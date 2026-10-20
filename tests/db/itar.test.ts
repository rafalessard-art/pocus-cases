/**
 * ITAR preparation workspace: evidence upload + verification, EPA review,
 * categorised observations, block-scoped access, ITAR approval, audit and
 * retention. All people and documents are fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, assign, createUser, makeCohort, makePublishedExam, pocusCourseId, pool, rpc, sql, type User } from './helpers';

let admin: User, faculty: User, otherFaculty: User, resident: User, otherResident: User, outsider: User;
let block: string, otherBlock: string, course: string;
let reqIds: string[];

async function upload(user: User, requirement: string, cohort: string, mime = 'application/pdf') {
  const r = await rpc(user, 'begin_evidence_upload', {
    p_requirement: requirement, p_cohort: cohort,
    p_file: { filename: 'brightspace-completion.pdf', mime_type: mime, size_bytes: 2048, sha256: 'abc' }, p_note: 'Completed in Brightspace',
  });
  // what the Storage API does when the browser uploads (RLS-checked)
  await as(user, (q) => q(`insert into storage.objects (bucket_id, name, owner, metadata) values ('itar-evidence', $1, $2, '{"size": 2048, "mimetype": "${mime}"}')`, [r.storage_path, user.id]));
  const done = await rpc(user, 'complete_evidence_upload', { p_id: r.id, p_ok: true });
  expect(done.status).toBe('uploaded');
  return r as { id: string; storage_path: string };
}

/** A delete as the Storage API issues it (it sets storage.allow_delete_query; RLS still applies). */
function storageDelete(user: User, where: string, params: unknown[]) {
  return as(user, async (q) => {
    await q(`select set_config('storage.allow_delete_query', 'true', true)`);
    return q(`delete from storage.objects where bucket_id = 'itar-evidence' and ${where} returning name`, params);
  });
}

beforeAll(async () => {
  course = await pocusCourseId();
  block = await makeCohort();
  otherBlock = await makeCohort();
  await sql(`update public.cohorts set start_date = '2026-09-01', end_date = '2026-09-28' where id = $1`, [block]);
  admin = await createUser('admin');
  faculty = await createUser('faculty', { cohortId: block });
  otherFaculty = await createUser('faculty', { cohortId: otherBlock });
  resident = await createUser('learner', { cohortId: block, name: 'Fictional Resident A' });
  otherResident = await createUser('learner', { cohortId: block, name: 'Fictional Resident B' });
  outsider = await createUser('learner', { cohortId: otherBlock });
  reqIds = (await sql(`select id from public.evidence_requirements where course_id = $1 and cohort_id is null and archived_at is null order by sort`, [course])).map((r) => r.id);
});
afterAll(() => pool.end());

describe('requirements', () => {
  it('ships draft POCUS requirements that residents can read', async () => {
    expect(reqIds.length).toBeGreaterThanOrEqual(4);
    const mine = await rpc(resident, 'my_evidence');
    const b = mine.find((x: any) => x.cohort.id === block);
    expect(b.requirements.length).toBe(reqIds.length);
  });

  it('supports block-specific requirements without code changes, and only admins edit them', async () => {
    const [r] = await as(admin, (q) => q(`insert into public.evidence_requirements (course_id, cohort_id, title) values ($1, $2, 'Block-only case') returning id`, [course, block]));
    const mine = await rpc(resident, 'my_evidence');
    expect(mine.find((x: any) => x.cohort.id === block).requirements.map((q: any) => q.title)).toContain('Block-only case');
    const theirs = await rpc(outsider, 'my_evidence');
    expect(theirs.find((x: any) => x.cohort.id === otherBlock).requirements.map((q: any) => q.title)).not.toContain('Block-only case');
    await expect(as(faculty, (q) => q(`insert into public.evidence_requirements (course_id, title) values ($1, 'x')`, [course]))).rejects.toThrow(/row-level security/);
    await as(admin, (q) => q(`update public.evidence_requirements set archived_at = now() where id = $1`, [r.id]));
  });
});

describe('evidence upload and verification', () => {
  let sub: { id: string; storage_path: string };

  it('a resident uploads privately; nobody else in the block can see it', async () => {
    sub = await upload(resident, reqIds[0], block);
    expect(await as(resident, (q) => q(`select public.can_read_evidence($1) as ok`, [sub.storage_path]))).toEqual([{ ok: true }]);
    expect(await as(otherResident, (q) => q(`select public.can_read_evidence($1) as ok`, [sub.storage_path]))).toEqual([{ ok: false }]);
    expect(await as(otherResident, (q) => q(`select * from public.evidence_submissions`))).toHaveLength(0);
    expect(await as(faculty, (q) => q(`select public.can_read_evidence($1) as ok`, [sub.storage_path]))).toEqual([{ ok: true }]);
    expect(await as(otherFaculty, (q) => q(`select public.can_read_evidence($1) as ok`, [sub.storage_path]))).toEqual([{ ok: false }]);
  });

  it('residents cannot upload into another block, write rows directly, or store a file without a pending record', async () => {
    await expect(rpc(outsider, 'begin_evidence_upload', { p_requirement: reqIds[0], p_cohort: block, p_file: { mime_type: 'application/pdf', size_bytes: 10 } }))
      .rejects.toThrow(/not a resident in this rotation block/);
    await expect(rpc(resident, 'begin_evidence_upload', { p_requirement: reqIds[0], p_cohort: block, p_file: { mime_type: 'text/html', size_bytes: 10 } }))
      .rejects.toThrow(/PDF, PNG, JPEG or WebP/);
    await expect(rpc(resident, 'begin_evidence_upload', { p_requirement: reqIds[0], p_cohort: block, p_file: { mime_type: 'application/pdf', size_bytes: 20_000_000 } }))
      .rejects.toThrow(/10 MB/);
    await expect(as(resident, (q) => q(`update public.evidence_submissions set status = 'verified' where id = $1`, [sub.id]))).rejects.toThrow(/permission denied/);
    await expect(as(resident, (q) => q(`insert into storage.objects (bucket_id, name) values ('itar-evidence', $1)`, [`${resident.id}/${block}/sneaky.pdf`])))
      .rejects.toThrow(/row-level security/);
    expect(await storageDelete(otherResident, 'name = $1', [sub.storage_path])).toHaveLength(0);
    expect(await storageDelete(resident, 'name = $1', [sub.storage_path])).toHaveLength(0);
    expect(await sql(`select 1 from storage.objects where name = $1`, [sub.storage_path])).toHaveLength(1);
  });

  it('only an evaluator of the block can review; non-verified decisions need a message; reviews are audited', async () => {
    await expect(rpc(otherFaculty, 'review_evidence', { p_id: sub.id, p_status: 'verified' })).rejects.toThrow(/Evidence not found/);
    await expect(rpc(resident, 'review_evidence', { p_id: sub.id, p_status: 'verified' })).rejects.toThrow(/Evidence not found/);
    await expect(rpc(faculty, 'review_evidence', { p_id: sub.id, p_status: 'clarification_requested', p_message: '' })).rejects.toThrow(/Add a message/);
    const c = await rpc(faculty, 'review_evidence', { p_id: sub.id, p_status: 'clarification_requested', p_message: 'The screenshot does not show your name.' });
    expect(c.status).toBe('clarification_requested');
    const mine = await rpc(resident, 'my_evidence');
    const s = mine.find((x: any) => x.cohort.id === block).requirements.find((r: any) => r.id === reqIds[0]).submissions[0];
    expect(s.reviewer_message).toMatch(/does not show your name/);
    expect(s).not.toHaveProperty('reviewed_by');
    const v = await rpc(faculty, 'review_evidence', { p_id: sub.id, p_status: 'verified' });
    expect(v.status).toBe('verified');
    const log = await sql(`select action, details from public.audit_log where entity = 'evidence_submissions' and entity_id = $1 order by id`, [sub.id]);
    expect(log.map((l) => l.action)).toEqual(['evidence_uploaded', 'evidence_clarification_requested', 'evidence_verified']);
    expect(log[2].details.previous_status).toBe('clarification_requested');
  });
});

describe('EPA review, observations and access separation', () => {
  it('EPA review: faculty of the block only; completion needs a date; complete reviews are locked until re-opened', async () => {
    await expect(as(otherFaculty, (q) => q(`insert into public.epa_reviews (course_id, learner_id, cohort_id) values ($1, $2, $3)`, [course, resident.id, block])))
      .rejects.toThrow(/row-level security/);
    const [r] = await as(faculty, (q) => q(
      `insert into public.epa_reviews (course_id, learner_id, cohort_id, entries, strengths) values ($1, $2, $3, $4, 'Fictional strength') returning id, status`,
      [course, resident.id, block, JSON.stringify([{ epa: 'DEMO-EPA-1', title: 'Fictional EPA', n_assessments: 2, entrustment: 'Level 4 (x2)' }])],
    ));
    expect(r.status).toBe('pending');
    await expect(as(faculty, (q) => q(`update public.epa_reviews set status = 'complete' where id = $1`, [r.id]))).rejects.toThrow(/review date/);
    await as(faculty, (q) => q(`update public.epa_reviews set status = 'complete', review_date = '2026-09-27' where id = $1`, [r.id]));
    await expect(as(faculty, (q) => q(`update public.epa_reviews set strengths = 'changed' where id = $1`, [r.id]))).rejects.toThrow(/Re-open/);
    await as(faculty, (q) => q(`update public.epa_reviews set status = 'pending' where id = $1`, [r.id]));
    await as(faculty, (q) => q(`update public.epa_reviews set status = 'complete' where id = $1`, [r.id]));
    const acts = (await sql(`select action from public.audit_log where entity = 'epa_reviews' and entity_id = $1 and action like 'epa_%' order by id`, [r.id])).map((x) => x.action);
    expect(acts).toEqual(['epa_review_completed', 'epa_review_reopened', 'epa_review_completed']);
    await expect(as(faculty, (q) => q(`delete from public.epa_reviews where id = $1`, [r.id]))).resolves.toEqual([]);
    expect(await sql(`select 1 from public.epa_reviews where id = $1`, [r.id])).toHaveLength(1);
  });

  it('categorised observations are block-scoped', async () => {
    await as(faculty, (q) => q(
      `insert into public.faculty_notes (course_id, learner_id, cohort_id, author_id, category, observed_on, body) values ($1, $2, $3, $4, 'scanning', '2026-09-10', 'Fictional: obtained a clear A4C view independently.')`,
      [course, resident.id, block, faculty.id],
    ));
    await expect(as(otherFaculty, (q) => q(
      `insert into public.faculty_notes (course_id, learner_id, cohort_id, author_id, category, body) values ($1, $2, $3, $4, 'scanning', 'x')`,
      [course, resident.id, block, otherFaculty.id],
    ))).rejects.toThrow(/row-level security/);
    await expect(as(faculty, (q) => q(`insert into public.faculty_notes (course_id, learner_id, cohort_id, author_id, category, body) values ($1, $2, $3, $4, 'vibes', 'x')`,
      [course, resident.id, block, faculty.id]))).rejects.toThrow(/check constraint/);
    expect(await as(otherFaculty, (q) => q(`select * from public.faculty_notes where learner_id = $1`, [resident.id]))).toHaveLength(0);
  });

  it('learners cannot see EPA reviews, observations, ITARs or the workspace — even their own', async () => {
    for (const t of ['epa_reviews', 'faculty_notes', 'evaluations', 'retention_settings']) {
      expect(await as(resident, (q) => q(`select * from public.${t}`)), t).toHaveLength(0);
    }
    await expect(rpc(resident, 'itar_workspace', { p_learner: resident.id, p_cohort: block })).rejects.toThrow(/not found/);
    await expect(rpc(resident, 'itar_block_overview', { p_cohort: block })).rejects.toThrow(/Faculty access/);
    await expect(rpc(otherFaculty, 'itar_workspace', { p_learner: resident.id, p_cohort: block })).rejects.toThrow(/not found/);
    await expect(rpc(otherFaculty, 'itar_block_overview', { p_cohort: block })).rejects.toThrow(/Block not found/);
    const blocks = await rpc(otherFaculty, 'itar_blocks');
    expect(blocks.map((b: any) => b.id)).toEqual([otherBlock]);
  });
});

describe('workspace, overview and ITAR approval', () => {
  let exam: Awaited<ReturnType<typeof makePublishedExam>>;
  let evalId: string;

  beforeAll(async () => {
    exam = await makePublishedExam(admin, { release_mode: 'immediate', max_attempts: 2 });
    await assign(admin, exam.versionId, { cohortId: block });
    const [a] = await rpc(resident, 'my_exams');
    const id = await rpc(resident, 'start_attempt', { p_assignment: a.assignment_id });
    await rpc(resident, 'submit_attempt', { p_attempt: id });
  });

  it('assembles the workspace for an evaluator', async () => {
    const w = await rpc(faculty, 'itar_workspace', { p_learner: resident.id, p_cohort: block });
    expect(w.learner.full_name).toBe('Fictional Resident A');
    expect(w.attempts).toHaveLength(1);
    expect(w.attempts[0].breakdown.domains.length).toBeGreaterThan(0);
    expect(w.requirements.find((r: any) => r.id === reqIds[0]).submissions[0].status).toBe('verified');
    expect(w.epa_review.status).toBe('complete');
    expect(w.observations[0].category).toBe('scanning');
    expect(w.roster.map((r: any) => r.id).sort()).toEqual([resident.id, otherResident.id].sort());
    expect(w.evaluation).toBeNull();
  });

  it('overview reflects exam, evidence, EPA and ITAR status per resident', async () => {
    const o = await rpc(faculty, 'itar_block_overview', { p_cohort: block });
    const a = o.residents.find((r: any) => r.id === resident.id);
    const b = o.residents.find((r: any) => r.id === otherResident.id);
    expect(a.exam.latest.grading_status).toBeDefined();
    expect(a.evidence).toMatchObject({ required: reqIds.length, submitted: 1, verified: 1 });
    expect(a.epa_status).toBe('complete');
    expect(a.n_observations).toBe(1);
    expect(a.itar).toBeNull();
    expect(b.exam.n_attempts).toBe(0);
    expect(b.evidence.submitted).toBe(0);
    expect(b.epa_status).toBe('not_started');
  });

  it('one ITAR per resident per block; approval locks it, is audited, and is blocked for oneself', async () => {
    const [e] = await as(faculty, (q) => q(
      `insert into public.evaluations (course_id, learner_id, cohort_id, itar_sections, summary) values ($1, $2, $3, $4, 'Draft text') returning id`,
      [course, resident.id, block, JSON.stringify([{ key: 'exam', title: 'Exam', text: 'Draft text' }])],
    ));
    evalId = e.id;
    await expect(as(faculty, (q) => q(`insert into public.evaluations (course_id, learner_id, cohort_id) values ($1, $2, $3)`, [course, resident.id, block])))
      .rejects.toThrow(/duplicate key/);
    expect(await as(otherFaculty, (q) => q(`select * from public.evaluations where id = $1`, [evalId]))).toHaveLength(0);
    await as(faculty, (q) => q(`update public.evaluations set status = 'approved' where id = $1`, [evalId]));
    await expect(as(faculty, (q) => q(`update public.evaluations set summary = 'x' where id = $1`, [evalId]))).rejects.toThrow(/Re-open|locked/);
    const [l] = await sql(`select details from public.audit_log where action = 'evaluation_approved' and entity_id = $1`, [evalId]);
    expect(l.details.cohort).toBe(block);
    await rpc(faculty, 'log_itar_export', { p_evaluation: evalId, p_format: 'copy_all' });
    await expect(rpc(otherFaculty, 'log_itar_export', { p_evaluation: evalId, p_format: 'text' })).rejects.toThrow(/not found/);
    expect(await sql(`select 1 from public.audit_log where action = 'itar_exported' and entity_id = $1`, [evalId])).toHaveLength(1);
    // observations that fed an approved ITAR stay on record
    const n = await as(faculty, (q) => q(`delete from public.faculty_notes where learner_id = $1 and cohort_id = $2 returning id`, [resident.id, block]));
    expect(n).toHaveLength(0);
    // an admin cannot approve an ITAR about themself
    await sql(`insert into public.cohort_members (cohort_id, user_id, member_role) values ($1, $2, 'learner')`, [otherBlock, admin.id]);
    await expect(as(admin, (q) => q(`insert into public.evaluations (course_id, learner_id, cohort_id, summary, status) values ($1, $2, $3, 'x', 'approved')`, [course, admin.id, otherBlock])))
      .rejects.toThrow(/about yourself/);
  });

  it('overview shows the approved ITAR', async () => {
    const o = await rpc(faculty, 'itar_block_overview', { p_cohort: block });
    expect(o.residents.find((r: any) => r.id === resident.id).itar.status).toBe('approved');
    const blocks = await rpc(faculty, 'itar_blocks');
    expect(blocks.find((b: any) => b.id === block).n_approved).toBe(1);
  });
});

describe('retention', () => {
  it('lists files past the configured period, deletes only marked files, keeps the record', async () => {
    await sql(`update public.retention_settings set retain_days = null where key = 'itar_evidence_files'`);
    expect(await rpc(admin, 'evidence_due_for_deletion')).toEqual([]);  // default: keep
    await expect(rpc(faculty, 'evidence_due_for_deletion')).rejects.toThrow(/Administrator/);
    await expect(as(faculty, (q) => q(`update public.retention_settings set retain_days = 1`))).resolves.toEqual([]);
    await as(admin, (q) => q(`update public.retention_settings set retain_days = 7 where key = 'itar_evidence_files'`));
    const due = await rpc(admin, 'evidence_due_for_deletion');
    const ids = due.map((d: any) => d.id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const [{ storage_path: path }] = await sql(`select storage_path from public.evidence_submissions where id = $1`, [ids[0]]);
    // not yet marked: even an admin's storage delete matches nothing
    expect(await storageDelete(admin, 'name = $1', [path])).toHaveLength(0);
    await expect(rpc(admin, 'request_evidence_file_deletion', { p_ids: ids, p_reason: '' })).rejects.toThrow(/reason/);
    const paths = await rpc(admin, 'request_evidence_file_deletion', { p_ids: ids, p_reason: 'Retention policy (7 days after block end)' });
    expect(paths).toContain(path);
    expect(await storageDelete(faculty, 'name = $1', [path])).toHaveLength(0);
    expect(await storageDelete(admin, 'name = any($1)', [paths])).toHaveLength(paths.length);
    expect(await rpc(admin, 'confirm_evidence_file_deletion', { p_ids: ids })).toBe(ids.length);
    const [row] = await sql(`select status, file_deleted_at, sha256 from public.evidence_submissions where id = $1`, [ids[0]]);
    expect(row.status).toBe('verified');
    expect(row.file_deleted_at).not.toBeNull();
    expect(row.sha256).toBe('abc');
    expect(await rpc(admin, 'evidence_due_for_deletion')).toEqual([]);
    await as(admin, (q) => q(`update public.retention_settings set retain_days = null where key = 'itar_evidence_files'`));
  });
});
