import { describe, expect, it } from 'vitest';
import { classify, plan, READ_RPCS, type ViewState } from './viewMode';

const base: ViewState = { perspective: null, actingLearner: null, previewAsReviewer: false, readOnly: false };
const ro: ViewState = { ...base, readOnly: true };
const U = 'http://127.0.0.1:54321';

describe('request classification', () => {
  it('recognises RPCs, table writes and storage writes', () => {
    expect(classify(`${U}/rest/v1/rpc/my_exams`, 'POST')).toEqual({ kind: 'rpc', fn: 'my_exams' });
    expect(classify(`${U}/rest/v1/profiles?select=*`, 'GET')).toEqual({ kind: 'other' });
    expect(classify(`${U}/rest/v1/profiles?id=eq.x`, 'PATCH')).toEqual({ kind: 'table' });
    expect(classify(`${U}/rest/v1/curriculum_progress`, 'POST')).toEqual({ kind: 'table' });
    expect(classify(`${U}/rest/v1/assignments?id=eq.1`, 'DELETE')).toEqual({ kind: 'table' });
    expect(classify(`${U}/storage/v1/object/sign/exam-media/a.mp4`, 'POST')).toEqual({ kind: 'other' });
    expect(classify(`${U}/storage/v1/object/itar-evidence/a.pdf`, 'POST')).toEqual({ kind: 'storage-write' });
    expect(classify(`${U}/storage/v1/object/itar-evidence`, 'DELETE')).toEqual({ kind: 'storage-write' });
    expect(classify(`${U}/auth/v1/logout`, 'POST')).toEqual({ kind: 'other' });
  });
});

describe('read-only plan', () => {
  it('lets reads, signed URLs, sign-out and feedback through', () => {
    for (const fn of READ_RPCS) expect(plan(`${U}/rest/v1/rpc/${fn}`, 'POST', '{}', ro).block, fn).toBe(false);
    expect(plan(`${U}/rest/v1/rpc/submit_feedback`, 'POST', '{}', ro).block).toBe(false);
    expect(plan(`${U}/rest/v1/exams?select=*`, 'GET', undefined, ro).block).toBe(false);
    expect(plan(`${U}/storage/v1/object/sign/exam-media/x.webm`, 'POST', '{}', ro).block).toBe(false);
    expect(plan(`${U}/auth/v1/logout`, 'POST', undefined, ro).block).toBe(false);
  });

  it('refuses every other function and every table or storage write', () => {
    for (const fn of ['start_attempt', 'save_responses', 'report_scans', 'set_requirement_status', 'verify_epa', 'release_results', 'publish_exam_version',
      'begin_evidence_upload', 'rotate_demo_code', 'set_admin_mfa_required', 'log_itar_export', 'some_future_function']) {
      expect(plan(`${U}/rest/v1/rpc/${fn}`, 'POST', '{}', ro).block, fn).toBe(true);
    }
    expect(plan(`${U}/rest/v1/evaluations`, 'POST', '{}', ro).block).toBe(true);
    expect(plan(`${U}/rest/v1/evaluations?id=eq.1`, 'PATCH', '{}', ro).block).toBe(true);
    expect(plan(`${U}/rest/v1/faculty_notes?id=eq.1`, 'DELETE', undefined, ro).block).toBe(true);
    expect(plan(`${U}/storage/v1/object/exam-media/x.mp4`, 'POST', 'bytes', ro).block).toBe(true);
  });

  it('a fictional resident or an owner preview is read-only even before the session flag is set', () => {
    expect(plan(`${U}/rest/v1/rpc/start_attempt`, 'POST', '{}', { ...base, actingLearner: { id: 'r', name: 'R' } }).block).toBe(true);
    expect(plan(`${U}/rest/v1/rpc/start_attempt`, 'POST', '{}', { ...base, previewAsReviewer: true }).block).toBe(true);
    expect(plan(`${U}/rest/v1/rpc/start_attempt`, 'POST', '{}', base).block).toBe(false);
  });
});

describe('Resident perspective and owner preview', () => {
  const acting: ViewState = { ...ro, perspective: 'resident', actingLearner: { id: 'fe000000-0000-4000-a000-000000000023', name: 'Casey' } };

  it('adds p_as_learner to the learner read functions only', () => {
    const p = plan(`${U}/rest/v1/rpc/my_exams`, 'POST', '{}', acting);
    expect(p.block).toBe(false);
    expect(JSON.parse((p as any).body)).toEqual({ p_as_learner: acting.actingLearner!.id });
    const r = plan(`${U}/rest/v1/rpc/my_curriculum`, 'POST', JSON.stringify({ p_course_slug: 'pocus' }), acting);
    expect(JSON.parse((r as any).body)).toEqual({ p_course_slug: 'pocus', p_as_learner: acting.actingLearner!.id });
    const s = plan(`${U}/rest/v1/rpc/itar_blocks`, 'POST', '{}', acting);
    expect((s as any).body).toBe('{}');
  });

  it('marks requests for the preview header only during an owner preview', () => {
    expect((plan(`${U}/rest/v1/rpc/my_access`, 'POST', '{}', { ...ro, previewAsReviewer: true }) as any).previewHeader).toBe(true);
    expect((plan(`${U}/rest/v1/rpc/my_access`, 'POST', '{}', ro) as any).previewHeader).toBe(false);
    expect((plan(`${U}/storage/v1/object/sign/exam-media/x`, 'POST', '{}', { ...ro, previewAsReviewer: true }) as any).previewHeader).toBe(false);
    expect((plan(`${U}/auth/v1/user`, 'GET', undefined, { ...ro, previewAsReviewer: true }) as any).previewHeader).toBe(false);
    expect((plan(`${U}/rest/v1/exams?select=*`, 'GET', undefined, { ...ro, previewAsReviewer: true }) as any).previewHeader).toBe(true);
  });
});
