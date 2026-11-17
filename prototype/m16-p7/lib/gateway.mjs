// The P7 gateway (see ../gateway.mjs): a raw TCP forwarder to ONE fixed destination, plus a self-check of its own
// egress. Factored out so both can be tested in-process with injected probes. NOT production code.
import http from 'node:http';
import net from 'node:net';
import { gatewayEgress } from './netcheck.mjs';

const MAX = 64;
/** Forwards every connection to host:port and nowhere else. It reads nothing it forwards. */
export function createForwarder({ host, port }) {
  let open = 0;
  return net.createServer((client) => {
    if (open >= MAX) return client.destroy();
    open += 1;
    const upstream = net.connect({ host, port });
    const done = () => { client.destroy(); upstream.destroy(); };
    for (const s of [client, upstream]) { s.setTimeout(60_000, done); s.on('error', done); s.on('close', done); }
    client.once('close', () => { open -= 1; });
    client.pipe(upstream).pipe(client);
  });
}
/**
 * GET / runs the fixed egress probes and returns their outcomes. It takes no input: the destinations come from
 * lib/netcheck.mjs and this container's own interfaces, so it can't be asked to connect anywhere. One run at a time.
 */
export function createSelfCheck({ target, tcp, interfaces }) {
  let running = null;
  return http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404).end(); return; }
    running ??= gatewayEgress({ tcp, interfaces: interfaces(), target }).finally(() => { running = null; });
    running.then((r) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r)); }, () => { res.writeHead(500).end(); });
  });
}
