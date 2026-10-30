# POCUS Portal — Project Overview

*The one page to open first. Last updated: **Oct 30, 2026**. Updated after every meaningful change.*

> This repository is public. This page never contains answer keys, exam content, real learner data, passwords or keys.

## Where things stand

- **Phase:** working demonstration, with the real end-of-block exam being loaded as a **draft**.
- **Feature freeze** since Oct 21. There are no new resident or faculty features until the POCUS rotation director and supervising staff give feedback. Bug fixes, exam content and developer tooling still go ahead.
- **Data:** fictional residents only. Nothing is merged to `main`, and no real learners are enrolled.

## Links

| What | Link |
|---|---|
| **Demonstration portal** (always the newest feature-branch build) | https://pocus-cases-git-feature-exam-cb089f-rafalessard-8465s-projects.vercel.app/app/ |
| Faculty dashboard | …/app/faculty |
| Admin: question bank · media library · exams | …/app/admin/questions · …/app/admin/media · …/app/admin/exams |
| Deployments (Vercel) | https://vercel.com/rafalessard-8465s-projects/pocus-cases/deployments |
| Database (Supabase demo project, Canada) | https://supabase.com/dashboard/project/ngnggoekezucadlwiomp |
| Code | https://github.com/rafalessard-art/pocus-cases/tree/feature/exam-platform |
| Public teaching site (unchanged, `main`) | https://pocus-cases.vercel.app |

- **Branch:** `feature/exam-platform`.
- **Latest deployment:** the portal link above always serves it. Vercel → Deployments shows the build and its commit.

## What works today

**Residents**
- Home page with "Your next steps".
- Curriculum, with Brightspace case evidence upload.
- Rotation requirements and scan self-report.
- Exam player: timer, autosave, keeps answers while offline, review before submitting.
- Released results.

**Faculty**
- Dashboard with "Needs your attention" and a block overview (prints, exports CSV).
- Learner workspace: evidence verification, EPA verification against Elentra, and scan and requirement attestation.
- **ITER Quick Copy** for One45, plus the Full Evidence Record.
- Approval marked "Draft approved — ready for One45". Faculty still submit in One45; there is no integration.

**Admin**
- Invitations and cohorts.
- Media library with authorization and de-identification.
- Question bank and editor.
- Exam builder, publishing and assignments.
- ExamBuilder import, grading and result release.

## Exam migration (real departmental post-test)

| Item | Status |
|---|---|
| Questions | 50 of 50 loaded as a draft exam (pass mark 75%); every question has an answer key |
| Ultrasound loops | **6 of 28 done and approved** (Q1, Q2, Q7, Q8, Q12, Q13) · **22 to go**: Q3–6, Q9–11, Q14–20, 40, 43, 44, 45 (two loops), 46, 47, 48 |
| Still images | 8 uploaded (Q28, 35–40, 48), **awaiting your approval** in the media library |
| Typos kept from the source | 3 to confirm with faculty |
| Publishing | Waits for the loops, the media approvals and faculty sign-off |

How each loop is done: you export an MP4 from QPath. Claude blacks out the burned-in header (site, date, time), strips the file details and checks the frames. It then uploads the loop and attaches it to the question. **Approval for teaching use is always your call.**

## Open tasks and decisions

- **You:**
  - send the remaining QPath exports;
  - approve the 8 stills;
  - optional: set up your own email sender, so sign-in codes always arrive (Supabase → Authentication → SMTP).
- **Rotation director (12 decisions in [DIRECTOR_DECISIONS](docs/exam-platform/DIRECTOR_DECISIONS.md)):** among them, C6 EPA criteria, scan counts, the ITER template used in One45, exam attempts and feedback, and the case list.
- **Faculty:** confirm the 3 exam typos; review the draft exam before it's published.

## What's blocking an institutional pilot

1. Feedback and decisions from the rotation director and staff.
2. Approvals: a privacy impact assessment (uOttawa AIPO/PGME), an IT security review, records retention and program approval. See [DEPLOYMENT_READINESS](docs/exam-platform/DEPLOYMENT_READINESS.md).
3. Production setup:
   - a **new** Supabase project (Pro, Canada), never a copy of the demo;
   - an institutional email sender;
   - production Vercel settings;
   - then merge to `main`.
4. Exam content complete, approved and published.

## What Claude changed most recently

- **Oct 30:** Q7 and Q8 loops de-identified, uploaded and approved; Q12 and Q13 loops (gastric) de-identified, uploaded and approved.
- **Oct 28:**
  - Set up your two Chrome windows: Faculty in your main profile, Resident (Jordan) in "POCUS Resident".
  - This overview.
  - `npm run visual`, a screenshot report on a local test copy.
  - Local-only test settings.
  - Nothing that real users see.
- **Oct 27:**
  - Fixed the question editor, which wasn't showing attached clips; saving could have removed them.
  - Q1 and Q2 loops de-identified, uploaded and approved.
- **Oct 26:** loaded the 50-question post-test as a draft.

## Test it yourself

**Look at the live demonstration (no code)**

1. Two Chrome windows are already set up (Oct 28), each logged in to Vercel and to the portal:
   - **your main Chrome profile ("Rafa")** is the **faculty/admin** view;
   - the **"POCUS Resident"** profile is signed in as the fictional resident **Jordan**.

   They stay signed in, so you won't need another code unless you sign out. Claude in Chrome is installed in both, so Claude can check either view.
   - If a code doesn't arrive, it's because the demo project uses Supabase's built-in sender, which allows only about 2 emails per hour. Wait, or set up your own sender: Supabase → Authentication → SMTP, with a Gmail app password you enter yourself.
2. After a Claude session, open the portal in each profile and refresh. You're always looking at the newest build.

**Screenshot report of every main screen (on your Mac)**

1. One-time setup:
   - install Docker (Docker Desktop, or the free OrbStack or Colima);
   - install the Supabase CLI: `brew install supabase/tap/supabase`;
   - then, in this folder, run `npm ci` and `npx playwright install chromium`.
2. Start Docker, run `supabase start`, then `npm run visual`.
3. The report opens automatically: `visual-report/index.html`, grouped by screen, with pass or fail at the top. It uses a local test copy with fictional data and never touches the demo or production database. Details: [TESTING](docs/exam-platform/TESTING.md).

## Other documents

| Document | For |
|---|---|
| [docs/exam-platform/README](docs/exam-platform/README.md) | Architecture and security model |
| [DEMO_SCRIPT](docs/exam-platform/DEMO_SCRIPT.md) | Walking someone through the demo |
| [DIRECTOR_DECISIONS](docs/exam-platform/DIRECTOR_DECISIONS.md) | Decisions needed from the rotation director |
| [DEPLOYMENT_READINESS](docs/exam-platform/DEPLOYMENT_READINESS.md) · [DEPLOYMENT](docs/exam-platform/DEPLOYMENT.md) | Approvals and production setup |
| [MEDIA_GUIDE](docs/exam-platform/MEDIA_GUIDE.md) | Exporting and de-identifying loops |
| [TESTING](docs/exam-platform/TESTING.md) | All tests, and `npm run visual` |
| [VALIDATION_REPORT](docs/exam-platform/VALIDATION_REPORT.md) | Last full validation (Oct 21) |

Answer keys and exam-content notes are kept privately in the claude.ai project, not here.
