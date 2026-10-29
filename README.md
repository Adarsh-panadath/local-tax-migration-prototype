# Local Tax Migration

A working prototype of the BRD v3 design for moving local payroll taxes from QuickBooks Desktop Payroll to QuickBooks Online Payroll. Built for SPJIMR BDA (INF501), Group Exam Case 19.

**Model suggests, person decides.** The prototype finds the right local tax for every employee from their addresses, groups free-text Desktop labels with clustering, and routes every Desktop line to one of three places. Nothing is switched on until the employer confirms it.

## Run it

Requires Node.js 20 or later. There are no dependencies to install and no API keys.

```sh
npm test        # 28 checks on the engine and workflow
npm run build   # copies web/ and data/ into dist/
npm start       # serves dist/ at http://localhost:3000
```

[Open the live demo](https://claude.ai/artifact/5VZAtVxjPoMrytwXFYLPxB). It is private to its owner until shared. Progress is saved in your browser only. Use **Reset demo** in the top bar to start again. In the hosted demo, the report is copied rather than downloaded.

## The design in one picture

```
Desktop payroll file
  │
  ├─ 1. Find the state ............ from the item label, else from the work address
  ├─ 2. List expected taxes ....... home address → school district, work address → city
  ├─ 3. Cluster custom labels ..... within each state; name each cluster after the closest defined entry
  ├─ 4. Route every line
  │      ├─ Local tax ............. matched to an exact jurisdiction, rate checked
  │      ├─ Not a tax ............. moves to deductions
  │      └─ Not in database ....... goes to an expert: map / not a tax / custom entry / stop
  └─ 5. Employer confirms ......... only then does the tax go live
        │
        ├─ Past payroll relabelled for W-2s (boxes 18–20)
        ├─ Gaps flagged both ways (expected but not withheld; withheld but not expected)
        └─ Reconcile after the first payroll and the first quarter
```

## Demo script (about five minutes)

The demo opens on **Fairfield Hardware Supply** (Premium plan, 8 employees, 17 Desktop lines).

1. **Analysis** shows the five steps, the Desktop items, and every employee's expected taxes. Ana Gomez moved house in June, so her school tax splits into two periods.
2. **Employer review**:
   - Click **Confirm 11 verified matches**.
   - Priya Shah was over-withheld by $207 (Desktop 1.5%, Pickerington 1.0%). Confirm at the official rate.
   - Move Sara Lee's union dues to deductions.
   - Add the Teays Valley school tax that nobody withheld for Raj Patel ($648 back tax estimate).
3. **Expert queue**:
   - Kevin O'Neil's "Wage Garnishment" is set up as a tax in Desktop, so it conflicts. Mark it as not a tax.
   - Mike Brown lives in Columbus City Schools, which has no school income tax. Stop that line.
   - Tom Reed's "Local Tax" had no address. Map it to Lancaster CSD.
4. Back on **Employer review**, the employer confirms the three expert decisions.
5. **Go live**: four checks pass. The dollar tie-out ($12,063.60 accounted for) and the W-2 boxes are projected. Click **Go live with confirmed taxes**.
6. **Reconcile**: run the first payroll and the first quarter. No expected tax is missing. Had Raj's gap been skipped, this screen would show a red flag.
7. **Model governance**: Ohio passes every gate (silhouette 0.54, precision 100%, 53 labels). Pennsylvania stays in shadow mode. Before going live, **Force shadow mode** for Ohio sends every custom line to an expert while system items still route.
8. **Decision log**: every action, with the JSON and CSV export.

The other two clients show other cases. **Hocking Valley Dental** is on the Core plan, so it pays and files itself, and a missing account number blocks go-live. **Keystone Freight** has a Pennsylvania worker whose lines go to an expert because Pennsylvania is in shadow mode.

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
| `web/engine/cluster.mjs` | Average-linkage clustering, silhouette, naming clusters |
| `web/engine/analysis.mjs` | Expected taxes, rollout gates, routing, rate checks, gaps |
| `web/engine/workflow.mjs` | Decisions, expert actions, go-live checks, dollar tie-out, W-2, reconciliation |
| `web/report.mjs` | JSON report and CSV export |
| `web/app.mjs`, `web/styles.css` | The eight-screen app |
| `data/` | Catalog, address lookup, three companies, expert-labelled label pool |
| `tests/engine.test.mjs` | 28 checks |
| `docs/` | Design decisions and the data contract |

See [design decisions](docs/design-decisions.md) and the [data contract](docs/data-contract.md).
