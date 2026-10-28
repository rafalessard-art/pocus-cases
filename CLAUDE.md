# Working on this repository

## Ground rules
- Work on `feature/exam-platform`. Never merge to `main`, deploy to production or enroll real learners.
- There is a feature freeze from Oct 21, 2026, until the POCUS rotation director gives feedback. Only bug fixes, exam content and developer tooling are allowed.
- The repo is **public**. Never commit exam content or answer keys, real learner data, passwords, service-role or secret keys, or Vercel share links.
- Don't weaken authentication, RLS or deployment protection. Ask Rafa before changing anything about sign-in, permissions or preview access.
- Automated tests run against a local stack only (`tests/local-only.ts`, `scripts/visual-report.mjs`).
- Approving media for teaching use is Rafa's decision.

## After every development task
1. Update `PROJECT_OVERVIEW.md`: status, exam progress, and "What Claude changed most recently".
2. Report to Rafa in this format, kept short:
   - **What changed:** plain language.
   - **Where to look:** the exact page or preview link.
   - **Visual evidence:** a screenshot or report, when relevant.
   - **Tests:** passed or failed.
   - **Needs my attention:** only decisions or actions needed from Rafa.
   - **Project status:** PROJECT_OVERVIEW.md updated.
