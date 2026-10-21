/**
 * ITER-ready summary. Every person, score and comment below is fictional
 * (docs/exam-platform/fixtures/FICTIONAL_ITER_AND_EPA_EXAMPLE.md); no real
 * assessment record is used as a fixture.
 */
import { describe, expect, it } from 'vitest';
import { FORBIDDEN, type ItarInput, type WsAttempt } from './itar';
import {
  DEFAULT_TEMPLATE, NO_ROLE_NOTES, applyFaculty, areaReminders, composeIter, draftIter, entrustmentText, isIterDraft, parseTemplate, suggestBasis,
  type IterFields,
} from './iter';
import type { Rotation, RotationReq } from './requirements';

const att = (o: Partial<WsAttempt> = {}): WsAttempt => ({
  id: 'a1', exam_title: 'POCUS Block Exam (fictional)', version: 2, attempt_no: 1, status: 'submitted', started_at: '2026-10-14T13:00:00Z',
  submitted_at: '2026-10-14T13:40:00Z', score_points: 34, max_points: 40, score_pct: 85, passed: true, pass_threshold_pct: 75,
  grading_status: 'complete', released: true,
  breakdown: { domains: [{ key: 'gastric', label: 'Gastric', pct: 95, n_items: 10 }, { key: 'lung', label: 'Lung', pct: 50, n_items: 10 }] }, ...o,
});
const req = (key: string, kind: RotationReq['kind'], status: RotationReq['status'], o: Partial<RotationReq> = {}): RotationReq => ({
  id: key, key, kind, title: key, description: '', required: true, resident_submits: kind === 'attestation', stages: [], evidence_requirement_id: null,
  status, action: null, detail: '', stage: null, resident_note: '', faculty_message: '', verified_by_name: null, verified_at: null, updated_at: null,
  override: false, extra: {}, ...o,
});
const rotation: Rotation = {
  requirements: [
    req('C6 POCUS EPAs', 'epa', 'verified'),
    req('Brightspace learning cases', 'learning_cases', 'in_progress'),
    req('TeachingMedicine online skills modules', 'attestation', 'verified', { verified_by_name: 'Dr Fictional Faculty', verified_at: '2026-10-15T12:00:00Z' }),
    req('Logbook of reviewed POCUS scans', 'scan_log', 'verified'),
    req('Written POCUS examination', 'exam', 'verified', { config: undefined } as any),
    req('POCUS rounds presentation', 'attestation', 'not_yet_due'),
  ],
  scans: {
    categories: [
      { id: 'c1', key: 'cardiac', label: 'Cardiac', target: 40, views_note: 'PLAX…', verified: 40, reported: 40, views_confirmed: true, met: true },
      { id: 'c2', key: 'gastric', label: 'Gastric', target: 20, views_note: '', verified: 24, reported: 24, views_confirmed: null, met: true },
    ],
    verified_total: 60, reviewed_total: 64, target_total: 60, reported_total: 64, history: [],
  },
};

const fixture = (o: Partial<ItarInput> = {}): ItarInput => ({
  learnerName: 'Sam Fictional-Resident', trainingLevel: 'PGY-2', rotation: 'POCUS Rotation', blockName: 'Block 9 (fictional)',
  blockStart: '2026-09-28', blockEnd: '2026-10-25', examAssigned: true, attempts: [att()],
  requirements: [
    { id: 'r1', title: 'Gastric ultrasound case', required: true, submissions: [{ id: 's1', status: 'verified', original_filename: 'SYNTHETIC.pdf', mime_type: 'application/pdf', storage_path: 'p', created_at: '2026-10-01T00:00:00Z', reviewer_name: 'Dr Fictional Faculty' }] },
    { id: 'r2', title: 'ONSD case', required: true, submissions: [] },
  ],
  epa: {
    status: 'complete', entries: [], strengths: 'Systematic gastric scanning sequence', areas_for_improvement: '', review_date: '2026-10-20',
    completed_by_name: 'Dr Fictional Faculty', completed_at: '2026-10-20T15:00:00Z', reviewed_in_elentra: true, criteria_status: 'partially_met',
    criteria_confirmed: false, criteria_snapshot: 'DRAFT — pending rotation director approval: …', concerns: 'Only one lung assessment documented',
    assessments_reviewed: 6, entrustment_counts: { '5': 2, '4': 3, '3': 1 }, key_findings: 'Interprets antral cross-sectional area reliably',
  },
  observations: [
    { id: 'o1', category: 'scanning', observed_on: '2026-10-08', body: 'Obtained a right lateral decubitus antral view independently', author: 'Dr Fictional Faculty', context: 'Pre-op clinic', created_at: '2026-10-08T10:00:00Z' },
    { id: 'o2', category: 'communication', observed_on: '2026-10-09', body: 'Explained the gastric scan to the patient clearly', author: 'Dr Fictional Faculty', created_at: '2026-10-09T10:00:00Z' },
    { id: 'o3', category: 'general', observed_on: '2026-10-10', body: 'Arrived prepared for every session', author: 'Dr Other Fictional', created_at: '2026-10-10T10:00:00Z' },
  ],
  strengths: '', areasForImprovement: '', otherComments: '', today: '2026-10-21', rotationReqs: rotation, ...o,
});
const T = DEFAULT_TEMPLATE;
const sec = (s: ReturnType<typeof draftIter>, key: string) => s.find((x) => x.key === key)!;

describe('ITER-ready summary structure', () => {
  const s = draftIter(fixture(), T, {});

  it('follows the ITER headings in form order, with one evidence section first', () => {
    expect(s.map((x) => x.title)).toEqual([
      'Resident and rotation', 'Verified rotation evidence (POCUS portal)',
      'Medical Expert', 'Communicator', 'Manager', 'Scholar', 'Collaborator', 'Health Advocate', 'Professional',
      'Other faculty observations (no CanMEDS role selected)',
      'Overall rotation objectives', 'Overall explanation of performance', 'Summary of strengths', 'Summary of areas needing improvement',
      'Recommendations for ongoing improvement', 'Basis of assessment', 'Performance discussed with the trainee', 'Portal record',
    ]);
    expect(isIterDraft(s)).toBe(true);
    expect(s.every((x) => x.dest && x.kind)).toBe(true);
    expect(sec(s, 'iter_role_medical_expert').dest).toMatch(/^Elentra ITER → Medical Expert: select a rating for each item yourself/);
  });

  it('assigns no CanMEDS rating and no overall outcome', () => {
    const all = composeIter(s);
    for (const f of FORBIDDEN) expect(all).not.toMatch(f);
    for (const r of T.rating_scale.filter((x) => x !== 'Not assessed')) expect(all).not.toContain(r);
    expect(sec(s, 'iter_outcome').text).toBe('Not selected in the portal — select in Elentra.');
    for (const o of T.outcome.options) expect(all).not.toContain(o);
  });

  it('CanMEDS notes come only from faculty observations recorded for that role; others are left for faculty', () => {
    expect(sec(s, 'iter_role_medical_expert').text).toBe('• Obtained a right lateral decubitus antral view independently. (Dr Fictional Faculty, October 8, 2026, Pre-op clinic)');
    expect(sec(s, 'iter_role_communicator').text).toMatch(/^• Explained the gastric scan/);
    for (const k of ['manager', 'scholar', 'collaborator', 'health_advocate', 'professional']) expect(sec(s, `iter_role_${k}`).text).toBe(NO_ROLE_NOTES);
    // the exam score and EPA review are never written under a CanMEDS role
    for (const x of s.filter((y) => y.kind === 'role')) expect(x.text).not.toMatch(/85\.0%|Elentra|entrustment/);
    expect(sec(s, 'iter_role_other').text).toMatch(/Arrived prepared/);
  });

  it('separates factual evidence from judgement and writes EPA information exactly once', () => {
    const ev = sec(s, 'iter_evidence').text;
    expect(ev).toMatch(/^Completion and assessment records verified in the POCUS portal\. They are not CanMEDS ratings and do not by themselves establish competence\./);
    expect(ev).toMatch(/Rotation requirements complete: 4 of 6 \(1 not yet due\)\./);
    expect(ev).toMatch(/• Written POCUS examination — complete: 85\.0% \(34\/40 points\) on POCUS Block Exam \(fictional\) v2, attempt 1 of 1 submitted \(most recent submitted attempt\), submitted October 14, 2026\. Strongest domains: Gastric 95%\. Domains to review: Lung 50%\. Knowledge assessment only\./);
    expect(ev).toMatch(/• Brightspace learning cases — in progress: 1 of 2 verified by faculty from completion evidence uploaded by the resident \(Gastric ultrasound case\)\. Not yet verified: ONSD case \(no evidence submitted\)\./);
    expect(ev).toMatch(/• Logbook of reviewed POCUS scans — complete: 60 of 60 faculty-verified reviewed scans, 64 reviewed in total \(Cardiac 40\/40; Gastric 24\/20\)\..*not an assessment of scanning competence/);
    expect(ev).toMatch(/• TeachingMedicine online skills modules — complete; confirmed by Dr Fictional Faculty, October 15, 2026\./);
    expect(ev).toMatch(/• POCUS rounds presentation — not yet due\./);
    const all = composeIter(s);
    const once = (re: RegExp) => expect(all.match(new RegExp(re.source, 'g'))?.length ?? 0).toBe(1);
    once(/Only one lung assessment documented/);
    once(/Interprets antral cross-sectional area reliably/);
    once(/Systematic gastric scanning sequence/);
    once(/reviewed the resident's C6 POCUS EPA assessments/);
  });

  it('EPA counts are reported as reviewed and never turned into a requirement decision', () => {
    const ev = sec(s, 'iter_evidence').text;
    expect(ev).toMatch(/• C6 POCUS EPAs — complete: Dr Fictional Faculty reviewed the resident's C6 POCUS EPA assessments in Elentra on October 20, 2026; 6 C6 POCUS assessments reviewed, entrustment level 5 × 2, level 4 × 3, level 3 × 1 \(scale 1 = “I had to do” to 5 = “I did not need to be there”\)\./);
    expect(ev).toMatch(/C6 criteria partially met; the criteria are a draft pending rotation director approval\./);
    expect(ev).toMatch(/does not by itself determine whether the C6 requirement is met/);
    expect(ev).toMatch(/not a separate assessment of competence/);
    const none = draftIter(fixture({ epa: { ...fixture().epa!, assessments_reviewed: null, entrustment_counts: {} } }), T, {});
    expect(sec(none, 'iter_evidence').text).not.toMatch(/assessments? reviewed|does not by itself determine/);
    expect(entrustmentText({})).toBe('');
  });
});

describe('faculty sections', () => {
  it('strengths and areas start as placeholders that block approval; optional fields do not', () => {
    const s = draftIter(fixture(), T, {});
    expect(sec(s, 'iter_strengths').text).toBe('[Faculty to complete: summary of strengths.]');
    expect(sec(s, 'iter_areas').text).toBe('[Faculty to complete: summary of areas needing improvement.]');
    expect(sec(s, 'iter_overall').text).not.toMatch(/\[Faculty to complete/);
    expect(sec(s, 'iter_recommendations').text).not.toMatch(/\[Faculty to complete/);
  });

  it('selections and text are faculty entries, re-rendered without touching the evidence', () => {
    const f: IterFields = { outcome: 'Yes, Partially', basis: ['Formal direct observation', 'Written examination', 'Made up'], discussed: 'yes', overall: 'Fictional overall comment', recommendations: '' };
    const s0 = draftIter(fixture(), T, {});
    const edited = s0.map((x) => (x.key === 'iter_evidence' ? { ...x, text: x.text + '\nFaculty edit kept' } : x));
    const s = applyFaculty(edited, T, f, { strengths: 'Fictional strengths', areas: 'Fictional areas' });
    expect(sec(s, 'iter_outcome').text).toBe('Yes, Partially');
    expect(sec(s, 'iter_basis').text).toBe('Formal direct observation; Written examination');
    expect(sec(s, 'iter_discussed').text).toBe('Yes');
    expect(sec(s, 'iter_overall').text).toBe('Fictional overall comment.');
    expect(sec(s, 'iter_strengths').text).toBe('Fictional strengths.');
    expect(sec(s, 'iter_evidence').text).toMatch(/Faculty edit kept$/);
    expect(sec(applyFaculty(s, T, { outcome: 'Outstanding' }, { strengths: '', areas: '' }), 'iter_outcome').text).toMatch(/Not selected/);
  });

  it('suggests the basis of assessment from what the portal holds; reminders stay out of the text', () => {
    expect(suggestBasis(fixture(), T)).toEqual(['Informal observation', 'Formal direct observation', 'Written examination', 'Other']);
    expect(suggestBasis(fixture({ observations: [], attempts: [], epa: null, requirements: [], rotationReqs: null }), T)).toEqual([]);
    const r = areaReminders(fixture(), ['ONSD case: no evidence submitted']);
    expect(r).toEqual(['EPA concern recorded: Only one lung assessment documented.', 'Outstanding: ONSD case: no evidence submitted.', 'Exam domains to review: Lung 50%.']);
  });

  it('the transfer sheet lists each section with its Elentra destination', () => {
    const txt = composeIter(draftIter(fixture(), T, { outcome: 'Yes, Fully' }));
    expect(txt).toMatch(/OVERALL ROTATION OBJECTIVES\n→ Elentra ITER → rotation objectives: select the same option\.\nYes, Fully/);
    expect(txt).toMatch(/SUMMARY OF STRENGTHS\n→ Elentra ITER → “Summary of strengths”: paste\./);
  });
});

describe('configurable template', () => {
  it('headings, options and role mapping come from the template; gaps fall back to the default', () => {
    const t = parseTemplate({
      roles: [{ key: 'leader', heading: 'Leader', categories: ['manager', 'general'] }],
      outcome: { options: ['Achieved', 'Not achieved'] },
      narrative: { strengths: { heading: 'Strengths observed' }, overall: { required: true } },
    });
    expect(t.outcome.heading).toBe('Overall rotation objectives');
    const s = draftIter(fixture(), t, { outcome: 'Yes, Fully' });
    expect(s.filter((x) => x.kind === 'role').map((x) => x.title)).toEqual(['Leader', 'Other faculty observations (no CanMEDS role selected)']);
    expect(sec(s, 'iter_role_leader').text).toMatch(/Arrived prepared/);
    expect(sec(s, 'iter_strengths').title).toBe('Strengths observed');
    expect(sec(s, 'iter_overall').text).toBe('[Faculty to complete: overall explanation of performance.]');
    expect(sec(s, 'iter_outcome').text).toMatch(/Not selected/); // not an option of this template
    expect(parseTemplate(null)).toEqual(DEFAULT_TEMPLATE);
  });
});
