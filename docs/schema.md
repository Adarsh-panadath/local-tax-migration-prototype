# The database schema

*This file is generated from the schema the app runs (`npm run schema`). The SQL is in [schema.sql](schema.sql).*

## What a schema is

The schema is the blueprint of the database: which tables exist, which columns each one has and their types, the **primary key** that identifies each row, the **foreign keys** that link tables, and the **rules** the data must follow. The data is the rows; the schema is the structure that keeps them correct.

Think of a workbook: each table is a sheet, the columns are its headings, the primary key is an ID column that never repeats, a foreign key is a column that must match an ID on another sheet, and a rule is data validation ("month must be 1 to 12"). The difference: a database refuses a row that breaks a rule, instead of just highlighting it.

## Where it runs

The prototype uses **SQLite** inside the web page (sql.js, compiled to WebAssembly), so it needs no server, account or key. It is rebuilt every time the page opens: from the demo files, the 60 generated businesses, and anything uploaded or corrected in that browser. Foreign keys and CHECK rules are switched on.

In production the same tables would live in a server database such as **PostgreSQL**, shared by every employer, expert and admin, with access limited to each person's own business.

## Four layers

The 22 tables are in four layers. Each layer has one owner, so it is clear who may change what.

| Layer | Owner | What it holds |
| --- | --- | --- |
| 1. Tax reference | Intuit | `states`, `taxes`, `no_tax_districts`, `state_place_names`, `defined_entries`, `defined_entry_states`, `addresses`, `label_pool` |
| 2. Source | Customer | `companies`, `worksites`, `payroll_items`, `employees`, `employee_addresses`, `desktop_lines`, `import_issues` |
| 3. Work | Engine and people | `expected_taxes`, `line_results`, `decisions`, `corrections`, `migrations` |
| 4. Audit | System | `audit_log`, `model_runs` |

Data moves one way: the Desktop file is copied into **Source** and never edited; the engine reads Source and the **Tax reference**, and writes what it finds to **Work**; people's decisions go to **Work** too; and **Audit** records who did what.

## The main tables

![The main tables and how they link](../web/schema-diagram.svg)

The full diagram of all 22 tables is in [schema.mmd](schema.mmd) (paste it into mermaid.live to draw it).

## One Desktop line, followed through the keys

1. `desktop_lines` holds one row per employee per payroll item: (`company_id`, `employee_id`, `item_id`).
2. `employee_id` points to `employees`, and `employee_addresses` gives that person's home address for each part of the year.
3. The address's `school_district` code in `addresses` is the same code as a school-district tax in `taxes`. That is how **the address decides which exact tax applies**; the Desktop label only says what kind of tax it is.
4. `expected_taxes` lists what the addresses say each person owes. A row with `gap = 1` is owed, but no Desktop line withholds it.
5. `line_results` says where the line stands: its route (local tax, not a tax, or an expert), why, and who settled it. `decisions` holds every decision, one row each.

The Data page's example query **One line across the keys** runs exactly this join.

## Design choices

- **One fact in one place (normalisation).** A tax's rate is stored once, in `taxes`; everything else points to it by `tax_id`. Change it once and it is right everywhere.
- **Addresses have their own table, with a start month,** because people move during the year. A move is a second row in `employee_addresses`.
- **The Desktop file is never edited.** An address the employer adds goes to `corrections`, so you can always show what Desktop said next to what the employer fixed.
- **Nothing in the file is lost.** A row that breaks a key (an item that does not exist, the same item twice, an address nobody knows) goes to `import_issues` instead of being dropped, and the engine reports it.
- **Every decision is a row** in `decisions`, with who decided (a rule, the employer or an expert), what and when. Together with `audit_log` this is the audit trail.
- **Keys that combine columns.** An employee ID is only unique inside one business, so the key of `employees` is (`company_id`, `employee_id`).

## Rules the database enforces

29 foreign keys and 31 CHECK rules, plus a primary key on every table. For example: a move month must be 1 to 12, a rate 0 to 100%, wages not negative, a route one of five values, and a customer-typed address must name its business.

The Data page has five buttons that each try to break one rule. The database refuses every one with its own error message, inside a transaction that is rolled back, so nothing changes:

| Try to | The database answers |
| --- | --- |
| Add an employee to a business that does not exist | FOREIGN KEY constraint failed |
| Add the same employee twice | UNIQUE constraint failed: employees.company_id, employees.employee_id |
| Set a move month of 13 | CHECK constraint failed: month_1_to_12 |
| Give a tax a rate of 150% | CHECK constraint failed: rate_0_to_100 |
| Record a Desktop line for an item the business never set up | FOREIGN KEY constraint failed |

## Every table

### 1. Tax reference (Intuit)

The same for every business. Ohio codes and rates are real; the address lookup stands in for Intuit's tax service.

| Table | What it holds | Primary key | Foreign keys | Rules |
| --- | --- | --- | --- | --- |
| `states` | A state, and whether migration is switched on there. | `state_code` | - | `rollout IN ('enabled', 'not_yet_enabled')` |
| `taxes` | Each local tax Online payroll knows: its rate, what it is based on and the agency. | `tax_id` | `state_code` → `states` | `type IN ('school_district', 'municipal', 'earned_income', 'local_services')`<br>`rate BETWEEN 0 AND 100`<br>`basis IN ('home', 'work', 'higher')`<br>`qb_pays_and_files IN (0, 1)` |
| `no_tax_districts` | School districts with no income tax, such as Columbus City Schools. | `state_code, name` | `state_code` → `states` | - |
| `state_place_names` | Place names taken out of labels before clustering, so "Lancaster SD" and "Bremen SD" look alike. | `state_code, place_name` | `state_code` → `states` | - |
| `defined_entries` | The names a label cluster can take: a kind of tax, or a known non-tax item like union dues. | `entry_id` | - | `kind IN ('tax', 'non_tax')`<br>`kind = 'non_tax' OR tax_type IS NOT NULL` |
| `defined_entry_states` | Which states each defined entry applies in. | `entry_id, state_code` | `state_code` → `states`<br>`entry_id` → `defined_entries` | - |
| `addresses` | Every street address, from Intuit's address lookup or typed by an employer, with its school district and city. | `address_id` | `company_id` → `companies` | `source IN ('lookup', 'customer')`<br>`(source = 'customer') = (company_id IS NOT NULL)` |
| `label_pool` | Desktop labels an expert has already classified; the clustering gates are measured on them. | `label_id` | `state_code` → `states` | - |

### 2. Source (Customer)

The Desktop file, copied in and never edited. Fictional people.

| Table | What it holds | Primary key | Foreign keys | Rules |
| --- | --- | --- | --- | --- |
| `companies` | One row per business moving to Online payroll. | `company_id` | - | `plan IN ('Core', 'Premium', 'Elite')`<br>`migration_month BETWEEN 1 AND 12`<br>`source IN ('demo', 'generated', 'upload')` |
| `worksites` | Where each business's people work. | `company_id, site_id` | `address_id` → `addresses`<br>`company_id` → `companies` | - |
| `payroll_items` | Payroll items as set up in Desktop, with the label exactly as someone typed it. | `company_id, item_id` | `system_tax_id` → `taxes`<br>`company_id` → `companies` | `origin IN ('custom', 'system')`<br>`calc_kind IN ('percent', 'flat_annual')`<br>`calc_rate BETWEEN 0 AND 100`<br>`calc_amount >= 0` |
| `employees` | The people on each payroll. | `company_id, employee_id` | `company_id, site_id` → `worksites`<br>`company_id` → `companies` | `monthly_wages >= 0`<br>`remote IN (0, 1)`<br>`hired_month BETWEEN 1 AND 12`<br>`left_month BETWEEN 1 AND 12` |
| `employee_addresses` | Home addresses over the year; a move adds a row from the month it starts. | `company_id, employee_id, from_month` | `company_id, employee_id` → `employees`<br>`address_id` → `addresses` | `from_month BETWEEN 1 AND 12` |
| `desktop_lines` | One row per employee per payroll item: a Desktop local tax line. | `company_id, employee_id, item_id` | `company_id, item_id` → `payroll_items`<br>`company_id, employee_id` → `employees` | - |
| `import_issues` | Rows in a Desktop file that break a key, kept so nothing is lost; the engine reports each one. | `issue_id` | `company_id, employee_id` → `employees` | `kind IN ('unknown_item', 'repeated_item', 'unknown_address')` |

### 3. Work (Engine and people)

What the engine found and what people decided.

| Table | What it holds | Primary key | Foreign keys | Rules |
| --- | --- | --- | --- | --- |
| `expected_taxes` | What each employee's addresses say they owe. gap = 1 means owed, but no Desktop line withholds it. | `company_id, employee_id, tax_id` | `company_id, employee_id` → `employees`<br>`tax_id` → `taxes` | `required IN (0, 1)`<br>`gap IN (0, 1)` |
| `line_results` | Where each Desktop line stands now: its route, why, and who settled it. | `company_id, employee_id, item_id` | `company_id, employee_id, item_id` → `desktop_lines` | `route IN ('local_tax', 'not_a_tax', 'not_in_database', 'custom_entry', 'stop')`<br>`stage IN ('awaiting_employer', 'with_expert', 'confirmed', 'moved_to_deduction', 'employer_managed', 'stopped')`<br>`decided_by IN ('rule', 'employer', 'expert')` |
| `decisions` | Every decision, one row each: by a rule, the employer or an expert. | `decision_id` | `company_id, employee_id, item_id` → `desktop_lines`<br>`company_id, employee_id` → `employees`<br>`tax_id` → `taxes` | `decided_by IN ('rule', 'employer', 'expert')` |
| `corrections` | Home addresses the employer added, and whether the lookup could place them. | `correction_id` | `company_id, employee_id` → `employees`<br>`address_id` → `addresses` | `found_in_lookup IN (0, 1)` |
| `migrations` | One row per business: how far its move has got. | `company_id` | `company_id` → `companies` | `status IN ('not_moved', 'moved', 'live', 'reconciled')` |

### 4. Audit (System)

Who did what and when, and how the label model scored.

| Table | What it holds | Primary key | Foreign keys | Rules |
| --- | --- | --- | --- | --- |
| `audit_log` | Who did what and when. | `log_id` | `company_id` → `companies` | - |
| `model_runs` | The label model per state: its scores, and whether its suggestions are shown. | `state_code, model_version` | `state_code` → `states` | `mode IN ('assisted', 'shadow')` |

## How to show it

1. Sign in as the admin and open **Data**. The schema shows the four layers; click any table for its columns, keys, rules, the tables it links to and its CREATE statement.
2. Open **Diagram of the main tables**.
3. Click **Try all** under "The database checks the data itself".
4. Run **One line across the keys** in "Ask the data".
5. Click **Download the database** and open the file in DB Browser for SQLite (free), or any SQLite tool: the same tables, keys and data.

## Limits, said plainly

- Each visitor gets their own copy, rebuilt on every visit. Decisions are kept in the browser and written into the work tables; in production the server database would be the only copy.
- Customer data is fictional. The Ohio rates and districts are real; the address lookup is a stand-in for Intuit's tax service.
- A real system would also need access control per business, encryption of pay and address data, and backups.
