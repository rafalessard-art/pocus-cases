import { describe, expect, it } from 'vitest';
import { attention, chooseAttempt, composeSummary, draftItar, FORBIDDEN, fingerprint, outstanding, requirementState, type ItarInput, type OverviewRow, type WsAttempt } from './itar';

const att = (o: Partial<WsAttempt>): WsAttempt => ({
  id: 'a1', exam_title: 'POCUS Block Exam', version: 1, attempt_no: 1, status: 'submitted', started_at: '2026-09-20T13:00:00Z',
  submitted_at: '2026-09-20T13:30:00Z', score_points: 8, max_points: 10, score_pct: 80, passed: true, pass_threshold_pct: 70,
  grading_status: 'complete', released: true,
  breakdown: { domains: [{ key: 'cardiac', label: 'Cardiac', pct: 90, n_items: 5 }, { key: 'lung', label: 'Lung', pct: 40, n_items: 5 }] },
  ...o,
});

const base = (o: Partial<ItarInput> = {}): ItarInput => ({
  learnerName: 'Alex Fictional', trainingLevel: 'PGY-3', rotation: 'POCUS Rotation', blockName: 'Block 4', blockStart: '2026-09-01', blockEnd: '2026-09-28',
  examAssigned: true, attempts: [att({})],
  requirements: [
    { id: 'r1', title: 'Gastric case', required: true, submissions: [{ id: 's1', status: 'verified', original_filename: 'a.pdf', mime_type: 'application/pdf', storage_path: 'p', created_at: '2026-09-10T00:00:00Z', reviewer_name: 'Dr Faculty' }] },
    { id: 'r2', title: 'ONSD case', required: true, submissions: [{ id: 's2', status: 'clarification_requested', original_filename: 'b.png', mime_type: 'image/png', storage_path: 'q', created_at: '2026-09-11T00:00:00Z' }] },
    { id: 'r3', title: 'Vascular case', required: true, submissions: [] },
  ],
  epa: { status: 'complete', entries: [{ epa: 'DEMO-1', title: 'Fictional EPA', n_assessments: 2, entrustment: 'Level 4' }], strengths: 'Organised', areas_for_improvement: '', review_date: '2026-09-27', completed_by_name: 'Dr Faculty', completed_at: '2026-09-27T15:00:00Z',
    reviewed_in_elentra: true, criteria_status: 'met', criteria_confirmed: true, criteria_snapshot: 'DRAFT — pending rotation director approval: …', concerns: '' },
  observations: [{ id: 'o1', category: 'scanning', observed_on: '2026-09-12', body: 'Obtained a clear A4C view without assistance', author: 'Dr Faculty', created_at: '2026-09-12T10:00:00Z' }],
  strengths: '', areasForImprovement: '', otherComments: '', today: '2026-09-28',
  ...o,
});

describe('attempt selection', () => {
  it('uses the most recent submitted attempt by default and records a faculty override', () => {
    const a = [att({ id: 'old', attempt_no: 1, submitted_at: '2026-09-10T00:00:00Z', score_pct: 50 }), att({ id: 'new', attempt_no: 2, submitted_at: '2026-09-20T00:00:00Z' }), att({ id: 'open', status: 'in_progress', submitted_at: null })];
    expect(chooseAttempt(a)).toMatchObject({ attempt: { id: 'new' }, rule: 'latest_submitted' });
    expect(chooseAttempt(a, 'old')).toMatchObject({ attempt: { id: 'old' }, rule: 'faculty_selected' });
    expect(chooseAttempt(a, 'open')).toMatchObject({ attempt: { id: 'new' }, rule: 'latest_submitted' });
    expect(chooseAttempt([])).toEqual({ attempt: null, rule: 'none' });
    const text = draftItar(base({ attempts: a })).find((s) => s.key === 'exam')!.text;
    expect(text).toMatch(/attempt 2 \(2 submitted attempts\); the most recent submitted attempt is used/);
  });
});

describe('ITAR draft', () => {
  const s = draftItar(base());
  const all = composeSummary(s);

  it('has the expected sections with evidence sources last', () => {
    expect(s.map((x) => x.key)).toEqual(['rotation', 'exam', 'cases', 'epa', 'observations', 'strengths', 'learning_needs', 'sources']);
  });

  it('reports exam facts and never infers skill from them', () => {
    const t = s.find((x) => x.key === 'exam')!.text;
    expect(t).toMatch(/80\.0% \(8\/10 points\), meeting the pass threshold of 70%/);
    expect(t).toMatch(/strongest in Cardiac \(90%\)/);
    expect(t).toMatch(/do not assess image acquisition, bedside scanning, clinical judgement or procedural skill/);
    for (const f of FORBIDDEN) expect(all).not.toMatch(f);
  });

  it('counts only verified evidence and names what is outstanding', () => {
    const t = s.find((x) => x.key === 'cases')!.text;
    expect(t).toMatch(/1 of 3 required learning cases was verified by faculty/);
    expect(t).toMatch(/ONSD case \(clarification requested\)/);
    expect(t).toMatch(/Vascular case \(no evidence submitted\)/);
  });

  it('uses only a completed EPA review and faculty-written observations', () => {
    const epa = s.find((x) => x.key === 'epa')!.text;
    expect(epa).toMatch(/^Dr Faculty reviewed the resident's EPA assessments in Elentra on September 27, 2026\. C6 POCUS EPA completion criteria: met \(criteria confirmed by the reviewing faculty member\); the criteria are a draft pending rotation director approval\./);
    expect(epa).toMatch(/\n• DEMO-1 — Fictional EPA: 2 assessments; entrustment: Level 4/); // optional details still included when recorded
    expect(epa).toMatch(/not a separate assessment of clinical competence/);
    expect(draftItar(base({ epa: { ...base().epa!, status: 'pending' } })).find((x) => x.key === 'epa')!.text).toBe('EPA review pending.');
    const o = s.find((x) => x.key === 'observations')!.text;
    expect(o).toMatch(/Practical scanning skills:\n• Obtained a clear A4C view without assistance\. \(Dr Faculty, September 12, 2026\)/);
    expect(o).toMatch(/No observations recorded for: Clinical judgement, Technical performance, Professionalism\./);
  });

  it('leaves faculty judgement as placeholders and lists outstanding requirements', () => {
    expect(s.find((x) => x.key === 'strengths')!.text).toMatch(/^\[Faculty to complete/);
    const n = s.find((x) => x.key === 'learning_needs')!.text;
    expect(n).toMatch(/Outstanding requirements:\n• Learning case “ONSD case”: clarification requested/);
    expect(n).toMatch(/Knowledge domains to review \(written examination\): Lung \(40%\)/);
    const filled = draftItar(base({ strengths: 'Calm under pressure', areasForImprovement: 'Practise subcostal views' }));
    expect(filled.find((x) => x.key === 'strengths')!.text).toBe('Calm under pressure.');
  });

  it('states sources and that no overall rating is assigned', () => {
    const t = s.find((x) => x.key === 'sources')!.text;
    expect(t).toMatch(/1 verified by Dr Faculty, 0 awaiting review, 1 returned to the resident, 1 not submitted/);
    expect(t).toMatch(/assigns no overall rating/);
    expect(t).toMatch(/not retrieved from Elentra automatically/);
  });

  it('handles a resident with nothing on record', () => {
    const empty = draftItar(base({ attempts: [], requirements: [], epa: null, observations: [], examAssigned: false }));
    expect(empty.find((x) => x.key === 'exam')!.text).toMatch(/No end-of-block written examination was assigned/);
    expect(empty.find((x) => x.key === 'observations')!.text).toBe('No direct faculty observations were recorded for this block.');
    expect(outstanding(base({ attempts: [], requirements: [], epa: null, examAssigned: true }))).toEqual(['Written examination not completed', 'EPA review (Elentra) pending']);
  });

  it('fingerprint changes when evidence status changes', () => {
    const a = fingerprint(base());
    const b = base();
    b.requirements[1].submissions[0].status = 'verified';
    expect(fingerprint(b)).not.toBe(a);
    expect(requirementState(b.requirements[1])).toBe('verified');
  });
});

describe('streamlined EPA verification in the draft', () => {
  it('concerns appear in the EPA section and are carried into areas for improvement', () => {
    const d = draftItar(base({ epa: { ...base().epa!, entries: [], criteria_status: 'partially_met', criteria_confirmed: false, concerns: 'Fictional: limited cardiac EPA observations' } }));
    expect(d.find((x) => x.key === 'epa')!.text).toMatch(/criteria: partially met; the criteria are a draft/);
    expect(d.find((x) => x.key === 'epa')!.text).toMatch(/Concerns noted by the reviewing faculty member: Fictional: limited cardiac EPA observations\./);
    expect(d.find((x) => x.key === 'learning_needs')!.text).toMatch(/Concerns from the EPA review \(faculty to address in the ITAR\): Fictional: limited cardiac EPA observations\./);
    expect(outstanding(base({ epa: { ...base().epa!, criteria_status: 'partially_met' } }))).toContain('C6 POCUS EPA criteria partially met');
  });
  it('a review completed under the old form is not treated as verified', () => {
    const d = draftItar(base({ epa: { ...base().epa!, criteria_status: null } }));
    expect(d.find((x) => x.key === 'epa')!.text).toBe('EPA review recorded before criteria verification; re-verification pending.');
  });
});

describe('block overview attention', () => {
  const row = (o: Partial<OverviewRow> = {}): OverviewRow => ({
    id: 'x', name: 'A', training_level: null,
    exam: { assigned: true, n_attempts: 0, in_progress: false, latest: null },
    evidence: { required: 4, submitted: 2, verified: 1, awaiting_review: 1, clarification: 0, rejected: 0 },
    epa_status: 'not_started', n_observations: 0, itar: null, ...o,
  });
  it('splits faculty and resident actions', () => {
    expect(attention(row())).toEqual({ faculty: ['Review evidence (1)', 'EPA review', 'Prepare ITAR'], resident: ['Exam outstanding', 'Evidence missing (2)'], done: false });
    expect(attention(row({ itar: { id: 'e', status: 'approved', updated_at: '', approved_at: '', has_text: true } })).done).toBe(true);
  });
});
