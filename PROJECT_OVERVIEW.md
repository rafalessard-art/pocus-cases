# POCUS Portal — Project Overview

*The one page to open first. Last updated: **Nov 26, 2026**. Updated after every meaningful change.*

> This repository is public. This page never contains answer keys, exam content, real learner data, passwords or keys.

## Where things stand

- **Phase:** **collaborative development** with departmental stakeholders (since Nov 25). The working demonstration continues, with the real end-of-block exam loaded as a **draft**.
- **Nov 24 meeting with DAPM program administration:** administration is interested in developing the portal as a potential formal departmental resource. It has asked uOttawa about institutional requirements (security, privacy, encryption); the answer is pending. Two administrators asked for their own access to explore the portal and give feedback. This is support for further evaluation, **not** approval for use with real residents.
- **Development policy:** the Oct 21 feature freeze is replaced by a controlled policy (Green / Amber / Red, in [CLAUDE.md](CLAUDE.md)). The principle: freeze unapproved institutional deployment, not general product development. Educational policy changes stay drafts until faculty or the program confirm them.
- **Next:** read-only reviewer access for the two administrators: a shared demonstration code, Resident / Faculty / Admin perspectives, in-app feedback, and fictional data only.
  - **WP2 complete and validated locally, not yet live:** sign-in with a password plus an authenticator app for your own account, and the database foundation for read-only reviewer access (branch `wp/2-owner-auth-demo-access`).
  - **WP3 built locally, Mac validation pending** (branch `wp/3-reviewer-experience`, not deployed): reviewer sign-in with a name and the shared code; Resident / Faculty / Admin perspectives over fictional data; read-only screens with disabled write controls; a demonstration exam walkthrough that records nothing; in-app feedback with an owner inbox; your own "Demonstration access" page and "Preview as reviewer". Dependencies updated (0 known vulnerabilities). See [DEMO_ACCESS](docs/exam-platform/DEMO_ACCESS.md).
  - **Then:** WP4 (a separate review environment in Canada, on free plans, then acceptance testing), only after you approve the WP3 report; WP5 (access for the administrators, after your approval).
- **Infrastructure:** free plans only for now (Supabase Free, Vercel Hobby). The existing US project stays the development demo; a second, Canadian project is planned for stakeholder review.
- **Data:** fictional residents only. Nothing is merged to `main`, and no real learners are enrolled.

## Links

| What | Link |
|---|---|
| **Demonstration portal** (always the newest feature-branch build) | https://pocus-cases-git-feature-exam-cb089f-rafalessard-8465s-projects.vercel.app/app/ |
| Faculty dashboard | …/app/faculty |
| Admin: question bank · media library · exams | …/app/admin/questions · …/app/admin/media · …/app/admin/exams |
| Deployments (Vercel) | https://vercel.com/rafalessard-8465s-projects/pocus-cases/deployments |
| Database (Supabase demo project, **United States, us-east-1**; fictional data only) | https://supabase.com/dashboard/project/ngnggoekezucadlwiomp |
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
| Ultrasound loops | **24 of 28 done and approved** (Q1–8, Q10, Q12, Q13, Q15, Q16, Q18–20, Q40, Q43, Q44, Q45 ×2, Q46–48; Q5 reuses the Q3 loop; Q19 is the Q18 clip with an added arrow; Q16 and Q20 also have added arrows; Q40 also keeps its original still) · **Q9, Q11 and Q14 use approved still images instead** · **1 to go**: Q17 |
| Still images | 8 from the original exam (Q28, 35–40, 48), all checked for identifiers (Q36 and Q38 had a burned-in date/time, now removed) and **all 8 approved** |
| Typos kept from the source | 3 to confirm with faculty |
| Publishing | Waits for the loops, the media approvals and faculty sign-off |

How each loop is done: you export an MP4 from QPath. Claude blacks out the burned-in header (site, date, time), strips the file details and checks the frames. It then uploads the loop and attaches it to the question. **Approval for teaching use is always your call.**

## Open tasks and decisions

- **You:**
  - decisions on reviewer access (authentication design, infrastructure and paid plans), listed in Claude's Nov 25 report;
  - the last QPath export (Q17) is on hold until the privacy review of the media workflow is settled;
  - optional: set up your own email sender, so sign-in codes always arrive (Supabase → Authentication → SMTP).
- **Rotation director (12 decisions in [DIRECTOR_DECISIONS](docs/exam-platform/DIRECTOR_DECISIONS.md)):** among them, C6 EPA criteria, scan counts, the ITER template used in One45, exam attempts and feedback, and the case list.
- **Faculty:** confirm the 3 exam typos; review the draft exam before it's published.

## What's blocking an institutional pilot

1. Feedback and decisions from the rotation director and staff.
2. Approvals: a privacy impact assessment (uOttawa AIPO/PGME), an IT security review, records retention and program approval. See [DEPLOYMENT_READINESS](docs/exam-platform/DEPLOYMENT_READINESS.md).
3. Production setup:
   - a **new** Supabase project (Pro, **Canada (Central)**), never a copy of the demo. The current demo project is in the US (us-east-1); a project's region can't be changed after creation;
   - an institutional email sender;
   - production Vercel settings;
   - then merge to `main`.
4. Exam content complete, approved and published.

## What Claude changed most recently

- **Nov 26 — WP3, local only, on branch `wp/3-reviewer-experience` (not deployed):**
  - **dependencies**, one commit each: vite 6.4.6, vitest 4.1.12, react-router-dom 7.18.7 (compatibility checked: the portal uses only basic routing). `npm audit`: 0 vulnerabilities, production and development;
  - **reviewer sign-in**: name + shared code on the sign-in page, no email; the session persists; clear messages for a wrong code and for access that has ended;
  - **perspectives**: Resident (pick a fictional resident) / Faculty / Admin, with a "read-only · fictional residents" badge and a Feedback button. Perspectives never change permissions;
  - **read-only screens**: the existing pages, with 65 write buttons disabled and explained; uploads hidden; the database refuses any write regardless;
  - **demonstration exam walkthrough**: six synthetic questions with simulator loops, then the feedback view. No attempt is recorded;
  - **feedback**: name and role (self-reported), date, perspective, page, section, version, category and comments; only you can read it;
  - **for you**: Admin → Demonstration access (issue, rotate and revoke the code; see and end reviewer sessions; feedback inbox), the same perspectives, and "Preview as reviewer";
  - **fictional data**: 6 residents, 3 faculty, 3 blocks (past, current, upcoming) with exam results, scans, evidence, requirements, EPA reviews, observations and ITERs (`npm run fixtures:demo`);
  - **guards**: what reviewers can see is set only in SQL; the departmental post-test, its keys and media with unresolved provenance stay hidden; real and fictional people never share a block; questions can't be shared between the demonstration exam and other exams;
  - **tests in the development workspace**: typecheck, 70 unit and 137 database tests pass (23 new reviewer tests that sweep every table, every function and storage for hidden content; a check that the earlier WP2 sweep was testing an already-revoked reviewer, now fixed). The new database changes roll back cleanly (WP2 suite 114/114 after rollback);
  - **still to run on the Mac**: `npm run validate:wp3` (live sign-in, the reviewer journey in a fresh browser, and screenshots of each perspective).
- **Nov 25 (evening) — WP2, local only, on branch `wp/2-owner-auth-demo-access`:**
  - your account can sign in with a password plus an authenticator app (Account → Security), with a backup authenticator. "Require an authenticator for administrators" stays off until you've tested recovery;
  - the database foundation for read-only demonstration access and the server-side code check;
  - related hardening: users can no longer rename themselves, faculty review notes are staff-only, video links last 20 minutes instead of 3 hours;
  - a rollback script for the new database changes, and a way to run the database tests without Docker;
  - **validated on the Mac's local Supabase stack** (`npm run validate:wp2`): typecheck, 64 unit, 114 database, 6 live sign-in tests (real Auth server and Edge Function), and 3 browser tests (exam lifecycle, sign-in emails, owner sign-in security). The visual report captured 34 of 34 screens;
  - **fixed during validation:**
    - switching the administrator MFA requirement failed through the API (the update had no WHERE clause, which Supabase rejects);
    - `npm run visual` could never load a page (its server was blocked while the browser ran);
    - the older emailed-link test was out of date with the code-only email;
    - the password hint is no longer part of the field's name for screen readers;
    - the authenticator step now shows no portal navigation;
    - the authenticator step only returns to pages inside the portal;
  - Node 22 pinned (`.nvmrc`); the Playwright browser install stalls on Node 26;
  - branches starting with `wp/` are not deployed by Vercel, so the demo portal is unchanged.
- **Nov 25:** Documentation only:
  - the new controlled development policy in `CLAUDE.md`, replacing the feature freeze;
  - this page, with the Nov 24 meeting and the collaborative phase;
  - the database region corrected to the United States (us-east-1) everywhere it said Canada. The demo holds only fictional data. Production is still planned for Canada.

  No code, database, sign-in or deployment settings were changed.
- **Nov 3:** Q44: the first QPath exports held a different clip from the one you were viewing; the wrong loop was taken off the question. From a full-study export, the clip matching your screenshot (subcostal, 20 cm) was de-identified, attached as version 2 and approved.
- **Nov 2:** All 8 original stills approved (Q35's chest photo kept as is). Checked the 6 remaining stills for identifiers: removed a burned-in date/time from Q36 and Q38 (version 2); Q28, 37 and 39 clean; Q35 (a chest photo) flagged. Q47 and Q48 approved. Q48 loop (right anterior chest) de-identified and added before the original still; a cut-off header line was removed from the still (version 2); both approved. Q47 loop (large pleural effusion) de-identified, uploaded and approved. Q46 loop (curtain sign) and Q45's two loops (PLAX and A4C) de-identified, uploaded and approved. Q43 loop (colour Doppler, mitral regurgitation) de-identified, uploaded and approved. Q40 loop (PSAX at the aortic valve) de-identified and added before the original still; still confirmed de-identified; both approved. Q20 loop (subcostal) de-identified with a red arrow added, approved. Q19 reuses the Q18 clip with a yellow arrow added, approved. Q18 loop (PLAX) de-identified, uploaded and approved. Q16 loop (A4C) de-identified with a yellow arrow added, then the arrow moved slightly lateral at your request (version 2), approved. Q15 loop (subcostal) de-identified, uploaded and approved. Q11's question wording corrected. Q14 now uses a de-identified still from the existing exam image (source logo and player controls removed), approved. Q9's question now says "image" instead of "video clip". Q11 now uses two de-identified stills side by side (headers removed), approved. Q10 loop (lung) de-identified, uploaded and approved. Q9 now uses a de-identified still from the existing exam image (date/time and player controls removed), approved. Q3 loop (PLAX, pleural effusion) uploaded and approved. Q4 loop (A4C, LV dysfunction) uploaded, then replaced with the correct clip (version 2) and approved. Q5 now reuses the approved Q3 loop. Q6 loop (subcostal, pericardial effusion) uploaded and approved.
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
| [TESTING](docs/exam-platform/TESTING.md) | All tests, `npm run visual` and `npm run validate:wp3` |
| [DEMO_ACCESS](docs/exam-platform/DEMO_ACCESS.md) | Read-only reviewer access: design, fictional data and tests |
| [VALIDATION_REPORT](docs/exam-platform/VALIDATION_REPORT.md) | Last full validation (Oct 21) |

Answer keys and exam-content notes are kept privately in the claude.ai project, not here.
