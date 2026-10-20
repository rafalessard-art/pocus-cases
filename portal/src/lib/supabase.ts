import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) as string | undefined;

/** True when the build was given Supabase settings (see docs/exam-platform/DEPLOYMENT.md). */
export const configured = Boolean(url && anonKey);
export const supabaseUrl = url ?? '';
export const supabaseAnonKey = anonKey ?? '';

export const supabase: SupabaseClient = configured
  ? createClient(url!, anonKey!, {
      // Sign-in works with either the 6-digit code or the emailed link. Implicit
      // flow means the link works even when opened in a different browser or
      // device from the one that requested it.
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit', storageKey: 'pocus-portal-auth' },
    })
  : (null as unknown as SupabaseClient);

/** A throwaway client for sending a sign-in email on someone else's behalf. */
export function sideClient(): SupabaseClient {
  return createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: 'pocus-side' } });
}

export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Call a Postgres function and unwrap errors into readable messages. */
export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new ApiError(friendly(error.message), error.code);
  return data as T;
}

export function friendly(msg: string): string {
  if (/JWT expired|invalid JWT/i.test(msg)) return 'Your session expired. Please sign in again.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Network unavailable. Check your connection and try again.';
  return msg;
}

export const MEDIA_BUCKET = 'exam-media';
