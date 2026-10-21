# ITER-ready summary: from the POCUS portal to the One45 ITER

**Which system does what:**

| System | Used for |
|---|---|
| **Elentra** | C6 POCUS EPA assessments are completed and reviewed there; faculty verify that review in the portal |
| **POCUS portal** | Collects the evidence (exam, Brightspace, faculty-verified scans, Elentra EPA review, direct observations) and prepares an ITER-ready draft |
| **One45** | The official In-Training Evaluation Report (ITER) is completed, reviewed and **submitted** there by faculty |

The ITAR workspace (Faculty → block → resident → **E · ITER summary**) produces a draft laid out like the University of Ottawa Anesthesiology ITER in One45. Faculty copy each section into the matching One45 field.

- **"Draft approved — ready for One45" is not a submission.** Approving in the portal locks the draft (and keeps an immutable version); the ITER is officially completed and submitted only in One45.
- The portal **never** selects a CanMEDS rating or the overall rotation outcome, and never submits anything to One45. There is no One45 integration.
- **CanMEDS roles are not part of the summary.** In One45 they are tick boxes that faculty complete directly; per-role notes added work without adding useful information (removed in migration 13).
- The layout is a **configurable template** (Admin → ITAR setup → *ITER export template*). The seeded template is based on an **elective** ITER example. It stays marked *draft* until the rotation director confirms it matches the current POCUS block ITER (DIRECTOR_DECISIONS.md #10).

## Section by section

| ITER-ready section (template heading) | Filled from | Who decides | Where it goes in One45 |
|---|---|---|---|
| Resident and rotation | Block and resident record | — | Check you are on the right ITER |
| **Verified rotation evidence (POCUS portal)** | Requirement statuses; exam (score, attempt used, 75% pass mark, domains); Brightspace cases verified; scans by category; TeachingMedicine, QPath and rounds confirmations; **the C6 EPA review (the only place EPA information appears)** | Facts verified earlier in the portal | Reference for your ratings. Optionally paste after your own text in *Overall explanation of performance* (placement is a director decision, #11) |
| Faculty observations (only if any were recorded) | Your observations for this block, grouped by category | — | Reference; use in your own words in the narrative fields if relevant |
| Overall rotation objectives | Your selection from the official options (*No, due to other reasons / No, due to absence / No, due to unsatisfactory performance / Yes, Partially / Yes, Fully*), or "not selected here" | You | Select the same option |
| Overall explanation of performance | Your text (optional in the portal) | You | Paste |
| Summary of strengths | Your text (**required before approval**) | You | Paste |
| Summary of areas needing improvement | Your text (**required before approval**). EPA concerns, outstanding requirements and weak exam domains are shown **beside** the box as reminders; they are never inserted | You | Paste |
| Recommendations for ongoing improvement | Your text (optional) | You | Paste |
| Basis of assessment | Boxes pre-ticked **as suggestions** from what the portal holds: *informal observation* (observations), *formal direct observation* (C6 EPA assessments reviewed), *written examination*, *other* (Brightspace, scan log, attestations). You can change any of them. | You | Tick the same boxes |
| Performance discussed with the trainee | Your Yes/No (or "not recorded here") | You | Select |
| Portal record | Sources and template used | — | For your files; not an ITER field |

## Transferring it to One45 (about 5 minutes)

1. Open the resident's ITER in One45 beside the portal and check the resident, rotation and dates.
2. Read **Verified rotation evidence**. It is factual and is the basis for your ratings.
3. Tick the CanMEDS rating boxes in One45 yourself, as usual (the portal prepares nothing for them).
4. Select the same **Overall rotation objectives** option.
5. Click **Copy** on each narrative section and paste it into the One45 field with the same heading.
6. Tick the same **Basis of assessment** boxes, answer **discussed with the trainee**, then review and submit the ITER in One45 as usual.

**Copy all (with One45 destinations)** and **Download .txt** produce a transfer sheet: every section's heading, then "→ where it goes", then the text. All exports are audit-logged (`iter_copy_section`, `iter_copy_all`, `iter_text`).

## C6 POCUS EPA: what the portal records

The streamlined verification is unchanged:
1. tick *reviewed in Elentra*;
2. choose *criteria met / partially met / outstanding*;
3. for *met*, confirm the criteria.

Optional extras, used only if they're in front of you:
- the **number of C6 POCUS assessments reviewed**;
- the **count at each entrustment level**: 1 = "I had to do" … 5 = "I did not need to be there". The counts can't exceed the number reviewed.
- **important findings**.

These appear once in the evidence section with the sentence: "The number of assessments is reported as reviewed; it does not by itself determine whether the C6 requirement is met."

You don't transcribe individual EPAs, don't re-enter milestones and don't upload EPA forms.

## Not done, by design

- No CanMEDS sections, no automatic ratings, no automatic outcome, and no inference of competence from scores or counts.
- No submission to One45 and no One45 integration. No Elentra integration either (see ELENTRA_IMPORT_PROPOSAL.md for a possible future EPA report import).
- The real ITER and EPA examples were used only to read the form structure. They contain identifiable educational records and are **not stored in the portal or used as test data**. Tests use the fictional example in `fixtures/FICTIONAL_ITER_AND_EPA_EXAMPLE.md`.
- Approved draft versions keep the layout and text they were approved with (versions approved before Oct 21 say "Elentra ITER" in their destinations); a revision adds a new version. If the ITER was already submitted in One45, corrections are made in One45.
