import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyseCompany, expectedTaxes, indexData } from '../web/engine/analysis.mjs';
import { clusterLabels, silhouette } from '../web/engine/cluster.mjs';
import { normalize } from '../web/engine/text.mjs';
import { effectiveAll, emptyDecisions, readiness, liveTaxes, dollarTieOut, w2Preview, reconcile, agencyAccounts } from '../web/engine/workflow.mjs';
import { buildReport, casesCSV } from '../web/report.mjs';

const read = async (f) => JSON.parse(await readFile(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const catalog = await read('catalog.json');
const geocoder = await read('geocoder.json');
const pools = (await read('label-pool.json')).pools;
const { companies } = await read('companies.json');
const data = { catalog, geocoder, pools };
const company = (id) => companies.find((c) => c.company_id === id);
const fhs = () => analyseCompany(company('C-FHS'), data, {});
const caseOf = (a, name, label) => a.cases.find((c) => c.employee_name === name && c.item.label === label);

// ---------- text and clustering ----------

test('normalisation expands payroll abbreviations and drops place names', () => {
  assert.deepEqual(normalize('Schl Dist W/H', catalog.states.OH.place_names), ['school', 'district', 'withholding']);
  assert.deepEqual(normalize('Lancaster SD', catalog.states.OH.place_names), ['school', 'district']);
  assert.ok(normalize('City Tax', []).includes('municipal'));
  assert.ok(!normalize('Lancaster City Schools', catalog.states.OH.place_names).includes('municipal'), 'city inside a school name is not a city-tax signal');
});

test('silhouette is high for separated groups and zero for singletons', () => {
  const d = [[0, 0.1, 0.9, 0.9], [0.1, 0, 0.9, 0.9], [0.9, 0.9, 0, 0.1], [0.9, 0.9, 0.1, 0]];
  const good = silhouette(d, [[0, 1], [2, 3]]);
  assert.ok(good.mean > 0.85);
  const single = silhouette(d, [[0], [1, 2, 3]]);
  assert.equal(single.scores[0], 0);
});

test('Ohio labels cluster above the 0.5 silhouette floor and vague labels stay unnamed', () => {
  const entries = catalog.defined_entries.filter((e) => e.states.includes('OH'));
  const r = clusterLabels(pools.OH.map((p) => p.label), entries, catalog.states.OH.place_names);
  assert.ok(r.silhouette >= 0.5, `silhouette ${r.silhouette}`);
  const clusterOf = (label) => r.clusters[r.assignment[pools.OH.findIndex((p) => p.label === label)]];
  assert.equal(clusterOf('SD WH').entry.tax_type, 'school_district');
  assert.equal(clusterOf('Schl Dist W/H'), clusterOf('School Tax'));
  assert.equal(clusterOf('Muni Tax').entry.tax_type, 'municipal');
  assert.equal(clusterOf('Local Tax').entry, null, '"Local Tax" names no tax type');
});

test('shadow-mode precision is measured on the expert-labelled pool only', () => {
  const a = fhs();
  const oh = a.models.OH;
  assert.equal(oh.poolSize, pools.OH.length);
  assert.ok(oh.precision >= 0.98);
  assert.ok(oh.coverage > 0.5 && oh.coverage < 1, 'some labels are left to people');
  assert.equal(oh.mode, 'assisted');
  assert.equal(a.models.PA.mode, 'shadow', 'Pennsylvania is not enabled and its sample is too small');
  assert.equal(a.models.PA.gates.sample, false);
});

// ---------- expected taxes ----------

test('expected taxes come from home and work addresses, by period', () => {
  const idx = indexData(data);
  const co = company('C-FHS');
  const emp = (n) => co.employees.find((e) => e.name === n);
  const ids = (n) => expectedTaxes(emp(n), co, idx).list.map((x) => x.tax_id).sort();
  assert.deepEqual(ids('John Carter'), ['OH-CITY-LANCASTER', 'OH-SD-2305']);
  const mike = expectedTaxes(emp('Mike Brown'), co, idx);
  assert.deepEqual(mike.list.map((x) => [x.tax_id, x.required]).sort(), [['OH-CITY-COLUMBUS', false], ['OH-CITY-LANCASTER', true]]);
  assert.ok(mike.notes.some((n) => /Columbus City School District has no/.test(n.text)));
  const ana = expectedTaxes(emp('Ana Gomez'), co, idx).list;
  assert.deepEqual(ana.find((x) => x.tax_id === 'OH-SD-2303').months, [1, 2, 3, 4, 5]);
  assert.deepEqual(ana.find((x) => x.tax_id === 'OH-SD-2305').months, [6, 7, 8, 9, 10, 11, 12]);
  const tom = expectedTaxes(emp('Tom Reed'), co, idx);
  assert.deepEqual(tom.list.map((x) => x.tax_id), ['OH-CITY-LANCASTER']);
  assert.ok(tom.notes.some((n) => n.tone === 'warn'));
});

// ---------- routing ----------

const ROUTES = [
  ['John Carter', 'School Tax', 'local_tax', 'matched', ['OH-SD-2305']],
  ['John Carter', 'Lancaster City Tax', 'local_tax', 'matched', ['OH-CITY-LANCASTER']],
  ['Priya Shah', 'School Tax', 'local_tax', 'matched', ['OH-SD-2307']],
  ['Mike Brown', 'School Tax', 'not_in_database', 'not_expected', []],
  ['Sara Lee', 'SD WH', 'local_tax', 'matched', ['OH-SD-2305']],
  ['Sara Lee', 'Union Dues', 'not_a_tax', 'after_tax', []],
  ['Tom Reed', 'Local Tax', 'not_in_database', 'weak_signal', []],
  ['Tom Reed', 'Lancaster City Tax', 'local_tax', 'matched', ['OH-CITY-LANCASTER']],
  ['Ana Gomez', 'School Tax', 'local_tax', 'matched', ['OH-SD-2303', 'OH-SD-2305']],
  ["Kevin O'Neil", 'Wage Garnishment', 'not_in_database', 'conflict', []],
];
for (const [name, label, route, reason, taxes] of ROUTES) {
  test(`${name} / "${label}" routes to ${route} (${reason})`, () => {
    const c = caseOf(fhs(), name, label);
    assert.equal(c.route, route);
    assert.equal(c.reason, reason);
    assert.deepEqual(c.proposal.map((p) => p.tax_id), taxes);
  });
}

test('every Desktop line ends in exactly one of the three routes', () => {
  for (const co of companies) {
    const a = analyseCompany(co, data, {});
    // One line per employee per item that exists; missing or repeated references are reported, not counted.
    const known = new Set(co.items.map((i) => i.item_id));
    const expected = co.employees.reduce((n, e) => n + new Set(e.items.filter((id) => known.has(id))).size, 0);
    const dropped = co.employees.reduce((n, e) => n + e.items.length, 0) - expected;
    assert.equal(a.cases.length, expected);
    assert.equal(a.dataIssues.filter((i) => /not in the Desktop item list|listed twice/.test(i.text)).length, dropped);
    for (const c of a.cases) assert.ok(['local_tax', 'not_a_tax', 'not_in_database'].includes(c.route), c.case_id);
  }
});

test('the rate check measures over-withholding in dollars', () => {
  const a = fhs();
  const priya = caseOf(a, 'Priya Shah', 'School Tax').proposal[0].rate;
  assert.equal(priya.status, 'over');
  assert.equal(priya.difference, 207);
  const ana = caseOf(a, 'Ana Gomez', 'School Tax').proposal;
  assert.equal(ana[0].rate.status, 'over');
  assert.equal(ana[0].rate.difference, 55);
  assert.equal(ana[1].rate.status, 'match');
});

test('gaps are flagged the other way: an expected tax nobody withheld', () => {
  const gaps = fhs().gaps;
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].employee_name, 'Raj Patel');
  assert.equal(gaps[0].tax_id, 'OH-SD-6503');
  assert.equal(gaps[0].backTaxEstimate, 648);
});

test('forcing shadow mode hides suggestions and sends custom lines to people; system items still route', () => {
  const a = analyseCompany(company('C-FHS'), data, { forceShadow: { OH: true } });
  const school = caseOf(a, 'John Carter', 'School Tax');
  assert.equal(school.route, 'not_in_database');
  assert.equal(school.reason, 'shadow');
  assert.equal(school.model.shown, false);
  assert.equal(school.model.entry_label, 'School-district income tax', 'the suggestion is still logged');
  assert.equal(caseOf(a, 'John Carter', 'Lancaster City Tax').route, 'local_tax');
  assert.equal(caseOf(a, 'Sara Lee', 'Union Dues').route, 'not_a_tax', 'Desktop already says after-tax');
});

test('Pennsylvania lines go to an expert while the state is in shadow mode', () => {
  const a = analyseCompany(company('C-KSF'), data, {});
  for (const label of ['PA Local EIT', 'LST']) {
    const c = caseOf(a, 'Marcus Bell', label);
    assert.equal(c.state, 'PA');
    assert.equal(c.route, 'not_in_database');
    assert.equal(c.reason, 'shadow');
  }
});

// ---------- workflow ----------

function runDemo(a) {
  const d = emptyDecisions();
  const id = (name, label) => caseOf(a, name, label).case_id;
  d.cases[id("Kevin O'Neil", 'Wage Garnishment')] = { expert: { action: 'not_a_tax' } };
  d.cases[id('Mike Brown', 'School Tax')] = { expert: { action: 'stop', note: 'No school-district tax at this address.' } };
  d.cases[id('Tom Reed', 'Local Tax')] = { expert: { action: 'map', tax_id: 'OH-SD-2305' } };
  for (const c of effectiveAll(a, d)) if (c.stage === 'awaiting_employer') d.cases[c.case_id] = { ...(d.cases[c.case_id] ?? {}), employer: { action: c.route } };
  for (const g of a.gaps) d.gaps[g.gap_id] = { action: 'add' };
  return d;
}

test('nothing goes live without the employer, even after an expert decides', () => {
  const a = fhs();
  const d = emptyDecisions();
  assert.equal(readiness(a, d).ready, false);
  assert.equal(liveTaxes(a, d).length, 0);
  const tom = caseOf(a, 'Tom Reed', 'Local Tax').case_id;
  d.cases[tom] = { expert: { action: 'map', tax_id: 'OH-SD-2305' } };
  const c = effectiveAll(a, d).find((x) => x.case_id === tom);
  assert.equal(c.stage, 'awaiting_employer');
  assert.equal(liveTaxes(a, d).length, 0);
});

test('the full demo flow passes every go-live check', () => {
  const a = fhs();
  const d = runDemo(a);
  const r = readiness(a, d);
  assert.deepEqual(r.checks.map((x) => [x.id, x.pass]), [['employer', true], ['gaps', true], ['dollars', true], ['accounts', true]]);
  assert.equal(r.tie.waiting, 0);
});

test('the dollar tie-out covers every Desktop local-tax dollar and skips after-tax deductions', () => {
  const a = fhs();
  const tie = dollarTieOut(a, runDemo(a));
  const desktopTax = a.cases.filter((c) => c.item.tracking_type !== 'None').reduce((s, c) => s + c.ytd, 0);
  assert.equal(tie.total, Math.round(desktopTax * 100) / 100);
  assert.equal(tie.rows.reduce((s, r) => s + r.amount, 0).toFixed(2), tie.total.toFixed(2));
  assert.ok(!a.cases.some((c) => c.item.label === 'Union Dues' && c.item.tracking_type !== 'None'));
});

test('W-2 history keeps what Desktop actually withheld and adds Online months', () => {
  const a = fhs();
  const w2 = w2Preview(a, runDemo(a));
  const john = w2.find((w) => w.employee.name === 'John Carter');
  const sd = john.lines.find((l) => l.key === 'OH-SD-2305');
  assert.equal(sd.desktop, 526.5);
  assert.equal(sd.cloud, 175.5);
  assert.equal(sd.total, 702);
  assert.equal(sd.wages, 46800);
  const ana = w2.find((w) => w.employee.name === 'Ana Gomez');
  assert.deepEqual(ana.lines.map((l) => l.key).sort(), ['OH-CITY-LANCASTER', 'OH-SD-2303', 'OH-SD-2305']);
  const mike = w2.find((w) => w.employee.name === 'Mike Brown');
  assert.ok(!mike.lines.some((l) => l.key.startsWith('OH-SD')), 'a stopped tax stays off the W-2');
});

test('reconciliation flags an expected tax that is not withheld', () => {
  const a = fhs();
  const d = runDemo(a);
  delete d.gaps[a.gaps[0].gap_id];
  const r = reconcile(a, d);
  assert.ok(r.flags.some((f) => f.tone === 'fail' && /Raj Patel: Teays Valley/.test(f.text)));
  const full = reconcile(a, runDemo(a));
  assert.ok(!full.flags.some((f) => f.tone === 'fail'));
  assert.ok(full.rows.every((row) => row.payer === 'QuickBooks pays and files'), 'Premium plan, supported taxes');
});

test('a Core-plan company pays and files itself, and a missing account number blocks go-live', () => {
  const a = analyseCompany(company('C-HVD'), data, {});
  const d = emptyDecisions();
  for (const c of effectiveAll(a, d)) {
    assert.ok(c.verified, `${c.case_id} should be verified`);
    d.cases[c.case_id] = { employer: { action: 'local_tax' } };
  }
  const lancaster = agencyAccounts(a, d).find((x) => x.agency === 'City of Lancaster Income Tax Department');
  assert.equal(lancaster.complete, false);
  assert.equal(readiness(a, d).ready, false);
  d.accounts['City of Lancaster Income Tax Department'] = { account: 'LAN-778812', frequency: 'Quarterly' };
  assert.equal(readiness(a, d).ready, true);
  assert.ok(reconcile(a, d).rows.every((row) => row.payer === 'You pay and file'));
});

test('a structured custom entry is employer-managed and never paid by QuickBooks', () => {
  const a = analyseCompany(company('C-KSF'), data, {});
  const d = emptyDecisions();
  const lst = caseOf(a, 'Marcus Bell', 'LST').case_id;
  d.cases[lst] = { expert: { action: 'custom_entry', entry: { name: 'York LST', agency: 'York Adams Tax Bureau', type: 'Local services tax', basis: 'work', frequency: 'Quarterly', flat: 52 } }, employer: { action: 'custom_entry' } };
  const c = effectiveAll(a, d).find((x) => x.case_id === lst);
  assert.equal(c.stage, 'employer_managed');
  const row = reconcile(a, d).rows.find((r) => r.name === 'York LST');
  assert.equal(row.payer, 'You pay and file (employer-managed)');
  assert.equal(row.quarter, 13);
});

test('the report keeps every line and its CSV neutralises spreadsheet formulas', () => {
  const a = fhs();
  const report = buildReport(a, runDemo(a), []);
  assert.equal(report.cases.length, a.cases.length);
  assert.ok(report.cases.every((c) => c.evidence.length > 0));
  report.cases[0].desktop_item.label = '=HYPERLINK("x")';
  const csv = casesCSV(report);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});
