/**
 * ITER-ready summary: pure helpers (no network), unit-tested in iter.test.ts.
 *
 * Re-arranges what the portal already holds under the headings of the
 * institutional ITER in One45 (University of Ottawa Anesthesiology; template is
 * configurable and stays DRAFT until the rotation director confirms it):
 *
 *   header      resident and rotation (check against One45)
 *   evidence    ONE factual section: requirements, exam, learning cases, scans,
 *               EPA review (the only place EPA information appears)
 *   observations  faculty observations for the block, as a reference (only
 *               when some exist). No rating is ever assigned.
 *   outcome     overall rotation objectives — faculty selection only
 *   narrative   overall explanation / strengths / areas / recommendations —
 *               faculty text only (strengths and areas are required)
 *   basis       basis of assessment (faculty ticks; the portal only suggests)
 *   discussed   performance discussed with the trainee (faculty selection)
 *   record      portal record of sources (for faculty files, not an ITER field)
 *
 * Factual completion evidence is kept apart from any judgement of competence.
 */
import {
  CATEGORIES, CRITERIA_LABEL, STATUS_LABEL, andList, chooseAttempt, epaVerified, factsFrom, fmt, latestSubmission, requirementState, sentence,
  type EpaReview, type ItarInput, type ItarSection, type Observation, type Requirement,
} from './itar';
import { REQ_LABEL, completion, rotationPassPct, type RotationReq } from './requirements';
import { domainHighlights } from './summary';

export const NARRATIVE_KEYS = ['overall', 'strengths', 'areas', 'recommendations'] as const;
export type NarrativeKey = (typeof NARRATIVE_KEYS)[number];

export type IterTemplate = {
  version: number;
  form_name: string;
  based_on: string;
  evidence: { heading: string; destination: string };
  outcome: { heading: string; destination: string; options: string[] };
  narrative: Record<NarrativeKey, { heading: string; required: boolean }>;
  narrative_destination: string;
  basis: { heading: string; destination: string; options: string[] };
  discussed: { heading: string; destination: string };
};

export type IterFields = {
  outcome?: string | null;
  basis?: string[];
  /** set when the faculty member ticks or unticks a basis option; nothing is pre-ticked for them */
  basis_confirmed?: boolean;
  /** the last automatic drafts, so a refresh replaces only text the faculty member has not edited */
  auto?: Partial<Record<'overall' | 'strengths' | 'areas' | 'recommendations', string>>;
  discussed?: 'yes' | 'no' | null;
  overall?: string;
  recommendations?: string;
};

/** Mirrors the seeded template (migration 12); used when none is configured and in tests. */
export const DEFAULT_TEMPLATE: IterTemplate = {
  version: 1,
  form_name: 'University of Ottawa Anesthesiology ITER',
  based_on: 'Elective assessment ITER example from One45 (October 2026). Confirm that the current POCUS block ITER in One45 uses the same headings and options.',
  evidence: { heading: 'Verified rotation evidence (POCUS portal)', destination: 'Reference for rating. If useful, paste after your own text in “Overall explanation of performance”.' },
  outcome: {
    heading: 'Overall rotation objectives',
    destination: 'One45 ITER → rotation objectives: select the same option.',
    options: ['No, due to other reasons', 'No, due to absence', 'No, due to unsatisfactory performance', 'Yes, Partially', 'Yes, Fully'],
  },
  narrative: {
    overall: { heading: 'Overall explanation of performance', required: false },
    strengths: { heading: 'Summary of strengths', required: true },
    areas: { heading: 'Summary of areas needing improvement', required: true },
    recommendations: { heading: 'Recommendations for ongoing improvement', required: false },
  },
  narrative_destination: 'One45 ITER → “{heading}”: paste.',
  basis: {
    heading: 'Basis of assessment',
    destination: 'One45 ITER → basis of assessment: tick the same boxes.',
    options: ['Informal observation', 'Formal direct observation', 'Written examination', 'Oral examination', 'OSCE', 'Other'],
  },
  discussed: { heading: 'Performance discussed with the trainee', destination: 'One45 ITER → select Yes or No.' },
};

const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
const strs = (v: unknown, d: string[]) => (Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()) && v.length ? v.map((x: string) => x.trim()) : d);

/** Read a stored template; missing or malformed parts fall back to the default. */
export function parseTemplate(def: unknown): IterTemplate {
  const d = (def && typeof def === 'object' ? def : {}) as Record<string, any>;
  const T = DEFAULT_TEMPLATE;
  const n = (d.narrative ?? {}) as Record<string, any>;
  return {
    version: Number(d.version) || 1,
    form_name: str(d.form_name, T.form_name),
    based_on: str(d.based_on, T.based_on),
    evidence: { heading: str(d.evidence?.heading, T.evidence.heading), destination: str(d.evidence?.destination, T.evidence.destination) },
    outcome: { heading: str(d.outcome?.heading, T.outcome.heading), destination: str(d.outcome?.destination, T.outcome.destination), options: strs(d.outcome?.options, T.outcome.options) },
    narrative: Object.fromEntries(NARRATIVE_KEYS.map((k) => [k, {
      heading: str(n[k]?.heading, T.narrative[k].heading),
      required: typeof n[k]?.required === 'boolean' ? n[k].required : T.narrative[k].required,
    }])) as IterTemplate['narrative'],
    narrative_destination: str(d.narrative_destination, T.narrative_destination),
    basis: { heading: str(d.basis?.heading, T.basis.heading), destination: str(d.basis?.destination, T.basis.destination), options: strs(d.basis?.options, T.basis.options) },
    discussed: { heading: str(d.discussed?.heading, T.discussed.heading), destination: str(d.discussed?.destination, T.discussed.destination) },
  };
}

// ---------------------------------------------------------------------------
// Factual evidence (one section; EPA information appears only here)
// ---------------------------------------------------------------------------
const LEVEL_ANCHOR: Record<string, string> = { '1': '“I had to do”', '5': '“I did not need to be there”' };

export function entrustmentText(counts: Record<string, number> | undefined): string {
  const parts = ['5', '4', '3', '2', '1'].filter((l) => Number(counts?.[l]) > 0).map((l) => `level ${l} × ${Number(counts![l])}`);
  if (!parts.length) return '';
  return `entrustment ${parts.join(', ')} (scale 1 = ${LEVEL_ANCHOR['1']} to 5 = ${LEVEL_ANCHOR['5']})`;
}

export function epaEvidence(epa: EpaReview | null): string {
  if (!epaVerified(epa)) return epa?.status === 'complete' ? 'review recorded before criteria verification; re-verification pending.' : 'review pending.';
  const x = epa!;
  const out: string[] = [];
  const n = x.assessments_reviewed;
  const ent = entrustmentText(x.entrustment_counts);
  const counts = n != null ? `; ${n} C6 POCUS assessment${n === 1 ? '' : 's'} reviewed${ent ? `, ${ent}` : ''}` : '';
  out.push(`${x.completed_by_name ?? 'Faculty'} reviewed the resident's C6 POCUS EPA assessments in Elentra on ${fmt(x.completed_at || x.review_date)}${counts}.`);
  const draft = /^\s*DRAFT/i.test(x.criteria_snapshot ?? '');
  out.push(`C6 criteria ${CRITERIA_LABEL[x.criteria_status!]}${x.criteria_status === 'met' ? ' (confirmed by the reviewing faculty member)' : ''}${draft ? '; the criteria are a draft pending rotation director approval' : ''}.`);
  if (n != null) out.push('The number of assessments is reported as reviewed; it does not by itself determine whether the C6 requirement is met.');
  if (x.key_findings?.trim()) out.push(`Faculty-identified findings: ${sentence(x.key_findings)}`);
  if (x.strengths.trim()) out.push(`Strengths noted in the EPA assessments: ${sentence(x.strengths)}`);
  if (x.areas_for_improvement.trim()) out.push(`Areas noted in the EPA assessments: ${sentence(x.areas_for_improvement)}`);
  if (x.concerns?.trim()) out.push(`Concerns noted by the reviewing faculty member: ${sentence(x.concerns)}`);
  const rows = x.entries.filter((e) => e.epa?.trim());
  if (rows.length) {
    out.push(`Recorded EPA details: ${rows.map((e) => `${e.epa.trim()}${e.title?.trim() ? ` (${e.title.trim()})` : ''}${e.n_assessments != null && !Number.isNaN(Number(e.n_assessments)) ? `, ${e.n_assessments} assessment${Number(e.n_assessments) === 1 ? '' : 's'}` : ''}${e.entrustment?.trim() ? `, ${e.entrustment.trim()}` : ''}`).join('; ')}.`);
  }
  out.push('This records a review of EPA assessments, not a separate assessment of competence.');
  return out.join(' ');
}

function examEvidence(i: ItarInput): string {
  const { attempt, rule } = chooseAttempt(i.attempts, i.selectedAttemptId);
  const e = factsFrom(attempt);
  if (!e) return i.examAssigned ? (i.attempts.some((a) => a.status === 'in_progress') ? 'in progress, not yet submitted.' : 'not yet completed.') : 'no examination assigned for this block.';
  if (e.gradingStatus !== 'complete' || e.scorePct == null) return `${e.examTitle} v${e.version}, attempt ${e.attemptNo}, submitted ${fmt(e.submittedAt)}; grading not yet complete.`;
  const n = i.attempts.filter((a) => a.status === 'submitted').length;
  const rp = rotationPassPct(i.rotationReqs);
  const pass = rp != null ? ` — rotation pass mark ${rp}% ${e.scorePct >= rp ? 'met' : 'not met'}` : '';
  const used = `attempt ${e.attemptNo} of ${n} submitted (${rule === 'faculty_selected' ? 'selected by the evaluating faculty member' : 'most recent submitted attempt'})`;
  const parts = [`${e.scorePct.toFixed(1)}% (${e.scorePoints}/${e.maxPoints} points) on ${e.examTitle} v${e.version}, ${used}, submitted ${fmt(e.submittedAt)}${pass}.`];
  if (n > 1) {
    const all = i.attempts.filter((a) => a.status === 'submitted').sort((a, b) => a.attempt_no - b.attempt_no);
    parts.push(`All attempts: ${all.map((a) => `#${a.attempt_no} ${a.score_pct == null ? 'not graded' : `${Number(a.score_pct).toFixed(1)}%`} (${fmt(a.submitted_at)})`).join('; ')}.`);
  }
  const { strong, weak } = domainHighlights(e.domains);
  if (strong.length) parts.push(`Strongest domains: ${andList(strong.map((d) => `${d.label} ${Math.round(d.pct!)}%`))}.`);
  if (weak.length) parts.push(`Domains to review: ${andList(weak.map((d) => `${d.label} ${Math.round(d.pct!)}%`))}.`);
  parts.push('Knowledge assessment only.');
  return parts.join(' ');
}

function casesEvidence(i: ItarInput): string {
  const req = i.requirements.filter((r) => r.required);
  if (!req.length) return 'none configured.';
  const v = req.filter((r) => requirementState(r) === 'verified');
  const rest = req.filter((r) => requirementState(r) !== 'verified');
  const who = (r: Requirement) => {
    const l = latestSubmission(r);
    return [l?.reviewer_name, l?.reviewed_at && fmt(l.reviewed_at)].filter(Boolean).join(', ');
  };
  return `${v.length} of ${req.length} verified by faculty from completion evidence uploaded by the resident${v.length ? ` (${v.map((r) => `${r.title}${who(r) ? ` — ${who(r)}` : ''}`).join('; ')})` : ''}.`
    + (rest.length ? ` Not yet verified: ${rest.map((r) => `${r.title} (${STATUS_LABEL[requirementState(r)].toLowerCase()})`).join('; ')}.` : '');
}

function scansEvidence(i: ItarInput): string {
  const s = i.rotationReqs!.scans;
  const raw = (s.reviewed_total ?? 0) > s.verified_total ? `, ${s.reviewed_total} reviewed in total` : '';
  const cats = s.categories.map((c) => `${c.label} ${c.verified}/${c.target}${c.views_note && c.verified >= c.target && !c.views_confirmed ? ' (views not confirmed)' : ''}`).join('; ');
  const last = s.history[0];
  const by = last ? ` Last attested by ${last.by ?? 'faculty'}, ${fmt(last.created_at)}.` : '';
  return `${s.verified_total} of ${s.target_total} faculty-verified reviewed scans${raw} (${cats}).${by} Images reviewed in QPath or another approved system; a completion measure, not an assessment of scanning competence.`;
}

function attestationEvidence(r: RotationReq): string {
  const stage = r.stage ? r.stages.find((s) => s.key === r.stage)?.label ?? r.detail : '';
  const who = r.status === 'verified' || r.override ? [r.verified_by_name && `confirmed by ${r.verified_by_name}`, r.verified_at && fmt(r.verified_at)].filter(Boolean).join(', ') : '';
  return `${REQ_LABEL[r.status].toLowerCase()}${stage ? ` (${stage})` : ''}${who ? `; ${who}` : ''}.`;
}

export function iterEvidence(i: ItarInput): string {
  const lines = ['Completion and assessment records verified in the POCUS portal. They are not ratings and do not by themselves establish competence.'];
  const rot = i.rotationReqs;
  if (rot?.requirements.length) {
    const c = completion(rot.requirements);
    lines.push(`Rotation requirements complete: ${c.done} of ${c.total}${c.notYetDue ? ` (${c.notYetDue} not yet due)` : ''}.`);
    for (const r of rot.requirements.filter((x) => x.required)) {
      const label = r.status === 'not_applicable' || r.status === 'not_yet_due' ? `${REQ_LABEL[r.status].toLowerCase()}.` : null;
      const body = label ?? (r.kind === 'exam' ? examEvidence(i)
        : r.kind === 'learning_cases' ? casesEvidence(i)
          : r.kind === 'scan_log' ? scansEvidence(i)
            : r.kind === 'epa' ? epaEvidence(i.epa)
              : attestationEvidence(r));
      lines.push(`• ${r.title} — ${r.kind === 'attestation' || label ? '' : `${REQ_LABEL[r.status].toLowerCase()}: `}${body}`);
    }
  } else {
    lines.push(`• Written examination — ${examEvidence(i)}`);
    lines.push(`• Required learning cases — ${casesEvidence(i)}`);
    lines.push(`• C6 POCUS EPAs — ${epaEvidence(i.epa)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Faculty observations (reference only)
// ---------------------------------------------------------------------------
const obsLine = (o: Observation) => {
  const meta = [o.author, fmt(o.observed_on || o.created_at), o.context?.trim()].filter(Boolean).join(', ');
  return `• ${sentence(o.body)}${meta ? ` (${meta})` : ''}`;
};

export function observationNotes(observations: Observation[]): string {
  return CATEGORIES.filter((c) => observations.some((o) => o.category === c.key))
    .map((c) => `${c.label}:\n${observations.filter((o) => o.category === c.key).map(obsLine).join('\n')}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// ITER Quick Copy: concise drafts of the One45 narrative fields
// ---------------------------------------------------------------------------
// Drafted ONLY from verified portal facts and faculty-entered text (EPA review
// notes, faculty observations). Nothing here rates the resident, judges whether
// the rotation objectives were met, or adds praise. Where the portal holds no
// faculty feedback to draft from, the field is left for faculty.
export type Drafts = Record<NarrativeKey, string>;

const shortTitle = (r: Pick<RotationReq, 'kind' | 'title'>) =>
  r.kind === 'learning_cases' ? 'Brightspace learning cases'
    : r.kind === 'scan_log' ? 'scan logbook'
      : r.kind === 'exam' ? 'written examination'
        : r.kind === 'epa' ? 'C6 POCUS EPAs'
          : r.title.replace(/ online skills modules/i, ' modules').replace(/ mentor review and ultrasound portfolio/i, ' portfolio review');
/**
 * Faculty selected "Yes, Fully" while required rotation items are still open:
 * the items to mention in a reminder. Never blocks approval and never changes
 * the outcome, which stays the faculty member's decision. Items not yet due
 * are not counted (same rule as the completion count).
 */
export function fullyMetReminder(outcome: string | null | undefined, reqs: Pick<RotationReq, 'kind' | 'title' | 'required' | 'status'>[] | undefined): string[] {
  if (!outcome || !/^yes,?\s*fully$/i.test(outcome.trim())) return [];
  return (reqs ?? []).filter((r) => r.required && !['verified', 'not_applicable', 'not_yet_due'].includes(r.status)).map(shortTitle);
}
const clip = (t: string, n = 180) => {
  const x = t.trim().replace(/\s+/g, ' ').replace(/[.;]+$/, '');
  return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x;
};

export function quickDrafts(i: ItarInput): Drafts {
  const rot = i.rotationReqs;
  const { attempt } = chooseAttempt(i.attempts, i.selectedAttemptId);
  const e = factsFrom(attempt);
  const rp = rotationPassPct(rot);
  const epa = epaVerified(i.epa) ? i.epa! : null;

  // Overall explanation: a short factual synthesis
  const overall: string[] = [];
  const open = rot?.requirements.filter((r) => r.required && !['verified', 'not_applicable', 'not_yet_due'].includes(r.status)) ?? [];
  if (rot?.requirements.length) {
    const c = completion(rot.requirements);
    const extras = rot.requirements.filter((r) => r.required && r.status === 'verified' && r.kind === 'attestation').map(shortTitle);
    if (c.outstanding === 0) {
      overall.push(`Completed ${c.done === c.total ? `all ${c.total}` : `${c.done} of ${c.total}`} required POCUS rotation activities${c.notYetDue ? ` (${c.notYetDue} not yet due)` : ''}${extras.length ? `, including ${andList(extras)}` : ''}.`);
    } else {
      overall.push(`Completed ${c.done} of ${c.total} required POCUS rotation activities; still to complete: ${andList(open.map(shortTitle))}.`);
    }
  }
  if (e && e.gradingStatus === 'complete' && e.scorePct != null) {
    overall.push(`Written examination: ${Math.round(e.scorePct * 10) / 10}%${rp != null ? ` (${e.scorePct >= rp ? 'rotation pass mark' : 'below the rotation pass mark of'} ${rp}%)` : ''}.`);
  } else if (i.examAssigned) {
    overall.push('Written examination not yet completed.');
  }
  const cases = i.requirements.filter((r) => r.required);
  if (cases.length && !rot?.requirements.length) {
    overall.push(`Brightspace learning cases: ${cases.filter((r) => requirementState(r) === 'verified').length} of ${cases.length} verified.`);
  }
  if (rot && rot.scans.target_total > 0) {
    const short = rot.scans.categories.filter((c) => !c.met);
    overall.push(`Scanning: ${rot.scans.verified_total} of ${rot.scans.target_total} required faculty-verified studies${short.length ? `; below target in ${andList(short.map((c) => `${c.label.toLowerCase()} (${c.verified}/${c.target})`))}` : ', meeting every category target'}.`);
  }
  if (epa) {
    const n = epa.assessments_reviewed;
    const top = Number(epa.entrustment_counts?.['5'] ?? 0);
    overall.push(`C6 POCUS EPAs: criteria ${epa.criteria_status === 'outstanding' ? 'not yet met' : CRITERIA_LABEL[epa.criteria_status!]} on faculty review of the Elentra assessments${n != null ? ` (${n} reviewed${top ? `; ${top} at the highest entrustment level` : ''})` : ''}.`);
    if (epa.key_findings?.trim()) overall.push(`EPA review findings: ${clip(epa.key_findings)}.`);
  }
  if (i.observations.length) {
    const chrono = [...i.observations].sort((a, b) => (a.observed_on || a.created_at).localeCompare(b.observed_on || b.created_at));
    overall.push(`Faculty observations: ${chrono.slice(0, 4).map((o) => clip(o.body, 160)).join('; ')}.`);
  }

  // Strengths: only documented feedback (EPA review notes)
  const strengths: string[] = [];
  if (epa?.strengths.trim()) {
    strengths.push(sentence(epa.strengths));
    if (e && e.gradingStatus === 'complete') {
      const { strong } = domainHighlights(e.domains);
      if (strong.length) strengths.push(`Highest written examination scores: ${andList(strong.map((d) => `${d.label} (${Math.round(d.pct!)}%)`))}.`);
    }
  }

  // Areas needing improvement: documented feedback and factual gaps
  const areas: string[] = [];
  if (epa?.areas_for_improvement.trim()) areas.push(sentence(epa.areas_for_improvement));
  if (epa?.concerns?.trim()) areas.push(`Concern noted on review of the EPA assessments: ${sentence(epa.concerns!)}`);
  let weak: { label: string; pct: number | null }[] = [];
  if (e && e.gradingStatus === 'complete') weak = domainHighlights(e.domains).weak;
  if (weak.length) areas.push(`Written examination domains to review: ${andList(weak.map((d) => `${d.label} (${Math.round(d.pct!)}%)`))}.`);

  // Recommendations: only what follows directly from the record
  const recs: string[] = [];
  if (open.length) recs.push('Complete the remaining rotation requirements.');
  if (weak.length) recs.push(`Review ${andList(weak.map((d) => d.label))}.`);

  return { overall: overall.join(' '), strengths: strengths.join(' '), areas: areas.join(' '), recommendations: recs.join(' ') };
}

/**
 * Refresh the drafted narrative fields. A field is replaced by the new draft
 * only if it is empty or still exactly the previous draft; anything the
 * faculty member wrote or edited is kept.
 */
export function refreshDrafts(cur: Drafts, prevAuto: Partial<Drafts> | undefined, next: Drafts): { values: Drafts; auto: Drafts } {
  const values = { ...cur };
  for (const k of NARRATIVE_KEYS) {
    const v = cur[k] ?? '';
    if (!v.trim() || (prevAuto?.[k] != null && v === prevAuto[k])) values[k] = next[k];
  }
  return { values, auto: next };
}

// ---------------------------------------------------------------------------
// Faculty-only sections
// ---------------------------------------------------------------------------
export type FacultyText = { strengths: string; areas: string };

const PLACEHOLDER: Record<'strengths' | 'areas', string> = {
  strengths: '[Faculty to complete: summary of strengths.]',
  areas: '[Faculty to complete: summary of areas needing improvement.]',
};
const OPTIONAL_BLANK = 'Not completed in the portal (optional) — write it in One45 if needed.';
export const BASIS_PROMPT = '[Faculty to confirm: basis of assessment.]';
/** Text that must be replaced before a draft can be approved. */
export const NEEDS_FACULTY = /\[Faculty to (complete|confirm)/;

export function facultyText(key: string, t: IterTemplate, f: IterFields, x: FacultyText): string | null {
  switch (key) {
    case 'iter_outcome':
      return f.outcome && t.outcome.options.includes(f.outcome) ? f.outcome : 'Not selected in the portal — select in One45.';
    case 'iter_overall':
    case 'iter_recommendations': {
      const k = key === 'iter_overall' ? 'overall' : 'recommendations';
      const v = (f[k] ?? '').trim();
      return v ? sentence(v) : t.narrative[k].required ? `[Faculty to complete: ${t.narrative[k].heading.toLowerCase()}.]` : OPTIONAL_BLANK;
    }
    case 'iter_strengths':
    case 'iter_areas': {
      const k = key === 'iter_strengths' ? 'strengths' : 'areas';
      const v = x[k].trim();
      return v ? sentence(v) : t.narrative[k].required ? PLACEHOLDER[k] : OPTIONAL_BLANK;
    }
    case 'iter_basis': {
      const sel = f.basis_confirmed ? (f.basis ?? []).filter((b) => t.basis.options.includes(b)) : [];
      return sel.length ? sel.join('; ') : BASIS_PROMPT;
    }
    case 'iter_discussed':
      return f.discussed === 'yes' ? 'Yes' : f.discussed === 'no' ? 'No' : 'Not recorded in the portal — select in One45.';
    default:
      return null;
  }
}

/** Re-render the faculty-owned sections after the faculty member edits a field. Evidence sections are left alone. */
export function applyFaculty(sections: ItarSection[], t: IterTemplate, f: IterFields, x: FacultyText): ItarSection[] {
  return sections.map((s) => {
    const text = facultyText(s.key, t, f, x);
    return text == null ? s : { ...s, text };
  });
}

/**
 * What the portal holds for each basis-of-assessment option. Shown beside the
 * boxes as information only — nothing is ticked automatically. EPA verification,
 * retrospective image review and the written exam are never treated as formal
 * direct observation.
 */
export function basisHints(i: ItarInput, t: IterTemplate): Record<string, string> {
  const { attempt } = chooseAttempt(i.attempts, i.selectedAttemptId);
  const n = i.observations.length;
  const out: Record<string, string> = {};
  for (const o of t.basis.options) {
    if (/^informal observation$/i.test(o)) out[o] = n ? `${n} faculty observation${n === 1 ? '' : 's'} recorded in the portal` : 'No faculty observations recorded in the portal';
    else if (/^formal direct observation$/i.test(o)) out[o] = 'Only if you or a colleague formally observed the resident. EPA verification, image review in QPath and the written exam do not count on their own.';
    else if (/^written exam/i.test(o)) out[o] = attempt && attempt.grading_status === 'complete' ? 'End-of-block written examination on record' : 'No graded written examination on record';
    else if (/^other$/i.test(o)) out[o] = 'For example: image review in QPath, Brightspace cases, TeachingMedicine, rounds presentation';
    else out[o] = 'Not recorded in the portal';
  }
  return out;
}

// ---------------------------------------------------------------------------
// The ITER-ready draft: Quick Copy fields + Full Evidence Record
// ---------------------------------------------------------------------------
/** Sections that go into One45 (the Quick Copy view). Everything else is the evidence record. */
export const QUICK_KINDS: ItarSection['kind'][] = ['outcome', 'narrative', 'basis', 'discussed'];
export const quickSections = (s: ItarSection[]) => s.filter((x) => QUICK_KINDS.includes(x.kind));
export const evidenceSections = (s: ItarSection[]) => s.filter((x) => !QUICK_KINDS.includes(x.kind));

export function draftIter(i: ItarInput, t: IterTemplate, f: IterFields): ItarSection[] {
  const x: FacultyText = { strengths: i.strengths, areas: i.areasForImprovement };
  const S: ItarSection[] = [];
  const fac = (key: string, kind: ItarSection['kind'], title: string, dest: string) =>
    S.push({ key, kind, title, text: facultyText(key, t, f, x)!, dest });

  // One45 fields (Quick Copy), in form order
  fac('iter_outcome', 'outcome', t.outcome.heading, t.outcome.destination);
  for (const k of NARRATIVE_KEYS) fac(`iter_${k}`, 'narrative', t.narrative[k].heading, t.narrative_destination.replace('{heading}', t.narrative[k].heading));
  fac('iter_basis', 'basis', t.basis.heading, t.basis.destination);
  fac('iter_discussed', 'discussed', t.discussed.heading, t.discussed.destination);

  // Full Evidence Record
  const dates = i.blockStart || i.blockEnd ? `, ${fmt(i.blockStart) || '—'} to ${fmt(i.blockEnd) || '—'}` : '';
  S.push({ key: 'iter_header', kind: 'header', title: 'Resident and rotation',
    text: `${i.learnerName}${i.trainingLevel ? ` (${i.trainingLevel})` : ''} — ${i.rotation}, ${i.blockName}${dates}.`,
    dest: 'Check that the One45 ITER is for the same resident, rotation and dates.' });
  S.push({ key: 'iter_evidence', kind: 'evidence', title: t.evidence.heading, text: iterEvidence(i), dest: t.evidence.destination });
  if (i.observations.length) {
    S.push({ key: 'iter_observations', kind: 'observations', title: 'Faculty observations', text: observationNotes(i.observations),
      dest: 'Reference — summarised in the drafted overall explanation.' });
  }
  const { attempt } = chooseAttempt(i.attempts, i.selectedAttemptId);
  const e = factsFrom(attempt);
  const req = i.requirements.filter((r) => r.required);
  const reviewers = [...new Set(req.filter((r) => requirementState(r) === 'verified').map((r) => latestSubmission(r)?.reviewer_name).filter(Boolean))] as string[];
  const authors = [...new Set(i.observations.map((o) => o.author).filter(Boolean))] as string[];
  S.push({ key: 'iter_record', kind: 'record', title: 'Evidence sources and verification', dest: 'For your files — not an ITER field.',
    text: [
      `Prepared in the POCUS Portal on ${fmt(i.today)} using the template “${t.form_name}” (${t.based_on})`,
      e ? `Written examination: portal record, ${e.examTitle} v${e.version}, attempt ${e.attemptNo}.` : 'Written examination: no submitted attempt on record.',
      `Learning cases: screenshots/PDFs uploaded by the resident, not retrieved from Brightspace${reviewers.length ? `; verified by ${andList(reviewers)}` : ''}.`,
      'EPA review: faculty attestation that the Elentra assessments were reviewed; no EPA data is retrieved from Elentra automatically.',
      `Faculty observations: ${i.observations.length}${authors.length ? ` (${andList(authors)})` : ''}.`,
      'Drafted text in the One45 fields comes only from these records and faculty-entered notes, and is reviewed and edited by the supervising faculty member.',
      'The portal assigns no rating and no overall outcome; both are the supervising faculty member\'s judgement, entered and submitted in One45. Approval in the portal is a draft approval, not a One45 submission.',
    ].join('\n') });
  return S;
}

/** Plain-text transfer sheet: every section with its One45 destination, in the order given. */
export function composeIter(sections: ItarSection[]): string {
  return sections.map((s) => `${s.title.toUpperCase()}${s.dest ? `\n→ ${s.dest}` : ''}\n${s.text.trim()}`).join('\n\n');
}

export const isIterDraft = (sections: ItarSection[]) => sections.some((s) => s.key.startsWith('iter_'));
