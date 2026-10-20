import { describe, expect, it } from 'vitest';
import { FORBIDDEN, draftItar, outstanding, type ItarInput } from './itar';
import { completion, outstandingRequirements, requirementActions, requirementsSection, scanDeltas, type Rotation, type RotationReq, type ScanCategory } from './requirements';

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
    verified_total: 45, target_total: 65, reported_total: 6, history: [],
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
    expect(s.text).toMatch(/45 of 65 faculty-verified reviewed scans \(Airway 5\/5; Cardiac 40\/40, views not confirmed; Gastric 0\/20\)/);
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

describe('scan form', () => {
  it('turns new verified totals into deltas; a lower total is a correction', () => {
    const cats = [cat('airway', 5, 2), cat('cardiac', 40, 10, { views_note: 'PLAX…', views_confirmed: null, met: false })];
    expect(scanDeltas(cats, { airway: '5', cardiac: '10' }, {})).toEqual({ entries: [{ category: 'airway', delta: 3 }], negative: false });
    expect(scanDeltas(cats, {}, { cardiac: true })).toEqual({ entries: [{ category: 'cardiac', delta: 0, views_confirmed: true }], negative: false });
    expect(scanDeltas(cats, { airway: '1' }, {})).toEqual({ entries: [{ category: 'airway', delta: -1 }], negative: true });
    expect(scanDeltas(cats, { airway: '' }, {}).entries).toEqual([]);
  });
});
