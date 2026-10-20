import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, ErrorNote, Spinner, useLoad } from '../../components/ui';
import { download, toCSV } from '../../lib/csv';
import { domains as loadDomains, mediaLibrary, objectives as loadObjectives, pocusCourse } from '../../lib/content';
import { CSV_TEMPLATE_COLUMNS, buildRows, importable, readSource, type ImportRow, type MediaLookup } from '../../lib/importer';
import { rpc } from '../../lib/supabase';

const EXAMPLE = [
  {
    question_key: 'DEMO-LUNG-001', section: 'Lung', type: 'single', stem: '[Example] Which artefact is shown in this clip?',
    option_a: 'A-lines', option_b: 'B-lines', option_c: 'Lung point', option_d: 'Seashore sign', option_e: '',
    correct: 'B', points: 1, scoring: '', explanation: 'Explanation shown after release.', domain: 'lung', objectives: 'LUNG-1',
    media: 'LUNG-001', media_captions: 'Clip 1', source: 'ExamBuilder export, Q3', needs_review: 'no',
  },
];

export function ImportExam() {
  const nav = useNavigate();
  const course = useLoad(pocusCourse, []);
  const ctx = useLoad(async () => {
    if (!course.data) return null;
    const [lib, doms, objs] = await Promise.all([mediaLibrary(), loadDomains(course.data.id), loadObjectives(course.data.id)]);
    const media: MediaLookup[] = lib
      .filter((a) => a.current?.upload_status === 'uploaded')
      .map((a) => ({ versionId: a.current!.id, mediaKey: a.media_key, filename: a.current!.original_filename, authorized: a.authorization_status === 'authorized', deidentified: a.deidentified, kind: a.kind }));
    return { media, domainKeys: doms.map((d) => d.key), objectiveCodes: objs.map((o) => o.code) };
  }, [course.data?.id]);
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fname, setFname] = useState('');
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<unknown>();
  const [progress, setProgress] = useState<string | null>(null);

  async function onFile(file: File) {
    setErr(undefined);
    setRows(null);
    try {
      const text = await file.text();
      const recs = readSource(text, file.name);
      if (!ctx.data) throw new Error('Still loading the media library — try again in a moment.');
      setRows(buildRows(recs, ctx.data.media, ctx.data.domainKeys, ctx.data.objectiveCodes));
      setFname(file.name);
      if (!title) setTitle(`Imported exam (${file.name})`);
    } catch (e) {
      setErr(e);
    }
  }

  async function runImport() {
    if (!rows || !course.data) return;
    setErr(undefined);
    const ok = rows.filter(importable).filter((r) => !r.duplicateOf);
    try {
      setProgress('Creating draft exam…');
      const ex = await rpc<any>('create_exam', { p_course_id: course.data.id, p_title: title, p_description: `Imported from ${fname}` });
      const items: { question_version_id: string; section: string }[] = [];
      for (let i = 0; i < ok.length; i++) {
        setProgress(`Importing question ${i + 1} of ${ok.length}…`);
        const r = ok[i];
        const res = await rpc<any>('save_question', { p_question_id: null, p: { ...r.payload, course_id: course.data.id, question_key: r.payload.question_key || null } });
        items.push({ question_version_id: res.question_version_id, section: r.section });
      }
      setProgress('Adding questions to the draft…');
      await rpc('set_exam_items', { p_exam_version_id: ex.exam_version_id, p_items: items });
      nav(`/admin/exams/${ex.exam_id}`);
    } catch (e) {
      setErr(e);
      setProgress(null);
    }
  }

  const counts = rows
    ? {
        total: rows.length,
        clean: rows.filter((r) => !r.issues.length).length,
        review: rows.filter((r) => importable(r) && r.payload.needs_review).length,
        blocked: rows.filter((r) => !importable(r)).length,
        dup: rows.filter((r) => r.duplicateOf).length,
      }
    : null;

  return (
    <Page kicker="Administration" title="Import an examination" subtitle="Structured CSV or JSON + clips already in the media library"
      actions={<Link className="btn secondary" to="/admin/questions">← Question bank</Link>}>
      <div className="grid two">
        <div className="card flat stack">
          <h3>1 · Upload the clips</h3>
          <p className="small">Bulk-upload every clip to the <Link to="/admin/media">media library</Link> first. The <span className="mono">media</span> column refers
            to clips by media key or by original filename (e.g. <span className="mono">LUNG-001</span> or <span className="mono">lung_bline.mp4</span>); separate multiple clips with <span className="mono">;</span>.</p>
          <h3>2 · Prepare the question file</h3>
          <p className="small">One row per question. <span className="mono">correct</span> uses option letters (<span className="mono">B</span>, or <span className="mono">A;C</span> for multiple-select).
            Types: <span className="mono">single</span>, <span className="mono">multiple</span>, <span className="mono">short_answer</span>.</p>
          <div className="row">
            <button className="btn secondary small" onClick={() => download('exam-import-template.csv', toCSV(EXAMPLE, CSV_TEMPLATE_COLUMNS))}>Download CSV template</button>
            <button className="btn secondary small" onClick={() => download('exam-import-example.json', JSON.stringify({ questions: EXAMPLE }, null, 2), 'application/json')}>JSON example</button>
          </div>
          <p className="small muted">Missing or ambiguous answers are never guessed: those questions are imported flagged for faculty review, which blocks publishing until fixed.</p>
        </div>
        <div className="card flat stack">
          <h3>3 · Validate</h3>
          {ctx.loading ? <Spinner label="Loading media library…" /> : (
            <label className="btn">
              Choose CSV or JSON file
              <input type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} data-testid="import-file" />
            </label>
          )}
          {counts && (
            <div className="stats">
              <div className="stat"><b>{counts.total}</b><span>rows</span></div>
              <div className="stat"><b>{counts.clean}</b><span>clean</span></div>
              <div className="stat"><b>{counts.review}</b><span>need review</span></div>
              <div className="stat"><b>{counts.blocked}</b><span>blocked</span></div>
              <div className="stat"><b>{counts.dup}</b><span>duplicates</span></div>
            </div>
          )}
          {rows && (
            <>
              <label className="field">Draft exam title<input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              <button className="btn" disabled={!!progress || !title || !rows.some((r) => importable(r) && !r.duplicateOf)} onClick={runImport} data-testid="run-import">
                Import {rows.filter((r) => importable(r) && !r.duplicateOf).length} question(s) as a draft exam
              </button>
              <p className="small muted">Blocked rows and duplicates are skipped. Nothing is published; you review the draft before publishing.</p>
            </>
          )}
          {progress && <div className="notice small" role="status">{progress}</div>}
          <ErrorNote error={err} />
        </div>
      </div>
      {rows && (
        <>
          <p className="seclabel">Validation — {fname}</p>
          <div className="tablewrap">
            <table className="data">
              <thead><tr><th>Row</th><th>Key</th><th>Question</th><th>Type</th><th>Answer</th><th>Clips</th><th>Issues</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td className="mono">{r.question_key || '—'}</td>
                    <td>{r.payload.stem.slice(0, 90) || <em>missing</em>}</td>
                    <td className="small">{r.payload.type}</td>
                    <td className="mono">{Array.isArray((r.payload.key as any).correct) ? ((r.payload.key as any).correct as string[]).join(';').toUpperCase() || '—' : 'manual'}</td>
                    <td>{r.payload.media.length}</td>
                    <td>
                      {!r.issues.length && <Badge tone="ok">OK</Badge>}
                      {!importable(r) && <Badge tone="bad">Blocked</Badge>}
                      {importable(r) && r.payload.needs_review && <Badge tone="warn">Faculty review</Badge>}
                      <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                        {r.issues.map((i, k) => <li key={k} style={{ color: i.level === 'error' ? 'var(--crisis)' : 'var(--warn-ink)' }}>{i.message}</li>)}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Page>
  );
}
