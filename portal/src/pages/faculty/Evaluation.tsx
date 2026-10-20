import { useEffect, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { Page } from '../../components/Layout';
import { Badge, Empty, ErrorNote, Spinner, fmtDate, useLoad } from '../../components/ui';
import { pocusCourse } from '../../lib/content';
import { rpc, supabase } from '../../lib/supabase';

/**
 * Entry point for end-of-block evaluations. Evaluations now live in the
 * block-scoped ITAR workspace (/faculty/itar/:cohort/:learner); this route
 * resolves older links (`/faculty/evaluations/new?learner=…` and
 * `/faculty/evaluations/:id`) to it, and shows evaluations created before
 * blocks were required, read-only, with an option to attach a draft to a block.
 */
export function EvaluationWorkspace() {
  const { evalId } = useParams();
  const [sp] = useSearchParams();
  const course = useLoad(pocusCourse, []);
  const [ev, setEv] = useState<any>(null);
  const [err, setErr] = useState<unknown>();
  const learnerId = evalId === 'new' ? sp.get('learner') : ev?.learner_id;

  useEffect(() => {
    if (!evalId || evalId === 'new') return;
    supabase.from('evaluations').select('*').eq('id', evalId).single().then(({ data, error }) => (error ? setErr(error) : setEv(data)));
  }, [evalId]);
  const rep = useLoad(() => (learnerId && course.data ? rpc<any>('learner_report', { p_learner: learnerId, p_course: course.data.id }) : Promise.resolve(null)),
    [learnerId, course.data?.id]);

  if (err) return <div className="wrap"><ErrorNote error={err} /></div>;
  if (evalId !== 'new' && !ev) return <Spinner />;
  if (ev?.cohort_id) return <Navigate to={`/faculty/itar/${ev.cohort_id}/${ev.learner_id}`} replace />;
  if (!learnerId) return <div className="wrap"><ErrorNote error="No learner selected" /></div>;
  if (rep.loading || !rep.data) return rep.error ? <div className="wrap"><ErrorNote error={rep.error} /></div> : <Spinner />;
  const cohorts: any[] = rep.data.cohorts;
  if (!ev && cohorts.length === 1) return <Navigate to={`/faculty/itar/${cohorts[0].id}/${learnerId}`} replace />;
  const L = rep.data.learner;

  async function attach(cohortId: string) {
    const { error } = await supabase.from('evaluations').update({ cohort_id: cohortId }).eq('id', ev.id);
    if (error) setErr(error);
    else setEv({ ...ev, cohort_id: cohortId });
  }

  return (
    <Page kicker="Faculty · End-of-block evaluation" title={L.full_name || L.email} subtitle={L.training_level ?? ''}
      actions={<Link className="btn secondary" to={`/faculty/learners/${L.id}`}>← Learner</Link>}>
      {!cohorts.length && <Empty>This resident is not in a rotation block. Add them to one (Admin → People → Cohorts) to prepare an ITAR.</Empty>}
      {cohorts.length > 0 && (
        <section className="panel stack" style={{ marginBottom: 18 }}>
          <strong>{ev ? 'Attach this draft to a rotation block' : 'Choose the rotation block'}</strong>
          <div className="row">
            {cohorts.map((c) => ev && ev.status === 'draft'
              ? <button key={c.id} className="btn secondary small" onClick={() => attach(c.id)}>{c.name}</button>
              : <Link key={c.id} className="btn secondary small" to={`/faculty/itar/${c.id}/${L.id}`}>{c.name}</Link>)}
          </div>
        </section>
      )}
      {ev && (
        <section className="card flat">
          <h3>Earlier evaluation {ev.status === 'approved' ? <Badge tone="ok">Approved {fmtDate(ev.approved_at)}</Badge> : <Badge tone="warn">Draft</Badge>}</h3>
          <p className="small muted">{ev.rotation_start ?? '—'} → {ev.rotation_end ?? '—'}</p>
          <div style={{ whiteSpace: 'pre-wrap' }}>{ev.summary || <span className="muted">(empty)</span>}</div>
        </section>
      )}
    </Page>
  );
}
