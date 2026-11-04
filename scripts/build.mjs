import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const out = new URL('../dist/', import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL('../web/', import.meta.url), out, { recursive: true });
await cp(new URL('../data/', import.meta.url), new URL('../dist/data/', import.meta.url), { recursive: true });
// GitHub Pages serves dist/ as-is; this file turns off its Jekyll processing.
await writeFile(new URL('.nojekyll', out), '');

// Cache busting. GitHub Pages lets browsers keep files for 10 minutes, and a normal reload only
// re-checks the page itself, so a visitor could get the new page with old styles and scripts.
// Every stylesheet, module and data file is requested with ?v=<hash of the build> instead.
const files = (await readdir(out, { recursive: true })).filter((f) => /\.(mjs|css|html|json)$/.test(f)).sort();
const hash = createHash('sha256');
for (const f of files) hash.update(f).update(await readFile(new URL(f, out)));
const v = hash.digest('hex').slice(0, 10);

const stamp = (text) => text
  .replace(/(\bfrom\s+['"])(\.{1,2}\/[^'"?]+\.mjs)(['"])/g, `$1$2?v=${v}$3`)
  .replace(/(\bimport\s+['"])(\.{1,2}\/[^'"?]+\.mjs)(['"])/g, `$1$2?v=${v}$3`)
  .replace(/(href|src)="(\.\/[^"?]+\.(?:css|mjs))"/g, `$1="$2?v=${v}"`)
  .replace('new URL(`./data/${file}`, import.meta.url)', `new URL(\`./data/\${file}?v=${v}\`, import.meta.url)`);
for (const f of files.filter((x) => /\.(mjs|html)$/.test(x))) {
  const url = new URL(f, out);
  await writeFile(url, stamp(await readFile(url, 'utf8')));
}
console.log(`Built the browser app into dist/ (version ${v}).`);
