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

**Production-ready vs prototype**

| Ready for a supervised pilot (after approvals) | Prototype / not yet built |
|---|---|
| Auth, RBAC/RLS, exam delivery, autosave, server scoring, versioning, media upload and playback, results, grading, release, evaluations, audit log | Image-hotspot questions (database scoring is implemented; player UI is not) · AI-assisted drafting (interface point only) · SSO · conversion inside the browser (uses the `tools/convert-clips.sh` script instead) · scheduled auto-close of abandoned timed attempts (closed lazily on next access; optional `pg_cron` job in DEPLOYMENT.md) · longitudinal trends across years |

## 4. Tests

- **Unit (17):** autosave queue (offline, crash-restore, ordering), CSV, importer, evaluation drafting guardrails.
- **Database (29):** permissions and secrecy for every role, invitation gating, versioning and immutability, autosave seq rule, timing and deadline, attempts and accommodations, partial-credit, short-answer and hotspot scoring, release policy, storage policy, evaluations.
- **End-to-end (1 scenario, 15 steps):** the full demonstration lifecycle in a real browser against a Supabase-equivalent stack. It includes an interruption with a reload, offline autosave, video playback checks, a phone-width layout check and automated WCAG 2.1 AA checks (axe) on the main screens.

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
