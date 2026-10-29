# First build

The first browser application is implemented. Live AI and optional AWS storage remain future milestones.

## One user journey

An accountant preparing a payroll migration loads a fictional company's local-tax items, understands the proposed mappings, resolves one missing jurisdiction fact, and exports the full review.

## Four screens

| Screen | Behavior | Reason |
| --- | --- | --- |
| Load data | Open the bundled sample or import a CSV with the sample columns. Use fictional records only. | Establish what information the system actually received. |
| Review results | Show every source record, proposed target when justified, status, and evidence. Filter without deleting records. | Make the result inspectable. |
| Resolve an item | Show source fields, plausible candidates, the specific missing or conflicting evidence, and a relevant action. Revalidate after an edit. | Resolve uncertainty through information. |
| Preview and export | Export original values, proposed mapping, status, checks, and recorded corrections for every item. | Produce a reviewable preparation report. |

## First demonstration sequence

1. Load the fixture and inspect R001 and R002. They share a name and rate but resolve to different fictional districts through different reference codes and jurisdiction evidence.
2. Open R004. Its abbreviated custom label can receive an AI suggestion; it must not automatically become an evidence-backed mapping.
3. Open R006. Select jurisdiction Alpha and enter a note describing the fictional evidence. Click Save & revalidate; the item becomes a suggestion. Verify its fields, enter another review note, and click Accept verified proposal. The two actions appear in history, and the original missing jurisdiction remains in the export.
4. Open R008. Its source code and jurisdiction disagree. Show the conflict and prevent a ready status until the contradiction is resolved.
5. Open R010. The item is identifiable but unsupported by this demo destination. Preserve it in the report with a resolution requirement.
6. Export the review, including all unresolved and excluded records.

## Meaning of ready

`ready_for_demo_mapping` means the fictional mapping checks pass. It does not mean real tax applicability, payroll readiness, historical balance migration, filing readiness, or account setup is complete.

## Implementation milestones

1. **Complete:** project setup and the four-screen workflow with explicitly labeled simulated responses.
2. **Complete:** deterministic validation and matching against the supplied demo catalog, evidence-based review actions, CSV import, and complete exports.
3. One live AI connection for uncertain labels, with structured candidates and supporting input fields. Clearly label live and simulated modes.
4. Evaluation of suggestions, unresolved cases, and API failure behavior. The system must not silently present simulated output as a live AI result.
5. Optional S3 storage for input files and saved reports. The first version uses browser storage and can be hosted as static files.

## First-version boundaries

This version prepares a mapping review. Actual QuickBooks file parsing, live QuickBooks writes, tax calculation, payroll submission, tax payments, employer account registration, and production legal validation require separate work and verified interfaces.

Do not display completion percentages that imply payroll readiness. Show observed item counts by review status. Every action should have a visible effect or a specific explanation.
