import { Link, useLocation, useParams } from 'react-router-dom';
import { Page } from '../components/Layout';
import { MediaView } from '../components/MediaView';
import { Badge, DomainBars, ErrorNote, Spinner, fmtDate, pct, useLoad } from '../components/ui';
import { rpc } from '../lib/supabase';

const LETTERS = 'ABCDEFGHIJKLMNOP';

export function Result() {
  const { attemptId = '' } = useParams();
  const loc = useLocation() as { state?: { justSubmitted?: boolean; reason?: string } };
  const { data, error, loading } = useLoad(() => rpc<any>('get_my_result', { p_attempt: attemptId }), [attemptId]);
  if (loading) return <Spinner />;
  if (error) return <div className="wrap"><ErrorNote error={error} /></div>;
  const r = data;
  return (
    <Page kicker="Examination" title={r.title} subtitle={`Attempt ${r.attempt_no}`} narrow>
      {loc.state?.justSubmitted && (
        <div className="notice ok" role="status" style={{ marginBottom: 18 }} data-testid="submitted-notice">
          <strong>Your examination has been submitted.</strong>{' '}
          {loc.state.reason === 'time' ? 'Time ran out; every answer saved before the deadline was submitted.' : ''} A record of your
          submission was stored at {fmtDate(r.submitted_at)}.
        </div>
      )}
      {r.status === 'in_progress' && (
        <div className="notice">This attempt is still in progress. <Link to={`/exams/attempt/${r.id}`}>Resume →</Link></div>
      )}
      {r.status === 'submitted' && !r.released && (
        <div className="card">
          <h3>Submitted — results not yet released</h3>
          <p className="muted">
            Submitted {fmtDate(r.submitted_at)}
            {r.submit_reason === 'time_expired' ? ' (time limit reached)' : ''}. Faculty will release results after review; they will appear here.
          </p>
        </div>
      )}
      {r.status === 'submitted' && r.released && r.feedback_policy === 'none' && (
        <div className="card"><h3>Completed</h3><p className="muted">This examination does not provide individual feedback.</p></div>
      )}
      {r.released && r.score_pct !== undefined && (
        <div className="card" data-testid="score-card">
          <div className="stats">
            <div className="stat"><b>{pct(r.score_pct, 1)}</b><span>score</span></div>
            <div className="stat"><b>{Number(r.score_points)}/{Number(r.max_points)}</b><span>points</span></div>
            {r.passed != null && (
              <div className="stat"><b>{r.passed ? 'Pass' : 'Below threshold'}</b><span>threshold {pct(r.pass_threshold_pct)}</span></div>
            )}
          </div>
        </div>
      )}
      {r.domains && (
        <>
          <p className="seclabel">Performance by curriculum domain</p>
          <div className="panel"><DomainBars domains={r.domains} /></div>
          {r.objectives?.length > 0 && (
            <details className="disclosure" style={{ marginTop: 12 }}>
              <summary>By learning objective</summary>
              <DomainBars domains={r.objectives.map((o: any) => ({ key: o.code, label: `${o.code} ${o.title ?? ''}`, pct: o.pct, n_items: o.n_items }))} />
            </details>
          )}
          <p className="small muted">Domains below 70% are worth revisiting in the <Link to="/curriculum">curriculum</Link>.</p>
        </>
      )}
      {r.items && (
        <>
          <p className="seclabel">Question review</p>
          <div className="stack">
            {r.items.map((it: any) => {
              const sel: string[] = it.response?.selected ?? [];
              const cor: string[] = it.key?.correct ?? [];
              return (
                <div key={it.number} className="question">
                  <div className="qhead">
                    <span className="qnum">Question {it.number}</span>
                    {it.is_correct ? <Badge tone="ok">Correct</Badge> : it.points_awarded > 0 ? <Badge tone="warn">Partial</Badge> : <Badge tone="bad">Incorrect</Badge>}
                  </div>
                  <p className="stem">{it.stem}</p>
                  <MediaView media={it.media} label={`Question ${it.number}`} />
                  {it.options?.length > 0 && (
                    <div className="options">
                      {it.options.map((o: any, i: number) => (
                        <div key={o.id} className={`opt ${cor.includes(o.id) ? 'correct' : sel.includes(o.id) ? 'incorrect' : ''}`}>
                          <span className="letter">{LETTERS[i]}</span>
                          <span>
                            {o.text}
                            {sel.includes(o.id) && <em className="small muted"> — your answer</em>}
                            {cor.includes(o.id) && <strong className="small"> ✓ correct</strong>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {it.type === 'short_answer' && (
                    <div className="stack">
                      <div className="panel"><strong>Your answer:</strong> <span style={{ whiteSpace: 'pre-wrap' }}>{it.response?.text ?? '—'}</span></div>
                      {it.key?.model_answer && <div className="panel"><strong>Model answer:</strong> {it.key.model_answer}</div>}
                      {it.grader_comment && <div className="panel"><strong>Grader comment:</strong> {it.grader_comment}</div>}
                    </div>
                  )}
                  {it.explanation && <div className="notice" style={{ marginTop: 12 }}><strong>Explanation.</strong> {it.explanation}</div>}
                </div>
              );
            })}
          </div>
        </>
      )}
      <p style={{ marginTop: 24 }}><Link to="/exams">← Back to examinations</Link></p>
    </Page>
  );
}
