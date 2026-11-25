/**
 * demo-redeem — exchange a shared demonstration code for a one-time sign-in
 * token for a new, independent, read-only reviewer identity.
 *
 * Platform-neutral (Web APIs only) so it can be unit-tested outside Deno;
 * index.ts wires it to Supabase. Security properties:
 *   - The privileged (service-role) client exists only on the server.
 *   - The client sends only { name, code }. Nothing it sends can choose a role,
 *     an identity, an expiry or a grant: the database decides all of that
 *     (demo_redeem_begin / demo_redeem_complete) and rate-limits before any
 *     code comparison.
 *   - Request bodies, codes, names, emails and tokens are never logged.
 *     Logs carry only a stage name.
 *   - Only listed portal origins may call it from a browser.
 */

export type RpcResult = { data: unknown; error: { message: string } | null };

export type Deps = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<RpcResult>;
  /** Create the Auth identity (Auth admin API). Returns its id, or null on failure. */
  createUser: (email: string) => Promise<string | null>;
  /** Delete an Auth identity (Auth admin API). Best effort. */
  deleteUser: (id: string) => Promise<void>;
  /** One-time sign-in token hash for the identity, without sending any email. */
  generateToken: (email: string) => Promise<string | null>;
  /** Keyed hash of the caller's IP address (the IP itself is never stored). */
  hashIp: (ip: string) => Promise<string>;
  allowedOrigins: string[];
  /** Stage-only logging; never pass values. */
  logStage?: (stage: string) => void;
};

const MAX_BODY = 2048;
const MAX_CLEANUP = 10;

type Failure = 'invalid_request' | 'invalid_code' | 'invalid_name' | 'rate_limited' | 'unavailable' | 'retry';
const STATUS: Record<Failure, number> = {
  invalid_request: 400,
  invalid_name: 400,
  invalid_code: 401,
  unavailable: 503,
  rate_limited: 429,
  retry: 409,
};

function cors(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey, x-client-info, authorization',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown';
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const log = deps.logStage ?? (() => {});
  const origin = req.headers.get('origin');
  const ch = cors(origin, deps.allowedOrigins);
  const fail = (f: Failure) => json(STATUS[f], { error: f }, ch);

  // Browsers must come from a listed portal origin.
  if (origin && !ch['Access-Control-Allow-Origin']) return json(403, { error: 'forbidden_origin' }, {});
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, ch);
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail('invalid_request');

  const raw = await req.text();
  if (raw.length > MAX_BODY) return fail('invalid_request');
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail('invalid_request');
  }
  const { code, name } = (body ?? {}) as Record<string, unknown>;
  if (typeof code !== 'string' || typeof name !== 'string' || code.length > 64 || name.length > 200) return fail('invalid_request');

  // 1. Validate the code and rate-limit (database decides; service role).
  const ipHash = await deps.hashIp(clientIp(req));
  const begin = await deps.rpc('demo_redeem_begin', { p_ip_hash: ipHash, p_code: code, p_name: name });
  if (begin.error) {
    log('begin_failed');
    return fail('unavailable');
  }
  const b = begin.data as { ok: boolean; reason?: string; grant_id?: string; email?: string };
  if (!b?.ok) {
    if (b?.reason === 'invalid') return fail('invalid_code');
    if (b?.reason === 'invalid_name') return fail('invalid_name');
    if (b?.reason === 'rate_limited') return fail('rate_limited');
    return fail('unavailable');
  }

  // 2. Create the identity. Its profile comes from the invitation the database just wrote.
  const userId = await deps.createUser(b.email!);
  if (!userId) {
    log('create_failed');
    return fail('unavailable');
  }

  // 3. Activate the grant (refused if the code was rotated meanwhile).
  const done = await deps.rpc('demo_redeem_complete', { p_grant: b.grant_id, p_user: userId });
  if (done.error || done.data !== true) {
    log('complete_failed');
    await deps.deleteUser(userId).catch(() => {});
    return fail('retry');
  }

  // 4. One-time sign-in token; the browser exchanges it for a session.
  const token = await deps.generateToken(b.email!);
  if (!token) {
    log('token_failed');
    await deps.deleteUser(userId).catch(() => {}); // nobody can use it; the grant record stays
    return fail('unavailable');
  }

  // 5. Opportunistic cleanup of ended reviewer identities (history is kept in demo_grants).
  try {
    const c = await deps.rpc('demo_cleanup_candidates');
    const ids = Array.isArray(c.data) ? (c.data as unknown[]).map((r) => (typeof r === 'string' ? r : (r as any)?.demo_cleanup_candidates ?? (r as any)?.id)) : [];
    for (const id of ids.filter(Boolean).slice(0, MAX_CLEANUP)) await deps.deleteUser(id as string).catch(() => {});
  } catch {
    log('cleanup_failed');
  }

  return json(200, { token_hash: token }, ch);
}
