# Institutional deployment readiness

**Current state:** a preview only (Vercel preview of `feature/exam-platform` + Supabase project `ngnggoekezucadlwiomp`, Canada Central). It holds fictional data only, and no real residents are invited. **Keep it that way until the approvals below are in place.**

**Feature freeze (Oct 21, 2026):** no further feature development until the POCUS rotation director and supervising staff have given feedback. Only fixes needed for the demonstration are allowed.

## Keeping demonstration data out of real records

| Safeguard | How |
|---|---|
| Separate databases | Fictional residents, demo exams, synthetic Brightspace files and demo ITER drafts exist only in the demonstration project. Migrations seed reference data only. Production is a new project built from the migrations, never a copy. |
| Build guard | A production build pointed at the demonstration project gets no database connection (`scripts/build-site.mjs`), so merging to `main` cannot expose or reuse the demo data. |
| Visible labelling | While connected to the demonstration project, every portal page shows "Demonstration environment — fictional residents and synthetic documents only". ITER printouts and .txt downloads carry "DEMONSTRATION — FICTIONAL DATA, NOT A LEARNER RECORD", and exported files start with `DEMO_`. |
| Tests stay local | Unit, database and end-to-end tests refuse any non-local database or site URL (`tests/local-only.ts`), so they cannot write fictional data to, or reset, a hosted database. |
| Content | Demo names are marked "(fictional)", demo exams "DEMO", and synthetic files "SYNTHETIC … NOT A REAL BRIGHTSPACE RECORD". The real ITER/EPA examples were never stored. |

## Data collected, access and storage

| Data | Who can see it | Stored in |
|---|---|---|
| Name, institutional email, role, training level | The person, admins, block evaluators | Supabase Postgres (ca-central-1) |
| Exam answers, scores, attempts | The resident (per release policy), block evaluators, admins | Postgres |
| Brightspace completion screenshots/PDFs | The resident, block evaluators, admins | Supabase Storage, private bucket (ca-central-1) |
| EPA verification: Elentra-review attestation and criteria decision | The resident (decision, reviewer and date only), block evaluators, admins | Postgres |
| EPA notes, concerns, optional C6 counts and findings; faculty observations; ITAR/ITER drafts, ITER selections and approved versions | Block evaluators and admins only, **never residents** | Postgres |
| Rotation requirement statuses; scan **counts** per category (no patient data) | The resident (own), block evaluators, admins | Postgres |
| Audit log (approvals, verifications, exports, deletions) | Admins | Postgres |
| Ultrasound teaching clips (de-identified/synthetic, with provenance) | Staff; residents during exams | Private Storage bucket |

**Not collected:** patient identifiers or images in the requirements or scan log, student numbers, dates of birth, passwords (email sign-in only), analytics cookies.

Vercel serves only static code; it stores no learner data.

## Approvals needed before real residents

1. **Privacy impact assessment** (uOttawa AIPO and PGME; TOH Privacy if any clinical clips are used). Cover:
   - resident assessment data;
   - uploaded evidence;
   - EPA/ITAR text;
   - US-headquartered vendors with Canadian hosting (CLOUD Act question).
2. **IT security review** (uOttawa / TOH):
   - vendor risk for Supabase and Vercel;
   - SSO preference;
   - incident response.
3. **Records retention:** evidence files, approved ITAR versions, exam records, audit log (see PRIVACY_AND_GOVERNANCE.md §5).
4. **Program approval:** the director decisions (DIRECTOR_DECISIONS.md) and the PGME evaluation policy (the official ITER is completed and submitted in One45; EPAs remain in Elentra).

## Technical items for production

- **SMTP sender** (required): an institutional relay or an approved provider. This allows email to any resident (the default Supabase sender reaches only the project team), the 6-digit code sign-in, and moving the admin to rlessard@toh.ca.
- **Supabase plan:**
  - Pro plan for daily backups (Point-in-Time Recovery optional);
  - a separate **production project** (don't reuse the preview database);
  - enable leaked-password and rate-limit settings;
  - review the auth redirect URLs.
- **Vercel:** merge to `main` only after approval. The production domain is `pocus-cases.vercel.app` or an institutional domain. Keep preview protection on.
- **Exam:** publish the real exam with a 75% threshold and confirmed attempts and feedback settings.
- **Optional:** SSO (institutional identity provider), scheduled auto-close of abandoned attempts (pg_cron), and approved Brightspace / Elentra / QPath count imports (the data model reserves them; Elentra design in ELENTRA_IMPORT_PROPOSAL.md).
- **Operations:** a named admin and a backup admin, export of results and approved ITARs each block, and an incident contact.
