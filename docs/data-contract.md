# Fictional data contract

This is our prototype's own JSON schema, not an actual QuickBooks export or internal database schema. Field availability in real source data is unverified. A future adapter must validate what real data actually contains.

## Source fields

| Field | Meaning |
| --- | --- |
| `record_id` | Unique row identifier in this file. |
| `company_id` | Fictional company identifier. |
| `source_item_id` | Identity of an item within that company. |
| `item_name` | The user-defined source label; never authoritative by itself. |
| `item_kind` | Declared `tax`, `benefit_deduction`, or `unknown`. |
| `source_tax_code` | Optional fictional code that a demo catalog may recognize. |
| `jurisdiction_reference` | Optional, fictional jurisdiction evidence; not an address or a real jurisdiction ID. |
| `tax_category` | Declared category, or null when unknown. |
| `payer` | `employee` or `employer`, or null. |
| `rate_percent` | Percentage value, such as 1.5; null means missing, and zero is a real value. |
| `effective_on` | Date for the mapping exercise. |

Only these input facts and the catalog can be used to form suggestions. The fixture does not model real employee residences, work locations, legal applicability, employer registration, historical balances, or filing setup.

## Catalog fields

`target_id`, `source_code_aliases`, `display_name`, `jurisdiction_reference`, `tax_category`, `payer`, `rate_percent`, `effective_from`, `effective_to`, and `supported` define the fictional target. `supported` describes only this demo, not actual QuickBooks functionality.

All catalog and input values are synthetic. A future real catalog would need provenance, supported product/version scope, effective dates, and independent verification.

## CSV imports

The template contains the 11 source field names above as its header. All columns are required; optional values may be blank. The parser supports quoted commas, quotes, and line breaks. It rejects duplicate row IDs, invalid dates, invalid categories/payers, non-numeric rates, and files over 2 MB or 2,000 records. Zero is retained as a supplied rate.

Reports escape spreadsheet formula prefixes in CSV. JSON retains the original text exactly. A report CSV includes additional review columns and is not the input template.

## Implemented status rules

1. Preserve every input row with a unique `record_id`. Flag repeated `(company_id, source_item_id, effective_on)` identities for review, even when their payloads agree; do not silently delete either row.
2. Retain recognized non-tax deductions as `excluded_non_tax`; do not classify them as taxes because their names or rates look similar.
3. An unrecognized source code remains `needs_information`; do not overwrite it silently using a name guess.
4. For a recognized code, check every available jurisdiction, payer, category, rate, and effective-date field for conflicts. A contradiction prevents a ready status even if other evidence matches.
5. Missing required jurisdiction, payer, rate, or date evidence results in `needs_information`, including when a code identifies a catalog item. Identity and contextual evidence are separate. An unknown category may receive an AI suggestion, but it is not a verified fact.
6. With a recognized code, complete matching evidence, and an eligible catalog entry, return `ready_for_demo_mapping`. A known unsupported destination returns `unsupported` when there are no other blockers.
7. Without a source code, available compatible facts can narrow the catalog to candidates. If jurisdiction, payer, rate, and date are supplied, AI may interpret the label to rank tax categories and candidates. The initial release labels these `suggestion_only` until reviewed; an inferred category must be displayed as inferred. Do not manufacture the missing identifier.
8. An unresolved case with multiple plausible targets remains `needs_information`. Preserve all candidate IDs and ask for the distinguishing fact.

Multiple checks can fail. Store all check results even when the interface chooses a primary status. The status is a summary, not a substitute for the evidence.

After a review action, preserve the original values, record the correction and its stated evidence, and rerun validation. Approval cannot bypass a contradiction or unavailable destination. A human's click is not proof that an unsupported fact is true.

An accepted compatible proposal becomes `reviewed_mapping`; no missing source code is invented. A confirmed duplicate becomes `excluded_duplicate`, while both original rows remain in the report. If the related record changes so that the exclusion no longer applies, the exclusion becomes a conflict and requires review again.

The current simulation uses a small label rule set to rank plausible school/municipal candidates. It makes no model API call. Reports explicitly include `ai_mode: "simulated"`; bundled data is marked as synthetic, while an uploaded file's provenance is unknown.

## Expected outcomes

`evaluation/expected-results.json` is a design oracle. It is kept separately to prevent the application or AI from reading the intended answer. Candidate IDs in that file define acceptable candidates for the example; they are not observed model output. For AI cases, the actual response must be measured after integration.
