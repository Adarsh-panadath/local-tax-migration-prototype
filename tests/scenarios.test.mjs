import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyseCompany, evaluateGates, DEFAULT_THRESHOLDS } from '../web/engine/analysis.mjs';
import { clusterLabels, assignLabel } from '../web/engine/cluster.mjs';
import { rateCheck, employedMonths } from '../web/engine/util.mjs';
import { effectiveAll, emptyDecisions, gapStage, liveTaxes, readiness, dollarTieOut } from '../web/engine/workflow.mjs';
import { SCENARIOS, GROUPS, runScenarios } from '../web/scenarios.mjs';

const read = async (f) => JSON.parse(await readFile(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const catalog = await read('catalog.json');
const geocoder = await read('geocoder.json');
const pools = (await read('label-pool.json')).pools;
const { companies } = await read('companies.json');
const data = { catalog, geocoder, pools, companies };
const company = (id) => companies.find((c) => c.company_id === id);
const caseOf = (a, name, label) => a.cases.find((c) => c.employee_name === name && c.item.label === label);

// ---------- every scenario on the website passes ----------

const results = runScenarios(data);
for (const r of results) {
  test(`scenario ${r.id}: ${r.title}`, () => {
    assert.ok(r.pass, `${r.title}: ${r.detail}`);
  });
}

test('the scenario list is well formed', () => {
  const ids = new Set();
  for (const s of SCENARIOS) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.ok(GROUPS.some((g) => g.id === s.group), `${s.id} has an unknown group`);
    assert.ok(companies.some((c) => c.company_id === s.where.company), `${s.id} points at an unknown company`);
    if (s.where.employee) assert.ok(company(s.where.company).employees.some((e) => e.employee_id === s.where.employee), `${s.id} points at an unknown employee`);
  }
  assert.ok(SCENARIOS.length >= 50);
});

// ---------- exact boundaries ----------

test('gates pass at exactly the threshold and fail just below it', () => {
  const base = { rollout: true, silhouette: 1, precision: 1, sample: 1000 };
  const t = DEFAULT_THRESHOLDS;
  assert.equal(evaluateGates({ ...base, silhouette: t.silhouetteFloor }).silhouette, true);
  assert.equal(evaluateGates({ ...base, silhouette: t.silhouetteFloor - 1e-9 }).silhouette, false);
  assert.equal(evaluateGates({ ...base, precision: t.precisionTarget }).precision, true);
  assert.equal(evaluateGates({ ...base, precision: t.precisionTarget - 1e-9 }).precision, false);
  assert.equal(evaluateGates({ ...base, sample: t.minSample }).sample, true);
  assert.equal(evaluateGates({ ...base, sample: t.minSample - 1 }).sample, false);
  assert.equal(evaluateGates({ ...base, rollout: false }).rollout, false);
});

test('rates within the tolerance match; anything further is over or under', () => {
  const tax = { rate: 1.5 };
  const status = (rate, months = [1, 2, 3]) => rateCheck({ calc: { kind: 'percent', rate } }, tax, months, 4000).status;
  assert.equal(status(1.5), 'match');
  assert.equal(status(1.5 + 1e-6), 'match');
  assert.equal(status(1.4999), 'under');
  assert.equal(status(1.5001), 'over');
  assert.equal(status(2.0, []), 'no_history', 'no Desktop months means nothing to compare');
  assert.equal(rateCheck({ calc: { kind: 'flat_annual', amount: 52 } }, tax, [1], 4000).status, 'not_comparable');
});

test('employment months default to the full year and respect joiners and leavers', () => {
  assert.deepEqual(employedMonths({}), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(employedMonths({ hired_month: 12 }), [12]);
  assert.deepEqual(employedMonths({ left_month: 1 }), [1]);
});

// ---------- the state model ----------

test('the state model is fitted on the labelled pool, so its gates are the same for every client', () => {
  const sil = new Set(companies.map((c) => analyseCompany(c, data, {}).models.OH.silhouette.toFixed(6)));
  assert.equal(sil.size, 1);
});

test('a label with no words left joins no cluster and scores zero', () => {
  const entries = catalog.defined_entries.filter((e) => e.states.includes('OH'));
  const fitted = clusterLabels(pools.OH.map((p) => p.label), entries, catalog.states.OH.place_names);
  for (const label of ['Lancaster', '---', '']) {
    const a = assignLabel(fitted, label);
    assert.equal(a.cluster, -1, label);
    assert.equal(a.silhouette, 0);
    assert.equal(a.empty, true);
  }
  const known = assignLabel(fitted, 'School District Tax');
  assert.ok(known.cluster >= 0 && known.silhouette > 0.5);
});

test('fewer than three labels cannot be clustered, so nothing is named', () => {
  const r = clusterLabels(['SD Tax', 'City Tax'], catalog.defined_entries, []);
  assert.equal(r.clusters.length, 0);
  assert.equal(assignLabel(r, 'SD Tax').cluster, -1);
});

// ---------- workflow edges ----------

test('sending a line to an expert, then taking it back, restores the suggestion', () => {
  const a = analyseCompany(company('C-FHS'), data, {});
  const id = caseOf(a, 'John Carter', 'School Tax').case_id;
  const d = emptyDecisions();
  d.cases[id] = { sentToExpert: { note: 'check' } };
  assert.equal(effectiveAll(a, d).find((c) => c.case_id === id).stage, 'with_expert');
  delete d.cases[id].sentToExpert;
  const back = effectiveAll(a, d).find((c) => c.case_id === id);
  assert.equal(back.stage, 'awaiting_employer');
  assert.equal(back.verified, true);
});

test('a covered gap is never withheld twice, even if the employer also added it', () => {
  const a = analyseCompany(company('C-HHF'), data, {});
  const sd = caseOf(a, 'Jacob King', 'SD Tax').case_id;
  const gap = a.gaps.find((g) => g.employee_name === 'Jacob King');
  const d = emptyDecisions();
  d.gaps[gap.gap_id] = { action: 'add' };
  d.cases[sd] = { expert: { action: 'map', tax_id: 'OH-SD-2305' }, employer: { action: 'local_tax' } };
  assert.equal(gapStage(gap, d, a), 'covered');
  const jacob = liveTaxes(a, d).filter((t) => t.employee.name === 'Jacob King' && t.key === 'OH-SD-2305');
  assert.equal(jacob.length, 1);
});

test('a line reclassified as a tax by an expert joins the dollar tie-out', () => {
  const a = analyseCompany(company('C-HHF'), data, {});
  const sd = caseOf(a, 'Jacob King', 'SD Tax');
  const before = dollarTieOut(a, emptyDecisions()).total;
  const d = emptyDecisions();
  d.cases[sd.case_id] = { expert: { action: 'map', tax_id: 'OH-SD-2305' } };
  assert.equal(Math.round((dollarTieOut(a, d).total - before) * 100) / 100, sd.ytd);
});

test('the boundary-case company can still go live once every line is decided', () => {
  const a = analyseCompany(company('C-HHF'), data, {});
  const d = emptyDecisions();
  const map = { 'Mia Young|Lancaster City Tax': { action: 'stop', note: 'Works from home in Columbus' }, 'Jacob King|SD Tax': { action: 'map', tax_id: 'OH-SD-2305' }, 'Henry Ward|Lancaster': { action: 'map', tax_id: 'OH-CITY-LANCASTER' } };
  for (const c of a.cases) {
    if (c.route !== 'not_in_database') continue;
    d.cases[c.case_id] = { expert: map[`${c.employee_name}|${c.item.label}`] ?? (['no_address', 'address_unresolved'].includes(c.reason) ? { action: 'map', tax_id: 'OH-SD-2305' } : { action: 'stop', note: 'Not owed' }) };
  }
  for (const c of effectiveAll(a, d)) if (c.stage === 'awaiting_employer') d.cases[c.case_id] = { ...(d.cases[c.case_id] ?? {}), employer: { action: c.route } };
  for (const g of a.gaps) if (gapStage(g, d, a) === 'awaiting_employer') d.gaps[g.gap_id] = { action: 'add' };
  d.accounts['City of Columbus Income Tax Division'] = { account: 'COL-552019', frequency: 'Quarterly' };
  const r = readiness(a, d);
  assert.deepEqual(r.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`), []);
});
