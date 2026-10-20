import { describe, expect, it } from 'vitest';
import { parseCSV, parseCSVObjects, toCSV } from './csv';
import { buildRows, importable, readSource, type MediaLookup } from './importer';
import { draftSummary, type EvalInput } from './summary';

describe('csv', () => {
  it('parses quotes, escaped quotes, commas and newlines inside fields', () => {
    const rows = parseCSV('a,b,c\r\n"x, y","he said ""hi""","multi\nline"\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['x, y', 'he said "hi"', 'multi\nline']]);
  });
  it('round-trips and neutralises formula injection', () => {
    const csv = toCSV([{ name: '=HYPERLINK("x")', score: 81.5 }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const [obj] = parseCSVObjects(csv);
    expect(obj.score).toBe('81.5');
  });
});

const media: MediaLookup[] = [
  { versionId: 'v1', mediaKey: 'LUNG-001', filename: 'lung_bline.mp4', authorized: true, deidentified: true, kind: 'video' },
  { versionId: 'v2', mediaKey: 'CARD-002', filename: 'a4c.mp4', authorized: false, deidentified: false, kind: 'video' },
];

describe('importer', () => {
  const csv = [
    'question_key,section,type,stem,option_a,option_b,option_c,correct,points,domain,objectives,media',
    'Q1,Lung,single,What artefact is shown?,A-lines,B-lines,Lung point,B,1,lung,LUNG-1,LUNG-001',
    'Q2,Cardiac,multiple,Select all,X,Y,Z,A;C,2,cardiac,CARD-9,a4c.mp4',
    'Q3,,single,No key here,One,Two,,,1,lung,,',
    'Q4,,single,Bad key,One,Two,,E,1,,,missing.mp4',
    'Q5,Lung,single,What artefact is shown?,A-lines,B-lines,Lung point,B,1,lung,,',
    'Q6,,essay,Unknown type,,,,,,,,',
  ].join('\n');
  const rows = buildRows(readSource(csv, 'x.csv'), media, ['lung', 'cardiac'], ['LUNG-1', 'CARD-1']);

  it('maps a clean row to a question payload with media and objectives', () => {
    const r = rows[0];
    expect(r.issues).toEqual([]);
    expect(r.payload.key).toEqual({ correct: ['b'] });
    expect(r.payload.media).toEqual([{ media_version_id: 'v1', caption: '' }]);
    expect(r.payload.objective_codes).toEqual(['LUNG-1']);
  });
  it('matches media by filename and warns about unauthorized clips and unknown objectives', () => {
    const msgs = rows[1].issues.map((i) => i.message).join(' | ');
    expect(rows[1].payload.media[0].media_version_id).toBe('v2');
    expect(msgs).toMatch(/not yet authorized/);
    expect(msgs).toMatch(/Unknown objective/);
    expect(rows[1].payload.key).toEqual({ correct: ['a', 'c'] });
  });
  it('never invents a missing answer: flags the question for faculty review', () => {
    expect(rows[2].payload.needs_review).toBe(true);
    expect(rows[2].payload.key).toEqual({ correct: [] });
    expect(importable(rows[2])).toBe(true);
  });
  it('reports unrecognised answers and missing clips', () => {
    const msgs = rows[3].issues.map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/Unrecognized correct answer "E"/);
    expect(msgs).toMatch(/Missing clip "missing.mp4"/);
    expect(importable(rows[3])).toBe(false);
  });
  it('detects duplicates and unknown types', () => {
    expect(rows[4].duplicateOf).toBe(2);
    expect(rows[5].issues[0].message).toMatch(/Unknown question type/);
  });
  it('accepts JSON input', () => {
    const j = JSON.stringify({ questions: [{ type: 'single', stem: 'S', options: ['a', 'b'], correct: ['2'], domain: 'lung' }] });
    const [r] = buildRows(readSource(j, 'q.json'), media, ['lung'], []);
    expect(r.payload.key).toEqual({ correct: ['b'] });
  });
});

describe('evaluation draft', () => {
  const base: EvalInput = {
    learnerName: 'Dr. Test Resident', trainingLevel: 'PGY-3', rotation: 'POCUS', rotationStart: '2026-09-01', rotationEnd: '2026-09-28',
    exam: {
      examTitle: 'POCUS End-of-Block', version: 2, submittedAt: '2026-09-27T15:00:00Z', attemptNo: 1, scorePct: 82.5, scorePoints: 33, maxPoints: 40,
      passThresholdPct: 70, passed: true, gradingStatus: 'complete',
      domains: [
        { key: 'cardiac', label: 'Cardiac', pct: 95 },
        { key: 'lung', label: 'Lung', pct: 50 },
        { key: 'gastric', label: 'Gastric', pct: 75 },
      ],
    },
    strengths: '', areasForImprovement: '', observations: '',
  };
  it('summarises only verified exam data, with an explicit scope disclaimer', () => {
    const s = draftSummary(base);
    expect(s).toContain('82.5%');
    expect(s).toContain('meeting the pass threshold of 70%');
    expect(s).toContain('strongest in Cardiac (95%)');
    expect(s).toContain('review of Lung (50%)');
    expect(s).toMatch(/do not assess image acquisition, bedside scanning or procedural skill/);
    expect(s).toMatch(/\[Faculty to add direct observations/);
    // no invented behavioural or clinical claims
    expect(s).not.toMatch(/professional(ism)? (was|is)|excellent|competent|skilled|confident/i);
  });
  it('includes faculty-entered text verbatim and omits the placeholder', () => {
    const s = draftSummary({ ...base, strengths: 'Efficient focused cardiac exams', observations: 'Observed 12 gastric scans' });
    expect(s).toContain('Strengths noted by faculty: Efficient focused cardiac exams.');
    expect(s).toContain('Faculty observations: Observed 12 gastric scans.');
    expect(s).not.toContain('[Faculty to add');
  });
  it('handles missing or ungraded exams', () => {
    expect(draftSummary({ ...base, exam: null })).toMatch(/No submitted end-of-block examination/);
    expect(draftSummary({ ...base, exam: { ...base.exam!, gradingStatus: 'pending_manual', scorePct: null } })).toMatch(/grading is not yet complete/);
  });
});
