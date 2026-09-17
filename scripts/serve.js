#!/usr/bin/env node
/**
 * `npm run web` -- a ~70 line static file server.
 *
 * The web player imports the compiled engine straight out of dist/ as native
 * ES modules, so there is no bundler, no dev server framework and no install
 * step beyond `npm run build`.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const port = Number(process.env.PORT ?? 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mid': 'audio/midi',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  // Redirect rather than rewrite, so the page's relative imports resolve
  // against /web/ instead of the server root.
  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { location: '/web/' });
    res.end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside the project root only -- no path traversal.
  const candidate = resolve(root, `.${normalize(pathname)}`);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`Not found: ${pathname}`);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  createReadStream(candidate).pipe(res);
});

if (!existsSync(join(root, 'dist', 'index.js'))) {
  process.stderr.write('dist/ is missing. Run `npm run build` first.\n');
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`Port ${port} is already in use. Run \`PORT=4174 npm run web\` to pick another.\n`);
  } else {
    process.stderr.write(`Server error: ${err.message}\n`);
  }
  process.exit(1);
});

server.listen(port, () => {
  process.stdout.write(`\n  groovebox web player  ->  http://localhost:${port}/\n`);
  process.stdout.write('  Ctrl+C to stop.\n\n');
});
