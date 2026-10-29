# Data contract

All files are in `data/`. Companies, people, street addresses, wages and account numbers are fictional. Ohio school-district codes and rates and the Lancaster and Columbus city rates are real (see `catalog.json` → `metadata.sources`).

## catalog.json: what Online payroll knows

- `states.<ST>`: `name`, `rollout` (`enabled` or `not_yet_enabled`), `taxes[]`, `no_tax_districts[]`, `place_names[]`.
- Tax: `tax_id`, `type` (`school_district` or `municipal`), `code` (the Ohio district number for school districts), `name`, `place`, `rate` (percent), `base`, `basis` (`home` or `work`), `agency`, `qb_pays_and_files`.
- `no_tax_districts[]`: districts with no school income tax, such as Columbus City Schools (`name`, `place`, `note`).
- `place_names[]`: removed from labels before clustering, so "Lancaster SD" and "Bremen SD" look alike.
- `defined_entries[]`: the names a cluster can take: `entry_id`, `kind` (`tax` or `non_tax`), `tax_type` for taxes, `states`, `label`, and `text` (the words the cluster is compared with).

## geocoder.json: stands in for an address lookup

- `addresses[]`: `address_id`, `line1`, `city`, `state`, `zip`, `school_district` (an Ohio district code, `NO-TAX-...`, or null), `municipality`.

A home city that differs from the work city gives an optional tax (courtesy withholding), not a required one.

## companies.json: what came across from Desktop

- Company: `company_id`, `name`, `plan` (`Core`, `Premium` or `Elite`), `migration_month` (10 = October), `worksites[]` (`site_id`, `name`, `address_id`), `items[]`, `employees[]`.
- Item:
  - `item_id`, `label` (free text);
  - `law_id` (177 or 0 = employer-created custom item);
  - `origin` (`custom` or `system`), plus `system_tax_id` for system items;
  - `item_type`, `tracking_type` (`None` means Desktop treats it as an after-tax deduction);
  - `calc` (`{kind: "percent", rate}` or `{kind: "flat_annual", amount}`);
  - `agency`, `agency_account`, `deposit_frequency`.
- Employee: `employee_id`, `name`, `site_id`, `monthly_wages`, `addresses[]` (`{address_id, from_month}`; empty means no address on file), `items[]` (item ids withheld in Desktop).

## label-pool.json: expert answers for shadow mode

- `pools.<ST>[]`: `label`, `expert_label` (`school_district`, `municipal`, `non_tax:<entry_id>`, or `ambiguous`).

A suggestion is **high confidence** when its cluster has a name and the label's own silhouette is at least 0.25.

- Precision = high-confidence suggestions that match the expert ÷ all high-confidence suggestions. An ambiguous label counts against precision only if the model gives it a confident name.
- Coverage = high-confidence suggestions ÷ all labels in the pool.

## The exported report

**Download report (JSON)** contains:

- `generated_at`, `prototype`, `model_version`, `company`;
- `models[]`: per state, the mode, silhouette, precision, coverage, sample size and gates;
- `cases[]`: one per Desktop line, with the Desktop item, the first route and the current route, stage, proposal with rate check, model suggestion (and whether the employer saw it), evidence and decision;
- `gaps[]`, `readiness`, `dollar_tie_out`, `live`;
- `w2_preview[]`: boxes 18, 19 and 20, split into the Desktop and Online parts;
- `reconciliation` (after it has been run) and `audit` (the decision log).

**Download lines (CSV)** has one row per Desktop line. A cell that starts with `=`, `+`, `-` or `@` gets a leading apostrophe, so a spreadsheet will not run it as a formula.

The report is a review record. It is not a QuickBooks import file and not permission to run payroll.
