import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { MediaView } from '../../components/MediaView';
import { Badge, Empty, ErrorNote, Modal, Spinner, fmtDate, useLoad } from '../../components/ui';
import { domains as loadDomains, mediaLibrary, mediaReady, objectives as loadObjectives, pocusCourse, type MediaAsset } from '../../lib/content';
import { rpc, supabase } from '../../lib/supabase';

const TYPE_LABEL: Record<string, string> = { single: 'Single best answer', multiple: 'Multiple select', short_answer: 'Short answer', hotspot: 'Image hotspot' };
const LETTERS = 'abcdefghijklmnop';

export function QuestionBank() {
  const course = useLoad(pocusCourse, []);
  const doms = useLoad(() => (course.data ? loadDomains(course.data.id) : Promise.resolve([])), [course.data?.id]);
  const list = useLoad(async () => {
    const { data, error } = await supabase
      .from('questions')
      .select('id, question_key, archived_at, created_at, current:question_versions!questions_current_version_fk(id, version, type, stem, domain_key, points, locked, needs_review, objective_codes)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data as any[];
  }, []);
  const [q, setQ] = useState('');
  const [dom, setDom] = useState('');
  const [review, setReview] = useState(false);
  const rows = (list.data ?? []).filter(
    (r) => (!dom || r.current?.domain_key === dom) && (!review || r.current?.needs_review) &&
      (!q || `${r.question_key ?? ''} ${r.current?.stem ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <Page kicker="Administration" title="Question bank" subtitle="Versioned questions mapped to curriculum domains and objectives"
      actions={<><Link className="btn secondary" to="/admin/import">Import CSV/JSON</Link><Link className="btn" to="/admin/questions/new">New question</Link></>}>
      <div className="row" style={{ marginBottom: 14 }}>
        <input type="search" placeholder="Search stem or key…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} aria-label="Search questions" />
        <select value={dom} onChange={(e) => setDom(e.target.value)} style={{ maxWidth: 260 }} aria-label="Domain filter">
          <option value="">All domains</option>
          {(doms.data ?? []).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> Flagged for review only</label>
      </div>
      {list.loading ? <Spinner /> : <ErrorNote error={list.error} />}
      {!list.loading && !rows.length && <Empty>No questions yet.</Empty>}
      {rows.length > 0 && (
        <div className="tablewrap">
          <table className="data">
            <thead><tr><th>Key</th><th>Question</th><th>Type</th><th>Domain</th><th>Version</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => (window.location.href = `/app/admin/questions/${r.id}`)}>
                  <td className="mono">{r.question_key ?? '—'}</td>
                  <td><Link to={`/admin/questions/${r.id}`} onClick={(e) => e.stopPropagation()}>{(r.current?.stem ?? '').slice(0, 120) || '(empty)'}</Link></td>
                  <td className="small">{TYPE_LABEL[r.current?.type] ?? r.current?.type}</td>
                  <td className="small">{doms.data?.find((d) => d.key === r.current?.domain_key)?.label ?? '—'}</td>
                  <td>v{r.current?.version}</td>
                  <td>
                    {r.current?.needs_review && <Badge tone="bad">Review</Badge>} {r.current?.locked ? <Badge tone="ok">In published exam</Badge> : <Badge>Draft</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

type Form = {
  question_key: string;
  type: 'single' | 'multiple' | 'short_answer';
  stem: string;
  options: { id: string; text: string }[];
  correct: string[];
  model_answer: string;
  points: number;
  scoring: 'all_or_nothing' | 'partial';
  explanation: string;
  domain_key: string;
  objective_codes: string[];
  media: { media_version_id: string; caption: string; asset?: MediaAsset }[];
  needs_review: boolean;
  review_note: string;
  source: string;
};

const blank: Form = {
  question_key: '', type: 'single', stem: '', options: [{ id: 'a', text: '' }, { id: 'b', text: '' }, { id: 'c', text: '' }, { id: 'd', text: '' }],
  correct: [], model_answer: '', points: 1, scoring: 'all_or_nothing', explanation: '', domain_key: '', objective_codes: [], media: [],
  needs_review: false, review_note: '', source: '',
};

export function QuestionEditor() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const nav = useNavigate();
  const course = useLoad(pocusCourse, []);
  const doms = useLoad(() => (course.data ? loadDomains(course.data.id) : Promise.resolve([])), [course.data?.id]);
  const objs = useLoad(() => (course.data ? loadObjectives(course.data.id) : Promise.resolve([])), [course.data?.id]);
  const [f, setF] = useState<Form>(blank);
  const [meta, setMeta] = useState<{ version?: number; locked?: boolean; versions?: any[] }>({});
  const [loading, setLoading] = useState(!isNew);
  const [err, setErr] = useState<unknown>();
  const [issues, setIssues] = useState<{ level: string; message: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const { data: qq, error } = await supabase.from('questions').select('*').eq('id', id).single();
        if (error) throw error;
        const { data: vers } = await supabase.from('question_versions').select('id, version, locked, created_at, stem').eq('question_id', id).order('version', { ascending: false });
        const { data: v } = await supabase.from('question_versions').select('*').eq('id', qq.current_version_id).single();
        const { data: k } = await supabase.from('question_keys').select('key').eq('question_version_id', v.id).maybeSingle();
        // media_versions ↔ media_assets have two FKs, so the embed must name one; and a failed media
        // load must stop the editor, because saving with an empty list would detach the question's media.
        const { data: m, error: mErr } = await supabase.from('question_version_media').select('*, media_versions(*, media_assets!media_versions_asset_id_fkey(*))').eq('question_version_id', v.id).order('position');
        if (mErr) throw mErr;
        setF({
          question_key: qq.question_key ?? '',
          type: v.type,
          stem: v.stem,
          options: v.options,
          correct: k?.key?.correct ?? [],
          model_answer: k?.key?.model_answer ?? '',
          points: Number(v.points),
          scoring: v.scoring?.mode === 'partial' ? 'partial' : 'all_or_nothing',
          explanation: v.explanation,
          domain_key: v.domain_key ?? '',
          objective_codes: v.objective_codes ?? [],
          media: (m ?? []).map((x: any) => ({ media_version_id: x.media_version_id, caption: x.caption, asset: { ...x.media_versions.media_assets, current: x.media_versions } })),
          needs_review: v.needs_review,
          review_note: v.review_note,
          source: v.source,
        });
        setMeta({ version: v.version, locked: v.locked, versions: vers ?? [] });
        setIssues(await rpc('question_issues', { p_qv: v.id }));
      } catch (e) {
        setErr(e);
      }
      setLoading(false);
    })();
  }, [id, isNew]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    setSaving(true);
    setErr(undefined);
    setNotice(null);
    try {
      const key = f.type === 'short_answer' ? { model_answer: f.model_answer } : { correct: f.correct.filter((c) => f.options.some((o) => o.id === c)) };
      const res = await rpc<any>('save_question', {
        p_question_id: isNew ? null : id,
        p: {
          course_id: course.data!.id,
          question_key: f.question_key,
          type: f.type,
          stem: f.stem,
          options: f.type === 'short_answer' ? [] : f.options.filter((o) => o.text.trim()),
          key,
          points: f.points,
          scoring: { mode: f.scoring },
          explanation: f.explanation,
          domain_key: f.domain_key || null,
          objective_codes: f.objective_codes,
          media: f.media.map((m) => ({ media_version_id: m.media_version_id, caption: m.caption })),
          needs_review: f.needs_review,
          review_note: f.review_note,
          source: f.source,
        },
      });
      setIssues(res.issues);
      setNotice(res.new_version ? `Saved as version ${isNew ? 1 : (meta.version ?? 0) + 1}. Published exams keep the previous version.` : 'Saved.');
      if (isNew) nav(`/admin/questions/${res.question_id}`, { replace: true });
      else setMeta((m) => ({ ...m, version: res.new_version ? (m.version ?? 0) + 1 : m.version, locked: false }));
    } catch (e) {
      setErr(e);
    }
    setSaving(false);
  }

  if (loading) return <Spinner />;
  return (
    <Page kicker="Question bank" title={isNew ? 'New question' : `Edit question${f.question_key ? ` ${f.question_key}` : ''}`}
      subtitle={!isNew ? `Version ${meta.version}${meta.locked ? ' — used in a published exam; saving creates a new version' : ''}` : undefined}
      actions={<Link className="btn secondary" to="/admin/questions">← Bank</Link>}>
      <div className="split">
        <div className="stack">
          <div className="formgrid">
            <label className="field">Question type
              <select value={f.type} onChange={(e) => set('type', e.target.value as Form['type'])} data-testid="q-type">
                <option value="single">Single best answer</option>
                <option value="multiple">Multiple select</option>
                <option value="short_answer">Short answer (manually graded)</option>
              </select>
            </label>
            <label className="field">Key <span className="hint">optional stable ID, e.g. LUNG-003</span>
              <input type="text" value={f.question_key} onChange={(e) => set('question_key', e.target.value)} />
            </label>
            <label className="field">Points<input type="number" min={0} step={0.5} value={f.points} onChange={(e) => set('points', Number(e.target.value))} /></label>
            {f.type === 'multiple' && (
              <label className="field">Scoring
                <select value={f.scoring} onChange={(e) => set('scoring', e.target.value as Form['scoring'])}>
                  <option value="all_or_nothing">All or nothing</option>
                  <option value="partial">Partial credit (right − wrong) / correct</option>
                </select>
              </label>
            )}
          </div>
          <label className="field">Question stem
            <textarea rows={5} value={f.stem} onChange={(e) => set('stem', e.target.value)} data-testid="q-stem" />
          </label>

          <div className="panel stack">
            <div className="row between"><strong>Ultrasound media</strong><button className="btn secondary small" onClick={() => setPicker(true)} data-testid="attach-media">Attach from library</button></div>
            {f.media.length === 0 && <p className="small muted">No clips attached.</p>}
            {f.media.map((m, i) => (
              <div key={m.media_version_id} className="row" style={{ alignItems: 'flex-start' }}>
                <span className="mono" style={{ minWidth: 120 }}>{m.asset?.media_key}</span>
                {m.asset && !mediaReady(m.asset) && <Badge tone="warn">Not yet authorized/de-identified</Badge>}
                <input type="text" placeholder="Caption (optional)" value={m.caption} style={{ flex: 1 }}
                  onChange={(e) => set('media', f.media.map((x, j) => (j === i ? { ...x, caption: e.target.value } : x)))} />
                <button className="btn ghost small" onClick={() => set('media', f.media.filter((_, j) => j !== i))} aria-label="Remove clip">✕</button>
              </div>
            ))}
            {f.media.length > 0 && (
              <MediaView media={f.media.filter((m) => m.asset?.current).map((m) => ({
                path: m.asset!.current!.storage_path, kind: m.asset!.kind, width: m.asset!.current!.width, height: m.asset!.current!.height, caption: m.caption,
              }))} />
            )}
          </div>

          {f.type !== 'short_answer' ? (
            <div className="panel stack">
              <strong>Answer options <span className="small muted">— tick the correct {f.type === 'single' ? 'answer' : 'answers'}</span></strong>
              {f.options.map((o, i) => (
                <div className="row" key={o.id}>
                  <label className="check" title="Correct">
                    <input
                      type={f.type === 'single' ? 'radio' : 'checkbox'}
                      name="correct"
                      checked={f.correct.includes(o.id)}
                      onChange={() => set('correct', f.type === 'single' ? [o.id] : f.correct.includes(o.id) ? f.correct.filter((c) => c !== o.id) : [...f.correct, o.id])}
                      aria-label={`Option ${LETTERS[i].toUpperCase()} is correct`}
                      data-testid={`correct-${i}`}
                    />
                    <strong>{LETTERS[i].toUpperCase()}</strong>
                  </label>
                  <input type="text" value={o.text} style={{ flex: 1 }} onChange={(e) => set('options', f.options.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
                    aria-label={`Option ${LETTERS[i].toUpperCase()} text`} data-testid={`option-text-${i}`} />
                  <button className="btn ghost small" disabled={f.options.length <= 2}
                    onClick={() => { set('options', f.options.filter((_, j) => j !== i)); set('correct', f.correct.filter((c) => c !== o.id)); }} aria-label="Remove option">✕</button>
                </div>
              ))}
              <div>
                <button className="btn secondary small" disabled={f.options.length >= 12}
                  onClick={() => {
                    const used = new Set(f.options.map((o) => o.id));
                    const nid = [...LETTERS].find((l) => !used.has(l)) ?? `o${Date.now()}`;
                    set('options', [...f.options, { id: nid, text: '' }]);
                  }}>+ Add option</button>
              </div>
            </div>
          ) : (
            <label className="field">Model answer / marking guide <span className="hint">shown to graders, and to learners only with full-review feedback</span>
              <textarea value={f.model_answer} onChange={(e) => set('model_answer', e.target.value)} />
            </label>
          )}
          <label className="field">Explanation <span className="hint">shown to learners only if the exam releases full review</span>
            <textarea value={f.explanation} onChange={(e) => set('explanation', e.target.value)} />
          </label>
        </div>

        <aside className="stack">
          <div className="panel stack">
            <label className="field">Curriculum domain
              <select value={f.domain_key} onChange={(e) => set('domain_key', e.target.value)} data-testid="q-domain">
                <option value="">— choose —</option>
                {(doms.data ?? []).map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            </label>
            <div className="field">Learning objectives
              <div style={{ maxHeight: 220, overflow: 'auto' }}>
                {(objs.data ?? []).map((o) => (
                  <label key={o.code} className="check small" style={{ display: 'flex' }}>
                    <input type="checkbox" checked={f.objective_codes.includes(o.code)}
                      onChange={() => set('objective_codes', f.objective_codes.includes(o.code) ? f.objective_codes.filter((c) => c !== o.code) : [...f.objective_codes, o.code])} />
                    <span><span className="mono">{o.code}</span> {o.title}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="field">Source <span className="hint">e.g. ExamBuilder export 2026-11, Q14</span>
              <input type="text" value={f.source} onChange={(e) => set('source', e.target.value)} />
            </label>
            <label className="check"><input type="checkbox" checked={f.needs_review} onChange={(e) => set('needs_review', e.target.checked)} /> Flag for faculty review (blocks publishing)</label>
            {f.needs_review && <label className="field">Review note<input type="text" value={f.review_note} onChange={(e) => set('review_note', e.target.value)} /></label>}
          </div>
          <button className="btn" onClick={save} disabled={saving || !course.data} data-testid="save-question">{saving ? 'Saving…' : meta.locked ? 'Save as new version' : 'Save question'}</button>
          {notice && <div className="notice ok small" role="status">{notice}</div>}
          <ErrorNote error={err} />
          {issues && (
            <div className="panel">
              <strong>Readiness check</strong>
              {issues.length === 0 ? <p className="small" style={{ color: 'var(--ok-ink)' }}>✓ Ready to publish</p> : (
                <ul className="small" style={{ paddingLeft: 18 }}>
                  {issues.map((i, k) => <li key={k} style={{ color: i.level === 'error' ? 'var(--crisis)' : 'var(--warn-ink)' }}>{i.message}</li>)}
                </ul>
              )}
            </div>
          )}
          {meta.versions && meta.versions.length > 1 && (
            <div className="panel small">
              <strong>Version history</strong>
              <ul style={{ paddingLeft: 18 }}>{meta.versions.map((v) => <li key={v.id}>v{v.version} · {fmtDate(v.created_at)}{v.locked ? ' · published' : ''}</li>)}</ul>
            </div>
          )}
        </aside>
      </div>
      {picker && (
        <MediaPicker
          exclude={f.media.map((m) => m.media_version_id)}
          onClose={() => setPicker(false)}
          onPick={(a) => {
            if (a.current_version_id) set('media', [...f.media, { media_version_id: a.current_version_id, caption: '', asset: a }]);
            setPicker(false);
          }}
        />
      )}
    </Page>
  );
}

function MediaPicker({ exclude, onPick, onClose }: { exclude: string[]; onPick: (a: MediaAsset) => void; onClose: () => void }) {
  const lib = useLoad(mediaLibrary, []);
  const [q, setQ] = useState('');
  const rows = useMemo(
    () => (lib.data ?? []).filter((a) => !a.archived_at && a.current?.upload_status === 'uploaded' && !exclude.includes(a.current_version_id ?? '') &&
      (!q || `${a.media_key} ${a.title} ${a.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()))),
    [lib.data, q, exclude],
  );
  return (
    <Modal title="Attach media" onClose={onClose} wide>
      <input type="search" placeholder="Search media…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Search media" />
      {lib.loading && <Spinner />}
      <div className="tablewrap" style={{ marginTop: 12 }}>
        <table className="data"><thead><tr><th>Key</th><th>Title</th><th>Domain</th><th>Status</th><th /></tr></thead><tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.media_key}</td><td>{a.title}</td><td className="small">{a.domain_key ?? '—'}</td>
              <td>{mediaReady(a) ? <Badge tone="ok">Ready</Badge> : <Badge tone="warn">Needs governance</Badge>}</td>
              <td><button className="btn small" onClick={() => onPick(a)} data-testid={`pick-${a.media_key}`}>Attach</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      {!lib.loading && !rows.length && <Empty>No uploaded media matches. <Link to="/admin/media">Open the media library</Link>.</Empty>}
    </Modal>
  );
}
