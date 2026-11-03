# Design decisions

Each decision below follows the BRD v3 handoff summary. Where the prototype had to pick a detail the BRD left open, it says so. Every rule here has a live check on the website's **Scenario coverage** page.

## 0. Check the Desktop file before anything else

*Added by the prototype; the BRD assumes clean data.*

- **Stop** when nothing sensible can be computed: a migration month outside 1 to 12, no work site or an unknown one, duplicate employee or item IDs, negative wages, a rate outside 0% to 100%, joining after leaving, or a system item pointing at a tax that is not in the catalog. The page lists every problem in plain words.
- **Clean up and report** smaller problems: an address the lookup has never seen (lines that need it go to an expert), an item reference that does not exist (left out), an item listed twice for one person (counted once), a missing item name (treated as blank).
- Labels are always plain text. A label with code or a spreadsheet formula goes to an expert, and the CSV export puts an apostrophe in front of any cell starting with `=`, `+`, `-` or `@`.

## 0a. The Law ID names the tax

Every tax has a **Law ID**, its unique identifier. A Desktop payroll item that QuickBooks already knows carries its tax's Law ID (Columbus City Tax: 4140), so it maps straight to the tax: no label reading, no clustering. An item the employer created carries **177 or 0**, which names no tax. Those are the hard lines, and everything below (addresses, clustering, experts) exists to turn a 177 into a real Law ID. In the database, `taxes` is keyed by `law_id`, `results.law_id` names the Online tax of every line, and `payroll_items.law_id` matches `taxes` for system items only (so it is not a foreign key). A system item whose Law ID no tax has stops the file. The Law ID numbers in the demo are illustrative, not Intuit's.

## 1. Addresses first, labels second

A Desktop label like "School Tax" names a type of tax, not a jurisdiction. Online payroll needs the exact jurisdiction. So the prototype starts from each employee's addresses:

- **School-district tax** follows the **home** address (Ohio).
- **City tax** follows the **work** location. A home city that offers courtesy withholding (Columbus 2.5%) is listed as optional, not required.
- A mid-year move splits the year into periods, and each period gets its own district. A move in the migration month keeps the Desktop history with the old district and starts the new one in Online payroll.
- A **remote worker** works where they live, so the city tax follows the home address.
- Living in a state that is not switched on (Pennsylvania) lists no home-based taxes for those months. If Desktop kept withholding after a move out of the district, those months are **not owed** and need a correction.
- No address, or an address the lookup cannot place, leaves those months open, and lines that depend on them go to an expert.
- Joiners and leavers only count the months they were on the payroll. Someone who left before the move has no Online taxes, but their history is still relabelled for the W-2.

The state comes from the item label if it names one, else the home address, else the work address. A label naming a state the employee neither lives nor works in goes to an expert.

Each employee ends up with one to four expected taxes. The label only has to say *which kind* of tax a line is. The address says *which one*.

## 2. Clustering is for labels, not for employees

Custom items (Law ID 177 or 0) carry free text: "SD WH", "Schl Dist W/H", "Local Tax". The prototype clusters those labels **within each state**:

- Labels are cleaned first: abbreviations expanded (`sd` → school district, `wh` → withholding), place names removed (so "Lancaster SD" and "Bremen SD" look the same).
- Vectors are TF-IDF on words plus character trigrams (weight 0.35), so typos and run-together words still land close.
- Average-linkage clustering, with k from 2 to 12 picked by the best silhouette score.
- The model is **fitted once per state, on the expert-labelled pool**. A company's own labels are then scored against those fitted clusters, so one company's messy labels cannot change a state's gates.
- A label with no words left after clean-up (blank, or just a place name like "Lancaster") joins no cluster and goes to an expert.
- Each cluster is **named after the closest defined entry** (school district, municipal, union dues, garnishment, and so on). A cluster too far from every entry stays unnamed, and its lines go to an expert. "Local Tax" lands there on purpose.
- An individual label with a silhouette below 0.25 counts as a weak signal and goes to an expert, even inside a named cluster.

*Detail chosen by the prototype:* the 0.25 per-item floor and the 0.35 trigram weight.

## 3. Gates decide whether suggestions are shown

Per state, the model's suggestions are shown only if **all** of these pass:

| Gate | Rule | Ohio in the demo |
| --- | --- | --- |
| Rollout | State switched on | On |
| Silhouette | At least 0.5 | 0.53 (0.528) |
| Precision | At least 98% on expert-labelled labels | 100% (44 of 44 named) |
| Sample | At least 40 labelled labels | 53 |

If any gate fails, the state runs in **shadow mode**: suggestions are still logged, but hidden, and every custom line goes to an expert. Pennsylvania is in shadow mode (not switched on, only 7 labels). The sample gate of 40 is set for demo scale. A real rollout would need thousands.

A value exactly equal to a threshold passes. **Model governance → Try the gates** lets you change the thresholds: at 0.53 Ohio drops to shadow mode, and at 0.52 it comes back. Governance can also force a state into shadow mode at any time.

## 4. Three routes, one outcome per line

Every Desktop line ends in exactly one route:

- **Local tax**: matched to an expected tax. The rate is checked against the official rate, and any over- or under-withholding is shown in dollars.
- **Not a tax**: Desktop already tracked it as an after-tax deduction (union dues), or the cluster says so.
- **Not in database**: shadow mode, weak signal, no address, a tax nobody expects at this address, or a **conflict** (Desktop says tax, the cluster says garnishment). An expert then maps it, marks it not a tax, adds a structured custom entry (employer-managed, never paid by QuickBooks), or stops it.

Conflicts always go to a person. The model never overrides what Desktop recorded.

Other cases the routing handles:

| Case | Outcome |
| --- | --- |
| The label names a place, the address says another ("Pickerington SD" for a Lancaster resident) | The address wins; flagged and not bulk-confirmable |
| Two Desktop items for the same tax | One stays; the other goes to an expert so nothing is withheld twice |
| An Intuit-defined item for the wrong city | Not expected, so an expert decides |
| Only the optional home-city tax fits | Matched as optional; the employer decides |
| The rate differs by any amount (1.4999% against 1.5%) | Over- or under-withheld, in dollars; not bulk-confirmable |

## 5. The employer confirms everything

Expert decisions go back to the employer. A tax goes live only when the employer has confirmed it. The employer can also send any line, even one that is ready to confirm, to an expert. A gap counts as covered once an expert maps one of the employee's lines to that tax, so it is never added twice. Bulk confirm is offered only for lines that are **ready to confirm** (called verified matches in the code): matched to an expected tax without an expert step, where the Desktop rate equals the official rate. The screen never calls them verified, because the employer has not confirmed them yet.

## 5a. Automation: the employer decides the rules, not every line

*Added by the prototype to keep manual work to a minimum.* The BRD's principle is "model suggests, person decides". Here the person decides once, by approving seven rules, and the system applies them to every line they cover (`automate` in `web/engine/workflow.mjs`):

1. Confirm matches the address supports.
2. Use the official rate when Desktop's rate is wrong (the difference is flagged for a correction).
3. Move after-tax deductions.
4. Add expected taxes nobody withheld (from the first cloud payroll; back tax flagged).
5. Stop taxes the address says are not owed (duplicates, and taxes not on the expected list for an address found in the lookup).
6. Accept expert decisions.
7. Go live and reconcile, only when nothing is left for a person and every go-live check passes.

Never automated: a weak or missing label signal, conflicting evidence, a missing or unplaceable address, a label naming another state, a state in shadow mode, more than one possible tax, or a line someone sent to an expert. These are the exceptions a person handles; after each decision, automation re-runs and finishes what it now can.

Every automatic step is logged with its rule. Any of them can be undone; an undone line is held for a person and automation skips it from then on. Each rule can be switched off.

## 5b. How a customer starts: the move

*Added by the prototype.* Intuit's own Desktop-to-Online move is a short wizard in Desktop (start, choose what moves, export), followed by a welcome page that lists what matched and an exception report for what did not. Its help pages describe employees, pay items and year-to-date totals being copied, but none of them say how local taxes are mapped; the local tax article has the employer pick each employee's local taxes by hand. The move copies the data but does not interpret it.

The prototype keeps that shape and puts the local tax step inside it:

1. **Start**: what moves, and the client's loose Desktop labels next to the exact taxes its addresses call for.
2. **Check**: before the move, what the employer's rules will settle, what stays for a person and why, and the rules to approve.
3. **Move**: the rules run (the same `automate` as everywhere else).
4. **Summary**: settled by rule, waiting for a person, an exception report that links to each record, and the steps up to the first Online payroll.

The screens are our own design and carry no Intuit branding. The copy of employees, pay items and totals is simulated and says so on screen; the local tax checks are real.

## 5c. One screen set per person, and a real database

*Added by the prototype.*

- **One business, one database.** A migration moves one business, so the demo has one: Buckeye Supply Co., 152 employees. All three roles work on it. The database holds only that business, so no table needs a company id; another business would get its own database with the same tables. An uploaded Desktop file replaces Buckeye until the admin goes back.
- **Roles.** The business owner moves the business: Move, To do and Go live. The payroll tax expert sees only the queue. The admin sees the engine's findings, the model, the ML Lab, the data, the scenarios and the log. Buttons that open another person's screen appear only for a role that can open it. The sign-in uses demo accounts without passwords, because a static site cannot keep a secret; in production the role would come from the Intuit account or the staff sign-in.
- **No bulk run across customers.** An earlier version had an accountant who could run automation for every client at once, and later an all-businesses Portfolio. Both were removed: each business approves its own rules when it moves, so nobody runs another company's move, and the demo stays on the one business being moved.
- **Database.** The business is loaded into SQLite in the browser, and the engine reads it back with SQL. A test proves the round trip is exact. The query box is read-only: the database itself is switched to read-only while a query runs, so even `WITH ... DELETE` is refused. Customer data stays fictional; the tax reference is real where it matters.
- **Schema: seven tables.** From the Desktop file: `company`, `employees`, `payroll_items`, `desktop_lines`. From Intuit's lookup: `addresses`, `taxes` (only what this business needs). Our result: `results`. Every table has a primary key, and foreign keys and CHECK rules are on, so the database itself refuses a row that points at nothing or holds an impossible value; the Data page proves it with five rule checks. Two simplifications, said plainly: an employee's work site and a move (new address and month) sit on the employee's row, and the step-by-step log stays in the app, not the database. An earlier version had 22 tables in four layers; it was cut to what one migration needs so it can be explained in a minute. See [schema.md](schema.md).

## 5d. Missing information goes to the person who has it

*Added by the prototype.* A missing or unplaceable home address is not a judgement call; it is a fact only the employer has. So those lines are the employer's (`needs: "address"` in `exceptions`), not an expert's:

1. The move summary lists them with **Add address**; the owner's To do shows them under **Missing information**.
2. The owner types the address (or, in the demo, fills one the lookup knows).
3. It is saved to the database, the engine checks that employee's lines again, and the rules settle what they can.
4. An address the lookup has never seen is kept, and the line stays with an expert, who can still map it.

The same card lists missing agency account numbers, which also only the employer can give.

## 5e. One decision per label, not per line

*Added by the prototype.* A Desktop item is usually on many employees: one unclear label at a 150-person business is 150 lines. The expert can decide what the label means once (school-district tax, city tax, or not a tax), and each employee's own address picks the exact tax. This is the BRD's split, label for the kind and address for the jurisdiction, applied to the expert's work. Lines with no tax of that kind at the employee's address stay open. Lines waiting for an address, or sent back by the employer, are left out.

## 5f. Scale, and proof that the clustering works

*Added by the prototype.*

- **A realistic size.** The business has 152 employees and 313 Desktop local tax lines, from a fixed seed: synthetic people on real towns, ZIP codes, districts and rates, with the messy data a real Desktop file has.
- **Scale test.** `tests/scale.test.mjs` generates 59 more businesses of 100 to 280 employees (9,000+ people) and runs them through the same engine and database. They are a test, not part of the app.
- **ML Lab.** The 53-label demo pool shows how the gates work but proves little. The lab builds a 1,200-label set, fits clusters on 80% with the engine's own code, and grades the other 20%, against simple word matching too. It reports what it finds, including when the gate would keep the state in shadow mode. With seed 2026: precision 98.4% on held-back labels at 78.8% coverage; word matching 98.2% at 90.8%; silhouette 0.462, below the 0.5 gate. Across other seeds neither method wins every time, which is why the screen states numbers, not a winner. Clustering's value is in grouping hundreds of label spellings into a few dozen families an expert names once, and in a confidence that decides when to defer.
- The demo pool's k range stays 2 to 12; the lab uses 2 to 30, because a set seven times larger needs room for more clusters.
- **Try the clustering.** The Model page runs one made-up employee and Desktop item through the same engine and shows each step: the cleaned words, the closeness to every cluster, the silhouette against the 0.25 floor, and the tax the address picks. Its numbers come from the fitted Ohio model, not from a separate demo path (`explainLabel` returns the same cluster and silhouette as `assignLabel`; a test checks this). **Add to Buckeye** stores the person in the browser and adds them to the database on every rebuild, so their line goes through the same queues as everyone else's.

## 6. Go-live checks

Four checks must pass:

1. Every line decided by the employer.
2. Every gap handled (added or explained).
3. **Dollar tie-out**: every Desktop local-tax dollar has a destination (live tax, deduction, employer-managed, stopped with a note, or not-owed months sent for correction).
4. Agency account number and deposit frequency for every agency that QuickBooks will pay.

## 7. History is relabelled, not recalculated

For the W-2, the Desktop months (January to September for an October move) are relabelled to the confirmed jurisdiction. They keep what was actually withheld, even if the rate was wrong. October to December comes from Online payroll at the official rate. A stopped line stays off the W-2. A company that moves in January has no Desktop history to relabel, so a gap has no back tax.

## 8. Reconcile twice

After the first cloud payroll and again after the first quarter, withholding is compared with the expected taxes. The flags:

- Expected but not withheld (red).
- Withheld in Desktop but not owed, so a correction with the agency is needed (amber).
- Past withholding over or under the official rate (amber).
- A line still with an expert, so nothing is withheld for it yet (amber).

The payer depends on the plan: Premium and Elite let QuickBooks pay and file supported taxes. Core means the employer pays and files.

## The AI assistant: an opinion first, then questions

*Added after faculty feedback.*

- **Where.** Every record in the employer's To do and the expert's queue, and every person on the Use cases screen, has an **AI assistant**. It gives its opinion first (a recommendation, how confident it is, why, and one thing to check), then answers questions so a person can verify it.
- **One facts brief, two answerers.** `web/assistant.mjs` builds one brief per record from the engine's own results: the person's addresses and months, the Desktop line, the expected taxes with their Law IDs, the rate checks, the model's reading of the label and the steps. In the hosted app on claude.ai, **Claude** answers from that brief through the page's `sample` capability, on the viewer's own Claude account (it asks permission the first time; no key is stored anywhere). Everywhere else (the website, the zip) the **built-in assistant** answers from the same brief with fixed rules, and says so.
- **Grounded, not creative.** Claude is told to use only the facts and to say when they do not cover a question; the built-in assistant has nothing else to use and answers "I can only answer from the facts" otherwise. Neither decides anything: suggestions still go through the gates and the employer's confirmation.
- **Failure is visible.** If the viewer declines, Claude is unavailable, busy or refuses, the card says so; when Claude is not allowed it switches to the built-in assistant for the rest of the visit.
- **The clustering stays the model.** The label clustering is still what reads Desktop labels; the assistant explains and checks, it does not replace the gates.

## Use cases

The Use cases screen runs six made-up people through the same engine as a small business of their own: lives and works in the same town; lives in one town and works in another; arrived from India in June and works as a barista in Columbus; moved house mid-year; works from home; Desktop withheld a tax that is not owed. Each shows a month-by-month timeline of the taxes owed, the reason, and what the migration does with the Desktop lines. `tests/assistant.test.mjs` checks each person's taxes and outcomes, so the screen cannot drift from the engine. Local taxes here follow where a person lives and works and the months on the payroll; federal and state tax residency for someone new to the US is out of scope.
