/**
 * Auth-server-level checks for owner MFA and demonstration access, against a
 * full LOCAL Supabase stack (Auth, REST, Edge Functions) — never a hosted one.
 *
 *   supabase start
 *   supabase functions serve demo-redeem --env-file supabase/functions/.env.example   (second terminal)
 *   AUTH_STACK_URL=http://127.0.0.1:54321 \
 *   AUTH_ANON_KEY=<anon / publishable key from `supabase status`> \
 *   AUTH_SERVICE_KEY=<service_role / secret key from `supabase status`> \
 *   npm run test:auth
 *
 * Skipped entirely when AUTH_STACK_URL is not set.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { assertLocal } from '../local-only';

const URL_ = process.env.AUTH_STACK_URL;
const ANON = process.env.AUTH_ANON_KEY ?? '';
const SERVICE = process.env.AUTH_SERVICE_KEY ?? '';
const ORIGIN = 'http://127.0.0.1:5173';
assertLocal('AUTH_STACK_URL', URL_);

const client = () => createClient(URL_!, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(ctr).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}

async function redeem(name: string, code: string) {
  const res = await fetch(`${URL_}/functions/v1/demo-redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: ANON, origin: ORIGIN },
    body: JSON.stringify({ name, code }),
  });
  const body = await res.json();
  if (!res.ok) return { status: res.status, body, c: null as SupabaseClient | null };
  const c = client();
  const { error } = await c.auth.verifyOtp({ token_hash: body.token_hash, type: 'email' });
  expect(error).toBeNull();
  return { status: res.status, body, c };
}

describe.skipIf(!URL_)('live local stack: owner authentication and demonstration access', () => {
  const svc = () => createClient(URL_!, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const ownerEmail = `owner-${randomUUID().slice(0, 8)}@localhost.test`;
  const ownerPassword = `Owner-${randomUUID()}`;
  let owner: SupabaseClient;
  let secret1 = '';
  let factor1 = '';

  beforeAll(async () => {
    const s = svc();
    await s.from('deployment_settings').delete().eq('id', true);
    await s.from('deployment_settings').insert({ environment: 'development', demo_access_enabled: true, admin_mfa_required: false });
    await s.from('invitations').insert({ email: ownerEmail, full_name: 'Local Owner', role: 'admin' });
    const { error } = await s.auth.admin.createUser({ email: ownerEmail, password: ownerPassword, email_confirm: true });
    expect(error).toBeNull();
    owner = client();
    const r = await owner.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword });
    expect(r.error).toBeNull();
  });

  afterAll(async () => {
    await svc().from('deployment_settings').update({ admin_mfa_required: false }).eq('id', true);
  });

  it('owner: password sign-in gives aal1; enrolling and verifying TOTP gives aal2', async () => {
    expect((await owner.rpc('my_access')).data).toMatchObject({ role: 'admin', aal: 'aal1' });
    const e = await owner.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Phone' });
    expect(e.error).toBeNull();
    secret1 = e.data!.totp.secret;
    factor1 = e.data!.id;
    const v = await owner.auth.mfa.challengeAndVerify({ factorId: factor1, code: totp(secret1) });
    expect(v.error).toBeNull();
    expect((await owner.auth.mfa.getAuthenticatorAssuranceLevel()).data?.currentLevel).toBe('aal2');
    expect((await owner.rpc('my_access')).data).toMatchObject({ role: 'admin', aal: 'aal2' });
  });

  it('owner: a second (backup) factor can be added; removing a factor needs aal2', async () => {
    const e = await owner.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Backup' });
    const v = await owner.auth.mfa.challengeAndVerify({ factorId: e.data!.id, code: totp(e.data!.totp.secret) });
    expect(v.error).toBeNull();
    const fresh = client();
    await fresh.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword });
    expect((await fresh.auth.mfa.getAuthenticatorAssuranceLevel()).data).toMatchObject({ currentLevel: 'aal1', nextLevel: 'aal2' });
    const un = await fresh.auth.mfa.unenroll({ factorId: e.data!.id });
    expect(un.error).not.toBeNull(); // aal1 can't remove a verified factor
    // either factor completes sign-in (the backup works)
    const ok = await fresh.auth.mfa.challengeAndVerify({ factorId: e.data!.id, code: totp(e.data!.totp.secret) });
    expect(ok.error).toBeNull();
  });

  it('staged requirement: when on, a password-only (aal1) owner session has no role until it confirms with TOTP', async () => {
    expect((await owner.rpc('set_admin_mfa_required', { p_on: true })).error).toBeNull();
    const fresh = client();
    await fresh.auth.signInWithPassword({ email: ownerEmail, password: ownerPassword });
    expect((await fresh.rpc('my_role')).data).toBeNull();
    expect((await fresh.from('invitations').select('email')).data).toEqual([]);
    await fresh.auth.mfa.challengeAndVerify({ factorId: factor1, code: totp(secret1, Date.now() + 30_000) });
    expect((await fresh.rpc('my_role')).data).toBe('admin');
    expect((await owner.rpc('set_admin_mfa_required', { p_on: false })).error).toBeNull();
  });

  it('demonstration: redemption creates independent reviewer identities; Auth-API actions by one cannot affect another', async () => {
    const { data } = await owner.rpc('rotate_demo_code', { p_valid_days: 30 });
    const code = data.code as string;
    const a = await redeem('Reviewer A', code);
    const b = await redeem('Reviewer B', code);
    expect(a.status).toBe(200);
    expect((await a.c!.rpc('my_role')).data).toBe('reviewer');
    // Reviewer A uses the Auth API directly on their own identity:
    expect((await a.c!.auth.updateUser({ password: `Changed-${randomUUID()}` })).error).toBeNull(); // allowed: recently signed in
    expect((await a.c!.auth.updateUser({ data: { role: 'admin' } })).error).toBeNull();
    const mfa = await a.c!.auth.mfa.enroll({ factorType: 'totp' });
    expect(mfa.error).toBeNull();
    await a.c!.auth.refreshSession();
    expect((await a.c!.rpc('my_role')).data).toBe('reviewer'); // nothing changed its role
    expect((await a.c!.rpc('is_admin')).data).toBe(false);
    // A signs out "globally": only A's own sessions end.
    await a.c!.auth.signOut({ scope: 'global' });
    expect((await b.c!.auth.getUser()).error).toBeNull();
    expect((await b.c!.rpc('my_role')).data).toBe('reviewer');
  });

  it('demonstration: rotation ends access for every reviewer immediately, and the old code stops working', async () => {
    const code = (await owner.rpc('rotate_demo_code', { p_valid_days: 30 })).data.code as string;
    const r = await redeem('Reviewer C', code);
    expect((await r.c!.rpc('my_role')).data).toBe('reviewer');
    await owner.rpc('rotate_demo_code', { p_valid_days: 30 });
    expect((await r.c!.rpc('my_role')).data).toBeNull();
    expect((await redeem('Reviewer C', code)).status).toBe(401);
  });

  it('demonstration: the function refuses browsers from unlisted origins', async () => {
    const res = await fetch(`${URL_}/functions/v1/demo-redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: ANON, origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'x', code: 'x' }),
    });
    expect(res.status).toBe(403);
  });
});
