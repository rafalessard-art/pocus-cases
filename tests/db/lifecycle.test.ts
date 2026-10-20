/**
 * Exam lifecycle: versioning, autosave semantics, timing, attempts,
 * accommodations, server-side grading, manual grading, result release,
 * reporting and evaluations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, assign, byStem, createUser, makeCohort, makeMedia, makePublishedExam, makeQuestion, pocusCourseId, pool, rpc, sql, type User } from './helpers';

let admin: User, faculty: User;
beforeAll(async () => {
  admin = await createUser('admin');
});
afterAll(() => pool.end());

async function learnerWithExam(settings: Record<string, unknown> = {}) {
  const cohortId = await makeCohort();
  faculty = await createUser('faculty', { cohortId });
  const learner = await createUser('learner', { cohortId });
  const exam = await makePublishedExam(admin, settings);
  const assignmentId = await assign(admin, exam.versionId, { cohortId });
  return { learner, exam, assignmentId, cohortId };
}

describe('validation & publishing', () => {
  it('refuses to publish with unauthorized or non-de-identified media, flagged or incomplete questions', async () => {
    const m = await makeMedia(admin, { authorize: false, deidentify: false });
    const q = await makeQuestion(admin, {
      type: 'single', stem: 'needs auth', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], key: { correct: ['z'] },
      media: [{ media_version_id: m.versionId }], needs_review: true, review_note: 'imported',
    });
    const msgs = q.issues.map((i: any) => i.message).join(' | ');
    expect(msgs).toMatch(/not authorized/);
    expect(msgs).toMatch(/de-identified/);
    expect(msgs).toMatch(/does not exist/);
    expect(msgs).toMatch(/faculty review/);
    const ex = await rpc(admin, 'create_exam', { p_course_id: await pocusCourseId(), p_title: 'Bad', p_description: '' });
    await rpc(admin, 'set_exam_items', { p_exam_version_id: ex.exam_version_id, p_items: [{ question_version_id: q.question_version_id }] });
    const pub = await rpc(admin, 'publish_exam_version', { p_exam_version_id: ex.exam_version_id });
    expect(pub.published).toBe(false);
    const [v] = await sql(`select status from exam_versions where id = $1`, [ex.exam_version_id]);
    expect(v.status).toBe('draft');
  });

  it('rejects unsupported media formats at registration', async () => {
    await expect(makeMedia(admin, { mime: 'video/x-msvideo' })).rejects.toThrow(/Unsupported format/);
  });
});

describe('versioning', () => {
  it('editing a published question creates a new version; published exam and past results are untouched', async () => {
    const { exam } = await learnerWithExam();
    const q1 = exam.q[0];
    // published exam version and its items are frozen
    await expect(as(admin, (q) => q(`update public.exam_versions set title = 'changed' where id = $1`, [exam.versionId]))).resolves.toHaveLength(0);
    await expect(sql(`update public.exam_versions set title = 'changed' where id = $1`, [exam.versionId])).rejects.toThrow(/create a new draft/);
    await expect(sql(`delete from public.exam_items where exam_version_id = $1`, [exam.versionId])).rejects.toThrow(/cannot be changed/);
    await expect(sql(`update public.question_versions set stem = 'x' where id = $1`, [q1.question_version_id])).rejects.toThrow(/locked/);

    const draftId = await rpc(admin, 'new_exam_draft', { p_exam_id: exam.examId });
    const edited = await makeQuestion(admin, {
      question_id: q1.question_id, type: 'single', stem: 'Q1 single (reworded)',
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], key: { correct: ['c'] },
    });
    expect(edited.new_version).toBe(true);
    expect(edited.question_version_id).not.toBe(q1.question_version_id);
    const [pubItem] = await sql(`select question_version_id from exam_items where exam_version_id = $1 and position = 0`, [exam.versionId]);
    expect(pubItem.question_version_id).toBe(q1.question_version_id);
    const [draftItem] = await sql(`select question_version_id from exam_items where exam_version_id = $1 and position = 0`, [draftId]);
    expect(draftItem.question_version_id).toBe(edited.question_version_id);
    // old key unchanged
    const [k] = await sql(`select key from question_keys where question_version_id = $1`, [q1.question_version_id]);
    expect(k.key.correct).toEqual(['b']);
  });

  it('uploaded media versions are immutable; replacement creates a new version', async () => {
    const m = await makeMedia(admin);
    await expect(sql(`update media_versions set storage_path = 'x' where id = $1`, [m.versionId])).rejects.toThrow(/immutable/);
    await expect(sql(`delete from media_versions where id = $1`, [m.versionId])).rejects.toThrow(/permanent/);
    const r = await rpc(admin, 'begin_media_upload', { p_asset_id: m.assetId, p_asset: {}, p_file: { filename: 'new.mp4', mime_type: 'video/mp4' } });
    expect(r.version).toBe(2);
    await expect(
      rpc(admin, 'begin_media_upload', { p_asset_id: m.assetId, p_asset: {}, p_file: { filename: 'still.png', mime_type: 'image/png' } }),
    ).rejects.toThrow(/same kind/);
  });
});

describe('autosave', () => {
  it('stores answers and flags, ignores stale (lower-seq) writes, validates shapes', async () => {
    const { learner, assignmentId } = await learnerWithExam();
    const id = await rpc(learner, 'start_attempt', { p_assignment: assignmentId });
    // resuming returns the same attempt
    expect(await rpc(learner, 'start_attempt', { p_assignment: assignmentId })).toBe(id);
    const att = await rpc(learner, 'get_attempt', { p_attempt: id });
    const it = byStem(att);
    const q1 = it['Q1 single'].item_id;
    await rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: q1, response: { selected: ['c'] }, flagged: true, seq: 5 }] });
    // an older write arriving late must not overwrite the newer answer
    await rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: q1, response: { selected: ['a'] }, flagged: false, seq: 3 }] });
    let cur = await rpc(learner, 'get_attempt', { p_attempt: id });
    const r = cur.responses.find((x: any) => x.item_id === q1);
    expect(r.response).toEqual({ selected: ['c'] });
    expect(r.flagged).toBe(true);
    // invalid option id and multi-select on single-best are rejected
    await expect(
      rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: q1, response: { selected: ['zzz'] }, seq: 9 }] }),
    ).rejects.toThrow(/Invalid answer/);
    await expect(
      rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: q1, response: { selected: ['a', 'b'] }, seq: 9 }] }),
    ).rejects.toThrow(/Invalid answer/);
    // item from another exam is rejected
    await expect(
      rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: '00000000-0000-0000-0000-000000000000', response: null, seq: 9 }] }),
    ).rejects.toThrow(/does not belong/);
    // clearing an answer
    await rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: q1, response: null, flagged: true, seq: 10 }] });
    cur = await rpc(learner, 'get_attempt', { p_attempt: id });
    expect(cur.responses.find((x: any) => x.item_id === q1).response).toBeNull();
  });

  it('allow_resume = false blocks re-entry to an open attempt', async () => {
    const { learner, assignmentId } = await learnerWithExam({ allow_resume: false });
    await rpc(learner, 'start_attempt', { p_assignment: assignmentId });
    await expect(rpc(learner, 'start_attempt', { p_assignment: assignmentId })).rejects.toThrow(/does not allow resuming/);
  });
});

describe('grading and release', () => {
  it('scores on the server, handles partial credit and manual grading, and hides results until release', async () => {
    const { learner, assignmentId, exam } = await learnerWithExam({ release_mode: 'manual', feedback_policy: 'full_review' });
    const id = await rpc(learner, 'start_attempt', { p_assignment: assignmentId });
    const it = byStem(await rpc(learner, 'get_attempt', { p_attempt: id }));
    await rpc(learner, 'save_responses', {
      p_attempt: id,
      p_items: [
        { item_id: it['Q1 single'].item_id, response: { selected: ['b'] }, seq: 1 },          // correct: 1/1
        { item_id: it['Q2 multiple'].item_id, response: { selected: ['a', 'b'] }, seq: 1 },   // partial: (1-1)/2 → 0/2
        { item_id: it['Q3 short'].item_id, response: { text: 'Grade 2' }, seq: 1 },          // manual
        // Q4 unanswered → 0
      ],
    });
    const res = await rpc(learner, 'submit_attempt', { p_attempt: id });
    expect(res.status).toBe('submitted');
    expect(res.released).toBe(false);
    expect(res.score_pct).toBeUndefined();
    expect(JSON.stringify(res)).not.toMatch(/Because B/);
    // no more saving after submission
    const late = await rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: it['Q4 single'].item_id, response: { selected: ['x'] }, seq: 2 }] });
    expect(late.saved).toBe(0);

    let [a] = await sql(`select * from attempts where id = $1`, [id]);
    expect(a.grading_status).toBe('pending_manual');
    expect(Number(a.max_points)).toBe(5);
    expect(a.score_pct).toBeNull();
    // release refused while grading is pending
    expect(await rpc(faculty, 'release_results', { p_attempts: [id] })).toBe(0);

    // faculty grades the short answer
    await expect(rpc(faculty, 'grade_response', { p_attempt: id, p_item: it['Q3 short'].item_id, p_points: 5, p_comment: '' })).rejects.toThrow(/between 0 and 1/);
    await rpc(faculty, 'grade_response', { p_attempt: id, p_item: it['Q3 short'].item_id, p_points: 1, p_comment: 'Good' });
    [a] = await sql(`select * from attempts where id = $1`, [id]);
    expect(a.grading_status).toBe('complete');
    expect(Number(a.score_points)).toBe(2);
    expect(Number(a.score_pct)).toBe(40);
    expect(a.passed).toBe(false); // threshold 60

    expect(await rpc(faculty, 'release_results', { p_attempts: [id] })).toBe(1);
    const out = await rpc(learner, 'get_my_result', { p_attempt: id });
    expect(out.released).toBe(true);
    expect(Number(out.score_pct)).toBe(40);
    expect(out.domains.find((d: any) => d.key === 'cardiac').pct).toBe(100);
    expect(out.domains.find((d: any) => d.key === 'lung').pct).toBe(0);
    expect(out.items[0].explanation).toBe('Because B.');
    // after release with full_review the learner may view the clips again
    expect(await rpc(learner, 'can_read_exam_media', { p_path: exam.media.path })).toBe(true);

    // report reflects the attempt
    const rep = await rpc(faculty, 'exam_report', { p_exam_version: exam.versionId });
    expect(rep.stats.n_completed).toBe(1);
    expect(Number(rep.stats.mean)).toBe(40);
    const item1 = rep.items.find((x: any) => x.position === 1);
    expect(Number(item1.pct_correct)).toBe(100);
  });

  it('partial-credit multiple-select scoring', async () => {
    const r = await sql(
      `select * from public.score_item('multiple', '{"correct":["a","c"]}', '{"selected":["a"]}', '{"mode":"partial"}', 2)`,
    );
    expect(r[0]).toMatchObject({ is_correct: false });
    expect(Number(r[0].points)).toBe(1);
    const all = await sql(`select * from public.score_item('multiple', '{"correct":["a","c"]}', '{"selected":["c","a"]}', '{}', 2)`);
    expect(all[0].is_correct).toBe(true);
    const aon = await sql(`select * from public.score_item('multiple', '{"correct":["a","c"]}', '{"selected":["a"]}', '{}', 2)`);
    expect(Number(aon[0].points)).toBe(0);
  });

  it('hotspot scoring (future question type) works for ellipse and rect regions', async () => {
    const key = JSON.stringify({ regions: [{ media: 0, shape: 'ellipse', x: 0.4, y: 0.4, w: 0.2, h: 0.2 }] });
    const hit = await sql(`select * from public.score_item('hotspot', $1, '{"point":{"media":0,"x":0.5,"y":0.5}}', '{}', 1)`, [key]);
    const miss = await sql(`select * from public.score_item('hotspot', $1, '{"point":{"media":0,"x":0.41,"y":0.41}}', '{}', 1)`, [key]);
    expect(hit[0].is_correct).toBe(true);
    expect(miss[0].is_correct).toBe(false);
  });

  it('immediate release shows the score right away with score-only feedback', async () => {
    const { learner, assignmentId } = await learnerWithExam({ release_mode: 'immediate', feedback_policy: 'score' });
    const id = await rpc(learner, 'start_attempt', { p_assignment: assignmentId });
    const it = byStem(await rpc(learner, 'get_attempt', { p_attempt: id }));
    await rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: it['Q1 single'].item_id, response: { selected: ['b'] }, seq: 1 }] });
    const res = await rpc(learner, 'submit_attempt', { p_attempt: id });
    // short answer unanswered ⇒ 0, no manual grading needed ⇒ complete ⇒ released
    expect(res.released).toBe(true);
    expect(Number(res.score_pct)).toBe(20);
    expect(res.domains).toBeUndefined();
    expect(res.items).toBeUndefined();
  });
});

describe('timing, attempts and accommodations', () => {
  it('rejects saves after the deadline and auto-submits the attempt', async () => {
    const { learner, assignmentId } = await learnerWithExam({ time_limit_minutes: 10 });
    const id = await rpc(learner, 'start_attempt', { p_assignment: assignmentId });
    const it = byStem(await rpc(learner, 'get_attempt', { p_attempt: id }));
    await rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: it['Q1 single'].item_id, response: { selected: ['b'] }, seq: 1 }] });
    await sql(`update attempts set deadline_at = now() - interval '5 minutes' where id = $1`, [id]);
    const r = await rpc(learner, 'save_responses', { p_attempt: id, p_items: [{ item_id: it['Q4 single'].item_id, response: { selected: ['x'] }, seq: 2 }] });
    expect(r.status).toBe('submitted');
    const [a] = await sql(`select status, submit_reason, score_points from attempts where id = $1`, [id]);
    expect(a.status).toBe('submitted');
    expect(a.submit_reason).toBe('time_expired');
    expect(Number(a.score_points)).toBe(1); // answer saved before the deadline counts
  });

  it('enforces max attempts and applies extra time / extra attempts accommodations', async () => {
    const { learner, assignmentId, exam } = await learnerWithExam({ time_limit_minutes: 20, max_attempts: 1 });
    await as(admin, (q) =>
      q(`insert into accommodations (user_id, exam_id, time_multiplier, extra_minutes, extra_attempts, notes) values ($1, $2, 1.5, 5, 1, 'Approved')`, [
        learner.id,
        exam.examId,
      ]),
    );
    const [mine] = await rpc(learner, 'my_exams');
    expect(Number(mine.time_limit_minutes)).toBe(35);
    expect(mine.max_attempts).toBe(2);
    const id1 = await rpc(learner, 'start_attempt', { p_assignment: assignmentId });
    const [a] = await sql(`select extract(epoch from deadline_at - started_at)/60 as mins from attempts where id = $1`, [id1]);
    expect(Math.round(Number(a.mins))).toBe(35);
    await rpc(learner, 'submit_attempt', { p_attempt: id1 });
    const id2 = await rpc(learner, 'start_attempt', { p_assignment: assignmentId });
    expect(id2).not.toBe(id1);
    await rpc(learner, 'submit_attempt', { p_attempt: id2 });
    await expect(rpc(learner, 'start_attempt', { p_assignment: assignmentId })).rejects.toThrow(/No attempts remaining/);
    // attempts are permanent
    await expect(sql(`delete from attempts where id = $1`, [id1])).rejects.toThrow(/permanent/);
  });

  it('respects the assignment window', async () => {
    const cohortId = await makeCohort();
    const learner = await createUser('learner', { cohortId });
    const exam = await makePublishedExam(admin);
    const future = await assign(admin, exam.versionId, { userId: learner.id }, { opens_at: new Date(Date.now() + 86400e3).toISOString() });
    await expect(rpc(learner, 'start_attempt', { p_assignment: future })).rejects.toThrow(/not open yet/);
    const past = await assign(admin, exam.versionId, { userId: learner.id }, {
      opens_at: new Date(Date.now() - 2 * 86400e3).toISOString(), due_at: new Date(Date.now() - 86400e3).toISOString(),
    });
    await expect(rpc(learner, 'start_attempt', { p_assignment: past })).rejects.toThrow(/deadline/);
    const states = (await rpc(learner, 'my_exams')).map((x: any) => x.state).sort();
    expect(states).toEqual(['closed', 'upcoming']);
  });

  it('cannot assign a draft exam version', async () => {
    const ex = await rpc(admin, 'create_exam', { p_course_id: await pocusCourseId(), p_title: 'Draft only', p_description: '' });
    const learner = await createUser('learner');
    await expect(assign(admin, ex.exam_version_id, { userId: learner.id })).rejects.toThrow(/Only published/);
  });
});

describe('evaluations', () => {
  it('drafts are editable; approval locks; re-open unlocks; empty summaries cannot be approved', async () => {
    const { learner, cohortId } = await learnerWithExam();
    const course = await pocusCourseId();
    const [ev] = await as(faculty, (q) =>
      q(`insert into evaluations (course_id, learner_id, cohort_id, summary) values ($1, $2, $3, '') returning id`, [course, learner.id, cohortId]),
    );
    await expect(as(faculty, (q) => q(`update evaluations set status = 'approved' where id = $1`, [ev.id]))).rejects.toThrow(/empty/);
    await as(faculty, (q) => q(`update evaluations set summary = 'Completed exam.', strengths = 'Cardiac' where id = $1`, [ev.id]));
    await as(faculty, (q) => q(`update evaluations set status = 'approved' where id = $1`, [ev.id]));
    const [row] = await sql(`select approved_by, approved_at from evaluations where id = $1`, [ev.id]);
    expect(row.approved_by).toBe(faculty.id);
    await expect(as(faculty, (q) => q(`update evaluations set summary = 'tampered' where id = $1`, [ev.id]))).rejects.toThrow(/locked/);
    await expect(as(faculty, (q) => q(`update evaluations set status = 'draft', summary = 'x' where id = $1`, [ev.id]))).rejects.toThrow(/Re-open/);
    await as(faculty, (q) => q(`update evaluations set status = 'draft' where id = $1`, [ev.id]));
    await as(faculty, (q) => q(`update evaluations set summary = 'Revised.' where id = $1`, [ev.id]));
    // a faculty member outside the cohort cannot see it
    const outsider = await createUser('faculty');
    expect(await as(outsider, (q) => q(`select * from evaluations where id = $1`, [ev.id]))).toHaveLength(0);
    const rep = await rpc(faculty, 'learner_report', { p_learner: learner.id, p_course: course });
    expect(rep.learner.id).toBe(learner.id);
  });
});
