# Testing

| Suite | Command | Needs |
|---|---|---|
| Unit (autosave, CSV, importer, evaluation drafting) | `npm run test:unit` | nothing |
| Database (RLS, secrecy, versioning, autosave, timing, grading, release, storage policy, evaluations) | `npm run test:db` | Postgres with Supabase roles + migrations applied |
| End-to-end lifecycle in a real browser (incl. axe WCAG 2.1 AA checks, phone width, offline) | `npm run test:e2e` | the full stack serving `dist/` + a mail catcher |
| Types | `npm run typecheck` | nothing |
| **Visual report** (screenshots of every main screen) | `npm run visual` | Docker + Supabase CLI, `supabase start` |

## Supported versions

- **Node.js 22** (LTS) is the supported local version; `.nvmrc` pins it and `package.json` allows 20–24. On a Mac: `brew install node@22`, then `export PATH="$(brew --prefix node@22)/bin:$PATH"`. Playwright's browser install stalls on Node 26.
- Supabase CLI 3.x with Docker (OrbStack, Docker Desktop or Colima) for the full local stack.

## Full validation on a Mac (WP3)

`npm run validate:wp3` (`scripts/wp3-validate.sh`) runs every suite against the **local** stack and writes the results to `.wp3-validation/` (git-ignored): `npm ci`, database reset, typecheck, unit, database (including the reviewer sweeps), the live sign-in tests with the `demo-redeem` function, and the visual report with all three browser suites (lifecycle, owner sign-in security, reviewer journey). It finishes by loading the demonstration fixtures (with their synthetic files) into the local database for exploring by hand. It aborts unless every address is local, and never links, pushes or deploys.

## Visual report — one command

`npm run visual` runs the end-to-end tests on a local copy of the portal and writes **`visual-report/index.html`**. The report groups the screenshots by screen: sign-in and account security, resident dashboard, requirements and scans, exam interface, faculty dashboard, learner workspace, exam management, demonstration access (owner and reviewer), and ITER Quick Copy. The local build includes demonstration sign-in (`VITE_DEMO_ACCESS=true`); the reviewer journey needs `supabase functions serve demo-redeem` running (the validation script starts it). Access codes are masked in screenshots. Pass or fail and the commit are shown at the top. On a Mac the report opens automatically.

**One-time setup:**
1. Install Docker: Docker Desktop, or the free OrbStack or Colima.
2. Install the Supabase CLI: `brew install supabase/tap/supabase`.
3. In this folder, run `npm ci`, then `npx playwright install chromium`.

**Each time:** start Docker, then:
- run `supabase start` (the first run downloads images for a few minutes; leave it running);
- run `npm run visual`;
- when finished, `supabase stop`.

**What it does**, in `scripts/visual-report.mjs`:
1. Reads the local stack's addresses from `supabase status`.
2. Resets the **local** database (migrations + seed).
3. Builds the site against it.
4. Serves the site with `scripts/local-gateway.mjs`. The gateway puts the site, the API and the local mail catcher on one address, `http://127.0.0.1:4173`.
5. Runs `npx playwright test` with `E2E_SHOTS`, then builds the page.

**Options:**
- `--no-reset` keeps the local data.
- `--report-only` rebuilds the page from the last screenshots.
- `--no-open` doesn't open the report.

**Safety.** The runner and `playwright.config.ts` both refuse any address that isn't localhost. After building, the runner checks that the portal points only at the local stack, and stops if it mentions a hosted Supabase project. The demonstration and production databases are never touched.

The local-only settings in `supabase/config.toml` (a higher email limit and the `:4173` redirect) affect only `supabase start`, not the hosted projects.

**Status (Oct 28):** the gateway, mail adapter, safety checks and report page were each checked in the development workspace. That workspace can't download Supabase's container images, so the first complete run of `npm run visual` happens on a Mac with Docker.

## With the Supabase CLI (Docker)

```bash
npx supabase start
npx supabase db reset                                  # migrations + seed
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm run test:db
```

For end-to-end testing, build with the local URL and anon key that `supabase start` prints, and serve `dist/` behind the same origin as the API (or point `E2E_BASE_URL` at a host doing so):

```bash
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=<local anon key> npm run build
E2E_BASE_URL=… E2E_MAIL_URL=<mail viewer JSON endpoint> DATABASE_URL=… npm run test:e2e
```

`E2E_RESET_CMD` (optional) runs before the suite, e.g. `"npx supabase db reset"`. `E2E_SHOTS=<dir>` saves a screenshot at each step of the walkthrough.

## Without Docker (plain PostgreSQL 16)

The database suites also run on a plain PostgreSQL 16 server (CI, or a machine without Docker). `scripts/local-stack/bootstrap.sql` provides the Supabase roles, schemas and `auth.*` functions the migrations need:

```bash
createdb portal
psql postgresql://postgres:postgres@127.0.0.1:5432/portal -f scripts/local-stack/bootstrap.sql
for f in supabase/migrations/*.sql; do psql postgresql://postgres:postgres@127.0.0.1:5432/portal -v ON_ERROR_STOP=1 -f "$f"; done
psql postgresql://postgres:postgres@127.0.0.1:5432/portal -f supabase/seed.sql
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/portal npm run test:db
```

## Demonstration fixtures

`npm run fixtures:demo` (with `DATABASE_URL` of the local database) loads the fictional cast, blocks, demonstration exam and synthetic evidence described in [DEMO_ACCESS](DEMO_ACCESS.md). Add `STORAGE_URL` and `SERVICE_ROLE_KEY` of the local stack to upload the synthetic files too. `tests/db/reviewer-views.test.ts` and `tests/e2e/reviewer.spec.ts` load them themselves.

## Authentication against a live local stack

`npm run test:auth` exercises the parts only a real Supabase Auth server can show: password sign-in, authenticator-app (TOTP) enrolment and verification, the staged administrator MFA requirement, and demonstration-code redemption through the `demo-redeem` function. It needs `supabase start` plus `supabase functions serve demo-redeem --env-file supabase/functions/.env.example`, and the variables listed at the top of `tests/auth/live-stack.test.ts`. Without `AUTH_STACK_URL` the suite is skipped.

## How the tests in this branch were run

The development container could not pull Docker images, so it ran the real Supabase components natively:

- PostgreSQL 16 with Supabase's roles and schemas;
- GoTrue v2.180 (Supabase Auth), with the before-user-created hook enabled;
- PostgREST v12;
- Supabase Storage API v1.40 (file backend, TUS resumable uploads);
- a small gateway emulating Kong's routing;
- an SMTP catcher.

Results: **62 unit, 79 database and both end-to-end tests passed** (Oct 21; final pre-demonstration regression) (the main scenario includes the ITAR workflow: evidence upload → preview → verify/clarify → re-upload → streamlined EPA verification (with optional C6 counts) → observations → ITER-ready summary → faculty dashboard task links → resident named-case upload deep link → ITER Quick Copy drafted from evidence (basis unticked, Full Evidence Record separate) → faculty edits and confirms basis (no "Yes, Fully" reminder when nothing required is outstanding) → approve → section copy / transfer sheet → block overview; plus rotation requirements: resident scan self-report and submissions → faculty batch scan attestation (with the identifier guard) → confirmations / not-yet-due → completion section in the draft). The local auth server's per-address email interval is set to 1 s (`GOTRUE_SMTP_MAX_FREQUENCY=1s`) because the scenario signs the same person in several times within a minute; hosted Supabase keeps its default.

Playwright's bundled open-source Chromium cannot decode H.264, so the end-to-end test uses VP9/WebM versions of the EchoSimulator loops (`tests/e2e/fixtures`). H.264 MP4 playback should be confirmed in Safari, Chrome and Firefox on the preview deployment; this is part of the go-live checklist.


The tests only run against a local stack: `tests/local-only.ts` stops them if `DATABASE_URL`, `E2E_BASE_URL` or `E2E_MAIL_URL` points anywhere else.
