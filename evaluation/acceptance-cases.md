# Acceptance cases

These are expected design outcomes for fictional development fixtures. They are not observed test results or model performance.

| Record | Scenario | Expected status |
| --- | --- | --- |
| R001 | Exact fictional Alpha match | `ready_for_demo_mapping` |
| R002 | Same label and rate, different district | `ready_for_demo_mapping` |
| R003 | Exact municipal employee match | `ready_for_demo_mapping` |
| R004 | Custom abbreviation without identifier | `suggestion_only` |
| R005 | Municipal naming variation | `suggestion_only` |
| R006 | Ambiguous school tax | `needs_information` |
| R007 | Known code but missing context | `needs_information` |
| R008 | Code and jurisdiction disagree | `conflict` |
| R009 | Unknown source code | `needs_information` |
| R010 | Identifiable but unsupported | `unsupported` |
| R011 | Non-tax deduction | `excluded_non_tax` |
| R012 | Employee versus employer conflict | `conflict` |
| R013 | Rate mismatch | `conflict` |
| R014 | Duplicate source identity, first occurrence | `duplicate_review` |
| R015 | Duplicate source identity, second occurrence | `duplicate_review` |
| R016 | Expired reference period | `conflict` |
| R017 | Missing rate evidence | `needs_information` |
| R018 | Insufficient description and context | `needs_information` |
| R019 | Exact employer-paid municipal match | `ready_for_demo_mapping` |
| R020 | Zero is a valid supplied rate | `ready_for_demo_mapping` |

## Expected status counts

| Status | Count |
| --- | --- |
| `conflict` | 4 |
| `duplicate_review` | 2 |
| `excluded_non_tax` | 1 |
| `needs_information` | 5 |
| `ready_for_demo_mapping` | 5 |
| `suggestion_only` | 2 |
| `unsupported` | 1 |

## Whole-workflow checks

- Every input record appears in the export exactly once, with its original values preserved.
- R001 and R002 remain distinct despite the same name and rate.
- R006 remains unresolved until distinguishing evidence is supplied; after Alpha evidence it becomes a suggestion for review, not an invented code-backed mapping.
- Conflicts cannot be bypassed with a generic approval button.
- Both duplicate occurrences remain visible until their relationship is reviewed.
- Live AI failure is explicit; simulated data is never presented as a live response.
- Expected answers stay outside the model context.
- Counts describe review status only; they do not imply production payroll readiness.
- A fresh dataset is required to evaluate generalization beyond these development fixtures.
