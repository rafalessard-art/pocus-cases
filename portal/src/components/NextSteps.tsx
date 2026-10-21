import { Link } from 'react-router-dom';
import { completion, residentNextSteps, scanPct, type CaseState, type Rotation } from '../lib/requirements';
import { Badge } from './ui';

/** Resident summary: progress, what to do next (with direct actions), and what is waiting on faculty. */
export function NextSteps({ rotation, openExam, compact, cases }: { rotation: Rotation; openExam?: boolean; compact?: boolean; cases?: CaseState[] }) {
  const c = completion(rotation.requirements);
  const { todo, waiting } = residentNextSteps(rotation, openExam, cases);
  const s = rotation.scans;
  return (
    <section className="card" style={{ ['--accent' as any]: 'var(--petrol)', marginBottom: 18 }} data-testid="next-steps">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div className="stats">
          <div className="stat"><b>{c.done}/{c.total}</b><span>requirements complete{c.notYetDue ? ` · ${c.notYetDue} not yet due` : ''}</span></div>
          <div className="stat" style={{ minWidth: 180 }}>
            <b>{s.verified_total}/{s.target_total}</b><span>faculty-verified scans</span>
            <div className="bar" aria-hidden style={{ marginTop: 6 }}><span style={{ width: `${scanPct({ verified: s.verified_total, target: s.target_total })}%` }} /></div>
          </div>
        </div>
        {!compact && <Link to="/requirements" className="btn secondary small">All requirements →</Link>}
      </div>
      <div className="row" style={{ margin: '12px 0' }}>
        <Link to="/evidence" className="btn" data-testid="cta-upload">Upload Brightspace evidence</Link>
        <Link to="/requirements?report=scans#scans" className="btn" data-testid="cta-report-scans">Report scan counts</Link>
        <Link to="/exams" className="btn secondary">Examinations</Link>
      </div>
      <p className="seclabel" style={{ margin: '6px 0' }}>Your next steps</p>
      {!todo.length ? <p className="small muted">Nothing for you to do right now.</p> : (
        <ol className="stack" style={{ paddingLeft: 18, margin: 0 }} data-testid="todo-list">
          {todo.map((t) => (
            <li key={t.key} className="small">
              <div className="row between">
                <span>{t.tone === 'warn' && <Badge tone="warn">Action needed</Badge>} {t.label}</span>
                {t.to && <Link to={t.to} className="btn secondary small">{t.cta}</Link>}
              </div>
              {t.detail && <div className="notice warn small" style={{ marginTop: 4 }}><strong>Message from faculty:</strong> {t.detail}</div>}
            </li>
          ))}
        </ol>
      )}
      {waiting.length > 0 && (
        <>
          <p className="seclabel" style={{ margin: '12px 0 6px' }}>Waiting on faculty</p>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }} data-testid="waiting-list">
            {waiting.map((t) => <li key={t.key}>{t.label}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}
