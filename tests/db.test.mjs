// The in-browser database: the engine's input rebuilt from SQL must equal the demo files exactly,
// uploaded Desktop CSV files must go through the same engine, and the query box must stay read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createDatabase, readData, runQuery, tableSummary, csvTemplate, companyFromCsv, insertCompany, parseCsv, writeOutcomes } from '../web/db.mjs';
import { analyseCompany } from '../web/engine/analysis.mjs';
import { automate, automationStats, effectiveAll, emptyDecisions } from '../web/engine/workflow.mjs';

const require = createRequire(import.meta.url);
const read = async (f) => JSON.parse(await readFile(new URL(`../data/${f}`, import.meta.url), 'utf8'));

// sql.js ships as a browser/CommonJS bundle; load it the same way in Node, with the vendored .wasm.
async function loadSql() {
  const code = await readFile(new URL('../web/vendor/sql-wasm.js', import.meta.url), 'utf8');
  const module = { exports: {} };
  const file = new URL('../web/vendor/sql-wasm.js', import.meta.url).pathname;
  new Function('module', 'exports', 'require', '__dirname', '__filename', code)(module, module.exports, require, file.replace(/[^/]+$/, ''), file);
  const wasmBinary = await readFile(new URL('../web/vendor/sql-wasm.wasm', import.meta.url));
  return module.exports({ wasmBinary });
}

const SQL = await loadSql();
const [catalog, geocoder, pool, companies] = await Promise.all(['catalog.json', 'geocoder.json', 'label-pool.json', 'companies.json'].map(read));
const files = { catalog, geocoder, pools: pool.pools, poolMeta: pool.metadata, companies: companies.companies, companiesMeta: companies.metadata };

test('the database rebuilds every demo file exactly', () => {
  const db = createDatabase(SQL, files);
  const back = readData(db);
  assert.deepStrictEqual(back.catalog, catalog);
  assert.deepStrictEqual(back.geocoder, geocoder);
  assert.deepStrictEqual(back.pools, pool.pools);
  assert.deepStrictEqual(back.poolMeta, pool.metadata);
  assert.deepStrictEqual(back.companiesMeta, companies.metadata);
  assert.equal(back.companies.length, companies.companies.length);
  for (let i = 0; i < companies.companies.length; i += 1) assert.deepStrictEqual(back.companies[i], companies.companies[i], companies.companies[i].company_id);
});

test('the engine gives the same answers from the database as from the files', () => {
  const back = readData(createDatabase(SQL, files));
  const fromFiles = { catalog, geocoder, pools: pool.pools };
  for (const c of companies.companies) {
    const a = analyseCompany(c, fromFiles);
    const b = analyseCompany(back.companies.find((x) => x.company_id === c.company_id), back);
    const pick = (x) => ({ cases: x.cases.map((k) => [k.case_id, k.route, k.reason, k.proposal.map((p) => p.tax.tax_id)]), gaps: x.gaps.map((g) => g.gap_id), issues: x.dataIssues.map((d) => d.text) });
    assert.deepStrictEqual(pick(b), pick(a), c.company_id);
    const auto = (x) => automationStats(x, automate(x, emptyDecisions()).decisions);
    assert.deepStrictEqual(auto(b), auto(a), c.company_id);
  }
});

test('the table summary groups customer data, tax reference and outcomes', () => {
  const db = createDatabase(SQL, files);
  const groups = tableSummary(db);
  assert.deepStrictEqual(groups.map((g) => g.id), ['customer', 'reference', 'outcome']);
  const rows = Object.fromEntries(groups.flatMap((g) => g.tables.map((t) => [t.name, t.rows])));
  assert.equal(rows.companies, companies.companies.length);
  assert.equal(rows.employees, companies.companies.reduce((n, c) => n + c.employees.length, 0));
  assert.equal(rows.address_lookup, geocoder.addresses.length);
  assert.equal(rows.label_pool, Object.values(pool.pools).reduce((n, l) => n + l.length, 0));
  assert.equal(rows.line_outcomes, 0);
});

test('the query box runs one SELECT and nothing that changes data', () => {
  const db = createDatabase(SQL, files);
  const r = runQuery(db, 'SELECT name, plan FROM companies ORDER BY sort');
  assert.deepStrictEqual(r.columns, ['name', 'plan']);
  assert.equal(r.rows[0][0], 'Fairfield Hardware Supply');
  assert.equal(runQuery(db, 'WITH x AS (SELECT 1 AS n) SELECT n FROM x;').rows[0][0], 1);
  assert.throws(() => runQuery(db, 'DELETE FROM companies'), /Only SELECT/);
  assert.throws(() => runQuery(db, 'SELECT 1; DROP TABLE companies'), /one query/);
  assert.throws(() => runQuery(db, '   '), /Type a query/);
  assert.equal(runQuery(db, 'SELECT COUNT(*) FROM companies').rows[0][0], companies.companies.length);
});

test('outcomes are written to their own tables', () => {
  const db = createDatabase(SQL, files);
  writeOutcomes(db, [{ company_id: 'C-FHS', line_id: 'x', employee: 'A', desktop_item: 'SD WH', state: 'OH', route: 'local_tax', reason: null, stage: 'confirmed', online_tax: 'Lancaster City School District', decided_by: 'Rule', rule: 'confirm_matches' }], [{ at: '2026-10-31T00:00:00Z', company_id: 'C-FHS', actor: 'Automation', action: 'Confirmed', target: 'A: SD WH', detail: '' }]);
  assert.equal(runQuery(db, 'SELECT COUNT(*) FROM line_outcomes').rows[0][0], 1);
  assert.equal(runQuery(db, 'SELECT actor FROM decision_log').rows[0][0], 'Automation');
});

test('the CSV template uploads cleanly and runs through the engine', () => {
  const text = csvTemplate(geocoder);
  const { company, addresses, problems } = companyFromCsv(text, geocoder, 'U-1');
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(addresses, []); // every template address is in the demo lookup
  assert.equal(company.employees.length, 3);
  assert.equal(company.items.length, 2);
  const db = createDatabase(SQL, files, [{ company, addresses }]);
  const back = readData(db);
  const up = back.companies.find((c) => c.company_id === 'U-1');
  assert.deepStrictEqual(up, company);
  const a = analyseCompany(up, back);
  assert.equal(a.cases.length, 6);
  assert.deepStrictEqual(a.dataIssues, []);
  const routes = Object.fromEntries(['local_tax', 'not_a_tax', 'not_in_database'].map((r) => [r, a.cases.filter((c) => c.route === r).length]));
  assert.equal(routes.local_tax + routes.not_a_tax + routes.not_in_database, 6);
  // The Columbus resident's school-district line is not expected at that address.
  const omar = a.cases.find((c) => c.employee_name === 'Omar Haddad' && c.item.label === 'SD W/H');
  assert.equal(omar.route, 'not_in_database');
  assert.equal(omar.reason, 'not_expected');
});

test('an address the lookup has never seen goes to an expert, and a broken file is refused', () => {
  const head = 'company_name,plan,migration_month,employee_id,employee_name,monthly_wages,home_address,home_city,home_state,home_zip,work_site,work_address,work_city,work_state,work_zip,item_label,law_id,item_type,tracking_type,rate_percent,agency';
  const ok = `${head}\nNew Co,Premium,10,N1,Ann Lee,3000,99 Nowhere Ln,Lancaster,OH,43130,Store,1200 Mill Park Dr,Lancaster,OH,43130,School Tax,177,Other Tax,Local Income Tax,1.5,Ohio Dept of Taxation\n`;
  const r = companyFromCsv(ok, geocoder, 'U-2');
  assert.deepStrictEqual(r.problems, []);
  assert.equal(r.addresses.length, 1);
  const db = createDatabase(SQL, files, [{ company: r.company, addresses: r.addresses }]);
  const back = readData(db);
  const a = analyseCompany(back.companies.find((c) => c.company_id === 'U-2'), back);
  assert.equal(a.cases[0].route, 'not_in_database');
  assert.equal(a.cases[0].reason, 'address_unresolved');

  assert.match(companyFromCsv('a,b\n1,2\n', geocoder, 'U-3').problems[0], /Missing columns/);
  const badSite = ok.replace('1200 Mill Park Dr', '1 Unknown Rd');
  assert.match(companyFromCsv(badSite, geocoder, 'U-4').problems.join(' '), /Work site "Store" is not an address/);
  assert.match(companyFromCsv(ok.replace(',3000,', ',lots,'), geocoder, 'U-5').problems.join(' '), /monthly_wages must be a number/);
});

test('the CSV reader handles quotes, commas and line endings', () => {
  assert.deepStrictEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('a company inserted later is read back like the rest', () => {
  const db = createDatabase(SQL, files);
  const c = structuredClone(companies.companies[1]);
  c.company_id = 'COPY';
  insertCompany(db, c, 'upload', 50);
  assert.deepStrictEqual(readData(db).companies.find((x) => x.company_id === 'COPY'), c);
  assert.ok(effectiveAll(analyseCompany(c, { catalog, geocoder, pools: pool.pools }), emptyDecisions()).length > 0);
});
