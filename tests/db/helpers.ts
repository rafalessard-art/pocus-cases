/**
 * Test helpers for database-level tests.
 *
 * Runs against a Supabase-compatible Postgres with the project's migrations
 * applied (e.g. `supabase start && supabase db reset`, then
 * DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres).
 *
 * `as(user, fn)` reproduces exactly what PostgREST does for a signed-in
 * request: SET ROLE authenticated + request.jwt.claims, inside a transaction.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres',
  max: 4,
});

export type User = { id: string; email: string; role: 'learner' | 'faculty' | 'admin' | 'none' };

export async function sql<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}

const run = randomUUID().slice(0, 8);
let n = 0;
export function uniq(prefix: string) {
  n += 1;
  return `${prefix}-${run}-${n}`;
}

/** Create an auth user. role 'none' = not invited (should get no access). */
export async function createUser(role: User['role'], opts: { cohortId?: string; name?: string } = {}): Promise<User> {
  const email = `${uniq(role)}@test.local`.toLowerCase();
  if (role !== 'none') {
    await sql(
      `insert into public.invitations (email, full_name, role, cohort_id, invited_by) values ($1, $2, $3, $4, null)`,
      [email, opts.name ?? `Test ${role} ${n}`, role, opts.cohortId ?? null],
    );
  }
  const id = randomUUID();
  await sql(
    `insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`,
    [id, email],
  );
  return { id, email, role };
}

/** Run fn inside a transaction as the given user (or anon when user is null). */
export async function as<T>(user: User | null, fn: (q: <R = any>(text: string, params?: unknown[]) => Promise<R[]>) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${user ? 'authenticated' : 'anon'}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(user ? { sub: user.id, role: 'authenticated', email: user.email } : { role: 'anon' }),
    ]);
    const q = async (text: string, params: unknown[] = []) => (await c.query(text, params)).rows;
    const out = await fn(q as any);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Call a SQL function as a user and return its single scalar result. */
export async function rpc<T = any>(user: User | null, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const names = Object.keys(args);
  const params = names.map((k, i) => `${k} => $${i + 1}`).join(', ');
  return as(user, async (q) => {
    const rows = await q(`select public.${fn}(${params}) as r`, names.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : Array.isArray(v) && v.length && typeof v[0] === 'object' ? JSON.stringify(v) : v;
    }));
    return rows[0].r as T;
  });
}

export async function pocusCourseId(): Promise<string> {
  const [r] = await sql(`select id from public.courses where slug = 'pocus'`);
  return r.id;
}

/** Simulate a completed direct-to-storage upload (the Storage API writes this row). */
export async function fakeStorageObject(path: string, size = 12345) {
  await sql(
    `insert into storage.objects (bucket_id, name, metadata) values ('exam-media', $1, jsonb_build_object('size', $2::bigint, 'mimetype', 'video/mp4'))`,
    [path, size],
  );
}

/** Admin helper: upload + authorize a media asset, return its version id. */
export async function makeMedia(admin: User, opts: { authorize?: boolean; deidentify?: boolean; mime?: string } = {}) {
  const key = uniq('CLIP');
  const r = await rpc(admin, 'begin_media_upload', {
    p_asset_id: null,
    p_asset: { media_key: key, title: `Clip ${key}`, domain_key: 'cardiac', course_id: await pocusCourseId() },
    p_file: { filename: `${key}.mp4`, mime_type: opts.mime ?? 'video/mp4', size_bytes: 1000, width: 448, height: 448, duration_seconds: 1.33 },
  });
  await fakeStorageObject(r.storage_path);
  const done = await rpc(admin, 'complete_media_upload', { p_version_id: r.version_id, p_ok: true });
  if (done.status !== 'uploaded') throw new Error('upload not completed');
  await as(admin, (q) =>
    q(`update public.media_assets set authorization_status = $2, deidentified = $3 where id = $1`, [
      r.asset_id,
      opts.authorize === false ? 'pending' : 'authorized',
      opts.deidentify !== false,
    ]),
  );
  return { assetId: r.asset_id as string, versionId: r.version_id as string, path: r.storage_path as string, key };
}

export async function makeQuestion(admin: User, p: Record<string, unknown>) {
  return rpc(admin, 'save_question', {
    p_question_id: (p.question_id as string) ?? null,
    p: { course_id: await pocusCourseId(), domain_key: 'cardiac', points: 1, ...p },
  });
}

export async function makeCohort(name = uniq('Cohort')) {
  const [c] = await sql(`insert into public.cohorts (course_id, name, academic_year, block_label) values ($1, $2, '2026-2027', 'Block 1') returning id`, [
    await pocusCourseId(),
    name,
  ]);
  return c.id as string;
}

/**
 * Build and publish a 4-question exam: single (with media), multiple (partial
 * scoring), short answer, single. Returns ids.
 */
export async function makePublishedExam(admin: User, settings: Record<string, unknown> = {}) {
  const media = await makeMedia(admin);
  const q1 = await makeQuestion(admin, {
    type: 'single', stem: 'Q1 single', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }],
    key: { correct: ['b'] }, explanation: 'Because B.', media: [{ media_version_id: media.versionId, caption: 'Loop 1' }],
    objective_codes: ['CARD-2'],
  });
  const q2 = await makeQuestion(admin, {
    type: 'multiple', stem: 'Q2 multiple', domain_key: 'lung', points: 2, scoring: { mode: 'partial' },
    options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }, { id: 'd', text: 'D' }],
    key: { correct: ['a', 'c'] }, objective_codes: ['LUNG-1'],
  });
  const q3 = await makeQuestion(admin, { type: 'short_answer', stem: 'Q3 short', domain_key: 'gastric', key: { model_answer: 'Grade 2 antrum' } });
  const q4 = await makeQuestion(admin, {
    type: 'single', stem: 'Q4 single', domain_key: 'lung', options: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y' }], key: { correct: ['x'] },
  });
  const ex = await rpc(admin, 'create_exam', { p_course_id: await pocusCourseId(), p_title: uniq('Exam'), p_description: '' });
  await as(admin, (q) =>
    q(
      `update public.exam_versions set pass_threshold_pct = 60, time_limit_minutes = $2, max_attempts = $3, release_mode = $4,
              feedback_policy = $5::public.feedback_policy, allow_resume = $6 where id = $1`,
      [
        ex.exam_version_id,
        settings.time_limit_minutes ?? 30,
        settings.max_attempts ?? 1,
        settings.release_mode ?? 'manual',
        settings.feedback_policy ?? 'full_review',
        settings.allow_resume ?? true,
      ],
    ),
  );
  await rpc(admin, 'set_exam_items', {
    p_exam_version_id: ex.exam_version_id,
    p_items: [q1, q2, q3, q4].map((q: any) => ({ question_version_id: q.question_version_id })),
  });
  const pub = await rpc(admin, 'publish_exam_version', { p_exam_version_id: ex.exam_version_id });
  if (!pub.published) throw new Error('publish failed: ' + JSON.stringify(pub.issues));
  return { examId: ex.exam_id as string, versionId: ex.exam_version_id as string, q: [q1, q2, q3, q4] as any[], media };
}

export async function assign(admin: User, versionId: string, target: { cohortId?: string; userId?: string }, extra: Record<string, unknown> = {}) {
  const [a] = await as(admin, (q) =>
    q(`insert into public.assignments (exam_version_id, cohort_id, user_id, opens_at, due_at) values ($1, $2, $3, $4, $5) returning id`, [
      versionId,
      target.cohortId ?? null,
      target.userId ?? null,
      extra.opens_at ?? null,
      extra.due_at ?? null,
    ]),
  );
  return a.id as string;
}

/** Map attempt items by their stem so tests are robust to shuffling. */
export function byStem(attempt: any) {
  const m: Record<string, any> = {};
  for (const it of attempt.items) m[it.stem] = it;
  return m;
}
