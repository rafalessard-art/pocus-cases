/**
 * ITAR preparation: pure helpers (no network), unit-tested in itar.test.ts.
 *
 * The draft is assembled ONLY from records in the portal:
 *   - verified exam data (server-scored attempts),
 *   - learning-case evidence and its faculty verification status,
 *   - a faculty-completed EPA review (transcribed from Elentra),
 *   - observations typed by faculty,
 *   - text the evaluating faculty member types.
 * It never infers scanning skill, clinical judgement, procedural competence or
 * professionalism from exam scores, and never assigns an overall rating.
 * Placeholders in [square brackets] mark what faculty must write themselves.
 */
import { outstandingRequirements, requirementsSection, rotationPassPct, type Rotation } from './requirements';
import { domainHighlights, type ExamFacts } from './summary';

export type EvidenceStatus = 'submitted' | 'verified' | 'clarification_requested' | 'rejected';
export type Submission = {
  id: string; status: EvidenceStatus; original_filename: string; mime_type: string; storage_path: string; created_at: string;
  reviewed_at?: string | null; reviewer_name?: string | null; reviewer_message?: string; learner_note?: string; file_deleted_at?: string | null;
  size_bytes?: number | null; sha256?: string | null;
};
export type Requirement = {
  id: string; title: string; description?: string; required: boolean; source?: string; external_ref?: string | null; submissions: Submission[];
};
export type EpaEntry = { epa: string; title?: string; n_assessments?: number | null; entrustment?: string; comment?: string };
export type EpaReview = {
  id?: string; status: 'pending' | 'complete'; entries: EpaEntry[]; strengths: string; areas_for_improvement: string;
  review_date: string | null; completed_by_name?: string | null; completed_at?: string | null;
  /** streamlined verification (migration 11) */
  reviewed_in_elentra?: boolean; criteria_status?: 'met' | 'partially_met' | 'outstanding' | null; criteria_confirmed?: boolean;
  criteria_snapshot?: string; concerns?: string;
};
export const CRITERIA_LABEL = { met: 'met', partially_met: 'partially met', outstanding: 'outstanding' } as const;
/** A completed review under the streamlined form (older completed reviews lack a criteria decision). */
export const epaVerified = (e: EpaReview | null | undefined) => !!e && e.status === 'complete' && !!e.criteria_status;
export type Category = 'scanning' | 'clinical_judgement' | 'technical' | 'professionalism' | 'communication' | 'general';
export type Observation = { id: string; category: Category; observed_on: string | null; context?: string; body: string; author?: string | null; created_at: string };
export type WsAttempt = {
  id: string; exam_title: string; version: number; attempt_no: number; status: 'in_progress' | 'submitted'; started_at: string;
  submitted_at: string | null; score_points: number | null; max_points: number | null; score_pct: number | null; passed: boolean | null;
  pass_threshold_pct: number | null; grading_status: string; released: boolean; breakdown?: { domains: any[] } | null;
};
export type ItarSection = { key: string; title: string; text: string };
export type AttemptRule = 'latest_submitted' | 'faculty_selected' | 'none';

export const CATEGORIES: { key: Category; label: string; core: boolean }[] = [
  { key: 'scanning', label: 'Practical scanning skills', core: true },
  { key: 'clinical_judgement', label: 'Clinical judgement', core: true },
  { key: 'technical', label: 'Technical performance', core: true },
  { key: 'professionalism', label: 'Professionalism', core: true },
  { key: 'communication', label: 'Communication', core: false },
  { key: 'general', label: 'General', core: false },
];
export const categoryLabel = (k: string) => CATEGORIES.find((c) => c.key === k)?.label ?? k;

export const STATUS_LABEL: Record<EvidenceStatus | 'missing', string> = {
  missing: 'No evidence submitted',
  submitted: 'Awaiting faculty review',
  verified: 'Verified',
  clarification_requested: 'Clarification requested',
  rejected: 'Rejected',
};

export const TONE: Record<EvidenceStatus | 'missing', 'ok' | 'warn' | 'bad' | 'info' | undefined> = {
  verified: 'ok', submitted: 'info', clarification_requested: 'warn', rejected: 'bad', missing: undefined,
};

const fmt = (d?: string | null) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }) : '');
const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?:][)"”’]?$/.test(t) ? t : `${t}.`;
};
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Latest uploaded submission decides a requirement's state. */
export function latestSubmission(r: Requirement): Submission | null {
  return [...r.submissions].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}
export function requirementState(r: Requirement): EvidenceStatus | 'missing' {
  return latestSubmission(r)?.status ?? 'missing';
}

/**
 * Which attempt the ITAR uses. Default: the most recent submitted attempt.
 * Faculty may select another submitted attempt; the draft says which and why.
 */
export function chooseAttempt(attempts: WsAttempt[], selectedId?: string | null): { attempt: WsAttempt | null; rule: AttemptRule } {
  const submitted = attempts.filter((a) => a.status === 'submitted').sort((a, b) => (b.submitted_at ?? '').localeCompare(a.submitted_at ?? ''));
  if (selectedId) {
    const s = submitted.find((a) => a.id === selectedId);
    if (s) return { attempt: s, rule: s.id === submitted[0]?.id ? 'latest_submitted' : 'faculty_selected' };
  }
  return submitted[0] ? { attempt: submitted[0], rule: 'latest_submitted' } : { attempt: null, rule: 'none' };
}

export function factsFrom(a: WsAttempt | null): ExamFacts | null {
  if (!a) return null;
  const n = (v: unknown) => (v == null ? null : Number(v));
  return {
    examTitle: a.exam_title, version: a.version, submittedAt: a.submitted_at, attemptNo: a.attempt_no,
    scorePct: n(a.score_pct), scorePoints: n(a.score_points), maxPoints: n(a.max_points), passThresholdPct: n(a.pass_threshold_pct),
    passed: a.passed, gradingStatus: a.grading_status,
    domains: (a.breakdown?.domains ?? []).map((d: any) => ({ key: d.key, label: d.label, pct: d.pct == null ? null : Number(d.pct), n_items: d.n_items })),
  };
}

export type ItarInput = {
  learnerName: string;
  trainingLevel?: string | null;
  rotation: string;
  blockName: string;
  blockStart?: string | null;
  blockEnd?: string | null;
  examAssigned: boolean;
  attempts: WsAttempt[];
  selectedAttemptId?: string | null;
  requirements: Requirement[];
  epa: EpaReview | null;
  observations: Observation[];
  strengths: string;
  areasForImprovement: string;
  otherComments: string;
  today: string; // ISO date the draft is generated
  /** Rotation requirements (completion tracker); when present, it drives the outstanding list. */
  rotationReqs?: Rotation | null;
};

/** What is still outstanding, in plain words (used in the draft and the UI). */
export function outstanding(i: Pick<ItarInput, 'examAssigned' | 'attempts' | 'selectedAttemptId' | 'requirements' | 'epa' | 'rotationReqs'>) {
  if (i.rotationReqs?.requirements.length) return outstandingRequirements(i.rotationReqs);
  const out: string[] = [];
  const { attempt } = chooseAttempt(i.attempts, i.selectedAttemptId);
  if (!attempt) {
    out.push(i.attempts.some((a) => a.status === 'in_progress') ? 'Written examination in progress, not yet submitted' : i.examAssigned ? 'Written examination not completed' : 'No written examination assigned for this block');
  } else if (attempt.grading_status !== 'complete' || attempt.score_pct == null) {
    out.push('Written examination grading not complete');
  } else if (attempt.passed === false) {
    out.push(`Written examination below the pass threshold (${Number(attempt.score_pct).toFixed(1)}%)`);
  }
  for (const r of i.requirements.filter((x) => x.required)) {
    const s = requirementState(r);
    if (s !== 'verified') out.push(`Learning case “${r.title}”: ${STATUS_LABEL[s].toLowerCase()}`);
  }
  if (!epaVerified(i.epa)) out.push('EPA review (Elentra) pending');
  else if (i.epa!.criteria_status !== 'met') out.push(`C6 POCUS EPA criteria ${CRITERIA_LABEL[i.epa!.criteria_status!]}`);
  return out;
}

export function draftItar(i: ItarInput): ItarSection[] {
  const S: ItarSection[] = [];
  const who = `${i.learnerName}${i.trainingLevel ? ` (${i.trainingLevel})` : ''}`;
  const dates = i.blockStart || i.blockEnd ? `, ${fmt(i.blockStart) || '—'} to ${fmt(i.blockEnd) || '—'}` : '';
  S.push({ key: 'rotation', title: 'Rotation', text: `${who} — ${i.rotation}, ${i.blockName}${dates}.` });
  if (i.rotationReqs?.requirements.length) S.push(requirementsSection(i.rotationReqs));

  // A. Written examination
  const { attempt, rule } = chooseAttempt(i.attempts, i.selectedAttemptId);
  const e = factsFrom(attempt);
  const nSubmitted = i.attempts.filter((a) => a.status === 'submitted').length;
  const exam: string[] = [];
  if (!e) {
    exam.push(i.examAssigned ? 'The end-of-block written examination has not been completed.' : 'No end-of-block written examination was assigned for this block.');
  } else if (e.gradingStatus !== 'complete' || e.scorePct == null) {
    exam.push(`The end-of-block written examination (${e.examTitle}, v${e.version}) was submitted on ${fmt(e.submittedAt)}; grading is not yet complete.`);
  } else {
    const rp = rotationPassPct(i.rotationReqs);
    const pass = rp != null
      ? (e.scorePct >= rp ? `, meeting the rotation pass mark of ${rp}%` : `, below the rotation pass mark of ${rp}%`)
      : e.passed == null || e.passThresholdPct == null ? '' : e.passed ? `, meeting the pass threshold of ${e.passThresholdPct}%` : `, below the pass threshold of ${e.passThresholdPct}%`;
    exam.push(`On the end-of-block written examination (${e.examTitle}, v${e.version}), submitted ${fmt(e.submittedAt)}, the score was ${e.scorePct.toFixed(1)}% (${e.scorePoints}/${e.maxPoints} points)${pass}.`);
    const { strong, weak } = domainHighlights(e.domains);
    if (strong.length) exam.push(`Performance was strongest in ${andList(strong.map((d) => `${d.label} (${Math.round(d.pct!)}%)`))}.`);
    if (weak.length) exam.push(`Results suggest review of ${andList(weak.map((d) => `${d.label} (${Math.round(d.pct!)}%)`))}.`);
  }
  if (e && nSubmitted > 1) {
    exam.push(`This is attempt ${e.attemptNo} (${nSubmitted} submitted attempts); ${rule === 'faculty_selected' ? 'the attempt was selected by the evaluating faculty member' : 'the most recent submitted attempt is used'}.`);
  }
  exam.push('Written examination results reflect knowledge only; they do not assess image acquisition, bedside scanning, clinical judgement or procedural skill.');
  S.push({ key: 'exam', title: 'Knowledge assessment — written examination', text: exam.join(' ') });

  // B. Learning cases
  const req = i.requirements.filter((r) => r.required);
  const verified = req.filter((r) => requirementState(r) === 'verified');
  const cases: string[] = [];
  if (!req.length) cases.push('No learning-case requirements are configured for this block.');
  else {
    cases.push(`Completion of ${verified.length} of ${req.length} required learning cases was verified by faculty from evidence uploaded by the resident${verified.length ? `: ${verified.map((r) => r.title).join('; ')}` : ''}.`);
    const rest = req.filter((r) => requirementState(r) !== 'verified');
    if (rest.length) cases.push(`Not yet verified: ${rest.map((r) => `${r.title} (${STATUS_LABEL[requirementState(r)].toLowerCase()})`).join('; ')}.`);
  }
  S.push({ key: 'cases', title: 'Required learning cases (Brightspace)', text: cases.join(' ') });

  // C. EPA review — faculty verification of Elentra assessments (no re-entry of EPA details required)
  const epa: string[] = [];
  if (!epaVerified(i.epa)) epa.push(i.epa?.status === 'complete' ? 'EPA review recorded before criteria verification; re-verification pending.' : 'EPA review pending.');
  else {
    const x = i.epa!;
    const draftCriteria = /^\s*DRAFT/i.test(x.criteria_snapshot ?? '');
    epa.push(`${x.completed_by_name ?? 'Faculty'} reviewed the resident's EPA assessments in Elentra on ${fmt(x.completed_at || x.review_date)}.`);
    epa.push(`C6 POCUS EPA completion criteria: ${CRITERIA_LABEL[x.criteria_status!]}${x.criteria_status === 'met' ? ' (criteria confirmed by the reviewing faculty member)' : ''}${draftCriteria ? '; the criteria are a draft pending rotation director approval' : ''}.`);
    for (const e of i.epa!.entries.filter((e) => e.epa?.trim())) {
      const n = e.n_assessments == null || Number.isNaN(Number(e.n_assessments)) ? '' : `: ${e.n_assessments} assessment${Number(e.n_assessments) === 1 ? '' : 's'}`;
      epa.push(`\n• ${e.epa.trim()}${e.title?.trim() ? ` — ${e.title.trim()}` : ''}${n}${e.entrustment?.trim() ? `; entrustment: ${e.entrustment.trim()}` : ''}${e.comment?.trim() ? `. ${sentence(e.comment)}` : ''}`);
    }
    if (x.strengths.trim()) epa.push(`\nStrengths noted from EPA assessments: ${sentence(x.strengths)}`);
    if (x.areas_for_improvement.trim()) epa.push(`\nAreas for improvement noted from EPA assessments: ${sentence(x.areas_for_improvement)}`);
    if (x.concerns?.trim()) epa.push(`\nConcerns noted by the reviewing faculty member: ${sentence(x.concerns)}`);
    epa.push('\nThis records that EPA assessments were reviewed against the program criteria; it is not a separate assessment of clinical competence.');
  }
  S.push({ key: 'epa', title: 'Workplace-based assessment — EPA review (Elentra)', text: epa.join(' ').replace(/ \n/g, '\n') });

  // D. Observations
  const obs: string[] = [];
  if (!i.observations.length) obs.push('No direct faculty observations were recorded for this block.');
  else {
    obs.push('Recorded by faculty from direct observation during the block (separate from the written examination).');
    for (const c of CATEGORIES) {
      const xs = i.observations.filter((o) => o.category === c.key);
      if (!xs.length) continue;
      obs.push(`\n${c.label}:`);
      for (const o of xs) {
        const meta = [o.author, fmt(o.observed_on || o.created_at), o.context?.trim()].filter(Boolean).join(', ');
        obs.push(`\n• ${sentence(o.body)}${meta ? ` (${meta})` : ''}`);
      }
    }
    const missing = CATEGORIES.filter((c) => c.core && !i.observations.some((o) => o.category === c.key)).map((c) => c.label);
    if (missing.length) obs.push(`\nNo observations recorded for: ${missing.join(', ')}.`);
  }
  S.push({ key: 'observations', title: 'Direct faculty observations', text: obs.join(' ').replace(/ \n/g, '\n') });

  // Faculty synthesis
  S.push({ key: 'strengths', title: 'Strengths', text: i.strengths.trim() ? sentence(i.strengths) : '[Faculty to complete: strengths observed during the block.]' });
  const needs: string[] = [i.areasForImprovement.trim() ? sentence(i.areasForImprovement) : '[Faculty to complete: areas for improvement and learning plan.]'];
  if (epaVerified(i.epa) && i.epa!.concerns?.trim()) needs.push(`\nConcerns from the EPA review (faculty to address in the ITAR): ${sentence(i.epa!.concerns!)}`);
  const o = outstanding(i);
  needs.push(o.length ? `\nOutstanding requirements:\n${o.map((x) => `• ${x}`).join('\n')}` : '\nNo outstanding requirements recorded in the portal.');
  if (e && e.gradingStatus === 'complete') {
    const { weak } = domainHighlights(e.domains);
    if (weak.length) needs.push(`\nKnowledge domains to review (written examination): ${weak.map((d) => `${d.label} (${Math.round(d.pct!)}%)`).join(', ')}.`);
  }
  S.push({ key: 'learning_needs', title: 'Areas for improvement and outstanding requirements', text: needs.join('') });
  if (i.otherComments.trim()) S.push({ key: 'comments', title: 'Additional comments', text: sentence(i.otherComments) });

  // Sources
  const src: string[] = [];
  src.push(e
    ? `• Written examination: POCUS Portal record, ${e.examTitle} v${e.version}, attempt ${e.attemptNo}, submitted ${fmt(e.submittedAt)}; ${e.gradingStatus === 'complete' ? 'scored by the portal' : 'grading incomplete'}.`
    : '• Written examination: no submitted attempt on record.');
  const reviewers = [...new Set(verified.map((r) => latestSubmission(r)?.reviewer_name).filter(Boolean))] as string[];
  const count = (s: string) => req.filter((r) => requirementState(r) === s).length;
  src.push(`• Learning cases: screenshots/PDFs uploaded by the resident (not retrieved from Brightspace); ${verified.length} verified${reviewers.length ? ` by ${andList(reviewers)}` : ''}, ${count('submitted')} awaiting review, ${count('clarification_requested') + count('rejected')} returned to the resident, ${count('missing')} not submitted.`);
  src.push(epaVerified(i.epa)
    ? `• EPA review: faculty attestation that the Elentra assessments were reviewed${i.epa!.completed_by_name ? ` (${i.epa!.completed_by_name})` : ''}, ${fmt(i.epa!.completed_at || i.epa!.review_date)}; EPA data not retrieved from Elentra automatically.`
    : '• EPA review: pending.');
  const authors = [...new Set(i.observations.map((x) => x.author).filter(Boolean))] as string[];
  src.push(`• Direct observations: ${i.observations.length} entr${i.observations.length === 1 ? 'y' : 'ies'}${authors.length ? ` by ${andList(authors)}` : ''}.`);
  src.push(`• Prepared in the POCUS Portal ITAR preparation workspace on ${fmt(i.today)}. The portal assigns no overall rating; the overall assessment is the supervising faculty member's judgement, recorded in the institution's official ITAR.`);
  S.push({ key: 'sources', title: 'Evidence sources and verification status', text: src.join('\n') });
  return S;
}

export function composeSummary(sections: ItarSection[]): string {
  return sections.map((s) => `${s.title.toUpperCase()}\n${s.text.trim()}`).join('\n\n');
}

/** Changes when any input that feeds the draft changes (to flag a stale draft). */
export function fingerprint(i: ItarInput): string {
  const { attempt } = chooseAttempt(i.attempts, i.selectedAttemptId);
  const key = JSON.stringify([
    attempt?.id, attempt?.score_pct, attempt?.grading_status,
    i.requirements.map((r) => [r.id, latestSubmission(r)?.id, requirementState(r)]),
    i.epa ? [i.epa.status, i.epa.completed_at, i.epa.criteria_status] : null,
    i.observations.map((o) => o.id).sort(),
    i.rotationReqs ? [i.rotationReqs.requirements.map((r) => [r.key, r.status, r.stage]), i.rotationReqs.scans.verified_total] : null,
  ]);
  let h = 5381;
  for (let k = 0; k < key.length; k++) h = ((h << 5) + h + key.charCodeAt(k)) | 0;
  return (h >>> 0).toString(36);
}

/** Phrases the generator must never produce on its own (rating or inferred skill). */
export const FORBIDDEN = [/overall rating (of|is|:)/i, /\brated\b/i, /meets expectations/i, /exceeds expectations/i, /competent (in|at) scanning/i, /entrustable/i];

// ---------------------------------------------------------------------------
// Block overview: what needs attention, and from whom
// ---------------------------------------------------------------------------
export type OverviewRow = {
  id: string; name: string; training_level: string | null;
  exam: { assigned: boolean; n_attempts: number; in_progress: boolean; latest: { id: string; score_pct: number | null; passed: boolean | null; grading_status: string; submitted_at: string } | null };
  evidence: { required: number; submitted: number; verified: number; awaiting_review: number; clarification: number; rejected: number };
  epa_status: 'not_started' | 'pending' | 'complete';
  n_observations: number;
  itar: { id: string; status: 'draft' | 'approved'; updated_at: string; approved_at: string | null; has_text: boolean } | null;
};

export function attention(r: OverviewRow) {
  const faculty: string[] = [];
  const resident: string[] = [];
  if (r.itar?.status === 'approved') return { faculty, resident, done: true };
  const ex = r.exam.latest;
  if (!ex) resident.push(r.exam.in_progress ? 'Exam in progress' : r.exam.assigned ? 'Exam outstanding' : 'No exam assigned');
  else if (ex.grading_status === 'pending_manual') faculty.push('Grade exam');
  if (r.evidence.awaiting_review) faculty.push(`Review evidence (${r.evidence.awaiting_review})`);
  const missing = r.evidence.required - r.evidence.submitted;
  if (missing > 0) resident.push(`Evidence missing (${missing})`);
  if (r.evidence.clarification + r.evidence.rejected) resident.push(`Evidence returned (${r.evidence.clarification + r.evidence.rejected})`);
  if (r.epa_status !== 'complete') faculty.push('EPA review');
  faculty.push(r.itar?.has_text ? 'Approve ITAR' : 'Prepare ITAR');
  return { faculty, resident, done: false };
}
