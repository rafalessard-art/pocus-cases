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
export type Rotation = {
  requirements: RotationReq[];
  scans: { categories: ScanCategory[]; verified_total: number; target_total: number; reported_total: number | null; history: ScanBatch[] };
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
    const who = last
      ? [last.by && `by ${last.by}`, fmt(last.created_at)].filter(Boolean).join(', ')
      : ['verified', 'not_yet_due', 'not_applicable'].includes(r.status) || r.override
        ? [r.verified_by_name && `by ${r.verified_by_name}`, r.verified_at && fmt(r.verified_at)].filter(Boolean).join(', ')
        : '';
    let body = REQ_LABEL[r.status];
    if (r.kind === 'scan_log') {
      body += ` — ${rot.scans.verified_total} of ${rot.scans.target_total} faculty-verified reviewed scans (${rot.scans.categories.map((x) => `${x.label} ${x.verified}/${x.target}${x.views_note && x.verified >= x.target && !x.views_confirmed ? ', views not confirmed' : ''}`).join('; ')})`;
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
export function requirementActions(reqs: Pick<RotationReq, 'kind' | 'title' | 'status' | 'action'>[]) {
  const faculty: string[] = [];
  const resident: string[] = [];
  for (const r of reqs) {
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
