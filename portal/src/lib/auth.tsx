import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { getView, resetView, setView, useView } from './viewMode';

export type Role = 'learner' | 'faculty' | 'admin' | 'reviewer';
export type Profile = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  training_level: string | null;
  program: string | null;
  active: boolean;
};

/**
 * What the database says this session may do (public.my_access). Used only to
 * shape the interface; every permission is enforced in the database.
 */
export type Access = {
  /** Effective role: null when the session has no access (e.g. MFA required, reviewer access ended). */
  role: Role | null;
  profile_role: Role | null;
  aal: 'aal1' | 'aal2';
  admin_mfa_required: boolean;
  environment: string | null;
  /** Demonstration access is switched on for this database (never in production). */
  demo_access_enabled?: boolean;
  /** The owner is previewing the reviewer experience (requests carry the preview header). */
  preview?: boolean;
  demo: { display_name: string; expires_at: string } | null;
};

type AuthState = {
  loading: boolean;
  session: Session | null;
  profile: Profile | null;
  access: Access | null;
  /** The account has a verified authenticator and this session hasn't used it yet. */
  mfaChallengeNeeded: boolean;
  /** An administrator whose environment requires MFA, with no authenticator enrolled yet. */
  mfaEnrollmentNeeded: boolean;
  /** Signed in but without an active invitation-backed profile, or with access that has ended. */
  noAccess: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [aal, setAal] = useState<{ current: string | null; next: string | null }>({ current: null, next: null });
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null);
      setAccess(null);
      setAal({ current: null, next: null });
      return;
    }
    const [{ data }, acc, lvl] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle(),
      supabase.rpc('my_access'),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    const a = acc.error ? null : (acc.data as Access);
    // In the owner's reviewer preview the database answers as a reviewer; show the reviewer interface.
    setProfile(data && data.active ? ({ ...(data as Profile), role: a?.role === 'reviewer' ? 'reviewer' : (data as Profile).role }) : null);
    setAccess(a);
    if (a && a.role !== 'reviewer' && getView().previewAsReviewer) setView({ previewAsReviewer: false });
    setAal({ current: lvl.data?.currentLevel ?? null, next: lvl.data?.nextLevel ?? null });
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      await loadProfile(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED' || event === 'MFA_CHALLENGE_VERIFIED') {
        // defer to avoid calling supabase inside the callback (documented deadlock)
        setTimeout(() => loadProfile(s).finally(() => setLoading(false)), 0);
      }
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  // Read-only whenever a reviewer (or the owner's preview) is signed in, or the owner is viewing a fictional resident.
  const view = useView();
  const readOnly = profile?.role === 'reviewer' || view.previewAsReviewer || !!view.actingLearner;
  useEffect(() => {
    if (getView().readOnly !== readOnly) setView({ readOnly });
  }, [readOnly]);

  const mfaChallengeNeeded = !!session && aal.next === 'aal2' && aal.current !== 'aal2';
  const mfaEnrollmentNeeded =
    !!session && !mfaChallengeNeeded && access?.profile_role === 'admin' && access.admin_mfa_required && access.aal !== 'aal2';
  const value: AuthState = {
    loading,
    session,
    profile,
    access,
    mfaChallengeNeeded,
    mfaEnrollmentNeeded,
    noAccess: !loading && !!session && !mfaChallengeNeeded && !mfaEnrollmentNeeded && (!profile || (!!access && access.role === null)),
    refresh: () => loadProfile(session),
    signOut: async () => {
      await supabase.auth.signOut();
      resetView();
      setProfile(null);
      setAccess(null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
export const isStaff = (p: Profile | null) => p?.role === 'faculty' || p?.role === 'admin';
export const isAdmin = (p: Profile | null) => p?.role === 'admin';
export const isReviewer = (p: Profile | null) => p?.role === 'reviewer';
/** The signed-in person is the owner (an administrator), whatever view they are in. */
export const isOwner = (a: Access | null) => a?.profile_role === 'admin';
