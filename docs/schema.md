# The database schema

*Generated from the schema the app runs (`npm run schema`). The SQL is in [schema.sql](schema.sql).*

## In one line

**Seven tables, one database per migration.** Four come from the business's Desktop file, two from Intuit's address and tax lookup, and one holds our result.

| Group | Tables | In plain words |
| --- | --- | --- |
| From the Desktop file | `company`, `employees`, `payroll_items`, `desktop_lines` | Who the business is, its people, its payroll items, and which person has which item |
| From Intuit's lookup | `addresses`, `taxes` | Which school district and city each address is in, and the exact local taxes, each with its unique **Law ID** |
| Our result | `results` | Where each Desktop line went, the Law ID of its Online tax, and who decided |

![The seven tables and how they link](../web/schema-diagram.svg)

## The Law ID

**Every tax has a Law ID, its unique identifier** (the primary key of `taxes`). A Desktop payroll item that QuickBooks already knows carries its tax's Law ID, for example *Columbus City Tax, Law ID 4140*, so it maps straight to the tax. An item the employer created carries **177 (or 0)**, which names no tax: *"Schl Dist W/H", Law ID 177*. Those are the lines the engine has to work out from the employee's address and the label. The migration's job, in one line: **turn every 177 into a real Law ID.**

The Law ID numbers in this demo (4120 Lancaster city, 4140 Columbus city, 5303 to 5503 for school districts) are demo numbers, not Intuit's.

## What a schema is

The schema is the blueprint of the database: the tables, their columns, the **primary key** that identifies each row, the **foreign keys** that link tables, and the **rules** the data must follow. Think of a workbook: each table is a sheet, the primary key is an ID column that never repeats, and a foreign key is a column that must match an ID on another sheet. A database refuses a row that breaks a rule.

## The story in four steps

1. **Desktop gives us lines.** `desktop_lines` has one row per employee per payroll item, for example *Maya Perez* has *"Lancaster Schools"*, Law ID 177. 177 means the employer created the item, so it names no tax.
2. **The address says which tax.** The employee's `home_address_id` leads to `addresses`, which holds the school district code (2305). That code matches `taxes.code`: *Lancaster City School District, Law ID 5305, 1.5%*. (A system item skips this step: its Law ID already names the tax.)
3. **The engine writes the result.** `results` gets one row per Desktop line: the route (local tax, not a tax, or an expert), the `law_id` of the tax it becomes in Online payroll, and who decided (a rule, the employer or an expert). So the line goes from Law ID 177 to Law ID 5305.
4. **Nothing in the Desktop file is changed.** Results live in their own table, so what Desktop said stays next to what happened.

The Data page query **Law ID before and after** runs exactly this join.

## Why one database per migration

A migration moves one business, so the database holds that one business and no table needs a company id. Moving another business means a new database with the same seven tables.

## Keys and rules

| Table | Primary key | Must match (foreign key) |
| --- | --- | --- |
| `company` | `company_id` | - |
| `employees` | `employee_id` | `work_address_id` → `addresses`<br>`home_address_id` → `addresses`<br>`new_home_address_id` → `addresses` |
| `payroll_items` | `item_id` | `law_id` → `taxes` for system items only (177 and 0 name no tax, so it is not enforced) |
| `desktop_lines` | `employee_id, item_id` | `employee_id` → `employees`<br>`item_id` → `payroll_items` |
| `addresses` | `address_id` | - |
| `taxes` | `law_id` | - |
| `results` | `employee_id, item_id` | `law_id` → `taxes`<br>`employee_id, item_id` → `desktop_lines` |

The Data page has five buttons that each try to break a rule. The database refuses every one, and nothing changes:

| Try to | The database answers |
| --- | --- |
| Add an employee who works at an address that does not exist | FOREIGN KEY constraint failed |
| Add the same employee twice | UNIQUE constraint failed: employees.employee_id |
| Set the move month to 13 | CHECK constraint failed: month_1_to_12 |
| Give a tax a rate of 150% | CHECK constraint failed: rate_0_to_100 |
| Record a Desktop line for an item the business never set up | FOREIGN KEY constraint failed |

## Every table

### 1. From the Desktop file

| Table | What it holds | Columns |
| --- | --- | --- |
| `company` | The business being moved: one row. | `company_id`, `name`, `plan`, `migration_month` |
| `employees` | The people: where they work, where they live, and where they moved to. | `employee_id`, `name`, `monthly_wages`, `work_site`, `work_address_id`, `home_address_id`, `new_home_address_id`, `moved_month`, `remote`, `hired_month`, `left_month` |
| `payroll_items` | Payroll items as set up in Desktop: the label as typed, and the Law ID (177 or 0 when the employer created it). | `item_id`, `label`, `law_id`, `item_type`, `tracking_type`, `rate_percent`, `annual_amount`, `agency`, `agency_account`, `deposit_frequency` |
| `desktop_lines` | Which employee has which payroll item: one row per Desktop local tax line. | `employee_id`, `item_id` |

### 2. From Intuit's lookup

| Table | What it holds | Columns |
| --- | --- | --- |
| `addresses` | Each address, with the school district and city the lookup places it in. | `address_id`, `street`, `city`, `state`, `zip`, `school_district`, `tax_city` |
| `taxes` | The local taxes Online payroll knows, each with its unique Law ID and rate. | `law_id`, `name`, `type`, `code`, `rate`, `agency` |

### 3. Our result

| Table | What it holds | Columns |
| --- | --- | --- |
| `results` | Where each Desktop line went, the Law ID of its Online tax, and who decided. | `employee_id`, `item_id`, `route`, `law_id`, `status`, `reason`, `decided_by`, `rule` |

## Questions you may be asked

- **What is a Law ID?** The unique identifier of each tax, the primary key of `taxes`. Desktop system items carry it, so they map directly; items the employer created carry 177 or 0 and need the address.
- **Why is payroll_items.law_id not a foreign key?** Because 177 and 0 are not taxes: they mean "the employer made this item". For system items it does match `taxes.law_id` (the dotted line in the diagram); `results.law_id` is a real foreign key, because every result names a real tax.
- **Why is the address in its own table?** Many employees share an address's district, and the lookup is Intuit's data. Each fact is stored once; employees point to it.
- **Why a separate desktop_lines table?** One employee has many payroll items and one item is on many employees (many-to-many). `desktop_lines` is the link table between them.
- **Why is results separate from desktop_lines?** The Desktop file is never edited. The result can change as people decide; the source cannot.
- **What if someone moved?** `employees` keeps the new address and the month (`new_home_address_id`, `moved_month`). The prototype keeps one move a year.
- **Where is the audit trail?** `results` says who decided each line and by which rule; the app's Log page keeps every step with its time.
- **Where does it run?** SQLite inside the web page (sql.js): no server, no key, rebuilt on every visit. In production the same tables would run on a server database such as PostgreSQL.

## How to show it

1. Sign in as the admin and open **Data**. Click any table for its columns and keys.
2. Open **Diagram of the tables**.
3. Click **Try all** under "The database checks the data itself".
4. Run **Items by Law ID**, **Law ID before and after** and **The address picks the tax**.
5. Click **Download the database** and open it in DB Browser for SQLite (free).
