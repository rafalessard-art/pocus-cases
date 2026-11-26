import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { isAdmin, isReviewer, isStaff, useAuth } from '../lib/auth';
import { isDemoDatabase } from '../lib/supabase';
import { useView } from '../lib/viewMode';
import { PerspectiveBar, ReadOnlyGuard, ReadOnlyNotice } from './Perspective';

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => {
        const next = !dark;
        setDark(next);
        try {
          localStorage.setItem('pocus-theme', next ? 'dark' : 'light');
        } catch {
          /* ignore */
        }
      }}
    >
      {dark ? '☀️' : '🌙'}
    </button>
  );
}

export function TopNav({ children }: { children?: ReactNode }) {
  const { profile: signedIn, signOut, mfaChallengeNeeded, noAccess } = useAuth();
  // Until the authenticator step is done, show no portal navigation at all.
  const profile = mfaChallengeNeeded ? null : signedIn;
  const nav = useNavigate();
  const view = useView();
  const residentNav = !!profile && (!!view.actingLearner || !isStaff(profile)) && (!isReviewer(profile) || !!view.actingLearner);
  return (
    <nav className="topnav" aria-label="Main">
      <div className="topnav-inner">
        <a href="/" className="brand" title="Back to the public case series">POCUS Cases</a>
        {profile && isReviewer(profile) && !view.actingLearner && (
          <>
            <NavLink to="/" end>Demonstration</NavLink>
            {view.perspective === 'faculty' && <NavLink to="/faculty">Faculty Dashboard</NavLink>}
            {view.perspective === 'admin' && <NavLink to="/admin">Admin</NavLink>}
          </>
        )}
        {residentNav && (
          <>
            <NavLink to="/" end>Home</NavLink>
            <NavLink to="/curriculum">Curriculum</NavLink>
            <NavLink to="/exams">Examinations</NavLink>
            <NavLink to="/requirements">Requirements</NavLink>
          </>
        )}
        {profile && !isReviewer(profile) && !residentNav && (
          <>
            {/* Faculty and admins land on their dashboard ("/" redirects there), so they get one link, not two. */}
            <NavLink to="/faculty">Faculty Dashboard</NavLink>
            <NavLink to="/curriculum">Curriculum</NavLink>
            <NavLink to="/exams">Examinations</NavLink>
            {isAdmin(profile) && <NavLink to="/admin">Admin</NavLink>}
          </>
        )}
        {children}
        <span className="spacer" />
        {profile && (
          <>
            {!isReviewer(profile) && <NavLink to="/account">Account</NavLink>}
            <span className="who" title={isReviewer(profile) ? 'Self-reported name' : profile.email}>
              {profile.full_name || profile.email} · {isReviewer(profile) ? 'reviewer (read-only)' : profile.role}
            </span>
            <button
              className="navbtn"
              onClick={async () => {
                await signOut();
                nav('/login');
              }}
            >
              Sign out
            </button>
          </>
        )}
        <ThemeToggle />
      </div>
      {profile && !noAccess && <PerspectiveBar />}
      {(isDemoDatabase || (isReviewer(profile) && !noAccess)) && (
        <div className="demo-banner" role="note" data-testid="demo-banner">
          Demonstration environment — fictional residents and synthetic documents only. Nothing here is a learner record.
        </div>
      )}
    </nav>
  );
}

export function Layout() {
  const view = useView();
  return (
    <>
      <TopNav />
      <main id="main">
        <ReadOnlyNotice />
        {/* a different fictional resident is a different page: reload everything */}
        <Fragment key={view.actingLearner?.id ?? 'me'}>
          <Outlet />
        </Fragment>
      </main>
      <ReadOnlyGuard />
    </>
  );
}

export function Page({ kicker, title, subtitle, actions, children, narrow }: {
  kicker?: string; title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; narrow?: boolean;
}) {
  useEffect(() => {
    document.title = `${title} — POCUS Portal`;
  }, [title]);
  return (
    <div className={`wrap ${narrow ? 'narrow' : ''}`}>
      <header className="masthead">
        <div className="row between" style={{ alignItems: 'flex-end' }}>
          <div>
            {kicker && <p className="kicker">{kicker}</p>}
            <h1>{title}</h1>
            {subtitle && <p className="subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="row no-print">{actions}</div>}
        </div>
      </header>
      {children}
    </div>
  );
}
