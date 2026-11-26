import { useState, type FormEvent } from 'react';
import type { Factor } from '@supabase/supabase-js';
import { Page } from '../components/Layout';
import { Badge, Confirm, ErrorNote, Spinner, fmtDate, useLoad } from '../components/ui';
import { useAuth } from '../lib/auth';
import { friendly, rpc, supabase } from '../lib/supabase';

const MIN_PASSWORD = 12;

/** Account → Security: password, authenticator apps, and (admins) the MFA requirement. */
export function AccountSecurity() {
  const { access, profile, mfaEnrollmentNeeded, refresh } = useAuth();
  const factors = useLoad(async () => {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) throw error;
    return (data?.all ?? []).filter((f) => f.factor_type === 'totp') as Factor[];
  }, []);
  const verified = (factors.data ?? []).filter((f) => f.status === 'verified');

  return (
    <Page kicker="Account" title="Security" narrow subtitle={profile?.email}>
      {mfaEnrollmentNeeded && (
        <div className="notice warn" role="alert" style={{ marginBottom: 16 }}>
          Administrator access in this environment requires an authenticator app. Add one below, then sign out and back in.
        </div>
      )}
      <div className="stack">
        <PasswordCard />
        <section className="card" data-testid="mfa-card">
          <h3>Authenticator apps</h3>
          <p className="muted small">
            After a password or email code, you'll be asked for a 6-digit code from the app. Add <strong>two</strong> (for example your phone and your
            password manager): there are no recovery codes, so the second one is your backup.
          </p>
          <p className="small">
            This session: <Badge tone={access?.aal === 'aal2' ? 'ok' : 'info'}>{access?.aal === 'aal2' ? 'confirmed with authenticator' : 'password or email code only'}</Badge>
          </p>
          {factors.loading ? <Spinner /> : <ErrorNote error={factors.error} />}
          {verified.length > 0 && (
            <ul className="stack" style={{ paddingLeft: 18 }}>
              {verified.map((f) => (
                <FactorRow key={f.id} factor={f} canRemove={access?.aal === 'aal2'} onChange={() => { factors.reload(); refresh(); }} />
              ))}
            </ul>
          )}
          <EnrollTotp existing={verified.length} onDone={() => { factors.reload(); refresh(); }} />
        </section>
        {access?.profile_role === 'admin' && <AdminMfaRequirement verifiedFactors={verified.length} />}
      </div>
    </Page>
  );
}

function PasswordCard() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [nonce, setNonce] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (pw.length < MIN_PASSWORD) return setMsg({ tone: 'error', text: `Use at least ${MIN_PASSWORD} characters.` });
    if (pw !== pw2) return setMsg({ tone: 'error', text: 'The two passwords do not match.' });
    setBusy(true);
    const { error } = await supabase.auth.updateUser(nonce ? { password: pw, nonce } : { password: pw });
    setBusy(false);
    if (error) {
      if (/reauthenticat/i.test(error.message) || (error as any).code === 'reauthentication_needed') {
        await supabase.auth.reauthenticate();
        setNonce('');
        return setMsg({ tone: 'warn', text: 'For security, we emailed you a confirmation code. Enter it below and save again.' });
      }
      return setMsg({ tone: 'error', text: /weak|pwned|leaked/i.test(error.message) ? 'Choose a stronger password.' : friendly(error.message) });
    }
    setPw('');
    setPw2('');
    setNonce(null);
    setMsg({ tone: 'ok', text: 'Password saved. You can now sign in with your email and this password.' });
  }

  return (
    <section className="card" data-testid="password-card">
      <h3>Password</h3>
      <p className="muted small">Optional for faculty; recommended for administrators, together with an authenticator app. Use a password manager.</p>
      <form onSubmit={save} className="stack">
        <div className="field-labelled">
          <label htmlFor="new-password">New password</label>
          <input id="new-password" type="password" autoComplete="new-password" aria-describedby="new-password-hint" value={pw} onChange={(e) => setPw(e.target.value)} minLength={MIN_PASSWORD} required />
          <span className="hint" id="new-password-hint">At least {MIN_PASSWORD} characters.</span>
        </div>
        <label className="field">
          Repeat new password
          <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} required />
        </label>
        {nonce !== null && (
          <label className="field">
            Confirmation code from the email
            <input inputMode="numeric" autoComplete="one-time-code" value={nonce} onChange={(e) => setNonce(e.target.value.replace(/\D/g, ''))} required />
          </label>
        )}
        <button className="btn" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save password'}</button>
      </form>
      {msg && <div className={`notice ${msg.tone}`} role={msg.tone === 'error' ? 'alert' : 'status'} style={{ marginTop: 12 }}>{msg.text}</div>}
    </section>
  );
}

function FactorRow({ factor, canRemove, onChange }: { factor: Factor; canRemove: boolean; onChange: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState<unknown>();
  return (
    <li>
      <strong>{factor.friendly_name || 'Authenticator app'}</strong> <span className="muted small">added {fmtDate(factor.created_at, false)}</span>{' '}
      <button className="btn ghost small" disabled={!canRemove} title={canRemove ? '' : 'Confirm this session with an authenticator first'} onClick={() => setConfirm(true)}>
        Remove
      </button>
      <ErrorNote error={err} />
      {confirm && (
        <Confirm
          title="Remove this authenticator?"
          body="You won't be able to use it to sign in. Keep at least one other authenticator if administrator access requires MFA."
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            setConfirm(false);
            const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
            if (error) setErr(new Error(friendly(error.message)));
            else onChange();
          }}
        />
      )}
    </li>
  );
}

function EnrollTotp({ existing, onDone }: { existing: number; onDone: () => void }) {
  const [pending, setPending] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [name, setName] = useState(existing ? 'Backup authenticator' : 'Phone');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function start() {
    setErr(null);
    setBusy(true);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `${name} ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (error || !data) return setErr(friendly(error?.message ?? 'Could not start'));
    setPending({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function cancel() {
    if (pending) await supabase.auth.mfa.unenroll({ factorId: pending.id }).catch(() => {});
    setPending(null);
    setCode('');
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setErr(null);
    setBusy(true);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: pending.id, code: code.trim() });
    setBusy(false);
    setCode('');
    if (error) return setErr(/invalid|expired/i.test(error.message) ? 'That code is not valid. Try the current code from the app.' : friendly(error.message));
    setPending(null);
    onDone();
  }

  if (!pending) {
    return (
      <div className="row" style={{ marginTop: 12 }}>
        <label className="field" style={{ flex: '1 1 200px' }}>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
        <button className="btn secondary" disabled={busy || !name.trim()} onClick={start} data-testid="mfa-add">
          {existing ? 'Add a backup authenticator' : 'Add an authenticator app'}
        </button>
        {err && <div className="notice error" role="alert">{err}</div>}
      </div>
    );
  }
  return (
    <form onSubmit={verify} className="stack" style={{ marginTop: 12 }} data-testid="mfa-enroll">
      <p className="small">Scan this with your authenticator app, or enter the key by hand. Then type the 6-digit code it shows.</p>
      <img src={pending.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ background: '#fff', padding: 8, borderRadius: 8 }} />
      <p className="small">Key: <span className="mono" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{pending.secret}</span></p>
      <label className="field">
        Code from the app
        <input className="codeinput" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus />
      </label>
      <div className="row">
        <button className="btn" disabled={busy || code.length !== 6} type="submit">{busy ? 'Checking…' : 'Confirm and add'}</button>
        <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
      </div>
      {err && <div className="notice error" role="alert">{err}</div>}
    </form>
  );
}

/**
 * The staged switch: once on, administrator privileges need an authenticator-confirmed
 * session everywhere (enforced in the database). Only an aal2 session can change it.
 */
function AdminMfaRequirement({ verifiedFactors }: { verifiedFactors: number }) {
  const { access, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const on = !!access?.admin_mfa_required;
  const aal2 = access?.aal === 'aal2';
  const ready = aal2 && verifiedFactors >= 2;
  return (
    <section className="card" data-testid="admin-mfa-card">
      <h3>Require an authenticator for administrators</h3>
      <p className="muted small">
        When on, every administrator privilege in this environment — pages, data and server functions — needs a session confirmed with an authenticator app.
        Turn it on only after you've signed in with each of your two authenticators and tested the recovery steps.
      </p>
      <p>Status: <Badge tone={on ? 'ok' : 'warn'}>{on ? 'Required' : 'Not required'}</Badge></p>
      {!aal2 && <p className="small">Confirm this session with an authenticator (sign out and back in) to change this setting.</p>}
      {aal2 && !on && verifiedFactors < 2 && <p className="small">Add a second authenticator first.</p>}
      <button
        className={`btn ${on ? 'secondary' : ''}`}
        disabled={busy || !aal2 || (!on && !ready)}
        onClick={async () => {
          setErr(undefined);
          setBusy(true);
          try {
            await rpc('set_admin_mfa_required', { p_on: !on });
            await refresh();
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {on ? 'Stop requiring it' : 'Require it'}
      </button>
      <ErrorNote error={err} />
    </section>
  );
}
