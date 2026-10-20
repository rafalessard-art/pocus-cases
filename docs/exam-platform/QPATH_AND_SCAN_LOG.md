# QPath and the scan logbook

## What QPath can already do

From vendor documentation (Sonosite/Telexy Q-Path FAQ) and a published departmental Q-Path policy:
- **Review workflow:** archive POCUS studies, then review worksheets with annotation and e-signature.
- **Filters:** by date, patient, exam type and user.
- **Statistics:** a package that an administrator can configure to track any worksheet value per user, with export to Excel ("QA/credentialing statistics").
- **Reports:** PDF reports.
- **Integrations:** HL7 (EMR/ADT/orders), DICOM (PACS) and LDAP/Active Directory.

Neither source describes a trainee-facing logbook, competency tracking or a public API. Programs that use Q-Path describe reviewed trainee scans as feeding a logbook, but the counting appears to be done separately.

**To confirm with the department's Q-Path administrator:**
1. Whether reviewed trainee studies are tagged by exam type and reviewer.
2. Whether the statistics package can export per-trainee counts of *reviewed and accepted* studies by category for a date range.
3. Whether such an export can be produced without patient identifiers.

If yes, the counts can be imported here instead of typed, with no patient data. The table already reserves `source = 'qpath_count_import'`.

## Design in this portal (privacy-first)

- **Counts only.** No patient-level rows, images, MRNs, names, dates of birth, or scan dates and locations. Images stay in QPath. The original studies are reviewed there.
- **Faculty-verified totals count; resident-reported totals do not.** Faculty enter the new verified totals for all six categories in one form, confirm required views where the program requires them, and record once. The database stores the difference as an append-only attestation with the reviewer and date.
- **Corrections** are negative attestations with a mandatory reason. The total can never go below zero. Every batch is audit-logged.
- **Identifier screen.** Notes are at most 300 characters and are refused if they look like an identifier (6+ digit numbers, dates, MRN/DOB/health-card wording). The UI repeats the rule.
- **Future option.** A more detailed, institutionally approved scan log, if ever required, could be added as a separate table linked to `scan_categories`. The completion logic reads only the per-category totals, so nothing else would change.

Sources: [Q-Path FAQ (Sonosite)](https://www.sonosite.com/sites/default/files/Q-path_FAQV8.pdf) · [Saint John Regional EM Q-Path policy draft](https://emsj.ca/wp-content/uploads/2025/11/SJRHEM-Q-PAth-Policy-Draft-1.pdf)
