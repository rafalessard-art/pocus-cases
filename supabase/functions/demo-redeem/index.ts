// Supabase Edge Function entry point (Deno). Logic and its security notes: ./handler.ts
// Deploy only to the development demo or the review project — never to production
// (the database refuses demonstration access there in any case).
//
// Environment (set by Supabase automatically, except the last):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   DEMO_ALLOWED_ORIGINS  comma-separated portal origins, e.g. https://<review-deployment>.vercel.app
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { handle } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const allowedOrigins = (Deno.env.get('DEMO_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const hmacKey = crypto.subtle.importKey('raw', new TextEncoder().encode(serviceKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

Deno.serve((req) =>
  handle(req, {
    allowedOrigins,
    rpc: async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args ?? {});
      return { data, error: error ? { message: error.message } : null };
    },
    createUser: async (email) => {
      const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
      return error || !data.user ? null : data.user.id;
    },
    deleteUser: async (id) => {
      await admin.auth.admin.deleteUser(id);
    },
    generateToken: async (email) => {
      // generateLink creates the token without sending any email.
      const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      return error ? null : (data.properties?.hashed_token ?? null);
    },
    hashIp: async (ip) => {
      const sig = await crypto.subtle.sign('HMAC', await hmacKey, new TextEncoder().encode(ip));
      return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
    },
    logStage: (stage) => console.error(`demo-redeem: ${stage}`),
  }),
);
