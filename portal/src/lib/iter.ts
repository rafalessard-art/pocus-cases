/**
 * ITER-ready summary: pure helpers (no network), unit-tested in iter.test.ts.
 *
 * Re-arranges what the portal already holds under the headings of the
 * institutional ITER (University of Ottawa Anesthesiology; template is
 * configurable and stays DRAFT until the rotation director confirms it):
 *
 *   header      resident and rotation (check against Elentra)
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
  type EpaReview, type ItarInput, type ItarSection, type Observation,
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
  discussed?: 'yes' | 'no' | null;
  overall?: string;
  recommendations?: string;
};

/** Mirrors the seeded template (migration 12); used when none is configured and in tests. */
export const DEFAULT_TEMPLATE: IterTemplate = {
  version: 1,
  form_name: 'University of Ottawa Anesthesiology ITER',
  based_on: 'Elective assessment ITER example (October 2026). Confirm that the current POCUS block ITER uses the same headings and options.',
  evidence: { heading: 'Verified rotation evidence (POCUS portal)', destination: 'Reference for rating. If useful, paste after your own text in “Overall explanation of performance”.' },
  outcome: {
    heading: 'Overall rotation objectives',
    destination: 'Elentra ITER → rotation objectives: select the same option.',
    options: ['No, due to other reasons', 'No, due to absence', 'No, due to unsatisfactory performance', 'Yes, Partially', 'Yes, Fully'],
  },
  narrative: {
    overall: { heading: 'Overall explanation of performance', required: false },
    strengths: { heading: 'Summary of strengths', required: true },
    areas: { heading: 'Summary of areas needing improvement', required: true },
    recommendations: { heading: 'Recommendations for ongoing improvement', required: false },
  },
  narrative_destination: 'Elentra ITER → “{heading}”: paste.',
  basis: {
    heading: 'Basis of assessment',
    destination: 'Elentra ITER → basis of assessment: tick the same boxes.',
    options: ['Informal observation', 'Formal direct observation', 'Written examination', 'Oral examination', 'OSCE', 'Other'],
  },
  discussed: { heading: 'Performance discussed with the trainee', destination: 'Elentra ITER → select Yes or No.' },
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
  return `${v.length} of ${req.length} verified by faculty from completion evidence uploaded by the resident${v.length ? ` (${v.map((r) => r.title).join('; ')})` : ''}.`
    + (rest.length ? ` Not yet verified: ${rest.map((r) => `${r.title} (${STATUS_LABEL[requirementState(r)].toLowerCase()})`).join('; ')}.` : '');
}

function scansEvidence(i: ItarInput): string {
  const s = i.rotationReqs!.scans;
  const raw = (s.reviewed_total ?? 0) > s.verified_total ? `, ${s.reviewed_total} reviewed in total` : '';
  const cats = s.categories.map((c) => `${c.label} ${c.verified}/${c.target}${c.views_note && c.verified >= c.target && !c.views_confirmed ? ' (views not confirmed)' : ''}`).join('; ');
  return `${s.verified_total} of ${s.target_total} faculty-verified reviewed scans${raw} (${cats}). Images reviewed in QPath or another approved system; a completion measure, not an assessment of scanning competence.`;
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
// Faculty-only sections
// ---------------------------------------------------------------------------
export type FacultyText = { strengths: string; areas: string };

const PLACEHOLDER: Record<'strengths' | 'areas', string> = {
  strengths: '[Faculty to complete: summary of strengths.]',
  areas: '[Faculty to complete: summary of areas needing improvement.]',
};
const OPTIONAL_BLANK = 'Not completed in the portal (optional) — write in Elentra if needed.';

export function facultyText(key: string, t: IterTemplate, f: IterFields, x: FacultyText): string | null {
  switch (key) {
    case 'iter_outcome':
      return f.outcome && t.outcome.options.includes(f.outcome) ? f.outcome : 'Not selected in the portal — select in Elentra.';
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
      const sel = (f.basis ?? []).filter((b) => t.basis.options.includes(b));
      return sel.length ? sel.join('; ') : 'Not recorded in the portal — tick in Elentra.';
    }
    case 'iter_discussed':
      return f.discussed === 'yes' ? 'Yes' : f.discussed === 'no' ? 'No' : 'Not recorded in the portal — select in Elentra.';
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

/** What the portal can point to for each basis option (a suggestion; faculty decide what to tick). */
export function suggestBasis(i: ItarInput, t: IterTemplate): string[] {
  const has = (re: RegExp) => t.basis.options.filter((o) => re.test(o));
  const { attempt } = chooseAttempt(i.attempts, i.selectedAttemptId);
  const out: string[] = [];
  if (i.observations.length) out.push(...has(/^informal observation$/i));
  if (epaVerified(i.epa) && (i.epa!.assessments_reviewed ?? 1) > 0) out.push(...has(/^formal direct observation$/i));
  if (attempt && attempt.grading_status === 'complete') out.push(...has(/^written exam/i));
  const otherEvidence = i.requirements.some((r) => requirementState(r) === 'verified')
    || (i.rotationReqs?.scans.verified_total ?? 0) > 0
    || (i.rotationReqs?.requirements ?? []).some((r) => r.kind === 'attestation' && r.status === 'verified');
  if (otherEvidence) out.push(...has(/^other$/i));
  return t.basis.options.filter((o) => out.includes(o)); // template order
}

/** Reminders shown next to the "areas needing improvement" box — never inserted into the text. */
export function areaReminders(i: ItarInput, outstandingItems: string[]): string[] {
  const r: string[] = [];
  if (epaVerified(i.epa) && i.epa!.concerns?.trim()) r.push(`EPA concern recorded: ${sentence(i.epa!.concerns!)}`);
  if (outstandingItems.length) r.push(`Outstanding: ${outstandingItems.join('; ')}.`);
  const { attempt } = chooseAttempt(i.attempts, i.selectedAttemptId);
  const e = factsFrom(attempt);
  if (e && e.gradingStatus === 'complete') {
    const { weak } = domainHighlights(e.domains);
    if (weak.length) r.push(`Exam domains to review: ${weak.map((d) => `${d.label} ${Math.round(d.pct!)}%`).join(', ')}.`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// The ITER-ready summary
// ---------------------------------------------------------------------------
export function draftIter(i: ItarInput, t: IterTemplate, f: IterFields): ItarSection[] {
  const x: FacultyText = { strengths: i.strengths, areas: i.areasForImprovement };
  const S: ItarSection[] = [];
  const dates = i.blockStart || i.blockEnd ? `, ${fmt(i.blockStart) || '—'} to ${fmt(i.blockEnd) || '—'}` : '';
  S.push({ key: 'iter_header', kind: 'header', title: 'Resident and rotation',
    text: `${i.learnerName}${i.trainingLevel ? ` (${i.trainingLevel})` : ''} — ${i.rotation}, ${i.blockName}${dates}.`,
    dest: 'Check that the Elentra ITER is for the same resident, rotation and dates.' });
  S.push({ key: 'iter_evidence', kind: 'evidence', title: t.evidence.heading, text: iterEvidence(i), dest: t.evidence.destination });

  if (i.observations.length) {
    S.push({ key: 'iter_observations', kind: 'observations', title: 'Faculty observations', text: observationNotes(i.observations),
      dest: 'Reference — use in your own words in “Overall explanation of performance” or the summaries below, if relevant.' });
  }

  const fac = (key: string, kind: ItarSection['kind'], title: string, dest: string) =>
    S.push({ key, kind, title, text: facultyText(key, t, f, x)!, dest });
  fac('iter_outcome', 'outcome', t.outcome.heading, t.outcome.destination);
  for (const k of NARRATIVE_KEYS) fac(`iter_${k}`, 'narrative', t.narrative[k].heading, t.narrative_destination.replace('{heading}', t.narrative[k].heading));
  fac('iter_basis', 'basis', t.basis.heading, t.basis.destination);
  fac('iter_discussed', 'discussed', t.discussed.heading, t.discussed.destination);

  // portal record (sources)
  const { attempt } = chooseAttempt(i.attempts, i.selectedAttemptId);
  const e = factsFrom(attempt);
  const req = i.requirements.filter((r) => r.required);
  const reviewers = [...new Set(req.filter((r) => requirementState(r) === 'verified').map((r) => latestSubmission(r)?.reviewer_name).filter(Boolean))] as string[];
  const authors = [...new Set(i.observations.map((o) => o.author).filter(Boolean))] as string[];
  S.push({ key: 'iter_record', kind: 'record', title: 'Portal record', dest: 'For your files — not an ITER field.',
    text: [
      `Prepared in the POCUS Portal on ${fmt(i.today)} using the template “${t.form_name}” (${t.based_on})`,
      e ? `Written examination: portal record, ${e.examTitle} v${e.version}, attempt ${e.attemptNo}.` : 'Written examination: no submitted attempt on record.',
      `Learning cases: screenshots/PDFs uploaded by the resident, not retrieved from Brightspace${reviewers.length ? `; verified by ${andList(reviewers)}` : ''}.`,
      'EPA review: faculty attestation that the Elentra assessments were reviewed; no EPA data is retrieved from Elentra automatically.',
      `Faculty observations: ${i.observations.length}${authors.length ? ` (${andList(authors)})` : ''}.`,
      'The portal assigns no rating and no overall outcome; both are the supervising faculty member\'s judgement, entered in Elentra.',
    ].join('\n') });
  return S;
}

/** Plain-text transfer sheet: every section with its Elentra destination, in form order. */
export function composeIter(sections: ItarSection[]): string {
  return sections.map((s) => `${s.title.toUpperCase()}${s.dest ? `\n→ ${s.dest}` : ''}\n${s.text.trim()}`).join('\n\n');
}

export const isIterDraft = (sections: ItarSection[]) => sections.some((s) => s.key.startsWith('iter_'));
