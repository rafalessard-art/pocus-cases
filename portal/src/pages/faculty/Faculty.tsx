import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, DomainBars, Empty, ErrorNote, Spinner, fmtDate, pct, useLoad } from '../../components/ui';
import { download, toCSV } from '../../lib/csv';
import { cohorts as loadCohorts, pocusCourse } from '../../lib/content';
import { rpc, supabase } from '../../lib/supabase';

const LETTERS = 'ABCDEFGHIJKLMNOP';

export function FacultyDashboard() {
  const versions = useLoad(async () => {
    const { data, error } = await supabase.from('exam_versions').select('id, exam_id, version, title, status, published_at').neq('status', 'draft').order('published_at', { ascending: false });
    if (error) throw error;
    return data as any[];
  }, []);
  const learners = useLoad(async () => {
    const { data, error } = await supabase.from('profiles').select('id, full_name, email, training_level, cohort_members(cohorts(name))').eq('role', 'learner').order('full_name');
    if (error) throw error;
    return data as any[];
  }, []);
  const todo = useLoad(async () => {
    const { data, error } = await supabase.from('attempts').select('id, user_id, status, grading_status, released_at, submitted_at, exam_version_id, profiles!attempts_user_id_fkey(full_name, email), exam_versions(title, version)')
      .eq('status', 'submitted').or('grading_status.eq.pending_manual,released_at.is.null').order('submitted_at', { ascending: false }).limit(50);
    if (error) throw error;
    return data as any[];
  }, []);
  const [q, setQ] = useState('');
  return (
    <Page kicker="Faculty" title="Faculty dashboard" subtitle="Results, grading and end-of-block evaluations for your learners">
      <div className="grid two">
        <section className="card" style={{ ['--accent' as any]: 'var(--clay)' }}>
          <h3>Needs attention</h3>
          {todo.loading ? <Spinner /> : !(todo.data ?? []).length ? <p className="small muted">Nothing waiting — all submitted attempts are graded and released.</p> : (
            <ul className="small" style={{ paddingLeft: 18 }}>
              {(todo.data ?? []).map((a) => (
                <li key={a.id}>
                  <Link to={`/faculty/attempts/${a.id}`}>{a.profiles?.full_name || a.profiles?.email}</Link> — {a.exam_versions?.title} v{a.exam_versions?.version}:{' '}
                  {a.grading_status === 'pending_manual' ? <Badge tone="warn">needs grading</Badge> : <Badge tone="info">not released</Badge>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card" style={{ ['--accent' as any]: 'var(--petrol)' }}>
          <h3>Examinations</h3>
          {versions.loading ? <Spinner /> : !(versions.data ?? []).length ? <p className="small muted">No published exams yet.</p> : (
            <ul style={{ paddingLeft: 18 }}>
              {(versions.data ?? []).map((v) => (
                <li key={v.id}>
                  <Link to={`/faculty/exams/${v.id}`} data-testid="exam-results-link">{v.title} — v{v.version}</Link>{' '}
                  {v.status === 'retired' && <Badge tone="bad">retired</Badge>} <span className="small muted">{fmtDate(v.published_at, false)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <p className="seclabel">Learners</p>
      <input type="search" placeholder="Find a learner…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, marginBottom: 12 }} aria-label="Find a learner" />
      {learners.loading ? <Spinner /> : <ErrorNote error={learners.error} />}
      {!learners.loading && !(learners.data ?? []).length && <Empty>No learners visible. Faculty see learners in cohorts where they are an evaluator.</Empty>}
      <div className="tablewrap">
        <table className="data">
          <thead><tr><th>Learner</th><th>Training</th><th>Cohorts</th><th /></tr></thead>
          <tbody>
            {(learners.data ?? []).filter((l) => !q || `${l.full_name} ${l.email}`.toLowerCase().includes(q.toLowerCase())).map((l) => (
              <tr key={l.id}>
                <td><Link to={`/faculty/learners/${l.id}`}>{l.full_name || l.email}</Link></td>
                <td>{l.training_level ?? '—'}</td>
                <td className="small">{l.cohort_members.map((m: any) => m.cohorts?.name).filter(Boolean).join(', ') || '—'}</td>
                <td><Link className="btn small secondary" to={`/faculty/evaluations/new?learner=${l.id}`}>Evaluation</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

function Histogram({ values }: { values: number[] }) {
  const bins = Array.from({ length: 10 }, (_, i) => values.filter((v) => (i === 9 ? v >= 90 : v >= i * 10 && v < (i + 1) * 10)).length);
  const max = Math.max(1, ...bins);
  return (
    <div>
      <div className="hist" role="img" aria-label="Score distribution">
        {bins.map((b, i) => <div key={i} style={{ height: `${(b / max) * 100}%` }} title={`${i * 10}–${i === 9 ? 100 : i * 10 + 9}%: ${b}`} />)}
      </div>
      <div className="hist-labels">{bins.map((_, i) => <span key={i}>{i * 10}</span>)}</div>
    </div>
  );
}

export function ExamResults() {
  const { versionId = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const cohort = sp.get('cohort') || '';
  const coh = useLoad(loadCohorts, []);
  const rep = useLoad(() => rpc<any>('exam_report', { p_exam_version: versionId, p_cohort: cohort || null }), [versionId, cohort]);
  const [sel, setSel] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>();

  const latest = useMemo(
    () => (rep.data?.learners ?? []).map((l: any) => ({ ...l, last: [...l.attempts].reverse().find((a: any) => a.status === 'submitted') ?? l.attempts[l.attempts.length - 1] })),
    [rep.data],
  );
  if (rep.loading) return <Spinner />;
  if (rep.error) return <div className="wrap"><ErrorNote error={rep.error} /></div>;
  const r = rep.data;
  const scores: number[] = latest.filter((l: any) => l.last?.score_pct != null).map((l: any) => Number(l.last.score_pct));
  const smallN = (r.stats.n_scored ?? 0) < 10;
  const releasable = latest.filter((l: any) => l.last && l.last.status === 'submitted' && l.last.grading_status === 'complete' && !l.last.released).map((l: any) => l.last.id);

  async function release(ids: string[]) {
    setErr(undefined);
    try {
      const n = await rpc<number>('release_results', { p_attempts: ids });
      setMsg(`Released results for ${n} attempt(s).`);
      setSel([]);
      rep.reload();
    } catch (e) {
      setErr(e);
    }
  }
  function exportLearners() {
    const rows = latest.map((l: any) => ({
      learner: l.full_name, email: l.email, training_level: l.training_level, attempts: l.attempts.length,
      status: l.last?.status ?? 'not started', submitted_at: l.last?.submitted_at ?? '', score_pct: l.last?.score_pct ?? '',
      points: l.last ? `${l.last.score_points ?? ''}/${l.last.max_points ?? ''}` : '', passed: l.last?.passed ?? '', grading: l.last?.grading_status ?? '',
      released: l.last?.released ?? '', ...Object.fromEntries((l.domains ?? []).map((d: any) => [`domain_${d.key}_pct`, d.pct ?? ''])),
    }));
    download(`${r.exam.title.replace(/\W+/g, '_')}_v${r.exam.version}_results.csv`, toCSV(rows));
  }
  function exportItems() {
    download(`${r.exam.title.replace(/\W+/g, '_')}_v${r.exam.version}_item_analysis.csv`, toCSV(r.items.map((i: any) => ({
      position: i.position, section: i.section, type: i.type, domain: i.domain_key, stem: i.stem, n: i.n, pct_correct: i.pct_correct,
      discrimination: i.discrimination, correct: (i.correct ?? []).join(';'), option_counts: i.option_counts,
    }))));
  }

  return (
    <Page kicker="Faculty · Results" title={`${r.exam.title}`} subtitle={`Version ${r.exam.version} · ${r.exam.status}`}
      actions={<><button className="btn secondary" onClick={exportLearners}>Export results CSV</button><button className="btn secondary" onClick={exportItems}>Export item analysis</button><button className="btn secondary" onClick={() => window.print()}>Print</button></>}>
      <div className="row no-print" style={{ marginBottom: 16 }}>
        <label className="field" style={{ maxWidth: 320 }}>Cohort
          <select value={cohort} onChange={(e) => setSp(e.target.value ? { cohort: e.target.value } : {})}>
            <option value="">All my learners</option>
            {(coh.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      <div className="grid two">
        <section className="card">
          <div className="stats">
            <div className="stat"><b>{r.stats.n_completed}/{r.stats.n_learners}</b><span>completed</span></div>
            <div className="stat"><b>{pct(r.stats.mean, 1)}</b><span>mean</span></div>
            <div className="stat"><b>{pct(r.stats.median, 1)}</b><span>median</span></div>
            <div className="stat"><b>{r.stats.sd ?? '—'}</b><span>SD</span></div>
            {r.stats.pass_threshold_pct != null && <div className="stat"><b>{r.stats.n_passed}/{r.stats.n_scored}</b><span>≥ {pct(r.stats.pass_threshold_pct)}</span></div>}
          </div>
          {scores.length > 0 && <Histogram values={scores} />}
          {smallN && <p className="small muted">Descriptive statistics for a small group (n = {r.stats.n_scored}). They describe this cohort's exam performance and are not validated measures of competence.</p>}
        </section>
        <section className="card" style={{ ['--accent' as any]: 'var(--sky)' }}>
          <h3>Performance by domain</h3>
          <DomainBars domains={r.domains} />
        </section>
      </div>

      <p className="seclabel">Learners</p>
      {msg && <div className="notice ok small" role="status">{msg}</div>}
      <ErrorNote error={err} />
      <div className="row no-print" style={{ marginBottom: 10 }}>
        <button className="btn small" disabled={!sel.length} onClick={() => release(sel)} data-testid="release-selected">Release selected ({sel.length})</button>
        <button className="btn small secondary" disabled={!releasable.length} onClick={() => release(releasable)}>Release all graded ({releasable.length})</button>
      </div>
      <div className="tablewrap">
        <table className="data">
          <thead><tr><th className="no-print" /><th>Learner</th><th>Status</th><th>Submitted</th><th className="num">Score</th><th>Result</th><th>Weakest domain</th><th /></tr></thead>
          <tbody>
            {latest.map((l: any) => {
              const weakest = [...(l.domains ?? [])].filter((d: any) => d.pct != null).sort((a: any, b: any) => a.pct - b.pct)[0];
              const a = l.last;
              return (
                <tr key={l.user_id}>
                  <td className="no-print">{a && releasable.includes(a.id) && <input type="checkbox" checked={sel.includes(a.id)} onChange={() => setSel(sel.includes(a.id) ? sel.filter((x) => x !== a.id) : [...sel, a.id])} aria-label={`Select ${l.full_name}`} />}</td>
                  <td><Link to={`/faculty/learners/${l.user_id}`}>{l.full_name || l.email}</Link><div className="small muted">{l.training_level}</div></td>
                  <td>
                    {!a ? <Badge>Not started</Badge> : a.status === 'in_progress' ? <Badge tone="warn">In progress</Badge> : a.grading_status === 'pending_manual' ? <Badge tone="warn">Needs grading</Badge> : <Badge tone="ok">Submitted</Badge>}{' '}
                    {a?.released && <Badge tone="info">Released</Badge>}
                    {l.attempts.length > 1 && <div className="small muted">{l.attempts.length} attempts</div>}
                  </td>
                  <td className="small">{fmtDate(a?.submitted_at)}</td>
                  <td className="num">{a?.score_pct != null ? pct(a.score_pct, 1) : '—'}</td>
                  <td>{a?.passed == null ? '—' : a.passed ? <Badge tone="ok">Pass</Badge> : <Badge tone="bad">Below</Badge>}</td>
                  <td className="small">{weakest ? `${weakest.label} (${pct(weakest.pct)})` : '—'}</td>
                  <td>{a && <Link className="btn ghost small" to={`/faculty/attempts/${a.id}`}>Review</Link>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="seclabel">Item analysis</p>
      <p className="small muted">% correct uses each learner's latest submitted attempt. Discrimination (corrected item–rest correlation) is shown only with ≥ 5 responses; with small cohorts treat it as a prompt to re-read the item, not a verdict.</p>
      <div className="tablewrap">
        <table className="data">
          <thead><tr><th>#</th><th>Question</th><th>Domain</th><th className="num">n</th><th className="num">% correct</th><th className="num">Discr.</th><th>Responses</th></tr></thead>
          <tbody>
            {r.items.map((i: any) => {
              const flag = (i.n >= 3 && i.pct_correct != null && i.pct_correct < 40) || (i.discrimination != null && i.discrimination < 0.1);
              return (
                <tr key={i.item_id} style={flag ? { background: 'var(--crisis-bg)' } : undefined}>
                  <td>{i.position}</td>
                  <td>{i.stem}{flag && <div><Badge tone="bad">Review item</Badge></div>}</td>
                  <td className="small">{i.domain_key ?? '—'}</td>
                  <td className="num">{i.n}</td>
                  <td className="num">{pct(i.pct_correct)}</td>
                  <td className="num">{i.discrimination ?? '—'}</td>
                  <td className="small mono">{i.option_counts ? Object.entries(i.option_counts).map(([k, v]) => `${k.toUpperCase()}${(i.correct ?? []).includes(k) ? '✓' : ''}:${v}`).join('  ') : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

export function AttemptReview() {
  const { attemptId = '' } = useParams();
  const d = useLoad(() => rpc<any>('staff_attempt_detail', { p_attempt: attemptId }), [attemptId]);
  const [grades, setGrades] = useState<Record<string, { points: string; comment: string }>>({});
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  if (d.loading) return <Spinner />;
  if (d.error) return <div className="wrap"><ErrorNote error={d.error} /></div>;
  const { attempt: a, learner, exam, breakdown, items } = d.data;

  async function grade(itemId: string) {
    setErr(undefined);
    const g = grades[itemId];
    try {
      const fresh = await rpc('grade_response', { p_attempt: attemptId, p_item: itemId, p_points: Number(g.points), p_comment: g.comment ?? '' });
      d.setData(fresh);
      setMsg('Grade saved.');
    } catch (e) {
      setErr(e);
    }
  }
  async function release() {
    try {
      await rpc('release_results', { p_attempts: [attemptId] });
      d.reload();
      setMsg('Results released to the learner.');
    } catch (e) {
      setErr(e);
    }
  }

  return (
    <Page kicker="Faculty · Attempt review" title={learner.full_name || learner.email}
      subtitle={`${exam.title} v${exam.version} · attempt ${a.attempt_no}`}
      actions={<>
        <Link className="btn secondary" to={`/faculty/exams/${exam.version_id}`}>← Exam results</Link>
        <Link className="btn secondary" to={`/faculty/evaluations/new?learner=${learner.id}&attempt=${a.id}`}>Start evaluation</Link>
      </>}>
      <div className="grid two">
        <section className="card">
          <div className="stats">
            <div className="stat"><b>{a.score_pct != null ? pct(a.score_pct, 1) : '—'}</b><span>score</span></div>
            <div className="stat"><b>{a.score_points ?? '—'}/{a.max_points}</b><span>points</span></div>
            <div className="stat"><b>{a.passed == null ? '—' : a.passed ? 'Pass' : 'Below'}</b><span>threshold {pct(exam.pass_threshold_pct)}</span></div>
          </div>
          <dl className="kv small" style={{ marginTop: 12 }}>
            <dt>Status</dt><dd>{a.status}{a.submit_reason ? ` (${a.submit_reason.replace('_', ' ')})` : ''}</dd>
            <dt>Started</dt><dd>{fmtDate(a.started_at)}</dd>
            <dt>Submitted</dt><dd>{fmtDate(a.submitted_at)}</dd>
            <dt>Grading</dt><dd>{a.grading_status.replace('_', ' ')}</dd>
            <dt>Released</dt><dd>{a.released_at ? fmtDate(a.released_at) : 'No'}</dd>
          </dl>
          <div className="row" style={{ marginTop: 12 }}>
            {a.status === 'submitted' && a.grading_status === 'complete' && !a.released_at && <button className="btn" onClick={release} data-testid="release-one">Release results</button>}
            {a.status === 'in_progress' && <button className="btn secondary" onClick={async () => { await rpc('staff_close_attempt', { p_attempt: attemptId }); d.reload(); }}>Close attempt now</button>}
          </div>
          {msg && <div className="notice ok small" style={{ marginTop: 10 }}>{msg}</div>}
          <ErrorNote error={err} />
        </section>
        <section className="card" style={{ ['--accent' as any]: 'var(--sky)' }}>
          <h3>By domain</h3>
          <DomainBars domains={breakdown.domains} />
        </section>
      </div>
      <p className="seclabel">Responses</p>
      <div className="stack">
        {items.map((it: any) => {
          const sel: string[] = it.response?.selected ?? [];
          const cor: string[] = it.key?.correct ?? [];
          return (
            <div key={it.item_id} className="question">
              <div className="qhead">
                <span className="qnum">Q{it.number} {it.domain_key && `· ${it.domain_key}`} {it.flagged && '· flagged by learner'}</span>
                <span>
                  {it.points_awarded == null ? <Badge tone="warn">Ungraded</Badge> : it.is_correct ? <Badge tone="ok">Correct</Badge> : Number(it.points_awarded) > 0 ? <Badge tone="warn">Partial</Badge> : <Badge tone="bad">Incorrect</Badge>}{' '}
                  <span className="small">{it.points_awarded ?? '—'}/{it.points}</span>
                </span>
              </div>
              <p className="stem" style={{ fontSize: 16 }}>{it.stem}</p>
              {it.options?.length > 0 && (
                <div className="options">
                  {it.options.map((o: any, i: number) => (
                    <div key={o.id} className={`opt ${cor.includes(o.id) ? 'correct' : sel.includes(o.id) ? 'incorrect' : ''}`}>
                      <span className="letter">{LETTERS[i]}</span><span>{o.text}{sel.includes(o.id) && <em className="small"> — selected</em>}</span>
                    </div>
                  ))}
                </div>
              )}
              {it.type === 'short_answer' && (
                <div className="stack">
                  <div className="panel"><strong>Response:</strong> <span style={{ whiteSpace: 'pre-wrap' }}>{it.response?.text ?? '(no answer)'}</span></div>
                  {it.key?.model_answer && <div className="panel small"><strong>Model answer:</strong> {it.key.model_answer}</div>}
                  {a.status === 'submitted' && it.response?.text && (
                    <div className="row">
                      <input type="number" min={0} max={it.points} step={0.5} style={{ width: 100 }} placeholder={`0–${it.points}`}
                        value={grades[it.item_id]?.points ?? (it.graded_by ? String(it.points_awarded) : '')}
                        onChange={(e) => setGrades({ ...grades, [it.item_id]: { ...(grades[it.item_id] ?? { comment: it.grader_comment ?? '' }), points: e.target.value } })}
                        aria-label="Points awarded" data-testid="grade-points" />
                      <input type="text" placeholder="Comment (visible to learner with full review)" style={{ flex: 1 }}
                        value={grades[it.item_id]?.comment ?? it.grader_comment ?? ''}
                        onChange={(e) => setGrades({ ...grades, [it.item_id]: { ...(grades[it.item_id] ?? { points: '' }), comment: e.target.value } })} />
                      <button className="btn small" disabled={!grades[it.item_id]?.points} onClick={() => grade(it.item_id)} data-testid="save-grade">Save grade</button>
                    </div>
                  )}
                </div>
              )}
              {it.explanation && <p className="small muted">Explanation: {it.explanation}</p>}
            </div>
          );
        })}
      </div>
    </Page>
  );
}

export function LearnerView() {
  const { learnerId = '' } = useParams();
  const course = useLoad(pocusCourse, []);
  const rep = useLoad(() => (course.data ? rpc<any>('learner_report', { p_learner: learnerId, p_course: course.data.id }) : Promise.resolve(null)), [learnerId, course.data?.id]);
  const evals = useLoad(async () => {
    const { data, error } = await supabase.from('evaluations').select('id, status, rotation_start, rotation_end, updated_at, approved_at').eq('learner_id', learnerId).order('updated_at', { ascending: false });
    if (error) throw error;
    return data as any[];
  }, [learnerId]);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>();
  if (rep.loading || !rep.data) return rep.error ? <div className="wrap"><ErrorNote error={rep.error} /></div> : <Spinner />;
  const r = rep.data;
  async function addNote() {
    setErr(undefined);
    const { data: s } = await supabase.auth.getUser();
    const { error } = await supabase.from('faculty_notes').insert({ course_id: course.data!.id, learner_id: learnerId, body: note.trim(), author_id: s.user?.id });
    if (error) setErr(error);
    else {
      setNote('');
      rep.reload();
    }
  }
  return (
    <Page kicker="Faculty · Learner" title={r.learner.full_name || r.learner.email} subtitle={[r.learner.training_level, r.learner.program].filter(Boolean).join(' · ')}
      actions={<Link className="btn" to={`/faculty/evaluations/new?learner=${learnerId}`}>New end-of-block evaluation</Link>}>
      <div className="grid two">
        <section className="card flat">
          <h3>Rotation</h3>
          {r.cohorts.length ? r.cohorts.map((c: any) => <div key={c.id} className="small">{c.name} · {c.start_date ?? '—'} → {c.end_date ?? '—'}</div>) : <p className="small muted">No cohort.</p>}
          <p className="small" style={{ marginTop: 10 }}>Curriculum: {r.curriculum.required_completed}/{r.curriculum.required} required resources marked complete by the learner.</p>
        </section>
        <section className="card flat">
          <h3>Evaluations</h3>
          {(evals.data ?? []).length === 0 ? <p className="small muted">None yet.</p> : (
            <ul className="small" style={{ paddingLeft: 18 }}>
              {(evals.data ?? []).map((e) => (
                <li key={e.id}><Link to={`/faculty/evaluations/${e.id}`}>{e.rotation_start ?? '—'} → {e.rotation_end ?? '—'}</Link> {e.status === 'approved' ? <Badge tone="ok">approved</Badge> : <Badge tone="warn">draft</Badge>}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <p className="seclabel">Examination attempts</p>
      {!r.attempts.length && <Empty>No attempts yet.</Empty>}
      <div className="stack">
        {r.attempts.map((a: any) => (
          <div key={a.id} className="panel">
            <div className="row between">
              <div>
                <strong>{a.exam_title}</strong> <span className="small muted">v{a.version} · attempt {a.attempt_no} · {a.status}{a.submitted_at ? ` · ${fmtDate(a.submitted_at)}` : ''}</span>
              </div>
              <div className="row">
                <strong>{a.score_pct != null ? pct(a.score_pct, 1) : a.grading_status === 'pending_manual' ? 'needs grading' : '—'}</strong>
                {a.passed != null && (a.passed ? <Badge tone="ok">Pass</Badge> : <Badge tone="bad">Below threshold</Badge>)}
                <Link className="btn ghost small" to={`/faculty/attempts/${a.id}`}>Review</Link>
              </div>
            </div>
            {a.breakdown && <DomainBars domains={a.breakdown.domains} />}
            {a.breakdown?.objectives?.some((o: any) => o.pct != null && o.pct < 60) && (
              <p className="small">Objectives below 60%: {a.breakdown.objectives.filter((o: any) => o.pct != null && o.pct < 60).map((o: any) => `${o.code} (${pct(o.pct)})`).join(', ')}</p>
            )}
          </div>
        ))}
      </div>
      <p className="seclabel">Faculty notes</p>
      <div className="panel stack">
        <textarea placeholder="Add an observation (visible to faculty only)…" value={note} onChange={(e) => setNote(e.target.value)} />
        <div><button className="btn small" disabled={!note.trim()} onClick={addNote}>Add note</button></div>
        <ErrorNote error={err} />
        {r.notes.map((n: any) => (
          <div key={n.id} className="small" style={{ borderTop: '1px solid var(--rule-soft)', paddingTop: 8 }}>
            <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
            <div className="muted">{n.author ?? 'Faculty'} · {fmtDate(n.created_at)}</div>
          </div>
        ))}
      </div>
    </Page>
  );
}
