import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), pub = join(here, '../public');
const files = new Map([
  ['/', [join(here, 'markdown-fixture.html'), 'text/html']],
  ['/fixture.js', [join(here, 'markdown-fixture.js'), 'text/javascript']],
  ...['markdown.js', 'style.css', 'icon.svg', 'vendor/marked.esm.js', 'vendor/purify.es.mjs'].map(path => [`/${path}`, [join(pub, path), path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript']]),
]);
const server = createServer((req, res) => {
  const file = files.get(req.url);
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-src 'none'; object-src 'none'" });
  res.end(readFileSync(file[0]));
});
server.listen(4327, '127.0.0.1', () => console.log('Synthetic Markdown preview: http://127.0.0.1:4327/ (no personal instance or model connection)'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
