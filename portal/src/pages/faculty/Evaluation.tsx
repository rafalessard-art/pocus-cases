import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Confirm, DomainBars, ErrorNote, Spinner, fmtDate, pct, useLoad } from '../../components/ui';
import { download, toCSV } from '../../lib/csv';
import { pocusCourse } from '../../lib/content';
import { domainHighlights, draftSummary, type ExamFacts } from '../../lib/summary';
import { rpc, supabase } from '../../lib/supabase';

type Ev = {
  id?: string; course_id: string; learner_id: string; cohort_id: string | null; rotation_start: string | null; rotation_end: string | null;
  attempt_id: string | null; exam_snapshot: any; strengths: string; areas_for_improvement: string; observations: string; summary: string;
  status: 'draft' | 'approved'; approved_at?: string | null; approved_by?: string | null; updated_at?: string;
};

function factsFrom(a: any): ExamFacts | null {
  if (!a) return null;
  return {
    examTitle: a.exam_title, version: a.version, submittedAt: a.submitted_at, attemptNo: a.attempt_no,
    scorePct: a.score_pct == null ? null : Number(a.score_pct), scorePoints: a.score_points == null ? null : Number(a.score_points),
    maxPoints: a.max_points == null ? null : Number(a.max_points), passThresholdPct: a.pass_threshold_pct == null ? null : Number(a.pass_threshold_pct),
    passed: a.passed, gradingStatus: a.grading_status, domains: (a.breakdown?.domains ?? []).map((d: any) => ({ key: d.key, label: d.label, pct: d.pct == null ? null : Number(d.pct), n_items: d.n_items })),
  };
}

/**
 * Faculty-only evaluation workspace. The draft is assembled from verified exam
 * data and faculty-typed observations only (lib/summary.ts); it stays editable
 * and becomes final only when a faculty member explicitly approves it.
 */
export function EvaluationWorkspace() {
  const { evalId } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const course = useLoad(pocusCourse, []);
  const [ev, setEv] = useState<Ev | null>(null);
  const [err, setErr] = useState<unknown>();
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'approve' | 'reopen' | null>(null);
  const [saving, setSaving] = useState(false);

  // load or initialise
  useEffect(() => {
    const c = course.data;
    if (!c) return;
    (async () => {
      try {
        if (evalId && evalId !== 'new') {
          const { data, error } = await supabase.from('evaluations').select('*').eq('id', evalId).single();
          if (error) throw error;
          setEv(data as Ev);
        } else {
          const learner = sp.get('learner');
          if (!learner) throw new Error('No learner selected');
          setEv({ course_id: c.id, learner_id: learner, cohort_id: null, rotation_start: null, rotation_end: null, attempt_id: sp.get('attempt'),
            exam_snapshot: {}, strengths: '', areas_for_improvement: '', observations: '', summary: '', status: 'draft' });
        }
      } catch (e) {
        setErr(e);
      }
    })();
  }, [evalId, course.data, sp]);

  const rep = useLoad(() => (ev && course.data ? rpc<any>('learner_report', { p_learner: ev.learner_id, p_course: course.data.id }) : Promise.resolve(null)),
    [ev?.learner_id, course.data?.id]);

  // sensible defaults from the learner's cohort and latest submitted attempt
  useEffect(() => {
    if (!rep.data || !ev || ev.id) return;
    const c = rep.data.cohorts[0];
    const submitted = rep.data.attempts.filter((a: any) => a.status === 'submitted');
    const att = submitted.find((a: any) => a.id === ev.attempt_id) ?? submitted[0];
    setEv((x) => x && {
      ...x, cohort_id: x.cohort_id ?? c?.id ?? null, rotation_start: x.rotation_start ?? c?.start_date ?? null, rotation_end: x.rotation_end ?? c?.end_date ?? null,
      attempt_id: att?.id ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rep.data]);

  const attempt = useMemo(() => rep.data?.attempts.find((a: any) => a.id === ev?.attempt_id) ?? null, [rep.data, ev?.attempt_id]);
  const facts = factsFrom(attempt);
  const locked = ev?.status === 'approved';
  const hl = facts ? domainHighlights(facts.domains) : { strong: [], weak: [] };

  if (err) return <div className="wrap"><ErrorNote error={err} /></div>;
  if (!ev || rep.loading || !rep.data) return <Spinner />;
  const L = rep.data.learner;
  const cohort = rep.data.cohorts.find((c: any) => c.id === ev.cohort_id);

  function generate() {
    setEv((x) => x && {
      ...x,
      exam_snapshot: facts ?? {},
      summary: draftSummary({
        learnerName: L.full_name || L.email, trainingLevel: L.training_level, rotation: 'POCUS', rotationStart: x.rotation_start, rotationEnd: x.rotation_end,
        exam: facts, strengths: x.strengths, areasForImprovement: x.areas_for_improvement, observations: x.observations,
      }),
    });
    setMsg('Draft generated from verified exam data and your entries. Edit freely before saving.');
  }

  async function save(status?: 'approved' | 'draft') {
    if (!ev) return;
    setSaving(true);
    setErr(undefined);
    setMsg(null);
    try {
      const body = {
        course_id: ev.course_id, learner_id: ev.learner_id, cohort_id: ev.cohort_id, rotation_start: ev.rotation_start, rotation_end: ev.rotation_end,
        attempt_id: ev.attempt_id, exam_snapshot: ev.exam_snapshot && Object.keys(ev.exam_snapshot).length ? ev.exam_snapshot : facts ?? {},
        strengths: ev.strengths, areas_for_improvement: ev.areas_for_improvement, observations: ev.observations, summary: ev.summary,
      };
      let row: Ev;
      if (!ev.id) {
        const { data, error } = await supabase.from('evaluations').insert(body).select('*').single();
        if (error) throw error;
        row = data as Ev;
        nav(`/faculty/evaluations/${row.id}`, { replace: true });
      } else if (status === 'draft') {
        const { data, error } = await supabase.from('evaluations').update({ status: 'draft' }).eq('id', ev.id).select('*').single();
        if (error) throw error;
        row = data as Ev;
      } else {
        const { data, error } = await supabase.from('evaluations').update(body).eq('id', ev.id).select('*').single();
        if (error) throw error;
        row = data as Ev;
      }
      if (status === 'approved') {
        const { data, error } = await supabase.from('evaluations').update({ status: 'approved' }).eq('id', row.id!).select('*').single();
        if (error) throw error;
        row = data as Ev;
      }
      setEv(row);
      setMsg(status === 'approved' ? 'Evaluation approved and locked.' : status === 'draft' ? 'Re-opened for editing.' : 'Draft saved.');
    } catch (e) {
      setErr(e);
    }
    setSaving(false);
    setConfirm(null);
  }

  const set = (k: keyof Ev, v: any) => setEv((x) => x && { ...x, [k]: v });
  const snapshot = (ev.exam_snapshot && Object.keys(ev.exam_snapshot).length ? ev.exam_snapshot : facts) as ExamFacts | null;

  return (
    <Page kicker="Faculty · End-of-block evaluation" title={L.full_name || L.email}
      subtitle={<>{L.training_level} · POCUS rotation {ev.status === 'approved' ? <Badge tone="ok">Approved {fmtDate(ev.approved_at)}</Badge> : <Badge tone="warn">Draft</Badge>}</>}
      actions={<>
        <Link className="btn secondary" to={`/faculty/learners/${L.id}`}>← Learner</Link>
        <button className="btn secondary" onClick={() => window.print()}>Print / PDF</button>
        <button className="btn secondary" onClick={() => download(`evaluation_${(L.full_name || L.email).replace(/\W+/g, '_')}.csv`, toCSV([{
          learner: L.full_name, email: L.email, training_level: L.training_level, rotation_start: ev.rotation_start, rotation_end: ev.rotation_end,
          exam: snapshot?.examTitle, exam_version: snapshot?.version, score_pct: snapshot?.scorePct, passed: snapshot?.passed,
          ...Object.fromEntries((snapshot?.domains ?? []).map((d) => [`domain_${d.key}_pct`, d.pct])),
          strengths: ev.strengths, areas_for_improvement: ev.areas_for_improvement, observations: ev.observations, summary: ev.summary,
          status: ev.status, approved_at: ev.approved_at ?? '',
        }]))}>Export CSV</button>
      </>}>
      <div className="notice small no-print" style={{ marginBottom: 16 }}>
        This workspace summarises <strong>verified written-exam data</strong> and <strong>what you type</strong>. It never infers scanning skill, clinical judgement or
        professionalism from exam scores. Nothing is final until you approve it.
      </div>
      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="formgrid">
              <label className="field">Rotation start<input type="date" disabled={locked} value={ev.rotation_start ?? ''} onChange={(e) => set('rotation_start', e.target.value || null)} /></label>
              <label className="field">Rotation end<input type="date" disabled={locked} value={ev.rotation_end ?? ''} onChange={(e) => set('rotation_end', e.target.value || null)} /></label>
              <label className="field">Exam attempt
                <select disabled={locked} value={ev.attempt_id ?? ''} onChange={(e) => { set('attempt_id', e.target.value || null); set('exam_snapshot', {}); }}>
                  <option value="">None</option>
                  {rep.data.attempts.filter((a: any) => a.status === 'submitted').map((a: any) => (
                    <option key={a.id} value={a.id}>{a.exam_title} v{a.version} · attempt {a.attempt_no} · {a.score_pct != null ? pct(a.score_pct, 1) : 'ungraded'}</option>
                  ))}
                </select>
              </label>
            </div>
            {cohort && <p className="small muted" style={{ marginBottom: 0 }}>Cohort: {cohort.name}</p>}
          </section>
          <label className="field">Strengths <span className="hint">your observations; exam-derived suggestions on the right</span>
            <textarea disabled={locked} value={ev.strengths} onChange={(e) => set('strengths', e.target.value)} data-testid="eval-strengths" />
          </label>
          <label className="field">Areas for improvement
            <textarea disabled={locked} value={ev.areas_for_improvement} onChange={(e) => set('areas_for_improvement', e.target.value)} />
          </label>
          <label className="field">Faculty observations <span className="hint">direct observation of scanning, interpretation, communication, professionalism</span>
            <textarea disabled={locked} value={ev.observations} onChange={(e) => set('observations', e.target.value)} data-testid="eval-observations" />
          </label>
          {!locked && <div><button className="btn secondary" onClick={generate} data-testid="generate-draft">Generate draft summary</button></div>}
          <label className="field">Evaluation summary <span className="hint">editable; this is what gets approved</span>
            <textarea rows={12} disabled={locked} value={ev.summary} onChange={(e) => set('summary', e.target.value)} data-testid="eval-summary" />
          </label>
          <div className="row no-print">
            {!locked && <button className="btn secondary" disabled={saving} onClick={() => save()} data-testid="save-eval">Save draft</button>}
            {!locked && <button className="btn" disabled={saving || !ev.summary.trim()} onClick={() => setConfirm('approve')} data-testid="approve-eval">Approve…</button>}
            {locked && <button className="btn secondary" disabled={saving} onClick={() => setConfirm('reopen')}>Re-open for editing</button>}
          </div>
          {msg && <div className="notice ok small" role="status">{msg}</div>}
          <ErrorNote error={err} />
        </div>
        <aside className="stack">
          <section className="card flat">
            <h3>Verified exam data</h3>
            {!snapshot ? <p className="small muted">No submitted exam selected.</p> : (
              <>
                <p className="small">{snapshot.examTitle} v{snapshot.version}{snapshot.attemptNo > 1 ? ` · attempt ${snapshot.attemptNo}` : ''} · {fmtDate(snapshot.submittedAt)}</p>
                <div className="stats">
                  <div className="stat"><b>{snapshot.scorePct != null ? pct(snapshot.scorePct, 1) : '—'}</b><span>score</span></div>
                  {snapshot.passThresholdPct != null && <div className="stat"><b>{snapshot.passed ? 'Pass' : 'Below'}</b><span>threshold {pct(snapshot.passThresholdPct)}</span></div>}
                </div>
                <DomainBars domains={snapshot.domains} />
                {ev.id && ev.exam_snapshot && Object.keys(ev.exam_snapshot).length > 0 && <p className="small muted">Snapshot stored with this evaluation.</p>}
              </>
            )}
          </section>
          {facts && !locked && (
            <section className="panel small">
              <strong>Exam-derived suggestions</strong>
              <p className="muted" style={{ margin: '4px 0' }}>Knowledge domains only — copy if you agree.</p>
              {hl.strong.length > 0 && <p>Strongest: {hl.strong.map((d) => `${d.label} (${pct(d.pct)})`).join(', ')}</p>}
              {hl.weak.length > 0 && <p>To review: {hl.weak.map((d) => `${d.label} (${pct(d.pct)})`).join(', ')}</p>}
              {!hl.strong.length && !hl.weak.length && <p>No domain stands out.</p>}
            </section>
          )}
          {rep.data.notes.length > 0 && (
            <section className="panel small">
              <strong>Faculty notes on file</strong>
              {rep.data.notes.slice(0, 5).map((n: any) => <p key={n.id} style={{ whiteSpace: 'pre-wrap' }}>“{n.body}” — {n.author}, {fmtDate(n.created_at, false)}</p>)}
            </section>
          )}
        </aside>
      </div>
      {confirm === 'approve' && (
        <Confirm title="Approve this evaluation?" confirmLabel="Approve and lock" onCancel={() => setConfirm(null)} onConfirm={() => save('approved')}
          body={<p>I have reviewed this summary, it reflects my professional judgement, and it contains no statements about clinical or technical performance that were not directly observed.</p>} />
      )}
      {confirm === 'reopen' && (
        <Confirm title="Re-open this evaluation?" confirmLabel="Re-open" onCancel={() => setConfirm(null)} onConfirm={() => save('draft')}
          body={<p>The approval will be withdrawn (this is recorded in the audit log). Approve again after editing.</p>} />
      )}
    </Page>
  );
}
