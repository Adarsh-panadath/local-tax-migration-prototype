-- Local Tax Migration: the database schema.
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
