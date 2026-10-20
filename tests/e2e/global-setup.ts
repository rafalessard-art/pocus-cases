import { execSync } from 'node:child_process';

/** Optionally reset the test database first (e.g. E2E_RESET_CMD="supabase db reset"). */
export default function globalSetup() {
  if (process.env.E2E_RESET_CMD) execSync(process.env.E2E_RESET_CMD, { stdio: 'inherit' });
}
