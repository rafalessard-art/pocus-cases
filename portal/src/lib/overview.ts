/**
 * What needs doing for each resident of a block, split into faculty and
 * resident tasks. Shared by the block overview and the faculty dashboard so
 * both show the same, de-duplicated list. Pure; unit-tested in overview.test.ts.
 */
import { attention, type OverviewRow } from './itar';
import { completion, requirementActions, type ItarState, type RotationReq } from './requirements';

export type RotRow = {
  learner_id: string;
  requirements: Pick<RotationReq, 'key' | 'kind' | 'title' | 'required' | 'status' | 'action' | 'detail' | 'extra'>[];
  scans: { verified_total: number; target_total: number };
  itar: ItarState | null;
};
/** A faculty task, with the workspace section it opens. */
export type Task = { label: string; anchor: string };

const ANCHOR: [RegExp, string][] = [
  [/^Grade exam|^Exam below/, '#exam'],
  [/^Review evidence/, '#cases'],
  [/EPA/, '#epa'],
  [/^Attest scans/, '#scans'],
  [/^Confirm /, '#requirements'],
  [/ITER|new evidence/i, '#itar'],
];
const anchorFor = (label: string) => ANCHOR.find(([re]) => re.test(label))?.[1] ?? '';

export function residentTasks(r: OverviewRow, x?: RotRow | null) {
  const a = attention(r);
  const faculty: string[] = a.done ? [] : a.faculty.filter((t) => !/ITAR$/.test(t));
  const resident = [...a.resident];
  let done = a.done;
  if (x) {
    const extra = requirementActions(x.requirements);
    if ((x.itar?.changes_since_approval.length ?? 0) > 0) extra.faculty.push('Review new evidence (draft approved earlier)');
    if (extra.faculty.some((t) => /EPA/.test(t))) {
      const i = faculty.indexOf('EPA review');
      if (i >= 0) faculty.splice(i, 1);
    }
    faculty.push(...extra.faculty);
    resident.push(...extra.resident);
    if (done && (extra.faculty.length || extra.resident.length)) done = false; // an approved draft never hides open work
  }
  if (r.itar?.status !== 'approved') faculty.push(r.itar?.has_text ? 'Approve ITER draft' : 'Prepare ITER draft');
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  return {
    faculty: uniq(faculty).map((label): Task => ({ label, anchor: anchorFor(label) })),
    resident: uniq(resident),
    done: done && !faculty.length,
    completion: x ? completion(x.requirements) : null,
  };
}

/** Requirement titles still open for a resident (for the expandable detail). */
export function openRequirements(x?: RotRow | null) {
  return (x?.requirements ?? [])
    .filter((q) => q.required && !['verified', 'not_applicable', 'not_yet_due'].includes(q.status))
    .map((q) => (q.kind === 'scan_log' ? 'Scan logbook' : q.title));
}
