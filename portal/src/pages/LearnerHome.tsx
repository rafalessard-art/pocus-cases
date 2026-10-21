import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page } from '../components/Layout';
import { Badge, Confirm, Empty, ErrorNote, Spinner, fmtDate, useLoad } from '../components/ui';
import { isStaff, useAuth } from '../lib/auth';
import { NextSteps } from '../components/NextSteps';
import { rpc } from '../lib/supabase';
import { caseStates, type Requirement } from '../lib/itar';

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

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
  const rq = useLoad(() => rpc<any[]>('my_requirements').catch(() => []), []);
  const rqBlock = (rq.data ?? [])[0];
  const ev = useLoad(() => rpc<{ cohort: { id: string }; requirements: Requirement[] }[]>('my_evidence').catch(() => []), []);
  const cases = caseStates((ev.data ?? []).find((x) => x.cohort.id === rqBlock?.cohort.id)?.requirements ?? (ev.data ?? [])[0]?.requirements ?? []);
  const casesVerified = cases.filter((c) => c.state === 'verified').length;
  // required curriculum items that are the Brightspace learning cases are tracked by verified uploads, not self-ticks
  const caseTitles = new Set(cases.map((c) => norm(c.title)));
  const otherRequired = required.filter((i: any) => !caseTitles.has(norm(i.title)));
  return (
    <Page kicker="POCUS Rotation" title={`Welcome${profile?.full_name ? `, ${profile.full_name.replace(/^(Dr\.?|Prof\.?)\s+/i, '').split(' ')[0]}` : ''}`}
      subtitle="Your POCUS rotation requirements, examination and curriculum">
      {isStaff(profile) && (
        <div className="notice" style={{ marginBottom: 18 }}>
          You have {profile!.role} access. <Link to="/faculty">Open the Faculty Dashboard →</Link>
        </div>
      )}
      {rqBlock && (
        <>
          <p className="seclabel" style={{ marginTop: 0 }}>{rqBlock.cohort.course} · {rqBlock.cohort.name}</p>
          <NextSteps rotation={rqBlock.rotation} openExam={active.length > 0} cases={cases} />
        </>
      )}
      <div className="grid two">
        <div className="card" style={{ ['--accent' as any]: 'var(--sky)' }}>
          <p className="kicker">Curriculum</p>
          <div className="stats">
            {cases.length > 0
              ? <div className="stat" data-testid="curriculum-cases"><b>{casesVerified}/{cases.length}</b><span>required learning cases verified</span></div>
              : <div className="stat"><b>{done}/{required.length}</b><span>required resources completed</span></div>}
            {cases.length > 0 && otherRequired.length > 0 && <div className="stat"><b>{otherRequired.filter((i: any) => i.completed_at).length}/{otherRequired.length}</b><span>other required resources</span></div>}
          </div>
          <p className="small muted">
            {cases.length > 0
              ? 'The required learning cases are the same cases you complete in Brightspace; they count once faculty verify your upload. Interactive tools and references are optional.'
              : 'Teaching cases, interactive tools and references for the rotation.'}
          </p>
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
