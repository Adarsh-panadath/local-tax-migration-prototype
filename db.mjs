import { effectiveAll } from './engine/workflow.mjs?v=93cbd9ba74';
import { monthSpan } from './engine/util.mjs?v=93cbd9ba74';

// The demo's database: SQLite (sql.js, compiled to WebAssembly) running inside the page.
// No server, no account and no keys. It is rebuilt every time the page opens.
//
// One database per migration: it holds the one business being moved, so no table needs a company id.
// Three groups of tables (SCHEMA below, also in docs/schema.sql):
//   Desktop file      what the business brings: company, work sites, employees, home addresses, items, lines
//   Tax lookup        Intuit's data, only what this business needs: its addresses and the taxes
//   Migration results what the engine found and what people decided
// Every table has a primary key; foreign keys and CHECK rules are on, so the database itself refuses
// a row that points at nothing or holds an impossible value.
//
// The engine reads the business back from these tables (readData), so the screens show what is in them.

export const SCHEMA = `-- Local Tax Migration: the database schema.
-- SQLite, in standard SQL: the same tables run on PostgreSQL with small type changes.
--
-- One database per migration. It holds the one business being moved, so no table needs a company id.
--   1. Desktop file       what the business brings (copied in, never edited)
--   2. Tax lookup         Intuit's data, only what this business needs
--   3. Migration results  what the engine found and what people decided
--
-- Every table has a primary key. Foreign keys link the tables, and CHECK rules refuse impossible values.

PRAGMA foreign_keys = ON;

-- =====================================================================
-- 1. DESKTOP FILE
-- =====================================================================

-- The business being moved: one row.
CREATE TABLE company (
  company_id       TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  plan             TEXT NOT NULL CHECK (plan IN ('Core', 'Premium', 'Elite')),
  migration_month  INTEGER NOT NULL CONSTRAINT month_1_to_12 CHECK (migration_month BETWEEN 1 AND 12),
  description      TEXT
);

CREATE TABLE worksites (
  site_id     TEXT PRIMARY KEY,
  name        TEXT,
  address_id  TEXT NOT NULL REFERENCES addresses (address_id)
);

CREATE TABLE employees (
  employee_id    TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  site_id        TEXT NOT NULL REFERENCES worksites (site_id),
  monthly_wages  REAL NOT NULL CONSTRAINT wages_not_negative CHECK (monthly_wages >= 0),
  remote         INTEGER CHECK (remote IN (0, 1)),
  hired_month    INTEGER CHECK (hired_month BETWEEN 1 AND 12),
  left_month     INTEGER CHECK (left_month BETWEEN 1 AND 12)
);

-- Where each employee lives. A move adds a second row from the month it starts.
CREATE TABLE home_addresses (
  employee_id  TEXT NOT NULL REFERENCES employees (employee_id),
  from_month   INTEGER NOT NULL CHECK (from_month BETWEEN 1 AND 12),
  address_id   TEXT NOT NULL REFERENCES addresses (address_id),
  PRIMARY KEY (employee_id, from_month)
);

-- A payroll item as set up in Desktop, with the label exactly as someone typed it.
-- Law ID 177 or 0 = an item the employer created.
CREATE TABLE payroll_items (
  item_id            TEXT PRIMARY KEY,
  label              TEXT,
  law_id             INTEGER,
  origin             TEXT NOT NULL CHECK (origin IN ('custom', 'system')),
  item_type          TEXT,
  tracking_type      TEXT,                           -- None = Desktop treats it as an after-tax deduction
  calc_kind          TEXT NOT NULL CHECK (calc_kind IN ('percent', 'flat_annual')),
  calc_rate          REAL CONSTRAINT item_rate_0_to_100 CHECK (calc_rate BETWEEN 0 AND 100),
  calc_amount        REAL CHECK (calc_amount >= 0),
  agency             TEXT,
  agency_account     TEXT,
  deposit_frequency  TEXT,
  system_tax_id      TEXT REFERENCES taxes (tax_id)  -- system items only: the tax Desktop already knows
);

-- One row per employee per payroll item: a Desktop local tax line.
CREATE TABLE desktop_lines (
  employee_id  TEXT NOT NULL REFERENCES employees (employee_id),
  item_id      TEXT NOT NULL REFERENCES payroll_items (item_id),
  PRIMARY KEY (employee_id, item_id)
);

-- =====================================================================
-- 2. TAX LOOKUP (Intuit)
-- =====================================================================

-- The addresses this business uses, with the school district and city the lookup places them in.
-- source = employer: typed by the employer and unknown to the lookup (school_district UNRESOLVED).
CREATE TABLE addresses (
  address_id       TEXT PRIMARY KEY,
  line1            TEXT,
  city             TEXT,
  state            TEXT,
  zip              TEXT,
  school_district  TEXT,                             -- the same code as taxes.code
  municipality     TEXT,
  source           TEXT NOT NULL CHECK (source IN ('lookup', 'employer'))
);

-- The local taxes Online payroll knows.
CREATE TABLE taxes (
  tax_id             TEXT PRIMARY KEY,               -- OH-SD-2305
  state              TEXT NOT NULL,
  type               TEXT NOT NULL CHECK (type IN ('school_district', 'municipal', 'earned_income', 'local_services')),
  code               TEXT,                           -- school-district number
  name               TEXT NOT NULL,
  rate               REAL NOT NULL CONSTRAINT rate_0_to_100 CHECK (rate BETWEEN 0 AND 100),   -- percent
  basis              TEXT NOT NULL CHECK (basis IN ('home', 'work', 'higher')),
  agency             TEXT,
  qb_pays_and_files  INTEGER NOT NULL CHECK (qb_pays_and_files IN (0, 1))
);

-- =====================================================================
-- 3. MIGRATION RESULTS
-- =====================================================================

-- What each employee's addresses say they owe. gap = 1: owed, but no Desktop line withholds it.
CREATE TABLE expected_taxes (
  employee_id  TEXT NOT NULL REFERENCES employees (employee_id),
  tax_id       TEXT NOT NULL REFERENCES taxes (tax_id),
  months       TEXT NOT NULL,
  required     INTEGER NOT NULL CHECK (required IN (0, 1)),   -- 0 = optional courtesy withholding
  gap          INTEGER NOT NULL CHECK (gap IN (0, 1)),
  PRIMARY KEY (employee_id, tax_id)
);

-- Where each Desktop line stands now: its route, why, the Online tax, and who settled it.
CREATE TABLE line_results (
  employee_id  TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  route        TEXT NOT NULL CONSTRAINT route_value CHECK (route IN ('local_tax', 'not_a_tax', 'not_in_database', 'custom_entry', 'stop')),
  reason       TEXT,                                 -- why it needs a person: weak_signal, no_address ...
  stage        TEXT NOT NULL CHECK (stage IN ('awaiting_employer', 'with_expert', 'confirmed', 'moved_to_deduction', 'employer_managed', 'stopped')),
  online_tax   TEXT,
  decided_by   TEXT CHECK (decided_by IN ('rule', 'employer', 'expert')),
  rule         TEXT,
  PRIMARY KEY (employee_id, item_id),
  FOREIGN KEY (employee_id, item_id) REFERENCES desktop_lines (employee_id, item_id)
);

-- Who did what and when: every rule, employer and expert decision.
CREATE TABLE decision_log (
  log_id  INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  who     TEXT NOT NULL,                             -- Automation, Employer, Expert, Admin
  action  TEXT NOT NULL,
  line    TEXT,                                      -- the employee and Desktop item it is about
  detail  TEXT
);
`;

// The three groups, for the Data page.
export const TABLE_GROUPS = [
  { id: 'desktop', title: 'Desktop file', owner: 'The business', tables: ['company', 'worksites', 'employees', 'home_addresses', 'payroll_items', 'desktop_lines'] },
  { id: 'lookup', title: 'Tax lookup', owner: 'Intuit', tables: ['addresses', 'taxes'] },
  { id: 'results', title: 'Migration results', owner: 'Engine and people', tables: ['expected_taxes', 'line_results', 'decision_log'] },
];

// What each table holds, in one line.
export const TABLE_NOTES = {
  company: 'The business being moved: one row.',
  worksites: 'Where its people work.',
  employees: 'The people on the payroll.',
  home_addresses: 'Where each employee lives; a move adds a row from the month it starts.',
  payroll_items: 'Payroll items as set up in Desktop, with the label exactly as typed.',
  desktop_lines: 'One row per employee per payroll item: a Desktop local tax line.',
  addresses: 'The addresses this business uses, with the school district and city the lookup places them in.',
  taxes: 'The local taxes Online payroll knows: rate, basis and agency.',
  expected_taxes: 'What each employee\'s addresses say they owe. gap = 1: owed, but nothing withholds it.',
  line_results: 'Where each Desktop line stands: route, Online tax, and who settled it.',
  decision_log: 'Who did what and when.',
};

// ---------- loading sql.js ----------

let sqlPromise = null;
// In the browser: load the vendored sql.js script once and point it at the vendored .wasm file.
export function loadSqlJs() {
  sqlPromise ??= new Promise((resolve, reject) => {
    const base = new URL('./vendor/', import.meta.url);
    const start = () => window.initSqlJs({ locateFile: (file) => new URL(file, base).href }).then(resolve, reject);
    if (window.initSqlJs) { start(); return; }
    const s = document.createElement('script');
    s.src = new URL('sql-wasm.js', base).href;
    s.onload = start;
    s.onerror = () => reject(new Error('sql.js did not load'));
    document.head.append(s);
  });
  return sqlPromise;
}

// ---------- helpers ----------

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function insert(db, table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  try {
    for (const r of rows) stmt.run(cols.map((c) => (r[c] === undefined ? null : typeof r[c] === 'boolean' ? Number(r[c]) : r[c])));
  } finally { stmt.free(); }
}
export function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const out = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}
// Put a value back only when the row has it, so the business reads back exactly as it was written.
const opt = (o, k, v) => { if (v !== null && v !== undefined) o[k] = v; return o; };
const lookupRow = (a) => ({ address_id: a.address_id, line1: a.line1, city: a.city, state: a.state, zip: a.zip, school_district: a.school_district, municipality: a.municipality, source: 'lookup' });
const employerRow = (a) => ({ address_id: a.address_id, line1: a.line1, city: a.city, state: a.state, zip: a.zip, school_district: 'UNRESOLVED', municipality: null, source: 'employer' });

// ---------- writing ----------

// The database for one migration: the business, the addresses it uses, the taxes, and empty results.
//   company     the business, in the same shape as the demo files
//   lookup      the address lookup (Intuit's service in production); only the addresses the business uses go in
//   catalog     the tax catalogue
//   addresses   addresses in the file the lookup does not know (kept, and the lookup cannot place them)
// A row that breaks a key (an item that does not exist, the same item twice) stops the load with the
// database's own message, so a broken file never gets in.
export function createDatabase(SQL, { company, lookup, catalog, addresses = [] }) {
  const db = new SQL.Database();
  db.run(SCHEMA);
  db.run('BEGIN');
  try {
    insert(db, 'taxes', Object.entries(catalog.states).flatMap(([st, s]) => s.taxes.map((t) => ({ tax_id: t.tax_id, state: st, type: t.type, code: t.code, name: t.name, rate: t.rate, basis: t.basis, agency: t.agency, qb_pays_and_files: t.qb_pays_and_files }))));
    const byId = new Map(lookup.map((a) => [a.address_id, a]));
    const fromFile = new Map(addresses.map((a) => [a.address_id, a]));
    const used = [...new Set([...company.worksites.map((w) => w.address_id), ...company.employees.flatMap((e) => e.addresses.map((a) => a.address_id))])];
    insert(db, 'addresses', used.map((id) => (byId.has(id) ? lookupRow(byId.get(id)) : fromFile.has(id) ? employerRow(fromFile.get(id)) : null)).filter(Boolean));
    insertCompany(db, company);
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    db.close();
    throw err;
  }
  return db;
}

function insertCompany(db, c) {
  insert(db, 'company', [{ company_id: c.company_id, name: c.name, plan: c.plan, migration_month: c.migration_month, description: c.description }]);
  insert(db, 'worksites', c.worksites.map((w) => ({ site_id: w.site_id, name: w.name, address_id: w.address_id })));
  insert(db, 'payroll_items', c.items.map((it) => ({
    item_id: it.item_id, label: it.label, law_id: it.law_id, origin: it.origin, item_type: it.item_type, tracking_type: it.tracking_type,
    calc_kind: it.calc?.kind, calc_rate: it.calc?.rate, calc_amount: it.calc?.amount, agency: it.agency, agency_account: it.agency_account,
    deposit_frequency: it.deposit_frequency, system_tax_id: it.system_tax_id,
  })));
  insert(db, 'employees', c.employees.map((e) => ({ employee_id: e.employee_id, name: e.name, site_id: e.site_id, monthly_wages: e.monthly_wages, remote: has(e, 'remote') ? e.remote : null, hired_month: e.hired_month, left_month: e.left_month })));
  insert(db, 'home_addresses', c.employees.flatMap((e) => e.addresses.map((a) => ({ employee_id: e.employee_id, from_month: a.from_month, address_id: a.address_id }))));
  insert(db, 'desktop_lines', c.employees.flatMap((e) => e.items.map((it) => ({ employee_id: e.employee_id, item_id: it }))));
}

// ---------- reading: the engine's input, rebuilt from SQL ----------

// The business comes back from the database. The tax catalogue, the label pool and the address lookup are
// reference files (Intuit's services in production); addresses the employer typed come from the database.
export function readData(db, { catalog, lookup, pools, lookupMeta = null }) {
  const typed = all(db, "SELECT address_id, line1, city, state, zip, school_district, municipality FROM addresses WHERE source = 'employer' ORDER BY rowid");
  return { catalog, geocoder: { metadata: lookupMeta, addresses: [...lookup, ...typed] }, pools, companies: [readCompany(db)] };
}

const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const list = m.get(r[key]); if (list) list.push(r); else m.set(r[key], [r]); } return m; };

export function readCompany(db) {
  const c = all(db, 'SELECT * FROM company')[0];
  const out = { company_id: c.company_id, name: c.name, plan: c.plan, migration_month: c.migration_month };
  out.worksites = all(db, 'SELECT site_id, name, address_id FROM worksites ORDER BY rowid');
  out.items = all(db, 'SELECT * FROM payroll_items ORDER BY rowid').map((r) => {
    const it = { item_id: r.item_id, label: r.label, law_id: r.law_id, origin: r.origin, item_type: r.item_type, tracking_type: r.tracking_type };
    it.calc = r.calc_kind === 'flat_annual' ? { kind: r.calc_kind, amount: r.calc_amount } : { kind: r.calc_kind, rate: r.calc_rate };
    it.agency = r.agency;
    opt(it, 'agency_account', r.agency_account);
    opt(it, 'deposit_frequency', r.deposit_frequency);
    opt(it, 'system_tax_id', r.system_tax_id);
    return it;
  });
  const homes = groupBy(all(db, 'SELECT employee_id, address_id, from_month FROM home_addresses ORDER BY rowid'), 'employee_id');
  const lines = groupBy(all(db, 'SELECT employee_id, item_id FROM desktop_lines ORDER BY rowid'), 'employee_id');
  out.employees = all(db, 'SELECT * FROM employees ORDER BY rowid').map((r) => {
    const e = { employee_id: r.employee_id, name: r.name, site_id: r.site_id, monthly_wages: r.monthly_wages };
    e.addresses = (homes.get(r.employee_id) ?? []).map((a) => ({ address_id: a.address_id, from_month: a.from_month }));
    e.items = (lines.get(r.employee_id) ?? []).map((l) => l.item_id);
    if (r.remote !== null) e.remote = Boolean(r.remote);
    opt(e, 'hired_month', r.hired_month);
    opt(e, 'left_month', r.left_month);
    return e;
  });
  opt(out, 'description', c.description);
  return out;
}

// ---------- the employer adds a missing or unplaceable home address ----------

export const addressKey = (line1, zip) => `${norm(line1)}|${norm(zip)}`;
export function lookupIndex(addresses) {
  return new Map(addresses.filter((a) => !a.missing && a.school_district !== 'UNRESOLVED').map((a) => [addressKey(a.line1, a.zip), a.address_id]));
}

// The new address replaces the employee's home address for the whole year. If the lookup knows it, it
// goes in as a lookup address the engine can place; if not, it is kept as one the lookup cannot place.
export function applyCorrection(db, c, index, lookup) {
  const found = index.get(addressKey(c.line1, c.zip));
  const addressId = found ?? `${c.company_id}-C-${c.employee_id}`;
  db.run('SAVEPOINT correction');
  try {
    if (found) {
      const a = lookup.find((x) => x.address_id === found);
      insert(db, 'addresses', all(db, 'SELECT 1 FROM addresses WHERE address_id = ?', [found]).length ? [] : [lookupRow(a)]);
    } else {
      db.run(`INSERT INTO addresses (address_id, line1, city, state, zip, school_district, municipality, source)
        VALUES (?, ?, ?, ?, ?, 'UNRESOLVED', NULL, 'employer')
        ON CONFLICT (address_id) DO UPDATE SET line1 = excluded.line1, city = excluded.city, state = excluded.state, zip = excluded.zip`, [addressId, c.line1, c.city, c.state, c.zip]);
    }
    db.run('DELETE FROM home_addresses WHERE employee_id = ?', [c.employee_id]);
    insert(db, 'home_addresses', [{ employee_id: c.employee_id, from_month: 1, address_id: addressId }]);
    db.run('RELEASE correction');
  } catch (err) {
    db.run('ROLLBACK TO correction');
    db.run('RELEASE correction');
    throw err;
  }
  return { addressId, found: Boolean(found) };
}

// ---------- results, written by the app ----------

export const RESULT_TABLES = ['expected_taxes', 'line_results', 'decision_log'];

// The engine's analysis of the business, the decisions so far, and the log, as rows.
// analysis is null for a file the engine stops on; then only the log is written.
export function resultRows({ analysis: a, decisions: d, log = [] }) {
  const rows = { expected_taxes: [], line_results: [], decision_log: [] };
  if (a) {
    const gaps = new Set(a.gaps.map((g) => `${g.employee_id}|${g.tax_id}`));
    for (const e of a.employees) {
      for (const x of e.expected.list) rows.expected_taxes.push({ employee_id: e.employee_id, tax_id: x.tax_id, months: monthSpan(x.months) || 'none', required: x.required ? 1 : 0, gap: gaps.has(`${e.employee_id}|${x.tax_id}`) ? 1 : 0 });
    }
    for (const k of effectiveAll(a, d)) {
      const e = k.decision.employer;
      const x = k.decision.expert;
      rows.line_results.push({
        employee_id: k.employee_id, item_id: k.item.item_id, route: k.route, reason: k.reason ?? null, stage: k.stage,
        online_tax: k.route === 'local_tax' ? k.proposal.map((p) => p.tax.name).join(' + ') : k.route === 'custom_entry' ? k.entry?.name ?? null : null,
        decided_by: e ? (e.auto ? 'rule' : 'employer') : x ? (x.auto ? 'rule' : 'expert') : null,
        rule: e?.rule ?? x?.rule ?? null,
      });
    }
  }
  // The log is kept newest first in the app; the table holds it in the order it happened.
  rows.decision_log = [...log].reverse().map((x) => ({ at: x.at, who: x.actor, action: x.action, line: x.target ?? null, detail: x.detail ?? null }));
  return rows;
}
export function writeResults(db, rows) {
  db.run('BEGIN');
  try {
    for (const t of RESULT_TABLES) db.run(`DELETE FROM ${t}`);
    for (const t of RESULT_TABLES) insert(db, t, rows[t] ?? []);
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// ---------- the Data page ----------

export function tableSummary(db) {
  return TABLE_GROUPS.map((g) => ({
    ...g,
    tables: g.tables.map((name) => ({
      name,
      rows: all(db, `SELECT COUNT(*) AS n FROM ${name}`)[0].n,
      columns: all(db, `PRAGMA table_info(${name})`).map((c) => c.name),
    })),
  }));
}

// One table as the database itself describes it: columns, keys, links, and its CREATE statement.
export function describeTable(db, name) {
  if (!TABLE_GROUPS.some((g) => g.tables.includes(name))) return null;
  // A foreign key over two columns comes back as two rows with the same id: put them together.
  const fkRows = all(db, `PRAGMA foreign_key_list(${name})`);
  const foreignKeys = [...new Set(fkRows.map((f) => f.id))].map((id) => {
    const parts = fkRows.filter((f) => f.id === id).sort((a, b) => a.seq - b.seq);
    return { table: parts[0].table, from: parts.map((f) => f.from), to: parts.map((f) => f.to ?? f.from) };
  });
  const columns = all(db, `PRAGMA table_info(${name})`).map((c) => ({
    name: c.name,
    type: c.type,
    pk: c.pk > 0,
    notNull: Boolean(c.notnull) || c.pk > 0,
    links: [...new Set(foreignKeys.filter((f) => f.from.includes(c.name)).map((f) => f.table))],
  }));
  const linkedFrom = TABLE_GROUPS.flatMap((g) => g.tables).filter((t) => t !== name && all(db, `PRAGMA foreign_key_list(${t})`).some((f) => f.table === name));
  const sql = all(db, 'SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?', [name])[0]?.sql ?? '';
  // The CHECK rules, as written in the CREATE statement (one per line in this schema).
  const checks = sql.split('\n').map((l) => l.match(/CHECK \((.*)\),?\s*(?:--.*)?$/)?.[1]).filter(Boolean);
  return { name, columns, foreignKeys, linkedFrom, checks, sql, rows: all(db, `SELECT COUNT(*) AS n FROM ${name}`)[0].n };
}

// Proof that the rules live in the database: each statement breaks one rule. tryRule runs it inside a
// savepoint and always rolls back, so the data never changes; the database's own error comes back.
export const RULE_CHECKS = [
  { id: 'fk', label: 'Add an employee at a work site that does not exist', rule: 'Foreign key',
    sql: "INSERT INTO employees (employee_id, name, site_id, monthly_wages) VALUES ('E999', 'Test Person', 'NO-SUCH-SITE', 3000)" },
  { id: 'pk', label: 'Add the same employee twice', rule: 'Primary key',
    sql: 'INSERT INTO employees (employee_id, name, site_id, monthly_wages) SELECT employee_id, name, site_id, monthly_wages FROM employees LIMIT 1' },
  { id: 'month', label: 'Set the move month to 13', rule: 'Check',
    sql: 'UPDATE company SET migration_month = 13' },
  { id: 'rate', label: 'Give a tax a rate of 150%', rule: 'Check',
    sql: 'UPDATE taxes SET rate = 150 WHERE tax_id = (SELECT tax_id FROM taxes LIMIT 1)' },
  { id: 'line', label: 'Record a Desktop line for an item the business never set up', rule: 'Foreign key',
    sql: "INSERT INTO desktop_lines (employee_id, item_id) SELECT employee_id, 'NO-SUCH-ITEM' FROM employees LIMIT 1" },
];
export function tryRule(db, id) {
  const check = RULE_CHECKS.find((c) => c.id === id);
  if (!check) return null;
  db.run('SAVEPOINT try_rule');
  let refused = null;
  try { db.run(check.sql); } catch (err) { refused = err.message; }
  db.run('ROLLBACK TO try_rule');
  db.run('RELEASE try_rule');
  return { ...check, refused };
}

// The whole database as a .sqlite file. sql.js reopens the database to export it, which resets
// pragmas, so foreign keys are switched back on.
export function exportDatabase(db) {
  const bytes = db.export();
  db.run('PRAGMA foreign_keys = ON');
  return bytes;
}

// Read-only queries for the demo: one SELECT (or WITH ... SELECT) at a time.
export function runQuery(db, sql, limit = 200) {
  const text = String(sql ?? '').trim().replace(/;\s*$/, '');
  if (!text) throw new Error('Type a query first.');
  if (/;/.test(text)) throw new Error('Run one query at a time.');
  if (!/^(select|with)\b/i.test(text)) throw new Error('Only SELECT queries can run here, so the demo data stays intact.');
  const res = db.exec(text);
  if (!res.length) return { columns: [], rows: [], total: 0 };
  const { columns, values } = res[0];
  return { columns, rows: values.slice(0, limit), total: values.length };
}

// ---------- uploading a Desktop file (CSV) ----------

export const CSV_COLUMNS = [
  ['company_name', true, 'The business name'],
  ['plan', true, 'Core, Premium or Elite'],
  ['migration_month', true, 'Month of the first Online payroll, 1 to 12'],
  ['employee_id', true, 'Desktop employee ID'],
  ['employee_name', true, ''],
  ['monthly_wages', true, 'Gross wages a month, in dollars'],
  ['home_address', false, 'Street line; blank if Desktop has none'],
  ['home_city', false, ''],
  ['home_state', false, ''],
  ['home_zip', false, ''],
  ['work_site', true, 'Work location name'],
  ['work_address', true, 'Street line of the work location'],
  ['work_city', false, ''],
  ['work_state', true, ''],
  ['work_zip', true, ''],
  ['remote', false, 'yes if the employee works from home'],
  ['item_label', false, 'The Desktop payroll item name, exactly as typed; blank row = no local items'],
  ['law_id', false, '177 or 0 for an employer-created item'],
  ['item_type', false, 'For example Other Tax or Deduction'],
  ['tracking_type', false, 'For example Local Income Tax, or None for after-tax'],
  ['rate_percent', false, 'Withholding rate, for example 1.5'],
  ['agency', false, 'Agency on the Desktop item'],
  ['agency_account', false, ''],
  ['deposit_frequency', false, 'Monthly, Quarterly, ...'],
];

// A small fictional company whose addresses are in the demo lookup, so its file runs end to end.
export function csvTemplate(geocoder) {
  const at = (id) => geocoder.addresses.find((a) => a.address_id === id);
  const work = at('W-LAN-1');
  const homes = ['H-001', 'H-003', 'H-007'].map(at).filter(Boolean);
  const people = [['M01', 'Grace Miller', 3600], ['M02', 'Omar Haddad', 4100], ['M03', 'Lena Fischer', 3900]];
  const items = [['SD W/H', 177, 'Other Tax', 'Local Income Tax', 1.5, 'Ohio Dept of Taxation'], ['City Tax', 177, 'Other Tax', 'Local Income Tax', 2.3, 'City of Lancaster']];
  const head = CSV_COLUMNS.map(([c]) => c).join(',');
  const rows = [];
  people.forEach(([id, name, wages], i) => {
    const h = homes[i % homes.length];
    for (const [label, law, type, track, rate, agency] of items) {
      rows.push(['Maple Street Cafe', 'Premium', 10, id, name, wages, h.line1, h.city, h.state, h.zip, 'Main Street cafe', work.line1, work.city, work.state, work.zip, '', label, law, type, track, rate, agency, '', 'Quarterly']);
    }
  });
  return [head, ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Turn the rows of a Desktop CSV into a company in the same shape as the demo files.
// Returns { company, addresses, problems }: problems are about the file's format; the engine's own
// file checks (stop or clean up) run afterwards, exactly as for the demo companies.
export function companyFromCsv(text, geocoder, companyId) {
  const problems = [];
  const table = parseCsv(text);
  if (table.length < 2) return { problems: ['The file needs a header row and at least one data row.'] };
  const head = table[0].map((h) => h.trim().toLowerCase());
  const missing = CSV_COLUMNS.filter(([c, req]) => req && !head.includes(c)).map(([c]) => c);
  if (missing.length) return { problems: [`Missing columns: ${missing.join(', ')}. Use the template.`] };
  const rows = table.slice(1).map((r, i) => ({ line: i + 2, ...Object.fromEntries(head.map((h, j) => [h, (r[j] ?? '').trim()])) }));
  const first = rows[0];
  const month = Number(first.migration_month);
  const plan = ['Core', 'Premium', 'Elite'].find((x) => x.toLowerCase() === String(first.plan ?? '').toLowerCase());
  if (first.plan && !plan) problems.push(`plan must be Core, Premium or Elite, not "${first.plan}".`);
  const lookup = new Map(geocoder.addresses.map((a) => [`${norm(a.line1)}|${norm(a.zip)}`, a]));
  const addresses = [];
  const placeAddress = (line1, city, st, zip) => {
    if (!line1) return null;
    const known = lookup.get(`${norm(line1)}|${norm(zip)}`);
    if (known) return known.address_id;
    let a = addresses.find((x) => norm(x.line1) === norm(line1) && norm(x.zip) === norm(zip));
    if (!a) { a = { address_id: `${companyId}-A${addresses.length + 1}`, line1, city, state: st.toUpperCase() || null, zip }; addresses.push(a); }
    return a.address_id;
  };
  const sites = [];
  const items = [];
  const employees = [];
  for (const r of rows) {
    if (r.company_name && norm(r.company_name) !== norm(first.company_name)) problems.push(`Line ${r.line}: one file is one company; "${r.company_name}" differs from "${first.company_name}".`);
    // work site: must be a known address, or the engine stops with "unknown work site"
    let site = sites.find((s) => norm(s.name) === norm(r.work_site));
    if (!site) {
      const known = lookup.get(`${norm(r.work_address)}|${norm(r.work_zip)}`);
      site = { site_id: `S${sites.length + 1}`, name: r.work_site || `Site ${sites.length + 1}`, address_id: known ? known.address_id : `${companyId}-W${sites.length + 1}` };
      sites.push(site);
    }
    let e = employees.find((x) => x.employee_id === r.employee_id);
    if (!e) {
      const wages = Number(r.monthly_wages);
      if (!Number.isFinite(wages)) problems.push(`Line ${r.line}: monthly_wages must be a number.`);
      const home = placeAddress(r.home_address, r.home_city, r.home_state ?? '', r.home_zip);
      e = { employee_id: r.employee_id, name: r.employee_name, site_id: site.site_id, monthly_wages: wages, addresses: home ? [{ address_id: home, from_month: 1 }] : [], items: [] };
      if (/^(yes|y|true|1)$/i.test(r.remote ?? '')) e.remote = true;
      employees.push(e);
    }
    if (!r.item_label && !r.rate_percent) continue;
    const rate = Number(r.rate_percent);
    if (r.rate_percent && !Number.isFinite(rate)) problems.push(`Line ${r.line}: rate_percent must be a number.`);
    const lawId = r.law_id === '' || r.law_id === undefined ? 177 : Number(r.law_id);
    const key = [norm(r.item_label), r.item_type, r.tracking_type, rate, norm(r.agency)].join('|');
    let item = items.find((x) => x.key === key);
    if (!item) {
      item = { key, item_id: `I${items.length + 1}`, label: r.item_label, law_id: lawId, origin: lawId === 177 || lawId === 0 ? 'custom' : 'system', item_type: r.item_type || 'Other Tax', tracking_type: r.tracking_type || 'Local Income Tax', calc: { kind: 'percent', rate }, agency: r.agency || '' };
      if (r.agency_account) item.agency_account = r.agency_account;
      if (r.deposit_frequency) item.deposit_frequency = r.deposit_frequency;
      items.push(item);
    }
    e.items.push(item.item_id);
  }
  // Without a lookup match a work site stays unknown, which the engine reports as a stop.
  for (const s of sites) if (s.address_id.startsWith(`${companyId}-W`)) problems.push(`Work site "${s.name}" is not an address the demo lookup knows. Use one of the work addresses in the template.`);
  const company = {
    company_id: companyId,
    name: first.company_name || 'Uploaded company',
    plan: plan ?? 'Premium',
    migration_month: month,
    worksites: sites,
    items: items.map(({ key, ...rest }) => rest),
    employees,
    description: `Uploaded Desktop file: ${employees.length} employees, ${rows.length} rows.`,
  };
  return { company, addresses, problems };
}
