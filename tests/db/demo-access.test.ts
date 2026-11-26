/**
 * Demonstration (reviewer) access and owner MFA — authorization tests.
 *
 * Calls go straight to the database exactly as PostgREST would issue them for
 * a signed-in user (SET ROLE authenticated + JWT claims), so they test the API
 * surface itself, not the interface. Nothing here depends on the frontend.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { as, asService, createAuthUser, createUser, makeCohort, makePublishedExam, pool, redeem, rpc, sql, uniq, withAal2, type User } from './helpers';

let admin: User; // aal1 session
let owner: User; // same admin, MFA-verified (aal2)
let learner: User;
let faculty: User;

async function setSettings(env: string | null, demo = true, mfa = false) {
  await sql(`delete from public.deployment_settings`);
  if (env) await sql(`insert into public.deployment_settings (environment, demo_access_enabled, admin_mfa_required) values ($1, $2, $3)`, [env, demo, mfa]);
}

async function newCode(days = 30): Promise<string> {
  const r = await rpc(owner, 'rotate_demo_code', { p_valid_days: days });
  return r.code as string;
}

const roleOf = async (u: User) => (await rpc<string | null>(u, 'my_role'));

beforeAll(async () => {
  admin = await createUser('admin');
  owner = withAal2(admin);
  learner = await createUser('learner');
  faculty = await createUser('faculty');
});

beforeEach(async () => {
  await setSettings('development', true, false);
  // Each test starts with no active code and no recent attempts.
  await sql(`update public.demo_codes set revoked_at = now(), revoked_reason = 'test reset' where revoked_at is null`);
  await sql(`delete from public.demo_redeem_attempts`);
});

afterAll(async () => {
  await setSettings('development', true, false);
  await pool.end();
});

describe('code rotation (owner only)', () => {
  it('requires an administrator with a multi-factor (aal2) session', async () => {
    await expect(rpc(admin, 'rotate_demo_code', { p_valid_days: 30 })).rejects.toThrow(/multi-factor/);
    await expect(rpc(withAal2(faculty), 'rotate_demo_code', { p_valid_days: 30 })).rejects.toThrow(/multi-factor/);
    await expect(rpc(withAal2(learner), 'rotate_demo_code', { p_valid_days: 30 })).rejects.toThrow(/multi-factor/);
    await expect(rpc(null, 'rotate_demo_code', { p_valid_days: 30 })).rejects.toThrow(/permission denied/);
  });

  it('returns a 16-character code once and stores only a bcrypt hash', async () => {
    const r = await rpc(owner, 'rotate_demo_code', { p_valid_days: 7 });
    expect(r.code).toMatch(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    const plain = r.code.replace(/-/g, '');
    const [c] = await sql(`select code_hash, expires_at from public.demo_codes where id = $1`, [r.code_id]);
    expect(c.code_hash).toMatch(/^\$2[aby]\$10\$/);
    expect(c.code_hash).not.toContain(plain);
    // not in the audit log, the grants or anywhere else in the public schema
    const [hit] = await sql(`select count(*)::int as n from public.audit_log where details::text like '%' || $1 || '%'`, [plain]);
    expect(hit.n).toBe(0);
    expect(new Date(c.expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 864e5);
  });

  it('only one code is ever active; rotation revokes the old code and every grant issued under it, atomically', async () => {
    const first = await newCode();
    const a = await redeem(first, 'Reviewer A');
    const b = await redeem(first, 'Reviewer B');
    expect(await roleOf(a.user!)).toBe('reviewer');
    expect(await roleOf(b.user!)).toBe('reviewer');
    const r = await rpc(owner, 'rotate_demo_code', { p_valid_days: 30 });
    expect(r.grants_revoked).toBe(2);
    expect(await roleOf(a.user!)).toBeNull();
    expect(await roleOf(b.user!)).toBeNull();
    const [n] = await sql(`select count(*)::int as n from public.demo_codes where revoked_at is null`);
    expect(n.n).toBe(1);
    // the old code no longer redeems; the new one does
    expect((await redeem(first)).reason).toBe('invalid');
    expect((await redeem(r.code)).completed).toBe(true);
  });

  it('a redemption started before a rotation cannot complete after it', async () => {
    const code = await newCode();
    const begin = (await asService((q) => q(`select public.demo_redeem_begin($1, $2, $3) as r`, [uniq('ip'), code, 'Slow reviewer'])))[0].r;
    expect(begin.ok).toBe(true);
    await newCode(); // rotation in between
    const id = await createAuthUser(begin.email);
    const done = (await asService((q) => q(`select public.demo_redeem_complete($1, $2) as r`, [begin.grant_id, id])))[0].r;
    expect(done).toBe(false);
    expect(await roleOf({ id, email: begin.email, role: 'reviewer' })).toBeNull();
  });

  it('revoke_demo_code ends every reviewer session at once', async () => {
    const code = await newCode();
    const a = await redeem(code);
    expect(await roleOf(a.user!)).toBe('reviewer');
    await rpc(owner, 'revoke_demo_code', { p_reason: 'end of review round' });
    expect(await roleOf(a.user!)).toBeNull();
    expect((await redeem(code)).reason).toBe('invalid');
  });
});

describe('redemption (service role only)', () => {
  it('accepts the code in any case and with spaces or dashes; rejects anything else', async () => {
    const code = await newCode();
    expect((await redeem(code.toLowerCase().replace(/-/g, ' '))).completed).toBe(true);
    expect((await redeem(code.slice(0, -1) + (code.endsWith('Z') ? 'Y' : 'Z'))).reason).toBe('invalid');
    expect((await redeem('')).reason).toBe('invalid');
    expect((await redeem(code, '   ')).reason).toBe('invalid_name');
    expect((await redeem(code, 'x'.repeat(81))).reason).toBe('invalid_name');
  });

  it('creates an independent identity per redemption with a self-reported name and a 30-day grant', async () => {
    const code = await newCode(90);
    const a = await redeem(code, '  Dr.   Admin   One ');
    const b = await redeem(code, 'Dr. Admin One');
    expect(a.user!.id).not.toBe(b.user!.id);
    const [g] = await sql(`select display_name, expires_at, user_id from public.demo_grants where id = $1`, [a.grant_id]);
    expect(g.display_name).toBe('Dr. Admin One');
    expect(g.user_id).toBe(a.user!.id);
    const days = (new Date(g.expires_at).getTime() - Date.now()) / 864e5;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    // the identity is a reviewer with no cohort and no learner standing
    const [p] = await sql(`select role, email from public.profiles where id = $1`, [a.user!.id]);
    expect(p.role).toBe('reviewer');
    expect(p.email).toMatch(/^reviewer-[0-9a-f-]{36}@demo\.invalid$/);
    const cm = await sql(`select 1 from public.cohort_members where user_id = $1`, [a.user!.id]);
    expect(cm).toHaveLength(0);
  });

  it('a grant never outlives its code', async () => {
    const code = await newCode(3);
    const a = await redeem(code);
    const [g] = await sql(`select expires_at from public.demo_grants where id = $1`, [a.grant_id]);
    expect((new Date(g.expires_at).getTime() - Date.now()) / 864e5).toBeLessThan(3.01);
  });

  it('rate-limits failures per source before comparing codes, and caps redemptions overall', async () => {
    const code = await newCode();
    const ip = uniq('ip');
    for (let i = 0; i < 5; i++) expect((await redeem('WRONGWRONGWRONG2', 'x', ip)).reason).toBe('invalid');
    // even the right code is refused from that source now
    expect((await redeem(code, 'x', ip)).reason).toBe('rate_limited');
    // another source is unaffected
    expect((await redeem(code, 'x', uniq('ip'))).completed).toBe(true);
    // overall cap: 20 successful redemptions per hour
    await sql(`insert into public.demo_redeem_attempts (ip_hash, succeeded) select 'bulk', true from generate_series(1, 20)`);
    expect((await redeem(code, 'x', uniq('ip'))).reason).toBe('rate_limited');
  });

  it('completion is single-use, must match the begun email, and expires after 5 minutes', async () => {
    const code = await newCode();
    const b1 = (await asService((q) => q(`select public.demo_redeem_begin($1, $2, $3) as r`, [uniq('ip'), code, 'One'])))[0].r;
    const id1 = await createAuthUser(b1.email);
    const other = await createUser('learner');
    // wrong user for this grant
    expect((await asService((q) => q(`select public.demo_redeem_complete($1, $2) as r`, [b1.grant_id, other.id])))[0].r).toBe(false);
    expect((await asService((q) => q(`select public.demo_redeem_complete($1, $2) as r`, [b1.grant_id, id1])))[0].r).toBe(true);
    // a second completion does nothing
    expect((await asService((q) => q(`select public.demo_redeem_complete($1, $2) as r`, [b1.grant_id, id1])))[0].r).toBe(false);
    // the invitation is closed once used
    const [inv] = await sql(`select revoked_at from public.invitations where email = $1`, [b1.email]);
    expect(inv.revoked_at).not.toBeNull();
    // stale begin
    const b2 = (await asService((q) => q(`select public.demo_redeem_begin($1, $2, $3) as r`, [uniq('ip'), code, 'Two'])))[0].r;
    await sql(`update public.demo_grants set created_at = now() - interval '6 minutes' where id = $1`, [b2.grant_id]);
    const id2 = await createAuthUser(b2.email);
    expect((await asService((q) => q(`select public.demo_redeem_complete($1, $2) as r`, [b2.grant_id, id2])))[0].r).toBe(false);
  });

  it('signed-in and anonymous clients cannot call the redemption or cleanup functions', async () => {
    const code = await newCode();
    for (const u of [null, learner, owner, (await redeem(code)).user!]) {
      await expect(rpc(u, 'demo_redeem_begin', { p_ip_hash: 'x', p_code: code, p_name: 'x' })).rejects.toThrow(/permission denied/);
      await expect(rpc(u, 'demo_redeem_complete', { p_grant: crypto.randomUUID(), p_user: crypto.randomUUID() })).rejects.toThrow(/permission denied/);
      await expect(as(u, (q) => q(`select * from public.demo_cleanup_candidates()`))).rejects.toThrow(/permission denied/);
      await expect(rpc(u, '_reviewer_grant_ok', { p_uid: crypto.randomUUID() })).rejects.toThrow(/permission denied/);
      await expect(rpc(u, '_new_demo_code')).rejects.toThrow(/permission denied/);
    }
  });
});

describe('a reviewer cannot extend, reactivate or escalate their own access', () => {
  it('revoked or expired access cannot reactivate itself', async () => {
    const code = await newCode();
    const r = await redeem(code);
    const u = r.user!;
    await rpc(owner, 'revoke_demo_grant', { p_grant: r.grant_id, p_reason: 'test' });
    expect(await roleOf(u)).toBeNull();
    // direct table writes on the grant are refused (no privilege at all)
    await expect(as(u, (q) => q(`update public.demo_grants set revoked_at = null, expires_at = now() + interval '1 year' where user_id = $1`, [u.id]))).rejects.toThrow(/permission denied/);
    await expect(as(u, (q) => q(`insert into public.demo_grants (code_id, email, display_name, expires_at, user_id, activated_at) select id, $2, 'x', now() + interval '1 day', $1, now() from public.demo_codes limit 1`, [u.id, u.email]))).rejects.toThrow(/permission denied/);
    // the completion step can't be replayed
    expect((await asService((q) => q(`select public.demo_redeem_complete($1, $2) as r`, [r.grant_id, u.id])))[0].r).toBe(false);
    expect(await roleOf(u)).toBeNull();
    // expiry
    const r2 = await redeem(code);
    await sql(`update public.demo_grants set expires_at = now() - interval '1 second' where id = $1`, [r2.grant_id]);
    expect(await roleOf(r2.user!)).toBeNull();
  });

  it('an expired code disables every grant issued under it', async () => {
    const code = await newCode();
    const r = await redeem(code);
    await sql(`update public.demo_codes set expires_at = now() - interval '1 second', created_at = now() - interval '1 day' where revoked_at is null`);
    expect(await roleOf(r.user!)).toBeNull();
  });

  it('no client-supplied claim or metadata changes the role', async () => {
    const r = await redeem(await newCode());
    const forged: User = {
      ...r.user!,
      claims: { aal: 'aal2', app_metadata: { role: 'admin' }, user_metadata: { role: 'admin' }, user_role: 'admin' },
    };
    expect(await roleOf(forged)).toBe('reviewer');
    expect(await rpc(forged, 'is_admin')).toBe(false);
    expect(await rpc(forged, 'is_staff')).toBe(false);
    expect(await rpc(forged, 'is_member')).toBe(false);
    await expect(rpc(forged, 'rotate_demo_code', { p_valid_days: 30 })).rejects.toThrow(/multi-factor/);
    // profile role, email and name are immutable for them
    for (const set of [`role = 'admin'`, `full_name = 'Someone Else'`, `email = 'x@y.z'`, `active = false`]) {
      const rows = await as(forged, (q) => q(`update public.profiles set ${set} where id = $1 returning id`, [r.user!.id]));
      expect(rows, set).toHaveLength(0);
    }
  });

  it('of real records, a reviewer can read only their own profile and their own grant', async () => {
    // WP3 adds read access to fictional (fixture) people and blocks and to reviewer-visible
    // exams and media — see reviewer-views.test.ts. Nothing real is readable.
    const code = await newCode();
    const other = await redeem(code, 'Other reviewer');
    const r = await redeem(code, 'Me');
    const ex = await makePublishedExam(admin);
    const real = [other.user!.id, other.grant_id!, admin.id, learner.id, faculty.id, ex.examId, ex.versionId, ex.media.assetId, ex.media.versionId,
                  ...ex.q.map((q: any) => q.question_version_id)];
    const tables = await sql<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'public' order by 1`);
    for (const { t } of tables) {
      const rows = await as(r.user!, (q) => q(`select * from public.${t}`)).catch((e) => {
        expect(String(e), t).toMatch(/permission denied/);
        return [];
      });
      const text = JSON.stringify(rows).replace(/"(updated_by|confirmed_by)":"[0-9a-f-]{36}"/g, '');
      expect(real.filter((id) => text.includes(id)), t).toEqual([]);
      if (t === 'profiles') expect(rows.filter((x: any) => !x.is_fixture).map((x: any) => x.id), t).toEqual([r.user!.id]);
      else if (t === 'demo_grants') expect(rows.map((x: any) => x.id), t).toEqual([r.grant_id]);
      else if (t === 'deployment_settings') expect(rows, t).toHaveLength(1);
      else if (['invitations', 'audit_log', 'demo_codes', 'demo_redeem_attempts', 'review_feedback'].includes(t)) expect(rows, t).toHaveLength(0);
    }
    expect(other.user).not.toBeNull();
    const objs = await as(r.user!, (q) => q(`select name from storage.objects`));
    expect(objs.map((o: any) => o.name)).not.toContain(ex.media.path);
    // cannot see the code hash column at all
    await expect(as(r.user!, (q) => q(`select code_hash from public.demo_codes`))).rejects.toThrow(/permission denied/);
  });
});

/**
 * Fingerprint of every row in the application and storage tables. If a
 * reviewer action changes anything at all, the fingerprint changes.
 */
async function fingerprint(): Promise<Record<string, string>> {
  const tables = await sql<{ s: string; t: string }>(
    `select schemaname as s, tablename as t from pg_tables where schemaname in ('public', 'storage') or (schemaname = 'auth' and tablename = 'users') order by 1, 2`,
  );
  const out: Record<string, string> = {};
  for (const { s, t } of tables) {
    const [r] = await sql(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h, count(*)::int as n from ${s}.${t} x`);
    out[`${s}.${t}`] = `${r.n}:${r.h}`;
  }
  return out;
}

describe('read-only enforcement: direct API sweep as a reviewer', () => {
  let reviewer: User;
  let ids: string[] = [];

  // The file-level beforeEach revokes every code, so the sweep's reviewer is issued
  // afresh before each test (an earlier version swept an already-revoked reviewer).
  beforeEach(async () => {
    const code = (await rpc(withAal2(admin), 'rotate_demo_code', { p_valid_days: 30 })).code;
    reviewer = (await redeem(code, 'Sweep reviewer')).user!;
    ids[8] = reviewer.id;
    expect(await roleOf(reviewer)).toBe('reviewer');
  });

  beforeAll(async () => {
    await setSettings('development', true, false);
    // realistic data to attack: a published exam with an open assignment and an attempt by a learner
    const block = await makeCohort();
    await sql(`insert into public.cohort_members (cohort_id, user_id, member_role) values ($1, $2, 'learner'), ($1, $3, 'evaluator')`, [block, learner.id, faculty.id]);
    const ex = await makePublishedExam(admin);
    const [asg] = await sql(`insert into public.assignments (exam_version_id, cohort_id) values ($1, $2) returning id`, [ex.versionId, block]);
    const att = await rpc(learner, 'start_attempt', { p_assignment: asg.id });
    ids = [block, ex.examId, ex.versionId, asg.id, att, learner.id, faculty.id, admin.id, admin.id, ex.media.versionId, ex.media.assetId];
  });

  it('every table refuses INSERT, UPDATE and DELETE', async () => {
    const before = await fingerprint();
    const tables = await sql<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'public' order by 1`);
    const stmts = (t: string) => [
      `insert into public.${t} default values`,
      `update public.${t} set updated_at = now()`,
      `update public.${t} set id = id`,
      `delete from public.${t}`,
      `truncate public.${t}`,
    ];
    for (const { t } of tables) {
      for (const s of stmts(t)) {
        const text = s.startsWith('truncate') ? s : `${s} returning *`;
        const res = await as(reviewer, (q) => q(text)).catch(() => []);
        expect(res, `${s}`).toHaveLength(0);
      }
    }
    for (const s of [
      `insert into storage.objects (bucket_id, name) values ('exam-media', 'x/evil.mp4')`,
      `insert into storage.objects (bucket_id, name) values ('itar-evidence', '${reviewer.id}/x/evil.pdf')`,
      `update storage.objects set name = name`,
    ]) {
      const res = await as(reviewer, (q) => q(`${s} returning *`)).catch(() => []);
      expect(res, s).toHaveLength(0);
    }
    await as(reviewer, async (q) => {
      await q(`select set_config('storage.allow_delete_query', 'true', true)`);
      return q(`delete from storage.objects returning *`);
    }).then((r) => expect(r).toHaveLength(0));
    expect(await fingerprint()).toEqual(before);
  });

  it('every callable function either refuses or changes nothing (functions with side effects included)', async () => {
    const fns = await sql<{ sig: string; args: string[] }>(
      `select p.oid::regprocedure::text as sig,
              coalesce(array(select format_type(t, null) from unnest(p.proargtypes) t), '{}') as args
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and p.prorettype <> 'trigger'::regtype
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`,
    );
    expect(fns.length).toBeGreaterThan(40);
    const before = await fingerprint();
    const answered: string[] = [];
    const sample = (type: string, i: number): string => {
      if (type === 'uuid') return `'${ids[i % ids.length]}'::uuid`;
      if (type === 'uuid[]') return `array['${ids.join("','")}']::uuid[]`;
      if (type === 'jsonb' || type === 'json') return `'{"id":"${ids[0]}","status":"verified","counts":[{"category":"${ids[1]}","count":5}]}'::${type}`;
      if (type === 'text') return `'x'`;
      if (type === 'text[]') return `array['x']`;
      if (type === 'boolean') return 'true';
      if (/int|numeric/.test(type)) return '1';
      if (/timestamp/.test(type)) return 'now()';
      return `null::${type}`;
    };
    for (const { sig, args } of fns) {
      const name = sig.split('(')[0];
      for (const variant of ['null', 'sample'] as const) {
        const params = args.map((t, i) => (variant === 'null' ? `null::${t}` : sample(t, i))).join(', ');
        const ok = await as(reviewer, (q) => q(`select ${name}(${params}) as r`)).then(
          (rows) => rows,
          () => null,
        );
        if (ok && ok[0] && ok[0].r !== null && JSON.stringify(ok[0].r) !== '[]' && JSON.stringify(ok[0].r) !== 'false') {
          answered.push(name.replace('public.', ''));
        }
      }
    }
    // A reviewer changed nothing anywhere.
    expect(await fingerprint()).toEqual(before);
    // And only these functions return anything meaningful to a reviewer given real ids.
    // Extend this list deliberately (WP3 views are swept with fictional ids in reviewer-views.test.ts).
    const allowed = new Set([
      'my_role', 'my_access', 'is_reviewer', 'current_aal', 'can_view_learner', 'can_evaluate',
      // pure helpers that only transform their arguments
      'score_item', 'assert_no_identifiers',
      // WP3 reviewer views: fictional blocks and residents, the configuration template, the
      // demonstration walkthrough's not-found note for other questions
      'itar_blocks', 'demo_fixture_learners', 'iter_template_for', 'question_issues',
    ]);
    const unexpected = [...new Set(answered)].filter((f) => !allowed.has(f));
    expect(unexpected).toEqual([]);
  });
});

describe('cleanup of ended reviewer identities', () => {
  it('returns only reviewer identities whose access ended over 7 days ago or never activated, and keeps the history', async () => {
    const code = await newCode();
    const keep = await redeem(code, 'Still active');
    const old = await redeem(code, 'Old');
    await sql(`update public.demo_grants set revoked_at = now() - interval '8 days', revoked_reason = 'test' where id = $1`, [old.grant_id]);
    const recent = await redeem(code, 'Recently revoked');
    await sql(`update public.demo_grants set revoked_at = now() - interval '1 day' where id = $1`, [recent.grant_id]);
    // half-finished redemption: identity created, completion never happened
    const half = (await asService((q) => q(`select public.demo_redeem_begin($1, $2, $3) as r`, [uniq('ip'), code, 'Half'])))[0].r;
    const halfId = await createAuthUser(half.email);
    await sql(`update public.profiles set created_at = now() - interval '2 hours' where id = $1`, [halfId]);
    await sql(`update public.demo_grants set created_at = now() - interval '2 hours' where id = $1`, [half.grant_id]);

    const ids = (await asService((q) => q(`select * from public.demo_cleanup_candidates() as id`))).map((r: any) => r.id);
    expect(ids).toContain(old.user!.id);
    expect(ids).toContain(halfId);
    expect(ids).not.toContain(keep.user!.id);
    expect(ids).not.toContain(recent.user!.id);
    for (const u of [admin, learner, faculty]) expect(ids).not.toContain(u.id);
    const [g] = await sql(`select identity_deleted_at from public.demo_grants where id = $1`, [old.grant_id]);
    expect(g.identity_deleted_at).not.toBeNull();
    const [h] = await sql(`select revoked_reason from public.demo_grants where id = $1`, [half.grant_id]);
    expect(h.revoked_reason).toBe('never activated');
    // deleting the identity (as the Auth admin API does) keeps the grant record
    await sql(`delete from auth.users where id = $1`, [old.user!.id]);
    const [after] = await sql(`select user_id, display_name from public.demo_grants where id = $1`, [old.grant_id]);
    expect(after).toMatchObject({ user_id: null, display_name: 'Old' });
  });
});

describe('demonstration access is fenced to non-production databases', () => {
  it('fails closed with no settings row, and can never be enabled in production', async () => {
    const code = await newCode();
    const r = await redeem(code);
    await setSettings(null);
    expect(await roleOf(r.user!)).toBeNull();
    expect((await redeem(code)).reason).toBe('disabled');
    await expect(rpc(owner, 'rotate_demo_code', { p_valid_days: 30 })).rejects.toThrow(/not enabled/);
    await expect(sql(`insert into public.deployment_settings (environment, demo_access_enabled) values ('production', true)`)).rejects.toThrow(/demo_access_never_in_production/);
    await setSettings('production', false, false);
    await expect(sql(`update public.deployment_settings set demo_access_enabled = true`)).rejects.toThrow(/demo_access_never_in_production/);
    expect(await roleOf(r.user!)).toBeNull();
  });

  it('no API role can change deployment settings', async () => {
    for (const u of [owner, learner, null]) {
      const res = await as(u, (q) => q(`update public.deployment_settings set demo_access_enabled = true, environment = 'development' returning *`)).catch((e) => {
        expect(String(e)).toMatch(/permission denied/);
        return [];
      });
      expect(res).toHaveLength(0);
    }
  });

  it('real people cannot be made reviewers, and demonstration identities cannot be made anything else', async () => {
    await expect(as(admin, (q) => q(`insert into public.invitations (email, full_name, role) values ($1, 'x', 'reviewer')`, [`${uniq('real')}@uottawa.ca`]))).rejects.toThrow(/invitations_reviewer_is_demo/);
    await expect(as(admin, (q) => q(`insert into public.invitations (email, full_name, role) values ($1, 'x', 'admin')`, [`reviewer-${crypto.randomUUID()}@demo.invalid`]))).rejects.toThrow(/invitations_reviewer_is_demo/);
    const r = await redeem(await newCode());
    await expect(as(admin, (q) => q(`update public.profiles set role = 'admin' where id = $1`, [r.user!.id]))).rejects.toThrow(/profiles_reviewer_is_demo/);
  });
});

describe('owner MFA (staged)', () => {
  it('is off by default: admin access is unchanged at aal1', async () => {
    expect(await roleOf(admin)).toBe('admin');
    expect(await rpc(admin, 'is_admin')).toBe(true);
  });

  it('can only be switched on (or off) from an aal2 session of an administrator', async () => {
    await expect(rpc(admin, 'set_admin_mfa_required', { p_on: true })).rejects.toThrow(/multi-factor/);
    await expect(rpc(withAal2(faculty), 'set_admin_mfa_required', { p_on: true })).rejects.toThrow(/multi-factor/);
    expect(await rpc(owner, 'set_admin_mfa_required', { p_on: true })).toBe(true);
    await expect(rpc(admin, 'set_admin_mfa_required', { p_on: false })).rejects.toThrow(/multi-factor/);
    expect(await rpc(owner, 'set_admin_mfa_required', { p_on: false })).toBe(false);
  });

  it('when on, every admin privilege needs aal2 — policies, privileged functions and staff access alike', async () => {
    await setSettings('development', true, true);
    expect(await roleOf(admin)).toBeNull();
    expect(await rpc(admin, 'is_admin')).toBe(false);
    expect(await rpc(admin, 'is_staff')).toBe(false);
    expect(await as(admin, (q) => q(`select * from public.invitations`))).toHaveLength(0);
    expect(await as(admin, (q) => q(`select * from public.question_keys`))).toHaveLength(0);
    await expect(rpc(admin, 'create_exam', { p_course_id: crypto.randomUUID(), p_title: 'x', p_description: '' })).rejects.toThrow();
    const a = await rpc(admin, 'my_access');
    expect(a).toMatchObject({ role: null, profile_role: 'admin', aal: 'aal1', admin_mfa_required: true });
    // storage too: an aal1 admin can't register or upload exam media
    await expect(rpc(admin, 'begin_media_upload', { p_asset_id: null, p_asset: { media_key: uniq('K'), title: 't' }, p_file: { filename: 'a.mp4', mime_type: 'video/mp4', size_bytes: 10 } })).rejects.toThrow();
    const up = await as(admin, (q) => q(`insert into storage.objects (bucket_id, name) values ('exam-media', 'mfa/blocked.mp4') returning name`)).catch(() => []);
    expect(up).toHaveLength(0);
    // with MFA everything works
    expect(await roleOf(owner)).toBe('admin');
    expect((await as(owner, (q) => q(`select * from public.invitations`))).length).toBeGreaterThan(0);
    // learners and faculty are not affected
    expect(await roleOf(learner)).toBe('learner');
    expect(await roleOf(faculty)).toBe('faculty');
  });
});

describe('API compatibility', () => {
  it('every UPDATE and DELETE inside a database function has a WHERE clause (Supabase rejects them otherwise, error 21000)', async () => {
    const fns = await sql<{ name: string; src: string }>(
      `select p.proname as name, p.prosrc as src from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prolang in (select oid from pg_language where lanname in ('sql', 'plpgsql'))`,
    );
    const offenders: string[] = [];
    for (const { name, src } of fns) {
      const code = src.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''");
      for (const stmt of code.split(';')) {
        const s = stmt.trim();
        // a statement starts at the beginning or after a plpgsql keyword (then/else/loop/begin/...) or a CTE
        const m = s.match(/(?:^|\b(?:then|else|loop|begin|\))\s+)(update\s+[\w."]+|delete\s+from\s+[\w."]+)/i);
        if (m && !/\bwhere\b/i.test(s.slice(s.indexOf(m[1])))) offenders.push(`${name}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
