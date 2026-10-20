import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase, friendly } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { TopNav } from '../components/Layout';

/**
 * Invitation-only sign-in with a 6-digit email code.
 * A code (rather than a magic link) is used because institutional mail
 * scanners (e.g. Microsoft Safe Links) often pre-open links and burn them.
 */
export function Login() {
  const { session, profile, loading, noAccess, signOut } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Sign in — POCUS Portal';
  }, []);

  if (!loading && session && profile) return <Navigate to="/" replace />;

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setErr(null);
    setInfo(null);
    const addr = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
      setErr('Enter a valid email address.');
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) {
      setErr(
        /invitation-only|403|not allowed|Signups not allowed/i.test(error.message)
          ? 'This address has not been invited to the portal. Ask your course administrator for an invitation.'
          : /rate limit|too many/i.test(error.message)
            ? 'Too many attempts. Please wait a minute before requesting another code.'
            : friendly(error.message),
      );
      return;
    }
    setStage('code');
    setInfo(`We sent a 6-digit sign-in code to ${addr}. It expires in 15 minutes.`);
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: code.trim(), type: 'email' });
    setBusy(false);
    if (error) setErr(/expired|invalid/i.test(error.message) ? 'That code is invalid or has expired. Request a new one.' : friendly(error.message));
  }

  return (
    <>
      <TopNav />
      <div className="login">
        <p className="kicker">POCUS Rotation Portal</p>
        <h1>Sign in</h1>
        <p className="muted">Curriculum, end-of-block examinations and faculty assessment. Access is by invitation.</p>
        {noAccess && (
          <div className="notice warn" style={{ margin: '16px 0' }}>
            You are signed in as {session?.user.email}, but this account has no active portal access.{' '}
            <button className="btn small secondary" onClick={signOut}>Sign out</button>
          </div>
        )}
        <div className="card" style={{ marginTop: 18 }}>
          {stage === 'email' ? (
            <form onSubmit={sendCode} className="stack">
              <label className="field">
                Institutional email
                <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </label>
              <button className="btn" disabled={busy} type="submit">
                {busy ? 'Sending…' : 'Email me a sign-in code'}
              </button>
            </form>
          ) : (
            <form onSubmit={verify} className="stack">
              {info && <div className="notice ok" role="status">{info}</div>}
              <label className="field">
                Sign-in code
                <input
                  className="codeinput"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6,10}"
                  maxLength={10}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                  autoFocus
                  aria-describedby="code-hint"
                />
                <span id="code-hint" className="hint">Check your inbox (and junk folder) for the code.</span>
              </label>
              <button className="btn" disabled={busy || code.length < 6} type="submit">
                {busy ? 'Verifying…' : 'Sign in'}
              </button>
              <div className="row between small">
                <button type="button" className="btn ghost small" onClick={() => { setStage('email'); setCode(''); setInfo(null); }}>
                  ← Use a different email
                </button>
                <button type="button" className="btn ghost small" onClick={() => sendCode()} disabled={busy}>
                  Resend code
                </button>
              </div>
            </form>
          )}
          {err && <div className="notice error" role="alert" style={{ marginTop: 14 }}>{err}</div>}
        </div>
        <p className="small muted" style={{ marginTop: 18 }}>
          The public teaching cases and interactive tools remain open to everyone at <a href="/">pocus-cases.vercel.app</a>.
        </p>
      </div>
    </>
  );
}
