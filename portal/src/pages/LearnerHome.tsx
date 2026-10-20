import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page } from '../components/Layout';
import { Badge, Confirm, Empty, ErrorNote, Spinner, fmtDate, useLoad } from '../components/ui';
import { isStaff, useAuth } from '../lib/auth';
import { completion } from '../lib/requirements';
import { rpc } from '../lib/supabase';

export type MyExam = {
  assignment_id: string;
  exam_version_id: string;
  title: string;
  version: number;
  instructions: string;
  n_items: number;
  time_limit_minutes: number | null;
  accommodated: boolean;
  max_attempts: number;
  attempts_used: number;
  allow_resume: boolean;
  opens_at: string | null;
  due_at: string | null;
  state: 'upcoming' | 'available' | 'in_progress' | 'completed' | 'closed';
  open_attempt_id: string | null;
  last_attempt: { id: string; attempt_no: number; submitted_at: string; released: boolean } | null;
};

const STATE: Record<MyExam['state'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'petrol' }> = {
  available: { label: 'Available', tone: 'petrol' },
  in_progress: { label: 'In progress', tone: 'warn' },
  completed: { label: 'Completed', tone: 'ok' },
  upcoming: { label: 'Not yet open', tone: 'info' },
  closed: { label: 'Closed', tone: 'bad' },
};

export function ExamCard({ exam, onStarted }: { exam: MyExam; onStarted?: () => void }) {
  const nav = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const s = STATE[exam.state];

  async function start() {
    setBusy(true);
    setErr(undefined);
    try {
      const id = await rpc<string>('start_attempt', { p_assignment: exam.assignment_id });
      onStarted?.();
      nav(`/exams/attempt/${id}`);
    } catch (e) {
      setErr(e);
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <div className="card" data-testid="exam-card">
      <div className="row between">
        <Badge tone={s.tone}>{s.label}</Badge>
        <span className="small muted">Version {exam.version}</span>
      </div>
      <h3 style={{ marginTop: 10 }}>{exam.title}</h3>
      <dl className="kv small">
        <dt>Questions</dt>
        <dd>{exam.n_items}</dd>
        <dt>Time limit</dt>
        <dd>
          {exam.time_limit_minutes ? `${Math.round(exam.time_limit_minutes)} min` : 'Untimed'}
          {exam.accommodated && <span className="muted"> (includes approved accommodation)</span>}
        </dd>
        <dt>Attempts</dt>
        <dd>
          {exam.attempts_used} of {exam.max_attempts} used
        </dd>
        {exam.opens_at && (<><dt>Opens</dt><dd>{fmtDate(exam.opens_at)}</dd></>)}
        {exam.due_at && (<><dt>Due</dt><dd>{fmtDate(exam.due_at)}</dd></>)}
      </dl>
      <ErrorNote error={err} />
      <div className="row" style={{ marginTop: 14 }}>
        {exam.state === 'available' && (
          <button className="btn" onClick={() => setConfirm(true)} disabled={busy}>
            {exam.attempts_used ? 'Start new attempt' : 'Start exam'}
          </button>
        )}
        {exam.state === 'in_progress' && exam.open_attempt_id && (
          <button className="btn" onClick={start} disabled={busy}>
            Resume exam
          </button>
        )}
        {exam.last_attempt && (
          <Link className="btn secondary" to={`/exams/result/${exam.last_attempt.id}`}>
            {exam.last_attempt.released ? 'View results' : 'Submission status'}
          </Link>
        )}
      </div>
      {confirm && (
        <Confirm
          title="Start the examination?"
          confirmLabel={busy ? 'Starting…' : 'Start now'}
          onCancel={() => setConfirm(false)}
          onConfirm={start}
          body={
            <div className="stack">
              {exam.instructions && <p style={{ whiteSpace: 'pre-wrap' }}>{exam.instructions}</p>}
              <ul className="small">
                <li>{exam.n_items} questions{exam.time_limit_minutes ? `, ${Math.round(exam.time_limit_minutes)} minutes. The timer starts now and keeps running if you close the page.` : ', untimed.'}</li>
                <li>Answers save automatically as you go, including if you lose your connection.</li>
                <li>{exam.allow_resume ? 'If interrupted, you can resume from this page.' : 'This exam cannot be resumed once you leave it — complete it in one sitting.'}</li>
                <li>Use the review screen to check flagged and unanswered questions before submitting.</li>
              </ul>
            </div>
          }
        />
      )}
    </div>
  );
}

export function LearnerHome() {
  const { profile } = useAuth();
  const exams = useLoad(() => rpc<MyExam[]>('my_exams'), []);
  const cur = useLoad(() => rpc<any>('my_curriculum', { p_course_slug: 'pocus' }), []);
  const required = (cur.data?.items ?? []).filter((i: any) => i.required);
  const done = required.filter((i: any) => i.completed_at).length;
  const active = (exams.data ?? []).filter((e) => e.state === 'available' || e.state === 'in_progress');
  const ev = useLoad(() => rpc<any[]>('my_evidence'), []);
  const rq = useLoad(() => rpc<any[]>('my_requirements').catch(() => []), []);
  const rqBlock = (rq.data ?? [])[0];
  const rqDone = rqBlock ? completion(rqBlock.rotation.requirements) : null;
  const evReq = (ev.data ?? []).flatMap((b) => b.requirements.filter((r: any) => r.required));
  const evVerified = evReq.filter((r: any) => r.submissions[0]?.status === 'verified').length;
  const evReturned = evReq.filter((r: any) => ['clarification_requested', 'rejected'].includes(r.submissions[0]?.status)).length;
  return (
    <Page kicker="POCUS Rotation" title={`Welcome${profile?.full_name ? `, ${profile.full_name.split(' ')[0]}` : ''}`}
      subtitle="Your curriculum and end-of-block examination">
      {isStaff(profile) && (
        <div className="notice" style={{ marginBottom: 18 }}>
          You have {profile!.role} access. <Link to="/faculty">Open the Faculty Dashboard →</Link>
        </div>
      )}
      <div className="grid two">
        <div className="card" style={{ ['--accent' as any]: 'var(--sky)' }}>
          <p className="kicker">Curriculum</p>
          <div className="stats">
            <div className="stat"><b>{done}/{required.length}</b><span>required resources completed</span></div>
          </div>
          <p className="small muted">Teaching cases, interactive tools and references for the rotation.</p>
          <Link to="/curriculum" className="btn secondary">Open curriculum</Link>
        </div>
        <div className="card" style={{ ['--accent' as any]: 'var(--clay)' }}>
          <p className="kicker">Examinations</p>
          <div className="stats">
            <div className="stat"><b>{active.length}</b><span>open now</span></div>
            <div className="stat"><b>{(exams.data ?? []).filter((e) => e.state === 'completed').length}</b><span>completed</span></div>
          </div>
          <Link to="/exams" className="btn secondary">All examinations</Link>
        </div>
        {rqDone && (
          <div className="card" style={{ ['--accent' as any]: 'var(--petrol)' }} data-testid="home-requirements">
            <p className="kicker">Rotation requirements</p>
            <div className="stats">
              <div className="stat"><b>{rqDone.done}/{rqDone.total}</b><span>complete</span></div>
              <div className="stat"><b>{rqBlock.rotation.scans.verified_total}/{rqBlock.rotation.scans.target_total}</b><span>verified scans</span></div>
            </div>
            {rqBlock.rotation.requirements.some((r: any) => r.status === 'clarification_requested') && <p className="small"><Badge tone="warn">Action needed</Badge> faculty asked for clarification.</p>}
            <Link to="/requirements" className="btn secondary">View requirements</Link>
          </div>
        )}
        {evReq.length > 0 && (
          <div className="card" style={{ ['--accent' as any]: 'var(--moss)' }}>
            <p className="kicker">Learning-case evidence</p>
            <div className="stats">
              <div className="stat"><b>{evVerified}/{evReq.length}</b><span>verified by faculty</span></div>
            </div>
            {evReturned > 0 && <p className="small"><Badge tone="warn">Action needed</Badge> {evReturned} upload(s) returned with a message from faculty.</p>}
            <p className="small muted">Upload proof that you completed your Brightspace learning cases.</p>
            <Link to="/evidence" className="btn secondary">Upload evidence</Link>
          </div>
        )}
      </div>
      <p className="seclabel">Open examinations</p>
      {exams.loading ? <Spinner /> : <ErrorNote error={exams.error} />}
      {!exams.loading && !active.length && <Empty>No examinations are open for you right now.</Empty>}
      <div className="grid">
        {active.map((e) => (
          <ExamCard key={e.assignment_id} exam={e} />
        ))}
      </div>
    </Page>
  );
}

export function ExamsList() {
  const exams = useLoad(() => rpc<MyExam[]>('my_exams'), []);
  return (
    <Page kicker="POCUS Rotation" title="Examinations" subtitle="Assigned end-of-block examinations">
      {exams.loading ? <Spinner /> : <ErrorNote error={exams.error} />}
      {!exams.loading && !exams.data?.length && <Empty>No examinations have been assigned to you yet.</Empty>}
      <div className="grid">
        {(exams.data ?? []).map((e) => (
          <ExamCard key={e.assignment_id} exam={e} />
        ))}
      </div>
    </Page>
  );
}
