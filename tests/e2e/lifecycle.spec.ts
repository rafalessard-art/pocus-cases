/**
 * The required end-to-end demonstration:
 *   faculty creates exam → uploads ultrasound loop → attaches loop to question →
 *   assigns learner → learner logs in → completes exam (with interruption and
 *   offline autosave) → system grades → faculty reviews, grades, releases →
 *   evaluation summary drafted and approved → learner sees released results.
 *
 * Content is clearly labelled demonstration material built from the site's own
 * synthetic EchoSimulator loops (WebM here, because Playwright's open-source
 * Chromium has no H.264 decoder; production clips are H.264 MP4).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIL = process.env.E2E_MAIL_URL ?? 'http://127.0.0.1:2501/messages';
const RUN = Date.now().toString(36);
const ADMIN = `admin-${RUN}@e2e.test`;
const LEARNER = `resident-${RUN}@e2e.test`;
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const SHOTS = process.env.E2E_SHOTS; // optional folder for walkthrough screenshots

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

/** Fail on serious/critical WCAG 2.1 A/AA violations. */
async function a11y(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${label}: ${v.id} — ${v.help} (${v.nodes.length})`)).toEqual([]);
}

async function latestCode(email: string, after: number): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${MAIL}?to=${encodeURIComponent(email)}`);
    const msgs = (await res.json()) as { text: string; at: number }[];
    const m = msgs.filter((x) => x.at >= after).pop();
    const code = m?.text.match(/\b(\d{6})\b/)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no sign-in code received for ${email}`);
}

async function signIn(page: Page, email: string) {
  await page.goto('/app/login');
  await page.getByLabel('Institutional email').fill(email);
  const t = Date.now() - 1000;
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await expect(page.getByText(/We sent a sign-in email/)).toBeVisible();
  await page.getByLabel('Sign-in code').fill(await latestCode(email, t));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Institutional email')).toBeVisible();
}

test.beforeAll(async () => {
  // Bootstrap: the very first administrator is invited directly in SQL (see DEPLOYMENT.md).
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' });
  await db.connect();
  await db.query(`insert into public.invitations (email, full_name, role) values ($1, 'Dr. Demo Faculty', 'admin')`, [ADMIN]);
  await db.end();
});

test('full examination lifecycle', async ({ page, context }) => {
  const cohortName = `POCUS Demo Block ${RUN}`;
  const examTitle = `DEMO POCUS End-of-Block Exam ${RUN}`;

  await test.step('public site is untouched and an uninvited email is refused', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'POCUS Learning Case Series' })).toBeVisible();
    await page.goto('/app/login');
    await a11y(page, 'login');
    await page.getByLabel('Institutional email').fill(`stranger-${RUN}@e2e.test`);
    await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
    await expect(page.getByText(/has not been invited/)).toBeVisible();
  });

  await test.step('admin signs in, creates a cohort and invites a learner', async () => {
    await signIn(page, ADMIN);
    await expect(page).toHaveURL(/\/app\/faculty/);
    await page.goto('/app/admin/people');
    await page.getByRole('tab', { name: 'Cohorts' }).click();
    await page.getByTestId('cohort-name').fill(cohortName);
    await page.getByTestId('create-cohort').click();
    await expect(page.getByText(cohortName)).toBeVisible();
    await page.getByRole('tab', { name: 'Invitations' }).click();
    await page.getByTestId('invite-emails').fill(LEARNER);
    await page.getByTestId('invite-name').fill('Dr. Demo Resident');
    await page.getByTestId('invite-cohort').selectOption({ label: cohortName });
    await page.getByTestId('invite').click();
    await expect(page.getByRole('cell', { name: LEARNER })).toBeVisible();
    await shot(page, '01-invitations');
  });

  await test.step('admin uploads ultrasound loops and a still, and governs them', async () => {
    await page.goto('/app/admin/media');
    await page.getByTestId('media-file-input').setInputFiles([
      join(FIX, 'SIM-A4C-RVSTRAIN.webm'), join(FIX, 'SIM-PLAX-DCM.webm'), join(FIX, 'SIM-PLAX-HCM-still.png'),
    ]);
    // media keys are unique library-wide; suffix them so the test can be re-run
    for (const base of ['SIM-A4C-RVSTRAIN', 'SIM-PLAX-DCM', 'SIM-PLAX-HCM-still']) {
      await page.getByRole('row').filter({ hasText: base }).locator('input[type=text]').first().fill(`${base}-${RUN}`);
    }
    await page.getByTestId('batch-domain').selectOption('cardiac');
    await page.getByRole('textbox', { name: /Source/ }).first().fill('EchoSimulator synthetic loops (site author)');
    await page.getByTestId('upload-all').click();
    await expect(page.locator('.badge.ok', { hasText: 'Uploaded' })).toHaveCount(3, { timeout: 60_000 });
    await page.getByRole('searchbox', { name: 'Search media' }).fill(RUN);
    await expect(page.getByTestId('media-card')).toHaveCount(3);
    await shot(page, '02-media-library');
    for (const key of ['SIM-A4C-RVSTRAIN', 'SIM-PLAX-DCM', 'SIM-PLAX-HCM-still']) {
      await page.getByTestId('media-card').filter({ hasText: `${key}-${RUN}` }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.locator('video, img').first()).toBeVisible();
      await dialog.getByTestId('auth-status').selectOption('authorized');
      await expect(dialog.getByText('Saved.')).toBeVisible();
      await dialog.getByTestId('deid-check').check();
      await expect(dialog.getByText(/Attested/)).toBeVisible();
      if (key === 'SIM-A4C-RVSTRAIN') await shot(page, '03-media-governance');
      await dialog.getByRole('button', { name: 'Close' }).click();
    }
    await expect(page.getByTestId('media-card').filter({ hasText: 'Ready' })).toHaveCount(3);
  });

  const questions = [
    {
      stem: '[DEMONSTRATION] This simulated loop (EchoSimulator) shows which focused cardiac ultrasound view?',
      type: 'single', options: ['Parasternal long axis', 'Apical four-chamber', 'Parasternal short axis', 'Subcostal four-chamber'], correct: [1],
      media: ['SIM-A4C-RVSTRAIN'],
    },
    {
      stem: '[DEMONSTRATION] Compare the two simulated images. Which views are displayed? Select all that apply.',
      type: 'multiple', options: ['Parasternal long axis', 'Apical four-chamber', 'Suprasternal', 'Apical two-chamber'], correct: [0, 1],
      media: ['SIM-PLAX-DCM', 'SIM-PLAX-HCM-still'],
    },
    {
      stem: '[DEMONSTRATION] In one or two sentences, describe one limitation of a written exam for assessing POCUS competence.',
      type: 'short_answer', options: [], correct: [], media: [],
    },
  ];

  await test.step('admin writes questions and attaches the loops', async () => {
    for (const q of questions) {
      await page.goto('/app/admin/questions/new');
      await page.getByTestId('q-type').selectOption(q.type);
      await page.getByTestId('q-stem').fill(q.stem);
      await page.getByTestId('q-domain').selectOption('cardiac');
      for (const key of q.media) {
        await page.getByTestId('attach-media').click();
        await page.getByTestId(`pick-${key}-${RUN}`).click();
      }
      for (let i = 0; i < q.options.length; i++) await page.getByTestId(`option-text-${i}`).fill(q.options[i]);
      for (const c of q.correct) await page.getByTestId(`correct-${c}`).check();
      if (q.type === 'short_answer') await page.getByLabel(/Model answer/).fill('It does not observe image acquisition or bedside integration.');
      await page.getByLabel(/^Explanation/).fill('Demonstration explanation shown after results are released.');
      await page.getByTestId('save-question').click();
      await expect(page.getByText('✓ Ready to publish')).toBeVisible();
      if (q.media.length === 2) await shot(page, '04-question-editor');
    }
  });

  await test.step('admin builds, publishes and assigns the exam', async () => {
    await page.goto('/app/admin/exams');
    await page.getByTestId('new-exam-title').fill(examTitle);
    await page.getByTestId('create-exam').click();
    await expect(page.getByRole('heading', { name: examTitle })).toBeVisible();
    await page.getByTestId('time-limit').fill('20');
    await page.getByTestId('pass-threshold').fill('60');
    await page.getByTestId('feedback-policy').selectOption('full_review');
    await page.getByTestId('release-mode').selectOption('manual');
    await page.getByTestId('save-settings').click();
    await expect(page.getByText('Settings saved.')).toBeVisible();
    await page.getByTestId('add-questions').click();
    for (const q of questions) await page.getByRole('row').filter({ hasText: q.stem.slice(0, 60) }).getByTestId('pick-question').check();
    await page.getByTestId('add-selected').click();
    await expect(page.getByText('Questions (3)')).toBeVisible();
    await expect(page.getByText('No problems found')).toBeVisible();
    await shot(page, '05-exam-builder');
    await page.getByTestId('publish').click();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText(/is published/)).toBeVisible();
    await page.getByTestId('assign-target').selectOption({ label: cohortName });
    await page.getByTestId('assign').click();
    await expect(page.getByRole('cell', { name: `Cohort: ${cohortName}` })).toBeVisible();
    await signOut(page);
  });

  let attemptUrl = '';
  await test.step('learner signs in and starts the exam', async () => {
    await signIn(page, LEARNER);
    await expect(page.getByText(examTitle)).toBeVisible();
    await page.getByRole('button', { name: 'Start exam' }).click();
    await page.getByRole('button', { name: 'Start now' }).click();
    await expect(page).toHaveURL(/\/app\/exams\/attempt\//);
    attemptUrl = page.url();
    await expect(page.getByTestId('timer')).toBeVisible();
  });

  await test.step('loops play, loop, scrub, slow down; answers autosave', async () => {
    const q1 = page.locator('.question').filter({ hasText: 'focused cardiac ultrasound view' });
    await expect(q1).toBeVisible();
    const video = q1.locator('video');
    await expect(video).toHaveJSProperty('loop', true);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0);
    await q1.getByRole('button', { name: 'Playback speed 0.5×' }).click();
    await expect(video).toHaveJSProperty('playbackRate', 0.5);
    await q1.getByRole('button', { name: 'Pause' }).click();
    await q1.getByRole('button', { name: 'Next frame' }).click();
    await expect(video).toHaveJSProperty('paused', true);
    const ar = await video.evaluate((v: HTMLVideoElement) => v.videoWidth / v.videoHeight);
    expect(ar).toBeCloseTo(1, 1); // simulator clips are 448×448: original aspect preserved
    await shot(page, '06-exam-player');
    await a11y(page, 'exam player');
    // phone-sized screen: no horizontal scrolling, clip still fits
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shot(page, '06b-exam-player-mobile');
    await page.setViewportSize({ width: 1360, height: 900 });
    await q1.getByRole('radio', { name: /Apical four-chamber/ }).click();
    await q1.getByRole('button', { name: /Flag for review/ }).click();
    await expect(page.getByTestId('save-status')).toHaveText(/All answers saved/);
  });

  await test.step('interruption: reload resumes with answers intact', async () => {
    await page.reload();
    await expect(page.getByRole('radio', { name: /Apical four-chamber/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('button', { name: /Flagged/ })).toBeVisible();
  });

  await test.step('offline: answers are kept locally, then saved on reconnect', async () => {
    await page.getByRole('button', { name: 'Next →' }).click();
    const q2 = page.locator('.question');
    await expect(q2.locator('video, img')).toHaveCount(2);
    await context.setOffline(true);
    await q2.getByRole('checkbox', { name: /Parasternal long axis/ }).click();
    await q2.getByRole('checkbox', { name: /Apical four-chamber/ }).click();
    await expect(page.getByTestId('save-status')).toHaveText(/Offline/, { timeout: 10_000 });
    const local = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pocus-autosave:')).length);
    expect(local).toBe(1);
    await shot(page, '07-offline-autosave');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByTestId('save-status')).toHaveText(/All answers saved/, { timeout: 20_000 });
    await page.getByRole('button', { name: 'Next →' }).click();
    await page.getByTestId('short-answer').fill('A written exam cannot observe probe handling or image acquisition at the bedside.');
    await expect(page.getByTestId('save-status')).toHaveText(/All answers saved/);
  });

  await test.step('review screen and submission', async () => {
    await page.getByRole('button', { name: 'Review answers →' }).click();
    await expect(page.getByText('3 of 3 answered.')).toBeVisible();
    await expect(page.getByText('Flagged', { exact: true })).toBeVisible();
    await shot(page, '08-review-screen');
    await a11y(page, 'review screen');
    await page.getByTestId('submit-exam').click();
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByTestId('submitted-notice')).toBeVisible();
    await expect(page.getByText('Submitted — results not yet released')).toBeVisible();
    await shot(page, '09-submitted');
    // the attempt is closed: returning to it shows the result page, not the questions
    await page.goto(attemptUrl);
    await expect(page.getByText('Submitted — results not yet released')).toBeVisible();
  });

  // ---------------------------------------------------------------- ITAR: resident uploads proof of Brightspace completion
  const CASES = [
    { title: 'Gastric Ultrasound', file: 'SYNTHETIC-brightspace-completion-1.pdf' },
    { title: 'Diaphragm POCUS', file: 'SYNTHETIC-brightspace-completion-2.pdf' },
    { title: 'Optic Nerve Sheath', file: 'SYNTHETIC-brightspace-completion-3.pdf' },
    { title: 'Peripheral Vascular Access', file: 'SYNTHETIC-brightspace-screenshot.png' },
  ];
  await test.step('resident uploads Brightspace completion evidence for each required case', async () => {
    await page.goto('/app/');
    await page.getByRole('link', { name: 'Upload evidence' }).click();
    await expect(page.getByRole('heading', { name: 'Learning-case evidence' })).toBeVisible();
    await expect(page.getByText(cohortName)).toBeVisible();
    await expect(page.getByTestId('evidence-requirement')).toHaveCount(4);
    for (const c of CASES) {
      const row = page.getByTestId('evidence-requirement').filter({ hasText: c.title });
      await row.getByTestId('evidence-file').setInputFiles(join(FIX, c.file));
      await row.getByTestId('evidence-upload').click();
      await expect(row.getByText('Awaiting faculty review')).toBeVisible();
    }
    await expect(page.getByText('0 of 4')).toBeVisible();
    await shot(page, '09b-resident-evidence');
    await a11y(page, 'resident evidence');
    // residents cannot reach faculty pages
    await page.goto('/app/faculty');
    await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
    await signOut(page);
  });

  await test.step('faculty grades the short answer, releases, reviews performance', async () => {
    await signIn(page, ADMIN);
    await page.goto('/app/faculty');
    // "Needs attention" lists the attempt awaiting manual grading
    await expect(page.getByText('needs grading')).toBeVisible();
    await page.getByRole('listitem').filter({ hasText: 'needs grading' }).getByRole('link', { name: 'Dr. Demo Resident' }).click();
    await expect(page).toHaveURL(/\/app\/faculty\/attempts\//);
    await page.getByTestId('grade-points').fill('1');
    await page.getByTestId('save-grade').click();
    await expect(page.getByText('Grade saved.')).toBeVisible();
    await expect(page.getByText('100.0%')).toBeVisible(); // 1 + 1 + 1 of 3 points
    await page.getByTestId('release-one').click();
    await expect(page.getByText('Results released to the learner.')).toBeVisible();
    await shot(page, '10-attempt-review');
    await page.getByRole('link', { name: '← Exam results' }).click();
    await expect(page.locator('.stat', { hasText: 'completed' })).toContainText('1/1');
    await expect(page.getByText('Item analysis', { exact: true })).toBeVisible();
    await shot(page, '11-exam-results');
    await a11y(page, 'faculty results');
  });

  await test.step('learner profile shows domain performance and accepts faculty notes', async () => {
    await page.goto('/app/faculty');
    await page.getByRole('row').filter({ hasText: 'Dr. Demo Resident' }).getByRole('link', { name: 'Dr. Demo Resident' }).click();
    await expect(page.getByText('Cardiac / echocardiography').first()).toBeVisible();
    await page.getByPlaceholder(/Add an observation/).fill('Engaged well in the scanning sessions.');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(page.getByText('Engaged well in the scanning sessions.')).toBeVisible();
  });

  // ---------------------------------------------------------------- ITAR: faculty side
  const evidenceRow = (title: string) => page.getByTestId('evidence-row').filter({ hasText: title });

  await test.step('block overview lists the resident and what needs attention', async () => {
    await page.goto('/app/faculty');
    await page.getByTestId('block-card').filter({ hasText: cohortName }).click();
    await expect(page.getByRole('heading', { name: cohortName })).toBeVisible();
    const row = page.getByTestId('overview-row').filter({ hasText: 'Dr. Demo Resident' });
    await expect(row).toContainText('100.0%');
    await expect(row).toContainText('0/4');
    await expect(row).toContainText('4 to review');
    await expect(row).toContainText('not started');
    await expect(row).toContainText('Review evidence (4)');
    await shot(page, '12a-block-overview');
    await a11y(page, 'block overview');
    await row.click();
    await expect(page).toHaveURL(/\/app\/faculty\/itar\//);
  });

  await test.step('faculty previews evidence, verifies three and returns one for clarification', async () => {
    await expect(page.getByRole('heading', { name: 'Dr. Demo Resident' })).toBeVisible();
    // A. exam result comes in automatically, with the attempt used stated
    await expect(page.getByText(/Rule: most recent submitted attempt/)).toBeVisible();
    // PDF preview through a short-lived private link
    await evidenceRow('Gastric Ultrasound').getByTestId('preview-evidence').click();
    await expect(page.getByRole('dialog').locator('iframe')).toHaveAttribute('src', /\/storage\/v1\/object\/sign\/itar-evidence\//);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    // image preview actually renders
    await evidenceRow('Peripheral Vascular Access').getByTestId('preview-evidence').click();
    const img = page.getByRole('dialog').locator('img');
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(900);
    await shot(page, '12b-evidence-preview');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    for (const t of ['Gastric Ultrasound', 'Diaphragm POCUS', 'Optic Nerve Sheath']) {
      await evidenceRow(t).getByTestId('verify-evidence').click();
      await expect(evidenceRow(t).locator('.badge', { hasText: 'Verified' })).toBeVisible();
    }
    await evidenceRow('Peripheral Vascular Access').getByRole('button', { name: 'Needs clarification…' }).click();
    await evidenceRow('Peripheral Vascular Access').getByTestId('evidence-message').fill('The screenshot does not show the completion date clearly. Please upload the completion page.');
    await evidenceRow('Peripheral Vascular Access').getByRole('button', { name: 'Request clarification' }).click();
    await expect(evidenceRow('Peripheral Vascular Access').locator('.badge', { hasText: 'Clarification requested' })).toBeVisible();
    await signOut(page);
  });

  await test.step('resident sees the faculty message and uploads a replacement', async () => {
    await signIn(page, LEARNER);
    await expect(page.getByText('Action needed')).toBeVisible();
    await page.goto('/app/evidence');
    const row = page.getByTestId('evidence-requirement').filter({ hasText: 'Peripheral Vascular Access' });
    await expect(row.getByText(/does not show the completion date clearly/)).toBeVisible();
    await expect(page.getByText('3 of 4')).toBeVisible();
    await row.getByTestId('evidence-file').setInputFiles(join(FIX, 'SYNTHETIC-brightspace-completion-3.pdf'));
    await row.getByTestId('evidence-upload').click();
    await expect(row.getByText('Awaiting faculty review')).toBeVisible();
    // the resident sees no EPA review, observations or ITAR draft anywhere
    await expect(page.getByText(/EPA|ITAR draft|observation/i)).toHaveCount(0);
    await signOut(page);
  });

  let itarUrl = '';
  await test.step('faculty verifies the replacement, records the EPA review and observations', async () => {
    await signIn(page, ADMIN);
    await page.goto('/app/faculty');
    await page.getByTestId('block-card').filter({ hasText: cohortName }).click();
    await page.getByTestId('overview-row').filter({ hasText: 'Dr. Demo Resident' }).click();
    itarUrl = page.url();
    await expect(evidenceRow('Peripheral Vascular Access').getByText('Earlier uploads (1)')).toBeVisible();
    await evidenceRow('Peripheral Vascular Access').getByTestId('verify-evidence').click();
    await expect(page.locator('.checklist a.done', { hasText: 'Learning cases' })).toContainText('4/4 verified');

    // C. EPA review (fictional, transcribed from Elentra)
    await page.getByTestId('epa-id').first().fill('DEMO-EPA-1');
    await page.getByLabel('EPA title').first().fill('Fictional EPA: focused cardiac ultrasound');
    await page.getByLabel('Number of assessments').first().fill('3');
    await page.getByTestId('epa-entrustment').first().fill('Fictional: supervision on request');
    await page.getByTestId('epa-strengths').fill('Fictional data: clear communication of findings to the team');
    await page.getByTestId('epa-complete').click();
    await expect(page.locator('#epa').getByText(/^Complete/)).toBeVisible();

    // D. observations, by category
    await page.getByTestId('obs-category').selectOption('scanning');
    await page.getByTestId('obs-body').fill('Fictional: obtained PLAX and A4C views independently, adjusting depth and gain appropriately');
    await page.getByTestId('obs-add').click();
    await expect(page.getByText(/obtained PLAX and A4C views independently/)).toBeVisible();
    await page.getByTestId('obs-category').selectOption('professionalism');
    await page.getByTestId('obs-body').fill('Fictional: prepared for every session and sought feedback');
    await page.getByTestId('obs-add').click();
    await expect(page.getByText(/sought feedback/)).toBeVisible();
    await expect(page.getByText(/Other faculty notes on file, not tied to this block \(1\)/)).toBeVisible();
    await a11y(page, 'ITAR workspace');
  });

  await test.step('the ITAR draft is assembled from the evidence, edited and approved', async () => {
    await page.getByTestId('generate-draft').click();
    await expect(page.getByTestId('section-exam')).toHaveValue(/score was 100\.0%/);
    await expect(page.getByTestId('section-exam')).toHaveValue(/reflect knowledge only/);
    await expect(page.getByTestId('section-cases')).toHaveValue(/4 of 4 required learning cases was verified/);
    await expect(page.getByTestId('section-epa')).toHaveValue(/DEMO-EPA-1 — Fictional EPA: focused cardiac ultrasound: 3 assessments; entrustment: Fictional: supervision on request/);
    await expect(page.getByTestId('section-observations')).toHaveValue(/Practical scanning skills:\n• Fictional: obtained PLAX/);
    await expect(page.getByTestId('section-observations')).toHaveValue(/No observations recorded for: Clinical judgement, Technical performance/);
    await expect(page.getByTestId('section-observations')).not.toHaveValue(/Engaged well in the scanning sessions/); // not tied to the block
    await expect(page.getByTestId('section-sources')).toHaveValue(/4 verified by Dr\. Demo Faculty/);
    await expect(page.getByTestId('section-sources')).toHaveValue(/assigns no overall rating/);
    // faculty judgement is never filled in for them
    await expect(page.getByTestId('approve-eval')).toBeDisabled();
    await page.getByTestId('eval-strengths').fill('Fictional: consistent, careful image acquisition');
    await page.getByTestId('eval-areas').fill('Fictional: practise lung ultrasound in more patients');
    await page.getByTestId('generate-draft').click();
    await page.getByRole('button', { name: 'Replace draft text' }).click();
    await expect(page.getByTestId('approve-eval')).toBeEnabled();
    await page.getByTestId('section-strengths').fill('Fictional: consistent, careful image acquisition. Edited directly by faculty.');
    await page.getByTestId('save-eval').click();
    await expect(page.locator('#itar .badge', { hasText: 'Draft' })).toBeVisible();
    // saved: survives a full reload
    await page.reload();
    await expect(page.getByTestId('section-strengths')).toHaveValue(/Edited directly by faculty/);
    await shot(page, '12c-itar-draft');
    await page.getByTestId('approve-eval').click();
    await page.getByRole('button', { name: 'Approve and lock' }).click();
    await expect(page.locator('#itar').getByText(/^Approved/)).toBeVisible();
    await expect(page.getByTestId('section-strengths')).toBeDisabled();
  });

  await test.step('faculty copies and exports the approved ITAR', async () => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByTestId('copy-all').click();
    await expect(page.getByText('Whole draft copied')).toBeVisible();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain('KNOWLEDGE ASSESSMENT — WRITTEN EXAMINATION');
    expect(clip).toContain('Edited directly by faculty');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-text').click()]);
    const txt = await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8');
    expect(txt).toMatch(/Status: approved by Dr\. Demo Faculty/);
    expect(txt).toContain('EVIDENCE SOURCES AND VERIFICATION STATUS');
    await shot(page, '12d-itar-approved');
    // verification, EPA completion, approval and export are all in the audit log
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' });
    await db.connect();
    const { rows } = await db.query(
      `select action, count(*)::int n from public.audit_log a join public.profiles p on p.id = a.actor
        where p.email = $1 and action in ('evidence_verified','evidence_clarification_requested','epa_review_completed','evaluation_approved','itar_exported')
        group by action order by action`, [ADMIN]);
    await db.end();
    expect(Object.fromEntries(rows.map((r) => [r.action, r.n]))).toEqual({
      epa_review_completed: 1, evaluation_approved: 1, evidence_clarification_requested: 1, evidence_verified: 4, itar_exported: 2,
    });
  });

  await test.step('the block overview shows the resident complete', async () => {
    await page.getByRole('link', { name: '← Block' }).click();
    const row = page.getByTestId('overview-row').filter({ hasText: 'Dr. Demo Resident' });
    await expect(row).toContainText('4/4');
    await expect(row).toContainText('approved');
    await expect(row).toContainText('Complete');
    await expect(page.locator('.stat', { hasText: 'ITARs approved' })).toContainText('1/1');
    await shot(page, '12e-block-complete');
    await signOut(page);
  });

  await test.step('learner sees released results with full review', async () => {
    await signIn(page, LEARNER);
    await page.goto('/app/exams');
    await page.getByRole('link', { name: 'View results' }).click();
    await expect(page.getByTestId('score-card')).toContainText('100.0%');
    await expect(page.getByText('Demonstration explanation shown after results are released.').first()).toBeVisible();
    await expect(page.locator('video').first()).toBeVisible();
    await shot(page, '13-learner-results');
    await a11y(page, 'learner results');
  });
});

test('an invited person can also sign in by clicking the emailed link', async ({ page }) => {
  const email = `link-${RUN}@e2e.test`;
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' });
  await db.connect();
  await db.query(`insert into public.invitations (email, full_name, role) values ($1, 'Link Learner', 'learner')`, [email]);
  await db.end();
  await page.goto('/app/login');
  await page.getByLabel('Institutional email').fill(email);
  const t = Date.now() - 1000;
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await expect(page.getByText(/We sent a sign-in email/)).toBeVisible();
  let link: string | undefined;
  for (let i = 0; i < 40 && !link; i++) {
    const msgs = (await (await fetch(`${MAIL}?to=${encodeURIComponent(email)}`)).json()) as { text: string; at: number }[];
    link = msgs.filter((m) => m.at >= t).pop()?.text.match(/https?:\/\/\S+verify\?token=[^\s\]]+/)?.[0];
    if (!link) await new Promise((r) => setTimeout(r, 250));
  }
  expect(link).toBeTruthy();
  // the local auth server omits its /auth/v1 prefix in links; hosted Supabase does not
  const url = new URL(link!.replace(/&amp;/g, '&'));
  if (!url.pathname.startsWith('/auth/v1')) url.pathname = '/auth/v1' + url.pathname;
  await page.goto(url.toString());
  await expect(page).toHaveURL(/\/app\/?#?$/);
  await expect(page.getByRole('heading', { name: /Welcome, Link/ })).toBeVisible();
});
