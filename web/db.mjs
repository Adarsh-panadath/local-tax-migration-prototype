import { effectiveAll } from './engine/workflow.mjs';
import { monthSpan } from './engine/util.mjs';

// The demo's database: SQLite (sql.js, compiled to WebAssembly) running inside the page.
// No server, no account and no keys. It is rebuilt every time the page opens, so each visitor gets
// a private copy; uploaded Desktop files and added addresses are kept in that visitor's browser.
//
// The schema (SCHEMA below, also in docs/schema.sql) has four layers:
//   tax reference - Intuit's data: states, taxes, defined entries, addresses, the expert-labelled pool
//   source        - the customer's Desktop file: companies, work sites, items, employees, lines
//   work          - what the engine found and what people decided
//   audit         - the decision log and the label model's scores
// Every table has a primary key; foreign keys and CHECK rules are switched on, so the database itself
// refuses a row that points at nothing or holds an impossible value.
//
// The engine never reads the JSON files directly when the database is available: readData() rebuilds
// its input from SQL queries, so what the screens show is what is in the tables.

export const SCHEMA = `-- Local Tax Migration: the database schema.
-- SQLite, written in standard SQL: the same tables run on PostgreSQL with small type changes.
--
-- Four layers, each with one owner:
--   1. Tax reference  Intuit's data, the same for every business
--   2. Source         the customer's Desktop file, copied in and never edited
--   3. Work           what the engine found and what people decided
--   4. Audit          who did what and when, and how the model scored
--
-- Every table has a primary key. Foreign keys link the tables, and CHECK rules refuse impossible
-- values, so bad data is stopped by the database itself, not only by the app.

PRAGMA foreign_keys = ON;

-- Where each demo file came from (sources, dates). Not part of the four layers.
CREATE TABLE dataset_info (
  dataset    TEXT PRIMARY KEY,
  info_json  TEXT NOT NULL
);

-- =====================================================================
-- 1. TAX REFERENCE (Intuit)
-- =====================================================================

CREATE TABLE states (
  state_code  TEXT PRIMARY KEY,                      -- OH, PA
  name        TEXT NOT NULL,
  rollout     TEXT NOT NULL CONSTRAINT rollout_value CHECK (rollout IN ('enabled', 'not_yet_enabled')),
  sort        INTEGER
);

CREATE TABLE taxes (
  tax_id             TEXT PRIMARY KEY,               -- OH-SD-2305
  state_code         TEXT NOT NULL REFERENCES states (state_code),
  type               TEXT NOT NULL CONSTRAINT tax_type_value CHECK (type IN ('school_district', 'municipal', 'earned_income', 'local_services')),
  code               TEXT,                           -- school-district number; addresses.school_district holds the same code
  name               TEXT NOT NULL,
  place              TEXT,
  rate               REAL NOT NULL CONSTRAINT rate_0_to_100 CHECK (rate BETWEEN 0 AND 100),   -- percent
  base               TEXT,
  basis              TEXT NOT NULL CONSTRAINT basis_value CHECK (basis IN ('home', 'work', 'higher')),
  agency             TEXT,
  qb_pays_and_files  INTEGER NOT NULL CHECK (qb_pays_and_files IN (0, 1)),
  sort               INTEGER
);

CREATE TABLE no_tax_districts (
  state_code  TEXT NOT NULL REFERENCES states (state_code),
  name        TEXT NOT NULL,
  place       TEXT,
  note        TEXT,
  sort        INTEGER,
  PRIMARY KEY (state_code, name)
);

-- Place names removed from labels before clustering ("Lancaster SD" and "Bremen SD" look alike).
CREATE TABLE state_place_names (
  state_code  TEXT NOT NULL REFERENCES states (state_code),
  place_name  TEXT NOT NULL,
  sort        INTEGER,
  PRIMARY KEY (state_code, place_name)
);

-- The names a label cluster can take: a kind of tax, or a known non-tax item such as union dues.
CREATE TABLE defined_entries (
  entry_id  TEXT PRIMARY KEY,                        -- T-SD, N-DUES
  kind      TEXT NOT NULL CHECK (kind IN ('tax', 'non_tax')),
  tax_type  TEXT,
  label     TEXT NOT NULL,
  text      TEXT NOT NULL,                           -- the words a cluster is compared with
  sort      INTEGER,
  CONSTRAINT tax_entry_has_type CHECK (kind = 'non_tax' OR tax_type IS NOT NULL)
);

CREATE TABLE defined_entry_states (
  entry_id    TEXT NOT NULL REFERENCES defined_entries (entry_id),
  state_code  TEXT NOT NULL REFERENCES states (state_code),
  sort        INTEGER,
  PRIMARY KEY (entry_id, state_code)
);

-- Every street address: from Intuit's address lookup, or typed by an employer and unknown to it.
-- school_district is the district code (a taxes.code), NO-TAX-..., or UNRESOLVED when the lookup cannot place it.
CREATE TABLE addresses (
  address_id       TEXT PRIMARY KEY,
  line1            TEXT,
  city             TEXT,
  state            TEXT,
  zip              TEXT,
  school_district  TEXT,
  municipality     TEXT,
  source           TEXT NOT NULL CHECK (source IN ('lookup', 'customer')),
  company_id       TEXT REFERENCES companies (company_id),   -- the business that typed it (customer addresses only)
  sort             INTEGER,
  CONSTRAINT customer_address_has_company CHECK ((source = 'customer') = (company_id IS NOT NULL))
);

-- Desktop labels an expert has already classified: what the clustering gates are measured on.
CREATE TABLE label_pool (
  label_id      INTEGER PRIMARY KEY,
  state_code    TEXT NOT NULL REFERENCES states (state_code),
  label         TEXT NOT NULL,
  expert_label  TEXT NOT NULL,                       -- school_district, municipal, non_tax:N-DUES, ambiguous ...
  sort          INTEGER
);

-- =====================================================================
-- 2. SOURCE: the customer's Desktop file, copied in and never edited
-- =====================================================================

CREATE TABLE companies (
  company_id       TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  plan             TEXT NOT NULL CONSTRAINT plan_value CHECK (plan IN ('Core', 'Premium', 'Elite')),
  migration_month  INTEGER NOT NULL CONSTRAINT month_1_to_12 CHECK (migration_month BETWEEN 1 AND 12),
  description      TEXT,
  source           TEXT NOT NULL CHECK (source IN ('demo', 'generated', 'upload')),
  sort             INTEGER
);

CREATE TABLE worksites (
  company_id  TEXT NOT NULL REFERENCES companies (company_id),
  site_id     TEXT NOT NULL,
  name        TEXT,
  address_id  TEXT NOT NULL REFERENCES addresses (address_id),
  sort        INTEGER,
  PRIMARY KEY (company_id, site_id)
);

-- A payroll item as set up in Desktop. Law ID 177 or 0 = an employer-created item with a free-text label.
CREATE TABLE payroll_items (
  company_id         TEXT NOT NULL REFERENCES companies (company_id),
  item_id            TEXT NOT NULL,
  label              TEXT,                           -- free text, exactly as typed
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
  system_tax_id      TEXT REFERENCES taxes (tax_id), -- system items only: the tax Desktop already knows
  null_fields        TEXT,                           -- fields the file had as an explicit null
  sort               INTEGER,
  PRIMARY KEY (company_id, item_id)
);

CREATE TABLE employees (
  company_id     TEXT NOT NULL REFERENCES companies (company_id),
  employee_id    TEXT NOT NULL,
  name           TEXT NOT NULL,
  site_id        TEXT NOT NULL,
  monthly_wages  REAL NOT NULL CONSTRAINT wages_not_negative CHECK (monthly_wages >= 0),
  remote         INTEGER CHECK (remote IN (0, 1)),
  hired_month    INTEGER CHECK (hired_month BETWEEN 1 AND 12),
  left_month     INTEGER CHECK (left_month BETWEEN 1 AND 12),
  sort           INTEGER,
  PRIMARY KEY (company_id, employee_id),
  FOREIGN KEY (company_id, site_id) REFERENCES worksites (company_id, site_id)
);

-- Home addresses over the year: a move adds a row with the month it starts.
CREATE TABLE employee_addresses (
  company_id   TEXT NOT NULL,
  employee_id  TEXT NOT NULL,
  from_month   INTEGER NOT NULL CHECK (from_month BETWEEN 1 AND 12),
  address_id   TEXT NOT NULL REFERENCES addresses (address_id),
  sort         INTEGER,
  PRIMARY KEY (company_id, employee_id, from_month),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, employee_id)
);

-- One row per employee per payroll item: a Desktop local tax line.
CREATE TABLE desktop_lines (
  company_id   TEXT NOT NULL,
  employee_id  TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  sort         INTEGER,
  PRIMARY KEY (company_id, employee_id, item_id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, employee_id),
  FOREIGN KEY (company_id, item_id) REFERENCES payroll_items (company_id, item_id)
);

-- Rows in the Desktop file that break a key: an item that does not exist, the same item twice,
-- an address nobody knows. Kept here so nothing in the file is lost; the engine reports each one.
CREATE TABLE import_issues (
  issue_id     INTEGER PRIMARY KEY,
  company_id   TEXT NOT NULL,
  employee_id  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('unknown_item', 'repeated_item', 'unknown_address')),
  value        TEXT NOT NULL,                        -- the item or address id the file gave
  from_month   INTEGER,                              -- for an address
  position     INTEGER NOT NULL,                     -- where it was in the employee's list
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, employee_id)
);

-- =====================================================================
-- 3. WORK: what the engine found and what people decided
-- =====================================================================

-- Home addresses the employer added because Desktop had none, or one the lookup could not place.
CREATE TABLE corrections (
  correction_id    INTEGER PRIMARY KEY,
  company_id       TEXT NOT NULL,
  employee_id      TEXT NOT NULL,
  value            TEXT NOT NULL,                    -- the address as typed
  address_id       TEXT NOT NULL REFERENCES addresses (address_id),
  found_in_lookup  INTEGER NOT NULL CHECK (found_in_lookup IN (0, 1)),
  at               TEXT NOT NULL,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, employee_id)
);

-- What each employee's addresses say they owe. gap = 1: owed in some months, but no Desktop line withholds it.
CREATE TABLE expected_taxes (
  company_id   TEXT NOT NULL,
  employee_id  TEXT NOT NULL,
  tax_id       TEXT NOT NULL REFERENCES taxes (tax_id),
  required     INTEGER NOT NULL CHECK (required IN (0, 1)),   -- 0 = optional courtesy withholding
  months       TEXT NOT NULL,
  gap          INTEGER NOT NULL CHECK (gap IN (0, 1)),
  PRIMARY KEY (company_id, employee_id, tax_id),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, employee_id)
);

-- Where each Desktop line stands now: its route, why, and who settled it.
CREATE TABLE line_results (
  company_id   TEXT NOT NULL,
  employee_id  TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  state        TEXT,
  route        TEXT NOT NULL CONSTRAINT route_value CHECK (route IN ('local_tax', 'not_a_tax', 'not_in_database', 'custom_entry', 'stop')),
  reason       TEXT,                                 -- why it needs a person: weak_signal, no_address ...
  stage        TEXT NOT NULL CHECK (stage IN ('awaiting_employer', 'with_expert', 'confirmed', 'moved_to_deduction', 'employer_managed', 'stopped')),
  online_tax   TEXT,                                 -- the Online payroll tax(es) it maps to
  decided_by   TEXT CHECK (decided_by IN ('rule', 'employer', 'expert')),
  rule         TEXT,                                 -- the automation rule, when a rule settled it
  PRIMARY KEY (company_id, employee_id, item_id),
  FOREIGN KEY (company_id, employee_id, item_id) REFERENCES desktop_lines (company_id, employee_id, item_id)
);

-- Every decision, one row each. A line has no item when the decision adds a tax nobody withheld.
CREATE TABLE decisions (
  decision_id  INTEGER PRIMARY KEY,
  company_id   TEXT NOT NULL,
  employee_id  TEXT NOT NULL,
  item_id      TEXT,
  tax_id       TEXT REFERENCES taxes (tax_id),       -- the tax it maps to or adds
  decided_by   TEXT NOT NULL CHECK (decided_by IN ('rule', 'employer', 'expert')),
  action       TEXT NOT NULL,
  rule         TEXT,
  at           TEXT,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, employee_id),
  FOREIGN KEY (company_id, employee_id, item_id) REFERENCES desktop_lines (company_id, employee_id, item_id)
);

-- One row per business: how far its move has got, and any rule the employer switched off.
CREATE TABLE migrations (
  company_id  TEXT PRIMARY KEY REFERENCES companies (company_id),
  status      TEXT NOT NULL CHECK (status IN ('not_moved', 'moved', 'live', 'reconciled')),
  rules_off   TEXT
);

-- =====================================================================
-- 4. AUDIT
-- =====================================================================

CREATE TABLE audit_log (
  log_id      INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  company_id  TEXT REFERENCES companies (company_id),
  actor       TEXT NOT NULL,                         -- Employer, Expert, Automation, Admin ...
  action      TEXT NOT NULL,
  target      TEXT,
  detail      TEXT
);

-- The label model per state: its quality and whether its suggestions are shown.
CREATE TABLE model_runs (
  state_code       TEXT NOT NULL REFERENCES states (state_code),
  model_version    TEXT NOT NULL,
  labels           INTEGER NOT NULL,               -- expert-labelled labels it was measured on
  k                INTEGER,                        -- number of clusters
  silhouette       REAL,
  precision_score  REAL,
  coverage         REAL,
  mode             TEXT NOT NULL CHECK (mode IN ('assisted', 'shadow')),
  PRIMARY KEY (state_code, model_version)
);
`;

// The four layers, for the Data page.
export const TABLE_GROUPS = [
  { id: 'reference', title: 'Tax reference', owner: 'Intuit', note: 'The same for every business. Ohio codes and rates are real; the address lookup stands in for Intuit\'s tax service.', tables: ['states', 'taxes', 'no_tax_districts', 'state_place_names', 'defined_entries', 'defined_entry_states', 'addresses', 'label_pool'] },
  { id: 'source', title: 'Source', owner: 'Customer', note: 'The Desktop file, copied in and never edited. Fictional people.', tables: ['companies', 'worksites', 'payroll_items', 'employees', 'employee_addresses', 'desktop_lines', 'import_issues'] },
  { id: 'work', title: 'Work', owner: 'Engine and people', note: 'What the engine found and what people decided.', tables: ['expected_taxes', 'line_results', 'decisions', 'corrections', 'migrations'] },
  { id: 'audit', title: 'Audit', owner: 'System', note: 'Who did what and when, and how the label model scored.', tables: ['audit_log', 'model_runs'] },
];

// What each table holds, in one line: the data dictionary on the Data page.
export const TABLE_NOTES = {
  states: 'A state, and whether migration is switched on there.',
  taxes: 'Each local tax Online payroll knows: its rate, what it is based on and the agency.',
  no_tax_districts: 'School districts with no income tax, such as Columbus City Schools.',
  state_place_names: 'Place names taken out of labels before clustering, so "Lancaster SD" and "Bremen SD" look alike.',
  defined_entries: 'The names a label cluster can take: a kind of tax, or a known non-tax item like union dues.',
  defined_entry_states: 'Which states each defined entry applies in.',
  addresses: 'Every street address, from Intuit\'s address lookup or typed by an employer, with its school district and city.',
  label_pool: 'Desktop labels an expert has already classified; the clustering gates are measured on them.',
  companies: 'One row per business moving to Online payroll.',
  worksites: 'Where each business\'s people work.',
  payroll_items: 'Payroll items as set up in Desktop, with the label exactly as someone typed it.',
  employees: 'The people on each payroll.',
  employee_addresses: 'Home addresses over the year; a move adds a row from the month it starts.',
  desktop_lines: 'One row per employee per payroll item: a Desktop local tax line.',
  import_issues: 'Rows in a Desktop file that break a key, kept so nothing is lost; the engine reports each one.',
  expected_taxes: 'What each employee\'s addresses say they owe. gap = 1 means owed, but no Desktop line withholds it.',
  line_results: 'Where each Desktop line stands now: its route, why, and who settled it.',
  decisions: 'Every decision, one row each: by a rule, the employer or an expert.',
  corrections: 'Home addresses the employer added, and whether the lookup could place them.',
  migrations: 'One row per business: how far its move has got.',
  audit_log: 'Who did what and when.',
  model_runs: 'The label model per state: its scores, and whether its suggestions are shown.',
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
// Put a value back only when the source row had it, so the rebuilt objects match the files exactly.
const opt = (o, k, v) => { if (v !== null && v !== undefined) o[k] = v; return o; };
const addressRow = (a, source, sort, companyId = null) => ({ address_id: a.address_id, line1: a.line1, city: a.city, state: a.state, zip: a.zip, school_district: source === 'customer' ? 'UNRESOLVED' : a.school_district, municipality: source === 'customer' ? null : a.municipality, source, company_id: companyId, sort });

// ---------- writing ----------

export function createDatabase(SQL, data, uploads = [], generated = null) {
  const db = new SQL.Database();
  db.run(SCHEMA);
  // Bulk load with the key checks paused, then check every key at once, then switch checks on for
  // everything that follows. Same guarantee, much faster than checking 50,000 rows one at a time.
  db.run('PRAGMA foreign_keys = OFF');
  db.run('BEGIN');
  try {
    insert(db, 'dataset_info', [
      { dataset: 'catalog', info_json: JSON.stringify(data.catalog.metadata ?? null) },
      { dataset: 'geocoder', info_json: JSON.stringify(data.geocoder.metadata ?? null) },
      { dataset: 'label_pool', info_json: JSON.stringify(data.poolMeta ?? null) },
      { dataset: 'companies', info_json: JSON.stringify(data.companiesMeta ?? null) },
    ]);
    const states = Object.entries(data.catalog.states);
    insert(db, 'states', states.map(([code, s], i) => ({ state_code: code, name: s.name, rollout: s.rollout, sort: i })));
    insert(db, 'state_place_names', states.flatMap(([code, s]) => (s.place_names ?? []).map((p, i) => ({ state_code: code, place_name: p, sort: i }))));
    insert(db, 'no_tax_districts', states.flatMap(([code, s]) => (s.no_tax_districts ?? []).map((d, i) => ({ state_code: code, name: d.name, place: d.place, note: d.note, sort: i }))));
    insert(db, 'taxes', states.flatMap(([code, s]) => s.taxes.map((t, i) => ({ tax_id: t.tax_id, state_code: code, type: t.type, code: t.code, name: t.name, place: t.place, rate: t.rate, base: t.base, basis: t.basis, agency: t.agency, qb_pays_and_files: t.qb_pays_and_files, sort: i }))));
    insert(db, 'defined_entries', data.catalog.defined_entries.map((e, i) => ({ entry_id: e.entry_id, kind: e.kind, tax_type: e.tax_type, label: e.label, text: e.text, sort: i })));
    insert(db, 'defined_entry_states', data.catalog.defined_entries.flatMap((e) => (e.states ?? []).map((s, i) => ({ entry_id: e.entry_id, state_code: s, sort: i }))));
    insert(db, 'addresses', data.geocoder.addresses.map((a, i) => addressRow(a, 'lookup', i)));
    // Generated addresses are ones the lookup service knows, like the demo ones.
    if (generated) insert(db, 'addresses', generated.addresses.map((a, i) => addressRow(a, 'lookup', 100000 + i)));
    insert(db, 'label_pool', Object.entries(data.pools).flatMap(([code, list]) => list.map((p, i) => ({ state_code: code, label: p.label, expert_label: p.expert_label, sort: i }))));
    data.companies.forEach((c, i) => insertCompany(db, c, 'demo', i));
    if (generated) generated.companies.forEach((c, i) => insertCompany(db, c, 'generated', 100 + i));
    uploads.forEach((u, i) => insertCompany(db, u.company, 'upload', 10000 + i, u.addresses));
    const broken = all(db, 'PRAGMA foreign_key_check');
    if (broken.length) throw new Error(`${broken.length} rows point at nothing, first in ${broken[0].table}`);
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    db.close();
    throw err;
  }
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

// One Desktop file into the source tables. Rows that would break a key (an item that does not exist,
// the same item twice for one person, an address nobody knows) go to import_issues instead.
export function insertCompany(db, c, source, sort, addresses = []) {
  const id = c.company_id;
  insert(db, 'companies', [{ company_id: id, name: c.name, plan: c.plan, migration_month: c.migration_month, description: c.description, source, sort }]);
  // Addresses from an uploaded file that the lookup has never seen: kept, and the lookup cannot place them.
  insert(db, 'addresses', addresses.map((a) => addressRow(a, 'customer', null, id)));
  insert(db, 'worksites', c.worksites.map((w, i) => ({ company_id: id, site_id: w.site_id, name: w.name, address_id: w.address_id, sort: i })));
  insert(db, 'payroll_items', c.items.map((it, i) => ({
    company_id: id, item_id: it.item_id, label: it.label, law_id: it.law_id, origin: it.origin, item_type: it.item_type, tracking_type: it.tracking_type,
    calc_kind: it.calc?.kind, calc_rate: it.calc?.rate, calc_amount: it.calc?.amount, agency: it.agency, agency_account: it.agency_account,
    deposit_frequency: it.deposit_frequency, system_tax_id: it.system_tax_id,
    // Desktop exports some empty fields as an explicit null; keep that, so the file reads back exactly.
    null_fields: Object.keys(it).filter((k) => it[k] === null).join(',') || null, sort: i,
  })));
  insert(db, 'employees', c.employees.map((e, i) => ({ company_id: id, employee_id: e.employee_id, name: e.name, site_id: e.site_id, monthly_wages: e.monthly_wages, remote: has(e, 'remote') ? e.remote : null, hired_month: e.hired_month, left_month: e.left_month, sort: i })));
  const itemIds = new Set(c.items.map((it) => it.item_id));
  // Which of this file's home addresses the database knows: one query per 500 ids.
  const wanted = [...new Set(c.employees.flatMap((e) => e.addresses.map((a) => a.address_id)))];
  const knownIds = new Set();
  for (let i = 0; i < wanted.length; i += 500) {
    const part = wanted.slice(i, i + 500);
    for (const r of all(db, `SELECT address_id FROM addresses WHERE address_id IN (${part.map(() => '?').join(',')})`, part)) knownIds.add(r.address_id);
  }
  const known = (addressId) => knownIds.has(addressId);
  const homes = [];
  const lines = [];
  const issues = [];
  for (const e of c.employees) {
    e.addresses.forEach((a, i) => {
      if (known(a.address_id)) homes.push({ company_id: id, employee_id: e.employee_id, from_month: a.from_month, address_id: a.address_id, sort: i });
      else issues.push({ company_id: id, employee_id: e.employee_id, kind: 'unknown_address', value: a.address_id, from_month: a.from_month, position: i });
    });
    const seen = new Set();
    e.items.forEach((it, i) => {
      if (!itemIds.has(it)) issues.push({ company_id: id, employee_id: e.employee_id, kind: 'unknown_item', value: it, from_month: null, position: i });
      else if (seen.has(it)) issues.push({ company_id: id, employee_id: e.employee_id, kind: 'repeated_item', value: it, from_month: null, position: i });
      else { seen.add(it); lines.push({ company_id: id, employee_id: e.employee_id, item_id: it, sort: i }); }
    });
  }
  insert(db, 'employee_addresses', homes);
  insert(db, 'desktop_lines', lines);
  insert(db, 'import_issues', issues);
}

// ---------- reading: the engine's input, rebuilt from SQL ----------

export function readData(db) {
  // Read everything once and group in memory: one query per table, however many companies there are.
  const info = Object.fromEntries(all(db, 'SELECT dataset, info_json FROM dataset_info').map((r) => [r.dataset, JSON.parse(r.info_json)]));
  const states = {};
  for (const s of all(db, 'SELECT * FROM states ORDER BY sort')) {
    states[s.state_code] = {
      name: s.name,
      rollout: s.rollout,
      taxes: all(db, 'SELECT * FROM taxes WHERE state_code = ? ORDER BY sort', [s.state_code]).map((t) => ({
        tax_id: t.tax_id, type: t.type, code: t.code, name: t.name, place: t.place, rate: t.rate, base: t.base, basis: t.basis, agency: t.agency, qb_pays_and_files: Boolean(t.qb_pays_and_files),
      })),
      no_tax_districts: all(db, 'SELECT name, place, note FROM no_tax_districts WHERE state_code = ? ORDER BY sort', [s.state_code]),
      place_names: all(db, 'SELECT place_name FROM state_place_names WHERE state_code = ? ORDER BY sort', [s.state_code]).map((r) => r.place_name),
    };
  }
  const catalog = {
    metadata: info.catalog,
    states,
    defined_entries: all(db, 'SELECT * FROM defined_entries ORDER BY sort').map((e) => ({
      ...opt({ entry_id: e.entry_id, kind: e.kind }, 'tax_type', e.tax_type),
      states: all(db, 'SELECT state_code FROM defined_entry_states WHERE entry_id = ? ORDER BY sort', [e.entry_id]).map((r) => r.state_code),
      label: e.label, text: e.text,
    })),
  };
  // The lookup's addresses first, then the ones customers typed that it cannot place.
  const addresses = all(db, "SELECT address_id, line1, city, state, zip, school_district, municipality FROM addresses ORDER BY source = 'customer', sort, rowid");
  const geocoder = { metadata: info.geocoder, addresses };
  const pools = {};
  for (const r of all(db, 'SELECT state_code, label, expert_label FROM label_pool ORDER BY state_code, sort')) (pools[r.state_code] ??= []).push({ label: r.label, expert_label: r.expert_label });
  const companies = readCompanies(db);
  return { catalog, geocoder, pools, poolMeta: info.label_pool, companies, companiesMeta: info.companies };
}

const groupBy = (rows, key = 'company_id') => { const m = new Map(); for (const r of rows) { const list = m.get(r[key]); if (list) list.push(r); else m.set(r[key], [r]); } return m; };

// All companies, or just one (after a correction), rebuilt from the source tables.
export function readCompanies(db, onlyId = null) {
  const where = onlyId ? ' WHERE company_id = ?' : '';
  const args = onlyId ? [onlyId] : [];
  const sites = groupBy(all(db, `SELECT company_id, site_id, name, address_id FROM worksites${where} ORDER BY company_id, sort`, args));
  const items = groupBy(all(db, `SELECT * FROM payroll_items${where} ORDER BY company_id, sort`, args));
  const emps = groupBy(all(db, `SELECT * FROM employees${where} ORDER BY company_id, sort`, args));
  const addrs = groupBy(all(db, `SELECT company_id, employee_id, address_id, from_month, sort FROM employee_addresses${where} ORDER BY company_id, sort`, args));
  const lines = groupBy(all(db, `SELECT company_id, employee_id, item_id, sort FROM desktop_lines${where} ORDER BY company_id, sort`, args));
  const issues = groupBy(all(db, `SELECT * FROM import_issues${where} ORDER BY company_id, position`, args));
  const of = (m, c) => m.get(c.company_id) ?? [];
  return all(db, `SELECT * FROM companies${where} ORDER BY sort`, args).map((c) => readCompany(c, of(sites, c), of(items, c), of(emps, c), of(addrs, c), of(lines, c), of(issues, c)));
}

function readCompany(c, siteRows, itemRows, empRows, addrRows, lineRows, issueRows) {
  const out = { company_id: c.company_id, name: c.name, plan: c.plan, migration_month: c.migration_month };
  out.worksites = siteRows.map((w) => ({ site_id: w.site_id, name: w.name, address_id: w.address_id }));
  out.items = itemRows.map((r) => {
    const it = { item_id: r.item_id, label: r.label, law_id: r.law_id, origin: r.origin, item_type: r.item_type, tracking_type: r.tracking_type };
    it.calc = r.calc_kind === 'flat_annual' ? { kind: r.calc_kind, amount: r.calc_amount } : { kind: r.calc_kind, rate: r.calc_rate };
    it.agency = r.agency;
    opt(it, 'agency_account', r.agency_account);
    opt(it, 'deposit_frequency', r.deposit_frequency);
    opt(it, 'system_tax_id', r.system_tax_id);
    for (const k of (r.null_fields ?? '').split(',').filter(Boolean)) it[k] = null;
    return it;
  });
  const addrBy = groupBy(addrRows, 'employee_id');
  const lineBy = groupBy(lineRows, 'employee_id');
  const issueBy = groupBy(issueRows, 'employee_id');
  // The engine sees the file as it was: rows from import_issues go back where they were in each list,
  // so its own file checks report them ("an item reference that does not exist", and so on).
  const inOrder = (rows, extra) => [...rows.map((r) => ({ at: r.sort, r })), ...extra.map((x) => ({ at: x.position, x }))].sort((a, b) => a.at - b.at);
  out.employees = empRows.map((r) => {
    const e = { employee_id: r.employee_id, name: r.name, site_id: r.site_id, monthly_wages: r.monthly_wages };
    const iss = issueBy.get(r.employee_id) ?? [];
    e.addresses = inOrder(addrBy.get(r.employee_id) ?? [], iss.filter((x) => x.kind === 'unknown_address'))
      .map(({ r: a, x }) => (a ? { address_id: a.address_id, from_month: a.from_month } : { address_id: x.value, from_month: x.from_month }));
    e.items = inOrder(lineBy.get(r.employee_id) ?? [], iss.filter((x) => x.kind !== 'unknown_address')).map(({ r: l, x }) => (l ? l.item_id : x.value));
    if (r.remote !== null) e.remote = Boolean(r.remote);
    opt(e, 'hired_month', r.hired_month);
    opt(e, 'left_month', r.left_month);
    return e;
  });
  opt(out, 'description', c.description);
  return out;
}

// ---------- corrections: the employer adds a missing or unplaceable home address ----------

export const addressKey = (line1, zip) => `${norm(line1)}|${norm(zip)}`;
export function lookupIndex(addresses) {
  return new Map(addresses.filter((a) => !a.missing && a.school_district !== 'UNRESOLVED').map((a) => [addressKey(a.line1, a.zip), a.address_id]));
}

// A corrected address replaces the employee's home address for the whole year. If the lookup knows it,
// the engine can place it; if not, it is kept as a customer address that the lookup cannot place.
export function applyCorrection(db, c, index) {
  const found = index.get(addressKey(c.line1, c.zip));
  const addressId = found ?? `${c.company_id}-C-${c.employee_id}`;
  db.run('SAVEPOINT correction');
  try {
    if (!found) {
      db.run(`INSERT INTO addresses (address_id, line1, city, state, zip, school_district, municipality, source, company_id)
        VALUES (?, ?, ?, ?, ?, 'UNRESOLVED', NULL, 'customer', ?)
        ON CONFLICT (address_id) DO UPDATE SET line1 = excluded.line1, city = excluded.city, state = excluded.state, zip = excluded.zip`, [addressId, c.line1, c.city, c.state, c.zip, c.company_id]);
    }
    db.run('DELETE FROM employee_addresses WHERE company_id = ? AND employee_id = ?', [c.company_id, c.employee_id]);
    db.run("DELETE FROM import_issues WHERE company_id = ? AND employee_id = ? AND kind = 'unknown_address'", [c.company_id, c.employee_id]);
    insert(db, 'employee_addresses', [{ company_id: c.company_id, employee_id: c.employee_id, from_month: 1, address_id: addressId, sort: 0 }]);
    insert(db, 'corrections', [{ company_id: c.company_id, employee_id: c.employee_id, value: [c.line1, c.city, c.state, c.zip].filter(Boolean).join(', '), address_id: addressId, found_in_lookup: found ? 1 : 0, at: c.at }]);
    db.run('RELEASE correction');
  } catch (err) {
    db.run('ROLLBACK TO correction');
    db.run('RELEASE correction');
    throw err;
  }
  return { addressId, found: Boolean(found) };
}

// ---------- work and audit tables, written by the app ----------

export const WORK_TABLES = ['expected_taxes', 'line_results', 'decisions', 'migrations', 'audit_log', 'model_runs'];

// The work and audit rows, from the engine's analysis of each business and the decisions made so far.
// analysisOf(id) may throw for a file the engine stops on; that business then has no work rows.
export function workRows({ companies, analysisOf, decisionsOf, audit = [], modelVersion = '' }) {
  const rows = Object.fromEntries(WORK_TABLES.map((t) => [t, []]));
  const known = new Set(companies.map((c) => c.company_id));
  let models = null;
  const by = (x) => (x.auto ? 'rule' : null);
  for (const c of companies) {
    const id = c.company_id;
    let a;
    try { a = analysisOf(id); } catch { continue; }
    models ??= a.models;
    const d = decisionsOf(id);
    const gaps = new Set(a.gaps.map((g) => `${g.employee_id}|${g.tax_id}`));
    for (const e of a.employees) {
      for (const x of e.expected.list) {
        rows.expected_taxes.push({ company_id: id, employee_id: e.employee_id, tax_id: x.tax_id, required: x.required ? 1 : 0, months: monthSpan(x.months) || 'none', gap: gaps.has(`${e.employee_id}|${x.tax_id}`) ? 1 : 0 });
      }
    }
    const lines = new Set();
    for (const k of effectiveAll(a, d)) {
      const e = k.decision.employer;
      const x = k.decision.expert;
      lines.add(k.case_id);
      rows.line_results.push({
        company_id: id, employee_id: k.employee_id, item_id: k.item.item_id, state: k.state ?? null,
        route: k.route, reason: k.reason ?? null, stage: k.stage,
        online_tax: k.route === 'local_tax' ? k.proposal.map((p) => p.tax.name).join(' + ') : k.route === 'custom_entry' ? k.entry?.name ?? null : null,
        decided_by: e ? (e.auto ? 'rule' : 'employer') : x ? (x.auto ? 'rule' : 'expert') : null,
        rule: e?.rule ?? x?.rule ?? null,
      });
    }
    for (const [caseId, rec] of Object.entries(d.cases ?? {})) {
      if (!lines.has(caseId)) continue;
      const [, employeeId, itemId] = caseId.split(':');
      const row = (who, r, action) => ({ company_id: id, employee_id: employeeId, item_id: itemId, tax_id: r.tax_id ?? null, decided_by: who, action, rule: r.rule ?? null, at: r.at ?? null });
      if (rec.sentToExpert) rows.decisions.push(row('employer', rec.sentToExpert, 'sent_to_expert'));
      if (rec.expert) rows.decisions.push(row(by(rec.expert) ?? 'expert', rec.expert, rec.expert.action));
      if (rec.employer) rows.decisions.push(row(by(rec.employer) ?? 'employer', rec.employer, rec.employer.action));
    }
    for (const [gapId, rec] of Object.entries(d.gaps ?? {})) {
      const [, employeeId, taxId] = gapId.split(':');
      if (!a.gaps.some((g) => g.gap_id === gapId)) continue;
      rows.decisions.push({ company_id: id, employee_id: employeeId, item_id: null, tax_id: taxId, decided_by: by(rec) ?? 'employer', action: rec.action === 'add' ? 'add_tax' : rec.action, rule: rec.rule ?? null, at: rec.at ?? null });
    }
    const off = Object.entries(d.policy ?? {}).filter(([, on]) => !on).map(([rule]) => rule);
    rows.migrations.push({ company_id: id, status: d.reconciled ? 'reconciled' : d.live ? 'live' : d.autoRun ? 'moved' : 'not_moved', rules_off: off.join(', ') || null });
  }
  rows.audit_log = audit.filter((x) => !x.company_id || known.has(x.company_id)).map((x) => ({ at: x.at, company_id: x.company_id ?? null, actor: x.actor, action: x.action, target: x.target ?? null, detail: x.detail ?? null }));
  rows.model_runs = Object.values(models ?? {}).map((m) => ({ state_code: m.state, model_version: modelVersion || m.version, labels: m.poolSize, k: m.k ?? null, silhouette: m.silhouette ?? null, precision_score: m.precision ?? null, coverage: m.coverage ?? null, mode: m.mode }));
  return rows;
}
export function writeWork(db, rows) {
  db.run('BEGIN');
  try {
    for (const t of [...WORK_TABLES].reverse()) db.run(`DELETE FROM ${t}`);
    for (const t of WORK_TABLES) insert(db, t, rows[t] ?? []);
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
      columns: all(db, `PRAGMA table_info(${name})`).filter((c) => c.name !== 'sort').map((c) => c.name),
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
  const columns = all(db, `PRAGMA table_info(${name})`).filter((c) => c.name !== 'sort' && c.name !== 'null_fields').map((c) => ({
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
// savepoint and always rolls back, so the demo data never changes; the database's own error comes back.
export const RULE_CHECKS = [
  { id: 'fk', label: 'Add an employee to a business that does not exist', rule: 'Foreign key',
    sql: "INSERT INTO employees (company_id, employee_id, name, site_id, monthly_wages) VALUES ('NO-SUCH-BUSINESS', 'E999', 'Test Person', 'S1', 3000)" },
  { id: 'pk', label: 'Add the same employee twice', rule: 'Primary key',
    sql: "INSERT INTO employees (company_id, employee_id, name, site_id, monthly_wages) SELECT company_id, employee_id, name, site_id, monthly_wages FROM employees LIMIT 1" },
  { id: 'month', label: 'Set a move month of 13', rule: 'Check',
    sql: "UPDATE companies SET migration_month = 13 WHERE company_id = (SELECT company_id FROM companies ORDER BY sort LIMIT 1)" },
  { id: 'rate', label: 'Give a tax a rate of 150%', rule: 'Check',
    sql: "UPDATE taxes SET rate = 150 WHERE tax_id = 'OH-SD-2305'" },
  { id: 'line', label: 'Record a Desktop line for an item the business never set up', rule: 'Foreign key',
    sql: "INSERT INTO desktop_lines (company_id, employee_id, item_id) SELECT company_id, employee_id, 'NO-SUCH-ITEM' FROM employees LIMIT 1" },
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
