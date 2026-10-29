import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

const out = new URL('../dist/', import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL('../web/', import.meta.url), out, { recursive: true });
await cp(new URL('../data/', import.meta.url), new URL('../dist/data/', import.meta.url), { recursive: true });
// GitHub Pages serves dist/ as-is; this file turns off its Jekyll processing.
await writeFile(new URL('.nojekyll', out), '');
console.log('Built the browser app into dist/.');
