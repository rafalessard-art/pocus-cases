#!/usr/bin/env node
/**
 * Build the deployable site into dist/:
 *   1. copy the existing static site (top-level pages, assets, echo-simulator/) unchanged
 *   2. build the portal (portal/ → dist/app) with Vite
 *   3. sanity-check the result
 *
 * The static pages are copied byte-for-byte; nothing in them is transformed.
 * Tooling directories (portal source, migrations, tests, docs…) are never copied.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

// Top-level entries that are development tooling, never part of the public site.
const EXCLUDE = new Set([
  'dist', 'node_modules', 'portal', 'supabase', 'scripts', 'tests', 'docs', 'tools', 'design-system', '_backups',
  '.git', '.github', '.claude', '.vercel', '.env', '.env.local', '.env.example', 'package.json', 'package-lock.json',
  'vitest.config.ts', 'playwright.config.ts', 'tsconfig.json', 'vercel.json', '.gitignore', '.vercelignore',
  'test-results', 'playwright-report', 'visual-report', 'PROJECT_OVERVIEW.md', 'CLAUDE.md',
]);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

let copied = 0;
for (const name of readdirSync(root)) {
  if (EXCLUDE.has(name) || name.startsWith('.env')) continue;
  cpSync(join(root, name), join(dist, name), { recursive: true });
  copied += 1;
}
console.log(`static site: copied ${copied} top-level entries`);

// The demonstration database (fictional residents, demo exams, synthetic evidence)
// must never back the production portal. A production build pointed at it gets
// no database settings at all, so /app shows "not configured" and nothing from the
// demonstration can be read, mixed with or mistaken for real learner records.
// The public site is unaffected. See docs/exam-platform/DEPLOYMENT_READINESS.md.
const DEMO_PROJECT_REFS = ['ngnggoekezucadlwiomp'];
const fileEnv = (f) => (existsSync(join(root, f)) ? Object.fromEntries(readFileSync(join(root, f), 'utf8').split('\n')
  .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]])) : {});
const portalUrl = process.env.VITE_SUPABASE_URL || fileEnv('.env.production').VITE_SUPABASE_URL || '';
const usesDemoDb = DEMO_PROJECT_REFS.some((r) => portalUrl.includes(r));
const viteEnv = { ...process.env };
if (usesDemoDb && process.env.VERCEL_ENV === 'production') {
  console.warn('⚠ Production build pointed at the DEMONSTRATION database: the portal is built without database settings ("not configured"). Connect the separate production Supabase project first.');
  viteEnv.VITE_SUPABASE_URL = '';
  viteEnv.VITE_SUPABASE_ANON_KEY = '';
  viteEnv.VITE_SUPABASE_PUBLISHABLE_KEY = '';
}
// Demonstration (reviewer) sign-in is never compiled into a production build.
if (process.env.VERCEL_ENV === 'production' && viteEnv.VITE_DEMO_ACCESS) {
  console.warn('⚠ VITE_DEMO_ACCESS is ignored in production builds: demonstration sign-in is not included.');
  delete viteEnv.VITE_DEMO_ACCESS;
}
// Version shown with reviewer feedback: branch@commit unless the build sets one.
if (!viteEnv.VITE_APP_VERSION) {
  try {
    const sha = execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim();
    const br = (process.env.VERCEL_GIT_COMMIT_REF || execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf8' }).trim()).slice(0, 24);
    viteEnv.VITE_APP_VERSION = `${br}@${sha}`;
  } catch {
    /* not a git checkout */
  }
}
execSync('npx vite build --config portal/vite.config.ts', { cwd: root, stdio: 'inherit', env: viteEnv });

const required = ['index.html', 'tools.html', 'theme.css', 'theme.js', 'app/index.html', 'echo-simulator/index.html'];
for (const f of required) {
  if (!existsSync(join(dist, f)) || statSync(join(dist, f)).size === 0) {
    console.error(`build check failed: missing ${f}`);
    process.exit(1);
  }
}
if (!viteEnv.VITE_SUPABASE_URL && !(viteEnv.VITE_SUPABASE_URL === undefined && portalUrl)) {
  console.warn('⚠ VITE_SUPABASE_URL is not set: the portal will show a "not configured" page. The public site is unaffected.');
}
if (usesDemoDb && process.env.VERCEL_ENV !== 'production') console.log('portal: demonstration database (fictional data only)');
console.log('build ok → dist/');
