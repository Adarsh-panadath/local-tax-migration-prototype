// The schema documents, generated from the schema the app actually runs (web/db.mjs), so they cannot drift:
//   docs/schema.sql       the CREATE TABLE statements
//   docs/schema.md        the explanation, with every table, its keys and its rules
//   docs/schema.mmd       a diagram of every table (Mermaid)
//   docs/schema-core.mmd  a diagram of the main tables, drawn to web/schema-diagram.svg
// scripts/schema.mjs writes them; tests/db.test.mjs checks they are up to date.
import { SCHEMA, TABLE_GROUPS, TABLE_NOTES, all, describeTable } from '../web/db.mjs';

// The main tables only, with their key columns and one or two that tell the story.
const CORE = {
  companies: ['company_id', 'name', 'migration_month'],
  worksites: ['company_id', 'site_id', 'address_id'],
  employees: ['company_id', 'employee_id', 'site_id', 'monthly_wages'],
  employee_addresses: ['company_id', 'employee_id', 'from_month', 'address_id'],
  addresses: ['address_id', 'school_district', 'municipality'],
  payroll_items: ['company_id', 'item_id', 'label', 'system_tax_id'],
  desktop_lines: ['company_id', 'employee_id', 'item_id'],
  taxes: ['tax_id', 'type', 'code', 'rate'],
  expected_taxes: ['company_id', 'employee_id', 'tax_id', 'gap'],
  line_results: ['company_id', 'employee_id', 'item_id', 'route', 'stage', 'decided_by'],
  decisions: ['decision_id', 'company_id', 'employee_id', 'item_id', 'tax_id', 'decided_by'],
};
const HIDDEN = ['sort', 'null_fields'];

function erDiagram(db, tables, keepLink) {
  const out = ['erDiagram'];
  for (const [name, want] of tables) {
    const fkCols = new Set(all(db, `PRAGMA foreign_key_list(${name})`).map((f) => f.from));
    const cols = all(db, `PRAGMA table_info(${name})`).filter((c) => !HIDDEN.includes(c.name) && (!want || want.includes(c.name)));
    out.push(`  ${name} {`);
    for (const c of cols) {
      const keys = [c.pk > 0 ? 'PK' : '', fkCols.has(c.name) ? 'FK' : ''].filter(Boolean).join(', ');
      out.push(`    ${(c.type || 'TEXT').toLowerCase()} ${c.name}${keys ? ` ${keys}` : ''}`);
    }
    out.push('  }');
  }
  for (const [name] of tables) {
    const fks = all(db, `PRAGMA foreign_key_list(${name})`);
    const pk = all(db, `PRAGMA table_info(${name})`).filter((c) => c.pk > 0).map((c) => c.name).sort().join(',');
    for (const id of [...new Set(fks.map((f) => f.id))]) {
      const parts = fks.filter((f) => f.id === id).sort((a, b) => a.seq - b.seq);
      const from = parts.map((f) => f.from);
      if (!keepLink(name, parts[0].table, from, fks, id)) continue;
      // When the link is the whole primary key, each parent row has at most one child row.
      const many = [...from].sort().join(',') === pk ? 'o|' : 'o{';
      out.push(`  ${parts[0].table} ||--${many} ${name} : "${from.join(', ')}"`);
    }
  }
  return `${out.join('\n')}\n`;
}

export function schemaDocs(SQL) {
  const db = new SQL.Database();
  db.run(SCHEMA);
  const allTables = TABLE_GROUPS.flatMap((g) => g.tables.map((t) => [t, null]));
  const mmd = erDiagram(db, allTables, () => true);
  const core = erDiagram(db, Object.entries(CORE), (name, parent, from, fks, id) => {
    if (!CORE[parent] || !from.every((c) => CORE[name].includes(c))) return false;
    // Leave out a link that a longer one already says (employees to companies, inside employees to worksites).
    const longer = [...new Set(fks.map((f) => f.id))].some((other) => other !== id && fks.filter((f) => f.id === other).length > from.length && from.every((c) => fks.some((f) => f.id === other && f.from === c)));
    return !longer;
  });

  const tableDocs = TABLE_GROUPS.map((g, gi) => {
    const rows = g.tables.map((name) => {
      const t = describeTable(db, name);
      const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
      const links = t.foreignKeys.map((f) => `\`${f.from.join(', ')}\` → \`${f.table}\``).join('<br>') || '-';
      const rules = t.checks.map((c) => `\`${c.replace(/\|/g, '\\|')}\``).join('<br>') || '-';
      return `| \`${name}\` | ${TABLE_NOTES[name]} | \`${pk.join(', ')}\` | ${links} | ${rules} |`;
    }).join('\n');
    return `### ${gi + 1}. ${g.title} (${g.owner})\n\n${g.note}\n\n| Table | What it holds | Primary key | Foreign keys | Rules |\n| --- | --- | --- | --- | --- |\n${rows}\n`;
  }).join('\n');
  const tableCount = TABLE_GROUPS.reduce((n, g) => n + g.tables.length, 0);
  const fkCount = TABLE_GROUPS.flatMap((g) => g.tables).reduce((n, t) => n + describeTable(db, t).foreignKeys.length, 0);
  const checkCount = TABLE_GROUPS.flatMap((g) => g.tables).reduce((n, t) => n + describeTable(db, t).checks.length, 0);
  db.close();

  const md = `# The database schema

*This file is generated from the schema the app runs (\`npm run schema\`). The SQL is in [schema.sql](schema.sql).*

## What a schema is

The schema is the blueprint of the database: which tables exist, which columns each one has and their types, the **primary key** that identifies each row, the **foreign keys** that link tables, and the **rules** the data must follow. The data is the rows; the schema is the structure that keeps them correct.

Think of a workbook: each table is a sheet, the columns are its headings, the primary key is an ID column that never repeats, a foreign key is a column that must match an ID on another sheet, and a rule is data validation ("month must be 1 to 12"). The difference: a database refuses a row that breaks a rule, instead of just highlighting it.

## Where it runs

The prototype uses **SQLite** inside the web page (sql.js, compiled to WebAssembly), so it needs no server, account or key. It is rebuilt every time the page opens: from the demo files, the 60 generated businesses, and anything uploaded or corrected in that browser. Foreign keys and CHECK rules are switched on.

In production the same tables would live in a server database such as **PostgreSQL**, shared by every employer, expert and admin, with access limited to each person's own business.

## Four layers

The ${tableCount} tables are in four layers. Each layer has one owner, so it is clear who may change what.

| Layer | Owner | What it holds |
| --- | --- | --- |
${TABLE_GROUPS.map((g, i) => `| ${i + 1}. ${g.title} | ${g.owner} | ${g.tables.map((t) => `\`${t}\``).join(', ')} |`).join('\n')}

Data moves one way: the Desktop file is copied into **Source** and never edited; the engine reads Source and the **Tax reference**, and writes what it finds to **Work**; people's decisions go to **Work** too; and **Audit** records who did what.

## The main tables

![The main tables and how they link](../web/schema-diagram.svg)

The full diagram of all ${tableCount} tables is in [schema.mmd](schema.mmd) (paste it into mermaid.live to draw it).

## One Desktop line, followed through the keys

1. \`desktop_lines\` holds one row per employee per payroll item: (\`company_id\`, \`employee_id\`, \`item_id\`).
2. \`employee_id\` points to \`employees\`, and \`employee_addresses\` gives that person's home address for each part of the year.
3. The address's \`school_district\` code in \`addresses\` is the same code as a school-district tax in \`taxes\`. That is how **the address decides which exact tax applies**; the Desktop label only says what kind of tax it is.
4. \`expected_taxes\` lists what the addresses say each person owes. A row with \`gap = 1\` is owed, but no Desktop line withholds it.
5. \`line_results\` says where the line stands: its route (local tax, not a tax, or an expert), why, and who settled it. \`decisions\` holds every decision, one row each.

The Data page's example query **One line across the keys** runs exactly this join.

## Design choices

- **One fact in one place (normalisation).** A tax's rate is stored once, in \`taxes\`; everything else points to it by \`tax_id\`. Change it once and it is right everywhere.
- **Addresses have their own table, with a start month,** because people move during the year. A move is a second row in \`employee_addresses\`.
- **The Desktop file is never edited.** An address the employer adds goes to \`corrections\`, so you can always show what Desktop said next to what the employer fixed.
- **Nothing in the file is lost.** A row that breaks a key (an item that does not exist, the same item twice, an address nobody knows) goes to \`import_issues\` instead of being dropped, and the engine reports it.
- **Every decision is a row** in \`decisions\`, with who decided (a rule, the employer or an expert), what and when. Together with \`audit_log\` this is the audit trail.
- **Keys that combine columns.** An employee ID is only unique inside one business, so the key of \`employees\` is (\`company_id\`, \`employee_id\`).

## Rules the database enforces

${fkCount} foreign keys and ${checkCount} CHECK rules, plus a primary key on every table. For example: a move month must be 1 to 12, a rate 0 to 100%, wages not negative, a route one of five values, and a customer-typed address must name its business.

The Data page has five buttons that each try to break one rule. The database refuses every one with its own error message, inside a transaction that is rolled back, so nothing changes:

| Try to | The database answers |
| --- | --- |
| Add an employee to a business that does not exist | FOREIGN KEY constraint failed |
| Add the same employee twice | UNIQUE constraint failed: employees.company_id, employees.employee_id |
| Set a move month of 13 | CHECK constraint failed: month_1_to_12 |
| Give a tax a rate of 150% | CHECK constraint failed: rate_0_to_100 |
| Record a Desktop line for an item the business never set up | FOREIGN KEY constraint failed |

## Every table

${tableDocs}
## How to show it

1. Sign in as the admin and open **Data**. The schema shows the four layers; click any table for its columns, keys, rules, the tables it links to and its CREATE statement.
2. Open **Diagram of the main tables**.
3. Click **Try all** under "The database checks the data itself".
4. Run **One line across the keys** in "Ask the data".
5. Click **Download the database** and open the file in DB Browser for SQLite (free), or any SQLite tool: the same tables, keys and data.

## Limits, said plainly

- Each visitor gets their own copy, rebuilt on every visit. Decisions are kept in the browser and written into the work tables; in production the server database would be the only copy.
- Customer data is fictional. The Ohio rates and districts are real; the address lookup is a stand-in for Intuit's tax service.
- A real system would also need access control per business, encryption of pay and address data, and backups.
`;
  return { sql: SCHEMA.trimStart(), md, mmd, core };
}
