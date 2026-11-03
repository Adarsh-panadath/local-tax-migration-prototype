// The in-browser database: one database per migration. The business read back from SQL must equal the file,
// the engine must give the same answers either way, the keys must be enforced, and the query box stays read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createDatabase, readData, runQuery, tableSummary, csvTemplate, companyFromCsv, parseCsv, writeResults, resultRows, all, SCHEMA, TABLE_GROUPS, RULE_CHECKS, tryRule, describeTable, exportDatabase } from '../web/db.mjs';
import { analyseCompany } from '../web/engine/analysis.mjs';
import { automate, automationStats, emptyDecisions } from '../web/engine/workflow.mjs';
import { generateBusinesses } from '../web/generate.mjs';
import { schemaDocs } from '../scripts/schema-docs.mjs';
import { asStored } from './helpers.mjs';

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
const gen = generateBusinesses(catalog, { count: 1 });
const buckeye = gen.companies[0];
const lookup = [...geocoder.addresses, ...gen.addresses];
const ref = { catalog, lookup, pools: pool.pools };
const files = { catalog, geocoder: { addresses: lookup }, pools: pool.pools };
const dbFor = (company, addresses = []) => createDatabase(SQL, { company, addresses, lookup, catalog });
const pick = (x) => ({ cases: x.cases.map((k) => [k.case_id, k.route, k.reason, k.proposal.map((p) => `${p.tax.tax_id} ${p.months}`)]), gaps: x.gaps.map((g) => g.gap_id), issues: x.dataIssues.map((d) => d.text) });
const auto = (x) => automationStats(x, automate(x, emptyDecisions()).decisions);

test('the business reads back from its database as it was written', () => {
  const back = readData(dbFor(buckeye), ref);
  assert.deepStrictEqual(back.companies, [asStored(buckeye)]);
  assert.equal(back.catalog, catalog);
  assert.equal(back.geocoder.addresses.length, lookup.length, 'no address typed by the employer yet');
});

test('the engine gives the same answers from the database as from the file', () => {
  for (const c of [buckeye, ...companies.companies.filter((x) => x.company_id !== 'C-RPS')]) {
    const back = readData(dbFor(c), ref);
    assert.deepStrictEqual(back.companies[0], asStored(c), c.company_id);
    const a = analyseCompany(c, files);
    const b = analyseCompany(back.companies[0], back);
    assert.deepStrictEqual(pick(b), pick(a), c.company_id);
    assert.deepStrictEqual(auto(b), auto(a), c.company_id);
  }
});

test('a Desktop file that breaks a key is refused by the database', () => {
  // Ridgeview's file points at an address nobody knows and an item that does not exist.
  assert.throws(() => dbFor(companies.companies.find((x) => x.company_id === 'C-RPS')), /FOREIGN KEY/);
  const twice = structuredClone(buckeye);
  twice.employees[0].items.push(twice.employees[0].items[0]);
  assert.throws(() => dbFor(twice), /UNIQUE constraint failed: desktop_lines/);
  const movedTwice = structuredClone(buckeye);
  movedTwice.employees[0].addresses.push({ address_id: movedTwice.employees[1].addresses[0].address_id, from_month: 8 }, { address_id: movedTwice.employees[2].addresses[0].address_id, from_month: 11 });
  assert.throws(() => dbFor(movedTwice), /one move a year/);
});

test('seven tables in three groups, one database per migration, no company id outside the company table', () => {
  const db = dbFor(buckeye);
  const groups = tableSummary(db);
  assert.deepStrictEqual(groups.map((g) => g.id), ['desktop', 'lookup', 'results']);
  assert.deepStrictEqual(groups.map((g) => g.tables.map((t) => t.name)), [['company', 'employees', 'payroll_items', 'desktop_lines'], ['addresses', 'taxes'], ['results']]);
  const rows = Object.fromEntries(groups.flatMap((g) => g.tables.map((t) => [t.name, t.rows])));
  assert.deepStrictEqual(rows, { company: 1, employees: 152, payroll_items: 12, desktop_lines: 313, addresses: rows.addresses, taxes: rows.taxes, results: 0 });
  // Only the addresses this business uses go in.
  const used = new Set([...buckeye.worksites.map((w) => w.address_id), ...buckeye.employees.flatMap((e) => e.addresses.map((a) => a.address_id))]);
  assert.equal(rows.addresses, used.size);
  const inSchema = all(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name).sort();
  assert.deepStrictEqual(TABLE_GROUPS.flatMap((g) => g.tables).sort(), inSchema, 'every table is in exactly one group');
  for (const t of inSchema.filter((x) => x !== 'company')) assert.ok(!describeTable(db, t).columns.some((c) => c.name === 'company_id'), t);
  // The movers: the new address and the month are on the employee's row.
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM employees WHERE new_home_address_id IS NOT NULL')[0].n, buckeye.employees.filter((e) => e.addresses.length === 2).length);
});

test('every table has a primary key, and the keys are enforced', () => {
  const db = dbFor(buckeye);
  assert.equal(all(db, 'PRAGMA foreign_keys')[0].foreign_keys, 1);
  assert.deepStrictEqual(all(db, 'PRAGMA foreign_key_check'), []);
  for (const name of TABLE_GROUPS.flatMap((g) => g.tables)) {
    assert.ok(describeTable(db, name).columns.some((c) => c.pk), `${name} has a primary key`);
  }
  assert.ok(describeTable(db, 'company').checks.includes('migration_month BETWEEN 1 AND 12'));
  const emp = describeTable(db, 'employees');
  assert.deepStrictEqual(emp.foreignKeys.map((f) => f.from.join()), ['work_address_id', 'home_address_id', 'new_home_address_id']);
  assert.ok(emp.foreignKeys.every((f) => f.table === 'addresses'));
  assert.ok(emp.linkedFrom.includes('desktop_lines'));
  // Each rule check is refused by the database itself, and nothing changes.
  const before = all(db, 'SELECT COUNT(*) AS n FROM employees')[0].n;
  const expected = { fk: /FOREIGN KEY/, pk: /UNIQUE constraint failed: employees.employee_id/, month: /month_1_to_12/, rate: /rate_0_to_100/, line: /FOREIGN KEY/ };
  for (const c of RULE_CHECKS) assert.match(tryRule(db, c.id).refused ?? 'accepted', expected[c.id], c.id);
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM employees')[0].n, before);
  assert.equal(all(db, 'SELECT migration_month FROM company')[0].migration_month, 10);
});

test('the schema documents in docs are generated from the schema the app runs', async () => {
  const docs = schemaDocs(SQL);
  assert.equal(docs.sql, SCHEMA.trimStart());
  const file = (n) => readFile(new URL(`../docs/${n}`, import.meta.url), 'utf8');
  for (const [name, text] of [['schema.sql', docs.sql], ['schema.md', docs.md], ['schema.mmd', docs.mmd]]) {
    assert.equal(await file(name), text, `docs/${name} is out of date: run npm run schema`);
  }
});

test('the database exports as a .sqlite file, with the keys still on afterwards', () => {
  const db = dbFor(buckeye);
  const bytes = exportDatabase(db);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 15)), 'SQLite format 3');
  assert.equal(all(db, 'PRAGMA foreign_keys')[0].foreign_keys, 1);
  const copy = new SQL.Database(bytes);
  assert.equal(all(copy, 'SELECT name FROM company')[0].name, 'Buckeye Supply Co.');
});

test('the query box runs one SELECT and nothing that changes data', () => {
  const db = dbFor(buckeye);
  const r = runQuery(db, 'SELECT name, plan FROM company');
  assert.deepStrictEqual(r.columns, ['name', 'plan']);
  assert.deepStrictEqual(r.rows[0], ['Buckeye Supply Co.', 'Premium']);
  assert.equal(runQuery(db, 'WITH x AS (SELECT 1 AS n) SELECT n FROM x;').rows[0][0], 1);
  assert.throws(() => runQuery(db, 'DELETE FROM employees'), /Only SELECT/);
  assert.throws(() => runQuery(db, 'SELECT 1; DROP TABLE employees'), /one query/);
  assert.throws(() => runQuery(db, '   '), /Type a query/);
  assert.equal(runQuery(db, 'SELECT COUNT(*) FROM employees').rows[0][0], 152);
});

test('the results table holds where every line went, and obeys the keys', () => {
  const db = dbFor(buckeye);
  const back = readData(db, ref);
  const a = analyseCompany(back.companies[0], back);
  const decided = automate(a, emptyDecisions()).decisions;
  writeResults(db, resultRows({ analysis: a, decisions: decided }));
  const n = (sql) => all(db, sql)[0].n;
  assert.equal(n('SELECT COUNT(*) AS n FROM results'), 313, 'one result per Desktop line');
  assert.equal(n("SELECT COUNT(*) AS n FROM results WHERE route = 'local_tax'"), n('SELECT COUNT(*) AS n FROM results WHERE law_id IS NOT NULL'), 'every local tax line names its Online tax by Law ID');
  // The Law ID story: custom items (177) end up on a real Law ID; system items keep their own.
  const moved = all(db, "SELECT p.law_id AS desktop, r.law_id AS online FROM results r JOIN payroll_items p ON p.item_id = r.item_id WHERE r.route = 'local_tax'");
  assert.ok(moved.some((x) => x.desktop === 177 && x.online !== 177), 'a custom item gets a real Law ID');
  assert.ok(moved.filter((x) => x.desktop !== 177 && x.desktop !== 0).every((x) => x.desktop === x.online), 'a system item keeps its Law ID');
  // 313 of 318 items settled by rule: Desktop lines plus taxes nobody withheld.
  assert.equal(n("SELECT COUNT(*) AS n FROM results WHERE decided_by = 'rule'") + a.gaps.length, automationStats(a, decided).auto);
  assert.equal(automationStats(a, decided).auto, 313);
  // A mover's line names the tax at the new address, the one that goes live in October.
  const mover = buckeye.employees.find((e) => e.addresses.length === 2 && e.addresses[1].from_month <= 10 && e.items.length);
  const live = all(db, "SELECT t.code, a.school_district FROM results r JOIN employees e ON e.employee_id = r.employee_id JOIN addresses a ON a.address_id = e.new_home_address_id JOIN taxes t ON t.law_id = r.law_id WHERE r.employee_id = ? AND t.type = 'school_district'", [mover.employee_id]);
  assert.ok(live.length && live.every((r) => r.code === r.school_district), JSON.stringify(live));
  assert.deepStrictEqual(all(db, 'PRAGMA foreign_key_check'), []);
  // Writing again replaces the results; it does not add to them.
  writeResults(db, resultRows({ analysis: a, decisions: decided }));
  assert.equal(n('SELECT COUNT(*) AS n FROM results'), 313);
});

test('the CSV template uploads cleanly and runs through the engine', () => {
  const text = csvTemplate(geocoder);
  const { company, addresses, problems } = companyFromCsv(text, geocoder, 'U-1');
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(addresses, []); // every template address is in the demo lookup
  assert.equal(company.employees.length, 3);
  assert.equal(company.items.length, 2);
  const back = readData(dbFor(company, addresses), ref);
  const up = back.companies[0];
  assert.deepStrictEqual(up, asStored(company));
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
  const back = readData(dbFor(r.company, r.addresses), ref);
  assert.equal(back.geocoder.addresses.at(-1).school_district, 'UNRESOLVED', 'kept, and the lookup cannot place it');
  const a = analyseCompany(back.companies[0], back);
  assert.equal(a.cases[0].route, 'not_in_database');
  assert.equal(a.cases[0].reason, 'address_unresolved');

  assert.match(companyFromCsv('a,b\n1,2\n', geocoder, 'U-3').problems[0], /Missing columns/);
  const badSite = ok.replace('1200 Mill Park Dr', '1 Unknown Rd');
  assert.match(companyFromCsv(badSite, geocoder, 'U-4').problems.join(' '), /Work site "Store" is not an address/);
  assert.match(companyFromCsv(ok.replace(',3000,', ',lots,'), geocoder, 'U-5').problems.join(' '), /monthly_wages must be a number/);
  assert.match(companyFromCsv(ok.replace(',Premium,', ',Gold,'), geocoder, 'U-6').problems.join(' '), /plan must be Core, Premium or Elite/);
  assert.equal(companyFromCsv(ok.replace(',Premium,', ',elite,'), geocoder, 'U-7').company.plan, 'Elite');
});

test('a Law ID names the tax: a known one maps directly, an unknown one stops the file', () => {
  const head = 'company_name,plan,migration_month,employee_id,employee_name,monthly_wages,home_address,home_city,home_state,home_zip,work_site,work_address,work_city,work_state,work_zip,item_label,law_id,item_type,tracking_type,rate_percent,agency';
  const row = (law) => `${head}\nNew Co,Premium,10,N1,Ann Lee,3000,${geocoder.addresses.find((a) => a.address_id === 'H-001').line1},Lancaster,OH,43130,Store,1200 Mill Park Dr,Lancaster,OH,43130,Columbus City Tax,${law},Other Tax,Local Income Tax,2.5,City of Columbus\n`;
  // 4120 is Lancaster's city tax: the item maps by its Law ID, whatever its label says.
  const known = companyFromCsv(row(4120), geocoder, 'U-L1');
  assert.deepStrictEqual(known.problems, []);
  const a = analyseCompany(known.company, files);
  assert.equal(a.cases[0].route, 'local_tax');
  assert.equal(a.cases[0].proposal[0].tax.law_id, 4120);
  assert.match(a.cases[0].evidence.find((e) => e.step === 3).text, /Law ID 4120 identifies the tax/);
  // A Law ID no tax has: the engine stops and says so.
  const unknown = companyFromCsv(row(9999), geocoder, 'U-L2');
  assert.throws(() => analyseCompany(unknown.company, files), (err) => err.issues.some((x) => /Law ID 9999/.test(x.text)));
});

test('the CSV reader handles quotes, commas and line endings', () => {
  assert.deepStrictEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\n\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
});
