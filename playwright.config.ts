import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a full Supabase-compatible stack serving the
 * built site (see docs/exam-platform/TESTING.md):
 *   E2E_BASE_URL   site + /auth/v1 + /rest/v1 + /storage/v1 (default http://127.0.0.1:54321)
 *   E2E_MAIL_URL   mail catcher returning JSON messages (default http://127.0.0.1:2501/messages)
 *   DATABASE_URL   used only to create the first admin invitation
 */
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:54321',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1360, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 900 } } }],
});
