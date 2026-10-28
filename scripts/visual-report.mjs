#!/usr/bin/env node
/**
 * npm run visual — one command for a screenshot report of the main resident and
 * faculty screens, made from the existing end-to-end test (tests/e2e) on a LOCAL
 * Supabase stack with fictional data only.
 *
 *   1. finds the local stack (`supabase status`) and refuses anything not on localhost
 *   2. resets the LOCAL database (migrations + seed) unless --no-reset
 *   3. builds the site against the local stack
 *   4. serves it with scripts/local-gateway.mjs (site + API + mail on one origin)
 *   5. runs the Playwright suite, saving a screenshot at each step
 *   6. writes visual-report/index.html, grouped by screen, and opens it (--open)
 *
 * Other options:
 *   --report-only   rebuild the page from the last run's screenshots, nothing else
 *   --no-open       don't open the report when finished (default on macOS: open)
 *
 * Needs: Docker (Docker Desktop, OrbStack or Colima) and the Supabase CLI, with
 * `supabase start` already run in this folder. See docs/exam-platform/TESTING.md.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalUrl, startGateway } from './local-gateway.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'visual-report');
const shotsDir = join(outDir, 'shots');
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.VISUAL_PORT ?? 4173);

/** The screens Rafa asked for, mapped to the screenshots tests/e2e/lifecycle.spec.ts takes. */
export const SECTIONS = [
  ['Resident dashboard', [
    ['r1-resident-next-steps', 'Home — “Your next steps”'],
    ['r2-curriculum-cases', 'Curriculum — Brightspace cases'],
  ]],
  ['Resident requirements and scans', [
    ['09c-resident-requirements', 'Rotation requirements and scan self-report'],
    ['09b-resident-evidence', 'My evidence — uploads'],
    ['r3-upload-deep-link', 'Upload link for a missing case'],
  ]],
  ['Resident exam interface', [
    ['06-exam-player', 'Exam player'],
    ['06b-exam-player-mobile', 'Exam player — phone width'],
    ['07-offline-autosave', 'Offline: answers saved on the device'],
    ['08-review-screen', 'Review before submitting'],
    ['09-submitted', 'Submitted'],
    ['13-learner-results', 'Released results'],
  ]],
  ['Faculty dashboard', [
    ['12-faculty-dashboard', 'Faculty dashboard — “Needs your attention”'],
    ['12a-block-overview', 'Block overview'],
    ['12e-block-complete', 'Block overview after approval'],
  ]],
  ['Faculty learner workspace', [
    ['12b-evidence-preview', 'Evidence preview and verification'],
    ['12b2-requirements', 'Rotation requirements and scan attestation'],
    ['12c2-full-evidence-record', 'Full Evidence Record'],
  ]],
  ['Exam management', [
    ['01-invitations', 'People — invitations'],
    ['02-media-library', 'Media library'],
    ['03-media-governance', 'Media authorization and de-identification'],
    ['04-question-editor', 'Question editor with clips'],
    ['05-exam-builder', 'Exam builder'],
    ['10-attempt-review', 'Attempt review and grading'],
    ['11-exam-results', 'Exam results'],
  ]],
  ['ITER Quick Copy', [
    ['12c-iter-quick-copy', 'ITER Quick Copy — draft'],
    ['12d-iter-approved', 'Draft approved — ready for One45'],
    ['12f-post-approval-flag', 'After approval — new evidence flagged'],
  ]],
];

function sh(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}
function supabaseCli() {
  const probe = spawnSync('supabase', ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? ['supabase'] : ['npx', '--yes', 'supabase'];
}
function gitInfo() {
  const g = (a) => { try { return sh('git', a).trim(); } catch { return ''; } };
  return { branch: g(['rev-parse', '--abbrev-ref', 'HEAD']), commit: g(['log', '-1', '--format=%h %s']) };
}

/** Local stack endpoints: explicit env vars win, otherwise `supabase status`. */
function localStack() {
  let env = {};
  const explicit = process.env.LOCAL_SUPABASE_URL;
  if (!explicit) {
    const [cmd, ...pre] = supabaseCli();
    let out = '';
    try { out = sh(cmd, [...pre, 'status', '-o', 'env']); } catch {
      throw new Error('The local Supabase stack is not running. Start Docker, then run `supabase start` in this folder (first time: a few minutes).');
    }
    env = Object.fromEntries(out.split('\n').map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  }
  const s = {
    api: explicit ?? env.API_URL,
    anonKey: process.env.LOCAL_SUPABASE_ANON_KEY ?? env.ANON_KEY ?? env.PUBLISHABLE_KEY,
    db: process.env.DATABASE_URL ?? env.DB_URL,
    mailpit: process.env.LOCAL_MAILPIT_URL ?? env.MAILPIT_URL ?? env.INBUCKET_URL,
    viaCli: !explicit,
  };
  for (const [k, v] of Object.entries({ 'Supabase API URL': s.api, 'database URL': s.db, 'mail catcher URL': s.mailpit })) {
    if (!v) throw new Error(`Could not find the local ${k}.`);
    assertLocalUrl(k, v);
  }
  if (!s.anonKey) throw new Error('Could not find the local anon key.');
  return s;
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function writeReport({ passed, startedAt, finishedAt, note } = {}) {
  const have = new Set(existsSync(shotsDir) ? readdirSync(shotsDir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)) : []);
  const used = new Set();
  const { branch, commit } = gitInfo();
  const status = passed === undefined ? '' : passed
    ? '<span class="pill ok">Tests passed</span>'
    : '<span class="pill bad">Tests failed — see the Playwright report</span>';
  const sections = SECTIONS.map(([title, shots], i) => {
    const cards = shots.map(([name, caption]) => {
      used.add(name);
      return have.has(name)
        ? `<figure><a href="shots/${name}.png" target="_blank"><img loading="lazy" src="shots/${name}.png" alt="${esc(caption)}"></a><figcaption>${esc(caption)}</figcaption></figure>`
        : `<figure class="missing"><div>Not captured in this run</div><figcaption>${esc(caption)}</figcaption></figure>`;
    }).join('\n');
    return `<section id="s${i}"><h2>${esc(title)}</h2><div class="grid">${cards}</div></section>`;
  });
  const extra = [...have].filter((n) => !used.has(n)).sort();
  if (extra.length) {
    sections.push(`<section id="other"><h2>Other screens</h2><div class="grid">${extra.map((n) => `<figure><a href="shots/${n}.png" target="_blank"><img loading="lazy" src="shots/${n}.png" alt="${esc(n)}"></a><figcaption>${esc(n)}</figcaption></figure>`).join('\n')}</div></section>`);
  }
  const nav = SECTIONS.map(([t], i) => `<a href="#s${i}">${esc(t)}</a>`).join('');
  const expected = SECTIONS.flatMap(([, s]) => s.map(([n]) => n));
  const captured = expected.filter((n) => have.has(n)).length;
  const countLine = `${captured} of ${expected.length} screens captured`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>POCUS Portal — visual report</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d2327;--muted:#5d666d;--card:#fff;--line:#d9d6cf;--ok:#1d7a46;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#15181a;--fg:#e8e6e1;--muted:#a0a7ac;--card:#1f2326;--line:#343a3e;--ok:#5cc58a;--bad:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:20px 24px 8px}h1{margin:0 0 4px;font-size:22px}.meta{color:var(--muted);font-size:13px}
.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:600;font-size:13px;margin-right:8px}
.ok{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}.bad{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
nav{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 24px;display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px;z-index:1}
nav a{color:inherit}section{padding:8px 24px 16px}h2{font-size:18px;margin:16px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
figure img{display:block;width:100%;height:auto;border-bottom:1px solid var(--line)}
figcaption{padding:8px 12px;font-size:14px}.missing div{padding:48px 12px;text-align:center;color:var(--muted);border-bottom:1px solid var(--line)}
@media (max-width:480px){header,section,nav{padding-left:16px;padding-right:16px}.grid{grid-template-columns:1fr}}
</style></head><body>
<header><h1>POCUS Portal — visual report</h1>
<div>${status}<span class="pill ${captured === expected.length ? 'ok' : 'bad'}">${countLine}</span><a href="../playwright-report/index.html">Full Playwright report</a></div>
<p class="meta">Branch <b>${esc(branch)}</b> · ${esc(commit)}<br>${startedAt ? `Run ${esc(new Date(startedAt).toLocaleString())}${finishedAt ? ` · ${Math.round((finishedAt - startedAt) / 1000)} s` : ''} · ` : ''}local stack, fictional data only${note ? `<br>${esc(note)}` : ''}</p></header>
<nav>${nav}</nav>
${sections.join('\n')}
</body></html>`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html);
  return join(outDir, 'index.html');
}

/** The tests write fictional data: stop if the built portal would talk to any hosted project. */
export function assertBuiltForLocal(site, dist = join(root, 'dist')) {
  const assets = join(dist, 'app', 'assets');
  const js = readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
  if (/[a-z0-9]{20}\.supabase\.(co|in)/.test(js) || !js.includes(site)) {
    throw new Error(`The local build is not pointed at ${site} (it mentions a hosted Supabase project). Nothing was run.`);
  }
}

function openFile(p) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawnSync(cmd, [p], { stdio: 'ignore', shell: process.platform === 'win32' });
}

async function main() {
  const wantOpen = args.has('--open') || (process.platform === 'darwin' && !args.has('--no-open'));
  if (args.has('--report-only')) {
    const p = writeReport({ note: 'Rebuilt from the previous run’s screenshots.' });
    console.log(`report: ${p}`);
    if (wantOpen) openFile(p);
    return 0;
  }

  const stack = localStack();
  const site = `http://127.0.0.1:${PORT}`;
  console.log(`local stack: API ${stack.api} · mail ${stack.mailpit}`);

  if (stack.viaCli && !args.has('--no-reset')) {
    console.log('resetting the LOCAL test database (migrations + seed)…');
    const [cmd, ...pre] = supabaseCli();
    sh(cmd, [...pre, 'db', 'reset', '--local'], { stdio: 'inherit' });
  }

  console.log('building the site against the local stack…');
  sh(process.execPath, ['scripts/build-site.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, VERCEL_ENV: '', VITE_SUPABASE_URL: site, VITE_SUPABASE_ANON_KEY: stack.anonKey, VITE_SUPABASE_PUBLISHABLE_KEY: '' },
  });

  assertBuiltForLocal(site);

  const gw = await startGateway({ dist: join(root, 'dist'), api: stack.api, mailpit: stack.mailpit, port: PORT });
  console.log(`serving ${gw.url}/app/`);

  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const startedAt = Date.now();
  const run = spawnSync('npx', ['playwright', 'test'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, E2E_BASE_URL: site, E2E_MAIL_URL: `${site}/__mail/messages`, DATABASE_URL: stack.db, E2E_SHOTS: shotsDir, E2E_RESET_CMD: '' },
  });
  const finishedAt = Date.now();
  await gw.close();

  const passed = run.status === 0;
  const p = writeReport({ passed, startedAt, finishedAt });
  console.log(`\n${passed ? '✔ tests passed' : '✘ tests failed'} — report: ${p}`);
  if (wantOpen) openFile(p);
  return passed ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c), (e) => { console.error(`\n✘ ${e.message}`); process.exit(2); });
}
