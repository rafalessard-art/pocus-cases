# Deployment

Nothing here touches production until you merge the `feature/exam-platform` branch. Until a Supabase project is connected, the portal at `/app` shows a "not configured" page and the public site is unaffected.

> **Before real learners or real clinical images:** complete the approvals in [PRIVACY_AND_GOVERNANCE.md](PRIVACY_AND_GOVERNANCE.md). This build has not been institutionally approved.

## 1. Create the Supabase project (≈10 min, browser only)

1. <https://supabase.com> → New project. **Region: Canada (Central) — `ca-central-1`.** Set a strong database password and store it in your password manager.
2. Plan: **Free** is fine for building and a demo. Free projects pause after a week without activity and include no backups, so use **Pro** before any live exam (see §8).

## 2. Create the database schema

Use **either** option.

**A — no terminal (simplest).** Dashboard → SQL Editor → New query → paste the whole of **`docs/exam-platform/supabase-setup.sql`** → Run. It is every migration below in order plus the first-administrator invitation, and runs as one transaction (all or nothing). Or paste and run each file in `supabase/migrations/` **in filename order**:

```
20261020000100_core.sql
20261020000200_content.sql
20261020000300_delivery.sql
20261020000400_assessment.sql
20261020000500_storage_and_grants.sql
20261020000600_pocus_course.sql
20261020000700_itar_preparation.sql
20261020000800_rotation_requirements.sql
20261020000900_validation_fixes.sql
20261020001000_scan_totals.sql
20261020001100_epa_verification.sql
20261020001200_iter_export.sql
20261020001300_iter_without_canmeds.sql
```

**B — Supabase CLI.**

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # applies supabase/migrations in order
```

This creates every table with row-level security, the private `exam-media` and `itar-evidence` buckets with their policies, the POCUS course with draft objectives, and curriculum links to the existing cases and tools.

## 3. Authentication settings

| Where (Dashboard) | Setting |
|---|---|
| Authentication → Sign In / Providers → **Email** | Enabled. **Allow new users to sign up: ON.** Invited people need it for their first sign-in; the hook below blocks everyone else. Email OTP expiration: `900` seconds. Turn off every other provider (phone, OAuth, anonymous). |
| Authentication → **Hooks** → *Before User Created* | Enable → type **Postgres** → schema `public` → function `hook_before_user_created`. |
| Authentication → **Emails → Templates** → *Magic Link* **and** *Confirm signup* (editable only after custom SMTP is configured; until then Supabase's default email contains a sign-in **link**, which the portal also accepts) | Subject `Your POCUS Portal sign-in code`; body = contents of `supabase/templates/sign-in-code.html`. The template **must** contain `{{ .Token }}`: the portal signs people in with a 6-digit code, never a link, because hospital mail scanners pre-open links and burn them. |
| Authentication → **URL Configuration** | Site URL `https://pocus-cases.vercel.app/app/`; Redirect URLs `https://pocus-cases.vercel.app/app/**` and `https://pocus-cases-*-rafalessard-8465s-projects.vercel.app/app/**` (previews) — needed for the emailed sign-in link |
| Authentication → **SMTP Settings** | **Required for real use.** Supabase's built-in sender is heavily rate-limited and only delivers to members of your Supabase team. Use an institutional SMTP relay (ask uOttawa/TOH IT) or a transactional email provider. Sender, for example, `POCUS Portal <no-reply@your-domain>`. |
| Authentication → Rate limits | Defaults are fine; raise "emails sent per hour" if a whole cohort signs in at once. |

## 4. Create the first administrator

SQL Editor:

```sql
insert into public.invitations (email, full_name, role)
values ('your.institutional@email', 'Your Name', 'admin');
```

Then sign in at `/app/login` with that email. Invite everyone else from **Admin → People**.

## 5. Connect Vercel

Vercel → project `pocus-cases` → Settings → **Environment Variables**. Add both values to **Preview** and **Production**:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | Supabase → Project Settings → API → Project URL (`https://<ref>.supabase.co`) |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API → `anon` / publishable key |

For this project both values are already committed in `.env.production` (they are public by design), so the build works without dashboard settings. Vercel variables with the same names override the file.

The anon key is designed to be public: it grants nothing beyond what RLS allows. **Never** put the `service_role` key or database password in Vercel, in the code or in the browser. The portal does not need them.

`vercel.json` now tells Vercel to run `npm ci && npm run build` and serve `dist/`. No dashboard build settings need changing.

## 6. Deploy and verify

1. Push the branch, or open a pull request. Vercel builds a **preview deployment** (protected by your Vercel login).
2. On the preview, check:
   - the home page, every case, `/tools` and the 3 interactive tools load exactly as before;
   - `/app` → sign in as admin;
   - upload one MP4 clip → authorize + de-identify → write a question → build, publish and assign an exam to yourself → take it → grade and release → draft an evaluation.
3. Merge to `main` → production. Vercel's **Instant Rollback** restores the previous deployment in one click if anything is wrong.

## 7. Optional hardening

- **Auto-close abandoned timed attempts on schedule.** Attempts close lazily whenever anyone next views them. To close them on the clock instead, enable the `pg_cron` extension (Database → Extensions) and run:
  ```sql
  select cron.schedule('finalize-overdue-attempts', '*/5 * * * *', $$select public._finalize_overdue(null, null)$$);
  ```
- **Custom Supabase domain.** If you use one, add it to the `Content-Security-Policy` in `vercel.json` (currently `https://*.supabase.co`).
- Turn on **MFA** for administrators (Authentication → Multi-Factor) and enforce it at the organization level in Supabase.
- Restrict who has access to the Supabase dashboard. Every dashboard user can read all data.

## 8. Estimated recurring cost (small scale)

Approximate figures in USD. Check current pricing before committing.

| Item | Pilot | Departmental use |
|---|---|---|
| Supabase | Free ($0): 500 MB DB, 1 GB storage, 5 GB egress; pauses when idle; no backups | **Pro ≈ $25/mo**: 8 GB DB, 100 GB storage, 250 GB egress, daily backups, no pausing |
| Vercel | Hobby ($0), for personal and non-commercial use | Pro ≈ $20/user/mo if departmental use falls outside Hobby terms |
| Email (SMTP) | Institutional relay ($0) or a provider's free tier | ≈ $0–15/mo |
| **Total** | **≈ $0** | **≈ $25–60/mo** |

**Scale check.** A 40-question exam with 5 MB clips is about 200 MB per learner sitting, so 30 learners × 3 sittings a year ≈ 18 GB of egress, well inside Pro's allowance. A library of 500 clips at 5 MB is about 2.5 GB of storage.

## 9. Local development

```bash
cp .env.example .env.local          # point at a dev Supabase project, or local CLI (below)
npm ci
npm run dev                         # portal on http://127.0.0.1:5173/app/
# local Supabase (Docker required):
npx supabase start && npx supabase db reset   # applies migrations + seed (admin@localhost.test)
```

Local sign-in codes appear in the CLI's mail viewer (the URL is printed by `supabase start`).
