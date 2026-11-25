import { friendly, supabase, supabaseAnonKey, supabaseUrl } from './supabase';

/**
 * Demonstration (reviewer) sign-in. Compiled in only when the build sets
 * VITE_DEMO_ACCESS=true; production builds never do (scripts/build-site.mjs),
 * and production databases refuse it regardless.
 */
export const demoAccessEnabled = import.meta.env.VITE_DEMO_ACCESS === 'true';

const MESSAGES: Record<string, string> = {
  invalid_code: 'That access code is not valid. Check it and try again.',
  invalid_name: 'Enter your name (up to 80 characters).',
  invalid_request: 'Enter your name and the access code.',
  rate_limited: 'Too many attempts. Please wait 15 minutes and try again.',
  retry: 'Access codes were just changed. Please try again with the current code.',
  unavailable: 'Demonstration access is not available right now.',
  forbidden_origin: 'Demonstration access is not available from this address.',
};

export function demoErrorMessage(code: string | undefined): string {
  return (code && MESSAGES[code]) || MESSAGES.unavailable;
}

/**
 * Exchange { name, code } for a session. The code goes only to the
 * demo-redeem function over HTTPS (never in a URL); the returned one-time
 * token is used immediately and never stored or shown.
 */
export async function redeemDemoCode(name: string, code: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${supabaseUrl}/functions/v1/demo-redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: supabaseAnonKey },
      body: JSON.stringify({ name: name.trim(), code: code.trim() }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    throw new Error(friendly('Failed to fetch'));
  }
  const body = (await res.json().catch(() => ({}))) as { token_hash?: string; error?: string };
  if (!res.ok || !body.token_hash) throw new Error(demoErrorMessage(body.error));
  const { error } = await supabase.auth.verifyOtp({ token_hash: body.token_hash, type: 'email' });
  if (error) throw new Error(demoErrorMessage('unavailable'));
}
