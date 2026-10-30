# Local Tax Migration

A working prototype of the BRD v3 design for moving local payroll taxes from QuickBooks Desktop Payroll to QuickBooks Online Payroll. Built for SPJIMR BDA (INF501), Group Exam Case 19.

**Model suggests, person decides.** The prototype finds the right local tax for every employee from their addresses, groups free-text Desktop labels with clustering, and routes every Desktop line to one of three places. Nothing is switched on until the employer confirms it.

## Open it

**Website: https://adarsh-panadath.github.io/local-tax-migration-prototype/**

The site is public; no sign-in is needed. Progress is saved in your own browser only. Use **Reset demo** in the top bar to start again.

To run it on your computer (Node.js 20 or later; no dependencies, no API keys):

```sh
npm test        # 108 checks, including every scenario on the website
npm run build   # copies web/ and data/ into dist/
npm start       # serves dist/ at http://localhost:3000
```

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
  └─ 5. Employer confirms ......... only then does the tax go live
        │
        ├─ Past payroll relabelled for W-2s (boxes 18–20)
        ├─ Gaps flagged both ways (expected but not withheld; withheld but not owed)
        └─ Reconcile after the first payroll and the first quarter
```

## Six demo clients

| Client | What it shows |
| --- | --- |
| Fairfield Hardware Supply | The main demo: one of each route, a move, a gap, an over-withheld rate |
| Hocking Valley Dental | Core plan (the employer pays and files); a missing account number blocks go-live |
| Keystone Freight | Two states; Pennsylvania is still in shadow mode |
| Hocking Hills Fabrication | Boundary cases: moves in the migration month, remote work, duplicates, joiners and leavers, conflicting labels |
| Lakeview Bakery | Moves in January, so there is no Desktop history to relabel |
| Ridgeview Print Shop | A messy Desktop file: blank item name, unknown address, missing and duplicate items, 0% rate, a move to another state |

## Scenario coverage

The **Scenario coverage** page lists 69 scenarios, grouped by BRD step, and runs a live check for each one when it opens. Every row links to the client and employee it concerns. The same checks run in `npm test`.

| Group | Scenarios |
| --- | --- |
| Before step 1: check the Desktop file | 8 |
| Step 1: find the state | 5 |
| Step 2: list the expected taxes | 9 |
| Step 3: cluster custom labels, and the gates | 11 |
| Step 4: route every line | 15 |
| Gaps | 4 |
| Step 5: employer and expert decisions | 4 |
| Go-live checks | 4 |
| W-2 history | 3 |
| Reconcile | 3 |
| Joiners, leavers and the migration month | 3 |

Boundary values are tested exactly: a gate value equal to its threshold passes (silhouette 0.50, precision 98%, sample 40, label confidence 0.25), and a rate of 1.4999% against 1.5% counts as under-withheld. **Model governance → Try the gates** lets you change the thresholds and watch a state switch to shadow mode.

## The screens

The interface follows the team's Google Stitch mockup:

- **Top bar:** the client picker and the five migration steps as tabs.
- **Batch strip:** the batch status, model mode, progress and links to the oversight pages.
- **Review** and **Expert** are list-and-detail workspaces:
  - On the left is a searchable record list with filter chips.
  - On the right is the selected record. It shows the target tax and the next step, a checks banner, and a Desktop-versus-Online table. Below that come the supporting evidence (addresses and expected taxes), how the system decided, the model suggestion and the decision history. A sticky action bar sits at the bottom.
- **On a phone:** the list opens into the record, with a back link and the action bar fixed at the bottom.

## Demo script (about five minutes)

The demo opens on **Fairfield Hardware Supply** (Premium plan, 8 employees, 17 Desktop lines).

1. **Analysis** shows the five steps, the Desktop items, and every employee's expected taxes. Ana Gomez moved house in June, so her school tax splits into two periods.
2. **Review** (employer):
   - Click **Confirm 11 verified matches** under the list.
   - Select Priya Shah's "School Tax". She was over-withheld by $207 (Desktop 1.5%, Pickerington 1.0%). Click **Confirm at official rate**.
   - Select Sara Lee's "Union Dues" and click **Move to deductions**.
   - Select Raj Patel's Teays Valley line: nobody withheld it ($648 back tax estimate). Click **Add from first cloud payroll**.
3. **Expert**:
   - Kevin O'Neil's "Wage Garnishment" is set up as a tax in Desktop, so it conflicts. Mark it as not a tax.
   - Mike Brown lives in Columbus City Schools, which has no school income tax. Click **Not owed: stop withholding**.
   - Tom Reed's "Local Tax" had no address. Map it to Lancaster CSD.
4. Back on **Review**, the employer confirms the three expert decisions.
5. **Go live**: four checks pass. The dollar tie-out ($12,063.60 accounted for) and the W-2 boxes are projected. Click **Go live with confirmed taxes**.
6. **Reconcile**: run the first payroll and the first quarter. No expected tax is missing. Had Raj's gap been skipped, this screen would show a red flag.
7. **Model governance**: Ohio passes every gate (silhouette 0.53, precision 100%, 53 labels). Pennsylvania stays in shadow mode. In **Try the gates**, set the silhouette threshold to 0.53 and Ohio drops to shadow mode (its score is 0.528); set it to 0.52 and suggestions come back.
8. **Scenario coverage**: 69 of 69 pass. Open any row to see the case in the app.
9. **Decision log**: every action, with the JSON and CSV export.

## What is real and what is not

| Part | Status |
| --- | --- |
| Ohio school-district codes, names, rates and tax bases | Real, from the Ohio Department of Taxation 2026 list (a small subset) |
| Lancaster 2.3% and Columbus 2.5% city rates | Real, from the city websites |
| Clustering, silhouette, precision gates | Implemented and tested; precision is measured on a 53-label expert-labelled pool written for this demo |
| Address lookup | A hand-made table of fictional addresses mapped to real districts. In production this is Intuit's tax applicability API |
| Companies, employees, wages, account numbers | Fictional |
| Which taxes QuickBooks pays and files | A demo assumption, not an Intuit statement |
| Connection to QuickBooks | None. The export is a review record, not an import file |

This prototype is not affiliated with Intuit and is not tax advice. A 53-label pool is far too small to prove production accuracy; the gates show how the BRD's rule works, not that the model is ready.

## Files

| Path | What it does |
| --- | --- |
| `web/engine/text.mjs` | Label clean-up (abbreviations, place names) and TF-IDF vectors |
| `web/engine/cluster.mjs` | Average-linkage clustering, silhouette, naming clusters, scoring a new label |
| `web/engine/analysis.mjs` | File checks, expected taxes, rollout gates, routing, rate checks, gaps |
| `web/engine/workflow.mjs` | Decisions, expert actions, go-live checks, dollar tie-out, W-2, reconciliation |
| `web/scenarios.mjs` | The 69 scenarios and their live checks |
| `web/report.mjs` | JSON report and CSV export |
| `web/app.mjs`, `web/styles.css` | The app |
| `data/` | Catalog, address lookup, six companies, expert-labelled label pool |
| `tests/` | `engine.test.mjs` (engine and workflow) and `scenarios.test.mjs` (every scenario plus exact boundaries) |
| `.github/workflows/pages.yml` | Tests, builds and republishes the website whenever `main` changes |
| `docs/` | Design decisions and the data contract |

See [design decisions](docs/design-decisions.md) and the [data contract](docs/data-contract.md).
