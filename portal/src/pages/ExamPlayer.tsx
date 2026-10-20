import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MediaView, type MediaRef } from '../components/MediaView';
import { Confirm, ErrorNote, Spinner } from '../components/ui';
import { AutosaveQueue, type Answer, type SaveStatus } from '../lib/autosave';
import { prefetch, signedUrls } from '../lib/media';
import { rpc, supabase, supabaseAnonKey, supabaseUrl } from '../lib/supabase';

type Option = { id: string; text: string };
type Item = {
  item_id: string; number: number; section: string; type: 'single' | 'multiple' | 'short_answer' | 'hotspot';
  stem: string; points: number; options: Option[]; media: MediaRef[];
};
type AttemptData = {
  id: string; status: string; title: string; instructions: string; attempt_no: number;
  started_at: string; deadline_at: string | null; server_now: string;
  items: Item[]; responses: { item_id: string; response: any; flagged: boolean; seq: number }[];
};
type Ans = { response: any; flagged: boolean };

const LETTERS = 'ABCDEFGHIJKLMNOP';

function isAnswered(a?: Ans) {
  if (!a || a.response == null) return false;
  if (Array.isArray(a.response.selected)) return a.response.selected.length > 0;
  if (typeof a.response.text === 'string') return a.response.text.trim().length > 0;
  return !!a.response.point;
}

function fmtClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}

export function ExamPlayer() {
  const { attemptId = '' } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<AttemptData | null>(null);
  const [error, setError] = useState<unknown>();
  const [answers, setAnswers] = useState<Record<string, Ans>>({});
  const [idx, setIdx] = useState(0);
  const [view, setView] = useState<'question' | 'review'>('question');
  const [save, setSave] = useState<{ s: SaveStatus; pending: number; at?: number; error?: string }>({ s: 'idle', pending: 0 });
  const [confirm, setConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [restoredCount, setRestoredCount] = useState(0);
  const queue = useRef<AutosaveQueue | null>(null);
  const offset = useRef(0);
  const finishing = useRef(false);
  const tokenRef = useRef<string | null>(null);

  const finish = useCallback(
    async (reason: 'learner' | 'time' | 'server') => {
      if (finishing.current) return;
      finishing.current = true;
      setSubmitting(true);
      try {
        if (reason !== 'server') {
          await queue.current?.flush();
          if (queue.current && queue.current.pendingCount > 0 && reason === 'learner') {
            finishing.current = false;
            setSubmitting(false);
            setSubmitErr('Some answers have not reached the server yet. Check your connection, then try submitting again.');
            return;
          }
          await rpc('submit_attempt', { p_attempt: attemptId });
        }
        queue.current?.close();
        nav(`/exams/result/${attemptId}`, { replace: true, state: { justSubmitted: true, reason } });
      } catch (e) {
        finishing.current = false;
        setSubmitting(false);
        setSubmitErr(e instanceof Error ? e.message : String(e));
      }
    },
    [attemptId, nav],
  );

  // Load attempt + set up autosave
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await rpc<AttemptData>('get_attempt', { p_attempt: attemptId });
        if (!alive) return;
        if (d.status !== 'in_progress') {
          nav(`/exams/result/${attemptId}`, { replace: true });
          return;
        }
        offset.current = new Date(d.server_now).getTime() - Date.now();
        const init: Record<string, Ans> = {};
        const seqs: Record<string, number> = {};
        let maxSeq = 0;
        for (const r of d.responses) {
          init[r.item_id] = { response: r.response, flagged: r.flagged };
          seqs[r.item_id] = Number(r.seq);
          maxSeq = Math.max(maxSeq, Number(r.seq));
        }
        const q = new AutosaveQueue(
          {
            attemptId,
            storage: (() => {
              try {
                return window.localStorage;
              } catch {
                return null;
              }
            })(),
            send: async (items: Answer[]) => {
              const res = await rpc<{ status: 'in_progress' | 'submitted'; reason?: string }>('save_responses', { p_attempt: attemptId, p_items: items });
              return res;
            },
            beacon: (items: Answer[]) => {
              if (!tokenRef.current) return;
              void fetch(`${supabaseUrl}/rest/v1/rpc/save_responses`, {
                method: 'POST',
                keepalive: true,
                headers: { 'content-type': 'application/json', apikey: supabaseAnonKey, authorization: `Bearer ${tokenRef.current}` },
                body: JSON.stringify({ p_attempt: attemptId, p_items: items }),
              }).catch(() => {});
            },
            onStatus: (s, info) => setSave({ s, pending: info?.pending ?? 0, at: info?.lastSavedAt, error: info?.error }),
            onClosed: () => void finish('server'),
          },
          maxSeq,
        );
        const restored = q.restore(seqs);
        for (const a of restored) init[a.item_id] = { response: a.response, flagged: a.flagged };
        setRestoredCount(restored.length);
        queue.current = q;
        setAnswers(init);
        setData(d);
        // warm signed URLs for all clips now (RLS allows while the attempt is open)
        const paths = d.items.flatMap((i) => i.media.map((m) => m.path));
        if (paths.length) signedUrls(paths).catch(() => {});
      } catch (e) {
        if (alive) setError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [attemptId, nav, finish]);

  // keep the current access token for keepalive beacons
  useEffect(() => {
    supabase.auth.getSession().then(({ data: s }) => (tokenRef.current = s.session?.access_token ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => (tokenRef.current = s?.access_token ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // network + page lifecycle
  useEffect(() => {
    const online = () => void queue.current?.flush();
    const hide = () => {
      if (document.visibilityState === 'hidden') {
        queue.current?.beacon();
      }
    };
    const pagehide = () => queue.current?.beacon();
    const before = (e: BeforeUnloadEvent) => {
      if (queue.current && queue.current.pendingCount > 0) {
        queue.current.beacon();
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('beforeunload', before);
    return () => {
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('beforeunload', before);
    };
  }, []);

  // clock
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const remaining = data?.deadline_at ? new Date(data.deadline_at).getTime() - (now + offset.current) : null;
  useEffect(() => {
    if (remaining !== null && remaining <= 0 && data && !finishing.current) void finish('time');
  }, [remaining, data, finish]);

  // prefetch the next question's clips
  useEffect(() => {
    if (!data) return;
    const next = data.items[idx + 1];
    if (next?.media.length) {
      signedUrls(next.media.map((m) => m.path))
        .then((u) => prefetch(Object.values(u)))
        .catch(() => {});
    }
  }, [idx, data]);

  const items = data?.items ?? [];
  const item = items[idx];
  const answeredCount = useMemo(() => items.filter((i) => isAnswered(answers[i.item_id])).length, [items, answers]);
  const flaggedCount = useMemo(() => items.filter((i) => answers[i.item_id]?.flagged).length, [items, answers]);

  const update = useCallback((itemId: string, patch: Partial<Ans>) => {
    setAnswers((prev) => {
      const cur = prev[itemId] ?? { response: null, flagged: false };
      const next = { ...cur, ...patch };
      queue.current?.set(itemId, next.response, next.flagged);
      return { ...prev, [itemId]: next };
    });
  }, []);

  const choose = useCallback(
    (it: Item, optId: string) => {
      const cur = answers[it.item_id]?.response?.selected ?? [];
      let sel: string[];
      if (it.type === 'single') sel = cur[0] === optId ? [] : [optId];
      else sel = cur.includes(optId) ? cur.filter((x: string) => x !== optId) : [...cur, optId];
      update(it.item_id, { response: sel.length ? { selected: sel } : null });
    },
    [answers, update],
  );

  // letter keys select options
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (view !== 'question' || !item || !item.options.length) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || (e.target as HTMLElement)?.closest?.('.usplayer')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const i = LETTERS.indexOf(e.key.toUpperCase());
      if (i >= 0 && i < item.options.length) {
        e.preventDefault();
        choose(item, item.options[i].id);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [view, item, choose]);

  if (error) {
    return (
      <div className="wrap narrow">
        <ErrorNote error={error} />
        <p><Link to="/exams">← Back to examinations</Link></p>
      </div>
    );
  }
  if (!data) return <Spinner label="Loading examination…" />;

  const saveLabel =
    save.s === 'saving' ? 'Saving…'
      : save.s === 'offline' ? `Offline — ${save.pending} answer${save.pending === 1 ? '' : 's'} kept on this device`
        : save.s === 'error' ? 'Save failed — retrying'
          : save.s === 'saved' ? 'All answers saved'
            : 'Answers save automatically';

  const goto = (i: number) => {
    setIdx(Math.max(0, Math.min(items.length - 1, i)));
    setView('question');
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="exam-shell">
      <header className="exam-bar">
        <div className="exam-bar-inner">
          <div className="exam-title">{data.title}</div>
          <span className={`savestate ${save.s}`} role="status" aria-live="polite" data-testid="save-status">
            <span className="dot" aria-hidden /> {saveLabel}
          </span>
          {remaining !== null && (
            <span className={`timer ${remaining < 5 * 60e3 ? 'low' : ''}`} aria-label="Time remaining" data-testid="timer">
              {fmtClock(remaining)}
            </span>
          )}
          <button className="btn secondary small" onClick={() => setView('review')}>Review &amp; submit</button>
        </div>
        <div className="progress" aria-hidden>
          <span style={{ width: `${(answeredCount / Math.max(1, items.length)) * 100}%` }} />
        </div>
      </header>

      <div className="exam-body">
        <aside className="navigator" aria-label="Question navigator">
          <p className="small muted" style={{ margin: '0 0 8px' }}>
            {answeredCount} of {items.length} answered{flaggedCount ? ` · ${flaggedCount} flagged` : ''}
          </p>
          <div className="navgrid">
            {items.map((it, i) => {
              const a = answers[it.item_id];
              return (
                <button
                  key={it.item_id}
                  className={[isAnswered(a) ? 'answered' : '', a?.flagged ? 'flagged' : '', view === 'question' && i === idx ? 'current' : ''].join(' ')}
                  onClick={() => goto(i)}
                  aria-label={`Question ${i + 1}${isAnswered(a) ? ', answered' : ', unanswered'}${a?.flagged ? ', flagged' : ''}`}
                  aria-current={view === 'question' && i === idx ? 'step' : undefined}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>
          <div className="legend">
            <span>■ <span style={{ color: 'var(--sky)' }}>Answered</span></span>
            <span><span style={{ color: 'var(--clay)' }}>●</span> Flagged for review</span>
          </div>
          {restoredCount > 0 && (
            <div className="notice small" style={{ marginTop: 12 }}>
              Restored {restoredCount} answer{restoredCount === 1 ? '' : 's'} saved on this device.
            </div>
          )}
        </aside>

        <main>
          {view === 'question' && item && (
            <article className="question" aria-labelledby="qtitle">
              <div className="qhead">
                <span className="qnum" id="qtitle">
                  Question {idx + 1} of {items.length}
                  {item.section ? ` · ${item.section}` : ''}
                </span>
                <button
                  className={`btn secondary small flagbtn ${answers[item.item_id]?.flagged ? 'on' : ''}`}
                  aria-pressed={!!answers[item.item_id]?.flagged}
                  onClick={() => update(item.item_id, { flagged: !answers[item.item_id]?.flagged })}
                >
                  {answers[item.item_id]?.flagged ? '⚑ Flagged' : '⚐ Flag for review'}
                </button>
              </div>
              <p className="stem">{item.stem}</p>
              <MediaView media={item.media} label={`Question ${idx + 1}`} />
              {(item.type === 'single' || item.type === 'multiple') && (
                <fieldset className="options" role={item.type === 'single' ? 'radiogroup' : 'group'} aria-labelledby="qtitle">
                  <legend className="small muted" style={{ marginBottom: 6 }}>
                    {item.type === 'single' ? 'Select the single best answer.' : 'Select all that apply.'}
                  </legend>
                  {item.options.map((o, i) => {
                    const sel = (answers[item.item_id]?.response?.selected ?? []).includes(o.id);
                    return (
                      <button
                        key={o.id}
                        type="button"
                        role={item.type === 'single' ? 'radio' : 'checkbox'}
                        aria-checked={sel}
                        className={`opt ${item.type === 'multiple' ? 'multi' : ''} ${sel ? 'selected' : ''}`}
                        onClick={() => choose(item, o.id)}
                        data-testid={`option-${i}`}
                      >
                        <span className="letter" aria-hidden>{LETTERS[i]}</span>
                        <span>{o.text}</span>
                      </button>
                    );
                  })}
                </fieldset>
              )}
              {item.type === 'short_answer' && (
                <label className="field">
                  Your answer
                  <textarea
                    rows={6}
                    maxLength={10000}
                    value={answers[item.item_id]?.response?.text ?? ''}
                    onChange={(e) => update(item.item_id, { response: e.target.value ? { text: e.target.value } : null })}
                    data-testid="short-answer"
                  />
                </label>
              )}
              {item.type === 'hotspot' && <div className="notice warn">This question type is not yet supported in the player.</div>}
              <div className="qfoot">
                <button className="btn secondary" onClick={() => goto(idx - 1)} disabled={idx === 0}>← Previous</button>
                {idx < items.length - 1 ? (
                  <button className="btn" onClick={() => goto(idx + 1)}>Next →</button>
                ) : (
                  <button className="btn" onClick={() => setView('review')}>Review answers →</button>
                )}
              </div>
            </article>
          )}

          {view === 'review' && (
            <section className="question" aria-labelledby="rtitle">
              <h2 id="rtitle">Review before submitting</h2>
              <p className="muted">
                {answeredCount} of {items.length} answered.{' '}
                {items.length - answeredCount > 0 && <strong>{items.length - answeredCount} unanswered.</strong>}{' '}
                {flaggedCount > 0 && <span>{flaggedCount} flagged.</span>}
              </p>
              <div className="tablewrap">
                <table className="data">
                  <thead>
                    <tr><th>#</th><th>Question</th><th>Status</th><th /></tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => {
                      const a = answers[it.item_id];
                      return (
                        <tr key={it.item_id}>
                          <td>{i + 1}</td>
                          <td>{it.stem.length > 110 ? `${it.stem.slice(0, 110)}…` : it.stem}</td>
                          <td>
                            {isAnswered(a) ? <span className="badge ok">Answered</span> : <span className="badge bad">Unanswered</span>}{' '}
                            {a?.flagged && <span className="badge warn">Flagged</span>}
                          </td>
                          <td><button className="btn ghost small" onClick={() => goto(i)}>Go to</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {submitErr && <div className="notice error" role="alert" style={{ marginTop: 14 }}>{submitErr}</div>}
              <div className="qfoot">
                <button className="btn secondary" onClick={() => setView('question')}>← Back to questions</button>
                <button className="btn" onClick={() => setConfirm(true)} disabled={submitting} data-testid="submit-exam">
                  Submit examination
                </button>
              </div>
            </section>
          )}
        </main>
      </div>

      {confirm && (
        <Confirm
          title="Submit your examination?"
          confirmLabel={submitting ? 'Submitting…' : 'Submit'}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void finish('learner');
          }}
          body={
            <p>
              You have answered {answeredCount} of {items.length} questions
              {items.length - answeredCount > 0 ? ` (${items.length - answeredCount} unanswered)` : ''}. After submitting you cannot change your
              answers.
            </p>
          }
        />
      )}
      {submitting && (
        <div className="modal-backdrop"><div className="modal"><Spinner label="Submitting…" /></div></div>
      )}
    </div>
  );
}

