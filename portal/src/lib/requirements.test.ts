import { describe, expect, it } from 'vitest';
import { FORBIDDEN, draftItar, outstanding, type ItarInput } from './itar';
import { completion, outstandingRequirements, requirementActions, requirementsSection, residentNextSteps, scanDeltas, withSelectedAttempt, type Rotation, type RotationReq, type ScanCategory } from './requirements';

const req = (key: string, kind: RotationReq['kind'], status: RotationReq['status'], extra: Partial<RotationReq> = {}): RotationReq => ({
  id: key, key, kind, title: key, description: '', required: true, resident_submits: kind === 'attestation', stages: [], evidence_requirement_id: null,
  status, action: null, detail: '', stage: null, resident_note: '', faculty_message: '', verified_by_name: null, verified_at: null, updated_at: null,
  override: false, extra: {}, ...extra,
});
const cat = (key: string, target: number, verified: number, extra: Partial<ScanCategory> = {}): ScanCategory => ({
  id: key, key, label: key[0].toUpperCase() + key.slice(1), target, views_note: '', verified, reported: null, views_confirmed: null,
  met: verified >= target && !extra.views_note, ...extra,
});

const rot: Rotation = {
  requirements: [
    req('C6 POCUS EPAs', 'epa', 'verified', { verified_by_name: 'Dr. Faculty', verified_at: '2026-10-20T12:00:00Z', detail: 'EPA review complete' }),
    req('Brightspace learning cases', 'learning_cases', 'verified', { detail: '4/4 verified', verified_by_name: 'Dr. Faculty', verified_at: '2026-10-19T12:00:00Z' }),
    req('TeachingMedicine online skills modules', 'attestation', 'submitted', { action: 'faculty' }),
    req('Logbook of reviewed POCUS scans', 'scan_log', 'submitted', { action: 'faculty', detail: '45/102 faculty-verified scans' }),
    req('QPath mentor review and ultrasound portfolio', 'attestation', 'not_started', { action: 'resident' }),
    req('Written POCUS examination', 'exam', 'verified', { detail: 'Score 80% — rotation pass mark 75% met', verified_by_name: 'the portal (automatic scoring)', verified_at: '2026-10-18T12:00:00Z' }),
    req('POCUS rounds presentation', 'attestation', 'not_yet_due', { override: false }),
  ],
  scans: {
    categories: [cat('airway', 5, 5), cat('cardiac', 40, 40, { views_note: 'PLAX, PSAX, S4C, A4C, IVC', views_confirmed: false, met: false }), cat('gastric', 20, 0, { reported: 6 })],
    verified_total: 45, reviewed_total: 45, target_total: 65, reported_total: 6, history: [],
  },
};

describe('completion', () => {
  it('counts verified items; not-applicable drops out; not-yet-due is neither done nor outstanding', () => {
    expect(completion(rot.requirements)).toEqual({ done: 3, total: 7, notYetDue: 1, outstanding: 3 });
    expect(completion([...rot.requirements.slice(0, 6), req('x', 'attestation', 'not_applicable')])).toMatchObject({ total: 6 });
  });
});

describe('outstanding list', () => {
  it('names what is missing, including categories below target and unconfirmed views', () => {
    const o = outstandingRequirements(rot);
    expect(o).toContain('POCUS rounds presentation: not yet due');
    expect(o.find((x) => x.startsWith('Logbook'))).toBe('Logbook of reviewed POCUS scans: 45/65 faculty-verified — outstanding: Cardiac (views not yet confirmed), Gastric 0/20');
    expect(o.some((x) => x.startsWith('C6'))).toBe(false);
  });
});

describe('ITAR section', () => {
  const s = requirementsSection(rot);
  it('lists every requirement with who verified it and when', () => {
    expect(s.text).toMatch(/Mandatory rotation activities complete: 3 of 7 \(1 not yet due\)\./);
    expect(s.text).toMatch(/• C6 POCUS EPAs: Complete — EPA review complete \(by Dr\. Faculty, October 20, 2026\)\./);
    expect(s.text).toMatch(/• Written POCUS examination: Complete — Score 80% — rotation pass mark 75% met \(by the portal \(automatic scoring\)/);
    expect(s.text).toMatch(/45 of 65 required faculty-verified reviewed scans \(Airway 5\/5; Cardiac 40\/40, views not confirmed; Gastric 0\/20\)/);
    const withHistory = requirementsSection({ ...rot, scans: { ...rot.scans, history: [{ batch_id: 'b', created_at: '2026-10-21T12:00:00Z', reviewed_on: '2026-10-21', is_correction: false, source: 'faculty_attestation', by: 'Dr. Faculty', note: '', entries: [] }] } });
    expect(withHistory.text).toMatch(/Gastric 0\/20\) \(last attested by Dr\. Faculty, October 21, 2026\)\./);
  });
  it('keeps scan numbers separate from competence and never rates', () => {
    expect(s.text).toMatch(/completion measure, not an assessment of scanning competence/);
    for (const f of FORBIDDEN) expect(s.text).not.toMatch(f);
  });
  it('appears in the draft right after the rotation line, and drives the outstanding list', () => {
    const input: ItarInput = {
      learnerName: 'Fictional Resident', rotation: 'POCUS', blockName: 'Block 1', examAssigned: true, attempts: [], requirements: [], epa: null,
      observations: [], strengths: '', areasForImprovement: '', otherComments: '', today: '2026-10-20', rotationReqs: rot,
    };
    const d = draftItar(input);
    expect(d.map((x) => x.key).slice(0, 2)).toEqual(['rotation', 'requirements']);
    expect(outstanding(input)).toEqual(outstandingRequirements(rot));
    expect(d.find((x) => x.key === 'learning_needs')!.text).toMatch(/QPath mentor review and ultrasound portfolio: not started/);
  });
});

describe('block overview actions', () => {
  it('adds only scan-log and attestation actions (exam, cases and EPA have their own columns)', () => {
    expect(requirementActions(rot.requirements)).toEqual({
      faculty: ['Confirm TeachingMedicine online skills modules', 'Attest scans'],
      resident: ['QPath mentor review and ultrasound portfolio'],
    });
  });
});

describe('exam below the rotation pass mark', () => {
  it('is a faculty decision (re-attempt), not a resident to-do', () => {
    const r = req('Written POCUS examination', 'exam', 'in_progress', { action: 'resident', extra: { pass_pct: 75, met: false } });
    expect(requirementActions([r])).toEqual({ faculty: ['Exam below 75% — decide on re-attempt'], resident: [] });
  });
});

describe('scan form', () => {
  it('turns new verified totals into deltas; a lower total is a correction', () => {
    const cats = [cat('airway', 5, 2), cat('cardiac', 40, 10, { views_note: 'PLAX…', views_confirmed: null, met: false })];
    expect(scanDeltas(cats, { airway: '5', cardiac: '10' }, {})).toEqual({ entries: [{ category: 'airway', delta: 3 }], negative: false });
    expect(scanDeltas(cats, {}, { cardiac: true })).toEqual({ entries: [{ category: 'cardiac', delta: 0, views_confirmed: true }], negative: false });
    expect(scanDeltas(cats, { airway: '1' }, {})).toEqual({ entries: [{ category: 'airway', delta: -1 }], negative: true });
    expect(scanDeltas(cats, { airway: '' }, {}).entries).toEqual([]);
  });
});

describe('exam consistency between the requirements section and the exam section', () => {
  const base: Rotation = { ...rot, requirements: rot.requirements.map((r) => (r.kind === 'exam' ? { ...r, extra: { pass_pct: 75 } } : r)) };
  const att = (n: number, score: number) => ({ id: `a${n}`, exam_title: 'Exam', version: 1, attempt_no: n, status: 'submitted' as const, started_at: '2026-10-01',
    submitted_at: `2026-10-0${n}T10:00:00Z`, score_points: score, max_points: 100, score_pct: score, passed: score >= 60, pass_threshold_pct: 60,
    grading_status: 'complete', released: true, breakdown: { domains: [] } });

  it('uses the attempt the ITAR uses, including a faculty selection, and the 75% rotation pass mark', () => {
    const r1 = withSelectedAttempt(base, att(1, 80), 'faculty_selected').requirements.find((r) => r.kind === 'exam')!;
    expect(r1).toMatchObject({ status: 'verified', detail: 'Score 80.0% (attempt 1, selected by faculty) — rotation pass mark 75% met' });
    const r2 = withSelectedAttempt(base, att(2, 70), 'latest_submitted').requirements.find((r) => r.kind === 'exam')!;
    expect(r2).toMatchObject({ status: 'in_progress', action: 'resident', detail: 'Score 70.0% (attempt 2) — below the rotation pass mark of 75%' });
  });

  it('the draft states the rotation pass mark (75%), not the exam version threshold (60%)', () => {
    const input: ItarInput = {
      learnerName: 'Fictional Resident', rotation: 'POCUS', blockName: 'Block 1', examAssigned: true, attempts: [att(1, 70)], requirements: [], epa: null,
      observations: [], strengths: '', areasForImprovement: '', otherComments: '', today: '2026-10-20', rotationReqs: base,
    };
    const exam = draftItar(input).find((s) => s.key === 'exam')!.text;
    expect(exam).toMatch(/below the rotation pass mark of 75%/);
    expect(exam).not.toMatch(/60%/);
  });
});

describe('resident next steps', () => {
  it('turns requirement states into resident actions and a separate "waiting on faculty" list', () => {
    const r: Rotation = {
      ...rot,
      requirements: [
        req('C6 POCUS EPAs', 'epa', 'in_progress', { key: 'c6_epas', action: 'resident', extra: { criteria_status: 'partially_met' } }),
        req('Brightspace learning cases', 'learning_cases', 'clarification_requested', { key: 'bs', extra: { returned: 1, missing: 2, awaiting: 1, verified: 0 } }),
        req('TeachingMedicine online skills modules', 'attestation', 'clarification_requested', { key: 'tm', faculty_message: 'Module 4 missing' }),
        req('QPath mentor review and ultrasound portfolio', 'attestation', 'submitted', { key: 'qp' }),
        req('Logbook of reviewed POCUS scans', 'scan_log', 'submitted', { key: 'scan_logbook' }),
        req('Written POCUS examination', 'exam', 'in_progress', { key: 'exam', detail: 'Score 60.0% (attempt 1) — below the rotation pass mark of 75%', extra: { met: false, pass_pct: 75 } }),
        req('POCUS rounds presentation', 'attestation', 'not_started', { key: 'rounds', stages: [{ key: 'planned', label: 'Planned', by: 'resident' }] }),
      ],
    };
    const { todo, waiting } = residentNextSteps(r);
    expect(todo.map((t) => t.label)).toEqual([
      'C6 EPAs: criteria partially met — continue requesting EPA assessments in Elentra',
      'Re-upload 1 learning case returned by faculty',
      'Upload Brightspace completion for 2 learning cases',
      'TeachingMedicine online skills modules: faculty asked for clarification',
      'Report your scan counts — 45/65 verified so far',
      'Plan your POCUS rounds presentation (topic and date)',
    ]);
    expect(todo.find((t) => t.key === 'tm')).toMatchObject({ detail: 'Module 4 missing', to: '/requirements#req-tm', tone: 'warn' });
    expect(todo.find((t) => t.key === 'scan_logbook')!.to).toBe('/requirements?report=scans#scans');
    expect(waiting.map((t) => t.label)).toEqual([
      '1 learning-case upload awaiting faculty review',
      'QPath mentor review and ultrasound portfolio — awaiting faculty confirmation',
      'Reported scans awaiting faculty verification',
      'Score 60.0% (attempt 1) — below the rotation pass mark of 75%. Faculty will contact you about a re-attempt.',
    ]);
  });
  it('shows nothing to do once everything is complete or not yet due', () => {
    const done: Rotation = { ...rot, requirements: rot.requirements.map((x) => ({ ...x, status: x.status === 'not_yet_due' ? 'not_yet_due' : 'verified' })) };
    expect(residentNextSteps(done)).toEqual({ todo: [], waiting: [] });
  });
});
