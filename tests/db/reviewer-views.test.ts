/**
 * WP3 — reviewer read views, perspectives, the demonstration walkthrough and feedback.
 *
 * Loads the synthetic demonstration fixtures, then adds "secret" data a reviewer
 * must never reach: a real (non-fixture) block, resident and faculty member, and a
 * hidden exam with a marker string in its stem, key, explanation and media — and
 * even assigns that hidden exam to a fictional block and has a fictional resident
 * sit it. Every reviewer-readable surface (each table, each callable function with
 * fictional *and* secret ids, storage) is then swept for the secret ids and marker.
 *
 * As everywhere in tests/db, calls go straight to Postgres the way PostgREST issues
 * them, so this tests the API itself, not the interface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as, assign, createUser, fakeStorageObject, makeCohort, makeMedia, makeQuestion, pocusCourseId, pool, redeem, rpc, sql, uniq, withAal2, type User,
} from './helpers';
// @ts-ignore — plain ESM loader shared with the local demo setup
import { FIXTURE, loadFixtures } from '../../scripts/demo-fixtures.mjs';

const MARK = `SECRET-${uniq('m')}`;
let admin: User;
let owner: User;
let reviewer: User;
let reviewerGrant: string;
let realLearner: User;
let realFaculty: User;
let realBlock: string;
let demo: { examId: string; versionId: string; attempts: Record<string, string>; qv: string[]; mediaPaths: string[]; evidencePaths: string[]; assignment: string };
let secret: { examId: string; versionId: string; qv: string; attempt: string; fixtureAttempt: string; mediaPath: string; evidencePath: string; assignment: string };
let secretIds: string[] = [];
let overdue: string;

const [R1, R2, R3, R4, R5] = FIXTURE.residents as string[];
const BLOCK = FIXTURE.blocks as { past: string; current: string; upcoming: string };

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

/** Nothing a reviewer receives may mention a secret id or the marker. */
function expectClean(label: string, value: unknown) {
  // Configuration rows name who last changed them by an opaque id (updated_by / confirmed_by);
  // that person's profile is not readable, so the id alone is allowed.
  const text = (JSON.stringify(value) ?? '').replace(/"(updated_by|confirmed_by)":"[0-9a-f-]{36}"/g, '');
  expect(text.includes(MARK), `${label} leaks the hidden exam's content`).toBe(false);
  const leaked = secretIds.filter((id) => text.includes(id));
  expect(leaked, `${label} leaks hidden ids`).toEqual([]);
}

const fixtureUser = (id: string): User => ({ id, email: 'fixture@fixture.invalid', role: 'learner' });

beforeAll(async () => {
  await sql(`delete from public.deployment_settings`);
  await sql(`insert into public.deployment_settings (environment, demo_access_enabled, admin_mfa_required) values ('development', true, false)`);
  await loadFixtures(pool);
  admin = await createUser('admin');
  owner = withAal2(admin);
  await sql(`update public.demo_codes set revoked_at = now(), revoked_reason = 'test reset' where revoked_at is null`);
  await sql(`delete from public.demo_redeem_attempts`);
  const code = (await rpc(owner, 'rotate_demo_code', { p_valid_days: 30 })).code;
  const r = await redeem(code, 'Program Director (test)');
  reviewer = r.user!;
  reviewerGrant = r.grant_id!;

  // ---- the demonstration exam, as loaded ----
  const [dx] = await sql(`select e.id, v.id as version from public.exams e join public.exam_versions v on v.exam_id = e.id where e.reviewer_visible`);
  const att = await sql(`select user_id, id from public.attempts where exam_version_id = $1`, [dx.version]);
  demo = {
    examId: dx.id, versionId: dx.version,
    attempts: Object.fromEntries(att.map((a: any) => [a.user_id, a.id])),
    qv: (await sql(`select question_version_id as id from public.exam_items where exam_version_id = $1`, [dx.version])).map((x: any) => x.id),
    mediaPaths: (await sql(`select mv.storage_path as p from public.media_versions mv join public.media_assets ma on ma.id = mv.asset_id where ma.reviewer_visible`)).map((x: any) => x.p),
    evidencePaths: (await sql(`select storage_path as p from public.evidence_submissions where learner_id = $1`, [R3])).map((x: any) => x.p),
    assignment: (await sql(`select id from public.assignments where exam_version_id = $1 and cohort_id = $2`, [dx.version, BLOCK.current]))[0].id,
  };

  // ---- secret data: real people and block, a hidden exam with marker content ----
  realBlock = await makeCohort();
  realLearner = await createUser('learner', { cohortId: realBlock, name: `Real Resident ${MARK}` });
  realFaculty = await createUser('faculty', { cohortId: realBlock });
  const media = await makeMedia(admin);
  const q = await makeQuestion(admin, {
    type: 'single', stem: `${MARK} departmental post-test stem`, options: [{ id: 'a', text: `${MARK} option` }, { id: 'b', text: 'B' }],
    key: { correct: ['b'] }, explanation: `${MARK} explanation`, media: [{ media_version_id: media.versionId, caption: `${MARK} caption` }],
  });
  const ex = await rpc(admin, 'create_exam', { p_course_id: await pocusCourseId(), p_title: `${MARK} End-of-Block Examination`, p_description: MARK });
  await as(admin, (q2) => q2(`update public.exam_versions set pass_threshold_pct = 60, time_limit_minutes = 30, feedback_policy = 'full_review', release_mode = 'manual' where id = $1`, [ex.exam_version_id]));
  await rpc(admin, 'set_exam_items', { p_exam_version_id: ex.exam_version_id, p_items: [{ question_version_id: q.question_version_id }] });
  const pub = await rpc(admin, 'publish_exam_version', { p_exam_version_id: ex.exam_version_id });
  expect(pub.published).toBe(true);
  const realAsg = await assign(admin, ex.exam_version_id, { cohortId: realBlock });
  const secretAttempt = await rpc(realLearner, 'start_attempt', { p_assignment: realAsg });
  await rpc(realLearner, 'submit_attempt', { p_attempt: secretAttempt });
  // the hidden exam is also assigned to a fictional block and sat by a fictional resident
  const fixtureAsg = await assign(admin, ex.exam_version_id, { cohortId: BLOCK.current });
  const fixtureAttempt = await rpc(fixtureUser(R4), 'start_attempt', { p_assignment: fixtureAsg });
  await rpc(fixtureUser(R4), 'submit_attempt', { p_attempt: fixtureAttempt });
  // a real resident's evidence
  const [req] = await sql(`select id from public.evidence_requirements where cohort_id is null and archived_at is null and required order by sort limit 1`);
  const up = await rpc(realLearner, 'begin_evidence_upload', { p_requirement: req.id, p_cohort: realBlock, p_file: { filename: `${MARK}.pdf`, mime_type: 'application/pdf', size_bytes: 10 } });
  await sql(`insert into storage.objects (bucket_id, name, metadata) values ('itar-evidence', $1, '{"size": 10}')`, [up.storage_path]);
  await rpc(realLearner, 'complete_evidence_upload', { p_id: up.id, p_ok: true });
  const course = await pocusCourseId();
  await as(realFaculty, (q2) => q2(`insert into public.faculty_notes (course_id, learner_id, cohort_id, author_id, category, body) values ($1, $2, $3, $4, 'general', $5)`,
    [course, realLearner.id, realBlock, realFaculty.id, `${MARK} observation`]));
  secret = { examId: ex.exam_id, versionId: ex.exam_version_id, qv: q.question_version_id, attempt: secretAttempt, fixtureAttempt,
             mediaPath: media.path, evidencePath: up.storage_path, assignment: fixtureAsg };
  // other people's feedback
  const other = (await redeem(code, 'Other reviewer')).user!;
  await rpc(other, 'submit_feedback', { p: { category: 'idea', comments: `${MARK} other reviewer's private feedback`, perspective: 'admin' } });

  // an overdue in-progress attempt by a fictional resident: viewing must never finalise it
  const [prior] = await sql(`select id from public.attempts where user_id = $1 and exam_version_id = $2`, [R5, demo.versionId]);
  overdue = prior?.id ?? (await rpc(fixtureUser(R5), 'start_attempt', { p_assignment: demo.assignment }));
  await sql(`update public.attempts set status = 'in_progress', submitted_at = null, submit_reason = null, score_points = null, score_pct = null, passed = null,
             deadline_at = now() - interval '2 hours', started_at = now() - interval '3 hours' where id = $1`, [overdue]);

  secretIds = [
    ...(await sql(`select id::text from public.profiles where not is_fixture and id <> $1`, [reviewer.id])).map((x: any) => x.id),
    ...(await sql(`select id::text from public.cohorts where not is_fixture`)).map((x: any) => x.id),
    ...(await sql(`select id::text from public.exams where not reviewer_visible`)).map((x: any) => x.id),
    ...(await sql(`select v.id::text from public.exam_versions v join public.exams e on e.id = v.exam_id where not e.reviewer_visible`)).map((x: any) => x.id),
    ...(await sql(`select id::text from public.questions where not public._question_reviewer_visible(id)`)).map((x: any) => x.id),
    ...(await sql(`select id::text from public.question_versions where not public._qv_reviewer_visible(id)`)).map((x: any) => x.id),
    ...(await sql(`select id::text from public.media_assets where not reviewer_visible`)).map((x: any) => x.id),
    ...(await sql(`select mv.id::text from public.media_versions mv join public.media_assets ma on ma.id = mv.asset_id where not ma.reviewer_visible`)).map((x: any) => x.id),
    ...(await sql(`select a.id::text from public.attempts a join public.exam_versions v on v.id = a.exam_version_id join public.exams e on e.id = v.exam_id
                    where not e.reviewer_visible`)).map((x: any) => x.id),
    ...(await sql(`select id::text from public.evidence_submissions where learner_id not in (select id from public.profiles where is_fixture)`)).map((x: any) => x.id),
    ...(await sql(`select email as id from public.invitations where email <> $1`, [reviewer.email])).map((x: any) => x.id),
    // (their own grant row names their code's id — not the code itself)
    ...(await sql(`select id::text from public.demo_codes where id <> (select code_id from public.demo_grants where id = $1)`, [reviewerGrant])).map((x: any) => x.id),
    ...(await sql(`select id::text from public.demo_grants where id <> $1`, [reviewerGrant])).map((x: any) => x.id),
    ...(await sql(`select id::text from public.review_feedback`)).map((x: any) => x.id),
    secret.mediaPath, secret.evidencePath,
  ];
  expect(secretIds.length).toBeGreaterThan(20);
});

afterAll(() => pool.end());

describe('what a reviewer can read', () => {
  it('every table returns only fictional or reviewer-visible rows', async () => {
    const tables = await sql<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'public' order by 1`);
    const seen: Record<string, number> = {};
    for (const { t } of tables) {
      const rows = await as(reviewer, (q) => q(`select * from public.${t}`)).catch((e) => {
        expect(String(e), t).toMatch(/permission denied/);
        return [];
      });
      expectClean(t, rows);
      seen[t] = rows.length;
    }
    // the fictional cast is visible…
    const people = await as(reviewer, (q) => q(`select id, is_fixture from public.profiles`));
    for (const id of [...FIXTURE.residents, ...FIXTURE.faculty]) expect(people.map((p: any) => p.id)).toContain(id);
    expect(people.every((p: any) => p.is_fixture || p.id === reviewer.id)).toBe(true);
    // …the demonstration exam and its questions and keys too…
    expect(seen.exams).toBe(1);
    expect(seen.question_keys).toBe(demo.qv.length);
    expect(seen.media_assets).toBe(2);
    // …and nothing administrative
    for (const t of ['invitations', 'audit_log', 'demo_codes', 'demo_redeem_attempts', 'review_feedback']) expect(seen[t], t).toBe(0);
    expect(seen.demo_grants).toBe(1);
  });

  it('storage: demonstration media and fictional evidence only', async () => {
    const objs = await as(reviewer, (q) => q(`select bucket_id, name from storage.objects`));
    expectClean('storage.objects', objs);
    expect(objs.map((o: any) => o.name)).toEqual(expect.arrayContaining([...demo.mediaPaths, ...demo.evidencePaths]));
    const can = async (fn: string, p: string) => (await as(reviewer, (q) => q(`select public.${fn}($1) as ok`, [p])))[0].ok;
    expect(await can('can_read_exam_media', demo.mediaPaths[0])).toBe(true);
    expect(await can('can_read_exam_media', secret.mediaPath)).toBe(false);
    expect(await can('can_read_evidence', demo.evidencePaths[0])).toBe(true);
    expect(await can('can_read_evidence', secret.evidencePath)).toBe(false);
  });
});

describe('Resident perspective (a fictional resident, never a sign-in)', () => {
  it('reviewers view fictional residents through the learner read functions', async () => {
    const exams = await rpc(reviewer, 'my_exams', { p_as_learner: R3 });
    expect(exams.map((e: any) => e.exam_version_id)).toEqual([demo.versionId]);
    expect(exams[0].preview).toBe(true);
    const reqs = await rpc(reviewer, 'my_requirements', { p_as_learner: R3 });
    expect(reqs.map((b: any) => b.cohort.id)).toEqual([BLOCK.current]);
    const ev = await rpc(reviewer, 'my_evidence', { p_as_learner: R3 });
    expect(ev[0].requirements.flatMap((r: any) => r.submissions).length).toBeGreaterThan(0);
    const cur = await rpc(reviewer, 'my_curriculum', { p_course_slug: 'pocus', p_as_learner: R3 });
    expect(cur.items.length).toBeGreaterThan(0);
    const res = await rpc(reviewer, 'get_my_result', { p_attempt: demo.attempts[R1], p_as_learner: R1 });
    expect(res.items.length).toBe(demo.qv.length);
    for (const v of [exams, reqs, ev, cur, res]) expectClean('learner view', v);
  });

  it('the hidden exam a fictional resident sat stays hidden in their view', async () => {
    expect((await rpc(reviewer, 'my_exams', { p_as_learner: R4 })).map((e: any) => e.exam_version_id)).toEqual([demo.versionId]);
    await expect(rpc(reviewer, 'get_my_result', { p_attempt: secret.fixtureAttempt, p_as_learner: R4 })).rejects.toThrow(/not found/);
  });

  it('only reviewers and the owner may choose a resident, and only a fictional one', async () => {
    await expect(rpc(reviewer, 'my_exams', { p_as_learner: realLearner.id })).rejects.toThrow(/Fictional resident not found/);
    await expect(rpc(reviewer, 'my_exams', { p_as_learner: FIXTURE.faculty[0] })).rejects.toThrow(/Fictional resident not found/);
    await expect(rpc(reviewer, 'my_exams', {})).rejects.toThrow(/Not signed in/);
    await expect(rpc(realLearner, 'my_exams', { p_as_learner: R3 })).rejects.toThrow(/Only demonstration reviewers/);
    await expect(rpc(realFaculty, 'my_requirements', { p_as_learner: R3 })).rejects.toThrow(/Only demonstration reviewers/);
    await expect(rpc(owner, 'my_exams', { p_as_learner: realLearner.id })).rejects.toThrow(/Fictional resident not found/);
    expect((await rpc(owner, 'my_exams', { p_as_learner: R3 })).length).toBe(1);
    // the learner's own view is unchanged
    expect((await rpc(realLearner, 'my_exams')).map((e: any) => e.exam_version_id)).toEqual([secret.versionId]);
  });

  it('choosing a resident never acts as them: every learner write still refuses', async () => {
    await expect(rpc(reviewer, 'start_attempt', { p_assignment: demo.assignment })).rejects.toThrow();
    await expect(rpc(reviewer, 'report_scans', { p_cohort: BLOCK.current, p_counts: [] })).rejects.toThrow();
    const [req] = await sql(`select id from public.evidence_requirements where cohort_id is null and archived_at is null and required order by sort limit 1`);
    await expect(rpc(reviewer, 'begin_evidence_upload', { p_requirement: req.id, p_cohort: BLOCK.current, p_file: { mime_type: 'application/pdf', size_bytes: 10 } })).rejects.toThrow();
  });
});

describe('Faculty and Admin perspectives', () => {
  it('fictional blocks, residents and the demonstration exam only', async () => {
    const blocks = await rpc(reviewer, 'itar_blocks');
    expect(blocks.map((b: any) => b.id).sort()).toEqual(Object.values(BLOCK).sort());
    const ov = await rpc(reviewer, 'itar_block_overview', { p_cohort: BLOCK.current });
    expect(ov.residents.length).toBe(3);
    const r4 = ov.residents.find((r: any) => r.id === R4);
    expect(r4.exam.n_attempts).toBe(0); // the hidden exam's attempt is not counted
    const ws = await rpc(reviewer, 'itar_workspace', { p_learner: R3, p_cohort: BLOCK.current });
    expect(ws.learner.id).toBe(R3);
    const rot = await rpc(reviewer, 'rotation_block_overview', { p_cohort: BLOCK.current });
    const rs = await rpc(reviewer, 'rotation_status', { p_learner: R3, p_cohort: BLOCK.current });
    const rep = await rpc(reviewer, 'learner_report', { p_learner: R4, p_course: await pocusCourseId() });
    expect(rep.attempts).toEqual([]);
    const detail = await rpc(reviewer, 'staff_attempt_detail', { p_attempt: demo.attempts[R1] });
    expect(detail.items[0].key).toBeTruthy();
    const er = await rpc(reviewer, 'exam_report', { p_exam_version: demo.versionId, p_cohort: null });
    expect(er.learners.every((l: any) => (FIXTURE.residents as string[]).includes(l.user_id))).toBe(true);
    const tpl = await rpc(reviewer, 'iter_template_for', { p_cohort: BLOCK.current });
    expect(tpl).not.toBeNull();
    expect(await rpc(reviewer, 'evidence_due_for_deletion')).toEqual([]);
    for (const v of [blocks, ov, ws, rot, rs, rep, detail, er]) expectClean('staff view', v);
  });

  it('real blocks, real residents and hidden exams refuse', async () => {
    await expect(rpc(reviewer, 'itar_block_overview', { p_cohort: realBlock })).rejects.toThrow(/Block not found/);
    await expect(rpc(reviewer, 'rotation_block_overview', { p_cohort: realBlock })).rejects.toThrow(/Block not found/);
    await expect(rpc(reviewer, 'itar_workspace', { p_learner: realLearner.id, p_cohort: realBlock })).rejects.toThrow(/not found/);
    await expect(rpc(reviewer, 'rotation_status', { p_learner: realLearner.id, p_cohort: realBlock })).rejects.toThrow(/not found/);
    await expect(rpc(reviewer, 'learner_report', { p_learner: realLearner.id, p_course: await pocusCourseId() })).rejects.toThrow(/not found/);
    await expect(rpc(reviewer, 'staff_attempt_detail', { p_attempt: secret.attempt })).rejects.toThrow(/not found/);
    await expect(rpc(reviewer, 'staff_attempt_detail', { p_attempt: secret.fixtureAttempt })).rejects.toThrow(/not found/);
    await expect(rpc(reviewer, 'exam_report', { p_exam_version: secret.versionId, p_cohort: null })).rejects.toThrow(/not found/);
    await expect(rpc(reviewer, 'exam_version_issues', { p_exam_version_id: secret.versionId })).rejects.toThrow(/not found/);
    expectClean('question_issues', await rpc(reviewer, 'question_issues', { p_qv: secret.qv }));
  });

  it('staff write functions refuse a reviewer even for fictional residents', async () => {
    const calls: [string, Record<string, unknown>][] = [
      ['verify_epa', { p_learner: R3, p_cohort: BLOCK.current, p_reviewed: true, p_criteria_status: 'met', p_criteria_confirmed: true, p_strengths: null, p_areas: null, p_concerns: null, p_entries: null, p_details: null }],
      ['attest_scans', { p_attested: true, p_learner: R3, p_cohort: BLOCK.current, p_reviewed_on: '2026-10-01', p_entries: [], p_note: null, p_correction: false }],
      ['set_requirement_status', { p_requirement: (await sql(`select id from public.rotation_requirements where key = 'teachingmedicine' and cohort_id is null`))[0].id, p_learner: R3, p_cohort: BLOCK.current, p_status: 'verified', p_stage: null, p_note: null }],
      ['grade_response', { p_attempt: demo.attempts[R3], p_item: demo.qv[0], p_points: 1, p_comment: null }],
      ['release_results', { p_attempts: [demo.attempts[R3]] }],
      ['staff_close_attempt', { p_attempt: overdue }],
      ['review_evidence', { p_id: (await sql(`select id from public.evidence_submissions where learner_id = $1 limit 1`, [R3]))[0].id, p_status: 'verified', p_message: null }],
    ];
    for (const [fn, args] of calls) await expect(rpc(reviewer, fn, args), fn).rejects.toThrow();
  });
});

describe('read-only enforcement with fictional rows visible', () => {
  it('no table accepts INSERT, UPDATE or DELETE from a reviewer, even on rows they can read', async () => {
    const before = await fingerprint();
    const tables = await sql<{ t: string; c: string }>(
      `select c.table_name as t, (array_agg(c.column_name::text order by c.ordinal_position))[2] as c
         from information_schema.columns c join pg_tables p on p.tablename = c.table_name and p.schemaname = 'public'
        where c.table_schema = 'public' group by 1 order by 1`);
    for (const { t, c } of tables) {
      for (const s of [`insert into public.${t} default values`, `update public.${t} set ${c} = ${c}`, `delete from public.${t}`]) {
        const res = await as(reviewer, (q) => q(`${s} returning *`)).catch(() => []);
        expect(res, s).toHaveLength(0);
      }
    }
    expect(await fingerprint()).toEqual(before);
  });

  it('every callable function, given fictional and hidden ids, changes nothing and leaks nothing', async () => {
    const fns = await sql<{ sig: string; args: string[] }>(
      `select p.oid::regprocedure::text as sig, coalesce(array(select format_type(t, null) from unnest(p.proargtypes) t), '{}') as args
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`);
    const variants: string[][] = [
      [R3, BLOCK.current], [R1, BLOCK.past], [R4, BLOCK.current], [realLearner.id, realBlock], [R3, realBlock], [realLearner.id, BLOCK.current],
      [demo.versionId], [secret.versionId], [demo.attempts[R1]], [secret.attempt], [secret.fixtureAttempt], [overdue], [secret.qv], [demo.qv[0]],
      [demo.assignment], [secret.assignment], [demo.examId], [secret.examId],
    ];
    const sample = (type: string, v: string[], i: number): string => {
      if (type === 'uuid') return `'${v[i % v.length]}'::uuid`;
      if (type === 'uuid[]') return `array['${v.join("','")}']::uuid[]`;
      if (type === 'jsonb' || type === 'json') return `'{"id":"${v[0]}","status":"verified","comments":"x","category":"bug"}'::${type}`;
      if (type === 'text') return `'pocus'`;
      if (type === 'boolean') return 'true';
      if (/int|numeric/.test(type)) return '1';
      if (/^date|timestamp/.test(type)) return `'2026-10-01'`;
      return `null::${type}`;
    };
    const before = await fingerprint();
    let calls = 0;
    for (const { sig, args } of fns) {
      const name = sig.split('(')[0];
      if (name.replace('public.', '') === 'submit_feedback') continue; // the one permitted write, tested below
      for (const v of variants) {
        let uuidPos = 0;
        const params = args.map((t) => sample(t, v, t === 'uuid' ? uuidPos++ : 0)).join(', ');
        const rows = await as(reviewer, (q) => q(`select ${name}(${params}) as r`)).catch(() => null);
        calls += 1;
        if (rows) expectClean(`${name}(${params})`, rows);
      }
    }
    expect(calls).toBeGreaterThan(1000);
    expect(await fingerprint()).toEqual(before);
    const [o] = await sql(`select status from public.attempts where id = $1`, [overdue]);
    expect(o.status).toBe('in_progress');
  });

  it('viewing never finalises an overdue attempt (owner in the Resident perspective included)', async () => {
    const before = await fingerprint();
    await rpc(owner, 'my_exams', { p_as_learner: R5 });
    await rpc(owner, 'my_requirements', { p_as_learner: R5 });
    await rpc(reviewer, 'itar_workspace', { p_learner: R5, p_cohort: BLOCK.current });
    await rpc(reviewer, 'learner_report', { p_learner: R5, p_course: await pocusCourseId() });
    await rpc(reviewer, 'exam_report', { p_exam_version: demo.versionId, p_cohort: BLOCK.current });
    await rpc(reviewer, 'itar_block_overview', { p_cohort: BLOCK.current });
    expect(await fingerprint()).toEqual(before);
  });
});

describe('the demonstration walkthrough', () => {
  it('shows the demonstration exam with media, keys and explanations, and records nothing', async () => {
    const before = await fingerprint();
    const w = await rpc(reviewer, 'preview_exam_version', { p_exam_version: demo.versionId });
    expect(w.items).toHaveLength(demo.qv.length);
    expect(w.items.filter((i: any) => i.media.length).length).toBe(2);
    expect(w.items.every((i: any) => i.key)).toBe(true);
    expectClean('walkthrough', w);
    expect(await fingerprint()).toEqual(before);
  });

  it('is unavailable for any other exam and to anyone but reviewers and the owner', async () => {
    await expect(rpc(reviewer, 'preview_exam_version', { p_exam_version: secret.versionId })).rejects.toThrow(/not found/);
    await expect(rpc(owner, 'preview_exam_version', { p_exam_version: secret.versionId })).rejects.toThrow(/not found/);
    await expect(rpc(realLearner, 'preview_exam_version', { p_exam_version: demo.versionId })).rejects.toThrow(/reviewers and the owner/);
    await expect(rpc(realFaculty, 'preview_exam_version', { p_exam_version: demo.versionId })).rejects.toThrow(/reviewers and the owner/);
  });
});

describe('the reviewer boundary cannot be moved from the portal', () => {
  it('visibility flags are set by fixtures/SQL only', async () => {
    await expect(as(owner, (q) => q(`update public.exams set reviewer_visible = true where id = $1`, [secret.examId]))).rejects.toThrow(/set by the demonstration fixtures/);
    await expect(as(owner, (q) => q(`update public.exams set reviewer_visible = false where id = $1`, [demo.examId]))).rejects.toThrow(/set by the demonstration fixtures/);
    await expect(as(owner, (q) => q(`update public.profiles set is_fixture = true where id = $1`, [realLearner.id]))).rejects.toThrow(/set by the demonstration fixtures/);
    await expect(as(owner, (q) => q(`update public.cohorts set is_fixture = true where id = $1`, [realBlock]))).rejects.toThrow(/set by the demonstration fixtures/);
    const [m] = await sql(`select ma.id from public.media_assets ma join public.media_versions mv on mv.asset_id = ma.id where mv.storage_path = $1`, [secret.mediaPath]);
    await expect(as(owner, (q) => q(`update public.media_assets set reviewer_visible = true where id = $1`, [m.id]))).rejects.toThrow(/set by the demonstration fixtures/);
  });

  it('fictional people are undeliverable addresses; media must be cleared; real and fictional people never share a block', async () => {
    await expect(sql(`update public.profiles set is_fixture = true where id = $1`, [realLearner.id])).rejects.toThrow(/profiles_fixture_is_fictional/);
    const pending = await makeMedia(admin, { authorize: false });
    await expect(sql(`update public.media_assets set reviewer_visible = true where id = $1`, [pending.assetId])).rejects.toThrow(/media_reviewer_visible_cleared/);
    await expect(as(owner, (q) => q(`insert into public.cohort_members (cohort_id, user_id, member_role) values ($1, $2, 'learner')`, [BLOCK.current, realLearner.id])))
      .rejects.toThrow(/only be in fictional blocks/);
    await expect(as(owner, (q) => q(`insert into public.cohort_members (cohort_id, user_id, member_role) values ($1, $2, 'learner')`, [realBlock, R3])))
      .rejects.toThrow(/only be in fictional blocks/);
  });

  it('demonstration and hidden exams cannot share a question', async () => {
    const draft = await rpc(owner, 'new_exam_draft', { p_exam_id: secret.examId });
    await expect(rpc(owner, 'set_exam_items', { p_exam_version_id: draft, p_items: [{ question_version_id: demo.qv[0] }] })).rejects.toThrow(/cannot share questions/);
  });
});

describe('owner preview of the reviewer experience', () => {
  const preview = (u: User): User => ({ ...u, headers: { 'x-portal-preview': 'reviewer' } });

  it('an admin request marked as a reviewer preview gets exactly the reviewer view', async () => {
    expect(await rpc(preview(owner), 'my_role')).toBe('reviewer');
    expect(await rpc(preview(owner), 'my_access')).toMatchObject({ role: 'reviewer', profile_role: 'admin', preview: true });
    const exams = await as(preview(owner), (q) => q(`select id from public.exams`));
    expect(exams.map((e: any) => e.id)).toEqual([demo.examId]);
    expect(await as(preview(owner), (q) => q(`select * from public.invitations`))).toHaveLength(0);
    await expect(rpc(preview(owner), 'create_exam', { p_course_id: await pocusCourseId(), p_title: 'x', p_description: '' })).rejects.toThrow();
    await expect(rpc(preview(owner), 'rotate_demo_code', { p_valid_days: 30 })).rejects.toThrow();
  });

  it('the header never raises anyone, and is ignored outside demonstration databases', async () => {
    expect(await rpc(preview(realLearner), 'my_role')).toBe('learner');
    expect(await rpc(preview(realFaculty), 'my_role')).toBe('faculty');
    expect(await rpc(preview(reviewer), 'my_role')).toBe('reviewer');
    expect(await rpc({ ...owner, headers: { 'x-portal-preview': 'admin' } }, 'my_role')).toBe('admin');
    await sql(`update public.deployment_settings set demo_access_enabled = false`);
    try {
      expect(await rpc(preview(owner), 'my_role')).toBe('admin');
    } finally {
      await sql(`update public.deployment_settings set demo_access_enabled = true`);
    }
    await sql(`update public.deployment_settings set admin_mfa_required = true`);
    try {
      expect(await rpc(preview(admin), 'my_role')).toBeNull(); // MFA still comes first
    } finally {
      await sql(`update public.deployment_settings set admin_mfa_required = false`);
    }
  });
});

describe('feedback', () => {
  it('a reviewer can submit contextual feedback and cannot read anyone’s, including their own', async () => {
    const id = await rpc(reviewer, 'submit_feedback', { p: {
      display_name: 'Program Director (test)', role_label: 'Program director', perspective: 'faculty', page: '/app/itar', section: 'Block overview',
      app_version: 'wp3-test', category: 'confusing', comments: 'The evidence column could say what is awaiting review.' } });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await as(reviewer, (q) => q(`select * from public.review_feedback`))).toHaveLength(0);
    await expect(rpc(reviewer, 'list_feedback')).rejects.toThrow();
    await expect(rpc(reviewer, 'set_feedback_status', { p_id: id, p_status: 'dismissed', p_note: null })).rejects.toThrow();
    const res = await as(reviewer, (q) => q(`update public.review_feedback set comments = 'x' returning id`)).catch(() => []);
    expect(res).toHaveLength(0);
    const [row] = await sql(`select * from public.review_feedback where id = $1`, [id]);
    expect(row).toMatchObject({ author_id: reviewer.id, grant_id: reviewerGrant, perspective: 'faculty', category: 'confusing', status: 'new', section: 'Block overview' });
  });

  it('the owner reads and triages feedback', async () => {
    const list = await rpc(owner, 'list_feedback');
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0]).not.toHaveProperty('author_id');
    expect(list.find((f: any) => f.comments.includes(MARK)).grant_name).toBe('Other reviewer');
    await rpc(owner, 'set_feedback_status', { p_id: list[0].id, p_status: 'actioned', p_note: 'Planned for WP4' });
    const [row] = await sql(`select status, owner_note from public.review_feedback where id = $1`, [list[0].id]);
    expect(row).toEqual({ status: 'actioned', owner_note: 'Planned for WP4' });
  });

  it('refuses patient identifiers, learners and faculty, and ended access', async () => {
    await expect(rpc(reviewer, 'submit_feedback', { p: { category: 'bug', comments: 'Patient MRN 1234567 looked wrong' } })).rejects.toThrow(/patient identifiers/);
    await expect(rpc(reviewer, 'submit_feedback', { p: { category: 'nonsense', comments: 'x' } })).rejects.toThrow();
    await expect(rpc(realLearner, 'submit_feedback', { p: { category: 'bug', comments: 'x' } })).rejects.toThrow(/for demonstration reviewers/);
    await expect(rpc(realFaculty, 'submit_feedback', { p: { category: 'bug', comments: 'x' } })).rejects.toThrow(/for demonstration reviewers/);
    const code = (await rpc(owner, 'rotate_demo_code', { p_valid_days: 30 })).code;
    const r = (await redeem(code, 'Soon revoked')).user!;
    await rpc(owner, 'revoke_demo_grant', { p_grant: (await sql(`select id from public.demo_grants where user_id = $1`, [r.id]))[0].id, p_reason: 'test' });
    await expect(rpc(r, 'submit_feedback', { p: { category: 'bug', comments: 'x' } })).rejects.toThrow(/for demonstration reviewers/);
  });
});

describe('ended access', () => {
  it('a revoked or expired reviewer reads nothing at all', async () => {
    // the beforeAll reviewer's code was rotated away in the previous test, which revoked their grant
    expect(await rpc(reviewer, 'my_role')).toBeNull();
    const tables = await sql<{ t: string }>(`select tablename as t from pg_tables where schemaname = 'public' order by 1`);
    for (const { t } of tables) {
      const rows = await as(reviewer, (q) => q(`select * from public.${t}`)).catch(() => []);
      if (t === 'deployment_settings') continue;
      if (t === 'profiles') expect(rows.map((x: any) => x.id), t).toEqual([reviewer.id]);
      else expect(rows, t).toHaveLength(0);
    }
    await expect(rpc(reviewer, 'my_exams', { p_as_learner: R3 })).rejects.toThrow();
    await expect(rpc(reviewer, 'itar_blocks')).rejects.toThrow();
    await expect(rpc(reviewer, 'preview_exam_version', { p_exam_version: demo.versionId })).rejects.toThrow();
    expect((await as(reviewer, (q) => q(`select public.can_read_exam_media($1) as ok`, [demo.mediaPaths[0]])))[0].ok).toBe(false);
  });
});
