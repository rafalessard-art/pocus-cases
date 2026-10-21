import { describe, expect, it } from 'vitest';
import type { OverviewRow } from './itar';
import { openRequirements, residentTasks, type RotRow } from './overview';

const row = (o: Partial<OverviewRow> = {}): OverviewRow => ({
  id: 'x', name: 'Fictional Resident', training_level: null,
  exam: { assigned: true, n_attempts: 1, in_progress: false, latest: { id: 'a', score_pct: 0, passed: false, grading_status: 'complete', submitted_at: '2026-10-20' } },
  evidence: { required: 4, submitted: 4, verified: 3, awaiting_review: 1, clarification: 0, rejected: 0 },
  epa_status: 'complete', n_observations: 0, itar: null, ...o,
});
const req = (key: string, kind: RotRow['requirements'][number]['kind'], status: RotRow['requirements'][number]['status'], o: Partial<RotRow['requirements'][number]> = {}) =>
  ({ key, kind, title: key, required: true, status, action: null, detail: '', extra: {}, ...o });
const rot = (o: Partial<RotRow> = {}): RotRow => ({
  learner_id: 'x', scans: { verified_total: 84, target_total: 102 }, itar: null,
  requirements: [
    req('C6 POCUS EPAs', 'epa', 'in_progress', { action: 'resident', extra: { criteria_status: 'partially_met' } }),
    req('Brightspace learning cases', 'learning_cases', 'submitted', { action: 'faculty' }),
    req('Logbook of reviewed POCUS scans', 'scan_log', 'submitted', { action: 'faculty' }),
    req('Written POCUS examination', 'exam', 'in_progress', { action: 'resident', extra: { met: false, pass_pct: 75 } }),
    req('POCUS rounds presentation', 'attestation', 'submitted', { action: 'faculty' }),
    req('TeachingMedicine online skills modules', 'attestation', 'verified'),
  ],
  ...o,
});

describe('resident tasks (faculty dashboard and block overview)', () => {
  it('lists real faculty work with the workspace section to open, without duplicates', () => {
    const t = residentTasks(row(), rot());
    expect(t.faculty).toEqual([
      { label: 'Review evidence (1)', anchor: '#cases' },
      { label: 'Attest scans', anchor: '#scans' },
      { label: 'Exam below 75% — decide on re-attempt', anchor: '#exam' },
      { label: 'Confirm rounds presentation', anchor: '#requirements' },
      { label: 'Prepare ITER draft', anchor: '#itar' },
    ]);
    expect(t.resident).toEqual(['C6 EPAs: criteria partially met']);
    expect(t.done).toBe(false);
    expect(openRequirements(rot())).toEqual(['C6 POCUS EPAs', 'Brightspace learning cases', 'Scan logbook', 'Written POCUS examination', 'POCUS rounds presentation']);
  });

  it('EPA appears once: a re-verification replaces the generic "EPA review" task', () => {
    const t = residentTasks(row({ epa_status: 'pending' }), rot({ requirements: [req('C6', 'epa', 'in_progress', { action: 'faculty', detail: 'Recorded before criteria verification — please re-verify' })] }));
    expect(t.faculty.map((f) => f.label)).toEqual(['Review evidence (1)', 'Re-verify EPA review', 'Prepare ITER draft']);
  });

  it('an approved draft with nothing open needs no action; new evidence after approval does', () => {
    const approved = { id: 'e', status: 'approved' as const, updated_at: '', approved_at: '', has_text: true };
    const clean = rot({ requirements: [req('Exam', 'exam', 'verified')] });
    const ok = residentTasks(row({ itar: approved, evidence: { required: 4, submitted: 4, verified: 4, awaiting_review: 0, clarification: 0, rejected: 0 } }), clean);
    expect(ok).toMatchObject({ faculty: [], resident: [], done: true });
    const changed = residentTasks(row({ itar: approved }), { ...clean, itar: { status: 'approved', approved_at: '', versions: 1, changes_since_approval: [{ area: 'Learning cases', what: 'Evidence uploaded', at: '' }] } });
    expect(changed.faculty.map((f) => f.label)).toEqual(['Review new evidence (draft approved earlier)']);
    expect(changed.done).toBe(false);
  });
});
