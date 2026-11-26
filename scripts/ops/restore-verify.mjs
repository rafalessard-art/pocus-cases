#!/usr/bin/env node
/**
 * Part of scripts/ops/restore-test.sh. Uploads the backed-up files into the DISPOSABLE stack's
 * Storage, then compares row counts and file checksums with the backup's MANIFEST.json.
 * RESTORE-REPORT.txt holds counts and pass/fail only.
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const { BK, OUT, T_DB, T_API, T_KEY, APP_RESTORE, AUTH_RESTORE } = process.env;
if (!/^http:\/\/127\.0\.0\.1:55321$/.test(T_API ?? '')) throw new Error('not the disposable stack');
if (!/@127\.0\.0\.1:55322\//.test(T_DB ?? '')) throw new Error('not the disposable database');
const manifest = JSON.parse(readFileSync(join(BK, 'MANIFEST.json'), 'utf8'));
const headers = { apikey: T_KEY, ...(T_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${T_KEY}` } : {}) };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const MIME = { mp4: 'video/mp4', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };

const db = new pg.Client({ connectionString: T_DB });
await db.connect();
const lines = [`Restore test at ${new Date().toISOString()} (backup taken ${manifest.at})`,
  `restore of roles, schema and application data: ${APP_RESTORE}`, `restore of sign-in accounts and file records: ${AUTH_RESTORE}`];
try {
  // buckets exist after the schema/storage restore; make sure, without changing their settings if present
  for (const b of new Set(manifest.files.map((f) => f.key.split('/')[0]))) {
    await db.query(`insert into storage.buckets (id, name, public) values ($1, $1, false) on conflict (id) do nothing`, [b]);
  }
  let uploaded = 0, upFailed = 0, match = 0, mismatch = 0;
  for (const f of manifest.files) {
    if (!f.sha256) continue; // was not downloaded at backup time
    const [bucket, ...rest] = f.key.split('/');
    const name = rest.join('/');
    const path = join(BK, 'storage', bucket, name);
    if (!existsSync(path)) { upFailed += 1; continue; }
    const body = readFileSync(path);
    const ext = name.split('.').pop().toLowerCase();
    const put = await fetch(`${T_API}/storage/v1/object/${bucket}/${enc(name)}`, {
      method: 'POST', headers: { ...headers, 'x-upsert': 'true', 'content-type': MIME[ext] ?? 'application/octet-stream' }, body,
    });
    if (!put.ok) { upFailed += 1; continue; }
    uploaded += 1;
    const get = await fetch(`${T_API}/storage/v1/object/${bucket}/${enc(name)}`, { headers });
    const back = get.ok ? sha(Buffer.from(await get.arrayBuffer())) : '';
    if (back === f.sha256) match += 1; else mismatch += 1;
  }
  lines.push(`stored files: ${uploaded} uploaded · ${upFailed} failed · read back with matching sha256: ${match} · mismatched: ${mismatch}`);

  let ok = 0; const diffs = [];
  for (const [key, want] of Object.entries(manifest.counts)) {
    if (!key.startsWith('public.')) continue;
    const [s, t] = key.split('.');
    const got = await db.query(`select count(*)::int as n from "${s}"."${t}"`).then((r) => r.rows[0].n, () => null);
    if (got === want) ok += 1; else diffs.push(`${key}: backup ${want}, restored ${got ?? 'missing'}`);
  }
  lines.push(`application tables with identical row counts: ${ok} of ${ok + diffs.length}`);
  for (const d of diffs) lines.push(`  differs: ${d}`);
  const users = await db.query(`select count(*)::int as n from auth.users`).then((r) => r.rows[0].n, () => null);
  lines.push(`sign-in accounts: backup ${manifest.counts['auth.users'] ?? '?'}, restored ${users ?? '?'}`);
  const fx = await db.query(`select
      (select count(*) from public.exams)::int as exams,
      (select count(*) from public.question_keys)::int as keys,
      (select count(*) from public.question_version_media)::int as attached_media,
      (select count(*) from public.media_versions mv join storage.objects o on o.bucket_id = 'exam-media' and o.name = mv.storage_path)::int as media_with_file`);
  lines.push(`spot checks: exams ${fx.rows[0].exams} · answer keys ${fx.rows[0].keys} · media attached to questions ${fx.rows[0].attached_media} · media versions with their file ${fx.rows[0].media_with_file}`);
  const pass = APP_RESTORE === 'ok' && diffs.length === 0 && upFailed === 0 && mismatch === 0;
  lines.push(`result: ${pass ? 'PASS — the backup restores completely' : 'NEEDS ATTENTION'}${AUTH_RESTORE !== 'ok' ? ' (sign-in accounts did not restore; they can be re-invited, see restore.log)' : ''}`);
} finally {
  await db.end();
}
writeFileSync(join(OUT, 'RESTORE-REPORT.txt'), lines.join('\n') + '\n', { mode: 0o600 });
