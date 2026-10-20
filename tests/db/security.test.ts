/**
 * Access-control tests: invitation-only accounts, role separation, answer-key
 * secrecy, faculty cohort scoping, storage media access.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, assign, createUser, makeCohort, makePublishedExam, pool, rpc, sql, type User } from './helpers';

let admin: User, faculty: User, otherFaculty: User, learner: User, otherLearner: User, stranger: User;
let cohortId: string, exam: Awaited<ReturnType<typeof makePublishedExam>>;

beforeAll(async () => {
  cohortId = await makeCohort();
  admin = await createUser('admin');
  faculty = await createUser('faculty', { cohortId }); // evaluator in the cohort
  otherFaculty = await createUser('faculty');           // no cohort
  learner = await createUser('learner', { cohortId });
  otherLearner = await createUser('learner');
  stranger = await createUser('none');
  exam = await makePublishedExam(admin);
  await assign(admin, exam.versionId, { cohortId });
});
afterAll(() => pool.end());

describe('accounts', () => {
  it('creates a profile only for invited users, with the invited role and cohort', async () => {
    const [p] = await sql(`select role from public.profiles where id = $1`, [learner.id]);
    expect(p.role).toBe('learner');
    const [m] = await sql(`select member_role from public.cohort_members where user_id = $1 and cohort_id = $2`, [faculty.id, cohortId]);
    expect(m.member_role).toBe('evaluator');
    expect(await sql(`select 1 from public.profiles where id = $1`, [stranger.id])).toHaveLength(0);
  });

  it('auth hook rejects un-invited sign-ups and accepts invited ones', async () => {
    const [bad] = await sql(`select public.hook_before_user_created($1::jsonb) as r`, [JSON.stringify({ user: { email: 'nobody@x.org' } })]);
    expect(bad.r.error.http_code).toBe(403);
    await sql(`insert into public.invitations (email, role) values ('Invited.Person@x.org'::text, 'learner') on conflict do nothing`).catch(() => {});
    await sql(`insert into public.invitations (email, role) values ('invited.person@x.org', 'learner') on conflict do nothing`);
    const [ok] = await sql(`select public.hook_before_user_created($1::jsonb) as r`, [JSON.stringify({ user: { email: 'Invited.Person@X.org' } })]);
    expect(ok.r).toEqual({});
  });

  it('un-invited signed-in users see nothing and cannot call learner functions', async () => {
    const rows = await as(stranger, (q) => q(`select * from public.profiles`));
    expect(rows).toHaveLength(0);
    await expect(rpc(stranger, 'my_exams')).rejects.toThrow(/Not signed in/);
    expect(await as(stranger, (q) => q(`select * from public.courses`))).toHaveLength(0);
  });

  it('anonymous requests cannot read tables or call functions', async () => {
    await expect(as(null, (q) => q(`select * from public.courses`))).rejects.toThrow(/permission denied/);
    await expect(rpc(null, 'my_exams')).rejects.toThrow(/permission denied/);
    await expect(as(null, (q) => q(`select * from public.question_keys`))).rejects.toThrow(/permission denied/);
  });

  it('a learner cannot promote themself', async () => {
    await expect(as(learner, (q) => q(`update public.profiles set role = 'admin' where id = $1`, [learner.id]))).rejects.toThrow(
      /Only an administrator/,
    );
  });
});

describe('exam content secrecy', () => {
  it('learners cannot select answer keys, question versions, exam items or media tables', async () => {
    for (const t of ['question_keys', 'question_versions', 'questions', 'exam_items', 'exam_versions', 'media_assets', 'media_versions', 'attempts', 'responses', 'assignments']) {
      const rows = await as(learner, (q) => q(`select * from public.${t}`));
      expect(rows, t).toHaveLength(0);
    }
  });

  it('learners cannot call admin or faculty functions', async () => {
    await expect(rpc(learner, 'save_question', { p_question_id: null, p: { type: 'single' } })).rejects.toThrow(/Administrator/);
    await expect(rpc(learner, 'exam_report', { p_exam_version: exam.versionId })).rejects.toThrow(/Faculty/);
    await expect(rpc(learner, 'publish_exam_version', { p_exam_version_id: exam.versionId })).rejects.toThrow(/Administrator/);
    await expect(rpc(learner, '_grade_attempt', { p_attempt: exam.versionId })).rejects.toThrow(/permission denied/);
    await expect(rpc(learner, 'attempt_breakdown', { p_attempt: exam.versionId })).rejects.toThrow(/permission denied/);
  });

  it('attempt payload never contains keys or explanations', async () => {
    const [a] = await rpc(learner, 'my_exams');
    const id = await rpc(learner, 'start_attempt', { p_assignment: a.assignment_id });
    const att = await rpc(learner, 'get_attempt', { p_attempt: id });
    const s = JSON.stringify(att);
    expect(s).not.toMatch(/"key"|"correct"|explanation|Because B/);
    expect(att.items).toHaveLength(4);
    // another learner can neither read nor write this attempt
    await expect(rpc(otherLearner, 'get_attempt', { p_attempt: id })).rejects.toThrow(/Attempt not found/);
    await expect(rpc(otherLearner, 'save_responses', { p_attempt: id, p_items: [] })).rejects.toThrow(/Attempt not found/);
    await expect(rpc(otherLearner, 'get_my_result', { p_attempt: id })).rejects.toThrow(/Attempt not found/);
    // direct writes to attempts are impossible even for the owner
    await expect(as(learner, (q) => q(`update public.attempts set score_pct = 100 where id = $1`, [id]))).rejects.toThrow(/permission denied/);
  });

  it('learners only see exams assigned to them', async () => {
    expect(await rpc(otherLearner, 'my_exams')).toEqual([]);
    const [a] = await rpc(learner, 'my_exams');
    await expect(rpc(otherLearner, 'start_attempt', { p_assignment: a.assignment_id })).rejects.toThrow(/not assigned/);
  });
});

describe('storage access to exam media', () => {
  it('learner may read a clip only while it is part of their open attempt', async () => {
    const path = exam.media.path;
    expect(await rpc(learner, 'can_read_exam_media', { p_path: path })).toBe(true); // attempt opened above
    expect(await rpc(otherLearner, 'can_read_exam_media', { p_path: path })).toBe(false);
    expect(await rpc(faculty, 'can_read_exam_media', { p_path: path })).toBe(true);
  });

  it('only admins may create storage objects, and only for registered pending uploads', async () => {
    await expect(
      as(learner, (q) => q(`insert into storage.objects (bucket_id, name) values ('exam-media', 'media/x/evil.mp4')`)),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as(admin, (q) => q(`insert into storage.objects (bucket_id, name) values ('exam-media', 'media/unregistered.mp4')`)),
    ).rejects.toThrow(/row-level security/);
  });
});

describe('faculty scoping', () => {
  it('evaluator faculty can view their cohort learners; other faculty cannot', async () => {
    expect(await rpc(faculty, 'can_view_learner', { p_learner: learner.id })).toBe(true);
    expect(await rpc(otherFaculty, 'can_view_learner', { p_learner: learner.id })).toBe(false);
    await expect(rpc(otherFaculty, 'learner_report', { p_learner: learner.id, p_course: (await sql(`select id from courses where slug='pocus'`))[0].id })).rejects.toThrow(
      /Learner not found/,
    );
    const rep = await rpc(otherFaculty, 'exam_report', { p_exam_version: exam.versionId });
    expect(rep.learners).toHaveLength(0);
    const rep2 = await rpc(faculty, 'exam_report', { p_exam_version: exam.versionId });
    expect(rep2.learners.map((l: any) => l.user_id)).toContain(learner.id);
  });

  it('faculty can read content but cannot edit it', async () => {
    expect((await as(faculty, (q) => q(`select * from public.question_keys`))).length).toBeGreaterThan(0);
    await expect(rpc(faculty, 'save_question', { p_question_id: null, p: { type: 'single' } })).rejects.toThrow(/Administrator/);
    const n = await as(faculty, (q) => q(`update public.exams set title = 'x' where id = $1 returning id`, [exam.examId]));
    expect(n).toHaveLength(0);
  });

  it('audit log is admin-readable and append-only', async () => {
    expect((await as(admin, (q) => q(`select * from public.audit_log limit 5`))).length).toBeGreaterThan(0);
    expect(await as(faculty, (q) => q(`select * from public.audit_log`))).toHaveLength(0);
    await expect(as(admin, (q) => q(`delete from public.audit_log`))).rejects.toThrow(/permission denied/);
  });
});

describe('bypass attempts by an administrator through direct table writes', () => {
  it('cannot publish an exam version or point an assignment at a draft without the publish function', async () => {
    const ex = await rpc(admin, 'create_exam', { p_course_id: (await sql(`select id from courses where slug='pocus'`))[0].id, p_title: 'Bypass', p_description: '' });
    await expect(as(admin, (q) => q(`update public.exam_versions set status = 'published' where id = $1`, [ex.exam_version_id]))).rejects.toThrow(
      /row-level security/,
    );
    const [a] = await as(admin, (q) => q(`select id from public.assignments where exam_version_id = $1 limit 1`, [exam.versionId]));
    await expect(as(admin, (q) => q(`update public.assignments set exam_version_id = $2 where id = $1`, [a.id, ex.exam_version_id]))).rejects.toThrow(
      /Only published/,
    );
  });

  it('records the signed-in faculty member as evaluator regardless of the payload', async () => {
    const course = (await sql(`select id from courses where slug='pocus'`))[0].id;
    const [ev] = await as(faculty, (q) =>
      q(`insert into public.evaluations (course_id, learner_id, evaluator_id) values ($1, $2, $3) returning evaluator_id`, [course, learner.id, otherFaculty.id]),
    );
    expect(ev.evaluator_id).toBe(faculty.id);
  });
});
