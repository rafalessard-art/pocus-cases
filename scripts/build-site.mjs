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
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
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
  'test-results', 'playwright-report',
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

execSync('npx vite build --config portal/vite.config.ts', { cwd: root, stdio: 'inherit' });

const required = ['index.html', 'tools.html', 'theme.css', 'theme.js', 'app/index.html', 'echo-simulator/index.html'];
for (const f of required) {
  if (!existsSync(join(dist, f)) || statSync(join(dist, f)).size === 0) {
    console.error(`build check failed: missing ${f}`);
    process.exit(1);
  }
}
if (!process.env.VITE_SUPABASE_URL) {
  console.warn('⚠ VITE_SUPABASE_URL is not set: the portal will show a "not configured" page. The public site is unaffected.');
}
console.log('build ok → dist/');
