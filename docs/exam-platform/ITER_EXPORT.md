# ITER-ready summary: from the POCUS portal to the One45 ITER

**Which system does what:**

| System | Used for |
|---|---|
| **Elentra** | C6 POCUS EPA assessments are completed and reviewed there; faculty verify that review in the portal |
| **POCUS portal** | Collects the evidence (exam, Brightspace, faculty-verified scans, Elentra EPA review, direct observations) and prepares an ITER-ready draft |
| **One45** | The official In-Training Evaluation Report (ITER) is completed, reviewed and **submitted** there by faculty |

The ITAR workspace (Faculty → block → resident → **E · ITER for One45**) prepares the narrative fields of the One45 ITER. It has two views:

| View | What it is | Used for |
|---|---|---|
| **ITER Quick Copy** (default) | Only the One45 fields, in form order: overall rotation objectives, overall explanation of performance, strengths, areas needing improvement, recommendations, basis of assessment, discussed with the trainee. Each has **Copy**; **Copy all One45 fields** copies the set. | Filling in the ITER in One45 in a few minutes |
| **Full Evidence Record** (optional) | The detailed, read-only record: resident and rotation, verified rotation evidence (requirements, every exam attempt, Brightspace cases with reviewer and date, scans by category with last attestation, C6 EPA review), faculty observations, and evidence sources. | Checking the facts behind the draft; keeping a record |

- **"Draft approved — ready for One45" is not a submission.** Approving in the portal locks the draft (and keeps an immutable version); the ITER is officially completed and submitted only in One45.
- The portal **never** selects a CanMEDS rating or the overall rotation outcome, and never submits anything to One45. There is no One45 integration.
- **CanMEDS roles are not part of the draft.** In One45 they are tick boxes that faculty complete directly.
- The layout is a **configurable template** (Admin → ITAR setup → *ITER export template*). It stays marked *draft* until the rotation director confirms it matches the current POCUS block ITER (DIRECTOR_DECISIONS.md #10).

## How Quick Copy is drafted

**Prepare ITER for One45** (or **Refresh from evidence**) drafts text from records already verified in the portal. Each drafted box is labelled *"Drafted from portal records — review and edit before approving."* Refreshing replaces only boxes that are empty or still exactly as drafted; anything faculty edited is kept.

| One45 field | Drafted from | Never drafted |
|---|---|---|
| Overall rotation objectives | — | Always selected by faculty |
| Overall explanation of performance | Factual sentences: requirements completed (or still to complete, by name), written exam result against the pass mark, scans against targets (categories below target named), C6 EPA criteria decision with the number reviewed and at the highest entrustment level, EPA review findings, and faculty observations for this block (oldest first, up to 4) | Praise, ratings or a competence judgment |
| Summary of strengths | Only strengths documented in the EPA review feedback (then the highest exam domains as supporting fact) | Anything not written by a faculty member |
| Areas needing improvement | Areas and concerns documented in the EPA review; weak exam domains | Invented weaknesses |
| Recommendations | Plain follow-ups that come from the record ("Complete the remaining rotation requirements", "Review <weak exam domains>") | Clinical or career advice |
| Basis of assessment | — (see below) | Always confirmed by faculty |
| Discussed with the trainee | — | Always selected by faculty |

If there is nothing documented to draft from, the box stays empty with a prompt (for example *"no faculty feedback to draft this from"*), and faculty write it. Strengths and areas are required before approval.

## Basis of assessment: faculty confirm it

Nothing is ticked automatically. Each option shows what the portal holds, as information only:

| Option | Hint shown |
|---|---|
| Informal observation | Number of faculty observations recorded for this block |
| **Formal direct observation** | "Only if you or a colleague formally observed the resident. EPA verification, image review in QPath and the written exam do not count on their own." |
| Written examination | Whether a graded end-of-block exam is on record |
| Oral examination, OSCE | Not recorded in the portal |
| Other | e.g. image review in QPath, Brightspace cases, TeachingMedicine, rounds presentation |

Until a faculty member ticks the boxes, the copied text reads *"[Faculty to confirm: basis of assessment.]"* and approval is blocked. (Earlier, an EPA review pre-ticked *formal direct observation*. That has been removed.) The options follow the One45 form; the director confirms the list (#10).

## Transferring it to One45 (a few minutes)

1. Open the resident's ITER in One45 beside the portal. Check the resident, rotation and dates.
2. In **Quick Copy**, read and edit the drafted text; add your own judgment. Open **Full Evidence Record** if you want to check a fact.
3. Tick the CanMEDS rating boxes in One45 yourself, as usual.
4. Select **Overall rotation objectives** and tick **Basis of assessment** and **Discussed with the trainee** in the portal, then **Approve draft**.
5. **Copy** each field (or **Copy all One45 fields**) and paste it into the One45 field with the same heading. Then select the same options in One45, review, and submit there as usual.

**Download .txt** saves the current view (Quick Copy or Full Evidence Record); **Print** gives a clean printout of it. All exports are audit-logged (`iter_copy_section`, `iter_copy_all`, `iter_text`).

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

- No CanMEDS sections, no automatic ratings, no automatic outcome, no automatic basis of assessment, and no inference of competence from scores or counts. Drafting is done in the browser from portal records; nothing is sent to an AI service.
- No submission to One45 and no One45 integration. No Elentra integration either (see ELENTRA_IMPORT_PROPOSAL.md for a possible future EPA report import).
- The real ITER and EPA examples were used only to read the form structure. They contain identifiable educational records and are **not stored in the portal or used as test data**. Tests use the fictional example in `fixtures/FICTIONAL_ITER_AND_EPA_EXAMPLE.md`.
- Approved draft versions keep the layout and text they were approved with (versions approved before Oct 21 say "Elentra ITER" in their destinations, and the demo resident's approved v4–v5 still carry the basis boxes that were pre-ticked by the old suggestion, including *formal direct observation*); a revision adds a new version. If the ITER was already submitted in One45, corrections are made in One45.
