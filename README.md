# Local Tax Migration Review

An academic prototype concept for reviewing proposed local-tax item mappings during a Desktop-to-Online payroll migration.

**Current milestone: project foundation.** The scope, demonstration data, and expected outcomes are prepared. A running web application, live AI connection, AWS storage, and QuickBooks integration are not implemented yet.

## Start here

1. Read [the first-build brief](docs/first-build.md) for the four-screen workflow.
2. Inspect [the sample items](data/sample-items.json) and [the fictional destination catalog](data/demo-catalog.json).
3. Review [the expected outcomes](evaluation/acceptance-cases.md) and [design decisions](docs/design-decisions.md).
4. Implement the load → review → resolve → export workflow, then connect one real AI API and compare it with straightforward matching rules.
5. Add AWS S3 file storage if the course requires or benefits from it.

The current files require no API credentials or cloud services. Future API credentials belong in private server configuration and must not be committed to GitHub or included in browser code.

## What the prototype should do

An employer or accountant loads sample payroll items, reviews proposed destination matches and evidence, resolves missing information, and exports a preparation report. The report is a review artifact, not a QuickBooks import file and not authorization to run payroll.

## Files

| File | Purpose |
| --- | --- |
| `docs/first-build.md` | Scope, four screens, and the first demonstration. |
| `docs/design-decisions.md` | Why we use rules, AI, sample data, GitHub, and optional AWS. |
| `docs/data-contract.md` | Meaning of the fictional fields and planned status rules. |
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
- A comparison of rules alone and AI-assisted matching on known examples.

The 20 examples are development fixtures, not evidence of production accuracy. A separate, independently checked evaluation dataset is required before making accuracy or automation-coverage claims.

## Assumptions to confirm

- Submission deadline and grading requirements.
- Whether a working AI API call is required; this is the planned target.
- Whether AWS is mandatory or optional; it is currently treated as optional.
- Whether the faculty can provide an authorized dataset or cloud/API access.
- Access to any actual QuickBooks integration and destination catalog, if needed later.

## Next implementation milestone

Build the four-screen workflow with the supplied records and clearly labeled simulated AI suggestions. A reviewer should be able to open R006, supply fictional jurisdiction evidence, revalidate the item, and export a report that retains all 20 source records. Then replace simulated suggestions with a measured, live AI integration.

Fixture consistency and archive integrity were checked during starter preparation. No application, AI accuracy, or production payroll tests have run.
