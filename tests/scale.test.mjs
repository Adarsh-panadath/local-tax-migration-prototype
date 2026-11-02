// Scale: 60 generated businesses (each with 100+ employees), address corrections, and the ML Lab.
// The app itself loads one of them, Buckeye Supply Co.; the other 59 exist only here, to test the engine at scale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { generateBusinesses, labelSet, GENERATED_COUNT } from '../web/generate.mjs';
import { createDatabase, readData, applyCorrection, lookupIndex } from '../web/db.mjs';
import { runLab } from '../web/mllab.mjs';
import { analyseCompany } from '../web/engine/analysis.mjs';
import { automate, automationStats, exceptions, emptyDecisions } from '../web/engine/workflow.mjs';

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
const withGenerated = { catalog, geocoder: { ...geocoder, addresses: [...geocoder.addresses, ...generated.addresses] }, pools: pool.pools };
const lookup = withGenerated.geocoder.addresses;
const ref = { catalog, lookup, pools: pool.pools };
// One database per migration: each business gets its own.
const dbFor = (c) => createDatabase(SQL, { company: c, lookup, catalog });

test('the generator makes the same 60 businesses every time, each with at least 100 employees', () => {
  assert.equal(generated.companies.length, GENERATED_COUNT);
  assert.deepStrictEqual(generateBusinesses(catalog), generated);
  for (const c of generated.companies) assert.ok(c.employees.length >= 100, `${c.company_id} has ${c.employees.length}`);
  assert.equal(new Set(generated.companies.map((c) => c.name)).size, GENERATED_COUNT);
  assert.equal(generated.companies[0].name, 'Buckeye Supply Co.');
  const employees = generated.companies.reduce((n, c) => n + c.employees.length, 0);
  assert.ok(employees > 9000, `${employees} employees`);
});

test('the app\'s one business is the same Buckeye Supply Co. the scale run starts with', () => {
  const one = generateBusinesses(catalog, { count: 1 });
  assert.equal(one.companies.length, 1);
  assert.deepStrictEqual(one.companies[0], generated.companies[0]);
  assert.equal(one.companies[0].employees.length, 152);
  const ids = new Set(one.companies[0].worksites.map((w) => w.address_id).concat(one.companies[0].employees.flatMap((e) => e.addresses.map((a) => a.address_id))));
  const known = new Set(one.addresses.map((a) => a.address_id));
  for (const id of ids) assert.ok(known.has(id) || geocoder.addresses.some((a) => a.address_id === id), `address ${id} is in the one-business lookup`);
});

test('every generated business goes through the engine, and most lines settle by rule', () => {
  let auto = 0;
  let total = 0;
  const reasons = new Set();
  for (const c of generated.companies) {
    const a = analyseCompany(c, withGenerated); // throws on a file the engine would stop on
    const res = automate(a, emptyDecisions());
    const st = automationStats(a, res.decisions);
    auto += st.auto;
    total += st.total;
    for (const x of exceptions(a, res.decisions)) reasons.add(x.reason);
  }
  assert.ok(auto / total > 0.9, `settled ${auto} of ${total}`);
  assert.ok(auto / total < 1, 'some lines must still need a person');
  for (const r of ['no_address', 'address_unresolved', 'weak_signal']) assert.ok(reasons.has(r), `expected some ${r}`);
});

// An empty field (null) reads back as absent; everything else must come back exactly.
const dropEmpty = (v) => JSON.parse(JSON.stringify(v, (k, x) => (x === null ? undefined : x)));

test('every generated business round-trips through its own database exactly', () => {
  for (const c of generated.companies) {
    const db = dbFor(c);
    assert.deepStrictEqual(readData(db, ref).companies, [dropEmpty(c)], c.company_id);
    db.close();
  }
});

test('an employer adding a missing home address settles the lines that waited for it', () => {
  const flag = generated.companies[0];
  const db = dbFor(flag);
  const a0 = analyseCompany(flag, withGenerated);
  const noAddr = a0.cases.filter((c) => c.reason === 'no_address');
  assert.ok(noAddr.length >= 1);
  const who = noAddr[0].employee_id;
  // A Lancaster address the lookup knows.
  const known = generated.addresses.find((x) => x.city === 'Lancaster' && x.school_district === '2305');
  const r = applyCorrection(db, { company_id: 'G-001', employee_id: who, line1: known.line1, city: 'Lancaster', state: 'OH', zip: known.zip, at: '2026-10-31T00:00:00Z' }, lookupIndex(lookup), lookup);
  assert.equal(r.found, true);
  const back = readData(db, ref);
  const a1 = analyseCompany(back.companies[0], back);
  assert.ok(!a1.cases.some((c) => c.employee_id === who && c.reason === 'no_address'), 'the line no longer waits for an address');
  const before = automationStats(a0, automate(a0, emptyDecisions()).decisions).auto;
  const after = automationStats(a1, automate(a1, emptyDecisions()).decisions).auto;
  assert.ok(after > before, `rules settle more after the fix (${before} → ${after})`);
  // An address the lookup has never seen is kept, and the lookup cannot place it: an expert decides.
  const other = noAddr.find((c) => c.employee_id !== who)?.employee_id ?? a0.company.employees.find((e) => e.employee_id !== who).employee_id;
  const r2 = applyCorrection(db, { company_id: 'G-001', employee_id: other, line1: '1 Nowhere Ln', city: 'Lancaster', state: 'OH', zip: '43130', at: '2026-10-31T00:00:00Z' }, lookupIndex(lookup), lookup);
  assert.equal(r2.found, false);
  const back2 = readData(db, ref);
  const a2 = analyseCompany(back2.companies[0], back2);
  assert.ok(a2.cases.some((c) => c.employee_id === other && c.reason === 'address_unresolved'));
});

test('lines waiting for a home address are the employer\'s to fix; weak labels stay with an expert', () => {
  const a = analyseCompany(generated.companies[0], withGenerated);
  const left = exceptions(a, automate(a, emptyDecisions()).decisions);
  const addr = left.filter((x) => x.needs === 'address');
  assert.equal(addr.length, 3);
  assert.ok(addr.every((x) => x.owner === 'employer' && ['no_address', 'address_unresolved'].includes(x.reason)));
  const weak = left.filter((x) => x.reason === 'weak_signal');
  assert.ok(weak.length > 0 && weak.every((x) => x.owner === 'expert' && !x.needs));
});

test('the ML Lab holds labels back, and its suggestions are precise; the gate keeps this messier set in shadow mode', () => {
  const lab = runLab(catalog, { map: false });
  assert.equal(lab.total, 1200);
  assert.equal(lab.trainSize + lab.testSize, 1200);
  assert.ok(lab.unseen > 0, 'some test labels were never seen in training');
  assert.ok(lab.model.precision >= 0.95, `precision ${lab.model.precision}`);
  assert.ok(lab.model.coverage > 0.6 && lab.model.coverage < 1, `coverage ${lab.model.coverage}`);
  assert.ok(lab.silhouette < 0.5, 'below the BRD gate: this state would stay in shadow mode');
  assert.equal(lab.curve.length, lab.maxK - 1);
  assert.ok(lab.clusters.every((c) => c.purity > 0 && c.purity <= 1));
  // Same seed, same answer.
  assert.deepStrictEqual(runLab(catalog, { map: false }).model, lab.model);
  assert.equal(labelSet().length, 1200);
});
