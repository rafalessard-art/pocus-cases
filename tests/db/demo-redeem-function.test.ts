/**
 * The demo-redeem Edge Function's handler, wired to the real database
 * functions (as the service role) instead of Supabase's HTTP APIs.
 * Auth admin calls are simulated the way the Auth server performs them
 * (an auth.users row; the existing triggers create the profile).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, type Deps } from '../../supabase/functions/demo-redeem/handler';
import { asService, createAuthUser, createUser, pool, rpc, sql, withAal2, type User } from './helpers';

const ORIGIN = 'https://review.example.test';
let owner: User;
let code: string;

function deps(over: Partial<Deps> = {}): Deps & { stages: string[] } {
  const stages: string[] = [];
  return {
    allowedOrigins: [ORIGIN],
    rpc: async (fn, args = {}) => {
      try {
        const names = Object.keys(args);
        const rows = await asService((q) =>
          fn === 'demo_cleanup_candidates'
            ? q(`select * from public.demo_cleanup_candidates() as id`)
            : q(`select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, names.map((k) => args[k])),
        );
        return { data: fn === 'demo_cleanup_candidates' ? rows.map((r: any) => r.id) : rows[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: String(e) } };
      }
    },
    createUser: async (email) => createAuthUser(email),
    deleteUser: async (id) => {
      await sql(`delete from auth.users where id = $1`, [id]);
    },
    generateToken: async () => 'tok_' + crypto.randomUUID(),
    hashIp: async (ip) => 'h_' + Buffer.from(ip).toString('hex'),
    logStage: (s) => stages.push(s),
    stages,
    ...over,
  } as Deps & { stages: string[] };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://fn.local/functions/v1/demo-redeem', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeAll(async () => {
  await sql(`delete from public.deployment_settings`);
  await sql(`insert into public.deployment_settings (environment, demo_access_enabled) values ('development', true)`);
  owner = withAal2(await createUser('admin'));
});

beforeEach(async () => {
  await sql(`delete from public.demo_redeem_attempts`);
  await sql(`update public.demo_codes set revoked_at = now() where revoked_at is null`);
  code = (await rpc(owner, 'rotate_demo_code', { p_valid_days: 30 })).code;
});

afterAll(async () => {
  await pool.end();
});

describe('demo-redeem handler', () => {
  it('redeems a valid code into a one-time token for a new reviewer identity', async () => {
    const d = deps();
    const res = await handle(post({ name: 'Program Admin', code }), d);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['token_hash']);
    const [g] = await sql(`select user_id, display_name from public.demo_grants order by created_at desc limit 1`);
    expect(g.display_name).toBe('Program Admin');
    expect(await rpc({ id: g.user_id, email: 'x', role: 'reviewer' }, 'my_role')).toBe('reviewer');
  });

  it('ignores anything the client adds: role, email, expiry, user id', async () => {
    const res = await handle(post({ name: 'X', code, role: 'admin', email: 'me@uottawa.ca', expires_at: '2099-01-01', user_id: crypto.randomUUID() }), deps());
    expect(res.status).toBe(200);
    const [g] = await sql(`select g.email, g.expires_at, p.role from public.demo_grants g join public.profiles p on p.id = g.user_id order by g.created_at desc limit 1`);
    expect(g.role).toBe('reviewer');
    expect(g.email).toMatch(/@demo\.invalid$/);
    expect(new Date(g.expires_at).getFullYear()).toBeLessThan(2099);
  });

  it('refuses other origins, other methods, non-JSON, oversized and malformed bodies', async () => {
    const d = deps();
    expect((await handle(post({ name: 'x', code }, { origin: 'https://evil.example' }), d)).status).toBe(403);
    expect((await handle(new Request('https://fn.local/x', { method: 'GET', headers: { origin: ORIGIN } }), d)).status).toBe(405);
    const pre = await handle(new Request('https://fn.local/x', { method: 'OPTIONS', headers: { origin: ORIGIN } }), d);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect((await handle(post('name=x&code=y', { 'content-type': 'application/x-www-form-urlencoded' }), d)).status).toBe(400);
    expect((await handle(post('{not json'), d)).status).toBe(400);
    expect((await handle(post({ name: 'x'.repeat(3000), code }), d)).status).toBe(400);
    expect((await handle(post({ name: 1, code }), d)).status).toBe(400);
    expect((await handle(post({ name: 'x' }), d)).status).toBe(400);
  });

  it('answers a wrong code with 401 and rate-limits by source (stored only as a keyed hash)', async () => {
    const d = deps();
    for (let i = 0; i < 5; i++) expect((await handle(post({ name: 'x', code: 'AAAA-BBBB-CCCC-DDDD' }), d)).status).toBe(401);
    expect((await handle(post({ name: 'x', code }), d)).status).toBe(429);
    expect((await handle(post({ name: 'x', code }, { 'x-forwarded-for': '198.51.100.9' }), d)).status).toBe(200);
    const rows = await sql(`select ip_hash from public.demo_redeem_attempts`);
    for (const r of rows) {
      expect(r.ip_hash).not.toContain('203.0.113.7');
      expect(r.ip_hash).not.toContain('198.51.100.9');
    }
  });

  it('never logs codes, names, emails or tokens', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(console, m as any).mockImplementation(() => {}));
    const d = deps({ generateToken: async () => null }); // force a failure path that logs
    const secretName = 'Dr Secret Name';
    await handle(post({ name: secretName, code }), d);
    await handle(post({ name: secretName, code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' }), deps());
    const logged = [...d.stages, ...spies.flatMap((s) => s.mock.calls.flat().map(String))].join('\n');
    spies.forEach((s) => s.mockRestore());
    expect(d.stages).toEqual(['token_failed']);
    for (const secret of [code, code.replace(/-/g, ''), secretName, '@demo.invalid', 'tok_']) expect(logged).not.toContain(secret);
  });

  it('removes the identity if the code is rotated mid-redemption', async () => {
    let createdId = '';
    const d = deps({
      createUser: async (email) => {
        createdId = await createAuthUser(email);
        await rpc(owner, 'rotate_demo_code', { p_valid_days: 30 }); // rotation lands between begin and complete
        return createdId;
      },
    });
    const res = await handle(post({ name: 'x', code }), d);
    expect(res.status).toBe(409);
    expect(await sql(`select 1 from auth.users where id = $1`, [createdId])).toHaveLength(0);
  });

  it('reports the service unavailable (and leaves only an inert pending grant) if identity creation fails', async () => {
    const res = await handle(post({ name: 'x', code }), deps({ createUser: async () => null }));
    expect(res.status).toBe(503);
    const [g] = await sql(`select user_id, activated_at from public.demo_grants order by created_at desc limit 1`);
    expect(g).toMatchObject({ user_id: null, activated_at: null });
  });

  it('is refused when demonstration access is disabled for the database', async () => {
    await sql(`update public.deployment_settings set demo_access_enabled = false`);
    try {
      expect((await handle(post({ name: 'x', code }), deps())).status).toBe(503);
    } finally {
      await sql(`update public.deployment_settings set demo_access_enabled = true`);
    }
  });

  it('cleans up ended identities on the way', async () => {
    const first = await handle(post({ name: 'Old reviewer', code }), deps());
    expect(first.status).toBe(200);
    const [g] = await sql(`select id, user_id from public.demo_grants where display_name = 'Old reviewer' order by created_at desc limit 1`);
    await sql(`update public.demo_grants set revoked_at = now() - interval '8 days' where id = $1`, [g.id]);
    expect((await handle(post({ name: 'New reviewer', code }), deps())).status).toBe(200);
    expect(await sql(`select 1 from auth.users where id = $1`, [g.user_id])).toHaveLength(0);
    const [kept] = await sql(`select display_name, identity_deleted_at from public.demo_grants where id = $1`, [g.id]);
    expect(kept.display_name).toBe('Old reviewer');
    expect(kept.identity_deleted_at).not.toBeNull();
  });
});
