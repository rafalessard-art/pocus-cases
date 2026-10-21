# Testing

| Suite | Command | Needs |
|---|---|---|
| Unit (autosave, CSV, importer, evaluation drafting) | `npm run test:unit` | nothing |
| Database (RLS, secrecy, versioning, autosave, timing, grading, release, storage policy, evaluations) | `npm run test:db` | Postgres with Supabase roles + migrations applied |
| End-to-end lifecycle in a real browser (incl. axe WCAG 2.1 AA checks, phone width, offline) | `npm run test:e2e` | the full stack serving `dist/` + a mail catcher |
| Types | `npm run typecheck` | nothing |

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

## How the tests in this branch were run

The development container could not pull Docker images, so it ran the real Supabase components natively:

- PostgreSQL 16 with Supabase's roles and schemas;
- GoTrue v2.180 (Supabase Auth), with the before-user-created hook enabled;
- PostgREST v12;
- Supabase Storage API v1.40 (file backend, TUS resumable uploads);
- a small gateway emulating Kong's routing;
- an SMTP catcher.

Results: **60 unit, 79 database and both end-to-end tests passed** (Oct 21) (the main scenario includes the ITAR workflow: evidence upload → preview → verify/clarify → re-upload → streamlined EPA verification (with optional C6 counts) → observations → ITER-ready summary → faculty dashboard task links → resident named-case upload deep link → ITER Quick Copy drafted from evidence (basis unticked, Full Evidence Record separate) → faculty edits and confirms basis → approve → section copy / transfer sheet → block overview; plus rotation requirements: resident scan self-report and submissions → faculty batch scan attestation (with the identifier guard) → confirmations / not-yet-due → completion section in the draft). The local auth server's per-address email interval is set to 1 s (`GOTRUE_SMTP_MAX_FREQUENCY=1s`) because the scenario signs the same person in several times within a minute; hosted Supabase keeps its default.

Playwright's bundled open-source Chromium cannot decode H.264, so the end-to-end test uses VP9/WebM versions of the EchoSimulator loops (`tests/e2e/fixtures`). H.264 MP4 playback should be confirmed in Safari, Chrome and Firefox on the preview deployment; this is part of the go-live checklist.
