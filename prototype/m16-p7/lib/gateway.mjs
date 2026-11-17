// The P7 gateway (see ../gateway.mjs): a raw TCP forwarder to ONE fixed destination, plus a self-check of its own
// egress. Factored out so both can be tested in-process with injected probes. NOT production code.
import http from 'node:http';
import net from 'node:net';
import { gatewayEgress } from './netcheck.mjs';

const MAX = 64;
/**
 * The one address the gateway listens on: its interface on the internal network it shares with the harness. The other
 * interface carries the default route (the egress network); nothing listens there. `routeTable` is /proc/net/route.
 * Returns null unless there are exactly two IPv4 interfaces and exactly one of them has no default route: the gateway
 * then refuses to start rather than listen on every address.
 */
export function internalAddress(interfaces, routeTable) {
  const egress = new Set(String(routeTable ?? '').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c[1] === '00000000' && c[7] === '00000000').map((c) => c[0]));
  const v4 = Object.entries(interfaces ?? {}).flatMap(([name, ifs]) => (ifs ?? []).filter((i) => i.family === 'IPv4' && !i.internal && i.address).map((i) => ({ name, address: i.address })));
  const inside = v4.filter((i) => !egress.has(i.name));
  return egress.size > 0 && v4.length === 2 && inside.length === 1 ? inside[0].address : null;
}
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
export function createSelfCheck({ target, tcp, interfaces, listeners = () => [] }) {
  let running = null;
  return http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404).end(); return; }
    running ??= gatewayEgress({ tcp, interfaces: interfaces(), target }).finally(() => { running = null; });
    // `listeners` are the addresses the kernel reports for the gateway's own listening sockets (server.address()).
    running.then((r) => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...r, listeners: listeners() })); }, () => { res.writeHead(500).end(); });
  });
}
