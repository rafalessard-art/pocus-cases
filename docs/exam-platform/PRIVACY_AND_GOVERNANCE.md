# Privacy, security and governance

**Status: development prototype. Not institutionally approved.** Do not enter identifiable learner results or real clinical images until the approvals in §1 are in place. These are engineering notes, not legal advice. The uOttawa and TOH privacy offices make the actual determinations.

## 1. Approvals to obtain before live use

| Body | Why | What to bring |
|---|---|---|
| **uOttawa Access to Information and Privacy Office (AIPO)** | Universities are institutions under Ontario's *FIPPA*. Learner assessment records are personal information. Since **1 July 2025** (Bill 194), FIPPA requires a **privacy impact assessment before** any new collection of personal information, with the identified mitigations implemented before collection starts. | This document, the data inventory (§2), the architecture (README) and the Supabase/Vercel terms |
| **uOttawa IT security** (and/or TOH IS) | Third-party cloud services, threat/risk assessment, SSO options | Architecture, hosting regions, access model |
| **PGME / Department of Anesthesiology** | Use of exam results in end-of-block evaluations; assessment policy; accommodations process | Exam settings, feedback/release policy, evaluation workflow |
| **TOH Privacy Office** (for any clip from TOH patients) | Clinical images originate as personal health information under *PHIPA*. Using them for teaching requires proper de-identification and authorization | De-identification procedure ([MEDIA_GUIDE.md](MEDIA_GUIDE.md)), clip provenance and authorization records |
| **Content owners** | The rights to reuse the existing ExamBuilder questions and clips | Who authored the exam and the clips |

## 2. Data inventory (minimized by design)

| Data | Where | Who can see it |
|---|---|---|
| Name, institutional email, role, training level, program | `profiles`, `invitations` | The person; admins; faculty for learners in their cohorts |
| Cohort membership, rotation dates | `cohorts`, `cohort_members` | Staff; the learner for their own |
| Exam answers, scores, timestamps | `attempts`, `responses` | The learner (only what the release policy allows); faculty for their cohorts; admins |
| Accommodations (factor/minutes/attempts + short note) | `accommodations` | Faculty for their learners; admins. **No medical details by policy** |
| Faculty notes, evaluations | `faculty_notes`, `evaluations` | Faculty for their cohorts; admins. Never learners in this version |
| Curriculum completion (self-reported) | `curriculum_progress` | The learner; faculty for their cohorts |
| De-identified ultrasound media + provenance | Storage `exam-media`, `media_assets` | Staff; learners only during an attempt (or a released full review) |
| Learning-case completion evidence (resident-uploaded screenshots/PDFs; filename, SHA-256, review status, reviewer message) | Storage `itar-evidence`, `evidence_submissions` | The resident (own files and review message); faculty who are evaluators of that resident's block; admins |
| EPA verification: Elentra-review attestation, criteria decision, optional C6 counts (assessments reviewed, per entrustment level), optional findings and notes. No EPA forms are uploaded. | `epa_reviews` | Evaluators of the block; admins. Learners see only the criteria decision, reviewer and date |
| Categorised faculty observations | `faculty_notes` (with block) | Evaluators of the block; admins. Never learners |
| ITAR/ITER drafts and approvals, faculty ITER selections (rotation objectives, basis of assessment, discussed with trainee) and narrative, evidence snapshot; immutable approved versions | `evaluations`, `evaluation_versions` | Evaluators of the block; admins. Never learners |
| ITER export template (headings and options only; no learner data) | `iter_templates` | Staff read; admins edit |
| Rotation requirement status (status, stage, short resident note, short faculty message, who verified and when) | `requirement_status` | The resident (own); evaluators of the block; admins |
| Reviewed-scan **counts** per category (no patient-level rows, images, MRNs, names, DOBs or scan dates/locations; short notes screened server-side for identifier patterns) | `scan_attestations` (faculty-attested), `scan_self_reports` (resident-reported, never counted) | Attestations: evaluators of the block, admins; the resident sees totals and history without notes. Self-reports: the resident and evaluators |
| Audit events | `audit_log` | Admins |

Not collected: student numbers, dates of birth, phone numbers, addresses, IP-based tracking or analytics cookies. Sign-in uses email codes, so there are no passwords to leak.

**Institutional assessment records:** real ITERs and EPA forms are never uploaded to the portal or used as test data; the ITER-ready layout was built from the form's structure, and tests use a fictional example.

**Evidence uploads:** residents are told to upload only Brightspace completion pages, and never anything with patient information. Admins can delete a file uploaded in error (audited, with a reason).

## 3. Hosting and residency

- **Data at rest:** Supabase project in **Canada (Central), `ca-central-1`**. This covers the database, auth and file storage.
- **Vercel** serves only static code. No learner data is stored there.
- **Email:** sign-in codes go through the configured SMTP provider. Messages contain only the code. An institutional relay keeps them on-premise.
- Supabase and Vercel are US-headquartered companies. Even with data in Canada, a privacy office may ask about foreign legal access (e.g. the US CLOUD Act). Ontario FIPPA has no blanket data-residency mandate (unlike, historically, BC and Nova Scotia), but institutional policy may impose one. Raise this explicitly in the PIA.

## 4. Security controls implemented

- Row-level security on every table; anonymous access revoked; role checks inside every privileged function.
- No service-role key or database password in the app or its hosting.
- Invitation-only accounts (auth hook + profile gating). Deactivation removes access immediately.
- One-time 6-digit email codes (15-minute expiry); session tokens refresh automatically; sign-out clears them.
- Private media bucket; short-lived signed URLs; uploads only for pre-registered paths.
- Answer keys and explanations are never sent to learners before release.
- Immutable history: published exams, used question versions, uploaded media, attempts, responses and approved evaluations cannot be altered (re-opening an evaluation is logged).
- Append-only audit log.
- Security headers on `/app` (CSP, frame-ancestors none, nosniff, referrer policy, no indexing).

**Recommended next:**
- MFA for admin accounts and the Supabase dashboard; restrict dashboard membership.
- uOttawa SSO (Microsoft Entra ID via Supabase's Azure provider or SAML; needs IT to register the app). The invitation model stays as the authorization layer.
- A formal incident-response contact.

## 5. Retention and deletion (proposal for the PIA)

| Record | Proposed retention | Mechanism |
|---|---|---|
| Attempts, responses, scores | Duration of residency + N years per PGME policy | Export (CSV) then delete by an admin with database access. Deletions are blocked in the app by design |
| Approved evaluations | Per PGME evaluation-record policy (the official copy usually lives in the program's evaluation system) | Same |
| Faculty notes | Until the end of residency | Same |
| Accounts | Deactivate at graduation; delete per policy | Admin → People; deletion via SQL |
| Media | While in use; archive afterwards; delete when authorization lapses | Storage API by an admin with dashboard access |
| Learning-case evidence **files** | Configurable: Admin → ITAR setup → "days after the block ends" (empty = keep until deleted). Set per records-retention policy | The admin screen lists files past the period; deletion removes the file and keeps the record, review history and SHA-256; each deletion is audit-logged with a reason |
| EPA reviews, ITAR drafts and approvals | Per PGME evaluation-record policy (the official ITER lives in One45; EPAs in Elentra) | Rows are not deletable in the app; export, then delete by an admin with database access |
| Audit log | ≥ 2 years | Database |

**Backups:** Supabase Pro takes daily backups (Point-in-Time Recovery is an optional add-on). Also export results CSVs each block to the program's official records system. That system, not this portal, should hold the record of truth for evaluations.

## 6. Assessment-integrity notes

- Item statistics with small cohorts are descriptive only. The dashboard says so.
- The evaluation generator summarises **only** verified exam data and faculty-entered text. It explicitly states that a written exam does not assess image acquisition or bedside skill. A faculty member must approve every evaluation.
- Accommodations are applied by the server (time and attempts), so learners do not have to disclose them to individual faculty.
