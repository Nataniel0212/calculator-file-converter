#!/usr/bin/env node
/**
 * Tiny static server for local development — no dependencies.
 *
 *   node scripts/serve.js            # serves apps/web on http://localhost:5173
 *   node scripts/serve.js 8080
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');
const port = Number(process.argv[2]) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  let path = join(root, normalize(decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    response.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => {
  console.log(`g1e tools running at http://localhost:${port}`);
});
