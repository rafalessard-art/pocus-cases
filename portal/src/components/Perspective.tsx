import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isOwner, isReviewer, useAuth } from '../lib/auth';
import { rpc } from '../lib/supabase';
import { READ_ONLY_MESSAGE, setView, useView, type Perspective } from '../lib/viewMode';
import { Modal } from './ui';

export type FixtureLearner = { id: string; full_name: string; training_level: string | null; blocks: { id: string; name: string }[] };

export const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'wp3-local';

/** Shown to reviewers, and to the owner on demonstration databases. */
export function usePerspectives() {
  const { profile, access } = useAuth();
  const reviewer = isReviewer(profile);
  const owner = isOwner(access) && !!access?.demo_access_enabled;
  return { reviewer, owner, show: reviewer || owner, preview: !!access?.preview };
}

function useFixtureLearners(enabled: boolean) {
  const [list, setList] = useState<FixtureLearner[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    rpc<FixtureLearner[]>('demo_fixture_learners').then((l) => alive && setList(l)).catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return list;
}

/**
 * The perspective bar: Resident (a fictional resident) / Faculty / Admin, the mode
 * badge and the Feedback button. It changes what is shown, never what is permitted.
 */
export function PerspectiveBar() {
  const { reviewer, owner, show, preview } = usePerspectives();
  const view = useView();
  const nav = useNavigate();
  const loc = useLocation();
  const { refresh } = useAuth();
  const learners = useFixtureLearners(show);
  const [feedback, setFeedback] = useState(false);
  if (!show) return null;

  const go = (p: Perspective, learner?: FixtureLearner) => {
    if (p === 'resident') {
      const l = learner ?? learners?.[0];
      if (!l) return;
      setView({ perspective: 'resident', actingLearner: { id: l.id, name: l.full_name } });
      nav('/');
    } else {
      setView({ perspective: p, actingLearner: null });
      nav(p === 'faculty' ? '/faculty' : '/admin');
    }
  };
  const active: Perspective | null = view.actingLearner ? 'resident' : view.perspective;
  const readOnlyView = reviewer || !!view.actingLearner;

  return (
    <div className={`perspective-bar ${readOnlyView ? 'ro' : ''}`} data-testid="perspective-bar">
      <div className="perspective-inner">
        <span className="mode" data-testid="mode-badge">
          {reviewer && !preview && <>Demonstration · <b>read-only</b> · fictional residents</>}
          {preview && <>Previewing the reviewer experience · <b>read-only</b></>}
          {owner && !preview && (view.actingLearner ? <>Viewing a fictional resident · <b>read-only</b></> : <>Perspectives (demonstration data)</>)}
        </span>
        <div className="seg" role="group" aria-label="Perspective">
          <label className={`seg-item ${active === 'resident' ? 'on' : ''}`}>
            <span>Resident</span>
            <select
              aria-label="Fictional resident"
              data-testid="perspective-resident"
              value={view.actingLearner?.id ?? ''}
              onChange={(e) => {
                const l = learners?.find((x) => x.id === e.target.value);
                if (l) go('resident', l);
              }}
            >
              <option value="" disabled>{learners === null ? 'Loading…' : 'Choose a fictional resident'}</option>
              {(learners ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.full_name}{l.blocks[0] ? ` — ${l.blocks[0].name.replace(/ — fictional residents$/, '')}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={`seg-item ${active === 'faculty' ? 'on' : ''}`} aria-pressed={active === 'faculty'} onClick={() => go('faculty')} data-testid="perspective-faculty">
            Faculty
          </button>
          <button type="button" className={`seg-item ${active === 'admin' ? 'on' : ''}`} aria-pressed={active === 'admin'} onClick={() => go('admin')} data-testid="perspective-admin">
            Admin
          </button>
        </div>
        <span className="spacer" />
        {(reviewer || preview) && (
          <button type="button" className="btn small" onClick={() => setFeedback(true)} data-testid="feedback-open">
            Feedback
          </button>
        )}
        {owner && !preview && !view.actingLearner && (
          <button
            type="button"
            className="btn small secondary"
            data-testid="preview-start"
            onClick={async () => {
              setView({ previewAsReviewer: true, readOnly: true, perspective: null, actingLearner: null });
              await refresh();
              nav('/');
            }}
          >
            Preview as reviewer
          </button>
        )}
        {owner && !preview && view.actingLearner && (
          <button type="button" className="btn small secondary" onClick={() => { setView({ perspective: null, actingLearner: null }); nav('/faculty'); }}>
            Back to my view
          </button>
        )}
        {preview && (
          <button
            type="button"
            className="btn small secondary"
            data-testid="preview-exit"
            onClick={async () => {
              setView({ previewAsReviewer: false, perspective: null, actingLearner: null });
              await refresh();
              nav('/admin/demo-access');
            }}
          >
            Exit preview
          </button>
        )}
      </div>
      {feedback && <FeedbackDialog onClose={() => setFeedback(false)} page={loc.pathname} perspective={active} />}
    </div>
  );
}

const CATEGORIES: [string, string][] = [
  ['works_well', 'Works well'],
  ['confusing', 'Confusing or unclear'],
  ['bug', 'Something looks wrong'],
  ['missing', 'Missing something we need'],
  ['idea', 'Idea or suggestion'],
  ['other', 'Other'],
];

/** Nearest section heading above the middle of the screen, for context. */
function currentSection(): string {
  const hs = Array.from(document.querySelectorAll('main h1, main h2, main h3')) as HTMLElement[];
  let best = '';
  for (const h of hs) if (h.getBoundingClientRect().top < window.innerHeight / 2) best = h.innerText.trim();
  return best.slice(0, 120);
}

export function FeedbackDialog({ onClose, page, perspective }: { onClose: () => void; page: string; perspective: Perspective | null }) {
  const { access, profile } = useAuth();
  const [name, setName] = useState(access?.demo?.display_name ?? profile?.full_name ?? '');
  const [roleLabel, setRoleLabel] = useState('');
  const [section, setSection] = useState(() => currentSection());
  const [category, setCategory] = useState('');
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => first.current?.focus(), []);

  async function send(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await rpc('submit_feedback', {
        p: {
          display_name: name.trim(), role_label: roleLabel.trim(), perspective: perspective ?? '', page, section: section.trim(),
          app_version: APP_VERSION, category, comments: comments.trim(),
        },
      });
      setDone(true);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Feedback" onClose={onClose}>
      {done ? (
        <div className="stack" data-testid="feedback-done">
          <div className="notice ok" role="status">Thank you — your feedback was sent to the portal owner. Only the owner can read it.</div>
          <div className="row"><button className="btn" onClick={onClose}>Close</button></div>
        </div>
      ) : (
        <form className="stack" onSubmit={send} data-allow-readonly data-testid="feedback-form">
          <p className="small muted" style={{ margin: 0 }}>
            About <span className="mono">{page}</span>{perspective ? ` · ${perspective} perspective` : ''}. Please do not include any patient or learner details.
          </p>
          <label className="field">
            What kind of feedback?
            <select ref={first} value={category} onChange={(e) => setCategory(e.target.value)} required data-testid="feedback-category">
              <option value="" disabled>Choose…</option>
              {CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="field">
            Section of the page
            <input type="text" value={section} onChange={(e) => setSection(e.target.value)} maxLength={120} />
          </label>
          <label className="field">
            Comments
            <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={5} maxLength={4000} required data-testid="feedback-comments" />
          </label>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label className="field" style={{ flex: 1, minWidth: 180 }}>
              Your name (as you'd like it shown)
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 180 }}>
              Your role (optional)
              <input type="text" value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} maxLength={80} placeholder="e.g. Program director" />
            </label>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Name and role are self-reported. The date, page, perspective and portal version ({APP_VERSION}) are added automatically.</p>
          {err && <div className="notice error" role="alert">{err}</div>}
          <div className="row">
            <button className="btn" type="submit" disabled={busy || !category || !comments.trim() || !name.trim()} data-testid="feedback-send">
              {busy ? 'Sending…' : 'Send feedback'}
            </button>
            <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** A short note at the top of read-only pages. */
export function ReadOnlyNotice() {
  const view = useView();
  const [dismissed, setDismissed] = useState(false);
  if (!view.readOnly || dismissed) return null;
  return (
    <div className="readonly-note no-print" role="note" data-testid="readonly-note">
      <span>
        {view.actingLearner ? <>You are viewing <b>{view.actingLearner.name}</b>, a fictional resident. </> : null}
        Read-only: buttons that would change anything are switched off.
      </span>
      <button type="button" className="btn ghost small" onClick={() => setDismissed(true)} aria-label="Hide this note">Hide</button>
    </div>
  );
}

/**
 * In read-only mode, stop any form from submitting (the server refuses anyway) and
 * say why — except forms marked data-allow-readonly (feedback).
 */
export function ReadOnlyGuard() {
  const view = useView();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!view.readOnly) return;
    const h = (e: Event) => {
      const f = e.target as HTMLElement | null;
      if (f?.closest('[data-allow-readonly]')) return;
      e.preventDefault();
      e.stopPropagation();
      setMsg(READ_ONLY_MESSAGE);
    };
    document.addEventListener('submit', h, true);
    return () => document.removeEventListener('submit', h, true);
  }, [view.readOnly]);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? <div className="toast" role="status" data-testid="readonly-toast">{msg}</div> : null;
}
