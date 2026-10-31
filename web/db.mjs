// The demo's database: SQLite (sql.js, compiled to WebAssembly) running inside the page.
// No server, no account and no keys. It is rebuilt from the demo files every time the page opens,
// so each visitor gets a private copy; uploaded Desktop files are kept in that visitor's browser.
//
// Three kinds of tables:
//   customer data  - companies, work sites, employees, their addresses and Desktop payroll items (fictional)
//   tax reference  - states, local taxes, defined entries, the address lookup and the expert-labelled pool
//                    (Ohio codes and rates are real and public; the address lookup is a demo stand-in)
//   outcomes       - where every Desktop line ended up and the decision log, written by the app
//
// The engine never reads the JSON files directly when the database is available: readData() rebuilds
// its input from SQL queries, so what the screens show is what is in the tables.

export const SCHEMA = `
CREATE TABLE dataset_info (dataset TEXT PRIMARY KEY, info_json TEXT NOT NULL);

-- tax reference (Intuit side)
CREATE TABLE states (state_code TEXT PRIMARY KEY, name TEXT NOT NULL, rollout TEXT NOT NULL, sort INTEGER);
CREATE TABLE state_place_names (state_code TEXT NOT NULL, place_name TEXT NOT NULL, sort INTEGER);
CREATE TABLE no_tax_districts (state_code TEXT NOT NULL, name TEXT NOT NULL, place TEXT, note TEXT, sort INTEGER);
CREATE TABLE taxes (tax_id TEXT PRIMARY KEY, state_code TEXT NOT NULL, type TEXT NOT NULL, code TEXT, name TEXT NOT NULL,
  place TEXT, rate REAL, base TEXT, basis TEXT, agency TEXT, qb_pays_and_files INTEGER, sort INTEGER);
CREATE TABLE defined_entries (entry_id TEXT PRIMARY KEY, kind TEXT, tax_type TEXT, label TEXT, text TEXT, sort INTEGER);
CREATE TABLE defined_entry_states (entry_id TEXT NOT NULL, state_code TEXT NOT NULL, sort INTEGER);
CREATE TABLE address_lookup (address_id TEXT PRIMARY KEY, line1 TEXT, city TEXT, state TEXT, zip TEXT,
  school_district TEXT, municipality TEXT, sort INTEGER);
CREATE TABLE label_pool (state_code TEXT NOT NULL, label TEXT, expert_label TEXT, sort INTEGER);

-- customer data (from the Desktop file)
CREATE TABLE companies (company_id TEXT NOT NULL, name TEXT NOT NULL, plan TEXT, migration_month INTEGER,
  description TEXT, source TEXT NOT NULL, sort INTEGER);
CREATE TABLE worksites (company_id TEXT NOT NULL, site_id TEXT, name TEXT, address_id TEXT, sort INTEGER);
CREATE TABLE customer_addresses (company_id TEXT NOT NULL, address_id TEXT NOT NULL, line1 TEXT, city TEXT, state TEXT, zip TEXT);
CREATE TABLE desktop_items (company_id TEXT NOT NULL, item_id TEXT, label TEXT, law_id INTEGER, origin TEXT, item_type TEXT,
  tracking_type TEXT, calc_kind TEXT, calc_rate REAL, calc_amount REAL, agency TEXT, agency_account TEXT,
  deposit_frequency TEXT, system_tax_id TEXT, null_fields TEXT, sort INTEGER);
CREATE TABLE employees (company_id TEXT NOT NULL, employee_id TEXT, name TEXT, site_id TEXT, monthly_wages REAL,
  remote INTEGER, hired_month INTEGER, left_month INTEGER, sort INTEGER);
CREATE TABLE employee_addresses (company_id TEXT NOT NULL, employee_id TEXT, address_id TEXT, from_month INTEGER, sort INTEGER);
CREATE TABLE employee_items (company_id TEXT NOT NULL, employee_id TEXT, item_id TEXT, sort INTEGER);

-- outcomes (written by the app)
CREATE TABLE line_outcomes (company_id TEXT, line_id TEXT, employee TEXT, desktop_item TEXT, state TEXT, route TEXT,
  reason TEXT, stage TEXT, online_tax TEXT, decided_by TEXT, rule TEXT);
CREATE TABLE decision_log (at TEXT, company_id TEXT, actor TEXT, action TEXT, target TEXT, detail TEXT);
`;

// What each table is, for the Data page.
export const TABLE_GROUPS = [
  { id: 'customer', title: 'Customer data', note: 'From the Desktop file. Fictional in the demo.', tables: ['companies', 'worksites', 'employees', 'employee_addresses', 'employee_items', 'desktop_items', 'customer_addresses'] },
  { id: 'reference', title: 'Tax reference', note: 'Ohio codes and rates are real and public. The address lookup stands in for Intuit\'s tax service.', tables: ['states', 'taxes', 'no_tax_districts', 'state_place_names', 'defined_entries', 'defined_entry_states', 'address_lookup', 'label_pool'] },
  { id: 'outcome', title: 'Outcomes', note: 'Written by the app: where every line went, and who decided.', tables: ['line_outcomes', 'decision_log'] },
];

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
  for (const r of rows) stmt.run(cols.map((c) => (r[c] === undefined ? null : typeof r[c] === 'boolean' ? Number(r[c]) : r[c])));
  stmt.free();
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

// ---------- writing ----------

export function createDatabase(SQL, data, uploads = []) {
  const db = new SQL.Database();
  db.run(SCHEMA);
  db.run('BEGIN');
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
  insert(db, 'address_lookup', data.geocoder.addresses.map((a, i) => ({ address_id: a.address_id, line1: a.line1, city: a.city, state: a.state, zip: a.zip, school_district: a.school_district, municipality: a.municipality, sort: i })));
  insert(db, 'label_pool', Object.entries(data.pools).flatMap(([code, list]) => list.map((p, i) => ({ state_code: code, label: p.label, expert_label: p.expert_label, sort: i }))));
  data.companies.forEach((c, i) => insertCompany(db, c, 'demo', i));
  uploads.forEach((u, i) => insertCompany(db, u.company, 'upload', 1000 + i, u.addresses));
  db.run('COMMIT');
  return db;
}

export function insertCompany(db, c, source, sort, addresses = []) {
  const id = c.company_id;
  insert(db, 'companies', [{ company_id: id, name: c.name, plan: c.plan, migration_month: c.migration_month, description: c.description, source, sort }]);
  insert(db, 'worksites', c.worksites.map((w, i) => ({ company_id: id, site_id: w.site_id, name: w.name, address_id: w.address_id, sort: i })));
  insert(db, 'customer_addresses', addresses.map((a) => ({ company_id: id, address_id: a.address_id, line1: a.line1, city: a.city, state: a.state, zip: a.zip })));
  insert(db, 'desktop_items', c.items.map((it, i) => ({
    company_id: id, item_id: it.item_id, label: it.label, law_id: it.law_id, origin: it.origin, item_type: it.item_type, tracking_type: it.tracking_type,
    calc_kind: it.calc?.kind, calc_rate: it.calc?.rate, calc_amount: it.calc?.amount, agency: it.agency, agency_account: it.agency_account,
    deposit_frequency: it.deposit_frequency, system_tax_id: it.system_tax_id,
    // Desktop exports some empty fields as an explicit null; keep that, so the file reads back exactly.
    null_fields: Object.keys(it).filter((k) => it[k] === null).join(',') || null, sort: i,
  })));
  insert(db, 'employees', c.employees.map((e, i) => ({ company_id: id, employee_id: e.employee_id, name: e.name, site_id: e.site_id, monthly_wages: e.monthly_wages, remote: has(e, 'remote') ? e.remote : null, hired_month: e.hired_month, left_month: e.left_month, sort: i })));
  insert(db, 'employee_addresses', c.employees.flatMap((e) => e.addresses.map((a, i) => ({ company_id: id, employee_id: e.employee_id, address_id: a.address_id, from_month: a.from_month, sort: i }))));
  insert(db, 'employee_items', c.employees.flatMap((e) => e.items.map((it, i) => ({ company_id: id, employee_id: e.employee_id, item_id: it, sort: i }))));
}

// ---------- reading: the engine's input, rebuilt from SQL ----------

export function readData(db) {
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
  const lookup = all(db, 'SELECT address_id, line1, city, state, zip, school_district, municipality FROM address_lookup ORDER BY sort');
  // Addresses from uploaded files that the lookup has never seen: the lookup cannot place them.
  const unplaced = all(db, 'SELECT DISTINCT address_id, line1, city, state, zip FROM customer_addresses ORDER BY rowid')
    .map((a) => ({ ...a, school_district: 'UNRESOLVED', municipality: null }));
  const geocoder = { metadata: info.geocoder, addresses: [...lookup, ...unplaced] };
  const pools = {};
  for (const r of all(db, 'SELECT state_code, label, expert_label FROM label_pool ORDER BY state_code, sort')) (pools[r.state_code] ??= []).push({ label: r.label, expert_label: r.expert_label });
  const companies = all(db, 'SELECT * FROM companies ORDER BY sort').map((c) => readCompany(db, c));
  return { catalog, geocoder, pools, poolMeta: info.label_pool, companies, companiesMeta: info.companies };
}

function readCompany(db, c) {
  const id = c.company_id;
  const out = { company_id: id, name: c.name, plan: c.plan, migration_month: c.migration_month };
  out.worksites = all(db, 'SELECT site_id, name, address_id FROM worksites WHERE company_id = ? ORDER BY sort', [id]);
  out.items = all(db, 'SELECT * FROM desktop_items WHERE company_id = ? ORDER BY sort', [id]).map((r) => {
    const it = { item_id: r.item_id, label: r.label, law_id: r.law_id, origin: r.origin, item_type: r.item_type, tracking_type: r.tracking_type };
    it.calc = r.calc_kind === 'flat_annual' ? { kind: r.calc_kind, amount: r.calc_amount } : { kind: r.calc_kind, rate: r.calc_rate };
    it.agency = r.agency;
    opt(it, 'agency_account', r.agency_account);
    opt(it, 'deposit_frequency', r.deposit_frequency);
    opt(it, 'system_tax_id', r.system_tax_id);
    for (const k of (r.null_fields ?? '').split(',').filter(Boolean)) it[k] = null;
    return it;
  });
  const addr = all(db, 'SELECT employee_id, address_id, from_month FROM employee_addresses WHERE company_id = ? ORDER BY sort', [id]);
  const items = all(db, 'SELECT employee_id, item_id FROM employee_items WHERE company_id = ? ORDER BY sort', [id]);
  out.employees = all(db, 'SELECT * FROM employees WHERE company_id = ? ORDER BY sort', [id]).map((r) => {
    const e = { employee_id: r.employee_id, name: r.name, site_id: r.site_id, monthly_wages: r.monthly_wages };
    e.addresses = addr.filter((a) => a.employee_id === r.employee_id).map((a) => ({ address_id: a.address_id, from_month: a.from_month }));
    e.items = items.filter((x) => x.employee_id === r.employee_id).map((x) => x.item_id);
    if (r.remote !== null) e.remote = Boolean(r.remote);
    opt(e, 'hired_month', r.hired_month);
    opt(e, 'left_month', r.left_month);
    return e;
  });
  opt(out, 'description', c.description);
  return out;
}

// ---------- outcomes ----------

export function writeOutcomes(db, lines, log) {
  db.run('BEGIN');
  db.run('DELETE FROM line_outcomes');
  db.run('DELETE FROM decision_log');
  insert(db, 'line_outcomes', lines);
  insert(db, 'decision_log', log);
  db.run('COMMIT');
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
    plan: first.plan || 'Premium',
    migration_month: month,
    worksites: sites,
    items: items.map(({ key, ...rest }) => rest),
    employees,
    description: `Uploaded Desktop file: ${employees.length} employees, ${rows.length} rows.`,
  };
  return { company, addresses, problems };
}
