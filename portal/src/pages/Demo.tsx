import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Page } from '../components/Layout';
import { MediaView } from '../components/MediaView';
import { usePerspectives, type FixtureLearner } from '../components/Perspective';
import { Badge, ErrorNote, Spinner, useLoad } from '../components/ui';
import { useAuth } from '../lib/auth';
import { rpc } from '../lib/supabase';
import { setView } from '../lib/viewMode';

/** Landing page for demonstration reviewers (and the owner's reviewer preview). */
export function ReviewerHome() {
  const { access, profile } = useAuth();
  const { preview } = usePerspectives();
  const nav = useNavigate();
  const learners = useLoad(() => rpc<FixtureLearner[]>('demo_fixture_learners'), []);
  const exams = useLoad(async () => {
    const first = learners.data?.[0];
    return first ? rpc<{ exam_version_id: string; title: string }[]>('my_exams', { p_as_learner: first.id }) : [];
  }, [learners.data?.[0]?.id]);
  const name = access?.demo?.display_name ?? profile?.full_name ?? '';
  const walkthrough = exams.data?.[0];

  return (
    <Page kicker="Demonstration access" title={`Welcome${name ? `, ${name}` : ''}`}
      subtitle={<>A read-only demonstration of the POCUS rotation portal with <b>fictional residents and synthetic documents</b>. Nothing here is a learner record.</>}>
      <div className="notice" style={{ marginBottom: 20 }} data-testid="reviewer-intro">
        Choose a perspective. Perspectives change what you see, not what you can do: everything is read-only, and the only thing you
        can send is feedback (the <b>Feedback</b> button, top right, on any page).
        {access?.demo?.expires_at && !preview ? ` Your access ends ${new Date(access.demo.expires_at).toLocaleDateString('en-CA')}.` : ''}
      </div>
      <div className="grid">
        <div className="card">
          <h3>Resident</h3>
          <p className="muted small">What a resident sees: requirements, scan logbook, learning-case evidence, examinations and results.</p>
          {learners.loading ? <Spinner /> : learners.error ? <ErrorNote error={learners.error} /> : (
            <ul className="choice-list" data-testid="resident-choices">
              {(learners.data ?? []).map((l) => (
                <li key={l.id}>
                  <button className="btn ghost small" onClick={() => { setView({ perspective: 'resident', actingLearner: { id: l.id, name: l.full_name } }); nav('/'); }}>
                    {l.full_name}
                  </button>{' '}
                  <span className="small muted">{l.training_level ?? ''}{l.blocks[0] ? ` · ${l.blocks[0].name.replace(/ — fictional residents$/, '')}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h3>Faculty</h3>
          <p className="muted small">Block overviews, evidence review, scan attestation, EPA verification and ITER drafting for fictional blocks.</p>
          <button className="btn" onClick={() => { setView({ perspective: 'faculty', actingLearner: null }); nav('/faculty'); }} data-testid="open-faculty">Open the Faculty view</button>
        </div>
        <div className="card">
          <h3>Admin</h3>
          <p className="muted small">Examination set-up, the question bank, media library, people and rotation settings (demonstration content only).</p>
          <button className="btn" onClick={() => { setView({ perspective: 'admin', actingLearner: null }); nav('/admin'); }} data-testid="open-admin">Open the Admin view</button>
        </div>
      </div>
      <div className="card flat" style={{ marginTop: 20 }}>
        <h3>Examination walkthrough</h3>
        <p className="muted small">
          Step through the demonstration examination (synthetic questions using simulator loops) as a resident would, then see how feedback looks.
          No attempt is recorded and no results change.
        </p>
        {walkthrough ? (
          <Link className="btn secondary" to={`/demo/walkthrough/${walkthrough.exam_version_id}`} data-testid="open-walkthrough">Start the walkthrough</Link>
        ) : exams.loading ? <Spinner /> : <p className="small muted">No demonstration examination is available.</p>}
      </div>
      <p className="small muted" style={{ marginTop: 20 }}>
        Settings shown in the portal (pass marks, scan targets, number of attempts, requirement wording) are <b>Draft placeholders</b> pending
        program decisions — they are not program policy. Elentra remains the EPA system of record and One45 the ITER submission platform.
      </p>
    </Page>
  );
}

type WItem = {
  item_id: string; number: number; section: string | null; type: 'single' | 'multiple' | 'short_answer' | string; stem: string; points: number;
  options: { id: string; text: string }[]; key: { correct?: string[]; model_answer?: string } | null; explanation: string | null; domain_key: string | null;
  media: { path: string; kind: 'video' | 'image'; mime?: string; width?: number; height?: number; frame_rate?: number; caption?: string }[];
};
type Walk = { exam_version_id: string; title: string; instructions: string; time_limit_minutes: number | null; pass_threshold_pct: number | null; items: WItem[] };

const LETTERS = 'ABCDEFGHIJ';

/**
 * Demonstration exam walkthrough: answers stay in this page only. Nothing is sent
 * to the server except the read of the demonstration questions themselves.
 */
export function DemoWalkthrough() {
  const { versionId = '' } = useParams();
  const w = useLoad(() => rpc<Walk>('preview_exam_version', { p_exam_version: versionId }), [versionId]);
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[] | string>>({});
  const [done, setDone] = useState(false);
  const items = w.data?.items ?? [];
  const score = useMemo(() => {
    let earned = 0;
    let possible = 0;
    let pending = 0;
    for (const it of items) {
      possible += Number(it.points);
      const a = answers[it.item_id];
      if (it.type === 'short_answer') { pending += 1; continue; }
      const sel = new Set(Array.isArray(a) ? a : []);
      const correct = new Set(it.key?.correct ?? []);
      if (it.type === 'single') earned += sel.size === 1 && correct.has([...sel][0]) ? Number(it.points) : 0;
      else {
        const right = [...sel].filter((x) => correct.has(x)).length;
        const wrong = [...sel].filter((x) => !correct.has(x)).length;
        earned += correct.size ? Math.max(0, (right - wrong) / correct.size) * Number(it.points) : 0;
      }
    }
    return { earned: Math.round(earned * 100) / 100, possible, pending };
  }, [answers, items]);

  if (w.loading) return <Spinner />;
  if (w.error) return <div className="wrap"><ErrorNote error={w.error} /></div>;
  const exam = w.data!;
  const it = items[i];

  if (done) {
    const pctv = score.possible ? (100 * score.earned) / score.possible : 0;
    return (
      <Page kicker="Demonstration walkthrough · nothing recorded" title={exam.title} subtitle="How the result and feedback look to a resident (full-review feedback)" narrow>
        <div className="card" data-testid="walkthrough-result">
          <h3>Your walkthrough result: {pctv.toFixed(0)}%{score.pending ? ' (before faculty grade the short answer)' : ''}</h3>
          <p className="muted small">
            {score.earned} of {score.possible} points. Draft pass mark shown to residents: {exam.pass_threshold_pct ?? '—'}% (a placeholder, not program policy).
            In the real portal, faculty release results after reviewing short answers.
          </p>
        </div>
        {items.map((q) => {
          const a = answers[q.item_id];
          return (
            <div className="card flat" key={q.item_id} style={{ marginTop: 14 }}>
              <p className="small muted" style={{ margin: 0 }}>Question {q.number}</p>
              <p><b>{q.stem}</b></p>
              {q.type === 'short_answer' ? (
                <p className="small">Your answer: {typeof a === 'string' && a ? a : '—'}<br />Model answer: {q.key?.model_answer ?? '—'}</p>
              ) : (
                <ul className="choice-list small">
                  {q.options.map((o, k) => {
                    const chosen = Array.isArray(a) && a.includes(o.id);
                    const right = q.key?.correct?.includes(o.id);
                    return (
                      <li key={o.id}>
                        {LETTERS[k]}. {o.text} {right && <Badge tone="ok">correct</Badge>} {chosen && !right && <Badge tone="bad">your answer</Badge>} {chosen && right && <Badge tone="info">your answer</Badge>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {q.explanation && <p className="small muted">{q.explanation}</p>}
            </div>
          );
        })}
        <div className="row" style={{ marginTop: 18 }}>
          <button className="btn secondary" onClick={() => { setDone(false); setI(0); setAnswers({}); }}>Start again</button>
          <Link className="btn ghost" to="/">Back to the demonstration</Link>
        </div>
      </Page>
    );
  }

  return (
    <Page kicker="Demonstration walkthrough · nothing recorded" title={exam.title} subtitle={`Question ${i + 1} of ${items.length}`} narrow>
      {i === 0 && <div className="notice" style={{ marginBottom: 16 }}>{exam.instructions}</div>}
      {it && (
        <div className="card" data-testid="walkthrough-question">
          <p><b>{it.stem}</b></p>
          <MediaView media={it.media} label={`Question ${it.number}`} />
          {it.type === 'short_answer' ? (
            <label className="field">
              Your answer
              <textarea rows={3} value={(answers[it.item_id] as string) ?? ''} onChange={(e) => setAnswers({ ...answers, [it.item_id]: e.target.value })} />
            </label>
          ) : (
            <fieldset className="options" role={it.type === 'single' ? 'radiogroup' : 'group'}>
              <legend className="small muted" style={{ marginBottom: 6 }}>{it.type === 'single' ? 'Select the single best answer.' : 'Select all that apply.'}</legend>
              {it.options.map((o, k) => {
                const sel = (answers[it.item_id] as string[] | undefined) ?? [];
                const on = sel.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    role={it.type === 'single' ? 'radio' : 'checkbox'}
                    aria-checked={on}
                    className={`opt ${it.type === 'multiple' ? 'multi' : ''} ${on ? 'selected' : ''}`}
                    onClick={() => setAnswers({ ...answers, [it.item_id]: it.type === 'single' ? [o.id] : on ? sel.filter((x) => x !== o.id) : [...sel, o.id] })}
                    data-testid={`walk-option-${k}`}
                  >
                    <span className="letter" aria-hidden>{LETTERS[k]}</span>
                    <span>{o.text}</span>
                  </button>
                );
              })}
            </fieldset>
          )}
        </div>
      )}
      <div className="row between" style={{ marginTop: 16 }}>
        <button className="btn secondary" disabled={i === 0} onClick={() => setI(i - 1)}>← Previous</button>
        {i < items.length - 1
          ? <button className="btn" onClick={() => setI(i + 1)} data-testid="walkthrough-next">Next →</button>
          : <button className="btn" onClick={() => setDone(true)} data-testid="walkthrough-finish">Finish and see feedback</button>}
      </div>
    </Page>
  );
}
