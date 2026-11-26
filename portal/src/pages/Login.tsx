import { useEffect, useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase, friendly } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { TopNav } from '../components/Layout';
import { demoAccessEnabled, redeemDemoCode } from '../lib/demoAccess';

/**
 * Invitation-only sign-in: a 6-digit email code, or a password for accounts
 * that have set one (Account → Security). Accounts with an authenticator app
 * then confirm with it (see Mfa.tsx).
 * A code (rather than a magic link) is used because institutional mail
 * scanners (e.g. Microsoft Safe Links) often pre-open links and burn them.
 */
export function Login() {
  const { session, profile, loading, noAccess, signOut } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code' | 'password'>('email');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Sign in — POCUS Portal';
  }, []);

  if (!loading && session && profile && !noAccess) return <Navigate to="/" replace />;

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
    const { error } = await supabase.auth.signInWithOtp({
      email: addr,
      options: { shouldCreateUser: true, emailRedirectTo: `${window.location.origin}/app/` },
    });
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
    setInfo(`We sent a sign-in email to ${addr}. Click the link in it, or enter the 6-digit code if the email shows one.`);
  }

  async function signInWithPassword(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    setBusy(false);
    setPassword('');
    if (error) {
      setErr(
        /invalid login credentials/i.test(error.message)
          ? 'Email or password not recognised. Use the email code instead if you have not set a password.'
          : /rate limit|too many/i.test(error.message)
            ? 'Too many attempts. Please wait a minute and try again.'
            : friendly(error.message),
      );
    }
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
        {/(^|&)error_description=/.test(window.location.hash.slice(1)) && (
          <div className="notice error" role="alert">
            That sign-in link is invalid or has expired (some email security scanners open links before you do). Request a new one below.
          </div>
        )}
        {noAccess && /@demo\.invalid$/.test(session?.user.email ?? '') && (
          <div className="notice warn" style={{ margin: '16px 0' }} data-testid="demo-ended">
            Your demonstration access has ended — it expired, was ended by the portal owner, or the access code was changed.
            Ask the person who invited you for the current code.{' '}
            <button className="btn small secondary" onClick={signOut}>Sign out</button>
          </div>
        )}
        {noAccess && !/@demo\.invalid$/.test(session?.user.email ?? '') && (
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
              <button type="button" className="btn ghost small" onClick={() => { setErr(null); setStage('password'); }} data-testid="use-password">
                Sign in with a password instead
              </button>
            </form>
          ) : stage === 'password' ? (
            <form onSubmit={signInWithPassword} className="stack" data-testid="password-form">
              <label className="field">
                Institutional email
                <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </label>
              <label className="field">
                Password
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
              </label>
              <button className="btn" disabled={busy || password.length < 12} type="submit">
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <button type="button" className="btn ghost small" onClick={() => { setErr(null); setPassword(''); setStage('email'); }}>
                ← Use an email code instead
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
                <span id="code-hint" className="hint">Check your inbox (and junk folder). You can also simply click the sign-in link in the email.</span>
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
        {demoAccessEnabled && <DemoSignIn />}
        <p className="small muted" style={{ marginTop: 18 }}>
          The public teaching cases and interactive tools remain open to everyone at <a href="/">pocus-cases.vercel.app</a>.
        </p>
      </div>
    </>
  );
}

/**
 * Demonstration reviewers: a name (self-reported) and the shared access code. No
 * email; each sign-in gets its own read-only identity. Compiled in only for
 * demonstration builds (VITE_DEMO_ACCESS=true).
 */
function DemoSignIn() {
  const { session, signOut } = useAuth();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (session) await signOut(); // an ended demonstration session, for instance
      await redeemDemoCode(name, code);
      setCode('');
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card" style={{ marginTop: 18, ['--accent' as any]: 'var(--clay)' }} data-testid="demo-signin">
      <h3>Demonstration reviewers</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Read-only access to a demonstration with fictional residents. Enter your name and the access code you were given — no email needed.
      </p>
      <form className="stack" onSubmit={go}>
        <label className="field">
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoComplete="name" data-testid="demo-name" />
        </label>
        <label className="field">
          Access code
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required autoComplete="off" spellCheck={false}
            className="mono" placeholder="XXXX-XXXX-XXXX-XXXX" maxLength={24} data-testid="demo-code" />
        </label>
        <button className="btn" type="submit" disabled={busy || !name.trim() || code.replace(/[^A-Za-z0-9]/g, '').length < 16} data-testid="demo-submit">
          {busy ? 'Checking…' : 'Enter the demonstration'}
        </button>
        {err && <div className="notice error" role="alert" data-testid="demo-error">{err}</div>}
      </form>
    </div>
  );
}
