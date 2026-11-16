// Fault proxy for P5: sits between the prototype and PostgreSQL and reads the frontend protocol to find COMMIT.
// Control (HTTP :9000): POST /arm {"mode": "..."} applies to the NEXT COMMIT on any connection, once:
//   drop_before_commit           - COMMIT is never forwarded; both sockets are closed (the server rolls back)
//   drop_after_commit_response   - COMMIT is forwarded; the server's answer is swallowed and both sockets closed
// POST /refuse {"on": true|false} - refuse new connections (PostgreSQL "unavailable"); GET /events; POST /reset.
import net from 'node:net';
import http from 'node:http';
let armed = null, refuse = false, events = [], conns = 0;
const log = (e) => events.push({ t: Date.now(), ...e });
net.createServer((client) => {
  const id = ++conns;
  if (refuse) { log({ id, event: 'refused new connection' }); return client.destroy(); }
  const server = net.connect(5432, 'db');
  let started = false, buf = Buffer.alloc(0), swallowNext = false;
  const kill = (why) => { log({ id, event: why }); client.destroy(); server.destroy(); };
  server.on('data', (d) => { if (swallowNext) { log({ id, event: 'server answered COMMIT', firstByte: String.fromCharCode(d[0]) }); return kill('closed both sockets: answer to COMMIT not delivered'); } client.write(d); });
  client.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let out = [];
    for (;;) {
      if (!started) { if (buf.length < 4) break; const len = buf.readInt32BE(0); if (buf.length < len) break; out.push(buf.subarray(0, len)); buf = buf.subarray(len); started = true; continue; }
      if (buf.length < 5) break;
      const type = String.fromCharCode(buf[0]); const len = buf.readInt32BE(1);
      if (buf.length < len + 1) break;
      const msg = buf.subarray(0, len + 1); buf = buf.subarray(len + 1);
      const text = type === 'Q' || type === 'P' ? msg.subarray(5).toString('utf8') : '';
      if (armed && /^\s*COMMIT\b/i.test(text.replace(/^\0/, ''))) {
        const mode = armed; armed = null; log({ id, event: 'COMMIT seen', mode, messageType: type });
        if (out.length) server.write(Buffer.concat(out));
        if (mode === 'drop_before_commit') return kill('closed both sockets before forwarding COMMIT');
        swallowNext = true; server.write(msg); return;
      }
      out.push(msg);
    }
    if (out.length) server.write(Buffer.concat(out));
  });
  client.on('error', () => server.destroy()); server.on('error', () => client.destroy());
  client.on('close', () => server.destroy()); server.on('close', () => client.destroy());
}).listen(6432);
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    if (req.url === '/arm') armed = j.mode;
    else if (req.url === '/refuse') refuse = !!j.on;
    else if (req.url === '/reset') { armed = null; refuse = false; events = []; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url === '/events' ? events : { armed, refuse }));
  });
}).listen(9000);
