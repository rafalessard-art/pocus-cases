# Fictional ITER and C6 EPA example (test and demonstration data only)

Everything below is invented. It mirrors the **structure** of the University of Ottawa Anesthesiology ITER and the ANES-C6 POCUS EPA form, so the export can be tested without real assessment records. The real example forms are identifiable educational records, so they are never stored in the portal or used as fixtures.

## Fictional C6 POCUS EPA assessment

| Field | Fictional value |
|---|---|
| Resident | Sam Fictional-Resident (PGY-2) |
| Assessor | Dr Fictional Faculty |
| Context / type of ultrasound examination | Pre-operative clinic; gastric ultrasound (antrum, supine and right lateral decubitus) |
| Milestones (Not observed / In progress / Achieved) | Image acquisition: Achieved · Interpretation: Achieved · Integration into the anesthetic plan: In progress |
| Overall entrustment (1 = "I had to do" … 5 = "I did not need to be there") | 4 |
| Observer comments | Fictional: clear antral views; describe the cross-sectional area before concluding. |
| Next steps | Fictional: perform two more scans with independent interpretation. |

What faculty record in the portal from a set of such assessments (optional, never decisive):
- C6 assessments reviewed: 6;
- entrustment counts: level 5 × 2, level 4 × 3, level 3 × 1;
- findings: "Interprets antral cross-sectional area reliably";
- criteria decision: *partially met*.

## Fictional ITER (as completed by faculty in Elentra)

**CanMEDS roles:** ticked by faculty directly in Elentra; the portal prepares nothing for them.

**Faculty observations (portal reference):** "Obtained a right lateral decubitus antral view independently"; "Explained the gastric scan to the patient clearly".

**Overall rotation objectives:** Yes, Partially (faculty selection).

**Narrative fields:**
- Overall explanation of performance: Fictional: steady progress; C6 POCUS assessments still incomplete.
- Summary of strengths: Fictional: systematic gastric scanning sequence.
- Summary of areas needing improvement: Fictional: obtain more lung ultrasound assessments.
- Recommendations for ongoing improvement: Fictional: two observed lung scans in the next block.

**Basis of assessment:** Informal observation; Formal direct observation; Written examination; Other.

**Performance discussed with the trainee:** Yes.

Used by `portal/src/lib/iter.test.ts` (unit tests) and the live demonstration with "Alex Demo-Resident (fictional)".
