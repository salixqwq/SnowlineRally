// tiny static server for local testing: localhost / https are secure contexts, so the
// device-orientation / motion APIs are available (file:// is not)
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8123);
const host = process.argv[4] || '127.0.0.1';
const tls = process.env.TLS === '1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

const handler = (req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(root, url === '/' ? '/snowline-rally.html' : url);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': st.size,
    });
    fs.createReadStream(file).pipe(res);
  });
};

const server = tls
  ? https.createServer({
      key: fs.readFileSync(path.join(import.meta.dirname, '../certs/key.pem')),
      cert: fs.readFileSync(path.join(import.meta.dirname, '../certs/cert.pem')),
    }, handler)
  : http.createServer(handler);

server.listen(port, host, () => {
  console.log(`${tls ? 'https' : 'http'}://${host}:${port}/snowline-rally.html  (root ${root})`);
});
