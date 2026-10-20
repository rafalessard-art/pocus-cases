import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Confirm, Empty, ErrorNote, Modal, Spinner, fmtDate, useLoad } from '../../components/ui';
import { cohorts as loadCohorts, pocusCourse } from '../../lib/content';
import { rpc, supabase } from '../../lib/supabase';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = { draft: 'info', published: 'ok', retired: 'bad' };

export function ExamsAdmin() {
  const nav = useNavigate();
  const course = useLoad(pocusCourse, []);
  const list = useLoad(async () => {
    const { data, error } = await supabase.from('exams').select('*, exam_versions(id, version, status, published_at, title)').order('created_at', { ascending: false });
    if (error) throw error;
    return data as any[];
  }, []);
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<unknown>();
  async function create() {
    setErr(undefined);
    try {
      const r = await rpc<any>('create_exam', { p_course_id: course.data!.id, p_title: title.trim(), p_description: '' });
      nav(`/admin/exams/${r.exam_id}`);
    } catch (e) {
      setErr(e);
    }
  }
  return (
    <Page kicker="Administration" title="Examinations" subtitle="Build, version, publish and assign">
      <div className="card flat" style={{ marginBottom: 20 }}>
        <div className="row">
          <input type="text" placeholder="New exam title, e.g. POCUS End-of-Block Examination" value={title} onChange={(e) => setTitle(e.target.value)}
            style={{ flex: 1, minWidth: 260 }} aria-label="New exam title" data-testid="new-exam-title" />
          <button className="btn" disabled={!title.trim() || !course.data} onClick={create} data-testid="create-exam">Create exam</button>
        </div>
        <ErrorNote error={err} />
      </div>
      {list.loading ? <Spinner /> : <ErrorNote error={list.error} />}
      {!list.loading && !list.data?.length && <Empty>No examinations yet.</Empty>}
      <div className="stack">
        {(list.data ?? []).map((e) => (
          <Link key={e.id} to={`/admin/exams/${e.id}`} className="panel row between" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div>
              <h3 style={{ margin: 0 }}>{e.title}</h3>
              <span className="small muted">Created {fmtDate(e.created_at, false)}</span>
            </div>
            <div className="chips">
              {[...e.exam_versions].sort((a: any, b: any) => b.version - a.version).map((v: any) => (
                <Badge key={v.id} tone={STATUS_TONE[v.status]}>v{v.version} {v.status}</Badge>
              ))}
            </div>
          </Link>
        ))}
      </div>
    </Page>
  );
}

type Version = {
  id: string; exam_id: string; version: number; status: 'draft' | 'published' | 'retired'; title: string; instructions: string;
  time_limit_minutes: number | null; max_attempts: number; pass_threshold_pct: number | null; allow_resume: boolean;
  shuffle_questions: boolean; shuffle_options: boolean; feedback_policy: string; release_mode: string; published_at: string | null;
};
type Item = { position: number; section: string; points: number | null; question_version_id: string; qv: any };

export function ExamEditor() {
  const { examId = '' } = useParams();
  const exam = useLoad(async () => {
    const { data, error } = await supabase.from('exams').select('*').eq('id', examId).single();
    if (error) throw error;
    return data;
  }, [examId]);
  const versions = useLoad(async () => {
    const { data, error } = await supabase.from('exam_versions').select('*').eq('exam_id', examId).order('version', { ascending: false });
    if (error) throw error;
    return data as Version[];
  }, [examId]);
  const [sel, setSel] = useState<string | null>(null);
  const v = versions.data?.find((x) => x.id === sel) ?? versions.data?.[0];
  useEffect(() => {
    if (versions.data?.length && !sel) setSel((versions.data.find((x) => x.status === 'draft') ?? versions.data[0]).id);
  }, [versions.data, sel]);

  if (exam.loading || versions.loading) return <Spinner />;
  if (exam.error) return <div className="wrap"><ErrorNote error={exam.error} /></div>;
  return (
    <Page kicker="Examination" title={exam.data.title} actions={<Link className="btn secondary" to="/admin/exams">← All exams</Link>}>
      <div className="tabs" role="tablist">
        {(versions.data ?? []).map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === v?.id} className={x.id === v?.id ? 'active' : ''} onClick={() => setSel(x.id)}>
            Version {x.version} · {x.status}
          </button>
        ))}
      </div>
      {v && <VersionPanel key={v.id} v={v} onChanged={(id) => { versions.reload(); if (id) setSel(id); }} />}
    </Page>
  );
}

function VersionPanel({ v, onChanged }: { v: Version; onChanged: (selectId?: string) => void }) {
  const draft = v.status === 'draft';
  const [s, setS] = useState(v);
  const [items, setItems] = useState<Item[]>([]);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  const [issues, setIssues] = useState<any[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmPub, setConfirmPub] = useState(false);
  const [busy, setBusy] = useState(false);
  const rotPass = useLoad(async () => {
    const { data } = await supabase.from('rotation_requirements').select('config').eq('kind', 'exam').is('cohort_id', null).is('archived_at', null).limit(1);
    const v = data?.[0]?.config?.pass_pct;
    return v == null ? null : Number(v);
  }, []);

  async function loadItems() {
    const { data, error } = await supabase.from('exam_items').select('position, section, points, question_version_id, qv:question_versions(*, questions!question_versions_question_id_fkey(question_key, current_version_id))').eq('exam_version_id', v.id).order('position');
    if (error) setErr(error);
    else setItems(data as Item[]);
    setDirty(false);
  }
  async function check() {
    try {
      setIssues(await rpc('exam_version_issues', { p_exam_version_id: v.id }));
    } catch (e) {
      setErr(e);
    }
  }
  useEffect(() => {
    void loadItems();
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.id]);

  const total = items.reduce((t, i) => t + Number(i.points ?? i.qv.points), 0);

  async function saveSettings() {
    setErr(undefined);
    setMsg(null);
    const { error } = await supabase.from('exam_versions').update({
      title: s.title, instructions: s.instructions, time_limit_minutes: s.time_limit_minutes || null, max_attempts: s.max_attempts,
      pass_threshold_pct: s.pass_threshold_pct === null || (s.pass_threshold_pct as any) === '' ? null : s.pass_threshold_pct,
      allow_resume: s.allow_resume, shuffle_questions: s.shuffle_questions, shuffle_options: s.shuffle_options,
      feedback_policy: s.feedback_policy, release_mode: s.release_mode,
    }).eq('id', v.id);
    if (error) setErr(error);
    else {
      setMsg('Settings saved.');
      await check();
    }
  }
  async function saveItems(next = items) {
    setErr(undefined);
    try {
      await rpc('set_exam_items', { p_exam_version_id: v.id, p_items: next.map((i) => ({ question_version_id: i.question_version_id, section: i.section, points: i.points })) });
      await loadItems();
      await check();
      setMsg('Questions saved.');
    } catch (e) {
      setErr(e);
    }
  }
  async function publish() {
    setBusy(true);
    setErr(undefined);
    try {
      if (dirty) await saveItems();
      const r = await rpc<any>('publish_exam_version', { p_exam_version_id: v.id });
      setIssues(r.issues);
      if (r.published) {
        setMsg('Published. Learners assigned to this version can now take it.');
        onChanged(v.id);
      } else setErr(new Error('Cannot publish yet — resolve the errors in the readiness check.'));
    } catch (e) {
      setErr(e);
    }
    setBusy(false);
    setConfirmPub(false);
  }
  const move = (i: number, d: number) => {
    const n = [...items];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    setItems(n);
    setDirty(true);
  };
  const errorsCount = (issues ?? []).filter((i) => i.level === 'error').length;

  return (
    <div className="stack">
      {!draft && (
        <div className="notice">
          Version {v.version} is <strong>{v.status}</strong>{v.published_at ? ` (published ${fmtDate(v.published_at)})` : ''}. It is frozen so that learners'
          results remain reproducible.{' '}
          <button className="btn small secondary" onClick={async () => { try { const id = await rpc<string>('new_exam_draft', { p_exam_id: v.exam_id }); onChanged(id); } catch (e) { setErr(e); } }}>
            Create new draft from this version
          </button>
        </div>
      )}
      <div className="split">
        <div className="stack">
          <section className="card flat">
            <h3>Questions ({items.length}) · {total} points</h3>
            {items.length === 0 && <Empty>No questions yet. {draft && 'Add from the question bank.'}</Empty>}
            {items.length > 0 && (
              <div className="tablewrap">
                <table className="data">
                  <thead><tr><th>#</th><th>Question</th><th>Section</th><th className="num">Points</th>{draft && <th />}</tr></thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={it.question_version_id}>
                        <td>{i + 1}</td>
                        <td>
                          <Link to={`/admin/questions/${it.qv.question_id}`}>{it.qv.stem.slice(0, 100)}</Link>
                          <div className="small muted">
                            {it.qv.type} · v{it.qv.version}{it.qv.questions?.current_version_id !== it.question_version_id ? ' · newer version exists' : ''}
                            {it.qv.needs_review ? ' · flagged for review' : ''}
                          </div>
                        </td>
                        <td>{draft ? <input type="text" value={it.section} style={{ minWidth: 100 }}
                          onChange={(e) => { setItems(items.map((x, j) => (j === i ? { ...x, section: e.target.value } : x))); setDirty(true); }} /> : it.section || '—'}</td>
                        <td className="num">{draft ? <input type="number" min={0} step={0.5} style={{ width: 80 }} placeholder={String(it.qv.points)} value={it.points ?? ''}
                          onChange={(e) => { setItems(items.map((x, j) => (j === i ? { ...x, points: e.target.value === '' ? null : Number(e.target.value) } : x))); setDirty(true); }} /> : Number(it.points ?? it.qv.points)}</td>
                        {draft && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="btn ghost small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                            <button className="btn ghost small" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                            <button className="btn ghost small" onClick={() => { setItems(items.filter((_, j) => j !== i)); setDirty(true); }} aria-label="Remove">✕</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {draft && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn secondary" onClick={() => setAdding(true)} data-testid="add-questions">+ Add questions</button>
                <button className="btn" disabled={!dirty} onClick={() => saveItems()}>Save question list</button>
                {dirty && <span className="small muted">Unsaved changes</span>}
              </div>
            )}
          </section>
          {!draft && <Assignments version={v} />}
        </div>
        <aside className="stack">
          <section className="panel stack">
            <strong>Settings</strong>
            <fieldset disabled={!draft} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
              <label className="field">Title shown to learners<input type="text" value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} /></label>
              <label className="field">Instructions<textarea value={s.instructions} onChange={(e) => setS({ ...s, instructions: e.target.value })} /></label>
              <div className="formgrid">
                <label className="field">Time limit (min)<input type="number" min={1} value={s.time_limit_minutes ?? ''} placeholder="Untimed"
                  onChange={(e) => setS({ ...s, time_limit_minutes: e.target.value ? Number(e.target.value) : null })} data-testid="time-limit" /></label>
                <label className="field">Attempts<input type="number" min={1} max={20} value={s.max_attempts} onChange={(e) => setS({ ...s, max_attempts: Number(e.target.value) })} /></label>
                <label className="field">Pass threshold %<input type="number" min={0} max={100} value={s.pass_threshold_pct ?? ''}
                  onChange={(e) => setS({ ...s, pass_threshold_pct: e.target.value === '' ? null : Number(e.target.value) })} data-testid="pass-threshold" /></label>
              </div>
              {rotPass.data != null && (
                Number(s.pass_threshold_pct) === rotPass.data
                  ? <p className="small muted" style={{ marginTop: -6 }}>Matches the rotation pass mark ({rotPass.data}%).</p>
                  : <div className="notice warn small" data-testid="pass-mismatch">The rotation requires {rotPass.data}% (Admin → ITAR setup). Residents see this exam's own threshold on their result page, so set it to {rotPass.data}% to avoid conflicting messages.</div>
              )}
              <label className="field">Learner feedback after release
                <select value={s.feedback_policy} onChange={(e) => setS({ ...s, feedback_policy: e.target.value })} data-testid="feedback-policy">
                  <option value="none">None (completion only)</option>
                  <option value="score">Score and pass/fail</option>
                  <option value="score_domains">Score + performance by domain</option>
                  <option value="full_review">Full review (answers, explanations)</option>
                </select>
              </label>
              <label className="field">Result release
                <select value={s.release_mode} onChange={(e) => setS({ ...s, release_mode: e.target.value })} data-testid="release-mode">
                  <option value="manual">Faculty releases results</option>
                  <option value="immediate">Immediately on submission (if fully auto-graded)</option>
                </select>
              </label>
              <label className="check"><input type="checkbox" checked={s.allow_resume} onChange={(e) => setS({ ...s, allow_resume: e.target.checked })} /> Allow resuming an interrupted attempt</label>
              <label className="check"><input type="checkbox" checked={s.shuffle_questions} onChange={(e) => setS({ ...s, shuffle_questions: e.target.checked })} /> Shuffle question order</label>
              <label className="check"><input type="checkbox" checked={s.shuffle_options} onChange={(e) => setS({ ...s, shuffle_options: e.target.checked })} /> Shuffle answer options</label>
              {draft && <button className="btn secondary" onClick={saveSettings} data-testid="save-settings">Save settings</button>}
            </fieldset>
          </section>
          {draft && (
            <section className="panel stack">
              <strong>Readiness check</strong>
              {issues === null ? <Spinner /> : issues.length === 0 ? <p className="small" style={{ color: 'var(--ok-ink)', margin: 0 }}>✓ No problems found</p> : (
                <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
                  {issues.map((i, k) => <li key={k} style={{ color: i.level === 'error' ? 'var(--crisis)' : 'var(--warn-ink)' }}>{i.position ? `Q${i.position}: ` : ''}{i.message}</li>)}
                </ul>
              )}
              <button className="btn" disabled={busy || errorsCount > 0 || items.length === 0} onClick={() => setConfirmPub(true)} data-testid="publish">
                Publish version {v.version}
              </button>
            </section>
          )}
          {v.status === 'published' && (
            <button className="btn ghost small" onClick={async () => { try { await rpc('retire_exam_version', { p_exam_version_id: v.id }); onChanged(v.id); } catch (e) { setErr(e); } }}>
              Retire this version (closes it to new attempts)
            </button>
          )}
          {msg && <div className="notice ok small" role="status">{msg}</div>}
          <ErrorNote error={err} />
        </aside>
      </div>
      {adding && (
        <AddQuestions
          exclude={items.map((i) => i.qv.question_id)}
          onClose={() => setAdding(false)}
          onAdd={async (qvs) => {
            const next = [...items, ...qvs.map((qv, k) => ({ position: items.length + k, section: '', points: null, question_version_id: qv.id, qv }))];
            setAdding(false);
            setItems(next);
            await saveItems(next);
          }}
        />
      )}
      {confirmPub && (
        <Confirm title={`Publish version ${v.version}?`} confirmLabel={busy ? 'Publishing…' : 'Publish'} onCancel={() => setConfirmPub(false)} onConfirm={publish}
          body={<p>Publishing freezes these {items.length} questions, their answer keys and media, and the settings above. Later edits create a new version and never change submitted results.</p>} />
      )}
    </div>
  );
}

function AddQuestions({ exclude, onAdd, onClose }: { exclude: string[]; onAdd: (qvs: any[]) => void; onClose: () => void }) {
  const list = useLoad(async () => {
    const { data, error } = await supabase.from('questions').select('id, question_key, archived_at, current:question_versions!questions_current_version_fk(*)').is('archived_at', null);
    if (error) throw error;
    return data as any[];
  }, []);
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const rows = useMemo(() => (list.data ?? []).filter((r) => r.current && !exclude.includes(r.id) && (!q || `${r.question_key ?? ''} ${r.current.stem}`.toLowerCase().includes(q.toLowerCase()))), [list.data, exclude, q]);
  return (
    <Modal title="Add questions from the bank" onClose={onClose} wide>
      <input type="search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search questions" />
      {list.loading && <Spinner />}
      <div className="tablewrap" style={{ marginTop: 12, maxHeight: '55vh', overflow: 'auto' }}>
        <table className="data"><thead><tr><th /><th>Question</th><th>Domain</th><th>Type</th></tr></thead><tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" checked={picked.includes(r.id)} onChange={() => setPicked(picked.includes(r.id) ? picked.filter((x) => x !== r.id) : [...picked, r.id])} aria-label="Select question" data-testid="pick-question" /></td>
              <td>{r.current.stem.slice(0, 120)}{r.current.needs_review && <> <Badge tone="bad">review</Badge></>}</td>
              <td className="small">{r.current.domain_key ?? '—'}</td><td className="small">{r.current.type}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      {!list.loading && !rows.length && <Empty>No more questions available. <Link to="/admin/questions/new">Write one</Link>.</Empty>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
        <button className="btn" disabled={!picked.length} onClick={() => onAdd(rows.filter((r) => picked.includes(r.id)).map((r) => r.current))} data-testid="add-selected">Add {picked.length} question(s)</button>
      </div>
    </Modal>
  );
}

function Assignments({ version }: { version: Version }) {
  const coh = useLoad(loadCohorts, []);
  const learners = useLoad(async () => {
    const { data, error } = await supabase.from('profiles').select('id, full_name, email, role').eq('active', true).order('full_name');
    if (error) throw error;
    return data as any[];
  }, []);
  const list = useLoad(async () => {
    const { data, error } = await supabase.from('assignments').select('*, cohorts(name), profiles:profiles!assignments_user_id_fkey(full_name, email)').eq('exam_version_id', version.id).order('created_at', { ascending: false });
    if (error) throw error;
    return data as any[];
  }, [version.id]);
  const [target, setTarget] = useState('');
  const [opens, setOpens] = useState('');
  const [due, setDue] = useState('');
  const [err, setErr] = useState<unknown>();
  async function add() {
    setErr(undefined);
    const [kind, id] = target.split(':');
    const { error } = await supabase.from('assignments').insert({
      exam_version_id: version.id, cohort_id: kind === 'c' ? id : null, user_id: kind === 'u' ? id : null,
      opens_at: opens ? new Date(opens).toISOString() : null, due_at: due ? new Date(due).toISOString() : null,
    });
    if (error) setErr(error);
    else {
      setTarget('');
      list.reload();
    }
  }
  return (
    <section className="card flat">
      <h3>Assignments</h3>
      {version.status !== 'published' ? <p className="small muted">Retired versions cannot be assigned.</p> : (
        <div className="formgrid" style={{ alignItems: 'end' }}>
          <label className="field">Assign to
            <select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="assign-target">
              <option value="">— choose cohort or learner —</option>
              <optgroup label="Cohorts">{(coh.data ?? []).filter((c) => !c.archived_at).map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}</optgroup>
              <optgroup label="Individual learners">{(learners.data ?? []).filter((l) => l.role === 'learner').map((l) => <option key={l.id} value={`u:${l.id}`}>{l.full_name || l.email}</option>)}</optgroup>
              <optgroup label="Faculty / admin (to preview the exam as a learner sees it)">{(learners.data ?? []).filter((l) => l.role !== 'learner').map((l) => <option key={l.id} value={`u:${l.id}`}>{l.full_name || l.email} — preview</option>)}</optgroup>
            </select>
          </label>
          <label className="field">Opens (optional)<input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} /></label>
          <label className="field">Due (optional)<input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <button className="btn" disabled={!target} onClick={add} data-testid="assign">Assign</button>
        </div>
      )}
      <ErrorNote error={err} />
      {(list.data ?? []).length > 0 && (
        <div className="tablewrap" style={{ marginTop: 14 }}>
          <table className="data"><thead><tr><th>Assigned to</th><th>Opens</th><th>Due</th><th>Created</th><th /></tr></thead><tbody>
            {(list.data ?? []).map((a) => (
              <tr key={a.id} style={{ opacity: a.archived_at ? 0.5 : 1 }}>
                <td>{a.cohorts?.name ? `Cohort: ${a.cohorts.name}` : a.profiles?.full_name || a.profiles?.email}</td>
                <td>{fmtDate(a.opens_at)}</td><td>{fmtDate(a.due_at)}</td><td>{fmtDate(a.created_at, false)}</td>
                <td>{!a.archived_at && <button className="btn ghost small" onClick={async () => { await supabase.from('assignments').update({ archived_at: new Date().toISOString() }).eq('id', a.id); list.reload(); }}>Withdraw</button>}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
    </section>
  );
}
