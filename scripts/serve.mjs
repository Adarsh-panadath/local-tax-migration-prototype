import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';

const root = resolve('dist');
const types = {
  '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.txt': 'text/plain',
  '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
};

http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html');
    const path = resolve(root, '.' + decodeURIComponent(pathname));
    if (!path.startsWith(root + sep)) throw new Error('Invalid path'); // sep: \ on Windows, / elsewhere
    const body = await readFile(path);
    const type = types[extname(path)] || 'application/octet-stream';
    const headers = { 'Content-Type': type.startsWith('text/') || type === 'application/json' ? `${type}; charset=utf-8` : type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
    // Browsers fetch a video in pieces (Safari will not play one without this).
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start > end || start >= body.length) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }); res.end(); return; }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1 });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Local Tax Migration: http://localhost:' + (process.env.PORT || 3000)));
