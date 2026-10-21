/**
 * ITER-ready export (migration 12): configurable template, faculty ITER fields
 * copied into immutable approved versions, optional C6 EPA counts that never
 * decide the requirement, CanMEDS observation categories.
 * All people and records are fictional.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createUser, makeCohort, pool, rpc, sql, type User } from './helpers';

let admin: User, faculty: User, otherFaculty: User, resident: User, resident2: User;
let block: string, course: string;

const status = (s: any, key: string) => s.requirements.find((r: any) => r.key === key);

beforeAll(async () => {
  block = await makeCohort();
  course = (await sql(`select course_id from public.cohorts where id = $1`, [block]))[0].course_id;
  admin = await createUser('admin');
  faculty = await createUser('faculty', { cohortId: block });
  otherFaculty = await createUser('faculty', { cohortId: await makeCohort() });
  resident = await createUser('learner', { cohortId: block, name: 'Fictional Resident ITER' });
  resident2 = await createUser('learner', { cohortId: block });
});
afterAll(() => pool.end());

describe('ITER template', () => {
  it('a draft default template follows the ITER headings; staff read it, residents cannot', async () => {
    const t = await rpc(faculty, 'iter_template_for', { p_cohort: block });
    expect(t.status).toBe('draft');
    expect(t.definition.roles.map((r: any) => r.heading)).toEqual(
      ['Medical Expert', 'Communicator', 'Manager', 'Scholar', 'Collaborator', 'Health Advocate', 'Professional']);
    expect(t.definition.outcome.options).toEqual(
      ['No, due to other reasons', 'No, due to absence', 'No, due to unsatisfactory performance', 'Yes, Partially', 'Yes, Fully']);
    expect(['overall', 'strengths', 'areas', 'recommendations'].map((k) => t.definition.narrative[k].heading)).toEqual(
      ['Overall explanation of performance', 'Summary of strengths', 'Summary of areas needing improvement', 'Recommendations for ongoing improvement']);
    expect(await rpc(resident, 'iter_template_for', { p_cohort: block })).toBeNull();
    expect(await as(resident, (q) => q(`select * from public.iter_templates`))).toHaveLength(0);
  });

  it('only admins edit it; a rotation can have its own; editing a confirmed template returns it to draft', async () => {
    const def = (await sql(`select definition from public.iter_templates where course_id is null`))[0].definition;
    await sql(`delete from public.iter_templates where course_id = $1`, [course]); // re-runnable on the same database
    await expect(as(faculty, (q) => q(`insert into public.iter_templates (course_id, name, definition) values ($1, 'x', $2)`, [course, def]))).rejects.toThrow();
    const [row] = await as(admin, (q) => q(`insert into public.iter_templates (course_id, name, definition, status) values ($1, 'POCUS block ITER', $2, 'confirmed') returning id, status, confirmed_by`, [course, def]));
    expect(row).toMatchObject({ status: 'confirmed', confirmed_by: admin.id });
    expect((await rpc(faculty, 'iter_template_for', { p_cohort: block })).name).toBe('POCUS block ITER');
    const def2 = { ...def, roles: def.roles.map((r: any) => (r.key === 'manager' ? { ...r, heading: 'Leader' } : r)) };
    const [after] = await as(admin, (q) => q(`update public.iter_templates set definition = $2 where id = $1 returning status, confirmed_by`, [row.id, def2]));
    expect(after).toEqual({ status: 'draft', confirmed_by: null });
    await expect(as(admin, (q) => q(`update public.iter_templates set definition = '{"roles": []}' where id = $1`, [row.id]))).rejects.toThrow(/roles/);
    await sql(`delete from public.iter_templates where id = $1`, [row.id]);
  });
});

describe('faculty ITER fields', () => {
  it('outcome and narrative are faculty entries; approved versions keep them unchanged after a revision', async () => {
    const fields = { outcome: 'Yes, Fully', basis: ['Written examination', 'Formal direct observation'], discussed: 'yes',
      overall: 'Fictional: steady progress across the block.', recommendations: 'Fictional: continue gastric ultrasound practice.' };
    const [ev] = await as(faculty, (q) => q(`insert into public.evaluations (course_id, learner_id, cohort_id, summary, itar_sections, iter_fields)
      values ($1, $2, $3, 'Fictional ITER summary', '[{"key":"iter_outcome","title":"Overall rotation objectives","text":"Yes, Fully"}]', $4) returning id`,
      [course, resident.id, block, fields]));
    await expect(as(faculty, (q) => q(`update public.evaluations set iter_fields = $2 where id = $1`, [ev.id, { overall: 'MRN 4481234 seen' }]))).rejects.toThrow(/patient identifiers/);
    await as(faculty, (q) => q(`update public.evaluations set status = 'approved' where id = $1`, [ev.id]));
    await as(faculty, (q) => q(`update public.evaluations set status = 'draft' where id = $1`, [ev.id]));
    await as(faculty, (q) => q(`update public.evaluations set iter_fields = $2, summary = 'revised' where id = $1`, [ev.id, { ...fields, outcome: 'Yes, Partially' }]));
    await as(faculty, (q) => q(`update public.evaluations set status = 'approved' where id = $1`, [ev.id]));
    const vs = await as(faculty, (q) => q(`select version, iter_fields ->> 'outcome' as outcome from public.evaluation_versions where evaluation_id = $1 order by version`, [ev.id]));
    expect(vs).toEqual([{ version: 1, outcome: 'Yes, Fully' }, { version: 2, outcome: 'Yes, Partially' }]);
    await expect(as(faculty, (q) => q(`update public.evaluation_versions set iter_fields = '{}' where evaluation_id = $1`, [ev.id]))).rejects.toThrow();
    await expect(as(faculty, (q) => q(`update public.evaluations set iter_fields = '{}' where id = $1`, [ev.id]))).rejects.toThrow(/Re-open/);
  });

  it('the export is logged with the ITER formats', async () => {
    const [ev] = await sql(`select id from public.evaluations where learner_id = $1`, [resident.id]);
    await rpc(faculty, 'log_itar_export', { p_evaluation: ev.id, p_format: 'iter_copy_section' });
    const [l] = await sql(`select details from public.audit_log where action = 'itar_exported' and entity_id = $1 order by id desc limit 1`, [ev.id]);
    expect(l.details.format).toBe('iter_copy_section');
    await expect(rpc(otherFaculty, 'log_itar_export', { p_evaluation: ev.id, p_format: 'iter_text' })).rejects.toThrow();
  });
});

describe('optional C6 EPA details', () => {
  const verify = (args: Record<string, unknown>) =>
    rpc(faculty, 'verify_epa', { p_learner: resident2.id, p_cohort: block, p_reviewed: true, ...args });

  it('counts and findings are optional and never decide the requirement', async () => {
    await verify({ p_criteria_status: 'partially_met', p_details: { assessments_reviewed: 12, entrustment_counts: { '5': 10, '4': 2 }, key_findings: 'Fictional: consistent gastric views' } });
    const s = await rpc(faculty, 'rotation_status', { p_learner: resident2.id, p_cohort: block });
    expect(status(s, 'c6_epas')).toMatchObject({ status: 'in_progress', action: 'resident' });
    const [row] = await sql(`select assessments_reviewed, entrustment_counts, key_findings from public.epa_reviews where learner_id = $1`, [resident2.id]);
    expect(row).toEqual({ assessments_reviewed: 12, entrustment_counts: { '4': 2, '5': 10 }, key_findings: 'Fictional: consistent gastric views' });
    // no details in a later call keeps them; streamlined verification still works without any count
    await verify({ p_criteria_status: 'outstanding' });
    expect((await sql(`select assessments_reviewed from public.epa_reviews where learner_id = $1`, [resident2.id]))[0].assessments_reviewed).toBe(12);
    await verify({ p_criteria_status: 'outstanding', p_details: {} });
    expect((await sql(`select assessments_reviewed, entrustment_counts from public.epa_reviews where learner_id = $1`, [resident2.id]))[0])
      .toEqual({ assessments_reviewed: null, entrustment_counts: {} });
  });

  it('counts are validated and findings are screened for identifiers', async () => {
    await expect(verify({ p_criteria_status: 'outstanding', p_details: { assessments_reviewed: 3, entrustment_counts: { '5': 4 } } })).rejects.toThrow(/more than the number/);
    await expect(verify({ p_criteria_status: 'outstanding', p_details: { entrustment_counts: { '5': 1 } } })).rejects.toThrow(/how many/);
    await expect(verify({ p_criteria_status: 'outstanding', p_details: { assessments_reviewed: 3, entrustment_counts: { '6': 1 } } })).rejects.toThrow(/levels 1 to 5/);
    await expect(verify({ p_criteria_status: 'outstanding', p_details: { assessments_reviewed: 3, entrustment_counts: { '5': 1.5 } } })).rejects.toThrow(/whole numbers/);
    await expect(verify({ p_criteria_status: 'outstanding', p_details: { key_findings: 'Scan on 2026-10-14 MRN 1234567' } })).rejects.toThrow(/patient identifiers/);
  });

  it('residents never see the counts or findings', async () => {
    const mine = (await rpc(resident2, 'my_requirements'))[0].rotation;
    expect(JSON.stringify(mine)).not.toMatch(/assessments_reviewed|entrustment|key_findings/);
    expect(await as(resident2, (q) => q(`select * from public.epa_reviews`))).toHaveLength(0);
  });
});

describe('CanMEDS observation categories', () => {
  it('faculty can record observations for every role', async () => {
    for (const category of ['manager', 'scholar', 'collaborator', 'health_advocate']) {
      await as(faculty, (q) => q(`insert into public.faculty_notes (course_id, learner_id, author_id, cohort_id, category, body)
        values ($1, $2, $3, $4, $5, 'Fictional observation')`, [course, resident.id, faculty.id, block, category]));
    }
    await expect(as(faculty, (q) => q(`insert into public.faculty_notes (course_id, learner_id, author_id, cohort_id, category, body)
      values ($1, $2, $3, $4, 'rating', 'x')`, [course, resident.id, faculty.id, block]))).rejects.toThrow();
  });
});
