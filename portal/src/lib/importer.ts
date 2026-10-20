/**
 * Exam import: CSV or JSON question content + media references → validated
 * question payloads for save_question().
 *
 * Nothing is invented: missing or ambiguous content is reported, and any row
 * with a problem the importer cannot resolve is imported (if at all) with
 * needs_review = true so that publishing is blocked until faculty verify it.
 */
import { parseCSVObjects } from './csv';

export type MediaLookup = { versionId: string; mediaKey: string; filename: string; authorized: boolean; deidentified: boolean; kind: string };
export type Issue = { level: 'error' | 'warning'; message: string };
export type ImportRow = {
  row: number;
  question_key: string;
  section: string;
  payload: {
    type: 'single' | 'multiple' | 'short_answer';
    stem: string;
    options: { id: string; text: string }[];
    key: Record<string, unknown>;
    points: number;
    scoring: { mode: string };
    explanation: string;
    domain_key: string | null;
    objective_codes: string[];
    media: { media_version_id: string; caption: string }[];
    needs_review: boolean;
    review_note: string;
    source: string;
    question_key: string;
  };
  issues: Issue[];
  duplicateOf?: number;
};

const LETTERS = 'abcdefghijklmnop';
const TYPES: Record<string, ImportRow['payload']['type']> = {
  single: 'single', sba: 'single', 'single best answer': 'single', mcq: 'single',
  multiple: 'multiple', 'multiple select': 'multiple', 'multi': 'multiple', msq: 'multiple',
  short: 'short_answer', short_answer: 'short_answer', 'short answer': 'short_answer',
};

export const CSV_TEMPLATE_COLUMNS = [
  'question_key', 'section', 'type', 'stem', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e',
  'correct', 'points', 'scoring', 'explanation', 'domain', 'objectives', 'media', 'media_captions', 'source', 'needs_review',
];

const split = (s?: string) => (s ?? '').split(/[;|]/).map((x) => x.trim()).filter(Boolean);

/** Normalise a JSON or CSV source into flat records. */
export function readSource(text: string, filename: string): Record<string, any>[] {
  if (/\.json$/i.test(filename) || /^\s*[[{]/.test(text)) {
    const j = JSON.parse(text);
    const qs = Array.isArray(j) ? j : j.questions;
    if (!Array.isArray(qs)) throw new Error('JSON must be an array of questions or { "questions": [...] }');
    return qs;
  }
  return parseCSVObjects(text);
}

export function buildRows(records: Record<string, any>[], media: MediaLookup[], domainKeys: string[], objectiveCodes: string[]): ImportRow[] {
  const byKey = new Map<string, MediaLookup>();
  for (const m of media) {
    byKey.set(m.mediaKey.toLowerCase(), m);
    byKey.set(m.filename.toLowerCase(), m);
    byKey.set(m.filename.toLowerCase().replace(/\.[^.]+$/, ''), m);
  }
  const rows: ImportRow[] = records.map((r, i) => {
    const issues: Issue[] = [];
    const rowNo = i + 2; // header is row 1 in CSV
    const typeRaw = String(r.type ?? '').trim().toLowerCase();
    const type = TYPES[typeRaw];
    if (!type) issues.push({ level: 'error', message: `Unknown question type "${r.type ?? ''}"` });

    // options: option_a..option_p columns, or an "options" array in JSON
    let options: { id: string; text: string }[] = [];
    if (Array.isArray(r.options)) {
      options = r.options.map((o: any, k: number) => (typeof o === 'string' ? { id: LETTERS[k], text: o } : { id: String(o.id ?? LETTERS[k]).toLowerCase(), text: String(o.text ?? '') }));
    } else {
      for (let k = 0; k < LETTERS.length; k++) {
        const v = r[`option_${LETTERS[k]}`];
        if (v !== undefined && String(v).trim() !== '') options.push({ id: LETTERS[k], text: String(v).trim() });
      }
    }
    const stem = String(r.stem ?? r.question ?? '').trim();
    if (!stem) issues.push({ level: 'error', message: 'Missing question stem' });

    const correctRaw: string[] = Array.isArray(r.correct) ? r.correct.map(String) : split(String(r.correct ?? '').replace(/,/g, ';'));
    const correct = correctRaw.map((c) => c.trim().toLowerCase()).map((c) => (/^\d+$/.test(c) ? LETTERS[Number(c) - 1] : c));
    const key: Record<string, unknown> = {};
    let needsReview = /^(y|yes|true|1)$/i.test(String(r.needs_review ?? ''));
    const notes: string[] = [];

    if (type === 'single' || type === 'multiple') {
      if (options.length < 2) issues.push({ level: 'error', message: 'Needs at least two answer options' });
      if (!correct.length) {
        issues.push({ level: 'error', message: 'No correct answer given — will be imported for faculty review' });
        needsReview = true;
        notes.push('correct answer missing in source');
      } else {
        const unknown = correct.filter((c) => !options.some((o) => o.id === c));
        if (unknown.length) {
          issues.push({ level: 'error', message: `Unrecognized correct answer "${unknown.join(', ').toUpperCase()}"` });
          needsReview = true;
          notes.push('correct answer did not match an option');
        }
        if (type === 'single' && correct.length > 1) {
          issues.push({ level: 'error', message: 'Single-best-answer question lists more than one correct option' });
          needsReview = true;
          notes.push('multiple correct answers on single-best question');
        }
      }
      key.correct = correct.filter((c) => options.some((o) => o.id === c));
    } else if (type === 'short_answer') {
      key.model_answer = String(r.model_answer ?? r.correct ?? '').trim();
      if (!key.model_answer) issues.push({ level: 'warning', message: 'No model answer for graders' });
    }

    const points = r.points === undefined || String(r.points).trim() === '' ? 1 : Number(r.points);
    if (!Number.isFinite(points) || points < 0) issues.push({ level: 'error', message: `Invalid points "${r.points}"` });

    const domain = String(r.domain ?? r.domain_key ?? '').trim().toLowerCase() || null;
    if (domain && !domainKeys.includes(domain)) issues.push({ level: 'warning', message: `Unknown domain "${domain}" (known: ${domainKeys.join(', ')})` });
    if (!domain) issues.push({ level: 'warning', message: 'No curriculum domain' });

    const objectives = (Array.isArray(r.objectives) ? r.objectives.map(String) : split(r.objectives)).map((o: string) => o.toUpperCase());
    const unknownObj = objectives.filter((o: string) => !objectiveCodes.includes(o));
    if (unknownObj.length) issues.push({ level: 'warning', message: `Unknown objective code(s): ${unknownObj.join(', ')}` });

    const mediaRefs: string[] = Array.isArray(r.media) ? r.media.map(String) : split(r.media);
    const captions: string[] = Array.isArray(r.media_captions) ? r.media_captions.map(String) : split(r.media_captions);
    const mediaOut: { media_version_id: string; caption: string }[] = [];
    mediaRefs.forEach((ref, k) => {
      const m = byKey.get(ref.toLowerCase()) ?? byKey.get(ref.toLowerCase().replace(/\.[^.]+$/, ''));
      if (!m) {
        issues.push({ level: 'error', message: `Missing clip "${ref}" — upload it to the media library first` });
        return;
      }
      if (!m.authorized || !m.deidentified) issues.push({ level: 'warning', message: `Clip "${ref}" is not yet authorized/de-identified (publishing will be blocked)` });
      mediaOut.push({ media_version_id: m.versionId, caption: captions[k] ?? '' });
    });

    const reviewNote = [String(r.review_note ?? '').trim(), ...notes].filter(Boolean).join('; ');
    return {
      row: rowNo,
      question_key: String(r.question_key ?? r.id ?? '').trim(),
      section: String(r.section ?? '').trim(),
      issues,
      payload: {
        type: type ?? 'single',
        stem,
        options,
        key,
        points: Number.isFinite(points) ? points : 1,
        scoring: { mode: /partial/i.test(String(r.scoring ?? '')) ? 'partial' : 'all_or_nothing' },
        explanation: String(r.explanation ?? '').trim(),
        domain_key: domain && domainKeys.includes(domain) ? domain : null,
        objective_codes: objectives.filter((o: string) => objectiveCodes.includes(o)),
        media: mediaOut,
        needs_review: needsReview,
        review_note: reviewNote,
        source: String(r.source ?? 'Import').trim(),
        question_key: String(r.question_key ?? r.id ?? '').trim(),
      },
    };
  });

  // duplicates: same stem + same options
  const seen = new Map<string, number>();
  for (const r of rows) {
    const sig = `${r.payload.stem.toLowerCase().replace(/\s+/g, ' ')}|${r.payload.options.map((o) => o.text.toLowerCase()).join('|')}`;
    if (seen.has(sig)) {
      r.duplicateOf = seen.get(sig);
      r.issues.push({ level: 'warning', message: `Duplicate of row ${seen.get(sig)}` });
    } else seen.set(sig, r.row);
    if (r.question_key) {
      const dupKey = rows.find((o) => o !== r && o.question_key === r.question_key && o.row < r.row);
      if (dupKey) r.issues.push({ level: 'error', message: `Question key "${r.question_key}" repeats row ${dupKey.row}` });
    }
  }
  return rows;
}

/** Rows that can be imported (no blocking error other than ones converted into needs_review). */
export function importable(r: ImportRow) {
  return !r.issues.some(
    (i) => i.level === 'error' && !/correct answer|faculty review|more than one correct/i.test(i.message),
  );
}
