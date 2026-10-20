/**
 * Rotation requirements and completion tracking: computed statuses from existing
 * records, faculty batch scan attestation (counts only), corrections, identifier
 * screen, resident submissions, overrides, access separation and audit.
 * All people are fictional; no patient-level data exists anywhere in this schema.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, assign, createUser, makeCohort, makePublishedExam, pool, rpc, sql, type User } from './helpers';

let admin: User, faculty: User, otherFaculty: User, resident: User, otherResident: User;
let block: string, otherBlock: string;
let cats: Record<string, string>;
let reqs: Record<string, string>;

const status = (s: any, key: string) => s.requirements.find((r: any) => r.key === key);
const cat = (s: any, key: string) => s.scans.categories.find((c: any) => c.key === key);

beforeAll(async () => {
  block = await makeCohort();
  otherBlock = await makeCohort();
  admin = await createUser('admin');
  faculty = await createUser('faculty', { cohortId: block });
  otherFaculty = await createUser('faculty', { cohortId: otherBlock });
  resident = await createUser('learner', { cohortId: block, name: 'Fictional Resident R' });
  otherResident = await createUser('learner', { cohortId: block });
  cats = Object.fromEntries((await sql(`select key, id from public.scan_categories where cohort_id is null and archived_at is null`)).map((r) => [r.key, r.id]));
  reqs = Object.fromEntries((await sql(`select key, id from public.rotation_requirements where cohort_id is null and archived_at is null`)).map((r) => [r.key, r.id]));
});
afterAll(() => pool.end());

describe('configuration', () => {
  it('seeds the 7 official POCUS requirements and 102 reviewed-scan targets', async () => {
    const s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(s.requirements.map((r: any) => r.key)).toEqual(
      ['c6_epas', 'brightspace_cases', 'teachingmedicine', 'scan_logbook', 'qpath_portfolio', 'written_exam', 'pocus_rounds']);
    expect(s.scans.target_total).toBe(102);
    expect(s.scans.categories.map((c: any) => [c.label, c.target])).toEqual(
      [['Airway', 5], ['Cardiac', 40], ['Lung and pleura', 15], ['Abdominal / FAST', 20], ['Gastric', 20], ['DVT', 2]]);
    expect(s.requirements.every((r: any) => r.status === 'not_started')).toBe(true);
  });

  it('a block can override a rotation-wide target without code changes; only admins edit configuration', async () => {
    const course = (await sql(`select course_id from public.cohorts where id = $1`, [otherBlock]))[0].course_id;
    await expect(as(faculty, (q) => q(`insert into public.scan_categories (course_id, cohort_id, key, label, target) values ($1, $2, 'dvt', 'DVT', 4)`, [course, otherBlock]))).rejects.toThrow();
    await as(admin, (q) => q(`insert into public.scan_categories (course_id, cohort_id, key, label, target) values ($1, $2, 'dvt', 'DVT', 4)`, [course, otherBlock]));
    const other = await rpc(admin, 'rotation_status', { p_learner: (await createUser('learner', { cohortId: otherBlock })).id, p_cohort: otherBlock });
    expect(cat(other, 'dvt').target).toBe(4);
    expect(other.scans.target_total).toBe(104);
    const mine = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(cat(mine, 'dvt').target).toBe(2);
  });
});

describe('scan logbook (counts only)', () => {
  it('resident-reported counts never count toward completion; they flag a faculty review', async () => {
    const s = await rpc(resident, 'report_scans', { p_cohort: block, p_counts: [{ category: cats.cardiac, count: 12 }] });
    expect(cat(s, 'cardiac')).toMatchObject({ reported: 12, verified: 0, met: false });
    expect(s.scans.verified_total).toBe(0);
    const f = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(status(f, 'scan_logbook')).toMatchObject({ status: 'submitted', action: 'faculty' });
  });

  it('faculty record several categories in one batch; the reviewer and date are kept', async () => {
    const s = await rpc(faculty, 'attest_scans', { p_attested: true,
      p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-15', p_note: 'Reviewed in QPath with the resident',
      p_entries: [{ category: cats.airway, delta: 5, views_confirmed: true }, { category: cats.cardiac, delta: 12 }, { category: cats.gastric, delta: 20 }],
    });
    expect(cat(s, 'airway')).toMatchObject({ verified: 5, met: true });
    expect(cat(s, 'cardiac')).toMatchObject({ verified: 12, met: false });
    expect(cat(s, 'gastric')).toMatchObject({ verified: 20, met: true }); // no views rule for gastric
    expect(s.scans.verified_total).toBe(37);
    expect(s.scans.history[0].entries).toHaveLength(3);
    expect(s.scans.history[0].note).toBe('Reviewed in QPath with the resident');
    const [log] = await sql(`select action, details from public.audit_log where action = 'scans_attested' order by id desc limit 1`);
    expect(log.details.learner).toBe(resident.id);
  });

  it('a category with a views rule is complete only once faculty confirm the views', async () => {
    let s = await rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_entries: [{ category: cats.cardiac, delta: 28 }] });
    expect(cat(s, 'cardiac')).toMatchObject({ verified: 40, met: false });
    s = await rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_entries: [{ category: cats.cardiac, delta: 0, views_confirmed: true }] });
    expect(cat(s, 'cardiac').met).toBe(true);
  });

  it('reductions need a correction with a reason, cannot go below zero, and are kept in the history', async () => {
    await expect(rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_entries: [{ category: cats.gastric, delta: -2 }] }))
      .rejects.toThrow(/correction/);
    await expect(rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_correction: true, p_entries: [{ category: cats.gastric, delta: -2 }] }))
      .rejects.toThrow(/reason/);
    await expect(rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_correction: true, p_note: 'Entered twice', p_entries: [{ category: cats.dvt, delta: -1 }] }))
      .rejects.toThrow(/below zero/);
    const s = await rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_correction: true, p_note: 'Two studies entered twice', p_entries: [{ category: cats.gastric, delta: -2 }] });
    expect(cat(s, 'gastric')).toMatchObject({ verified: 18, met: false });
    expect(s.scans.history[0]).toMatchObject({ is_correction: true, note: 'Two studies entered twice' });
    expect((await sql(`select count(*)::int n from public.scan_attestations where learner_id = $1`, [resident.id]))[0].n).toBe(6);
  });

  it('notes that look like patient identifiers are refused', async () => {
    for (const note of ['MRN 4481234', 'pt born 1961-03-04', 'DOB 03/04/61', 'Health card 1234-567-890']) {
      await expect(rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_note: note, p_entries: [{ category: cats.dvt, delta: 1 }] }))
        .rejects.toThrow(/patient identifiers/);
    }
  });

  it('only evaluators of the block attest; never for themselves; never in the future; no direct writes', async () => {
    await expect(rpc(otherFaculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_entries: [{ category: cats.dvt, delta: 1 }] })).rejects.toThrow();
    await expect(rpc(resident, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2026-10-16', p_entries: [{ category: cats.dvt, delta: 1 }] })).rejects.toThrow();
    await expect(rpc(faculty, 'attest_scans', { p_attested: true, p_learner: resident.id, p_cohort: block, p_reviewed_on: '2999-01-01', p_entries: [{ category: cats.dvt, delta: 1 }] })).rejects.toThrow(/future/);
    await expect(as(faculty, (q) => q(`insert into public.scan_attestations (batch_id, learner_id, cohort_id, category_id, delta, reviewed_on) values (gen_random_uuid(), $1, $2, $3, 50, current_date)`,
      [resident.id, block, cats.lung_pleura]))).rejects.toThrow();
    await expect(as(resident, (q) => q(`update public.scan_self_reports set count = 999`))).rejects.toThrow();
  });
});

describe('attestation requirements', () => {
  it('resident submits, faculty asks for clarification with a message, then verifies; who and when are kept', async () => {
    let s = await rpc(resident, 'set_requirement_status', { p_requirement: reqs.teachingmedicine, p_learner: resident.id, p_cohort: block, p_status: 'submitted', p_note: 'All 6 modules done' });
    expect(status(s, 'teachingmedicine')).toMatchObject({ status: 'submitted', resident_note: 'All 6 modules done' });
    await expect(rpc(faculty, 'set_requirement_status', { p_requirement: reqs.teachingmedicine, p_learner: resident.id, p_cohort: block, p_status: 'clarification_requested' })).rejects.toThrow(/message/);
    s = await rpc(faculty, 'set_requirement_status', { p_requirement: reqs.teachingmedicine, p_learner: resident.id, p_cohort: block, p_status: 'clarification_requested', p_note: 'Module 4 not shown as complete' });
    const mine = (await rpc(resident, 'my_requirements'))[0].rotation;
    expect(status(mine, 'teachingmedicine')).toMatchObject({ status: 'clarification_requested', faculty_message: 'Module 4 not shown as complete', action: 'resident' });
    s = await rpc(faculty, 'set_requirement_status', { p_requirement: reqs.teachingmedicine, p_learner: resident.id, p_cohort: block, p_status: 'verified' });
    expect(status(s, 'teachingmedicine')).toMatchObject({ status: 'verified', action: null });
    expect(status(s, 'teachingmedicine').verified_by_name).toBeTruthy();
    expect(status(s, 'teachingmedicine').verified_at).toBeTruthy();
    // once verified the resident cannot change it
    await expect(rpc(resident, 'set_requirement_status', { p_requirement: reqs.teachingmedicine, p_learner: resident.id, p_cohort: block, p_status: 'in_progress' })).rejects.toThrow(/confirmed/);
  });

  it('rounds: resident plans; only faculty record review and presentation; not-yet-due is a faculty decision', async () => {
    await rpc(resident, 'set_requirement_status', { p_requirement: reqs.pocus_rounds, p_learner: resident.id, p_cohort: block, p_status: 'in_progress', p_stage: 'planned' });
    await expect(rpc(resident, 'set_requirement_status', { p_requirement: reqs.pocus_rounds, p_learner: resident.id, p_cohort: block, p_status: 'in_progress', p_stage: 'presented' })).rejects.toThrow(/faculty/);
    await expect(rpc(resident, 'set_requirement_status', { p_requirement: reqs.pocus_rounds, p_learner: resident.id, p_cohort: block, p_status: 'not_yet_due' })).rejects.toThrow();
    const s = await rpc(faculty, 'set_requirement_status', { p_requirement: reqs.pocus_rounds, p_learner: resident.id, p_cohort: block, p_status: 'in_progress', p_stage: 'faculty_reviewed' });
    expect(status(s, 'pocus_rounds')).toMatchObject({ stage: 'faculty_reviewed', detail: 'Reviewed by faculty before presenting' });
    const n = await rpc(faculty, 'set_requirement_status', { p_requirement: reqs.pocus_rounds, p_learner: otherResident.id, p_cohort: block, p_status: 'not_yet_due' });
    expect(status(n, 'pocus_rounds')).toMatchObject({ status: 'not_yet_due', action: null });
  });

  it('computed requirements accept only not-yet-due / not-applicable overrides, which can be cleared', async () => {
    await expect(rpc(faculty, 'set_requirement_status', { p_requirement: reqs.written_exam, p_learner: resident.id, p_cohort: block, p_status: 'verified' })).rejects.toThrow(/automatically/);
    let s = await rpc(faculty, 'set_requirement_status', { p_requirement: reqs.c6_epas, p_learner: otherResident.id, p_cohort: block, p_status: 'not_applicable', p_note: 'Off-cycle block' });
    expect(status(s, 'c6_epas')).toMatchObject({ status: 'not_applicable', override: true });
    s = await rpc(faculty, 'set_requirement_status', { p_requirement: reqs.c6_epas, p_learner: otherResident.id, p_cohort: block, p_status: 'clear' });
    expect(status(s, 'c6_epas')).toMatchObject({ status: 'not_started', override: false });
    await expect(rpc(resident, 'set_requirement_status', { p_requirement: reqs.qpath_portfolio, p_learner: otherResident.id, p_cohort: block, p_status: 'submitted' })).rejects.toThrow();
  });
});

describe('computed from existing records', () => {
  it('exam: uses the rotation pass mark (75%), not the exam version threshold; hides unreleased scores from the resident', async () => {
    const exam = await makePublishedExam(admin, { release_mode: 'manual' }); // exam version threshold: 60%
    await assign(admin, exam.versionId, { cohortId: block });
    const [a] = await rpc(resident, 'my_exams');
    const id = await rpc(resident, 'start_attempt', { p_assignment: a.assignment_id });
    await rpc(resident, 'submit_attempt', { p_attempt: id });
    await sql(`update public.attempts set score_pct = 70, grading_status = 'complete', passed = true where id = $1`, [id]);
    let s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(status(s, 'written_exam')).toMatchObject({ status: 'in_progress', action: 'resident' });
    expect(status(s, 'written_exam').detail).toMatch(/below the rotation pass mark of 75%/);
    let mine = (await rpc(resident, 'my_requirements'))[0].rotation;
    expect(status(mine, 'written_exam')).toMatchObject({ status: 'submitted', detail: 'Submitted — results not yet released' });
    expect(JSON.stringify(status(mine, 'written_exam'))).not.toMatch(/70/);
    await sql(`update public.attempts set score_pct = 80, released_at = now() where id = $1`, [id]);
    s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(status(s, 'written_exam')).toMatchObject({ status: 'verified', verified_by_name: 'the portal (automatic scoring)' });
    mine = (await rpc(resident, 'my_requirements'))[0].rotation;
    expect(status(mine, 'written_exam').detail).toMatch(/80/);
  });

  it('EPA and Brightspace cases follow the existing EPA review and evidence verification', async () => {
    await as(faculty, (q) => q(`insert into public.epa_reviews (course_id, learner_id, cohort_id, entries, review_date, status) select course_id, $1, $2, '[{"epa":"DEMO"}]', current_date, 'complete' from public.cohorts where id = $2`, [resident.id, block]));
    const s = await rpc(faculty, 'rotation_status', { p_learner: resident.id, p_cohort: block });
    expect(status(s, 'c6_epas')).toMatchObject({ status: 'verified' });
    expect(status(s, 'brightspace_cases')).toMatchObject({ status: 'not_started', action: 'resident', detail: '0/4 verified' });
    // the resident sees the EPA status but none of the EPA review content
    const mine = (await rpc(resident, 'my_requirements'))[0].rotation;
    expect(status(mine, 'c6_epas')).toMatchObject({ status: 'verified', detail: '' });
  });
});

describe('access', () => {
  it('residents see only their own status; never another resident, faculty notes on scans, or the overview', async () => {
    const mine = (await rpc(resident, 'my_requirements'))[0].rotation;
    expect(mine.scans.history.every((h: any) => h.note === '')).toBe(true);
    await expect(rpc(resident, 'rotation_status', { p_learner: resident.id, p_cohort: block })).rejects.toThrow();
    await expect(rpc(resident, 'rotation_block_overview', { p_cohort: block })).rejects.toThrow();
    expect(await as(resident, (q) => q(`select * from public.scan_attestations`))).toEqual([]);
    expect(await as(otherResident, (q) => q(`select * from public.requirement_status where learner_id = $1`, [resident.id]))).toEqual([]);
    await expect(rpc(otherFaculty, 'rotation_status', { p_learner: resident.id, p_cohort: block })).rejects.toThrow();
  });

  it('block overview summarises each resident for evaluators', async () => {
    const o = await rpc(faculty, 'rotation_block_overview', { p_cohort: block });
    const me = o.find((r: any) => r.learner_id === resident.id);
    expect(me.scans).toMatchObject({ target_total: 102 });
    expect(me.requirements.find((r: any) => r.key === 'teachingmedicine').status).toBe('verified');
    expect(o.find((r: any) => r.learner_id === otherResident.id).requirements.find((r: any) => r.key === 'pocus_rounds').status).toBe('not_yet_due');
  });
});
