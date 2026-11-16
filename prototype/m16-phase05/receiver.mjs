// Local stand-in receiver: records requests, changes nothing. GET /hits, POST /reset.
import http from 'node:http';
let hits = [];
http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  if (req.method === 'GET' && req.url === '/hits') return res.writeHead(200).end(JSON.stringify(hits));
  if (req.url === '/reset') return (hits = []), res.writeHead(204).end();
  hits.push({ at: Date.now(), body: JSON.parse(b || '{}') }); res.writeHead(200).end();
}); }).listen(8080);
