# Validation report (pre-demonstration, Oct 20, 2026)

Scope: the POCUS exam, the ITAR preparation workspace and the rotation requirements tracker, on the `feature/exam-platform` preview. All data is fictional.

Tests: **37 unit, 67 database and 2 end-to-end browser tests**, all passing. The browser scenario covers 30+ steps across resident and faculty roles, with WCAG 2.1 AA checks.

## 1. Assessment accuracy

| Check | Result |
|---|---|
| Rotation pass mark = 75% | ✅ Configured (Admin → ITAR setup) and used consistently by the requirement, the workspace, the overview badge and the ITAR text. **Fixed:** the ITAR text, workspace and overview previously used the exam's own threshold (60% on the demo exam). The exam builder now warns when an exam's threshold differs from 75%. Residents' result pages show the exam's own threshold, so the real exam should be published at 75%. |
| Attempts and faculty selection | ✅ The default is the most recent submitted attempt. A faculty selection is saved with the ITAR and used everywhere (requirement, draft, overview: "ITAR uses attempt n"). **Fixed:** the requirement always used the latest attempt, and a saved "latest" attempt was mislabelled as a faculty selection. |
| 102 scans across 6 categories | ✅ Airway 5, Cardiac 40, Lung/pleura 15, Abdominal/FAST 20, Gastric 20, DVT 2 (tested). **Fixed:** extra scans in one category no longer offset another (e.g. 22 gastric no longer showed "104/102"). Totals now count each category up to its target, and the raw number is shown separately. |
| Required views configurable | ✅ A free-text rule per category in Admin → ITAR setup. Faculty tick "views covered" per category. Pending program approval. |
| Scan counts ≠ competence | ✅ The faculty attestation statement, the scan-log text, the requirements panel and the ITAR section all state that counts are a completion measure, not a competence assessment. No rating is ever generated. |
| ITAR approval vs requirement completion | ✅ Separate columns and checklist items. **Fixed:** "Needs attention" said "Complete" when the ITAR was approved; it now says "No action needed", and an approved ITAR never hides outstanding requirements. |

## 2. Changes after an ITAR is approved

Before: re-opening and re-approving overwrote the approved text (only a hash was kept), and nothing flagged later evidence.

Now:
- Every approval stores an **immutable numbered version**: text, sections, evidence snapshot, approver and time. Versions can't be edited or deleted through the app.
- New exam attempts or grades, evidence uploads or reviews, EPA changes, scan attestations, requirement changes and observations after the approval time are **listed on the approved ITAR** and flagged in the block overview ("new evidence since approval").
- Nothing changes automatically. **"Start a revision…"** re-opens, regenerates and re-approves, creating a new version alongside the original. All of this is audit-logged.

Verified live on the preview: fictional Alex Demo-Resident has version 1, then new scans and rounds after approval were flagged, then a revision produced version 2.

## 3. Faculty efficiency (click audit)

| Task | Clicks |
|---|---|
| See who needs attention | 2 (Faculty Dashboard → block) |
| Open a resident / next resident | 1 |
| Exam result | 0 (automatic) |
| Verify a Brightspace upload | 2 (Preview → Verify). **Improved** from 3. |
| Return an upload for clarification | 2 + a short message |
| All six scan categories | 3–7 (fill in reported counts · tick views where required · attestation statement · Record) |
| TeachingMedicine / QPath portfolio | 1 each |
| Rounds | 1 (not yet due) or 2 (stage + confirm) |
| EPA review | Transcription + 1 |
| ITAR | Write strengths and areas · Generate · Approve + confirm · Copy or Download |

A typical resident takes about 15–20 clicks plus the judgement text faculty must write anyway.

Remaining manual entry is by design: EPA details (until an approved Elentra integration) and pasting into the official ITAR system.

**Not added** (would add burden or weaken attestation):
- automatic views confirmation;
- verifying evidence without opening it;
- per-scan entry.

## 4. Uploads and document security

**Real browser uploads:**
- The automated Chromium test uploads real PDF and PNG files through the file control, previews them, and refuses a .txt file.
- On the hosted preview, uploads go through the same control and private storage.
- **One manual check remains for you:** pick a file with the system file picker in Safari or Chrome. This environment can't operate the OS file dialog.

**Access controls:**
- Files are in the private `itar-evidence` bucket (PDF/PNG/JPEG/WebP, ≤ 10 MB).
- Read access is limited to the uploading resident and to evaluators of that resident's block (checked in Storage policies).
- Files are opened through 10-minute signed links. Anyone holding a link can open it until it expires, so links shouldn't be forwarded.
- Uploads are written only by the resident, to a server-assigned path, and only while the upload record is pending. Files can't be replaced in place.
- Deletion is admin-only, needs a reason, and keeps the record and the SHA-256 hash.

**De-identification:** the scan-note screen (6+ digit numbers, dates, MRN/DOB/health-card wording) is a safeguard against obvious mistakes, **not proof of de-identification**. The protection is the design itself: counts only, no patient-level fields, images stay in QPath, plus training and policy.

**Demonstration data:** two fictional residents (Alex and Jordan Demo-Resident) in "POCUS Block 4 — DEMO (fictional residents)", using synthetic, labelled documents and EchoSimulator clips. No real resident has been invited.
