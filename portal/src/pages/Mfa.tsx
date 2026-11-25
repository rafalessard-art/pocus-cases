import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { Factor } from '@supabase/supabase-js';
import { TopNav } from '../components/Layout';
import { Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { friendly, supabase } from '../lib/supabase';

/** Second step of sign-in for accounts with an authenticator app (TOTP). */
export function MfaChallenge() {
  const { loading, session, mfaChallengeNeeded, refresh, signOut } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [factorId, setFactorId] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Confirm sign-in — POCUS Portal';
    supabase.auth.mfa.listFactors().then(({ data }) => {
      const verified = (data?.totp ?? []).filter((f) => f.status === 'verified');
      setFactors(verified);
      if (verified[0]) setFactorId(verified[0].id);
    });
  }, []);

  if (loading) return <Spinner />;
  if (!session) return <Navigate to="/login" replace />;
  if (!mfaChallengeNeeded) return <Navigate to={(loc.state as any)?.from ?? '/'} replace />;

  async function verify(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    setCode('');
    if (error) {
      setErr(/invalid|expired/i.test(error.message) ? 'That code is not valid. Check the time on your phone and try the current code.' : friendly(error.message));
      return;
    }
    await refresh();
    nav((loc.state as any)?.from ?? '/', { replace: true });
  }

  return (
    <>
      <TopNav />
      <div className="login">
        <p className="kicker">POCUS Rotation Portal</p>
        <h1>Confirm it's you</h1>
        <p className="muted">Enter the 6-digit code from your authenticator app.</p>
        <div className="card" style={{ marginTop: 18 }}>
          {factors === null ? (
            <Spinner />
          ) : (
            <form onSubmit={verify} className="stack" data-testid="mfa-form">
              {factors.length > 1 && (
                <label className="field">
                  Authenticator
                  <select value={factorId} onChange={(e) => setFactorId(e.target.value)}>
                    {factors.map((f) => <option key={f.id} value={f.id}>{f.friendly_name || 'Authenticator app'}</option>)}
                  </select>
                </label>
              )}
              <label className="field">
                Code
                <input
                  className="codeinput"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                  autoFocus
                />
              </label>
              <button className="btn" disabled={busy || code.length !== 6 || !factorId} type="submit">
                {busy ? 'Checking…' : 'Confirm'}
              </button>
              <p className="small muted">
                Lost access to this authenticator? Choose your second authenticator above if you added one. Otherwise follow the
                recovery steps in the private operations notes (the account owner removes the factor from the Supabase dashboard).
              </p>
              <button type="button" className="btn ghost small" onClick={signOut}>Sign out</button>
            </form>
          )}
          {err && <div className="notice error" role="alert" style={{ marginTop: 14 }}>{err}</div>}
        </div>
      </div>
    </>
  );
}
