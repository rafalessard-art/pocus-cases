/**
 * Deterministic end-of-block evaluation draft.
 *
 * Inputs are ONLY (a) verified exam data from the database and (b) text that a
 * faculty member typed. The generator never infers clinical performance,
 * scanning/technical skill, procedural competence or professional behaviour
 * from a written exam score; it says so explicitly in the output.
 *
 * A future AI-assisted drafter must keep the same contract: same inputs, and
 * its output is a draft that a faculty member edits and approves.
 */

export type DomainResult = { key: string; label: string; pct: number | null; n_items?: number };
export type ExamFacts = {
  examTitle: string;
  version: number;
  submittedAt: string | null;
  attemptNo: number;
  scorePct: number | null;
  scorePoints: number | null;
  maxPoints: number | null;
  passThresholdPct: number | null;
  passed: boolean | null;
  gradingStatus: string;
  domains: DomainResult[];
};
export type EvalInput = {
  learnerName: string;
  trainingLevel?: string | null;
  rotation?: string | null;
  rotationStart?: string | null;
  rotationEnd?: string | null;
  exam: ExamFacts | null;
  strengths: string;
  areasForImprovement: string;
  observations: string;
};

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' }) : '');

/** Domain lists derived from exam data; offered to faculty as editable suggestions. */
export function domainHighlights(domains: DomainResult[], strong = 80, weak = 60) {
  const scored = domains.filter((d) => d.pct !== null && d.key !== 'unassigned');
  return {
    strong: scored.filter((d) => (d.pct as number) >= strong).sort((a, b) => (b.pct as number) - (a.pct as number)),
    weak: scored.filter((d) => (d.pct as number) < weak).sort((a, b) => (a.pct as number) - (b.pct as number)),
  };
}

export function draftSummary(i: EvalInput): string {
  const out: string[] = [];
  const who = `${i.learnerName}${i.trainingLevel ? ` (${i.trainingLevel})` : ''}`;
  const when = i.rotationStart || i.rotationEnd ? ` from ${fmt(i.rotationStart) || '—'} to ${fmt(i.rotationEnd) || '—'}` : '';
  out.push(`${who} completed the ${i.rotation || 'POCUS'} rotation${when}.`);

  if (!i.exam) {
    out.push('No submitted end-of-block examination is on record for this rotation.');
  } else {
    const e = i.exam;
    if (e.gradingStatus !== 'complete' || e.scorePct === null) {
      out.push(`The end-of-block written examination (${e.examTitle}, v${e.version}) was submitted${e.submittedAt ? ` on ${fmt(e.submittedAt)}` : ''}; grading is not yet complete.`);
    } else {
      const pass =
        e.passed === null || e.passThresholdPct === null
          ? ''
          : e.passed
            ? `, meeting the pass threshold of ${Number(e.passThresholdPct)}%`
            : `, below the pass threshold of ${Number(e.passThresholdPct)}%`;
      out.push(
        `On the end-of-block written examination (${e.examTitle}, v${e.version}${e.attemptNo > 1 ? `, attempt ${e.attemptNo}` : ''}), submitted ${fmt(e.submittedAt)}, the score was ${Number(e.scorePct).toFixed(1)}% (${Number(e.scorePoints)}/${Number(e.maxPoints)} points)${pass}.`,
      );
      const { strong, weak } = domainHighlights(e.domains);
      if (strong.length) out.push(`Examination performance was strongest in ${list(strong)}.`);
      if (weak.length) out.push(`Examination results suggest review of ${list(weak)}.`);
    }
    out.push('Written examination results reflect knowledge assessment only and do not assess image acquisition, bedside scanning or procedural skill.');
  }

  if (i.strengths.trim()) out.push(`Strengths noted by faculty: ${sentence(i.strengths)}`);
  if (i.areasForImprovement.trim()) out.push(`Areas for improvement noted by faculty: ${sentence(i.areasForImprovement)}`);
  if (i.observations.trim()) out.push(`Faculty observations: ${sentence(i.observations)}`);
  if (!i.strengths.trim() && !i.areasForImprovement.trim() && !i.observations.trim()) {
    out.push('[Faculty to add direct observations of clinical scanning, interpretation and professional conduct before approval.]');
  }
  return out.join('\n\n');
}

function list(ds: DomainResult[]) {
  const parts = ds.map((d) => `${d.label} (${Math.round(d.pct as number)}%)`);
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function sentence(s: string) {
  const t = s.trim().replace(/\s+\n/g, '\n');
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
