-- Local Tax Migration: the database schema. Seven tables, one database per migration.
--   From the Desktop file:  company, employees, payroll_items, desktop_lines
--   From Intuit's lookup:   addresses, taxes
--   Our result:             results
-- Every table has a primary key. Foreign keys link the tables; CHECK rules refuse impossible values.

PRAGMA foreign_keys = ON;

-- The business being moved: one row.
CREATE TABLE company (
  company_id       TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  plan             TEXT NOT NULL CHECK (plan IN ('Core', 'Premium', 'Elite')),
  migration_month  INTEGER NOT NULL CONSTRAINT month_1_to_12 CHECK (migration_month BETWEEN 1 AND 12)
);

-- An address, and the school district and city the lookup places it in.
-- school_district matches taxes.code; UNRESOLVED when the lookup cannot place the address.
CREATE TABLE addresses (
  address_id       TEXT PRIMARY KEY,
  street           TEXT,
  city             TEXT,
  state            TEXT,
  zip              TEXT,
  school_district  TEXT,
  tax_city         TEXT                              -- the city whose income tax applies, if any
);

-- The people. Where they work, where they live, and where they moved to if they moved this year.
CREATE TABLE employees (
  employee_id          TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  monthly_wages        REAL NOT NULL CONSTRAINT wages_not_negative CHECK (monthly_wages >= 0),
  work_site            TEXT NOT NULL,
  work_address_id      TEXT NOT NULL REFERENCES addresses (address_id),
  home_address_id      TEXT REFERENCES addresses (address_id),          -- empty: Desktop has no home address
  new_home_address_id  TEXT REFERENCES addresses (address_id),          -- after a move
  moved_month          INTEGER CHECK (moved_month BETWEEN 2 AND 12),
  remote               INTEGER CHECK (remote IN (0, 1)),
  hired_month          INTEGER CHECK (hired_month BETWEEN 1 AND 12),
  left_month           INTEGER CHECK (left_month BETWEEN 1 AND 12)
);

-- The local taxes Online payroll knows. law_id: the tax's unique Law ID.
-- code: the school-district number (it matches addresses.school_district), or the city for a city tax.
CREATE TABLE taxes (
  law_id  INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  type    TEXT NOT NULL CHECK (type IN ('school_district', 'municipal', 'earned_income', 'local_services')),
  code    TEXT,
  rate    REAL NOT NULL CONSTRAINT rate_0_to_100 CHECK (rate BETWEEN 0 AND 100),   -- percent
  agency  TEXT
);

-- Payroll items as set up in Desktop, with the label exactly as someone typed it.
-- law_id: an item QuickBooks already knows carries its tax's Law ID, so it matches taxes.law_id.
-- An item the employer created carries 177 (or 0), which names no tax: those are the lines the engine
-- works out from the address and the label. That is why law_id here is not a foreign key.
CREATE TABLE payroll_items (
  item_id            TEXT PRIMARY KEY,
  label              TEXT,
  law_id             INTEGER NOT NULL,
  item_type          TEXT,
  tracking_type      TEXT,                           -- None: Desktop treats it as an after-tax deduction
  rate_percent       REAL CHECK (rate_percent BETWEEN 0 AND 100),
  annual_amount      REAL CHECK (annual_amount >= 0),
  agency             TEXT,
  agency_account     TEXT,
  deposit_frequency  TEXT
);

-- One row per employee per payroll item: a Desktop local tax line.
CREATE TABLE desktop_lines (
  employee_id  TEXT NOT NULL REFERENCES employees (employee_id),
  item_id      TEXT NOT NULL REFERENCES payroll_items (item_id),
  PRIMARY KEY (employee_id, item_id)
);

-- Where each Desktop line went: the route, the Law ID of the tax it becomes in Online payroll, and who decided.
CREATE TABLE results (
  employee_id  TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  route        TEXT NOT NULL CONSTRAINT route_value CHECK (route IN ('local_tax', 'not_a_tax', 'not_in_database', 'custom_entry', 'stop')),
  law_id       INTEGER REFERENCES taxes (law_id),    -- the Online payroll tax from the first Online payroll
  status       TEXT NOT NULL CHECK (status IN ('awaiting_employer', 'with_expert', 'confirmed', 'moved_to_deduction', 'employer_managed', 'stopped')),
  reason       TEXT,                                 -- why it needs a person: weak_signal, no_address ...
  decided_by   TEXT CHECK (decided_by IN ('rule', 'employer', 'expert')),
  rule         TEXT,
  PRIMARY KEY (employee_id, item_id),
  FOREIGN KEY (employee_id, item_id) REFERENCES desktop_lines (employee_id, item_id)
);
