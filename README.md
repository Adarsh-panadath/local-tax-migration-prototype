# Local Tax Migration

A working prototype of the BRD v3 design for moving local payroll taxes from QuickBooks Desktop Payroll to QuickBooks Online Payroll. Built for SPJIMR BDA (INF501), Group Exam Case 19.

**Model suggests, person decides.** The prototype finds the right local tax for every employee from their addresses, groups free-text Desktop labels with clustering, and routes every Desktop line to one of three places. Nothing is switched on until the employer confirms it.

## Open it

**Website: https://adarsh-panadath.github.io/local-tax-migration-prototype/**

The site is public; no sign-in is needed. Progress is saved in your own browser only. Use **Reset** in the top bar to start again (it asks for a second click, because it clears every client's decisions).

To run it on your computer (Node.js 20 or later; no dependencies, no API keys):

```sh
npm test        # 116 checks, including every scenario on the website
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

## Automatic migration

Most of the work runs by itself. The employer approves seven rules once (this is the "person decides" part of the BRD), and one click applies them to every line they cover:

| Rule | What it settles |
| --- | --- |
| Confirm matches the address supports | Lines on the employee's expected list |
| Use the official rate when Desktop's rate is wrong | Over- or under-withholding, months withheld after a move (flagged for a correction) |
| Move after-tax deductions | Union dues and other non-tax items |
| Add expected taxes nobody withheld | Gaps, from the first cloud payroll (back tax flagged) |
| Stop taxes the address says are not owed | Duplicates, and taxes not owed at an address found in the lookup |
| Accept expert decisions | An expert's answer takes effect without a second click |
| Go live and reconcile when everything is settled | Only when nothing is left for a person and every check passes |

Only the cases the BRD reserves for people are left: a weak or missing label signal, conflicting evidence, a missing or unplaceable address, a label naming another state, a state in shadow mode, or a missing agency account number. After a person decides one, automation re-runs and finishes the rest.

| Client | Settled automatically | Left for a person |
| --- | --- | --- |
| Fairfield Hardware Supply | 16 of 18 (89%) | Tom Reed's "Local Tax" (weak signal), Kevin O'Neil's garnishment (conflict) |
| Hocking Valley Dental | 6 of 6 | The Lancaster account number |
| Keystone Freight | 2 of 4 | Two Pennsylvania lines (shadow mode) |
| Hocking Hills Fabrication | 30 of 35 | 5 exceptions |
| Lakeview Bakery | 4 of 4 | Nothing: live and reconciled |
| Ridgeview Print Shop | 9 of 11 | A blank item name, an unknown address |
| **All clients** | **67 of 78 (86%)** | **12** |

Every automatic step is in the decision log with its rule, and anything can be undone. An undone decision stays with a person.

## Scenario coverage

The **Scenario coverage** page lists 76 scenarios, grouped by BRD step, and runs a live check for each one when it opens. Every row links to the client and employee it concerns. The same checks run in `npm test`.

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
| Automation | 7 |

Boundary values are tested exactly: a gate value equal to its threshold passes (silhouette 0.50, precision 98%, sample 40, label confidence 0.25), and a rate of 1.4999% against 1.5% counts as under-withheld. **Model governance → Try the gates** lets you change the thresholds and watch a state switch to shadow mode.

## The screens

The interface follows the team's Google Stitch mockup:

- **Top bar:** a deep-green band with the client picker and the five migration steps. A step shows a tick once nothing is left in it, so the tabs double as a progress tracker; amber counts show what is waiting.
- **Status line:** one count for the whole client: items settled out of Desktop lines plus expected taxes nobody withheld, then who holds the rest (the employer or an expert), the model mode and links to the oversight pages.
- **Review** and **Expert** are list-and-detail workspaces:
  - On the left is a searchable record list with filter chips, grouped by employee. Each row shows the Desktop item and where it is heading.
  - On the right is the selected record. It shows the target tax and the next step, a checks banner, and a Desktop-versus-Online table. Below that come the supporting evidence (addresses and expected taxes), how the system decided, the model suggestion and the decision history. A sticky action bar sits at the bottom.
- **On a phone:** the list opens into the record, with a back link and the action bar fixed at the bottom. The clients table becomes one block per client.

Colour always means the same thing: green is settled or ready, amber is waiting for the employer, blue is with an expert, red is a gap or a tax that is not owed.

Wording is chosen so that nothing looks decided before a person decides it:

| On screen | Meaning |
| --- | --- |
| Ready to confirm | The rule checks passed (on the expected list, rate equal). Still waiting for the employer. |
| Proposed for Online payroll | The system's proposal. Nothing is switched on. |
| Confirmed by rule / by the employer | Decided; the record says which. |
| Model suggestion | Shown only when the state passes its gates, and never more than a suggestion. |
| Needs an expert | The BRD's "not in database" route. |

Keyboard: a skip link leads to the main content, focus moves to the record you open, and after each action focus returns to the same control or to the next record's heading.

## Demo script (about five minutes)

The demo opens on **Fairfield Hardware Supply** (Premium plan, 8 employees, 17 Desktop lines).

1. **Analysis**: the Automatic migration panel says 16 of 18 items can be settled by rule. Click **Run automatic migration**.
   - Settled: the 11 lines that were ready to confirm (on the expected list, rate equal), Priya Shah at the official 1.0% rate (Desktop over-withheld $207), Sara Lee's union dues, Raj Patel's missing Teays Valley tax ($648 back tax flagged), and Mike Brown's school tax (not owed in Columbus City Schools).
   - Left for a person: Tom Reed and Kevin O'Neil.
2. **Expert**: mark Kevin O'Neil's "Wage Garnishment" as not a tax (Desktop calls it a tax, the label says garnishment), and map Tom Reed's "Local Tax" to Lancaster CSD once his address is known.
3. Automation accepts both, passes the four go-live checks ($12,063.60 tie-out), goes live and reconciles: 4 taxes, $3,428.70 for the quarter, no expected tax missing.
4. **Go live** shows the W-2 boxes; **Decision log** shows each automatic step with its rule.
5. **All clients**: **Run automation for every client** settles 86% across the six clients and leaves 10 exceptions (Fairfield's two were decided in step 2).
6. To show the manual path instead, open **Review** before running automation: every record has its own Confirm button.
7. **Model governance**: Ohio passes every gate (silhouette 0.53, precision 100%, 53 labels). Pennsylvania stays in shadow mode. In **Try the gates**, set the silhouette threshold to 0.53 and Ohio drops to shadow mode (its score is 0.528); set it to 0.52 and suggestions come back.
8. **Scenario coverage**: 76 of 76 pass. Open any row to see the case in the app.
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
| `web/scenarios.mjs` | The 76 scenarios and their live checks |
| `web/report.mjs` | JSON report and CSV export |
| `web/app.mjs`, `web/styles.css` | The app |
| `data/` | Catalog, address lookup, six companies, expert-labelled label pool |
| `tests/` | `engine.test.mjs` (engine and workflow) and `scenarios.test.mjs` (every scenario plus exact boundaries) |
| `.github/workflows/pages.yml` | Tests, builds and republishes the website whenever `main` changes |
| `docs/` | Design decisions and the data contract |

See [design decisions](docs/design-decisions.md) and the [data contract](docs/data-contract.md).
