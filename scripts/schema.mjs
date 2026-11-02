// Writes docs/schema.sql, docs/schema.md and docs/schema.mmd from the schema the app runs.
// Run: npm run schema. tests/db.test.mjs checks the files are up to date.
// To redraw web/schema-diagram.svg after a change to the tables:
//   npx @mermaid-js/mermaid-cli -i docs/schema.mmd -o web/schema-diagram.svg -c docs/mermaid-config.json -b white
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { schemaDocs } from './schema-docs.mjs';

const require = createRequire(import.meta.url);
const code = await readFile(new URL('../web/vendor/sql-wasm.js', import.meta.url), 'utf8');
const module = { exports: {} };
const file = new URL('../web/vendor/sql-wasm.js', import.meta.url).pathname;
new Function('module', 'exports', 'require', '__dirname', '__filename', code)(module, module.exports, require, file.replace(/[^/]+$/, ''), file);
const SQL = await module.exports({ wasmBinary: await readFile(new URL('../web/vendor/sql-wasm.wasm', import.meta.url)) });

const docs = schemaDocs(SQL);
const out = { 'schema.sql': docs.sql, 'schema.md': docs.md, 'schema.mmd': docs.mmd };
for (const [name, text] of Object.entries(out)) await writeFile(new URL(`../docs/${name}`, import.meta.url), text);
console.log(`Wrote ${Object.keys(out).map((n) => `docs/${n}`).join(', ')}.`);
