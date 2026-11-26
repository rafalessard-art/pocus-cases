#!/usr/bin/env node
/**
 * Part of scripts/ops/backup-hosted.sh: row counts, every stored file, checksums.
 * Reads only. Env: DB_URL (with password), SERVICE_KEY, REF, OUT. Never prints secrets.
 * SUMMARY.txt holds counts and pass/fail only (no names, paths or content), so it can be
 * shared; MANIFEST.json (inside the encrypted image) holds the details.
 */
import pg from 'pg';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const { DB_URL, SERVICE_KEY, REF, OUT } = process.env;
if (!DB_URL || !SERVICE_KEY || !REF || !OUT) throw new Error('DB_URL, SERVICE_KEY, REF and OUT are required');
if (!OUT.startsWith('/Volumes/POCUS-Backups/') && !OUT.startsWith('/Volumes/POCUS-Restore/')) throw new Error('OUT must be inside the encrypted backup image');

const db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
const API = `https://${REF}.supabase.co`;
const headers = { apikey: SERVICE_KEY, ...(SERVICE_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SERVICE_KEY}` } : {}) };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

await db.connect();
try {
  await db.query('set default_transaction_read_only = on');
  const tables = (await db.query(`select table_schema as s, table_name as t from information_schema.tables
                                   where table_type = 'BASE TABLE' and table_schema in ('public', 'auth', 'storage') order by 1, 2`)).rows;
  const counts = {};
  for (const { s, t } of tables) counts[`${s}.${t}`] = (await db.query(`select count(*)::int as n from "${s}"."${t}"`)).rows[0].n;

  const objects = (await db.query(`select bucket_id, name, (metadata->>'size')::bigint as size from storage.objects order by bucket_id, name`)).rows;
  const expected = new Map();
  for (const r of (await db.query(`select storage_path as p, sha256 from public.media_versions where sha256 is not null`).catch(() => ({ rows: [] }))).rows) expected.set(`exam-media/${r.p}`, r.sha256);
  for (const r of (await db.query(`select storage_path as p, sha256 from public.evidence_submissions where sha256 is not null and file_deleted_at is null`).catch(() => ({ rows: [] }))).rows) expected.set(`itar-evidence/${r.p}`, r.sha256);

  const files = [];
  let downloaded = 0, failed = 0, verified = 0, mismatched = 0, unverifiable = 0, bytes = 0;
  for (const o of objects) {
    const key = `${o.bucket_id}/${o.name}`;
    let res;
    try {
      res = await fetch(`${API}/storage/v1/object/${encodeURIComponent(o.bucket_id)}/${enc(o.name)}`, { headers });
    } catch (e) {
      res = { ok: false, status: `network: ${e.cause?.code ?? e.message}` };
    }
    if (!res.ok) {
      failed += 1;
      files.push({ key, status: `download failed (${res.status})` });
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const path = join(OUT, 'storage', o.bucket_id, o.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf, { mode: 0o600 });
    downloaded += 1;
    bytes += buf.length;
    const h = sha(buf);
    const want = expected.get(key);
    const check = want ? (want === h ? 'sha256 matches the database' : 'SHA256 MISMATCH') : 'no checksum recorded';
    if (want === h) verified += 1;
    else if (want) mismatched += 1;
    else unverifiable += 1;
    files.push({ key, bytes: buf.length, sha256: h, size_in_db: o.size === null ? null : Number(o.size), check });
  }
  const sizeMismatch = files.filter((f) => f.bytes !== undefined && f.size_in_db !== null && f.bytes !== f.size_in_db).length;

  writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify({ ref: REF, at: new Date().toISOString(), counts, files }, null, 2), { mode: 0o600 });
  const byBucket = objects.reduce((m, o) => ((m[o.bucket_id] = (m[o.bucket_id] ?? 0) + 1), m), {});
  const lines = [
    `Backup of ${REF} at ${new Date().toISOString()}`,
    `tables: ${tables.length} · rows: ${Object.values(counts).reduce((a, b) => a + b, 0)}`,
    ...Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`),
    `stored files: ${objects.length} (${Object.entries(byBucket).map(([b, n]) => `${b} ${n}`).join(', ')}) · downloaded ${downloaded} · failed ${failed} · ${(bytes / 1e6).toFixed(1)} MB`,
    `checksums: ${verified} match the database · ${mismatched} mismatch · ${unverifiable} have no recorded checksum · size mismatches ${sizeMismatch}`,
    `result: ${failed === 0 && mismatched === 0 && sizeMismatch === 0 ? 'OK' : 'NEEDS ATTENTION'}`,
  ];
  writeFileSync(join(OUT, 'SUMMARY.txt'), lines.join('\n') + '\n', { mode: 0o600 });
} finally {
  await db.end();
}
