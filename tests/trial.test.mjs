// "Try the clustering" on the Model page: one made-up employee and Desktop item, run through the real engine.
// These tests check what the panel shows (explainLabel / model.explain) and that an added employee goes
// through the database like any other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { generateBusinesses } from '../web/generate.mjs';
import { createDatabase, readData } from '../web/db.mjs';
import { analyseCompany } from '../web/engine/analysis.mjs';
import { clusterLabels, assignLabel, explainLabel } from '../web/engine/cluster.mjs';
import { effectiveAll, emptyDecisions } from '../web/engine/workflow.mjs';

const require = createRequire(import.meta.url);
const read = async (f) => JSON.parse(await readFile(new URL(`../data/${f}`, import.meta.url), 'utf8'));
async function loadSql() {
  const code = await readFile(new URL('../web/vendor/sql-wasm.js', import.meta.url), 'utf8');
  const module = { exports: {} };
  const file = new URL('../web/vendor/sql-wasm.js', import.meta.url).pathname;
  new Function('module', 'exports', 'require', '__dirname', '__filename', code)(module, module.exports, require, file.replace(/[^/]+$/, ''), file);
  return module.exports({ wasmBinary: await readFile(new URL('../web/vendor/sql-wasm.wasm', import.meta.url)) });
}
const SQL = await loadSql();
const [catalog, geocoder, pool] = await Promise.all(['catalog.json', 'geocoder.json', 'label-pool.json'].map(read));
const generated = generateBusinesses(catalog);
const lookup = [...geocoder.addresses, ...generated.addresses];
const buckeye = generated.companies[0];
const data = { catalog, geocoder: { ...geocoder, addresses: lookup }, pools: pool.pools };

// One placed address in a town, as the panel's "Lives in" list picks it.
const homeIn = (city) => lookup.find((a) => a.state === 'OH' && a.city === city && !a.missing && a.school_district !== 'UNRESOLVED').address_id;
function trial({ label, law = 177, rate = 1, city = 'Pickerington', site = 'S1', kind = 'tax' }) {
  const item = { item_id: 'I-TRY', label, law_id: law, origin: law === 177 || law === 0 ? 'custom' : 'system', item_type: kind === 'tax' ? 'Other Tax' : 'Deduction', tracking_type: kind === 'tax' ? 'Local Income Tax' : 'None', calc: { kind: 'percent', rate }, agency: '' };
  const emp = { employee_id: 'TRY', name: 'Asha Verma', site_id: site, monthly_wages: 4000, addresses: city ? [{ address_id: homeIn(city), from_month: 1 }] : [], items: ['I-TRY'] };
  const co = { ...buckeye, items: [...buckeye.items, item], employees: [...buckeye.employees, emp] };
  const a = analyseCompany(co, data);
  const c = effectiveAll(a, emptyDecisions()).find((x) => x.employee_id === 'TRY');
  return { a, c, model: a.models[c.state] };
}

test('explainLabel gives the same cluster and silhouette as assignLabel, with a distance to every cluster', () => {
  const labels = pool.pools.OH.map((p) => p.label);
  const fitted = clusterLabels(labels, catalog.defined_entries.filter((e) => e.states.includes('OH')), catalog.states.OH.place_names);
  for (const label of ['Pickrngtn Schl W/H', 'OH City Withholding', 'Union Dues', 'zzz']) {
    const x = explainLabel(fitted, label);
    const a = assignLabel(fitted, label);
    assert.equal(x.cluster, a.cluster, label);
    assert.equal(x.silhouette, a.silhouette, label);
    if (x.empty) continue;
    assert.equal(x.distances.length, fitted.clusters.length);
    assert.ok(x.tokens.length > 0);
    // The nearest cluster is the one it is assigned to, and a is its distance.
    const nearest = x.distances.indexOf(Math.min(...x.distances));
    assert.equal(fitted.clusters[nearest].index, x.cluster, label);
    assert.ok(Math.abs(x.a - x.distances[nearest]) < 1e-9);
  }
});

test('a short-form school-district label lands in the school-district cluster and the address picks the exact tax', () => {
  const { c, model } = trial({ label: 'Schl Dist W/H', city: 'Pickerington' });
  const x = model.explain('Schl Dist W/H');
  assert.deepEqual(x.tokens, ['school', 'district', 'withholding']);
  assert.match(x.clusters[0].name, /school/i);
  assert.ok(x.silhouette >= model.thresholds.itemFloor);
  assert.equal(c.route, 'local_tax');
  assert.deepEqual(c.proposal.map((p) => p.tax.law_id), [5307]);
});

test('the same label for someone living in another district picks that district', () => {
  const { c } = trial({ label: 'Schl Dist W/H', city: 'Bremen', rate: 2 });
  assert.equal(c.route, 'local_tax');
  assert.deepEqual(c.proposal.map((p) => p.tax.law_id), [5304]);
});

test('a misspelt label below the confidence floor goes to an expert, though its nearest cluster is right', () => {
  const { c, model } = trial({ label: 'Pickrngtn Schl W/H', city: 'Pickerington' });
  const x = model.explain('Pickrngtn Schl W/H');
  assert.match(x.clusters[0].name, /school/i);
  assert.ok(x.silhouette < model.thresholds.itemFloor, String(x.silhouette));
  assert.equal(x.suggestion.confidence, 'low');
  assert.equal(c.route, 'not_in_database');
  assert.equal(c.reason, 'weak_signal');
});

test('an after-tax deduction is not a tax, and no home address sends the line to an expert', () => {
  assert.equal(trial({ label: 'Local 9 Union Dues', law: 0, kind: 'deduction', city: 'Ashville' }).c.route, 'not_a_tax');
  const none = trial({ label: 'Schl Dist W/H', city: null });
  assert.equal(none.c.route, 'not_in_database');
});

test('a system Law ID names the tax with no clustering', () => {
  const { c } = trial({ label: 'Columbus City Tax', law: 4140, rate: 2.5, site: 'S2' });
  assert.equal(c.route, 'local_tax');
  assert.ok(c.evidence.some((e) => /Law ID 4140 identifies the tax/.test(e.text)));
  assert.deepEqual(c.proposal.map((p) => p.tax.law_id), [4140]);
});

test('an added employee goes through the database and comes back with its Desktop line', () => {
  const item = { item_id: 'I-ADD1', label: 'Schl Dist W/H', law_id: 177, origin: 'custom', item_type: 'Other Tax', tracking_type: 'Local Income Tax', calc: { kind: 'percent', rate: 1 }, agency: '' };
  const emp = { employee_id: 'E-ADD1', name: 'Asha Verma', site_id: 'S1', monthly_wages: 4000, addresses: [{ address_id: homeIn('Pickerington'), from_month: 1 }], items: ['I-ADD1'] };
  const db = createDatabase(SQL, { company: { ...buckeye, items: [...buckeye.items, item], employees: [...buckeye.employees, emp] }, lookup, catalog });
  const back = readData(db, { catalog, lookup, pools: pool.pools });
  db.close();
  const a = analyseCompany(back.companies[0], back);
  const c = a.cases.find((x) => x.employee_id === 'E-ADD1');
  assert.equal(c.item.label, 'Schl Dist W/H');
  assert.equal(c.route, 'local_tax');
  assert.deepEqual(c.proposal.map((p) => p.tax.law_id), [5307]);
});
