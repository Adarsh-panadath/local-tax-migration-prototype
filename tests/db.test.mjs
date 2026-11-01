// The in-browser database: the engine's input rebuilt from SQL must equal the demo files exactly,
// uploaded Desktop CSV files must go through the same engine, and the query box must stay read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createDatabase, readData, runQuery, tableSummary, csvTemplate, companyFromCsv, insertCompany, parseCsv, writeWork, workRows, all, SCHEMA, TABLE_GROUPS, RULE_CHECKS, tryRule, describeTable, exportDatabase } from '../web/db.mjs';
import { analyseCompany } from '../web/engine/analysis.mjs';
import { automate, automationStats, effectiveAll, emptyDecisions } from '../web/engine/workflow.mjs';
import { MODEL_VERSION } from '../web/engine/cluster.mjs';
import { schemaDocs } from '../scripts/schema-docs.mjs';

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

test('the schema has four layers, and every table in them exists', () => {
  const db = createDatabase(SQL, files);
  const groups = tableSummary(db);
  assert.deepStrictEqual(groups.map((g) => g.id), ['reference', 'source', 'work', 'audit']);
  const rows = Object.fromEntries(groups.flatMap((g) => g.tables.map((t) => [t.name, t.rows])));
  assert.equal(rows.companies, companies.companies.length);
  assert.equal(rows.employees, companies.companies.reduce((n, c) => n + c.employees.length, 0));
  assert.equal(rows.addresses, geocoder.addresses.length);
  assert.equal(rows.label_pool, Object.values(pool.pools).reduce((n, l) => n + l.length, 0));
  assert.equal(rows.line_results, 0);
  const inSchema = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'dataset_info'").map((r) => r.name).sort();
  assert.deepStrictEqual(TABLE_GROUPS.flatMap((g) => g.tables).sort(), inSchema, 'every table is in exactly one layer');
});

test('every table has a primary key, and the keys are enforced', () => {
  const db = createDatabase(SQL, files);
  assert.equal(all(db, 'PRAGMA foreign_keys')[0].foreign_keys, 1);
  assert.deepStrictEqual(all(db, 'PRAGMA foreign_key_check'), []);
  for (const name of TABLE_GROUPS.flatMap((g) => g.tables)) {
    assert.ok(describeTable(db, name).columns.some((c) => c.pk), `${name} has a primary key`);
  }
  assert.ok(describeTable(db, 'companies').checks.includes('migration_month BETWEEN 1 AND 12'));
  const emp = describeTable(db, 'employees');
  assert.deepStrictEqual(emp.foreignKeys.map((f) => f.table).sort(), ['companies', 'worksites']);
  assert.ok(emp.linkedFrom.includes('desktop_lines'));
  // Each rule check is refused by the database itself, and nothing changes.
  const before = all(db, 'SELECT COUNT(*) AS n FROM employees')[0].n;
  const expected = { fk: /FOREIGN KEY/, pk: /UNIQUE/, month: /month_1_to_12/, rate: /rate_0_to_100/, line: /FOREIGN KEY/ };
  for (const c of RULE_CHECKS) assert.match(tryRule(db, c.id).refused ?? 'accepted', expected[c.id], c.id);
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM employees')[0].n, before);
  assert.equal(all(db, "SELECT migration_month FROM companies WHERE company_id = 'C-FHS'")[0].migration_month, 10);
});

test('rows in a Desktop file that break a key are kept in import_issues, and the engine still reports them', () => {
  const db = createDatabase(SQL, files);
  const issues = all(db, 'SELECT company_id, employee_id, kind, value FROM import_issues ORDER BY issue_id');
  assert.deepStrictEqual(issues.map((x) => `${x.employee_id} ${x.kind} ${x.value}`), ['E02 unknown_address H-404', 'E03 unknown_item I-OLD', 'E03 repeated_item I-LANC']);
  assert.ok(issues.every((x) => x.company_id === 'C-RPS'));
  const a = analyseCompany(readData(db).companies.find((c) => c.company_id === 'C-RPS'), readData(db));
  assert.ok(a.dataIssues.length >= 3);
});

test('the schema documents in docs are generated from the schema the app runs', async () => {
  const docs = schemaDocs(SQL);
  assert.equal(docs.sql, SCHEMA.trimStart());
  const file = (n) => readFile(new URL(`../docs/${n}`, import.meta.url), 'utf8');
  for (const [name, text] of [['schema.sql', docs.sql], ['schema.md', docs.md], ['schema.mmd', docs.mmd], ['schema-core.mmd', docs.core]]) {
    assert.equal(await file(name), text, `docs/${name} is out of date: run npm run schema`);
  }
});

test('the database exports as a .sqlite file, with the keys still on afterwards', () => {
  const db = createDatabase(SQL, files);
  const bytes = exportDatabase(db);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 15)), 'SQLite format 3');
  assert.equal(all(db, 'PRAGMA foreign_keys')[0].foreign_keys, 1);
  const copy = new SQL.Database(bytes);
  assert.equal(all(copy, 'SELECT COUNT(*) AS n FROM companies')[0].n, companies.companies.length);
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

test('the work tables hold the engine\'s results and every decision, and they obey the keys', () => {
  const db = createDatabase(SQL, files);
  const data = readData(db);
  const analyses = new Map(data.companies.map((c) => [c.company_id, analyseCompany(c, data)]));
  const decided = new Map([...analyses].map(([id, a]) => [id, automate(a, emptyDecisions()).decisions]));
  const rows = workRows({ companies: data.companies, analysisOf: (id) => analyses.get(id), decisionsOf: (id) => decided.get(id) ?? emptyDecisions(), audit: [{ at: '2026-10-31T00:00:00Z', company_id: 'C-FHS', actor: 'Automation', action: 'Confirmed', target: 'x', detail: '' }], modelVersion: MODEL_VERSION });
  writeWork(db, rows);
  const n = (sql) => all(db, sql)[0].n;
  const lines = [...analyses.values()].reduce((s, a) => s + a.cases.length, 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM line_results'), lines, 'one result per Desktop line');
  assert.equal(n('SELECT COUNT(*) AS n FROM desktop_lines'), lines, 'and one Desktop line per result');
  const gaps = [...analyses.values()].reduce((s, a) => s + a.gaps.length, 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM expected_taxes WHERE gap = 1'), gaps, 'gaps come straight out of expected_taxes');
  assert.ok(n("SELECT COUNT(*) AS n FROM decisions WHERE decided_by = 'rule'") > 0);
  assert.equal(n('SELECT COUNT(*) AS n FROM migrations'), companies.companies.length);
  assert.equal(n('SELECT COUNT(*) AS n FROM model_runs'), Object.keys(catalog.states).length);
  assert.equal(n('SELECT COUNT(*) AS n FROM audit_log'), 1);
  assert.deepStrictEqual(all(db, 'PRAGMA foreign_key_check'), []);
  // Fairfield: 16 of 18 items settled by rule (Desktop lines plus added gaps).
  const fhs = all(db, "SELECT COUNT(*) AS n FROM line_results WHERE company_id = 'C-FHS' AND decided_by = 'rule'")[0].n
    + all(db, "SELECT COUNT(*) AS n FROM decisions WHERE company_id = 'C-FHS' AND item_id IS NULL AND decided_by = 'rule'")[0].n;
  assert.equal(fhs, automationStats(analyses.get('C-FHS'), decided.get('C-FHS')).auto);
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
  assert.match(companyFromCsv(ok.replace(',Premium,', ',Gold,'), geocoder, 'U-6').problems.join(' '), /plan must be Core, Premium or Elite/);
  assert.equal(companyFromCsv(ok.replace(',Premium,', ',elite,'), geocoder, 'U-7').company.plan, 'Elite');
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
