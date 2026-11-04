// The schema documents, generated from the schema the app actually runs (web/db.mjs), so they cannot drift:
//   docs/schema.sql  the CREATE TABLE statements
//   docs/schema.md   the explanation, with every table, its keys and its rules
//   docs/schema.mmd  the diagram (Mermaid), drawn to web/schema-diagram.svg
// scripts/schema.mjs writes them; tests/db.test.mjs checks they are up to date.
import { SCHEMA, TABLE_GROUPS, TABLE_NOTES, all, describeTable } from '../web/db.mjs';

// Each table with its key columns and one or two that tell the story.
const SHOWN = {
  company: ['company_id', 'name', 'migration_month'],
  employees: ['employee_id', 'name', 'work_address_id', 'home_address_id', 'new_home_address_id'],
  payroll_items: ['item_id', 'label', 'law_id'],
  desktop_lines: ['employee_id', 'item_id'],
  addresses: ['address_id', 'city', 'school_district'],
  taxes: ['law_id', 'name', 'code', 'rate'],
  results: ['employee_id', 'item_id', 'route', 'law_id', 'decided_by'],
};

function erDiagram(db) {
  const out = ['erDiagram'];
  const tables = TABLE_GROUPS.flatMap((g) => g.tables);
  for (const name of tables) {
    const fkCols = new Set(all(db, `PRAGMA foreign_key_list(${name})`).map((f) => f.from));
    const cols = all(db, `PRAGMA table_info(${name})`).filter((c) => SHOWN[name].includes(c.name));
    out.push(`  ${name} {`);
    for (const c of cols) {
      const keys = [c.pk > 0 ? 'PK' : '', fkCols.has(c.name) ? 'FK' : '', name === 'payroll_items' && c.name === 'law_id' ? '"matches taxes for system items"' : ''].filter(Boolean).join(', ');
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
  // Law ID links a system item to its tax, but a custom item carries 177 or 0, so it is not a foreign key: dotted.
  out.push('  taxes |o..o{ payroll_items : "law_id (system items only)"');
  return `${out.join('\n')}\n`;
}

export function schemaDocs(SQL) {
  const db = new SQL.Database();
  db.run(SCHEMA);
  const mmd = erDiagram(db);
  const tableDocs = TABLE_GROUPS.map((g, gi) => {
    const rows = g.tables.map((name) => {
      const t = describeTable(db, name);
      const cols = t.columns.map((c) => `\`${c.name}\``).join(', ');
      return `| \`${name}\` | ${TABLE_NOTES[name]} | ${cols} |`;
    }).join('\n');
    return `### ${gi + 1}. ${g.title}\n\n| Table | What it holds | Columns |\n| --- | --- | --- |\n${rows}\n`;
  }).join('\n');
  const tablesById = Object.fromEntries(TABLE_GROUPS.flatMap((g) => g.tables).map((name) => [name, describeTable(db, name)]));
  db.close();

  const md = `# The database schema

*Generated from the schema the app runs (\`npm run schema\`). The SQL is in [schema.sql](schema.sql).*

## In one line

**Seven tables, one database per migration.** Four come from the business's Desktop file, two from Intuit's address and tax lookup, and one holds our result.

| Group | Tables | In plain words |
| --- | --- | --- |
| From the Desktop file | \`company\`, \`employees\`, \`payroll_items\`, \`desktop_lines\` | Who the business is, its people, its payroll items, and which person has which item |
| From Intuit's lookup | \`addresses\`, \`taxes\` | Which school district and city each address is in, and the exact local taxes, each with its unique **Law ID** |
| Our result | \`results\` | Where each Desktop line went, the Law ID of its Online tax, and who decided |

![The seven tables and how they link](../web/schema-diagram.svg)

## The Law ID

**Every tax has a Law ID, its unique identifier** (the primary key of \`taxes\`). A Desktop payroll item that QuickBooks already knows carries its tax's Law ID, for example *Columbus City Tax, Law ID 4140*, so it maps straight to the tax. An item the employer created carries **177 (or 0)**, which names no tax: *"Schl Dist W/H", Law ID 177*. Those are the lines the engine has to work out from the employee's address and the label. The migration's job, in one line: **turn every 177 into a real Law ID.**

The Law ID numbers in this demo (4120 Lancaster city, 4140 Columbus city, 5303 to 5503 for school districts) are demo numbers, not Intuit's.

## What a schema is

The schema is the blueprint of the database: the tables, their columns, the **primary key** that identifies each row, the **foreign keys** that link tables, and the **rules** the data must follow. Think of a workbook: each table is a sheet, the primary key is an ID column that never repeats, and a foreign key is a column that must match an ID on another sheet. A database refuses a row that breaks a rule.

## The story in four steps

1. **Desktop gives us lines.** \`desktop_lines\` has one row per employee per payroll item, for example *Maya Perez* has *"Lancaster Schools"*, Law ID 177. 177 means the employer created the item, so it names no tax.
2. **The address says which tax.** The employee's \`home_address_id\` leads to \`addresses\`, which holds the school district code (2305). That code matches \`taxes.code\`: *Lancaster City School District, Law ID 5305, 1.5%*. (A system item skips this step: its Law ID already names the tax.)
3. **The engine writes the result.** \`results\` gets one row per Desktop line: the route (local tax, not a tax, or an expert), the \`law_id\` of the tax it becomes in Online payroll, and who decided (a rule, the employer or an expert). So the line goes from Law ID 177 to Law ID 5305.
4. **Nothing in the Desktop file is changed.** Results live in their own table, so what Desktop said stays next to what happened.

The Data page query **Law ID before and after** runs exactly this join.

## Why one database per migration

A migration moves one business, so the database holds that one business and no table needs a company id. Moving another business means a new database with the same seven tables.

## Keys and rules

| Table | Primary key | Must match (foreign key) |
| --- | --- | --- |
${TABLE_GROUPS.flatMap((g) => g.tables).map((name) => { const t = tablesById[name]; return `| \`${name}\` | \`${t.columns.filter((c) => c.pk).map((c) => c.name).join(', ')}\` | ${[...t.foreignKeys.map((f) => `\`${f.from.join(', ')}\` → \`${f.table}\``), ...(name === 'payroll_items' ? ['\`law_id\` → \`taxes\` for system items only (177 and 0 name no tax, so it is not enforced)'] : [])].join('<br>') || '-'} |`; }).join('\n')}

The Data page has five buttons that each try to break a rule. The database refuses every one, and nothing changes:

| Try to | The database answers |
| --- | --- |
| Add an employee who works at an address that does not exist | FOREIGN KEY constraint failed |
| Add the same employee twice | UNIQUE constraint failed: employees.employee_id |
| Set the move month to 13 | CHECK constraint failed: month_1_to_12 |
| Give a tax a rate of 150% | CHECK constraint failed: rate_0_to_100 |
| Record a Desktop line for an item the business never set up | FOREIGN KEY constraint failed |

## Every table

${tableDocs}
## Questions you may be asked

- **What is a Law ID?** The unique identifier of each tax, the primary key of \`taxes\`. Desktop system items carry it, so they map directly; items the employer created carry 177 or 0 and need the address.
- **Why is payroll_items.law_id not a foreign key?** Because 177 and 0 are not taxes: they mean "the employer made this item". For system items it does match \`taxes.law_id\` (the dotted line in the diagram); \`results.law_id\` is a real foreign key, because every result names a real tax.
- **Why is the address in its own table?** Many employees share an address's district, and the lookup is Intuit's data. Each fact is stored once; employees point to it.
- **Why a separate desktop_lines table?** One employee has many payroll items and one item is on many employees (many-to-many). \`desktop_lines\` is the link table between them.
- **Why is results separate from desktop_lines?** The Desktop file is never edited. The result can change as people decide; the source cannot.
- **What if someone moved?** \`employees\` keeps the new address and the month (\`new_home_address_id\`, \`moved_month\`). The prototype keeps one move a year.
- **Where is the audit trail?** \`results\` says who decided each line and by which rule; the app's Log page keeps every step with its time.
- **Where does it run?** SQLite inside the web page (sql.js): no server, no key, rebuilt on every visit. In production the same tables would run on a server database such as PostgreSQL.

## How to show it

1. Sign in as the admin and open **Data**. Click any table for its columns and keys.
2. Open **Diagram of the tables**.
3. Click **Try all** under "The database checks the data itself".
4. Run **Items by Law ID**, **Law ID before and after** and **The address picks the tax**.
5. Click **Download the database** and open it in DB Browser for SQLite (free).
`;
  return { sql: SCHEMA.trimStart(), md, mmd };
}
