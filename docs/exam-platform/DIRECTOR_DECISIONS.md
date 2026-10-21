# Decisions for the POCUS rotation director

Everything below is configurable without code (Admin → ITAR setup / exam settings). The current values are placeholders until approved.

| # | Decision | Current setting in the portal | Options / question |
|---|---|---|---|
| 1 | **C6 EPA completion criteria** | Streamlined verification: faculty attest they reviewed the EPAs in Elentra, then choose *met / partially met / outstanding*. "Met" needs explicit confirmation of the configured criteria. The criteria text is a **DRAFT** ("the C6 POCUS EPAs required by the program have been assessed and documented in Elentra at the program-defined entrustment level"). Edit and approve it in Admin → ITAR setup. | Which EPAs count as "C6 POCUS EPAs"? How many assessments, and what entrustment level? Who signs off: block supervisor or rotation director? Is a future Elentra report import wanted (ELENTRA_IMPORT_PROPOSAL.md)? |
| 2 | **Scan counts and required views** | Airway 5 (both views) · Cardiac 40 (PLAX, PSAX, S4C, A4C, IVC) · Lung/pleura 15 (≥ 2 points per hemithorax) · Abdominal/FAST 20 (RUQ, LUQ, pelvis, subcostal) · Gastric 20 · DVT 2 = **102** | Confirm counts. Confirm exact view rules per category. Should a category count only scans with all required views? |
| 3 | **Aggregate scan attestation** | Faculty attest per-category **counts** after reviewing images in QPath; no patient-level log in the portal | Is an aggregate attestation acceptable to the program, or is an individual scan log required (and where should it live: QPath)? Who may attest (any staff, or POCUS faculty only)? |
| 4 | **TeachingMedicine** | Resident submits; faculty confirm; evidence upload optional | Is faculty confirmation enough, or is a certificate upload required? Which modules? |
| 5 | **POCUS rounds** | Stages: planned → reviewed by faculty → presented → confirmed; "not yet due" allowed | Required in every block or once per year? Who reviews beforehand? How is "not yet due" decided? |
| 6 | **Exam attempts and feedback** | Pass mark **75%**; default: the most recent submitted attempt is used, faculty may select another; demo exam allows 1 attempt with full review after release | Number of attempts? Best or most recent attempt? Re-attempt process after < 75%? What residents see after the exam (score only, domains, full review)? When results are released? |
| 7 | **Official ITER format** | ITER-ready summary laid out like the uOttawa Anesthesiology ITER (CanMEDS roles, rotation objectives, four narrative fields, basis of assessment, discussed with trainee); section-by-section copy into Elentra (ITER_EXPORT.md) | Is section-by-section copying acceptable? |
| 8 | **Learning-case list** | 4 required Brightspace cases (draft titles from the teaching site) | Confirm the exact Brightspace case list per block. |
| 9 | **Evidence retention** | Files kept until an admin deletes them | How long to keep uploaded completion evidence after the block (records-retention schedule)? |
| 10 | **ITER template for the POCUS block** | Seeded from an **elective** ITER example; marked *draft* | Confirm the current POCUS block ITER uses the same CanMEDS headings, rating scale, rotation-objectives options, narrative headings and basis-of-assessment options (Admin → ITAR setup → ITER export template → "confirmed") |
| 11 | **Where the verified evidence goes** | Reference for rating; optionally pasted after the faculty narrative in *Overall explanation of performance* | Paste it, keep it as reference only, or use another field? |
| 12 | **C6 counts in the criteria** | Number of C6 assessments reviewed and entrustment counts are optional and never decide the requirement | Should the C6 criteria name a minimum number of assessments or entrustment level? (Faculty would still confirm "met".) |

**Also ask:** who should be faculty evaluators per block, and should the rotation director see all blocks? (Admins see all; faculty see only blocks where they are evaluators.)
