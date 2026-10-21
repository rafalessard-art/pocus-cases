/**
 * ITER-ready summary. Every person, score and comment below is fictional
 * (docs/exam-platform/fixtures/FICTIONAL_ITER_AND_EPA_EXAMPLE.md); no real
 * assessment record is used as a fixture.
 */
import { describe, expect, it } from 'vitest';
import { FORBIDDEN, type ItarInput, type WsAttempt } from './itar';
import {
  BASIS_PROMPT, DEFAULT_TEMPLATE, NEEDS_FACULTY, applyFaculty, basisHints, composeIter, draftIter, entrustmentText, evidenceSections, isIterDraft,
  parseTemplate, quickDrafts, quickSections, refreshDrafts, type IterFields,
  fullyMetReminder,
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

  it('puts the One45 fields first (Quick Copy) and keeps the evidence record separate; no CanMEDS sections', () => {
    expect(quickSections(s).map((x) => x.title)).toEqual([
      'Overall rotation objectives', 'Overall explanation of performance', 'Summary of strengths', 'Summary of areas needing improvement',
      'Recommendations for ongoing improvement', 'Basis of assessment', 'Performance discussed with the trainee',
    ]);
    expect(evidenceSections(s).map((x) => x.title)).toEqual([
      'Resident and rotation', 'Verified rotation evidence (POCUS portal)', 'Faculty observations', 'Evidence sources and verification',
    ]);
    expect(isIterDraft(s)).toBe(true);
    expect(s.every((x) => x.dest && x.kind)).toBe(true);
    expect(composeIter(s)).not.toMatch(/CanMEDS|Medical Expert|Health Advocate|Collaborator/);
  });

  it('assigns no rating and no overall outcome', () => {
    const all = composeIter(s);
    for (const f of FORBIDDEN) expect(all).not.toMatch(f);
    for (const r of ['Unsatisfactory', 'Below expectations', 'Meets expectations', 'Above expectations', 'Outstanding']) expect(all).not.toContain(r);
    expect(sec(s, 'iter_outcome').text).toBe('Not selected in the portal — select in One45.');
    for (const o of T.outcome.options) expect(all).not.toContain(o);
  });

  it('faculty observations are one reference section, grouped by category, and only when some exist', () => {
    expect(sec(s, 'iter_observations').text).toBe([
      'Practical scanning skills:', '• Obtained a right lateral decubitus antral view independently. (Dr Fictional Faculty, October 8, 2026, Pre-op clinic)',
      'Communication:', '• Explained the gastric scan to the patient clearly. (Dr Fictional Faculty, October 9, 2026)',
      'General:', '• Arrived prepared for every session. (Dr Other Fictional, October 10, 2026)',
    ].join('\n'));
    expect(sec(s, 'iter_observations').text).not.toMatch(/85\.0%|Elentra|entrustment/);
    expect(draftIter(fixture({ observations: [] }), T, {}).some((x) => x.key === 'iter_observations')).toBe(false);
  });

  it('separates factual evidence from judgement and writes EPA information exactly once', () => {
    const ev = sec(s, 'iter_evidence').text;
    expect(ev).toMatch(/^Completion and assessment records verified in the POCUS portal\. They are not ratings and do not by themselves establish competence\./);
    expect(ev).toMatch(/Rotation requirements complete: 4 of 6 \(1 not yet due\)\./);
    expect(ev).toMatch(/• Written POCUS examination — complete: 85\.0% \(34\/40 points\) on POCUS Block Exam \(fictional\) v2, attempt 1 of 1 submitted \(most recent submitted attempt\), submitted October 14, 2026\. Strongest domains: Gastric 95%\. Domains to review: Lung 50%\. Knowledge assessment only\./);
    expect(ev).toMatch(/• Brightspace learning cases — in progress: 1 of 2 verified by faculty from completion evidence uploaded by the resident \(Gastric ultrasound case — Dr Fictional Faculty\)\. Not yet verified: ONSD case \(no evidence submitted\)\./);
    expect(ev).toMatch(/• Logbook of reviewed POCUS scans — complete: 60 of 60 faculty-verified reviewed scans, 64 reviewed in total \(Cardiac 40\/40; Gastric 24\/20\)\..*not an assessment of scanning competence/);
    expect(ev).toMatch(/• TeachingMedicine online skills modules — complete; confirmed by Dr Fictional Faculty, October 15, 2026\./);
    expect(ev).toMatch(/• POCUS rounds presentation — not yet due\./);
    // within each view, EPA feedback appears once (the Quick Copy uses its own concise drafts)
    const record = composeIter(evidenceSections(s));
    const once = (txt: string, re: RegExp) => expect(txt.match(new RegExp(re.source, 'g'))?.length ?? 0).toBe(1);
    once(record, /Only one lung assessment documented/);
    once(record, /Interprets antral cross-sectional area reliably/);
    once(record, /Systematic gastric scanning sequence/);
    once(record, /reviewed the resident's C6 POCUS EPA assessments/);
    const d = quickDrafts(fixture());
    const quick = [d.overall, d.strengths, d.areas, d.recommendations].join('\n');
    once(quick, /Only one lung assessment documented/);
    once(quick, /Interprets antral cross-sectional area reliably/);
    once(quick, /Systematic gastric scanning sequence/);
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

describe('ITER Quick Copy drafts', () => {
  const PRAISE = /excellent|outstanding|superb|great|impressive|competent|strong (?!scan)|well done|exceeds/i;

  it('drafts a concise overall explanation from verified facts and faculty-entered notes only', () => {
    const d = quickDrafts(fixture());
    expect(d.overall).toBe([
      'Completed 4 of 6 required POCUS rotation activities; still to complete: Brightspace learning cases.',
      'Written examination: 85%.',
      'Scanning: 60 of 60 required faculty-verified studies, meeting every category target.',
      'C6 POCUS EPAs: criteria partially met on faculty review of the Elentra assessments (6 reviewed; 2 at the highest entrustment level).',
      'EPA review findings: Interprets antral cross-sectional area reliably.',
      'Faculty observations: Obtained a right lateral decubitus antral view independently; Explained the gastric scan to the patient clearly; Arrived prepared for every session.',
    ].join(' '));
    expect(d.overall.length).toBeLessThan(700);
    for (const t of Object.values(d)) expect(t).not.toMatch(PRAISE);
    for (const f of FORBIDDEN) expect(Object.values(d).join(' ')).not.toMatch(f);
  });

  it('strengths and areas come only from documented EPA feedback and factual gaps; otherwise left for faculty', () => {
    const d = quickDrafts(fixture());
    expect(d.strengths).toBe('Systematic gastric scanning sequence. Highest written examination scores: Gastric (95%).');
    expect(d.areas).toBe('Concern noted on review of the EPA assessments: Only one lung assessment documented. Written examination domains to review: Lung (50%).');
    expect(d.recommendations).toBe('Complete the remaining rotation requirements. Review Lung.');
    const bare = quickDrafts(fixture({ epa: null, observations: [], attempts: [att({ breakdown: { domains: [] } })] }));
    expect(bare.strengths).toBe('');
    expect(bare.areas).toBe('');
    const s = draftIter({ ...fixture(), strengths: bare.strengths, areasForImprovement: bare.areas }, T, {});
    expect(sec(s, 'iter_strengths').text).toMatch(NEEDS_FACULTY);
    expect(sec(s, 'iter_areas').text).toMatch(NEEDS_FACULTY);
  });

  it('a resident with everything complete gets a short synthesis', () => {
    const done: Rotation = { ...rotation, requirements: rotation.requirements.map((r) => ({ ...r, status: 'verified' as const })) };
    const d = quickDrafts(fixture({ rotationReqs: done }));
    expect(d.overall).toMatch(/^Completed all 6 required POCUS rotation activities, including TeachingMedicine modules and POCUS rounds presentation\./);
    expect(d.recommendations).toBe('Review Lung.');
  });

  it('refreshing replaces only drafts the faculty member has not edited', () => {
    const prev = quickDrafts(fixture());
    const next = { ...prev, overall: 'NEW overall', strengths: 'NEW strengths', areas: 'NEW areas', recommendations: 'NEW recs' };
    const { values, auto } = refreshDrafts({ ...prev, strengths: 'My own words about strengths', recommendations: '' }, prev, next);
    expect(values).toEqual({ overall: 'NEW overall', strengths: 'My own words about strengths', areas: 'NEW areas', recommendations: 'NEW recs' });
    expect(auto).toEqual(next);
    // first time: empty fields take the drafts, written text is kept
    expect(refreshDrafts({ overall: '', strengths: 'Typed before', areas: '', recommendations: '' }, undefined, next).values.strengths).toBe('Typed before');
  });
});

describe('faculty sections', () => {
  it('strengths, areas and the basis of assessment need faculty input before approval; optional fields do not', () => {
    const s = draftIter(fixture(), T, {});
    expect(sec(s, 'iter_strengths').text).toBe('[Faculty to complete: summary of strengths.]');
    expect(sec(s, 'iter_areas').text).toBe('[Faculty to complete: summary of areas needing improvement.]');
    expect(sec(s, 'iter_basis').text).toBe(BASIS_PROMPT);
    expect(sec(s, 'iter_overall').text).not.toMatch(NEEDS_FACULTY);
    expect(sec(s, 'iter_recommendations').text).not.toMatch(NEEDS_FACULTY);
  });

  it('selections and text are faculty entries, re-rendered without touching the evidence', () => {
    const f: IterFields = { outcome: 'Yes, Partially', basis: ['Informal observation', 'Written examination', 'Made up'], basis_confirmed: true, discussed: 'yes', overall: 'Fictional overall comment', recommendations: '' };
    const s0 = draftIter(fixture(), T, {});
    const edited = s0.map((x) => (x.key === 'iter_evidence' ? { ...x, text: x.text + '\nFaculty edit kept' } : x));
    const s = applyFaculty(edited, T, f, { strengths: 'Fictional strengths', areas: 'Fictional areas' });
    expect(sec(s, 'iter_outcome').text).toBe('Yes, Partially');
    expect(sec(s, 'iter_basis').text).toBe('Informal observation; Written examination');
    expect(sec(s, 'iter_discussed').text).toBe('Yes');
    expect(sec(s, 'iter_overall').text).toBe('Fictional overall comment.');
    expect(sec(s, 'iter_strengths').text).toBe('Fictional strengths.');
    expect(sec(s, 'iter_evidence').text).toMatch(/Faculty edit kept$/);
    expect(sec(applyFaculty(s, T, { outcome: 'Outstanding' }, { strengths: '', areas: '' }), 'iter_outcome').text).toMatch(/Not selected/);
    // a basis that was never confirmed by faculty (older pre-ticked drafts) does not count
    expect(sec(applyFaculty(s, T, { basis: ['Written examination'] }, { strengths: 'x', areas: 'y' }), 'iter_basis').text).toBe(BASIS_PROMPT);
  });

  it('basis of assessment: nothing is ticked automatically; EPA verification is never formal direct observation', () => {
    const h = basisHints(fixture(), T);
    expect(Object.keys(h)).toEqual(T.basis.options);
    expect(h['Formal direct observation']).toMatch(/Only if you or a colleague formally observed the resident\. EPA verification, image review in QPath and the written exam do not count on their own\./);
    expect(h['Informal observation']).toBe('3 faculty observations recorded in the portal');
    expect(basisHints(fixture({ observations: [] }), T)['Informal observation']).toBe('No faculty observations recorded in the portal');
    expect(h['Written examination']).toBe('End-of-block written examination on record');
    expect(sec(draftIter(fixture(), T, {}), 'iter_basis').text).toBe(BASIS_PROMPT);
  });

  it('the transfer sheet lists each One45 field with its destination, never Elentra', () => {
    const s = draftIter(fixture(), T, { outcome: 'Yes, Fully' });
    const txt = composeIter(quickSections(s));
    expect(txt).toMatch(/^OVERALL ROTATION OBJECTIVES\n→ One45 ITER → rotation objectives: select the same option\.\nYes, Fully/);
    expect(txt).toMatch(/SUMMARY OF STRENGTHS\n→ One45 ITER → “Summary of strengths”: paste\./);
    expect(composeIter(s)).not.toMatch(/Elentra ITER|in Elentra\b(?! on)/);
    expect(composeIter(evidenceSections(s))).toMatch(/Approval in the portal is a draft approval, not a One45 submission\./);
  });
});

describe('configurable template', () => {
  it('headings and options come from the template; gaps fall back to the default; old role settings are ignored', () => {
    const t = parseTemplate({
      roles: [{ key: 'leader', heading: 'Leader', categories: ['manager'] }],
      outcome: { options: ['Achieved', 'Not achieved'] },
      narrative: { strengths: { heading: 'Strengths observed' }, overall: { required: true } },
    });
    expect(t.outcome.heading).toBe('Overall rotation objectives');
    const s = draftIter(fixture(), t, { outcome: 'Yes, Fully' });
    expect(s.some((x) => x.kind === 'role' || /Leader/.test(x.title))).toBe(false);
    expect(sec(s, 'iter_strengths').title).toBe('Strengths observed');
    expect(sec(s, 'iter_overall').text).toBe('[Faculty to complete: overall explanation of performance.]');
    expect(sec(s, 'iter_outcome').text).toMatch(/Not selected/); // not an option of this template
    expect(parseTemplate(null)).toEqual(DEFAULT_TEMPLATE);
  });
});

describe('"Yes, Fully" reminder (non-blocking)', () => {
  const r = (kind: RotationReq['kind'], title: string, status: RotationReq['status'], required = true) => ({ kind, title, status, required });
  const reqs = [
    r('epa', 'C6 POCUS EPAs', 'in_progress'),
    r('learning_cases', 'Brightspace learning cases', 'verified'),
    r('scan_log', 'Logbook of reviewed POCUS scans', 'submitted'),
    r('attestation', 'POCUS rounds presentation', 'not_yet_due'),
    r('attestation', 'Optional extra', 'not_started', false),
    r('exam', 'Written POCUS examination', 'not_applicable'),
  ];
  it('lists open required items only when "Yes, Fully" is selected', () => {
    expect(fullyMetReminder('Yes, Fully', reqs)).toEqual(['C6 POCUS EPAs', 'scan logbook']);
    expect(fullyMetReminder('Yes, Partially', reqs)).toEqual([]);
    expect(fullyMetReminder('No, due to absence', reqs)).toEqual([]);
    expect(fullyMetReminder(null, reqs)).toEqual([]);
  });
  it('is silent when every required item is complete, not applicable or not yet due', () => {
    expect(fullyMetReminder('Yes, Fully', reqs.filter((x) => x.kind !== 'epa' && x.kind !== 'scan_log'))).toEqual([]);
    expect(fullyMetReminder('Yes, Fully', undefined)).toEqual([]);
  });
});
