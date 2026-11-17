#!/usr/bin/env node
// P7 recorder gateway: the ONLY path out of the test stack. The harness container has no outbound network; it reaches
// this container on an internal network, and this forwards raw TCP to one fixed destination (the recorder on the other
// host, P7_RECORDER_TARGET=host:port). It cannot be told to go anywhere else, and it reads nothing it forwards: the
// recorder authenticates every request. It isn't on the database network. NOT production code.
import net from 'node:net';

const target = process.env.P7_RECORDER_TARGET ?? '';
const m = /^([A-Za-z0-9.-]{1,253}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(target);
if (!m) { console.error('P7_RECORDER_TARGET must be host:port'); process.exit(1); }
const [host, port] = [m[1].replace(/^\[|\]$/g, ''), Number(m[2])];
const MAX = 64;
let open = 0;
net.createServer((client) => {
  if (open >= MAX) return client.destroy();
  open += 1;
  const upstream = net.connect({ host, port });
  const done = () => { client.destroy(); upstream.destroy(); };
  for (const s of [client, upstream]) { s.setTimeout(60_000, done); s.on('error', done); s.on('close', done); }
  client.once('close', () => { open -= 1; });
  client.pipe(upstream).pipe(client);
}).listen(8787, '0.0.0.0', () => console.log(`gateway: forwarding :8787 to the recorder only`));
