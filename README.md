# Local Tax Migration

A working prototype of the BRD v3 design for moving local payroll taxes from QuickBooks Desktop Payroll to QuickBooks Online Payroll. Built for SPJIMR BDA (INF501), Group Exam Case 19.

**Model suggests, person decides.** The prototype finds the right local tax for every employee from their addresses, groups free-text Desktop labels with clustering, and routes every Desktop line to one of three places. Rules the employer approves settle most lines; people handle only the exceptions; nothing switches on until the employer confirms it.

## Open it

**Website: https://adarsh-panadath.github.io/local-tax-migration-prototype/**

Sign in with a demo account (no passwords). Progress is saved in your own browser only; **Reset** (two clicks) starts again.

To run it on your computer (Node.js 20 or later; no install step, no API keys):

```sh
npm test        # 131 checks: engine, every scenario, the database, scale and the ML Lab
npm run build   # copies web/ and data/ into dist/
npm start       # serves dist/ at http://localhost:3000
```

## Three people, one screen set each

| Sign in as | Their job | Screens |
| --- | --- | --- |
| **Business owner** (customer) | Move their own business, give the information only they have, confirm what is theirs | **Move** (start, check, summary), **To do** (with **Missing information**), **Go live** (with reconcile and W-2) |
| **Payroll tax expert** (Intuit) | Decide the lines the rules leave, one label at a time | **Queue** |
| **Admin** (Intuit) | Watch every business, keep the model safe and the data right | **Portfolio**, **Model** (gates and thresholds), **ML Lab**, **Engine**, **Data**, **Scenarios**, **Log** |

Each business runs its own move with the rules it approved; nobody runs automation for other people's businesses. Intuit's view across all of them is the admin's Portfolio, which only reads.

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

- **Customer data** (fictional): businesses, work sites, employees, their addresses, Desktop payroll items, and home addresses the employer added.
- **Tax reference** (real and public where it matters): states, Ohio school-district and city taxes, defined entries, the demo address lookup and the expert-labelled label pool.
- **Outcomes**: where every Desktop line ended up (route, stage, Online tax, decided by which rule or person) and the decision log.

The admin's **Data** page shows every table with its row count, runs read-only SQL queries (with examples), and accepts a **Desktop file as CSV**: download the template, upload it, and the new company goes through the same file checks and engine as the demo clients. A file with missing columns or an unknown work site is refused with the reason; a home address the lookup has never seen goes to an expert. Uploads stay in your browser. See [the data contract](docs/data-contract.md) for the columns.

Customer payroll data stays fictional on purpose: real payroll files hold social security numbers and wages. Real companies demo the same way: invented people, real tax rules.

## The demo data

**66 businesses, 11,330 employees, 20,269 Desktop local tax lines.**

- **60 generated businesses**, 100 to 280 employees each, made from a fixed seed so every visit sees the same data. Names, people and labels are synthetic; the towns, ZIP codes, school districts and rates are real. Each has its own mix of messy data: missing or unplaceable home addresses, moves, wrong rates, items nobody set up, ambiguous labels. **Buckeye Supply Co.** (152 employees) is the default.
- **6 story clients**, small and hand-made, one BRD case each:

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
| **Six story clients** | **67 of 78 (86%)** | **12** |
| Buckeye Supply Co. (152 employees) | 313 of 318 (98%) | 3 home addresses (employer), 2 "Other Tax" lines (expert) |
| **All 66 businesses** | **20,413 of 21,125 (96.6%)** | **714**: 609 with an expert, 105 with employers |

Most of what is left at scale is one kind: an unclear label on a Desktop item that many employees share. The expert decides what such a label means once, and each employee's address picks the exact tax (see the demo script).

## Missing information

A missing or unplaceable home address is a fact only the employer has, so it waits for the employer, not an expert. The move summary shows **Add address** next to it, and the owner's To do lists it under **Missing information**. Saving an address writes it to the database, the engine checks that employee's lines again, and the rules settle what they can. An address the lookup has never seen is kept, and the line stays with an expert. Missing agency account numbers are listed there too.

## Proving the clustering: the ML Lab

The admin's **ML Lab** answers "does the clustering work beyond 53 labels?" with a test anyone can rerun:

1. Make 1,200 Desktop-style labels with known answers (600 or 2,400 on request; any seed).
2. Hold back 20%. Fit clusters on the rest with the engine's own code; no answers are used to fit.
3. Score the held-back labels exactly as the engine scores a new business's labels, and grade them.
4. Compare with simple word matching, which uses the same clean-up.

It shows the silhouette for every k with the 0.5 gate, every label on a 2D map, the confusion matrix, every wrong answer, and the clusters with their purity. With seed 2026 the model is right on 98.4% of its suggestions and suggests for 78.8% of labels; word matching is right on 98.2% and suggests for 90.8%. The silhouette is 0.462, below the gate, so on a set this messy the state would stay in shadow mode. The screen states these numbers and does not claim a winner: across seeds neither method wins every time. What clustering adds is grouping hundreds of spellings into a few dozen families an expert names once, and a confidence that says when to defer.

## Demo script (about six minutes)

1. **Sign in as the business owner** of Buckeye Supply Co. (152 employees). **Move**: Get started; the check says 313 of 318 items settle by rule, 3 need an address from the employer and 2 need an expert. Click **Move to Online payroll**.
2. On the summary, click **Add address** next to Gabriel Bell. On To do, click **Fill a demo address**, then **Save**: the engine checks his line again and the rules settle it. (Type an address the lookup does not know, and the line stays with an expert.)
3. **Sign in as the payroll tax expert.** Buckeye's queue has two "Other Tax" lines. Then pick **Licking Pharmacy**: one unclear label is open on 151 lines; decide what it means once and every employee's address picks the exact tax.
4. **Sign in as the admin**:
   - **Portfolio**: 66 businesses, 11,330 employees, 96.6% settled by rule, and what is left by reason.
   - **ML Lab**: 1,200 labels, 240 held back, precision and coverage against word matching, and the gate that keeps this messier set in shadow mode.
   - **Model**: Ohio passes every gate on the demo pool (silhouette 0.53, precision 100%, 53 labels). Set the silhouette threshold to 0.53 and Ohio drops to shadow mode (its score is 0.528).
   - **Data**: run "Added addresses" to see the address saved in step 2; download the template and upload it as a new business.
   - **Scenarios**: 76 of 76 pass; each row opens the case.

The story clients show single cases in detail. For example, Fairfield Hardware Supply settles 16 of 18 by rule; the expert marks Kevin O'Neil's garnishment as not a tax and maps Tom Reed's "Local Tax" to Lancaster CSD; the rules then pass the four go-live checks ($12,063.60 tie-out), go live and reconcile.

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
| Clustering, silhouette, precision gates | Implemented and tested; the gates use a 53-label pool written for this demo |
| ML Lab | Real computation with the engine's code, on 1,200 synthetic labels written from real label patterns |
| Generated businesses | Synthetic, from a fixed seed; real towns, ZIP codes, districts and rates |
| Address lookup | A hand-made table of fictional addresses mapped to real districts. In production this is Intuit's tax applicability service |
| Database | Real SQLite, in the browser; rebuilt from the demo files on each visit |
| Sign-in | Demo accounts without passwords |
| Businesses, employees, wages, account numbers | Fictional |
| Copying employees, pay items and totals in the Move step | Simulated; the local tax checks are real |
| Which taxes QuickBooks pays and files | A demo assumption, not an Intuit statement |
| Connection to QuickBooks | None |

This prototype is not affiliated with Intuit and is not tax advice. Synthetic labels are not real customer labels: the ML Lab shows the method and how the gates react, not production accuracy, which needs real Desktop files labelled by experts.

## Files

| Path | What it does |
| --- | --- |
| `web/engine/text.mjs` | Label clean-up (abbreviations, place names) and TF-IDF vectors |
| `web/engine/cluster.mjs` | Average-linkage clustering, silhouette, naming clusters, scoring a new label |
| `web/engine/analysis.mjs` | File checks, expected taxes, rollout gates, routing, rate checks, gaps |
| `web/engine/workflow.mjs` | Decisions, automation rules, go-live checks, dollar tie-out, W-2, reconciliation |
| `web/db.mjs` | The database: schema, loading, reading the engine's input with SQL, queries, CSV import, added addresses |
| `web/generate.mjs` | The 60 generated businesses and the ML Lab's labelled set, from a fixed seed |
| `web/mllab.mjs` | The ML Lab: hold-out split, fit, scoring, baseline, confusion matrix, 2D map |
| `web/vendor/` | sql.js 1.14.2 (SQLite in WebAssembly, MIT licence) |
| `web/scenarios.mjs` | The 76 scenarios and their live checks |
| `web/report.mjs` | JSON report and CSV export |
| `web/app.mjs`, `web/styles.css` | The app |
| `data/` | Catalog, address lookup, six companies, expert-labelled label pool |
| `tests/` | Engine and workflow, every scenario plus exact boundaries, the database, and scale (generated data, added addresses, ML Lab) |
| `.github/workflows/pages.yml` | Tests, builds and republishes the website whenever `main` changes |
| `docs/` | Design decisions and the data contract |
