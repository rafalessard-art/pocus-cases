import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { isAdmin, isStaff, useAuth } from '../lib/auth';
import { isDemoDatabase } from '../lib/supabase';

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
  const { profile, signOut } = useAuth();
  const nav = useNavigate();
  return (
    <nav className="topnav" aria-label="Main">
      <div className="topnav-inner">
        <a href="/" className="brand" title="Back to the public case series">POCUS Cases</a>
        {profile && (
          <>
            {/* Faculty and admins land on their dashboard ("/" redirects there), so they get one link, not two. */}
            {isStaff(profile) ? <NavLink to="/faculty">Faculty Dashboard</NavLink> : <NavLink to="/" end>Home</NavLink>}
            <NavLink to="/curriculum">Curriculum</NavLink>
            <NavLink to="/exams">Examinations</NavLink>
            {!isStaff(profile) && <NavLink to="/requirements">Requirements</NavLink>}
            {isAdmin(profile) && <NavLink to="/admin">Admin</NavLink>}
          </>
        )}
        {children}
        <span className="spacer" />
        {profile && (
          <>
            <span className="who" title={profile.email}>
              {profile.full_name || profile.email} · {profile.role}
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
      {isDemoDatabase && (
        <div className="demo-banner" role="note" data-testid="demo-banner">
          Demonstration environment — fictional residents and synthetic documents only. Nothing here is a learner record.
        </div>
      )}
    </nav>
  );
}

export function Layout() {
  return (
    <>
      <TopNav />
      <main id="main">
        <Outlet />
      </main>
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
