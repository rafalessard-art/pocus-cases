/**
 * Rotation requirements: types and pure helpers (no network), unit-tested in
 * requirements.test.ts. Statuses are computed in the database
 * (_rotation_status); this file only presents and summarises them.
 * Completion counts are never turned into a competence judgement.
 */

export type ReqStatus = 'not_started' | 'in_progress' | 'submitted' | 'verified' | 'clarification_requested' | 'not_yet_due' | 'not_applicable';
export type ReqKind = 'exam' | 'learning_cases' | 'epa' | 'scan_log' | 'attestation';
export type Stage = { key: string; label: string; by: 'resident' | 'faculty' };

export type RotationReq = {
  id: string; key: string; kind: ReqKind; title: string; description: string; required: boolean; resident_submits: boolean;
  stages: Stage[]; evidence_requirement_id: string | null; status: ReqStatus; action: 'resident' | 'faculty' | null; detail: string;
  stage: string | null; resident_note: string; faculty_message: string; verified_by_name: string | null; verified_at: string | null;
  updated_at: string | null; override: boolean; extra: Record<string, any>;
};
export type ScanCategory = {
  id: string; key: string; label: string; target: number; views_note: string; verified: number; reported: number | null;
  views_confirmed: boolean | null; met: boolean;
};
export type ScanBatch = {
  batch_id: string; created_at: string; reviewed_on: string; is_correction: boolean; source: string; by: string | null; note: string;
  entries: { category: string; delta: number; views_confirmed: boolean | null }[];
};
export type ItarState = {
  status: 'draft' | 'approved'; approved_at: string | null; versions: number;
  changes_since_approval: { area: string; what: string; at: string }[];
};
export type Rotation = {
  itar?: ItarState | null;
  requirements: RotationReq[];
  /** verified_total counts each category only up to its target; reviewed_total is the raw number of faculty-verified scans. */
  scans: { categories: ScanCategory[]; verified_total: number; reviewed_total?: number; target_total: number; reported_total: number | null; history: ScanBatch[] };
};

export const REQ_LABEL: Record<ReqStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  submitted: 'Submitted for review',
  verified: 'Complete',
  clarification_requested: 'Needs clarification',
  not_yet_due: 'Not yet due',
  not_applicable: 'Not applicable',
};
export const REQ_TONE: Record<ReqStatus, 'ok' | 'warn' | 'bad' | 'info' | undefined> = {
  verified: 'ok', submitted: 'info', clarification_requested: 'warn', in_progress: undefined, not_started: undefined,
  not_yet_due: undefined, not_applicable: undefined,
};

const fmt = (d?: string | null) => (d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }) : '');

/** Required requirements that count (not-applicable ones drop out of the denominator). */
export function completion(reqs: Pick<RotationReq, 'required' | 'status'>[]) {
  const counted = reqs.filter((r) => r.required && r.status !== 'not_applicable');
  const done = counted.filter((r) => r.status === 'verified').length;
  const notYetDue = counted.filter((r) => r.status === 'not_yet_due').length;
  return { done, total: counted.length, notYetDue, outstanding: counted.length - done - notYetDue };
}

export function scanPct(c: Pick<ScanCategory, 'verified' | 'target'>) {
  return c.target > 0 ? Math.min(100, (100 * Math.max(0, c.verified)) / c.target) : 100;
}

/** Outstanding items in plain words (for the ITAR draft and the workspace banner). */
export function outstandingRequirements(rot: Rotation): string[] {
  return rot.requirements
    .filter((r) => r.required && !['verified', 'not_applicable'].includes(r.status))
    .map((r) => {
      if (r.status === 'not_yet_due') return `${r.title}: not yet due`;
      if (r.kind === 'scan_log') {
        const short = rot.scans.categories.filter((c) => !c.met)
          .map((c) => (c.verified >= c.target && c.views_note ? `${c.label} (views not yet confirmed)` : `${c.label} ${c.verified}/${c.target}`));
        return `${r.title}: ${rot.scans.verified_total}/${rot.scans.target_total} faculty-verified${short.length ? ` — outstanding: ${short.join(', ')}` : ''}`;
      }
      return `${r.title}: ${REQ_LABEL[r.status].toLowerCase()}${r.detail ? ` (${r.detail})` : ''}`;
    });
}

/** "ROTATION REQUIREMENTS" section of the ITAR draft. */
export function requirementsSection(rot: Rotation): { key: string; title: string; text: string } {
  const c = completion(rot.requirements);
  const lines: string[] = [];
  lines.push(`Mandatory rotation activities complete: ${c.done} of ${c.total}${c.notYetDue ? ` (${c.notYetDue} not yet due)` : ''}.`);
  for (const r of rot.requirements.filter((x) => x.required)) {
    const last = r.kind === 'scan_log' && r.status !== 'verified' ? rot.scans.history[0] : undefined;
    // The EPA detail already names the reviewer and date ("Reviewed in Elentra by … on …").
    const who = r.kind === 'epa' && !r.override && r.detail.startsWith('Reviewed in Elentra by') ? '' : last
      ? [last.by && `by ${last.by}`, fmt(last.created_at)].filter(Boolean).join(', ')
      : ['verified', 'not_yet_due', 'not_applicable'].includes(r.status) || r.override
        ? [r.verified_by_name && `by ${r.verified_by_name}`, r.verified_at && fmt(r.verified_at)].filter(Boolean).join(', ')
        : '';
    let body = REQ_LABEL[r.status];
    if (r.kind === 'scan_log') {
      body += ` — ${rot.scans.verified_total} of ${rot.scans.target_total} required faculty-verified reviewed scans${(rot.scans.reviewed_total ?? 0) > rot.scans.verified_total ? ` (${rot.scans.reviewed_total} reviewed in total)` : ''} (${rot.scans.categories.map((x) => `${x.label} ${x.verified}/${x.target}${x.views_note && x.verified >= x.target && !x.views_confirmed ? ', views not confirmed' : ''}`).join('; ')})`;
    } else if (r.kind === 'attestation' && r.stage) {
      body += ` — ${r.detail}`;
    } else if (r.detail) {
      body += ` — ${r.detail}`;
    }
    lines.push(`• ${r.title}: ${body}${who ? ` (${r.kind === 'scan_log' ? 'last attested ' : r.status === 'verified' ? '' : 'set '}${who})` : ''}.`);
  }
  lines.push('Scan numbers record studies reviewed and accepted by faculty (counted in this portal; images reviewed in QPath or another approved system). They are a completion measure, not an assessment of scanning competence.');
  return { key: 'requirements', title: 'Rotation requirements — completion record', text: lines.join('\n') };
}

/** Actions for the block overview that are NOT already covered by exam/evidence/EPA columns. */
export function requirementActions(reqs: (Pick<RotationReq, 'kind' | 'title' | 'status' | 'action'> & { extra?: Record<string, any>; detail?: string })[]) {
  const faculty: string[] = [];
  const resident: string[] = [];
  for (const r of reqs) {
    // an exam below the rotation pass mark needs a program decision (another attempt), not just resident effort
    if (r.kind === 'exam' && (r as RotationReq).extra?.met === false && r.status === 'in_progress') {
      faculty.push(`Exam below ${Math.round(Number((r as RotationReq).extra?.pass_pct ?? 75))}% — decide on re-attempt`);
      continue;
    }
    if (r.kind === 'epa') {
      const cs = (r as RotationReq).extra?.criteria_status as string | undefined;
      if (r.action === 'resident' && cs) resident.push(`C6 EPAs: criteria ${cs === 'partially_met' ? 'partially met' : 'outstanding'}`);
      else if (r.action === 'faculty' && r.status === 'in_progress' && /re-verify/.test((r as RotationReq).detail ?? '')) faculty.push('Re-verify EPA review');
      continue;
    }
    if (!['scan_log', 'attestation'].includes(r.kind) || !r.action) continue;
    const short = r.kind === 'scan_log' ? 'scan log' : r.title.replace(/^POCUS\s+/i, '').split(/\s+—|\s+\(/)[0];
    if (r.action === 'faculty') faculty.push(r.kind === 'scan_log' ? 'Attest scans' : `Confirm ${short}`);
    else resident.push(r.status === 'clarification_requested' ? `${short}: clarify` : short);
  }
  return { faculty, resident };
}

/** Turn "set verified total to N" into the delta sent to attest_scans. */
export function scanDeltas(cats: ScanCategory[], totals: Record<string, string>, views: Record<string, boolean>) {
  const entries: { category: string; delta: number; views_confirmed?: boolean }[] = [];
  let negative = false;
  for (const c of cats) {
    const raw = totals[c.id];
    const n = raw === undefined || raw === '' ? c.verified : Math.max(0, Math.floor(Number(raw)));
    const delta = Number.isFinite(n) ? n - c.verified : 0;
    const v = views[c.id];
    const viewsChanged = c.views_note && v !== undefined && v !== !!c.views_confirmed;
    if (delta !== 0 || viewsChanged) entries.push({ category: c.id, delta, ...(viewsChanged ? { views_confirmed: v } : {}) });
    if (delta < 0) negative = true;
  }
  return { entries, negative };
}

/**
 * Make the exam requirement reflect the attempt the ITAR uses (the faculty's
 * selection in the workspace, even before it is saved), so the requirements
 * section and the exam section of the draft never disagree.
 */
export function withSelectedAttempt(
  rot: Rotation,
  a: { attempt_no: number; score_pct: number | string | null; grading_status: string; submitted_at: string | null } | null,
  rule: 'latest_submitted' | 'faculty_selected' | 'none',
): Rotation {
  const i = rot.requirements.findIndex((r) => r.kind === 'exam');
  if (i < 0 || !a || rot.requirements[i].override) return rot;
  const r = rot.requirements[i];
  const pass = r.extra?.pass_pct == null ? null : Number(r.extra.pass_pct);
  const score = a.score_pct == null ? null : Number(a.score_pct);
  const sel = rule === 'faculty_selected' ? ', selected by faculty' : '';
  let next: RotationReq;
  if (a.grading_status !== 'complete' || score == null) {
    next = { ...r, status: 'submitted', action: 'faculty', detail: 'Submitted — grading in progress', verified_by_name: null, verified_at: null };
  } else if (pass == null || score >= pass) {
    next = { ...r, status: 'verified', action: null, detail: `Score ${score.toFixed(1)}% (attempt ${a.attempt_no}${sel})${pass == null ? '' : ` — rotation pass mark ${Math.round(pass)}% met`}`,
      verified_by_name: 'the portal (automatic scoring)', verified_at: a.submitted_at, extra: { ...r.extra, score_pct: score, met: true } };
  } else {
    next = { ...r, status: 'in_progress', action: 'resident', detail: `Score ${score.toFixed(1)}% (attempt ${a.attempt_no}${sel}) — below the rotation pass mark of ${Math.round(pass)}%`,
      verified_by_name: null, verified_at: null, extra: { ...r.extra, score_pct: score, met: false } };
  }
  const requirements = [...rot.requirements];
  requirements[i] = next;
  return { ...rot, requirements };
}

/** Rotation pass mark for the exam requirement, if configured. */
export function rotationPassPct(rot: Rotation | null | undefined): number | null {
  const v = rot?.requirements.find((r) => r.kind === 'exam')?.extra?.pass_pct;
  return v == null ? null : Number(v);
}

// ---------------------------------------------------------------------------
// Resident view: what to do next, and what is waiting on faculty
// ---------------------------------------------------------------------------
export type NextStep = { key: string; label: string; detail?: string; to?: string; cta?: string; tone?: 'warn' | 'info' };

export function residentNextSteps(rot: Rotation, openExam = false): { todo: NextStep[]; waiting: NextStep[] } {
  const todo: NextStep[] = [];
  const waiting: NextStep[] = [];
  for (const r of rot.requirements.filter((x) => x.required)) {
    if (['verified', 'not_applicable', 'not_yet_due'].includes(r.status)) continue;
    const anchor = `/requirements#req-${r.key}`;
    if (r.kind === 'learning_cases') {
      const e = r.extra ?? {};
      if (e.returned > 0) todo.push({ key: `${r.key}-returned`, label: `Re-upload ${e.returned} learning case${e.returned === 1 ? '' : 's'} returned by faculty`, to: '/evidence', cta: 'Open evidence', tone: 'warn' });
      if (e.missing > 0) todo.push({ key: `${r.key}-missing`, label: `Upload Brightspace completion for ${e.missing} learning case${e.missing === 1 ? '' : 's'}`, to: '/evidence', cta: 'Upload' });
      if (e.awaiting > 0) waiting.push({ key: `${r.key}-awaiting`, label: `${e.awaiting} learning-case upload${e.awaiting === 1 ? '' : 's'} awaiting faculty review` });
    } else if (r.kind === 'scan_log') {
      const s = rot.scans;
      todo.push({ key: r.key, label: `Report your scan counts — ${s.verified_total}/${s.target_total} verified so far`, to: '/requirements?report=scans#scans', cta: 'Report scans' });
      if (s.categories.some((c) => (c.reported ?? 0) > c.verified)) waiting.push({ key: `${r.key}-review`, label: 'Reported scans awaiting faculty verification' });
    } else if (r.kind === 'attestation') {
      if (r.status === 'clarification_requested') todo.push({ key: r.key, label: `${r.title}: faculty asked for clarification`, detail: r.faculty_message, to: anchor, cta: 'Respond', tone: 'warn' });
      else if (r.status === 'submitted') waiting.push({ key: r.key, label: `${r.title} — awaiting faculty confirmation` });
      else if (r.resident_submits) {
        const plan = r.stages.some((x) => x.by === 'resident') && !r.stage;
        todo.push({ key: r.key, label: plan ? `Plan your ${r.title.replace(/^POCUS /, 'POCUS ')} (topic and date)` : `Submit ${r.title} for faculty confirmation`, to: anchor, cta: plan ? 'Plan' : 'Submit' });
      } else waiting.push({ key: r.key, label: `${r.title} — recorded by faculty` });
    } else if (r.kind === 'exam') {
      if (r.extra?.met === false) waiting.push({ key: r.key, label: `${r.detail}. Faculty will contact you about a re-attempt.`, tone: 'warn' });
      else if (r.status === 'submitted') waiting.push({ key: r.key, label: `Written examination: ${r.detail.toLowerCase()}` });
      else todo.push({ key: r.key, label: openExam || r.status === 'in_progress' ? 'Complete the written POCUS examination' : 'Written POCUS examination — not yet open', to: '/exams', cta: 'Examinations' });
    } else if (r.kind === 'epa') {
      const cs = r.extra?.criteria_status;
      if (cs === 'partially_met' || cs === 'outstanding') todo.push({ key: r.key, label: `C6 EPAs: criteria ${cs === 'partially_met' ? 'partially met' : 'outstanding'} — continue requesting EPA assessments in Elentra`, to: anchor, cta: 'Details' });
      else waiting.push({ key: r.key, label: 'C6 EPA review by faculty (from your Elentra assessments)' });
    }
  }
  return { todo, waiting };
}
