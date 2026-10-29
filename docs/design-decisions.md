# Design decisions

Each decision below follows the BRD v3 handoff summary. Where the prototype had to pick a detail the BRD left open, it says so.

## 1. Addresses first, labels second

A Desktop label like "School Tax" names a type of tax, not a jurisdiction. Online payroll needs the exact jurisdiction. So the prototype starts from each employee's addresses:

- **School-district tax** follows the **home** address (Ohio).
- **City tax** follows the **work** location. A home city that offers courtesy withholding (Columbus 2.5%) is listed as optional, not required.
- A mid-year move splits the year into periods, and each period gets its own district.

Each employee ends up with one to four expected taxes. The label only has to say *which kind* of tax a line is. The address says *which one*.

## 2. Clustering is for labels, not for employees

Custom items (Law ID 177 or 0) carry free text: "SD WH", "Schl Dist W/H", "Local Tax". The prototype clusters those labels **within each state**:

- Labels are cleaned first: abbreviations expanded (`sd` → school district, `wh` → withholding), place names removed (so "Lancaster SD" and "Bremen SD" look the same).
- Vectors are TF-IDF on words plus character trigrams (weight 0.35), so typos and run-together words still land close.
- Average-linkage clustering, with k from 2 to 12 picked by the best silhouette score.
- Each cluster is **named after the closest defined entry** (school district, municipal, union dues, garnishment, and so on). A cluster too far from every entry stays unnamed, and its lines go to an expert. "Local Tax" lands there on purpose.
- An individual label with a silhouette below 0.25 counts as a weak signal and goes to an expert, even inside a named cluster.

*Detail chosen by the prototype:* the 0.25 per-item floor and the 0.35 trigram weight.

## 3. Gates decide whether suggestions are shown

Per state, the model's suggestions are shown only if **all** of these pass:

| Gate | Rule | Ohio in the demo |
| --- | --- | --- |
| Rollout | State switched on | On |
| Silhouette | At least 0.5 | 0.54 |
| Precision | At least 98% on expert-labelled labels | 100% (44 of 44 named) |
| Sample | At least 40 labelled labels | 53 |

If any gate fails, the state runs in **shadow mode**: suggestions are still logged, but hidden, and every custom line goes to an expert. Pennsylvania is in shadow mode (not switched on, only 7 labels). The sample gate of 40 is set for demo scale. A real rollout would need thousands.

## 4. Three routes, one outcome per line

Every Desktop line ends in exactly one route:

- **Local tax**: matched to an expected tax. The rate is checked against the official rate, and any over- or under-withholding is shown in dollars.
- **Not a tax**: Desktop already tracked it as an after-tax deduction (union dues), or the cluster says so.
- **Not in database**: shadow mode, weak signal, no address, a tax nobody expects at this address, or a **conflict** (Desktop says tax, the cluster says garnishment). An expert then maps it, marks it not a tax, adds a structured custom entry (employer-managed, never paid by QuickBooks), or stops it.

Conflicts always go to a person. The model never overrides what Desktop recorded.

## 5. The employer confirms everything

Expert decisions go back to the employer. A tax goes live only when the employer has confirmed it. Bulk confirm is offered only for verified matches: lines matched to an expected tax without an expert step, where the Desktop rate equals the official rate.

## 6. Go-live checks

Four checks must pass:

1. Every line decided by the employer.
2. Every gap handled (added or explained).
3. **Dollar tie-out**: every Desktop local-tax dollar has a destination (live tax, deduction, employer-managed, or stopped with a note).
4. Agency account number and deposit frequency for every agency that QuickBooks will pay.

## 7. History is relabelled, not recalculated

For the W-2, the January to September Desktop amounts are relabelled to the confirmed jurisdiction. They keep what was actually withheld, even if the rate was wrong. October to December comes from Online payroll at the official rate. A stopped line stays off the W-2.

## 8. Reconcile twice

After the first cloud payroll and again after the first quarter, withholding is compared with the expected taxes. The flags:

- Expected but not withheld (red).
- Withheld in Desktop but not owed, so a correction with the agency is needed (amber).
- Past withholding over or under the official rate (amber).
- A line still with an expert, so nothing is withheld for it yet (amber).

The payer depends on the plan: Premium and Elite let QuickBooks pay and file supported taxes. Core means the employer pays and files.

## Why no live AI call

The BRD's model is clustering, which runs in the browser with no key and no data leaving the page. A language model could later help name new clusters, but its output would still go through the same gates and the same employer confirmation.
