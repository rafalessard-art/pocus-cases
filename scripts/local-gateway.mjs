#!/usr/bin/env node
/**
 * Local test gateway — used by `npm run visual` (scripts/visual-report.mjs).
 *
 * Serves the built site (dist/) and forwards the Supabase API paths to a LOCAL
 * Supabase stack on the same origin, the way Vercel + Supabase look to the
 * browser in the real deployment. It also exposes /__mail/messages?to=<email>,
 * which turns the local mail catcher (Mailpit, started by `supabase start`) into
 * the [{ text, at }] list the end-to-end tests read sign-in codes from.
 *
 * Local only: it refuses to forward to anything that is not localhost.
 * It never runs on Vercel and is not part of the deployed site.
 */
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;
export function assertLocalUrl(what, value) {
  let host = '';
  try { host = new URL(value).hostname; } catch { throw new Error(`${what} is not a valid URL: ${value}`); }
  if (!LOCAL.test(host)) throw new Error(`${what} points at ${host}. The visual report only runs against a local stack.`);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm',
};
const API_PREFIXES = ['/auth/v1', '/rest/v1', '/storage/v1'];

/**
 * @param {object} o
 * @param {string} o.dist      built site folder
 * @param {string} o.api       local Supabase API URL (e.g. http://127.0.0.1:54321), paths forwarded unchanged
 * @param {Record<string,string>} [o.services]  optional per-prefix upstreams with the prefix stripped
 *                             (e.g. { '/auth/v1': 'http://127.0.0.1:9999' }) for stacks without Kong
 * @param {string} [o.mailpit] Mailpit base URL (e.g. http://127.0.0.1:54324)
 * @param {number} [o.port]
 */
export async function startGateway({ dist, api, services = {}, mailpit, port = 4173, host = '127.0.0.1' }) {
  const root = resolve(dist);
  if (!existsSync(join(root, 'app', 'index.html'))) throw new Error(`${root} has no app/index.html — build the site first.`);
  if (api) assertLocalUrl('Supabase API URL', api);
  for (const [p, u] of Object.entries(services)) assertLocalUrl(`${p} upstream`, u);
  if (mailpit) assertLocalUrl('Mailpit URL', mailpit);
  const rewrites = vercelRewrites();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/__mail/messages') return await mail(url, res, mailpit);
      const prefix = API_PREFIXES.find((p) => url.pathname === p || url.pathname.startsWith(p + '/'));
      if (prefix) return proxy(req, res, url, prefix, services[prefix], api, port);
      return serveStatic(root, url.pathname, rewrites, res);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e?.stack ?? e));
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok({ url: `http://${host}:${port}`, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

function proxy(req, res, url, prefix, service, api, port) {
  let target;
  if (service) {
    const base = new URL(service);
    target = new URL(base.origin);
    target.pathname = base.pathname.replace(/\/$/, '') + (url.pathname.slice(prefix.length) || '/');
  } else {
    target = new URL(url.pathname, api);
  }
  target.search = url.search;
  const headers = { ...req.headers, host: target.host, 'x-forwarded-host': req.headers.host, 'x-forwarded-proto': 'http', 'x-forwarded-port': String(port) };
  if (service) headers['x-forwarded-prefix'] = prefix;
  const up = http.request(target, { method: req.method, headers }, (r) => {
    const h = { ...r.headers };
    // keep resumable-upload and redirect locations on this origin
    if (h.location) {
      try {
        const loc = new URL(h.location, target);
        if (LOCAL.test(loc.hostname) && loc.port === target.port) h.location = (service ? prefix : '') + loc.pathname + loc.search;
      } catch { /* leave as is */ }
    }
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`local Supabase not reachable at ${target.origin}: ${e.message}`); });
  req.pipe(up);
}

/** Mailpit → [{ text, at }] (oldest first), the shape tests/e2e/lifecycle.spec.ts reads. */
async function mail(url, res, mailpit) {
  if (!mailpit) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('no mail catcher configured'); }
  const to = url.searchParams.get('to') ?? '';
  const q = new URL('/api/v1/search', mailpit);
  q.searchParams.set('query', `to:"${to}"`);
  q.searchParams.set('limit', '25');
  const list = await (await fetch(q)).json();
  const out = [];
  for (const m of list.messages ?? []) {
    const full = await (await fetch(new URL(`/api/v1/message/${m.ID}`, mailpit))).json();
    out.push({ text: full.Text || full.HTML || '', at: Date.parse(m.Created ?? full.Date) });
  }
  out.sort((a, b) => a.at - b.at);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
}

function vercelRewrites() {
  try {
    const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    return (v.rewrites ?? []).filter((r) => !r.source.includes(':')).map((r) => [r.source, r.destination]);
  } catch { return []; }
}

function serveStatic(root, pathname, rewrites, res) {
  let p = decodeURIComponent(pathname);
  const rw = rewrites.find(([s]) => s === p);
  if (rw) p = rw[1];
  if (p === '/app' || p.startsWith('/app/')) {
    const f = safe(root, p);
    if (!f || !isFile(f)) p = '/app/index.html'; // single-page app
  }
  let file = safe(root, p);
  if (file && !isFile(file) && isFile(join(file, 'index.html'))) file = join(file, 'index.html');
  if (!file || !isFile(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}
function safe(root, p) {
  const f = normalize(join(root, p));
  return f === root || f.startsWith(root + sep) ? f : null;
}
function isFile(f) { try { return statSync(f).isFile(); } catch { return false; } }

// `node scripts/local-gateway.mjs` — serve dist/ against `supabase start` for manual browsing.
if (import.meta.url === `file://${process.argv[1]}`) {
  const api = process.env.LOCAL_SUPABASE_URL ?? 'http://127.0.0.1:54321';
  const mailpit = process.env.LOCAL_MAILPIT_URL ?? 'http://127.0.0.1:54324';
  const g = await startGateway({ dist: new URL('../dist', import.meta.url).pathname, api, mailpit, port: Number(process.env.PORT ?? 4173) });
  console.log(`local portal: ${g.url}/app/  (API → ${api}, mail → ${mailpit})`);
}
