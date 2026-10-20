# Migrating the existing POCUS exam from ExamBuilder

## What ExamBuilder offers (researched October 2026)

The likely product is **ExamBuilder** (exambuilder.com), a hosted testing platform; confirm this is the one your program uses (blocker B4).

- **Official REST API** (`api.exambuilder.com`, key + secret, permissions granted by a Super User) covers **exams (list/get), students, groups, scheduling, SSO launch links and reports**. These include per-student exam statistics, enrollment, snapshot, *question ranking* (percent correct and discrimination per question), group analysis and date-range reports.
- **No documented API endpoint returns question text, answer options, correct answers, question banks or media files.** The question-ranking report returns statistics, not content.
- **LMS integration:** AICC, the web API or a custom interface. SCORM is not supported. No documented LTI.
- **Reports** can be saved as PDF or XLS (per user reviews).
- **Media:** exams can include images and videos, and the training library accepts video. No documented bulk media export.

**Conclusion.** The authorized way to get the *content* out is to ask the vendor. Results and statistics can come out through the API or the report exports.

## Plan

### Step 1 — Ask the vendor (or your institutional ExamBuilder administrator)

Email ExamBuilder support from the account owner's address:

> We are moving our POCUS end-of-block exam to an internal platform and need an export of exam "<name>" (all versions in use) including: question text, answer options, correct answer(s), question order and sections, point values, explanations or feedback, any category or learning-objective tags, and every embedded image or video **as original files with a mapping to the question they belong to**. CSV/Excel/QTI/JSON are all acceptable. Please also confirm whether question-level statistics (question ranking) can be exported for the past academic year.

If the program, rather than you, holds the account, the Super User or administrator makes this request. **Do not** scrape the web interface, script around logins, or use an undocumented endpoint.

### Step 2 — Collect the clips from the best source

The vendor's copy of a video may be re-compressed. The **original loops** (from the faculty member who built the exam, or the machine/PACS teaching export) are better, so use those wherever they exist. Run each through `tools/convert-clips.sh` and the de-identification checklist in [MEDIA_GUIDE.md](MEDIA_GUIDE.md).

Upload everything to **Admin → Media library** in one drag-and-drop, with media keys that match your manifest (e.g. `EB-Q14-1`). Authorize and attest each clip.

### Step 3 — Build the import file

Use **Admin → Import → Download CSV template**. One row per question:

| Column | Example |
|---|---|
| `question_key` | `EB-Q14` |
| `section` | `Lung` |
| `type` | `single`, `multiple` or `short_answer` |
| `stem`, `option_a` … `option_e` | text |
| `correct` | `B`, or `A;C` |
| `points`, `scoring` | `1`, `partial` (optional) |
| `explanation` | text |
| `domain` | `lung` (cardiac, lung, gastric, vascular, diaphragm, airway, ocular, fundamentals, other) |
| `objectives` | `LUNG-1;LUNG-2` |
| `media`, `media_captions` | `EB-Q14-1;EB-Q14-2` (media keys **or** original filenames), `Clip 1;Clip 2` |
| `source` | `ExamBuilder export 2026-11, Q14` |

JSON (`{ "questions": [ … ] }`) with the same field names is also accepted.

### Step 4 — Validate (automatic)

Choosing the file shows a validation table before anything is written. It flags:

- missing clips;
- unsupported or unknown question types;
- correct answers that do not match an option, or no answer at all;
- several "correct" answers on a single-best question;
- unknown domains or objectives;
- unauthorized clips;
- duplicate questions;
- repeated keys.

**Nothing is guessed.** A question with a missing or ambiguous answer is imported *flagged for faculty review*, and the database refuses to publish an exam containing a flagged question.

### Step 5 — Import as a draft, review, pilot

1. Import creates a **draft** exam with all questions in file order.
2. Faculty open each flagged question and fix it from the source of truth, then check every clip plays and that keys and points are right. The exam's readiness check must be clean.
3. **Pilot:** publish, assign it to 2–3 faculty or chief residents, and compare their scores question by question with the same answers entered in ExamBuilder. Any disagreement points to a key or scoring difference to fix *before* learners sit it.
4. Run the first live block with ExamBuilder still available as a fallback, then retire it.

### Optional — interim coexistence

If you want to keep ExamBuilder for a while, its API can schedule learners, generate SSO launch links (`/student/{id}/sso.json`) and pull results. A later phase could import those results into the faculty dashboard. This needs an API key from the account's Super User; it is not built yet.

## Sources

- [ExamBuilder API documentation](https://api.exambuilder.com/)
- [ExamBuilder LMS integration](https://www.exambuilder.com/lms-integration)
- [ExamBuilder on GetApp (features, reviews)](https://www.getapp.ca/software/131223/exambuilder)
