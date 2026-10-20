# Proposal: faculty-authorised Elentra EPA report import (not built)

**Status:** this is a proposal only. Nothing in the portal reads Elentra files today. **Do not use real resident reports with it** until the prerequisites in §5 are approved. No assessment report is sent to any external or AI service, now or under this design.

## 1. Goal

Today a faculty member reviews the resident's EPAs in Elentra and records a one-step verification in the portal (*Reviewed in Elentra* + *criteria met / partially met / outstanding* + optional notes). An import would only **pre-fill the evidence summary** that faculty look at. It would never decide the requirement:

> Faculty export an authorised EPA report from Elentra → upload it in the resident's ITAR workspace → the browser parses it and keeps only the C6 POCUS EPA rows → faculty review the summary and confirm the criteria decision → the confirmed summary becomes available to the ITAR draft.

The criteria decision stays a human attestation, as it is now. The import only removes the need to look up counts and dates by hand.

## 2. Candidate Elentra sources

| Source | How it's produced | Fit |
|---|---|---|
| **Assessment Data Extract** (Admin → Assessment & Evaluation → Reports) | CSV, one row per assessment. Filters: program, date range of delivery, activity type, form(s). | **Best fit.** It has EPA code and title, the entrustment rating, the date and the release flags. It's program-wide, so it holds **every resident in the program**. The importer would need to filter rows to one learner and discard the rest *before* anything is stored. |
| **Learner Reports / My Learners** (CSV export added in Elentra release 24.09.10) | Per-learner export from the program admin and competence committee views | Smaller scope, since it's already one learner. The column list isn't published, so we need a sample export from our Elentra administrators. |
| **CBME dashboard** (screen only) | Not an export | Already used by faculty for the manual verification |

Columns of the Assessment Data Extract that institutional guides document include:
- Assessment ID, form name, code and type;
- assessee user ID, last name, email, CPSO, stage and training level;
- assessor name, email, role and CPSO;
- date of encounter and submission timestamps;
- flagged, embargoed and released-to-assessee or competence-committee flags;
- EPA code and EPA title;
- entrustment / overall rating, value and category, and entrusted / satisfactory;
- rotation service, clinical location or site;
- free-text "things to continue doing" and "things to work on";
- contextual variables and milestones.

Exact names vary by Elentra version and institution, so **we need a de-identified header row from the uOttawa Elentra team.**

## 3. Fields we would need (minimum set)

| Needed | Elentra column (expected) | Why | Stored? |
|---|---|---|---|
| EPA code | EPA Code | Select the C6 POCUS EPA rows | Yes, in the summary |
| EPA title | EPA Title | Display | Yes |
| Encounter date | Date of encounter | Confirm it falls in the rotation block and count by period | Yes, as a date only |
| Entrustment category | Entrustment / Overall Category (or Value) | Compare against the program-defined level | Yes, as counts by category |
| Entrusted / satisfactory | Entrusted / Satisfactory | Same | Yes, as counts |
| Assessment ID | Assessment ID | Deduplicate a re-uploaded report | Hashed only |
| Learner match | Assessee User ID **or** Assessee Email | Make sure the rows belong to the resident whose workspace is open; drop all other learners | **No.** Used in the browser for matching, then discarded |
| Embargoed / released flags | Embargoed, Released to Assessee | Exclude embargoed assessments unless the uploader is authorised to see them | No |

**Deliberately not imported:**
- assessor names, emails and CPSO numbers;
- assessee CPSO;
- free-text feedback (for example "things to continue/work on");
- contextual variables, including patient-related ones such as presentation or complexity;
- clinical location or site;
- device and browser fields;
- assessment URLs.

Faculty read narrative feedback in Elentra and, if relevant, summarise it in the existing optional *Strengths / Areas / Concerns* fields.

## 4. Proposed implementation

1. **Upload:** shown in the faculty ITAR workspace (the EPA section, "Pre-fill from Elentra export…"), for block evaluators and admins only. Residents never see it.
2. **Parsing:** done entirely in the browser (Papa Parse or a small CSV reader). The raw file is **never uploaded or stored**: not in Supabase Storage, not on Vercel, not in any third-party or AI service.
3. **Structure check:**
   - required headers must be present; unknown columns are ignored;
   - reject the file if the learner-match column is absent or matches no row;
   - show "N rows for other learners were discarded".
4. **Filtering:**
   - keep rows for the open learner;
   - keep rows whose EPA code is in the configured C6 POCUS EPA list (a new `epa_codes` entry in the EPA requirement config, editable in Admin → ITAR setup, pending director approval);
   - keep encounter dates inside the block (with a configurable grace period).
5. **Summary shown to faculty** (nothing saved yet):
   - per EPA code: number of assessments, count at or above the program entrustment level, latest date;
   - totals.
6. **Faculty validation:** the faculty member confirms the summary, then makes the same criteria decision as today. Only the **aggregate summary** (codes, counts, dates) goes into `epa_reviews.entries`, along with `source = 'elentra_import'`, the import timestamp and a hash of the file. An `epa_import_confirmed` audit event is logged.
7. **ITAR:** the draft keeps its current wording ("assessments were reviewed against the program criteria … not a separate assessment of clinical competence"). It may add "Summary pre-filled from an Elentra report exported on <date> and confirmed by <faculty>." It makes no statements about performance beyond the counts.
8. **Tests:**
   - synthetic CSV fixtures only, including one with other learners, one with embargoed rows, one with wrong headers and one with no C6 rows;
   - unit tests for parsing and filtering;
   - an E2E test that confirms nothing is uploaded (by checking network requests).

Estimated effort: about 2–3 days once the column list and approvals exist.

## 5. Prerequisites before any real report is used

- **Privacy:** AIPO and PGME confirm that exporting the Assessment Data Extract to a faculty workstation and parsing it locally is permitted. It is program-wide and holds other learners' data.
- **Elentra permissions:** who may run the extract (program administrators vs. supervising faculty), and the handling of embargoed assessments.
- **Retention:** confirm that storing only the aggregate summary in the portal is acceptable, and that the downloaded CSV is deleted from the faculty workstation per policy. The portal can't enforce this, so it goes in the guidance.
- **Program decisions:**
  - the C6 POCUS EPA codes;
  - the entrustment level that counts;
  - the minimum number;
  - the date window.

  These are the same criteria the director must approve for the manual workflow (DIRECTOR_DECISIONS.md).
- **Sample header row:** with no data rows, from the uOttawa Elentra administrators, to fix the column mapping.

## 6. Recommendation

Keep the manual verification as the default. It already takes about 30 seconds per resident. Build the import only if directors find the manual review of the Elentra dashboard to be the bottleneck, and only after §5 is complete.
