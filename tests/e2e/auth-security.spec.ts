/**
 * Owner sign-in security, end to end in a real browser against the LOCAL stack:
 *   email-code sign-in → set a password → add two authenticator apps →
 *   password sign-in + authenticator challenge → require MFA for admins →
 *   recovery: email code + backup authenticator → new password (including
 *   the emailed re-authentication code once the session is older than 24 h).
 * Screenshots (E2E_SHOTS) feed the "Sign-in and account security" section of npm run visual.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';

const MAIL = process.env.E2E_MAIL_URL ?? 'http://127.0.0.1:2501/messages';
const SHOTS = process.env.E2E_SHOTS;
const RUN = Date.now().toString(36);
const OWNER = `owner-${RUN}@e2e.test`;
const PW1 = `Correct-Horse-${RUN}-1`;
const PW2 = `Correct-Horse-${RUN}-2`;
const PW3 = `Correct-Horse-${RUN}-3`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/postgres' });

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.addStyleTag({ content: '.topnav{position:static!important}' }); // no sticky header mid-page in full-page shots
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}
async function a11y(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${label}: ${v.id} — ${v.help} (${v.nodes.length})`)).toEqual([]);
}

/** RFC 6238 TOTP; waits for a fresh 30-second window so no code is used twice. */
const lastWindow = new Map<string, number>();
async function totp(secret: string): Promise<string> {
  let w = Math.floor(Date.now() / 30000);
  if (lastWindow.get(secret) === w) {
    await new Promise((r) => setTimeout(r, (w + 1) * 30000 - Date.now() + 300));
    w = Math.floor(Date.now() / 30000);
  }
  lastWindow.set(secret, w);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(w));
  const h = createHmac('sha1', key).update(ctr).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
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
  throw new Error(`no email code received for ${email}`);
}

async function emailCodeSignIn(page: Page) {
  await page.goto('/app/login');
  await page.getByLabel('Institutional email').fill(OWNER);
  const t = Date.now() - 1000;
  await page.getByRole('button', { name: 'Email me a sign-in code' }).click();
  await expect(page.getByText(/We sent a sign-in email/)).toBeVisible();
  await page.getByLabel('Sign-in code').fill(await latestCode(OWNER, t));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function passwordSignIn(page: Page, password: string, screenshot?: string) {
  await page.goto('/app/login');
  await page.getByTestId('use-password').click();
  await page.getByLabel('Institutional email').fill(OWNER);
  await page.getByLabel('Password', { exact: true }).fill(password);
  if (screenshot) await shot(page, screenshot);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page.getByLabel('Institutional email')).toBeVisible();
}

async function addAuthenticator(page: Page, name: string, screenshot?: string): Promise<string> {
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByTestId('mfa-add').click();
  const form = page.getByTestId('mfa-enroll');
  await expect(form.getByRole('img', { name: /QR code/ })).toBeVisible();
  const secret = (await form.locator('.mono').innerText()).trim();
  if (screenshot) await shot(page, screenshot);
  await form.getByLabel('Code from the app').fill(await totp(secret));
  await form.getByRole('button', { name: 'Confirm and add' }).click();
  await expect(page.getByTestId('mfa-card').locator('li', { hasText: name })).toHaveCount(1);
  return secret;
}

async function confirmWithAuthenticator(page: Page, secret: string, factorLabel?: RegExp) {
  await expect(page).toHaveURL(/\/app\/mfa/);
  const form = page.getByTestId('mfa-form');
  if (factorLabel) {
    const sel = form.getByLabel('Authenticator');
    const value = await sel.locator('option', { hasText: factorLabel }).first().getAttribute('value');
    await sel.selectOption(value!);
  }
  await form.getByLabel('Code', { exact: true }).fill(await totp(secret));
  await form.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' }).first()).toBeVisible();
  await expect(page).not.toHaveURL(/\/app\/mfa/);
}

test.beforeAll(async () => {
  await db.connect();
  await db.query(`insert into public.invitations (email, full_name, role) values ($1, 'Dr. Demo Owner', 'admin')`, [OWNER]);
  await db.query(`update public.deployment_settings set admin_mfa_required = false`);
});

test.afterAll(async () => {
  // Never leave the requirement on for the other suites.
  await db.query(`update public.deployment_settings set admin_mfa_required = false`).catch(() => {});
  await db.end();
});

test('owner: password, two authenticators, staged MFA requirement and recovery', async ({ page }) => {
  let phone = '';
  let backup = '';

  await test.step('sign in with an email code, then set a password', async () => {
    await emailCodeSignIn(page);
    await page.getByRole('link', { name: 'Account' }).click();
    await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible();
    await shot(page, 'a2-account-security');
    await a11y(page, 'account security');
    await page.getByLabel('New password', { exact: true }).fill(PW1);
    await page.getByLabel('Repeat new password').fill(PW1);
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByText(/Password saved/)).toBeVisible();
  });

  await test.step('add a phone authenticator and a backup authenticator', async () => {
    phone = await addAuthenticator(page, 'Phone', 'a3-add-authenticator');
    backup = await addAuthenticator(page, 'Backup');
    await expect(page.getByTestId('admin-mfa-card').getByRole('button', { name: 'Require it' })).toBeEnabled();
    await shot(page, 'a4-two-authenticators');
  });

  await test.step('sign in with the password; the authenticator is asked for next', async () => {
    await signOut(page);
    await passwordSignIn(page, PW1, 'a1-password-sign-in');
    await expect(page).toHaveURL(/\/app\/mfa/);
    await shot(page, 'a5-authenticator-challenge');
    await a11y(page, 'authenticator challenge');
    // nothing behind the challenge is reachable by URL before confirming
    await page.goto('/app/admin');
    await expect(page).toHaveURL(/\/app\/mfa/);
    await confirmWithAuthenticator(page, phone, /Phone/);
    await expect(page).toHaveURL(/\/app\/admin/); // back to the page that was asked for
  });

  await test.step('require an authenticator for administrators (database-enforced)', async () => {
    await page.getByRole('link', { name: 'Account' }).click();
    const card = page.getByTestId('admin-mfa-card');
    await card.getByRole('button', { name: 'Require it' }).click();
    await expect(card.getByText('Required', { exact: true })).toBeVisible();
    await shot(page, 'a6-mfa-required');
    const r = await db.query(`select admin_mfa_required from public.deployment_settings`);
    expect(r.rows[0].admin_mfa_required).toBe(true);
  });

  await test.step('recovery: forgotten password → email code + backup authenticator → new password', async () => {
    await signOut(page);
    await emailCodeSignIn(page);
    await expect(page).toHaveURL(/\/app\/mfa/);
    await confirmWithAuthenticator(page, backup, /Backup/);
    await page.getByRole('link', { name: 'Account' }).click();
    await page.getByLabel('New password', { exact: true }).fill(PW2);
    await page.getByLabel('Repeat new password').fill(PW2);
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByText(/Password saved/)).toBeVisible();
    await signOut(page);
    await passwordSignIn(page, PW1);
    await expect(page.getByText(/Email or password not recognised/)).toBeVisible();
    await passwordSignIn(page, PW2);
    await confirmWithAuthenticator(page, phone, /Phone/);
  });

  await test.step('a session older than 24 hours must confirm a password change with an emailed code', async () => {
    const u = await db.query(`select id from auth.users where email = $1`, [OWNER]);
    await db.query(`update auth.sessions set created_at = now() - interval '25 hours' where user_id = $1`, [u.rows[0].id]);
    await page.getByRole('link', { name: 'Account' }).click();
    await page.getByLabel('New password', { exact: true }).fill(PW3);
    await page.getByLabel('Repeat new password').fill(PW3);
    const t = Date.now() - 1000;
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByText(/we emailed you a confirmation code/i)).toBeVisible();
    await page.getByLabel('Confirmation code from the email').fill(await latestCode(OWNER, t));
    await shot(page, 'a7-reauthentication-code');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByText(/Password saved/)).toBeVisible();
    await signOut(page);
    await passwordSignIn(page, PW3);
    await confirmWithAuthenticator(page, backup, /Backup/);
  });

  await test.step('turn the requirement off again (only possible from a confirmed session)', async () => {
    await page.getByRole('link', { name: 'Account' }).click();
    const card = page.getByTestId('admin-mfa-card');
    await card.getByRole('button', { name: 'Stop requiring it' }).click();
    await expect(card.getByText('Not required', { exact: true })).toBeVisible();
  });
});
