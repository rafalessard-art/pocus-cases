# Working on this repository

## Ground rules
- Work on `feature/exam-platform`. Never merge to `main`, deploy a production environment or enroll real learners.
- The repo is **public**. Never commit exam content or answer keys, real learner data, passwords, demonstration access codes, service-role or secret keys, Vercel share links, or unpublished security findings.
- Automated tests run against a local stack only (`tests/local-only.ts`, `scripts/visual-report.mjs`).
- Approving media for teaching use is Rafa's decision.
- Elentra remains the EPA system of record and One45 the ITER submission platform unless the institution approves otherwise.

## Development policy (replaces the Oct 21, 2026 feature freeze; approved Nov 25, 2026)
Principle: **freeze unapproved institutional deployment, not general product development.**
Work proceeds under Rafa's direction. A Green zone is not permission to start unrelated features on your own.
If it is unclear which zone applies, treat the work as the stricter zone and ask Rafa.

### Green — proceed when Rafa asks
- Usability, navigation, dashboards, accessibility, performance and bug fixes.
- Demonstration access, perspective switching and stakeholder feedback (per the approved design).
- Tests, CI, developer tooling and documentation.
- Remediation of items in the private readiness register.
- Generalising rotation components behind configuration; architecture that supports future scaling.

**Explicit approval first:** anything that touches sign-in, sessions, roles, RLS policies, grants, SECURITY DEFINER functions, storage policies, Supabase Auth settings, deployment protection or Vercel access needs Rafa's approval *before* implementation, with the risks explained.

### Amber — build as configurable drafts; policy stays pending
New or changed educational and assessment workflows; faculty verification; rotation requirements; EPA criteria; scan counts; exam attempts, pass marks and feedback policy; ITER content and templates; administrative reporting; notifications and reminders; faculty and administrative responsibilities; other rotations.
- Implement as settings. Mark placeholder values **Draft**; never present a value as program policy.
- Add each open question to `docs/exam-platform/DIRECTOR_DECISIONS.md`.
- Do not publish the real end-of-block exam, or release results from it, without faculty sign-off.

### Red — blocked until institutional approval and Rafa's go-ahead
- Enrolling real residents or faculty; collecting real learner assessments or evidence.
- Any identifiable patient information.
- Production deployment, merging to `main`, or setting up production Supabase or Vercel.
- Integrations with institutional systems (Elentra, One45, Brightspace, QPath, SSO) beyond design documents.
- Weakening any existing security control.
- Describing the portal as an approved institutional system.

## Demonstration environment
- Fictional data only. Reviewer (demonstration-code) access is read-only and enforced in the database; perspectives change the view, never permissions.
- Never create, display, log, commit or send demonstration codes. Rafa generates and distributes them.
- The stable reviewer build changes only through a release Rafa approves; keep it working while development continues.
- Reviewers see only exams and media marked reviewer-visible.

## Local development lifecycle (Mac)
- Develop and test only in `~/pocus-portal`; never modify `~/pocus-cases`, its ignored files or its unpushed branches.
- Node.js 22 (Homebrew `node@22`); the scripts put it on the PATH themselves.
- `npm run local:up` starts OrbStack and the local Supabase stack if they are not running, and leaves anything already running alone. `npm run local:status` shows what runs (no keys). `npm run local:down` stops only this project's Supabase containers; data volumes are kept. `npm run local:down -- --runtime` also quits OrbStack, but only if nothing else runs in it.
- Full validation: `npm run validate:<wp>` (currently `validate:wp3`) does the above itself, saves a copy of the local database (`npm run local:backup` → `.local-backups/`, git-ignored) before the suites reset it, and ends with the demonstration fixtures loaded. It leaves the stack running.
- Claude cannot start services on the Mac (its shell there can't reach the Mac's own processes or localhost, and Terminal is click-only). Ask Rafa for one consolidated command; read results from the validation folder.
- Never `supabase db reset` against anything but the local stack, never delete Docker volumes, never stop containers that are not this project's, never `npm audit fix --force`.

## After every development task
1. Update `PROJECT_OVERVIEW.md`: status, exam progress, and "What Claude changed most recently".
2. Report to Rafa in this format, kept short:
   - **What changed:** plain language.
   - **Where to look:** the exact page or preview link.
   - **Visual evidence:** a screenshot or report, when relevant.
   - **Tests:** passed or failed.
   - **Needs my attention:** only decisions or actions needed from Rafa.
   - **Project status:** PROJECT_OVERVIEW.md updated.
