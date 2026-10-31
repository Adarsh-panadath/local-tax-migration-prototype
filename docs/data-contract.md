# Data contract

All files are in `data/`. Companies, people, street addresses, wages and account numbers are fictional. Ohio school-district codes and rates and the Lancaster and Columbus city rates are real (see `catalog.json` → `metadata.sources`).

## catalog.json: what Online payroll knows

- `states.<ST>`: `name`, `rollout` (`enabled` or `not_yet_enabled`), `taxes[]`, `no_tax_districts[]`, `place_names[]`.
- Tax: `tax_id`, `type` (`school_district` or `municipal`), `code` (the Ohio district number for school districts), `name`, `place`, `rate` (percent), `base`, `basis` (`home` or `work`), `agency`, `qb_pays_and_files`.
- `no_tax_districts[]`: districts with no school income tax, such as Columbus City Schools (`name`, `place`, `note`).
- `place_names[]`: removed from labels before clustering, so "Lancaster SD" and "Bremen SD" look alike.
- `defined_entries[]`: the names a cluster can take: `entry_id`, `kind` (`tax` or `non_tax`), `tax_type` for taxes, `states`, `label`, and `text` (the words the cluster is compared with).

## geocoder.json: stands in for an address lookup

- `addresses[]`: `address_id`, `line1`, `city`, `state`, `zip`, `school_district` (an Ohio district code, `NO-TAX-...`, `UNRESOLVED` for an address the lookup cannot place, or null), `municipality`.

A home city that differs from the work city gives an optional tax (courtesy withholding), not a required one.

## companies.json: what came across from Desktop

- Company: `company_id`, `name`, `plan` (`Core`, `Premium` or `Elite`), `migration_month` (1 to 12; 10 = October), `description` (optional, shown on the analysis page), `worksites[]` (`site_id`, `name`, `address_id`), `items[]`, `employees[]`.
- Item:
  - `item_id`, `label` (free text);
  - `law_id` (177 or 0 = employer-created custom item);
  - `origin` (`custom` or `system`), plus `system_tax_id` for system items;
  - `item_type`, `tracking_type` (`None` means Desktop treats it as an after-tax deduction);
  - `calc` (`{kind: "percent", rate}` or `{kind: "flat_annual", amount}`);
  - `agency`, `agency_account`, `deposit_frequency`.
- Employee: `employee_id`, `name`, `site_id`, `monthly_wages`, `addresses[]` (`{address_id, from_month}`; empty means no address on file), `items[]` (item ids withheld in Desktop). Optional: `hired_month` and `left_month` (first and last month on the payroll), `remote` (works from home).

## File checks

`analyseCompany` checks the company first (`checkCompanyData` in `web/engine/analysis.mjs`).

- **Errors** stop the analysis with a `DataError` listing every problem: migration month not 1 to 12; no work site, a duplicate one, or one whose address is unknown; duplicate employee or item IDs; an employee on a work site that does not exist; wages below $0; a rate outside 0% to 100% or a flat amount below $0; a system item whose tax is not in the catalog; a join month after the leave month; an address start month outside 1 to 12, or two addresses starting in the same month.
- **Warnings** are cleaned up and returned as `analysis.dataIssues`: an unknown home address (kept as "not in the lookup", so dependent lines go to an expert), an item reference that does not exist (left out), an item listed twice for one person (counted once), an item with no name (treated as blank), a state the catalog does not cover, and a company with no employees.

## label-pool.json: expert answers for shadow mode

- `pools.<ST>[]`: `label`, `expert_label` (`school_district`, `municipal`, `non_tax:<entry_id>`, or `ambiguous`).

A suggestion is **high confidence** when its cluster has a name and the label's own silhouette is at least 0.25.

- Precision = high-confidence suggestions that match the expert ÷ all high-confidence suggestions. An ambiguous label counts against precision only if the model gives it a confident name.
- Coverage = high-confidence suggestions ÷ all labels in the pool.

## The exported report

**Download report (JSON)** contains:

- `generated_at`, `prototype`, `model_version`, `company`, `data_issues` (the file warnings);
- `models[]`: per state, the mode, silhouette, precision, coverage, sample size and gates;
- `cases[]`: one per Desktop line, with the Desktop item, the first route and the current route, stage, proposal with rate check, model suggestion (and whether the employer saw it), evidence and decision;
- `gaps[]`, `readiness`, `dollar_tie_out`, `live`;
- `w2_preview[]`: boxes 18, 19 and 20, split into the Desktop and Online parts;
- `reconciliation` (after it has been run) and `audit` (the decision log).

**Download lines (CSV)** has one row per Desktop line. A cell that starts with `=`, `+`, `-` or `@` gets a leading apostrophe, so a spreadsheet will not run it as a formula.

The report is a review record. It is not a QuickBooks import file and not permission to run payroll.

## The database

When the page opens, the files above are loaded into a SQLite database in the browser (sql.js, `web/vendor/`), and the engine's input is read back from it with SQL (`web/db.mjs`). A test (`tests/db.test.mjs`) checks that what comes back equals the files exactly and that the engine gives the same answers either way. If a viewer blocks WebAssembly, the app reads the files directly and the Data page says so.

| Group | Tables |
| --- | --- |
| Customer data | `companies` (`source`: `demo`, `generated` or `upload`), `worksites`, `employees`, `employee_addresses`, `employee_items`, `desktop_items`, `customer_addresses` (addresses the lookup has never seen), `corrections` (home addresses the employer added) |
| Tax reference | `states`, `taxes`, `no_tax_districts`, `state_place_names`, `defined_entries`, `defined_entry_states`, `address_lookup`, `label_pool` |
| Outcomes | `line_outcomes` (every Desktop line: route, stage, Online tax, decided by, rule), `decision_log` |

The Data page runs one read-only `SELECT` at a time.

## Generated businesses

`web/generate.mjs` makes 60 more businesses from a fixed seed (2026) on every visit, so every visitor sees the same data. They are synthetic: names, people, street addresses, wages and Desktop labels are made up. Each has 100 to 280 employees; the first, **Buckeye Supply Co.** (`G-001`), has 152 and is the default business.

- Towns are real Ohio places (Lancaster, Pickerington, Columbus, Carroll, Bremen, Baltimore, Millersport, Ashville) with their real ZIP codes, school districts and city taxes. People live where commuters to each work site plausibly live.
- Desktop labels are written the way people type them: abbreviations, typos, place names, upper and lower case.
- Each business has its own mix of problems: missing home addresses, addresses the lookup cannot place, people who moved, wrong rates, Columbus residents with a school tax withheld, items nobody set up, ambiguous labels, union dues, garnishments, joiners and leavers.
- Their addresses join the demo lookup (`address_lookup`, `G-A00001` onward).

A test (`tests/scale.test.mjs`) checks that the generator gives the same businesses every time, that each has at least 100 employees, that every one goes through the engine, and that they round-trip through the database exactly.

## Addresses the employer adds

A line that needs a home address (`no_address`, or `address_unresolved` when the lookup cannot place it) waits for the employer: the owner's **To do** lists it under **Missing information**. Saving an address:

1. Looks it up by street and ZIP in the address lookup.
2. Writes it to the database: `employee_addresses` (for the whole year), `customer_addresses` if the lookup has never seen it, and a row in `corrections` (`company_id`, `employee_id`, `value`, `address_id`, `found_in_lookup`, `at`).
3. Reads that business back from the database, and the engine checks its lines again. If the business has moved, the employer's rules run and settle what they can.

An address the lookup knows settles the line by rule; one it has never seen is kept, and the line stays with an expert as `address_unresolved`. Added addresses are kept in the browser and applied again whenever the database is rebuilt.

## ML Lab

`web/mllab.mjs` grades the label clustering on a larger labelled set (`labelSet` in `web/generate.mjs`: 1,200 labels by default, 600 or 2,400 on request).

- 80% of the labels fit the clusters with the engine's own `clusterLabels` (k from 2 to 30, picked by silhouette). No answers are used to fit.
- The other 20% are scored with the engine's own `assignLabel`, exactly as a new business's labels are: nearest cluster, its name, and the label's silhouette. Below 0.25 the label goes to an expert.
- **Precision** = right suggestions ÷ suggestions. **Coverage** = suggestions ÷ held-back labels. An ambiguous label sent to an expert counts as right.
- The baseline uses the same clean-up and then picks the catalogue entry that shares the most words; a tie or no shared word goes to an expert.
- The map is kernel PCA on the same cosine similarity.

## Uploading a Desktop file (CSV)

One file is one company, with one row per employee per payroll item (an employee with no local items has one row with the item columns blank). The Data page has a template: a small fictional company whose addresses are all in the demo lookup.

| Column | Required | Notes |
| --- | --- | --- |
| `company_name`, `plan`, `migration_month` | Yes | Same on every row |
| `employee_id`, `employee_name`, `monthly_wages` | Yes | |
| `home_address`, `home_city`, `home_state`, `home_zip` | No | Blank means no address on file |
| `work_site`, `work_address`, `work_state`, `work_zip` | Yes | `work_city` optional |
| `remote` | No | `yes` if the employee works from home |
| `item_label`, `law_id`, `item_type`, `tracking_type`, `rate_percent`, `agency` | No | `law_id` defaults to 177 (custom) |
| `agency_account`, `deposit_frequency` | No | |

Addresses are matched to `geocoder.json` on street line and ZIP. A home address it has never seen is kept as customer data and its lines go to an expert ("address not placed"); a work address it has never seen stops the file. Rows with the same label, type, tracking, rate and agency become one Desktop item. After the format checks, the engine's own file checks run exactly as for the demo companies. Moves within the year cannot be expressed in the CSV yet.
