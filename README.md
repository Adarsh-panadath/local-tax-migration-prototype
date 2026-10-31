# Local Tax Migration

A working prototype of the BRD v3 design for moving local payroll taxes from QuickBooks Desktop Payroll to QuickBooks Online Payroll. Built for SPJIMR BDA (INF501), Group Exam Case 19.

**Model suggests, person decides.** The prototype finds the right local tax for every employee from their addresses, groups free-text Desktop labels with clustering, and routes every Desktop line to one of three places. Rules the employer approves settle most lines; people handle only the exceptions; nothing switches on until the employer confirms it.

## Open it

**Website: https://adarsh-panadath.github.io/local-tax-migration-prototype/**

Sign in with a demo account (no passwords). Progress is saved in your own browser only; **Reset** (two clicks) starts again.

To run it on your computer (Node.js 20 or later; no install step, no API keys):

```sh
npm test        # 125 checks: engine, every scenario, and the database
npm run build   # copies web/ and data/ into dist/
npm start       # serves dist/ at http://localhost:3000
```

## Four people, one screen set each

A real migration involves four different people, and each sees only what they need:

| Sign in as | Their job | Screens |
| --- | --- | --- |
| **Business owner** (customer) | Move their business and confirm what is theirs to confirm | **Move** (start, check, summary), **To do**, **Go live** (with reconcile and W-2) |
| **Accountant** (customer) | Move every client they look after | **Clients**, then the owner's screens for any client |
| **Payroll tax expert** (Intuit) | Decide the lines the rules leave | **Queue** |
| **Admin** (Intuit) | Keep the model safe and the data right | **Model** (gates and thresholds), **Engine** (what each step found), **Data**, **Scenarios**, **Log** |

The sign-in is a demo: in a real product customers would use their Intuit account and staff the company sign-in, and the role would decide the screens. A public static site cannot keep a password secret, so it does not pretend to.

## The design in one picture

```
Desktop payroll file
  │
  ├─ 0. Check the file ............ stop on broken data; clean up and report smaller problems
  ├─ 1. Find the state ............ from the item label, else the home address, else the work address
  ├─ 2. List expected taxes ....... home address → school district, work address → city
  ├─ 3. Cluster custom labels ..... per state; name each cluster after the closest defined entry
  ├─ 4. Route every line
  │      ├─ Local tax ............. matched to an exact jurisdiction, rate checked
  │      ├─ Not a tax ............. moves to deductions
  │      └─ Not in database ....... goes to an expert: map / not a tax / custom entry / stop
  └─ 5. Employer confirms ......... by approved rules, or by hand; only then does the tax go live
        │
        ├─ Past payroll relabelled for W-2s (boxes 18–20)
        ├─ Gaps flagged both ways (expected but not withheld; withheld but not owed)
        └─ Reconcile after the first payroll and the first quarter
```

## The database

The demo data lives in a **SQLite database inside the page** (sql.js, compiled to WebAssembly; no server, no account, no keys). It is rebuilt from the demo files on every visit, so every visitor has a private copy. The engine reads its input from the database with SQL, and a test checks that this equals the files exactly.

- **Customer data** (fictional): companies, work sites, employees, their addresses and Desktop payroll items.
- **Tax reference** (real and public where it matters): states, Ohio school-district and city taxes, defined entries, the demo address lookup and the expert-labelled label pool.
- **Outcomes**: where every Desktop line ended up (route, stage, Online tax, decided by which rule or person) and the decision log.

The admin's **Data** page shows every table with its row count, runs read-only SQL queries (with examples), and accepts a **Desktop file as CSV**: download the template, upload it, and the new company goes through the same file checks and engine as the demo clients. A file with missing columns or an unknown work site is refused with the reason; a home address the lookup has never seen goes to an expert. Uploads stay in your browser. See [the data contract](docs/data-contract.md) for the columns.

Customer payroll data stays fictional on purpose: real payroll files hold social security numbers and wages. Real companies demo the same way: invented people, real tax rules.

## Six demo clients

| Client | What it shows |
| --- | --- |
| Fairfield Hardware Supply | The main demo: one of each route, a move, a gap, an over-withheld rate |
| Hocking Valley Dental | Core plan (the employer pays and files); a missing account number blocks go-live |
| Keystone Freight | Two states; Pennsylvania is still in shadow mode |
| Hocking Hills Fabrication | Boundary cases: moves in the migration month, remote work, duplicates, joiners and leavers, conflicting labels |
| Lakeview Bakery | Moves in January, so there is no Desktop history to relabel |
| Ridgeview Print Shop | A messy Desktop file: blank item name, unknown address, missing and duplicate items, 0% rate, a move to another state |

## Automatic migration

The employer approves seven rules once, on the Move page's check step:

| Rule | What it settles |
| --- | --- |
| Confirm matches the address supports | Lines on the employee's expected list |
| Use the official rate when Desktop's rate is wrong | Over- or under-withholding, months withheld after a move (flagged for a correction) |
| Move after-tax deductions | Union dues and other non-tax items |
| Add expected taxes nobody withheld | Gaps, from the first cloud payroll (back tax flagged) |
| Stop taxes the address says are not owed | Duplicates, and taxes not owed at an address found in the lookup |
| Accept expert decisions | An expert's answer takes effect without a second click |
| Go live and reconcile when everything is settled | Only when nothing is left for a person and every check passes |

Only the cases the BRD reserves for people are left: a weak or missing label signal, conflicting evidence, a missing or unplaceable address, a label naming another state, a state in shadow mode, or a missing agency account number. After a person decides one, the rules run again and finish the rest.

| Client | Settled automatically | Left for a person |
| --- | --- | --- |
| Fairfield Hardware Supply | 16 of 18 (89%) | Tom Reed's "Local Tax" (weak signal), Kevin O'Neil's garnishment (conflict) |
| Hocking Valley Dental | 6 of 6 | The Lancaster account number |
| Keystone Freight | 2 of 4 | Two Pennsylvania lines (shadow mode) |
| Hocking Hills Fabrication | 30 of 35 | 5 exceptions |
| Lakeview Bakery | 4 of 4 | Nothing: live and reconciled |
| Ridgeview Print Shop | 9 of 11 | A blank item name, an unknown address |
| **All clients** | **67 of 78 (86%)** | **12** |

## Demo script (about five minutes)

1. **Sign in as the business owner** of Fairfield Hardware Supply. **Move**: Get started, then the check says 16 of 18 items settle by rule and names the two that stay for an expert. Click **Move to Online payroll**; the summary shows the exception report.
2. **Sign out, sign in as the payroll tax expert.** The queue has two lines: mark Kevin O'Neil's garnishment as not a tax, and map Tom Reed's "Local Tax" to Lancaster CSD.
3. The rules accept both, pass the four go-live checks ($12,063.60 tie-out), go live and reconcile. **Sign in as the owner again**: the summary says live; **Go live** shows 4 taxes, $3,428.70 for October to December, and the W-2 boxes.
4. **Sign in as the accountant**: **Run automation for every client** settles 86% across the six clients; the chart shows each client's share.
5. **Sign in as the admin**:
   - **Model**: Ohio passes every gate (silhouette 0.53, precision 100%, 53 labels); Pennsylvania stays in shadow mode. Set the silhouette threshold to 0.53 and Ohio drops to shadow mode (its score is 0.528).
   - **Data**: run "Who decided", download the template and upload it as a new client.
   - **Scenarios**: 76 of 76 pass; each row opens the case.

## Scenario coverage

The admin's **Scenarios** page lists 76 scenarios, grouped by BRD step, and runs a live check for each one. The same checks run in `npm test`, together with exact boundaries: a gate value equal to its threshold passes (silhouette 0.50, precision 98%, sample 40, label confidence 0.25), and a rate of 1.4999% against 1.5% counts as under-withheld.

## The screens

- Light grey page, white rounded cards, pill buttons and one emerald green. Colour has one meaning each: green is settled or ready, amber is waiting for the employer, blue is with an expert, red is a gap or a tax that is not owed.
- Wording never implies a decision nobody made: "Ready to confirm" (rule checks passed, still waiting), "Proposed for Online payroll", then "Confirmed by rule" or "Confirmed by the employer". Model output is labelled a suggestion.
- Records show the Desktop item and its Online destination, the next step, anything that needs checking, a Desktop-versus-Online table and the evidence. Explanations sit in folds ("How the system decided", "Model suggestion", "Decision history").
- Keyboard: a skip link, focus moves to what opens, and back to the next record after each action. On a phone, lists open into the record with the action bar at the bottom.

## What is real and what is not

| Part | Status |
| --- | --- |
| Ohio school-district codes, names, rates and tax bases | Real, from the Ohio Department of Taxation 2026 list (a small subset) |
| Lancaster 2.3% and Columbus 2.5% city rates | Real, from the city websites |
| Clustering, silhouette, precision gates | Implemented and tested; precision is measured on a 53-label pool written for this demo |
| Address lookup | A hand-made table of fictional addresses mapped to real districts. In production this is Intuit's tax applicability service |
| Database | Real SQLite, in the browser; rebuilt from the demo files on each visit |
| Sign-in | Demo accounts without passwords |
| Companies, employees, wages, account numbers | Fictional |
| Copying employees, pay items and totals in the Move step | Simulated; the local tax checks are real |
| Which taxes QuickBooks pays and files | A demo assumption, not an Intuit statement |
| Connection to QuickBooks | None |

This prototype is not affiliated with Intuit and is not tax advice. A 53-label pool is far too small to prove production accuracy; the gates show how the BRD's rule works, not that the model is ready.

## Files

| Path | What it does |
| --- | --- |
| `web/engine/text.mjs` | Label clean-up (abbreviations, place names) and TF-IDF vectors |
| `web/engine/cluster.mjs` | Average-linkage clustering, silhouette, naming clusters, scoring a new label |
| `web/engine/analysis.mjs` | File checks, expected taxes, rollout gates, routing, rate checks, gaps |
| `web/engine/workflow.mjs` | Decisions, automation rules, go-live checks, dollar tie-out, W-2, reconciliation |
| `web/db.mjs` | The database: schema, loading, reading the engine's input with SQL, queries, CSV import |
| `web/vendor/` | sql.js 1.14.2 (SQLite in WebAssembly, MIT licence) |
| `web/scenarios.mjs` | The 76 scenarios and their live checks |
| `web/report.mjs` | JSON report and CSV export |
| `web/app.mjs`, `web/styles.css` | The app |
| `data/` | Catalog, address lookup, six companies, expert-labelled label pool |
| `tests/` | Engine and workflow, every scenario plus exact boundaries, and the database |
| `.github/workflows/pages.yml` | Tests, builds and republishes the website whenever `main` changes |
| `docs/` | Design decisions and the data contract |
