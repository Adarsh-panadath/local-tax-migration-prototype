-- Local Tax Migration: the database schema.
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
