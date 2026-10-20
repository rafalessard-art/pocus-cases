/**
 * Pre-demonstration validation: approved ITARs are preserved as versions,
 * post-approval evidence changes are detected (never applied silently), the
 * rotation exam requirement uses the same attempt as the ITAR, the 75% rotation
 * pass mark and 102-scan target hold, and scan attestation needs an explicit
 * review statement. Fictional people only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, assign, createUser, makeCohort, makePublishedExam, pool, rpc, sql, type User } from './helpers';

let admin: User, faculty: User, resident: User;
let block: string, course: string, cats: Record<string, string>;
let attempts: string[] = [];
const exam = (s: any) => s.requirements.find((r: any) => r.key === 'written_exam');

beforeAll(async () => {
  block = await makeCohort();
  course = (await sql(`select course_id from public.cohorts where id = $1`, [block]))[0].course_id;
  admin = await createUser('admin');
  faculty = await createUser('faculty', { cohortId: block });
  resident = await createUser('learner', { cohortId: block, name: 'Fictional Resident V' });
  cats = Object.fromEntries((await sql(`select key, id from public.scan_categories where cohort_id is null and archived_at is null`)).map((r) => [r.key, r.id]));
  // two submitted attempts: 80% then 70% (scores set directly to simulate grading)
  const ex = await makePublishedExam(admin, { release_mode: 'immediate', max_attempts: 2 });
  await assign(admin, ex.versionId, { cohortId: block });
  for (const pct of [80, 70]) {
    const [a] = await rpc(resident, 'my_exams');
    const id = await rpc(resident, 'start_attempt', { p_assignment: a.assignment_id });
    await rpc(resident, 'submit_attempt', { p_attempt: id });
    await sql(`update public.attempts set score_pct = $2::numeric, grading_status = 'complete', passed = $2::numeric >= 60, submitted_at = now() + make_interval(secs => $3::int) where id = $1`, [id, pct, attempts.length]);
    attempts.push(id);
  }
});
afterAll(() => pool.end());

describe('rotation configuration', () => {
  it('pass mark is 75% and scan targets total 102 across six categories', async () => {
    const [r] = await sql(`select config from public.rotation_requirements where key = 'written_exam' and cohort_id is null`);
    expect(r.config.pass_pct).toBe(75);
    const c = await sql(`select key, target from public.scan_categories where cohort_id is null and archived_at is null order by sort`);
    expect(c.map((x) => [x.key, x.target])).toEqual([['airway', 5], ['cardiac', 40], ['lung_pleura', 15], ['abdominal_fast', 20], ['gastric', 20], ['dvt', 2]]);
    expect(c.reduce((a, x) => a + x.target, 0)).toBe(102);
  });
});

describe('exam attempt used for the rotation requirement matches the ITAR', () => {
  it('defaults to the most recent submitted attempt (70% → below 75%)', async () => {
    const s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(exam(s)).toMatchObject({ status: 'in_progress', action: 'resident' });
    expect(exam(s).detail).toBe('Score 70.0% (attempt 2) — below the rotation pass mark of 75%');
  });

  it('follows a faculty-selected attempt saved with the ITAR draft, but not an attempt that was merely latest at save time', async () => {
    await as(faculty, (q) => q(`insert into public.evaluations (course_id, learner_id, cohort_id, attempt_id, attempt_rule, summary) values ($1, $2, $3, $4, 'latest_submitted', 'x')`,
      [course, resident.id, block, attempts[0]]));
    let s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(exam(s).detail).toMatch(/attempt 2/);
    await as(faculty, (q) => q(`update public.evaluations set attempt_rule = 'faculty_selected' where learner_id = $1 and cohort_id = $2`, [resident.id, block]));
    s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(exam(s)).toMatchObject({ status: 'verified' });
    expect(exam(s).detail).toBe('Score 80.0% (attempt 1) — rotation pass mark 75% met');
  });
});

describe('scan attestation', () => {
  it('requires an explicit statement that the studies were reviewed', async () => {
    await expect(rpc(faculty, 'attest_scans', { p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_entries: [{ category: cats.dvt, delta: 2 }] }))
      .rejects.toThrow(/reviewed these studies/);
    const s = await rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_entries: [{ category: cats.dvt, delta: 2 }] });
    expect(s.scans.categories.find((c: any) => c.key === 'dvt').verified).toBe(2);
    const [log] = await sql(`select details from public.audit_log where action = 'scans_attested' order by id desc limit 1`);
    expect(log.details.attestation).toMatch(/reviewed by the attesting faculty member/);
  });
});

describe('scan totals', () => {
  it('extra scans in one category do not make up for another; the raw number is kept separately', async () => {
    const r2 = await createUser('learner', { cohortId: block });
    const s = await rpc(faculty, 'attest_scans', { p_attested: true, p_learner: r2.id, p_cohort: block, p_reviewed_on: '2026-10-16',
      p_entries: [{ category: cats.gastric, delta: 30 }, { category: cats.dvt, delta: 1 }] });
    expect(s.scans).toMatchObject({ verified_total: 21, reviewed_total: 31, target_total: 102 });
    expect(s.requirements.find((r: any) => r.key === 'scan_logbook').detail).toBe('21/102 faculty-verified scans');
  });
});

describe('after an ITAR is approved', () => {
  let evalId: string;

  it('approval stores an immutable version and reports the ITAR separately from requirement completion', async () => {
    [{ id: evalId }] = await sql(`select id from public.evaluations where learner_id = $1 and cohort_id = $2`, [resident.id, block]);
    await as(faculty, (q) => q(`update public.evaluations set summary = 'Approved text v1', status = 'approved' where id = $1`, [evalId]));
    const v = await as(faculty, (q) => q(`select version, summary, approved_by from public.evaluation_versions where evaluation_id = $1`, [evalId]));
    expect(v).toEqual([{ version: 1, summary: 'Approved text v1', approved_by: faculty.id }]);
    const s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(s.itar).toMatchObject({ status: 'approved', versions: 1, changes_since_approval: [] });
    expect(s.requirements.filter((r: any) => r.status === 'verified').length).toBeLessThan(7); // approved ≠ all requirements complete
  });

  it('newer evidence is listed but never applied to the approved record', async () => {
    await new Promise((r) => setTimeout(r, 20));
    await rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-17', p_entries: [{ category: cats.gastric, delta: 5 }] });
    await as(faculty, (q) => q(`insert into public.faculty_notes (course_id, learner_id, cohort_id, author_id, category, body) values ($1, $2, $3, $4, 'scanning', 'Fictional later observation')`,
      [course, resident.id, block, faculty.id]));
    const s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(s.itar.changes_since_approval.map((c: any) => c.area)).toEqual(['Scan logbook', 'Observations']);
    const o = await rpc(faculty, 'rotation_block_overview', { p_cohort: block });
    expect(o[0].itar.changes_since_approval).toHaveLength(2);
    const [e] = await sql(`select status, summary from public.evaluations where id = $1`, [evalId]);
    expect(e).toEqual({ status: 'approved', summary: 'Approved text v1' });
    // the approved record cannot be edited without re-opening
    await expect(as(faculty, (q) => q(`update public.evaluations set summary = 'silently changed' where id = $1`, [evalId]))).rejects.toThrow(/locked/);
  });

  it('a faculty revision (re-open, edit, re-approve) creates version 2 and keeps version 1 intact', async () => {
    await as(faculty, (q) => q(`update public.evaluations set status = 'draft' where id = $1`, [evalId]));
    await as(faculty, (q) => q(`update public.evaluations set summary = 'Approved text v2 (revised for new scan counts)' where id = $1`, [evalId]));
    await as(faculty, (q) => q(`update public.evaluations set status = 'approved' where id = $1`, [evalId]));
    const v = await as(faculty, (q) => q(`select version, summary from public.evaluation_versions where evaluation_id = $1 order by version`, [evalId]));
    expect(v).toEqual([{ version: 1, summary: 'Approved text v1' }, { version: 2, summary: 'Approved text v2 (revised for new scan counts)' }]);
    const s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(s.itar).toMatchObject({ versions: 2, changes_since_approval: [] });
    await expect(as(faculty, (q) => q(`update public.evaluation_versions set summary = 'tamper'`))).rejects.toThrow();
    await expect(as(faculty, (q) => q(`delete from public.evaluation_versions`))).rejects.toThrow();
    expect(await as(resident, (q) => q(`select * from public.evaluation_versions`))).toEqual([]);
  });
});
