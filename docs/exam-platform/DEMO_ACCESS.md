# Demonstration (reviewer) access

Read-only access for program reviewers (for example, departmental administrators) to a demonstration of the portal with **fictional residents and synthetic documents**. Status: **built and tested locally (WP3); not deployed.** It goes live only in the separate review environment (WP4), after the owner approves the release.

This page describes the design. It contains no access codes, keys or links.

## How a reviewer gets in

1. The owner issues a shared code on **Admin → Demonstration access** (an authenticator-confirmed session is required). The code is shown once; only a bcrypt hash is stored. The owner shares it personally.
2. The reviewer opens the portal sign-in page and fills in the **Demonstration reviewers** card: their name (self-reported) and the code. No email address is needed.
3. The `demo-redeem` Edge Function checks the code on the server (rate-limited), creates an **independent identity for that person** and returns a one-time token that the browser exchanges for a normal session. The session persists like any other sign-in.
4. Access ends when the grant expires (≤ the code's expiry), when the owner ends that person's session, revokes the code or issues a new one. The reviewer then sees "Your demonstration access has ended" and nothing else.

Demonstration sign-in is compiled only into builds with `VITE_DEMO_ACCESS=true`, is never included in a production build (`scripts/build-site.mjs`), and is refused by any database whose `deployment_settings.environment` is `production`.

## What a reviewer can do

| | Reviewer |
|---|---|
| Read | Fictional people and blocks (`is_fixture`), the demonstration exam and its media (`reviewer_visible`), course content and configuration (requirements, scan categories, ITER template, retention setting) |
| Write | **Only feedback** (`submit_feedback`) |
| Never | Real people or blocks, any exam or media not marked reviewer-visible (the departmental post-test, its answer keys and media with unresolved provenance), invitations, the audit log, access codes, other reviewers' grants or feedback |

Everything is enforced in the database (row-level security and the read functions); the interface only mirrors it.

### Perspectives

The perspective bar offers **Resident** (choose a fictional resident), **Faculty** and **Admin**. A perspective changes what is shown, never what is permitted:

- **Resident** passes the chosen fictional resident to the learner read functions (`p_as_learner`). The database accepts it only from a reviewer or the owner, and only for a fictional resident. No one is signed in as the resident; every learner action (starting an exam, uploading evidence, reporting scans) is still refused.
- **Faculty** and **Admin** reuse the normal screens. Reviewers see fictional blocks and the demonstration exam only; write controls are disabled with an explanation.
- Viewing never changes data: for reviewers and previews, the read functions skip the clean-up that would otherwise close overdue exam attempts.

### Examination walkthrough

The walkthrough steps through the demonstration exam (synthetic questions using simulator loops) and then shows the result and full-review feedback. Answers stay in the browser page: no attempt is created and no result changes. It works only for exams marked reviewer-visible.

### Feedback

The **Feedback** button records: the reviewer's name and optional role (self-reported), the date, the perspective, the page and section, the portal version, a category and comments. Comments are checked for patient identifiers (6+ digit numbers, dates, MRN/DOB references). Only the owner can read feedback (Admin → Demonstration access → Feedback inbox); reviewers cannot read any feedback, including their own. Feedback and grant records are kept when reviewer identities are cleaned up.

## For the owner

- **Your perspectives.** On a demonstration database you also get the perspective bar. Viewing a fictional resident is read-only.
- **Preview as reviewer** shows exactly what a reviewer sees: your requests carry a preview header that the database honours only to *lower* an administrator to the reviewer role (never to raise anyone, and never outside demonstration databases). Exit the preview to get your full rights back.
- **What reviewers can see is set in SQL only.** The `is_fixture` and `reviewer_visible` flags cannot be changed from the portal, so a click cannot expose real content. Further guards: fictional people must have `@fixture.invalid` addresses; real and fictional people never share a block; reviewer-visible media must be de-identified and authorized; a question can't be shared between the demonstration exam and any other exam.

## Fictional data

`scripts/demo-fixtures.mjs` (also `npm run fixtures:demo`) creates the demonstration data in a **local** database through the portal's own workflow functions, executed as the fictional people:

- 6 residents and 3 faculty, all marked "(fictional)";
- 3 blocks: completed, current and upcoming;
- the demonstration exam (6 questions, 2 simulator loops), with released, below-threshold and awaiting-grading attempts;
- scan self-reports and attestations at different levels; synthetic completion PDFs as learning-case evidence, verified, awaiting review or needing clarification; TeachingMedicine, QPath and rounds requirements in different states;
- EPA reviews, observations, one approved and one draft ITER.

It is idempotent and refuses non-local databases. With `STORAGE_URL` and `SERVICE_ROLE_KEY` of the local stack it also uploads the synthetic files.

## Tests

- `tests/db/reviewer-views.test.ts` loads the fixtures, adds hidden data (a real block, resident and faculty member, and a hidden exam with a marker string in its stem, key, explanation and media — also assigned to a fictional block and sat by a fictional resident), and sweeps every table, every callable function (with fictional and hidden ids) and storage for any hidden id or the marker. It also checks writes with fictional rows visible, the perspectives, the walkthrough, the boundary guards, the preview header, feedback and ended access.
- `tests/db/demo-access.test.ts` (WP2) covers codes, redemption, rate limits, expiry, revocation, cleanup and owner MFA.
- `tests/e2e/reviewer.spec.ts` runs the journey in real browsers: the owner issues a code, views a fictional resident and previews; a reviewer in a fresh browser session is refused with a wrong code, signs in, uses each perspective and the walkthrough, sends write requests straight to the API from the page (all refused), and sends feedback; the owner reads it and ends the session.

Run everything on a Mac with `npm run validate:wp3` (see [TESTING](TESTING.md)).
