# Local Tax Migration Review

An academic web prototype for reviewing proposed local-tax item mappings during a Desktop-to-Online payroll migration.

**Current milestone: working review application.** Import fictional items, inspect matches, record evidence and corrections, and export the complete review. Suggestions are explicitly simulated. Live AI, AWS storage, and QuickBooks integration are not connected.

## Start here

Requires Node.js 20 or later. No dependency installation or API key is needed.

```sh
npm test
npm run build
npm start
```

Open `http://localhost:3000`. The build copies the application and fictional catalog into `dist/`; it does not copy `evaluation/` or its expected answers. Rebuild after changing source files.

1. Click **Load demo dataset** to load 20 fictional records.
2. Open **R006**, select jurisdiction **Alpha**, enter an evidence note, and click **Save & revalidate**.
3. Inspect the proposal, enter a review note, and click **Accept verified proposal**.
4. Open **R008** to see a conflicting code and jurisdiction. It cannot be accepted while that conflict remains.
5. Open **Export report** and download CSV or JSON. All 20 rows, including unresolved and excluded rows, are retained.

For CSV imports, download the sample template from the Load data screen. Use fictional records only; this prototype is not approved for private payroll information.

The current files require no API credentials or cloud services. Future API credentials belong in private server configuration and must not be committed to GitHub or included in browser code.

## What works

The four screens cover import, review, resolution, and export. Search, status filters, sorting, and pagination help inspect records. Validation checks expose missing information, conflicting evidence, unsupported destinations, and duplicates. Corrections and decisions require a note; restoring an original retains the history. Exports contain originals, current values, candidates, checks, and review events.

Drafts are stored in this browser's local storage. They are not shared across devices or users and may be lost if browser storage is cleared. Export a report to keep a copy. The review history is a local demonstration record, not a tamper-proof audit system.

The report is a review artifact, not a QuickBooks import file and not authorization to run payroll.

## Files

| File | Purpose |
| --- | --- |
| `web/app.mjs`, `web/styles.css` | Four-screen browser application. |
| `web/engine.mjs` | Deterministic matching, simulated suggestions, review decisions, and history. |
| `web/io.mjs` | CSV validation and complete CSV/JSON reports. |
| `scripts/` | Dependency-free build and local static server. |
| `tests/review.test.mjs` | Fixture outcomes, evidence rules, duplicates, and import/export tests. |
| `docs/first-build.md` | Scope, four screens, and the first demonstration. |
| `docs/design-decisions.md` | Why we use rules, AI, sample data, GitHub, and optional AWS. |
| `docs/data-contract.md` | Fictional fields, import format, and status rules. |
| `data/sample-items.json` | 20 fictional source records. |
| `data/demo-catalog.json` | Eight fictional destination catalog entries. |
| `evaluation/expected-results.json` | Expected outcomes, evidence, and resolution steps. |
| `evaluation/acceptance-cases.md` | A readable checklist of the 20 cases. |

All tax names, codes, jurisdictions, rates, company identifiers, and rules in these files are **fictional**. They are not an Intuit catalog, not a legal reference, and not an actual QuickBooks export schema. Only the shape of the problem is being demonstrated.

## What the faculty can inspect

- Exactly which inputs produced a proposed mapping.
- Which checks are deterministic and where an AI suggestion is used.
- Why the application requests a missing fact.
- Whether a conflict blocks a proposed mapping.
- Whether the output preserves all input records, including unresolved ones.
- The boundary between implemented rules and simulated suggestions; a measured live-AI comparison remains a future milestone.

The 20 examples are development fixtures, not evidence of production accuracy. A separate, independently checked evaluation dataset is required before making accuracy or automation-coverage claims.

## Assumptions to confirm

- Submission deadline and grading requirements.
- Whether a working AI API call is required; this is the planned target.
- Whether AWS is mandatory or optional; it is currently treated as optional.
- Whether the faculty can provide an authorized dataset or cloud/API access.
- Access to any actual QuickBooks integration and destination catalog, if needed later.

## Validation and next milestone

The automated suite has 29 passing tests covering the 20 fixture outcomes, correction and approval, blocked approvals, duplicate review, restoring originals, CSV validation, spreadsheet-formula protection, and complete reports. These are behavior checks on fictional development fixtures, not an AI accuracy result.

Next: add a server endpoint for a real AI provider, keep its key in private server configuration, validate every returned candidate, and compare its value against the existing rules on independent examples. Add explicit timeout/error handling and clearly separate live and simulated modes. Optional AWS S3 can follow if required by the faculty. See [the design decisions](docs/design-decisions.md) for the rationale and [the first-build guide](docs/first-build.md) for the demonstration.
