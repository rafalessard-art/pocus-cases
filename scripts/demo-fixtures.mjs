#!/usr/bin/env node
/**
 * Synthetic demonstration fixtures for reviewer access (WP3).
 *
 * Everything here is fictional: residents, faculty, blocks, scan counts, evidence
 * files (synthetic PDFs), observations, ITER text and a DEMO examination built from
 * simulator loops. Nothing comes from a real learner or patient.
 *
 * The data is created through the portal's own workflow functions, executed as the
 * fictional people (the same SET ROLE + JWT claims PostgREST uses), so every state
 * is one the real workflow can produce. Flags that expose rows to reviewers
 * (is_fixture, reviewer_visible) are then set directly, as only SQL can.
 *
 * Idempotent: does nothing if the fixtures already exist.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node scripts/demo-fixtures.mjs
 *   # optional: also put the synthetic files into local Storage (needed to open them in the portal)
 *   STORAGE_URL=http://127.0.0.1:54321 SERVICE_ROLE_KEY=... node scripts/demo-fixtures.mjs
 *
 * Local stacks only.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;
function assertLocal(what, value) {
  if (!value) return;
  const host = new URL(value).hostname;
  if (!LOCAL.test(host)) throw new Error(`${what} points at ${host}. Demonstration fixtures are loaded into local stacks only.`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = path.join(here, '..', 'tests', 'e2e', 'fixtures');

/** Deterministic fixture ids, recognisable in any table. */
export const fid = (n) => `fe000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
export const FIXTURE = {
  admin: fid(1),
  faculty: [fid(11), fid(12), fid(13)],
  residents: [fid(21), fid(22), fid(23), fid(24), fid(25), fid(26)],
  blocks: { past: fid(31), current: fid(32), upcoming: fid(33) },
};

const PEOPLE = [
  { id: FIXTURE.admin, email: 'demo-author@fixture.invalid', name: 'Demo content author (fictional)', role: 'admin' },
  { id: FIXTURE.faculty[0], email: 'faculty-hale@fixture.invalid', name: 'Dr. Morgan Hale (fictional)', role: 'faculty' },
  { id: FIXTURE.faculty[1], email: 'faculty-okafor@fixture.invalid', name: 'Dr. Jordan Okafor (fictional)', role: 'faculty' },
  { id: FIXTURE.faculty[2], email: 'faculty-tremblay@fixture.invalid', name: 'Dr. Sam Tremblay (fictional)', role: 'faculty' },
  { id: FIXTURE.residents[0], email: 'resident-avery@fixture.invalid', name: 'Avery Lin (fictional)', role: 'learner', level: 'PGY-2' },
  { id: FIXTURE.residents[1], email: 'resident-blake@fixture.invalid', name: 'Blake Moreau (fictional)', role: 'learner', level: 'PGY-2' },
  { id: FIXTURE.residents[2], email: 'resident-casey@fixture.invalid', name: 'Casey Nguyen (fictional)', role: 'learner', level: 'PGY-3' },
  { id: FIXTURE.residents[3], email: 'resident-devon@fixture.invalid', name: 'Devon Roy (fictional)', role: 'learner', level: 'PGY-2' },
  { id: FIXTURE.residents[4], email: 'resident-emery@fixture.invalid', name: 'Emery Gauthier (fictional)', role: 'learner', level: 'PGY-3' },
  { id: FIXTURE.residents[5], email: 'resident-finley@fixture.invalid', name: 'Finley Osei (fictional)', role: 'learner', level: 'PGY-2' },
];

const day = 86_400_000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

export async function loadFixtures(pool, opts = {}) {
  const log = opts.log ?? (() => {});
  const sql = async (text, params = []) => (await pool.query(text, params)).rows;
  const [{ n }] = await sql(`select count(*)::int as n from public.cohorts where id = $1`, [FIXTURE.blocks.past]);
  if (n > 0) {
    log('Demonstration fixtures already present; nothing to do.');
    return { created: false };
  }

  /** Run as a fictional person, exactly as PostgREST would for their session. */
  async function as(uid, text, params = []) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: uid, role: 'authenticated', aal: 'aal2', email: PEOPLE.find((p) => p.id === uid)?.email }),
      ]);
      const r = await c.query(text, params);
      await c.query('commit');
      return r.rows;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw new Error(`${text.slice(0, 80)}… as ${uid}: ${e.message}`);
    } finally {
      c.release();
    }
  }
  const call = async (uid, fn, args) => {
    const names = Object.keys(args);
    const rows = await as(uid, `select public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`,
      names.map((k) => {
        const v = args[k];
        const scalarArray = Array.isArray(v) && v.every((x) => typeof x !== 'object');
        return v !== null && typeof v === 'object' && !scalarArray ? JSON.stringify(v) : v;
      }));
    return rows[0].r;
  };

  const now = Date.now();
  const [{ course }] = await sql(`select id as course from public.courses where slug = 'pocus'`);

  // ---- people -------------------------------------------------------------
  log('people');
  for (const p of PEOPLE) {
    await sql(`insert into public.invitations (email, full_name, role, training_level, program) values ($1, $2, $3, $4, $5)`,
      [p.email, p.name, p.role, p.level ?? null, p.role === 'learner' ? 'Anesthesiology (fictional)' : null]);
    await sql(`insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
               values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}', '{}', now(), now())`, [p.id, p.email]);
    await sql(`update public.profiles set is_fixture = true where id = $1`, [p.id]);
  }
  await sql(`delete from public.invitations where email like '%@fixture.invalid'`);

  // ---- blocks -------------------------------------------------------------
  log('blocks');
  const blocks = [
    { id: FIXTURE.blocks.past, name: 'DEMO Block 2 — fictional residents', label: 'Block 2', start: now - 98 * day, end: now - 70 * day },
    { id: FIXTURE.blocks.current, name: 'DEMO Block 5 — fictional residents', label: 'Block 5', start: now - 21 * day, end: now + 7 * day },
    { id: FIXTURE.blocks.upcoming, name: 'DEMO Block 7 — fictional residents', label: 'Block 7', start: now + 35 * day, end: now + 63 * day },
  ];
  for (const b of blocks) {
    await sql(`insert into public.cohorts (id, course_id, name, academic_year, block_label, start_date, end_date, is_fixture)
               values ($1, $2, $3, '2026-2027', $4, $5, $6, true)`, [b.id, course, b.name, b.label, iso(b.start), iso(b.end)]);
  }
  const [R1, R2, R3, R4, R5, R6] = FIXTURE.residents;
  const [F1, F2, F3] = FIXTURE.faculty;
  const members = [
    [FIXTURE.blocks.past, R1, 'learner'], [FIXTURE.blocks.past, R2, 'learner'], [FIXTURE.blocks.past, F1, 'evaluator'],
    [FIXTURE.blocks.current, R3, 'learner'], [FIXTURE.blocks.current, R4, 'learner'], [FIXTURE.blocks.current, R5, 'learner'],
    [FIXTURE.blocks.current, F1, 'evaluator'], [FIXTURE.blocks.current, F2, 'evaluator'],
    [FIXTURE.blocks.upcoming, R6, 'learner'], [FIXTURE.blocks.upcoming, F3, 'evaluator'],
  ];
  for (const [c, u, r] of members) await sql(`insert into public.cohort_members (cohort_id, user_id, member_role) values ($1, $2, $3)`, [c, u, r]);

  // ---- DEMO examination (simulator loops; reviewer-visible) ------------------
  log('demo exam');
  const media = {};
  for (const [key, file, mime, w, h, dur] of [
    ['DEMO-SIM-PLAX-DCM', 'SIM-PLAX-DCM.webm', 'video/webm', 448, 448, 2],
    ['DEMO-SIM-A4C-RV', 'SIM-A4C-RVSTRAIN.webm', 'video/webm', 448, 448, 2],
  ]) {
    const bytes = readFileSync(path.join(FILES, file));
    const r = await call(FIXTURE.admin, 'begin_media_upload', {
      p_asset_id: null,
      p_asset: { media_key: key, title: `Simulated loop — ${key.replace('DEMO-SIM-', '')} (EchoSimulator, not a patient)`, domain_key: 'cardiac', course_id: course,
                 source: 'EchoSimulator (synthetic)', attribution: 'Generated by the portal\'s EchoSimulator — synthetic, no patient', license: 'Synthetic' },
      p_file: { filename: file, mime_type: mime, size_bytes: bytes.length, width: w, height: h, duration_seconds: dur, sha256: createHash('sha256').update(bytes).digest('hex') },
    });
    await sql(`insert into storage.objects (bucket_id, name, metadata) values ('exam-media', $1, jsonb_build_object('size', $2::bigint, 'mimetype', $3::text))`,
      [r.storage_path, bytes.length, mime]);
    const done = await call(FIXTURE.admin, 'complete_media_upload', { p_version_id: r.version_id, p_ok: true });
    if (done.status !== 'uploaded') throw new Error(`media ${key}: ${JSON.stringify(done)}`);
    await as(FIXTURE.admin, `update public.media_assets set authorization_status = 'authorized', deidentified = true where id = $1`, [r.asset_id]);
    await sql(`update public.media_assets set reviewer_visible = true where id = $1`, [r.asset_id]);
    media[key] = { ...r, file, mime };
  }
  const Q = [
    { type: 'single', domain_key: 'cardiac', objective_codes: ['CARD-1'], media: [{ media_version_id: media['DEMO-SIM-PLAX-DCM'].version_id, caption: 'Simulated parasternal long-axis loop' }],
      stem: 'DEMO (simulated loop, not a patient). The left ventricle is dilated with globally reduced wall motion. Which pattern does this best fit?',
      options: [{ id: 'a', text: 'Dilated cardiomyopathy' }, { id: 'b', text: 'Hypertrophic cardiomyopathy' }, { id: 'c', text: 'Pericardial tamponade' }, { id: 'd', text: 'A normal study' }],
      key: { correct: ['a'] }, explanation: 'A large, globally hypokinetic left ventricle is the dilated cardiomyopathy pattern. Demonstration question.' },
    { type: 'single', domain_key: 'cardiac', objective_codes: ['CARD-2'], media: [{ media_version_id: media['DEMO-SIM-A4C-RV'].version_id, caption: 'Simulated apical four-chamber loop' }],
      stem: 'DEMO (simulated loop, not a patient). The right ventricle appears larger than the left. In a patient with sudden hypotension, which diagnosis should this prompt you to consider first?',
      options: [{ id: 'a', text: 'Left ventricular systolic failure' }, { id: 'b', text: 'Acute pulmonary embolism' }, { id: 'c', text: 'Hypovolaemia' }, { id: 'd', text: 'Mitral stenosis' }],
      key: { correct: ['b'] }, explanation: 'Acute right ventricular dilatation with hypotension should prompt consideration of pulmonary embolism. Demonstration question.' },
    { type: 'multiple', domain_key: 'lung', objective_codes: ['LUNG-1'], points: 2, scoring: { mode: 'partial' },
      stem: 'DEMO. Which findings at the probe position support a pneumothorax? Select all that apply.',
      options: [{ id: 'a', text: 'Absent lung sliding' }, { id: 'b', text: 'A lung point' }, { id: 'c', text: 'B-lines' }, { id: 'd', text: 'Lung pulse' }],
      key: { correct: ['a', 'b'] }, explanation: 'Absent sliding and a lung point support pneumothorax; B-lines and a lung pulse argue against it at that spot.' },
    { type: 'single', domain_key: 'gastric', objective_codes: ['GAST-1'],
      stem: 'DEMO. In the Perlas antral grading system, a grade 2 antrum means clear fluid is seen in which position(s)?',
      options: [{ id: 'a', text: 'Neither position' }, { id: 'b', text: 'Right lateral decubitus only' }, { id: 'c', text: 'Both supine and right lateral decubitus' }, { id: 'd', text: 'Supine only' }],
      key: { correct: ['c'] }, explanation: 'Grade 0: neither; grade 1: right lateral decubitus only; grade 2: both positions.' },
    { type: 'single', domain_key: 'vascular', objective_codes: ['VASC-1'],
      stem: 'DEMO. Two-point compression ultrasound for proximal DVT examines which sites?',
      options: [{ id: 'a', text: 'Common femoral and popliteal veins' }, { id: 'b', text: 'Great saphenous and posterior tibial veins' }, { id: 'c', text: 'External iliac and peroneal veins' }],
      key: { correct: ['a'] }, explanation: 'The common femoral vein (with the saphenofemoral junction) and the popliteal vein.' },
    { type: 'short_answer', domain_key: 'airway', objective_codes: ['AIRW-1'],
      stem: 'DEMO. Which membrane is identified with ultrasound before emergency front-of-neck access?',
      key: { model_answer: 'The cricothyroid membrane' }, explanation: 'Faculty grade short answers; this is a demonstration question.' },
  ];
  const ex = await call(FIXTURE.admin, 'create_exam', { p_course_id: course, p_title: 'DEMO — POCUS block examination (fictional walkthrough)',
    p_description: 'Synthetic demonstration examination for reviewers. Not the departmental post-test.' });
  await as(FIXTURE.admin, `update public.exam_versions set pass_threshold_pct = 75, time_limit_minutes = 30, max_attempts = 1, release_mode = 'manual',
    feedback_policy = 'full_review', allow_resume = true,
    instructions = 'DEMONSTRATION ONLY. Six synthetic questions using simulator loops. Settings shown (75% pass mark, 30 minutes, one attempt) are Draft placeholders, not program policy.'
    where id = $1`, [ex.exam_version_id]);
  const qs = [];
  for (const q of Q) qs.push(await call(FIXTURE.admin, 'save_question', { p_question_id: null, p: { course_id: course, points: 1, ...q } }));
  await call(FIXTURE.admin, 'set_exam_items', { p_exam_version_id: ex.exam_version_id, p_items: qs.map((q) => ({ question_version_id: q.question_version_id })) });
  const pub = await call(FIXTURE.admin, 'publish_exam_version', { p_exam_version_id: ex.exam_version_id });
  if (!pub.published) throw new Error('DEMO exam did not publish: ' + JSON.stringify(pub.issues));
  await sql(`update public.exams set reviewer_visible = true where id = $1`, [ex.exam_id]);
  const asg = {};
  for (const b of blocks) {
    const [a] = await as(FIXTURE.admin, `insert into public.assignments (exam_version_id, cohort_id, note) values ($1, $2, 'Demonstration') returning id`, [ex.exam_version_id, b.id]);
    asg[b.id] = a.id;
  }

  /** A resident sits the exam; answers given by item stem prefix. */
  async function sit(uid, block, answers, { submit = true } = {}) {
    const attempt = await call(uid, 'start_attempt', { p_assignment: asg[block] });
    const att = await call(uid, 'get_attempt', { p_attempt: attempt });
    const items = att.items.map((it) => {
      const k = Q.findIndex((q) => q.stem === it.stem);
      const a = answers[k];
      return { item_id: it.item_id, response: a === undefined ? null : typeof a === 'string' ? { text: a } : { selected: a }, flagged: false, seq: 1 };
    });
    await call(uid, 'save_responses', { p_attempt: attempt, p_items: items });
    if (submit) await call(uid, 'submit_attempt', { p_attempt: attempt });
    return { attempt, items: att.items };
  }
  async function gradeShort(faculty, s, points, comment) {
    const it = s.items.find((x) => x.type === 'short_answer');
    await call(faculty, 'grade_response', { p_attempt: s.attempt, p_item: it.item_id, p_points: points, p_comment: comment });
  }

  log('exam attempts');
  const a1 = await sit(R1, FIXTURE.blocks.past, [['a'], ['b'], ['a'], ['c'], ['a'], 'Cricothyroid membrane']);
  await gradeShort(F1, a1, 1, 'Correct.');
  const a2 = await sit(R2, FIXTURE.blocks.past, [['a'], ['c'], ['a', 'c'], ['b'], ['a'], 'Thyrohyoid membrane']);
  await gradeShort(F1, a2, 0, 'Fictional feedback: review the surface anatomy of the cricothyroid membrane.');
  await call(F1, 'release_results', { p_attempts: [a1.attempt, a2.attempt] });
  await sit(R3, FIXTURE.blocks.current, [['a'], ['b'], ['a', 'b'], ['c'], ['b'], 'cricothyroid']); // awaiting short-answer grading
  // past block: exam window closed; attempts dated within the block
  await sql(`update public.assignments set opens_at = $2, due_at = $3 where id = $1`, [asg[FIXTURE.blocks.past], new Date(blocks[0].start), new Date(blocks[0].end)]);
  await sql(`update public.assignments set opens_at = $2, due_at = $3 where id = $1`, [asg[FIXTURE.blocks.current], new Date(blocks[1].start), new Date(blocks[1].end)]);
  await sql(`update public.assignments set opens_at = $2, due_at = $3 where id = $1`, [asg[FIXTURE.blocks.upcoming], new Date(blocks[2].end - 7 * day), new Date(blocks[2].end)]);
  for (const [a, off] of [[a1.attempt, 74], [a2.attempt, 73]]) {
    await sql(`update public.attempts set started_at = now() - make_interval(days => $2), submitted_at = now() - make_interval(days => $2) + interval '24 minutes',
               deadline_at = now() - make_interval(days => $2) + interval '30 minutes', released_at = now() - make_interval(days => $2 - 2) where id = $1`, [a, off]);
  }

  // ---- scans ---------------------------------------------------------------
  log('scans');
  const cats = Object.fromEntries((await sql(`select key, id, target from public.scan_categories where course_id = $1 and cohort_id is null and archived_at is null`, [course])).map((r) => [r.key, r]));
  const scanPlan = {
    [R1]: { frac: 1, block: FIXTURE.blocks.past, views: true, on: blocks[0].end - 2 * day },
    [R2]: { frac: 1, block: FIXTURE.blocks.past, views: true, on: blocks[0].end - 3 * day },
    [R3]: { frac: 0.7, block: FIXTURE.blocks.current, views: false, on: now - 2 * day },
    [R4]: { frac: 0.35, block: FIXTURE.blocks.current, views: false, on: now - 4 * day },
  };
  for (const [uid, p] of Object.entries(scanPlan)) {
    const counts = Object.values(cats).map((c) => ({ category: c.id, count: Math.round(c.target * Math.min(1, p.frac + 0.1)) }));
    await call(uid, 'report_scans', { p_cohort: p.block, p_counts: counts });
    const entries = Object.entries(cats).map(([key, c]) => ({ category: c.id, delta: Math.round(c.target * p.frac), ...(p.views && key === 'cardiac' ? { views_confirmed: true } : {}) }));
    await call(F1, 'attest_scans', { p_attested: true, p_learner: uid, p_cohort: p.block, p_reviewed_on: iso(p.on), p_entries: entries,
      p_note: 'Fictional: reviewed in the logbook with the resident', p_correction: false });
  }
  await call(R5, 'report_scans', { p_cohort: FIXTURE.blocks.current, p_counts: Object.values(cats).slice(0, 3).map((c) => ({ category: c.id, count: 3 })) });

  // ---- evidence (synthetic PDFs) ---------------------------------------------
  log('evidence');
  const reqs = await sql(`select id, title from public.evidence_requirements where course_id = $1 and cohort_id is null and archived_at is null and required order by sort`, [course]);
  const pdfs = ['SYNTHETIC-brightspace-completion-1.pdf', 'SYNTHETIC-brightspace-completion-2.pdf', 'SYNTHETIC-brightspace-completion-3.pdf'];
  const evidenceFiles = [];
  async function upload(uid, block, req, i) {
    const file = pdfs[i % pdfs.length];
    const bytes = readFileSync(path.join(FILES, file));
    const r = await call(uid, 'begin_evidence_upload', { p_requirement: req, p_cohort: block,
      p_file: { filename: `synthetic-completion-${i + 1}.pdf`, mime_type: 'application/pdf', size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      p_note: 'Fictional completion record' });
    await sql(`insert into storage.objects (bucket_id, name, metadata) values ('itar-evidence', $1, jsonb_build_object('size', $2::bigint, 'mimetype', 'application/pdf'))`, [r.storage_path, bytes.length]);
    await call(uid, 'complete_evidence_upload', { p_id: r.id, p_ok: true });
    evidenceFiles.push({ bucket: 'itar-evidence', path: r.storage_path, file, mime: 'application/pdf' });
    return r.id;
  }
  for (const uid of [R1, R2]) {
    for (const [i, rq] of reqs.entries()) {
      const id = await upload(uid, FIXTURE.blocks.past, rq.id, i);
      await call(F1, 'review_evidence', { p_id: id, p_status: 'verified', p_message: null });
    }
  }
  for (const [i, rq] of reqs.entries()) {
    const id = await upload(R3, FIXTURE.blocks.current, rq.id, i);
    if (i < reqs.length - 2) await call(F2, 'review_evidence', { p_id: id, p_status: 'verified', p_message: null });
    else if (i === reqs.length - 2) await call(F2, 'review_evidence', { p_id: id, p_status: 'clarification_requested',
      p_message: 'Fictional: the completion page does not show the case title — please upload the full page.' });
    // last one stays awaiting review
  }
  await upload(R4, FIXTURE.blocks.current, reqs[0].id, 0);

  // ---- other requirements --------------------------------------------------
  log('requirements');
  const rq = Object.fromEntries((await sql(`select key, id from public.rotation_requirements where course_id = $1 and cohort_id is null and archived_at is null`, [course])).map((r) => [r.key, r.id]));
  const setReq = (who, learner, block, key, status, stage = null, note = null) =>
    call(who, 'set_requirement_status', { p_requirement: rq[key], p_learner: learner, p_cohort: block, p_status: status, p_stage: stage, p_note: note });
  for (const uid of [R1, R2]) {
    await setReq(uid, uid, FIXTURE.blocks.past, 'teachingmedicine', 'submitted', null, 'Fictional: all modules completed');
    await setReq(F1, uid, FIXTURE.blocks.past, 'teachingmedicine', 'verified');
    await setReq(uid, uid, FIXTURE.blocks.past, 'qpath_portfolio', 'submitted', null, 'Fictional: portfolio reviewed with mentor');
    await setReq(F1, uid, FIXTURE.blocks.past, 'qpath_portfolio', 'verified');
    await setReq(uid, uid, FIXTURE.blocks.past, 'pocus_rounds', 'in_progress', 'planned', 'Fictional topic: gastric ultrasound');
    await setReq(F1, uid, FIXTURE.blocks.past, 'pocus_rounds', 'in_progress', 'faculty_reviewed');
    await setReq(F1, uid, FIXTURE.blocks.past, 'pocus_rounds', 'verified', 'presented');
  }
  await setReq(R3, R3, FIXTURE.blocks.current, 'teachingmedicine', 'submitted', null, 'Fictional: modules 1–6 done');
  await setReq(F2, R3, FIXTURE.blocks.current, 'teachingmedicine', 'clarification_requested', null, 'Fictional: module 4 is not shown as complete.');
  await setReq(R3, R3, FIXTURE.blocks.current, 'pocus_rounds', 'in_progress', 'planned', 'Fictional topic: lung ultrasound in the PACU');
  await setReq(R4, R4, FIXTURE.blocks.current, 'qpath_portfolio', 'submitted', null, 'Fictional: mentor review booked');

  // ---- EPA review, observations and ITERs ------------------------------------
  log('EPA, observations, ITER');
  for (const uid of [R1, R2]) {
    await call(F1, 'verify_epa', { p_learner: uid, p_cohort: FIXTURE.blocks.past, p_reviewed: true, p_criteria_status: 'met', p_criteria_confirmed: true,
      p_strengths: 'Fictional: efficient focused cardiac views.', p_areas: 'Fictional: consolidate gastric antrum scanning.', p_concerns: null, p_entries: null, p_details: null });
  }
  const notes = [
    [R1, FIXTURE.blocks.past, F1, 'scanning', blocks[0].start + 10 * day, 'Fictional: obtained a clear subcostal view independently.'],
    [R2, FIXTURE.blocks.past, F1, 'communication', blocks[0].start + 14 * day, 'Fictional: explained lung point to a junior resident.'],
    [R3, FIXTURE.blocks.current, F2, 'scanning', now - 6 * day, 'Fictional: improving probe handling for apical views.'],
    [R4, FIXTURE.blocks.current, F1, 'professionalism', now - 9 * day, 'Fictional: well-organised logbook.'],
  ];
  for (const [learner, block, author, category, on, body] of notes) {
    await as(author, `insert into public.faculty_notes (course_id, learner_id, cohort_id, author_id, category, observed_on, body) values ($1, $2, $3, $4, $5, $6, $7)`,
      [course, learner, block, author, category, iso(on), body]);
  }
  const iter = (outcome, overall) => ({ outcome, basis: ['Written examination', 'Formal direct observation'], discussed: 'yes', overall,
    strengths: 'Fictional: focused cardiac and lung views.', areas: 'Fictional: gastric antrum in the right lateral position.',
    recommendations: 'Fictional: continue supervised gastric scans.' });
  const [e1] = await as(F1, `insert into public.evaluations (course_id, learner_id, cohort_id, summary, itar_sections, iter_fields) values ($1, $2, $3, $4, $5, $6) returning id`,
    [course, R1, FIXTURE.blocks.past, 'Fictional ITER: met all rotation objectives.',
     JSON.stringify([{ key: 'iter_outcome', title: 'Overall rotation objectives', text: 'Yes, Fully' }]), iter('Yes, Fully', 'Fictional: consistently strong performance across the block.')]);
  await as(F1, `update public.evaluations set status = 'approved' where id = $1`, [e1.id]);
  await as(F1, `insert into public.evaluations (course_id, learner_id, cohort_id, summary, itar_sections, iter_fields) values ($1, $2, $3, $4, $5, $6)`,
    [course, R2, FIXTURE.blocks.past, 'Fictional ITER draft: objectives partially met; exam below the Draft pass mark.',
     JSON.stringify([{ key: 'iter_outcome', title: 'Overall rotation objectives', text: 'Yes, Partially' }]), iter('Yes, Partially', 'Fictional: steady progress; written exam to be repeated.')]);

  // ---- the fictional author leaves; nobody can act as them -------------------
  await sql(`update public.profiles set active = false where id = $1`, [FIXTURE.admin]);

  const files = [...Object.values(media).map((m) => ({ bucket: 'exam-media', path: m.storage_path, file: m.file, mime: m.mime })), ...evidenceFiles];
  if (opts.storageUrl && opts.serviceKey) await uploadFiles(files, opts, log);
  log('done');
  return { created: true, files, examVersionId: ex.exam_version_id, examId: ex.exam_id };
}

/** Put the synthetic files into a local Storage API (service role; local only). */
export async function uploadFiles(files, { storageUrl, serviceKey }, log = () => {}) {
  assertLocal('STORAGE_URL', storageUrl);
  for (const f of files) {
    const res = await fetch(`${storageUrl}/storage/v1/object/${f.bucket}/${f.path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': f.mime, 'x-upsert': 'true' },
      body: readFileSync(path.join(FILES, f.file)),
    });
    if (!res.ok) throw new Error(`upload ${f.bucket}/${f.path}: ${res.status} ${await res.text()}`);
  }
  log(`uploaded ${files.length} synthetic files`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL to the local database');
  assertLocal('DATABASE_URL', url);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  loadFixtures(pool, { log: (m) => console.log(`fixtures: ${m}`), storageUrl: process.env.STORAGE_URL, serviceKey: process.env.SERVICE_ROLE_KEY })
    .then(async (r) => {
      // Files for an existing fixture set (e.g. Storage was reset separately) can be re-sent with --files.
      if (!r.created && process.argv.includes('--files')) console.log('fixtures: --files needs a fresh fixture load');
      await pool.end();
    })
    .catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
}
