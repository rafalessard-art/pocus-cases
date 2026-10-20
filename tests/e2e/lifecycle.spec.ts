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

  await test.step('evaluation workspace drafts from verified data and requires approval', async () => {
    await page.goto('/app/faculty');
    await page.getByRole('row').filter({ hasText: 'Dr. Demo Resident' }).getByRole('link', { name: 'Evaluation' }).click();
    await page.getByTestId('eval-observations').fill('Directly observed 8 focused cardiac scans with appropriate depth and gain adjustments.');
    await page.getByTestId('generate-draft').click();
    const summary = page.getByTestId('eval-summary');
    await expect(summary).toHaveValue(/score was 100\.0%/);
    await expect(summary).toHaveValue(/do not assess image acquisition/);
    await expect(summary).toHaveValue(/Faculty observations: Directly observed 8 focused cardiac scans/);
    await page.getByTestId('save-eval').click();
    await expect(page.getByText('Draft saved.')).toBeVisible();
    await page.getByTestId('approve-eval').click();
    await page.getByRole('button', { name: 'Approve and lock' }).click();
    await expect(page.getByText('Evaluation approved and locked.')).toBeVisible();
    await expect(summary).toBeDisabled();
    await shot(page, '12-evaluation');
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
