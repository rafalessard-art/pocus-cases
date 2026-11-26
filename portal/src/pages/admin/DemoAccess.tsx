import { useState } from 'react';
import { Page } from '../../components/Layout';
import { Badge, Empty, ErrorNote, Modal, Spinner, fmtDate, useLoad } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { rpc } from '../../lib/supabase';

type Grant = {
  id: string; display_name: string; created_at: string; activated_at: string | null; expires_at: string; revoked_at: string | null;
  revoked_reason: string | null; identity_deleted_at: string | null; active: boolean;
};
type Overview = { enabled: boolean; environment: string | null; code: { id: string; created_at: string; expires_at: string; expired: boolean } | null; grants: Grant[] };
type Feedback = {
  id: string; display_name: string; role_label: string; perspective: string | null; page: string; section: string; app_version: string;
  category: string; comments: string; status: 'new' | 'read' | 'actioned' | 'dismissed'; owner_note: string; created_at: string;
  grant_name: string | null; grant_active: boolean | null;
};

const CATEGORY: Record<string, string> = {
  works_well: 'Works well', confusing: 'Confusing', bug: 'Looks wrong', missing: 'Missing', idea: 'Idea', other: 'Other',
};

/** Owner-only: the shared demonstration code, reviewer grants and the feedback inbox. */
export function DemoAccess() {
  const { access } = useAuth();
  const [tab, setTab] = useState<'access' | 'feedback'>('access');
  const aal2 = access?.aal === 'aal2';
  return (
    <Page kicker="Administration" title="Demonstration access" subtitle="A shared code for program reviewers: read-only, fictional data, feedback only.">
      <div className="tabs" role="tablist" style={{ marginBottom: 18 }}>
        <button role="tab" aria-selected={tab === 'access'} className={tab === 'access' ? 'active' : ''} onClick={() => setTab('access')} data-testid="tab-access">Access code</button>
        <button role="tab" aria-selected={tab === 'feedback'} className={tab === 'feedback' ? 'active' : ''} onClick={() => setTab('feedback')} data-testid="tab-feedback">Feedback inbox</button>
      </div>
      {tab === 'access' ? (aal2 ? <AccessCode /> : (
        <div className="notice warn" data-testid="needs-aal2">
          Managing demonstration access needs a session confirmed with your authenticator app. Sign out and sign in again with your
          authenticator, or add one under Account → Security.
        </div>
      )) : <FeedbackInbox />}
    </Page>
  );
}

function AccessCode() {
  const o = useLoad(() => rpc<Overview>('demo_access_overview'), []);
  const [fresh, setFresh] = useState<{ code: string; expires_at: string; grants_revoked: number } | null>(null);
  const [days, setDays] = useState(30);
  const [confirm, setConfirm] = useState<null | 'rotate' | 'revoke'>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      o.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }
  if (o.loading && !o.data) return <Spinner />;
  if (o.error) return <ErrorNote error={o.error} />;
  const d = o.data!;
  const active = d.grants.filter((g) => g.active);
  return (
    <div className="stack">
      {!d.enabled && <div className="notice warn">Demonstration access is switched off for this database ({d.environment ?? 'no settings'}). Codes cannot be issued or redeemed.</div>}
      <ErrorNote error={err} />
      <div className="card">
        <h3>Current code</h3>
        {d.code ? (
          <p className="small" data-testid="code-status">
            Active since {fmtDate(d.code.created_at)} · expires {fmtDate(d.code.expires_at)} {d.code.expired && <Badge tone="bad">expired</Badge>}
            <br /><span className="muted">The code itself is never stored; only you saw it when it was issued. Issue a new one if it has been lost.</span>
          </p>
        ) : <p className="small muted" data-testid="code-status">No active code. Reviewers cannot sign in until you issue one.</p>}
        {fresh && (
          <div className="notice ok" role="status" style={{ margin: '12px 0' }}>
            <p style={{ margin: '0 0 6px' }}><b>New code — copy it now; it will not be shown again.</b> Share it with reviewers yourself (not by a public link).</p>
            <p className="mono" style={{ fontSize: 22, letterSpacing: '.08em', margin: '6px 0' }} data-testid="new-code">{fresh.code}</p>
            <div className="row">
              <button className="btn small secondary" onClick={async () => { await navigator.clipboard.writeText(fresh.code).catch(() => {}); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</button>
              <button className="btn small ghost" onClick={() => setFresh(null)}>I have saved it — hide</button>
            </div>
            <p className="small muted" style={{ margin: '6px 0 0' }}>Valid until {fmtDate(fresh.expires_at)}. {fresh.grants_revoked} earlier reviewer session(s) ended.</p>
          </div>
        )}
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <label className="field" style={{ margin: 0 }}>
            Valid for (days)
            <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.max(1, Math.min(90, Number(e.target.value) || 30)))} style={{ width: 90 }} />
          </label>
          <button className="btn" disabled={busy || !d.enabled} onClick={() => setConfirm('rotate')} data-testid="rotate-code">{d.code ? 'Issue a new code…' : 'Issue a code…'}</button>
          {d.code && <button className="btn secondary" disabled={busy} onClick={() => setConfirm('revoke')} data-testid="revoke-code">Revoke code…</button>}
        </div>
      </div>

      <div className="card">
        <h3>Reviewer sessions</h3>
        <p className="small muted">Each person who redeems the code gets their own read-only identity. Names are self-reported. Ending a session signs that person out everywhere.</p>
        {d.grants.length === 0 ? <Empty>No reviewer has signed in yet.</Empty> : (
          <table className="data" data-testid="grants">
            <thead><tr><th>Name (self-reported)</th><th>Signed in</th><th>Ends</th><th>Status</th><th /></tr></thead>
            <tbody>
              {d.grants.map((g) => (
                <tr key={g.id}>
                  <td>{g.display_name}</td>
                  <td>{fmtDate(g.activated_at ?? g.created_at)}</td>
                  <td>{fmtDate(g.expires_at, false)}</td>
                  <td>{g.active ? <Badge tone="ok">active</Badge> : <Badge>{g.revoked_reason ?? (new Date(g.expires_at) < new Date() ? 'expired' : 'ended')}</Badge>}</td>
                  <td>{g.active && <button className="btn ghost small" disabled={busy} onClick={() => act(async () => { await rpc('revoke_demo_grant', { p_grant: g.id, p_reason: 'ended by owner' }); })}>End session</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small muted">{active.length} active.</p>
      </div>

      {confirm && (
        <Modal title={confirm === 'rotate' ? 'Issue a new code?' : 'Revoke the code?'} onClose={() => setConfirm(null)}>
          <p>
            {confirm === 'rotate'
              ? `The current code (if any) stops working and every reviewer signed in with it is signed out (${active.length} active). The new code is valid for ${days} days.`
              : `Reviewers can no longer sign in, and all ${active.length} active reviewer session(s) end now.`}
          </p>
          <div className="row">
            <button className="btn" disabled={busy} data-testid="confirm-code-action" onClick={() => act(async () => {
              if (confirm === 'rotate') setFresh(await rpc('rotate_demo_code', { p_valid_days: days }));
              else { await rpc('revoke_demo_code', { p_reason: 'revoked by owner' }); setFresh(null); }
            })}>{confirm === 'rotate' ? 'Issue new code' : 'Revoke'}</button>
            <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function FeedbackInbox() {
  const f = useLoad(() => rpc<Feedback[]>('list_feedback'), []);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  if (f.loading && !f.data) return <Spinner />;
  if (f.error) return <ErrorNote error={f.error} />;
  const rows = (f.data ?? []).filter((x) => filter === 'all' || x.status === 'new' || x.status === 'read');
  async function setStatus(id: string, status: Feedback['status']) {
    setBusy(id);
    setErr(null);
    try {
      await rpc('set_feedback_status', { p_id: id, p_status: status, p_note: null });
      f.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="stack" data-testid="feedback-inbox">
      <div className="row between">
        <p className="small muted" style={{ margin: 0 }}>Only you can read feedback. Reviewers never see each other's submissions.</p>
        <label className="small">Show{' '}
          <select value={filter} onChange={(e) => setFilter(e.target.value as 'open' | 'all')}>
            <option value="open">New and read</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>
      <ErrorNote error={err} />
      {rows.length === 0 ? <Empty>No feedback {filter === 'open' ? 'waiting' : 'yet'}.</Empty> : rows.map((x) => (
        <div className="card flat" key={x.id} data-testid="feedback-item">
          <div className="row between">
            <div>
              <Badge tone={x.category === 'bug' ? 'bad' : x.category === 'works_well' ? 'ok' : 'info'}>{CATEGORY[x.category] ?? x.category}</Badge>{' '}
              <b>{x.display_name}</b>{x.role_label ? ` · ${x.role_label}` : ''}{' '}
              <span className="small muted">· {fmtDate(x.created_at)}</span>
            </div>
            <Badge tone={x.status === 'new' ? 'warn' : x.status === 'actioned' ? 'ok' : undefined}>{x.status}</Badge>
          </div>
          <p style={{ whiteSpace: 'pre-wrap', margin: '10px 0' }}>{x.comments}</p>
          <p className="small muted" style={{ margin: 0 }}>
            {x.perspective ? `${x.perspective} perspective · ` : ''}<span className="mono">{x.page || '—'}</span>{x.section ? ` · “${x.section}”` : ''} · version {x.app_version || '—'}
            {x.grant_name && x.grant_name !== x.display_name ? ` · signed in as “${x.grant_name}”` : ''}
          </p>
          {x.owner_note && <p className="small">Note: {x.owner_note}</p>}
          <div className="row" style={{ marginTop: 8 }}>
            {x.status === 'new' && <button className="btn ghost small" disabled={busy === x.id} onClick={() => setStatus(x.id, 'read')}>Mark read</button>}
            {x.status !== 'actioned' && <button className="btn ghost small" disabled={busy === x.id} onClick={() => setStatus(x.id, 'actioned')}>Actioned</button>}
            {x.status !== 'dismissed' && <button className="btn ghost small" disabled={busy === x.id} onClick={() => setStatus(x.id, 'dismissed')}>Dismiss</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
