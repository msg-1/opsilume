// Local deterministic stand-in receiver: records each request in memory and answers after an optional delay.
// It changes nothing anywhere. GET /hits returns what it recorded; POST /reset clears it.
import http from 'node:http';
let hits = [];
http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/hits') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hits));
      if (req.method === 'POST' && req.url === '/reset') return (hits = []), res.writeHead(204).end();
      hits.push({ at: Date.now(), body: JSON.parse(body || '{}') });
      setTimeout(() => res.writeHead(Number(req.headers['x-status'] ?? 200)).end(), Number(req.headers['x-delay-ms'] ?? 0));
    });
  })
  .listen(8080);
