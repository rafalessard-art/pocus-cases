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

## Excel logbooks and a possible aggregate-only template import (assessment, not built)

Residents' current Excel logbooks may contain MRNs, scan dates, findings and procedures. The portal therefore **does not accept logbook uploads**. The Requirements page tells residents to report numbers only and not to upload the logbook. The established workflow stays: the resident types six category totals, faculty verify against the logbook or QPath, and only faculty-verified totals count.

**Would an aggregate-only template import help?** We looked at a standard two-column template (`category, count`), parsed in the browser, with only the six totals sent.

- **Saving: minimal.** Reporting is six numbers in one form, about 30 seconds, and it's pre-filled with the last values. An import still means maintaining a second "summary" sheet. If residents build that by hand, it's the same typing. If it's a formula tab inside the patient-level logbook, the resident's file mixes both. Opening that file in the portal means patient data reaches the browser, even if it's never uploaded.
- **Risk: real.** A strict template check can reject unexpected columns, cells that look like identifiers (6+ digits, dates) and extra rows. But that's only a filter. **It is not proof of de-identification**, and residents would be more likely to choose the wrong file.
- **Requirements if ever built:**
  - a fixed downloadable template (exactly six category rows and two columns), with any other sheet, column, row, date or text value rejected;
  - parsing in the browser only, with the file never uploaded or stored;
  - only the six totals submitted, through the existing self-report path, still needing faculty verification;
  - institutional approval before enabling it.

  A patient-level importer is out of scope without institutional authorisation.
- **Recommendation:** don't build it now. Revisit if a future QPath count export (above) becomes available. That's a better source, because the counts would come from reviewed studies rather than from the resident's own sheet.

Sources: [Q-Path FAQ (Sonosite)](https://www.sonosite.com/sites/default/files/Q-path_FAQV8.pdf) · [Saint John Regional EM Q-Path policy draft](https://emsj.ca/wp-content/uploads/2025/11/SJRHEM-Q-PAth-Policy-Draft-1.pdf)
