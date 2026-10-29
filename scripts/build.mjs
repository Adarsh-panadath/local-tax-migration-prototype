import { cp, mkdir, rm } from 'node:fs/promises';

const out = new URL('../dist/', import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL('../web/', import.meta.url), out, { recursive: true });
await cp(new URL('../data/', import.meta.url), new URL('../dist/data/', import.meta.url), { recursive: true });
console.log('Built the browser app into dist/.');
