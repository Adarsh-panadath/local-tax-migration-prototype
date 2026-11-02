// The schema documents, generated from the schema the app actually runs (web/db.mjs), so they cannot drift:
//   docs/schema.sql  the CREATE TABLE statements
//   docs/schema.md   the explanation, with every table, its keys and its rules
//   docs/schema.mmd  the diagram (Mermaid), drawn to web/schema-diagram.svg
// scripts/schema.mjs writes them; tests/db.test.mjs checks they are up to date.
import { SCHEMA, TABLE_GROUPS, TABLE_NOTES, all, describeTable } from '../web/db.mjs';

// Each table with its key columns and one or two that tell the story.
const SHOWN = {
  company: ['company_id', 'name', 'migration_month'],
  worksites: ['site_id', 'name', 'address_id'],
  employees: ['employee_id', 'name', 'site_id'],
  home_addresses: ['employee_id', 'from_month', 'address_id'],
  payroll_items: ['item_id', 'label', 'system_tax_id'],
  desktop_lines: ['employee_id', 'item_id'],
  addresses: ['address_id', 'city', 'school_district'],
  taxes: ['tax_id', 'name', 'rate'],
  expected_taxes: ['employee_id', 'tax_id', 'gap'],
  line_results: ['employee_id', 'item_id', 'route', 'decided_by'],
  decision_log: ['log_id', 'who', 'action'],
};

function erDiagram(db) {
  const out = ['erDiagram'];
  const tables = TABLE_GROUPS.flatMap((g) => g.tables);
  for (const name of tables) {
    const fkCols = new Set(all(db, `PRAGMA foreign_key_list(${name})`).map((f) => f.from));
    const cols = all(db, `PRAGMA table_info(${name})`).filter((c) => SHOWN[name].includes(c.name));
    out.push(`  ${name} {`);
    for (const c of cols) {
      const keys = [c.pk > 0 ? 'PK' : '', fkCols.has(c.name) ? 'FK' : ''].filter(Boolean).join(', ');
      out.push(`    ${(c.type || 'TEXT').toLowerCase()} ${c.name}${keys ? ` ${keys}` : ''}`);
    }
    out.push('  }');
  }
  for (const name of tables) {
    const fks = all(db, `PRAGMA foreign_key_list(${name})`);
    const pk = all(db, `PRAGMA table_info(${name})`).filter((c) => c.pk > 0).map((c) => c.name).sort().join(',');
    for (const id of [...new Set(fks.map((f) => f.id))]) {
      const parts = fks.filter((f) => f.id === id).sort((a, b) => a.seq - b.seq);
      const from = parts.map((f) => f.from);
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
  const mmd = erDiagram(db);
  const tableDocs = TABLE_GROUPS.map((g, gi) => {
    const rows = g.tables.map((name) => {
      const t = describeTable(db, name);
      const pk = t.columns.filter((c) => c.pk).map((c) => c.name);
      const links = t.foreignKeys.map((f) => `\`${f.from.join(', ')}\` → \`${f.table}\``).join('<br>') || '-';
      return `| \`${name}\` | ${TABLE_NOTES[name]} | \`${pk.join(', ')}\` | ${links} |`;
    }).join('\n');
    return `### ${gi + 1}. ${g.title} (${g.owner})\n\n| Table | What it holds | Primary key | Links to |\n| --- | --- | --- | --- |\n${rows}\n`;
  }).join('\n');
  const tableCount = TABLE_GROUPS.reduce((n, g) => n + g.tables.length, 0);
  db.close();

  const md = `# The database schema

*Generated from the schema the app runs (\`npm run schema\`). The SQL is in [schema.sql](schema.sql).*

## What a schema is

The schema is the blueprint of the database: which tables exist, their columns, the **primary key** that identifies each row, the **foreign keys** that link tables, and the **rules** the data must follow.

Think of a workbook: each table is a sheet, the columns are its headings, the primary key is an ID column that never repeats, and a foreign key is a column that must match an ID on another sheet. The difference: a database refuses a row that breaks a rule.

## One database per migration

A migration moves one business from Desktop to Online payroll, so the database holds that one business: **${tableCount} tables in three groups**, and no table needs a company id. Moving another business means a new database with the same tables.

| Group | Who it comes from | Tables |
| --- | --- | --- |
${TABLE_GROUPS.map((g, i) => `| ${i + 1}. ${g.title} | ${g.owner} | ${g.tables.map((t) => `\`${t}\``).join(', ')} |`).join('\n')}

Data moves one way: the Desktop file is copied into group 1 and never edited; the engine reads it with group 2 and writes what it finds, and what people decide, to group 3.

![The tables and how they link](../web/schema-diagram.svg)

## One Desktop line, followed through the keys

1. \`desktop_lines\` has one row per employee per payroll item: (\`employee_id\`, \`item_id\`).
2. \`employee_id\` leads to \`employees\`, and \`home_addresses\` gives where that person lives.
3. The address's \`school_district\` in \`addresses\` is the same code as a school-district tax in \`taxes\`. **The address decides the exact tax**; the Desktop label only says what kind of tax it is.
4. \`expected_taxes\` lists what the addresses say each person owes; \`gap = 1\` means nothing in Desktop withholds it.
5. \`line_results\` says where the line ended up: its route, the Online tax, and who settled it. \`decision_log\` records every step.

The Data page's example query **One line across the keys** runs this join.

## Design choices

- **One fact in one place.** A tax's rate is stored once, in \`taxes\`; everything else points to it.
- **Home addresses have their own table** because people move. A move is a second row with the month it starts.
- **The Desktop file is never edited.** Results and decisions go to their own tables, so what Desktop said stays next to what happened.
- **Keys the database enforces.** The same item twice for one person, or a line for an item that does not exist, is refused when the file is loaded.

## Rules the database enforces

Every table has a primary key; foreign keys and CHECK rules are on. The Data page has five buttons that each try to break a rule. The database refuses every one, and nothing changes:

| Try to | The database answers |
| --- | --- |
| Add an employee at a work site that does not exist | FOREIGN KEY constraint failed |
| Add the same employee twice | UNIQUE constraint failed: employees.employee_id |
| Set the move month to 13 | CHECK constraint failed: month_1_to_12 |
| Give a tax a rate of 150% | CHECK constraint failed: rate_0_to_100 |
| Record a Desktop line for an item the business never set up | FOREIGN KEY constraint failed |

## Every table

${tableDocs}
## Where it runs

SQLite inside the web page (sql.js, compiled to WebAssembly): no server, no account, no key. It is rebuilt every time the page opens. The tax catalogue, the address lookup and the model's labelled examples are Intuit's reference data; only the parts this business uses go into the database. In production the tables would live in a server database such as PostgreSQL.

## How to show it

1. Sign in as the admin and open **Data**. Click any table for its columns and keys.
2. Open **Diagram of the tables**.
3. Click **Try all** under "The database checks the data itself".
4. Run **One line across the keys**.
5. Click **Download the database** and open it in DB Browser for SQLite (free).
`;
  return { sql: SCHEMA.trimStart(), md, mmd };
}
