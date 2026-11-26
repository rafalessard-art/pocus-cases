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

const { BK, OUT, T_DB, T_API, T_KEY, APP_RESTORE } = process.env;
if (!/^http:\/\/127\.0\.0\.1:55321$/.test(T_API ?? '')) throw new Error('not the disposable stack');
if (!/@127\.0\.0\.1:55322\//.test(T_DB ?? '')) throw new Error('not the disposable database');
const manifest = JSON.parse(readFileSync(join(BK, 'MANIFEST.json'), 'utf8'));
const headers = { apikey: T_KEY, ...(T_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${T_KEY}` } : {}) };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const MIME = { mp4: 'video/mp4', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' };

const db = new pg.Client({ connectionString: T_DB });
await db.connect();
const st = (f) => (existsSync(join(OUT, f)) ? readFileSync(join(OUT, f), 'utf8').trim() : 'not run');
const AUTH = st('AUTH-RECOVERY.status'), DRILL = st('AUTH-FALLBACK.status'), RECORDS = st('FILE-RECORDS.status');
const lines = [`Restore test at ${new Date().toISOString()} (backup taken ${manifest.at})`, ''];
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
  const filesPass = upFailed === 0 && mismatch === 0 && RECORDS === 'pass';
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
  const fx = await db.query(`select
      (select count(*) from public.exams)::int as exams,
      (select count(*) from public.question_keys)::int as keys,
      (select count(*) from public.question_version_media)::int as attached_media,
      (select count(*) from public.media_versions mv join storage.objects o on o.bucket_id = 'exam-media' and o.name = mv.storage_path)::int as media_with_file`);
  lines.push(`spot checks: exams ${fx.rows[0].exams} · answer keys ${fx.rows[0].keys} · media attached to questions ${fx.rows[0].attached_media} · media versions with their file ${fx.rows[0].media_with_file}`);
  const appPass = APP_RESTORE === 'ok' && diffs.length === 0;
  const authText = { pass: 'PASS — accounts restored with passwords and authenticators, each linked to its own portal record',
    fallback: 'PARTIAL — sign-in tables did not restore; every account was recreated with its original id and linked, but passwords and authenticators must be set again',
    fail: 'FAIL — not every portal account could be recovered', 'not run': 'NOT RUN' }[AUTH] ?? AUTH;
  lines.splice(2, 0,
    `1. Application data (roles, schema, ${ok + diffs.length} tables): ${appPass ? 'PASS' : 'FAIL'}`,
    `2. Stored files and their records: ${filesPass ? 'PASS' : 'FAIL'}`,
    `3. Authentication recovery: ${authText}`,
    `4. Fallback procedure drill (recreate accounts with the same id): ${DRILL === 'fallback' ? 'PASS' : DRILL.toUpperCase()}`,
    `OVERALL: ${appPass && filesPass && AUTH === 'pass' && DRILL === 'fallback' ? 'COMPLETE' : appPass && filesPass && AUTH !== 'fail' ? 'PARTIAL — see section 3' : 'NOT RESTORABLE AS IS — see the failing sections'}`,
    '');
} finally {
  await db.end();
}
writeFileSync(join(OUT, 'RESTORE-REPORT.txt'), lines.join('\n') + '\n', { mode: 0o600 });
