# POCUS Portal — curriculum, examinations and learner assessment

The portal lives at **`/app`** on the existing site. The public teaching cases and interactive tools are still plain static pages, open to everyone, and nothing in them depends on the portal. The only change to them is a **Portal** link in the top nav of `index.html` and `tools.html`, plus a small rule in `theme.css` that lets the nav wrap on phones.

| Document | What it covers |
|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Supabase project, auth settings, email, Vercel env vars, first admin, go-live checklist, costs |
| [MEDIA_GUIDE.md](MEDIA_GUIDE.md) | Exporting, converting, de-identifying and uploading ultrasound loops; storage choice |
| [EXAMBUILDER_MIGRATION.md](EXAMBUILDER_MIGRATION.md) | What ExamBuilder can export, and the authorized migration plan |
| [PRIVACY_AND_GOVERNANCE.md](PRIVACY_AND_GOVERNANCE.md) | Ontario requirements, data inventory, retention, audit, approvals needed before live use |
| [TESTING.md](TESTING.md) | Running the unit, database and end-to-end tests |

## 1. What existed before

- Hand-authored static HTML (4 cases, 3 interactive tools, `theme.css`/`theme.js` dark mode) deployed by Vercel from GitHub. It had no framework, no build step, no backend, no database and no authentication.
- `vercel.json` clean-URL rewrites; `@pocus/design-system` (a React component library with the site's tokens) not deployed.

## 2. Architecture

```
Browser ──► Vercel (static CDN, Canada-agnostic: serves code only)
   │          ├── /, /cases/*, /tools …  unchanged static pages
   │          └── /app/*                 portal SPA (React + TypeScript, Vite build)
   │
   └──► Supabase project in Canada (Central) — ca-central-1
          ├── Auth      invitation-only, 6-digit email code
          ├── Postgres  all data; row-level security + server-side functions
          └── Storage   private bucket "exam-media" (signed, expiring URLs)
```

**Why this design**

- **Least disruption.** The static site still deploys exactly as before. `npm run build` copies the static files into `dist/` unchanged and builds the portal into `dist/app`.
- **One backend service, in Canada.** Supabase provides the database, authentication and private file storage in one Canadian region. Identified learner data and exam media never leave `ca-central-1`; Vercel serves only code. Vercel Blob/Postgres were not chosen because Vercel has no Canadian region and private Blob delivery has to stream through serverless functions.
- **No server code to run or secure.** All privileged logic runs inside Postgres as `SECURITY DEFINER` functions that check the caller's role explicitly. That covers scoring, timing, answer-key secrecy, versioning, result release and reporting. The browser holds only the public "anon" key. No service-role key exists in the app, and there are no serverless functions.

### Security model (enforced in the database, not the UI)

| Rule | Mechanism |
|---|---|
| Only invited people get accounts | Auth hook `hook_before_user_created` rejects un-invited emails. As a second line of defence, an un-invited auth user never gets a `profiles` row and so matches no RLS policy |
| Learners never see answer keys before release | Keys live in `question_keys`, which has no learner policy. Learners read exam content only through `get_attempt()`, which omits keys and explanations |
| Scoring happens on the server | `submit_attempt()` → `_grade_attempt()` → `score_item()` (Postgres) |
| Timer is authoritative | `deadline_at` is set by the server at start. Saves after deadline + 60 s are refused and the attempt is auto-submitted |
| Autosave can't roll answers back | Every save carries a monotonically increasing `seq`; the server keeps the highest |
| History is immutable | Published exam versions, locked question versions, uploaded media versions, attempts, responses and approved evaluations are protected by triggers |
| Faculty see only their learners | `can_view_learner()`: a faculty member sees learners in cohorts where they are an *evaluator*; admins see everyone |
| Exam media is private | Storage policy `can_read_exam_media()`: staff, or a learner whose *open* attempt (or released full-review attempt) contains the clip. URLs are signed and expire |
| Audit trail | `audit_log` (append-only) records role/invitation/cohort/assignment/accommodation/media changes, attempts started/submitted, grading, release, evaluation approval/re-opening |

### Data model (generic, not POCUS-specific)

`courses` → `domains`, `learning_objectives`, `curriculum_items`, `cohorts` (rotation blocks) → `cohort_members`.
`media_assets` → `media_versions`. `questions` → `question_versions` (+ `question_keys`, `question_version_media`).
`exams` → `exam_versions` → `exam_items`. `assignments` (version × cohort or learner) → `attempts` → `responses`.
`accommodations`, `faculty_notes`, `evaluations`, `audit_log`, `invitations`, `profiles`.

POCUS is simply the first row in `courses` (migration `…600_pocus_course.sql`). Adding a regional-anesthesia or OB rotation is data, not code.

## 3. What is built (Phase 1 + 2, with parts of 3 and 4)

**Learner:** sign in with an email code, curriculum page (existing cases/tools linked, never duplicated, with self-tracked completion), assigned exams. The exam player has question navigation, single-best and multiple-select questions, short answer, flags, a progress bar, a server-synced timer, a review screen, confirmation and submit. Autosave keeps a local mirror that survives crashes and offline periods and syncs on reconnect. Results appear according to the faculty-chosen feedback policy.

**Ultrasound player:** native `<video>`, always looping, play/pause, frame-step, scrubbing, 1×/0.5×/0.25×, fullscreen (iOS included), original aspect ratio (never stretched), several clips per question, prefetch of the next question's clips, keyboard control.

**Admin:**
- Media library: bulk drag-and-drop upload directly to private storage (resumable above 6 MB), duplicate detection by SHA-256, preview, metadata, an authorization and de-identification attestation, versioned replacement, archive and "used in".
- Question bank: versioned editor with a readiness check.
- Exam builder: settings for time, attempts, pass mark, resume, shuffling, feedback policy and release mode, then validation, publish, assign to a cohort or learner with open/due dates, and retire.
- CSV/JSON import with a validation screen.
- People: invitations, roles, cohorts and accommodations (time × factor, extra minutes, extra attempts).

**Faculty:**
- Dashboard with a "needs attention" queue.
- Exam results: completion, mean, median and SD, a histogram, domain bars, item analysis (% correct and discrimination with small-n caveats), release controls, CSV export and print.
- Attempt review with manual grading.
- Learner profile with domain and objective breakdown and faculty notes.
- **Evaluation workspace.** It drafts deterministically from verified exam data plus faculty-typed observations. It never infers clinical, scanning or professional performance from scores, states that limit in the text, and requires explicit approval. Approved evaluations are locked and can be re-opened (audited). Print/PDF and CSV are available.

**ITAR preparation workspace (Phase 2).** Faculty → rotation block → resident. One page brings together, for that resident and block:
- **A. Exam performance**, pulled automatically: score, date, pass/fail and domains. The **most recent submitted attempt** is used by default. Faculty can pick another, and the draft states which attempt was used and why.
- **B. Learning-case evidence (Brightspace).** Residents upload a screenshot or PDF per required case (Learner → *My evidence*) to the private `itar-evidence` bucket. Faculty preview it and mark it *verified*, *needs clarification* or *rejected*, with a message the resident sees. Re-uploads keep the full history. Requirements are configured in Admin → *ITAR setup*, any number per rotation or per block. They are seeded as drafts from the 4 required teaching cases and need confirming against the Brightspace course. A future official Brightspace import has a reserved `source` value and `external_ref` column, but is not built.
- **C. EPA review (Elentra).** A faculty-entered form with EPA IDs, number of assessments, entrustment as recorded, strengths, areas for improvement, review date, and status *pending* / *complete*. Complete reviews are locked until re-opened.
- **D. Direct faculty observations** by category (scanning, clinical judgement, technical, professionalism, communication, general), date and context. They are shown apart from exam scores and never derived from them.
- **E. ITAR draft.** Built from a template into editable sections: rotation, exam, cases, EPA, observations, strengths, areas for improvement and outstanding requirements, and evidence sources and verification status.
  - Faculty-judgement sections start as `[Faculty to complete…]` placeholders, and approval is blocked until they are replaced.
  - It assigns no overall rating and makes no inference from exam scores.
  - Save, approve (locks; audited) and re-open (audited).
  - Copy one section or the whole draft; download .txt; print/PDF; CSV. Exports are audit-logged.
  - The draft is flagged as stale when the evidence changes after it was generated.

**Rotation requirements and completion tracking (Phase 3).** Seven mandatory activities are configured per rotation (Admin → ITAR setup), and a block can override any of them:
1. C6 POCUS EPAs
2. Brightspace learning cases
3. TeachingMedicine modules
4. Logbook of reviewed scans (102 across 6 categories)
5. QPath mentor review and portfolio
6. Written exam (rotation pass mark 75%)
7. POCUS rounds

The exam, Brightspace and EPA statuses are **calculated** from the records above, not re-entered. The scan logbook holds **faculty-attested counts per category only**:
- Faculty review the images in QPath, then record verified totals for every category in one form. "Fill in resident-reported counts" makes this one click.
- They also confirm the required views and add an optional non-identifying note.
- Corrections need a reason, and the history is append-only.

Resident-reported counts are shown separately and never count. TeachingMedicine, the QPath portfolio and rounds use submit → faculty confirm. Rounds has stages (planned → reviewed by faculty → presented). Faculty can mark any requirement "not yet due" or "not applicable".

The resident sees a dashboard with progress bars. Faculty see a requirements table at the top of the ITAR workspace, with who verified each item and when. The block overview shows requirements and scans columns. The ITAR draft gains a "Rotation requirements — completion record" section. It states that scan numbers are a completion measure and not a competence assessment, and it assigns no rating. See [QPATH_AND_SCAN_LOG.md](QPATH_AND_SCAN_LOG.md).

**Before the departmental demonstration:** see [VALIDATION_REPORT.md](VALIDATION_REPORT.md), [DEMO_SCRIPT.md](DEMO_SCRIPT.md), [DIRECTOR_DECISIONS.md](DIRECTOR_DECISIONS.md) and [DEPLOYMENT_READINESS.md](DEPLOYMENT_READINESS.md).

**Block overview (cohort dashboard).** Faculty → block card. It shows one row per resident: exam, evidence verified/awaiting/returned/missing, EPA, observations, ITAR status, and "needs attention", split into *you* vs *resident*. It has an "only needing attention" filter, CSV export, one click into each resident, and Previous/Next between residents.

**Access.** Faculty see a resident's ITAR data only if they are an **evaluator of that resident's block**; admins see all. Learners never see EPA reviews, observations or drafts; they see only their own uploads and the reviewer's message.

**Production-ready vs prototype**

| Ready for a supervised pilot (after approvals) | Prototype / not yet built |
|---|---|
| Auth, RBAC/RLS, exam delivery, autosave, server scoring, versioning, media upload and playback, results, grading, release, evaluations, audit log | Image-hotspot questions (database scoring is implemented; player UI is not) · AI-assisted drafting (interface point only) · SSO · conversion inside the browser (uses the `tools/convert-clips.sh` script instead) · scheduled auto-close of abandoned timed attempts (closed lazily on next access; optional `pg_cron` job in DEPLOYMENT.md) · longitudinal trends across years |

## 4. Tests

- **Unit (27):** autosave queue (offline, crash-restore, ordering), CSV, importer, evaluation drafting guardrails, ITAR draft (attempt rule, verified-only evidence, no rating/inference, placeholders, sources, staleness), overview attention rules.
- **Database (44):** the ITAR suite (13) covers evidence privacy and upload rules, block-scoped faculty access, review messages and audit, EPA locking, learner exclusion, one ITAR per resident per block, approval lock, and retention. The original suite (31): permissions and secrecy for every role, invitation gating, versioning and immutability, autosave seq rule, timing and deadline, attempts and accommodations, partial-credit, short-answer and hotspot scoring, release policy, storage policy, evaluations.
- **End-to-end (2 tests; the main scenario now includes the 8-step ITAR workflow):** the full demonstration lifecycle in a real browser against a Supabase-equivalent stack. It includes an interruption with a reload, offline autosave, video playback checks, a phone-width layout check and automated WCAG 2.1 AA checks (axe) on the main screens.

See [TESTING.md](TESTING.md).

## 5. Blockers that need you

| # | Blocker | Why it needs you |
|---|---|---|
| B1 | **Create the Supabase project** in Canada (Central) and add the two Vercel env vars ([DEPLOYMENT.md](DEPLOYMENT.md) §1–5) | Your account, billing and credentials |
| B2 | **SMTP sender** for sign-in codes (institutional relay or provider) | Supabase's default sender only reaches your own team |
| B3 | **Privacy impact assessment and approvals** (uOttawa AIPO, IT security, PGME; TOH Privacy for clinical clips) | Institutional permission before live learner data |
| B4 | **Confirm which ExamBuilder** and request the vendor export (question content + original clips + mapping) | Account owner or Super User access |
| B5 | **Rights to reuse** the current exam questions and clips; authorization status per clip | Content owners |
| B6 | **Replace the draft learning objectives** with the program's approved POCUS objectives | Program decision |
| B7 | Decide **feedback and release policy** and the **pass threshold** for the end-of-block exam | Assessment policy |
| B8 | Optional: **uOttawa SSO** (Entra ID app registration) | University IT |
| B9 | Confirm **H.264 MP4 playback** on the preview in Safari/Chrome/Firefox and on an iPad | Needs a real browser with H.264 (not available in the test container) |
