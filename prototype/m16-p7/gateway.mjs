#!/usr/bin/env node
// P7 recorder gateway: the ONLY path out of the test stack. The harness container has no outbound network; it reaches
// this container on an internal network, and this forwards raw TCP to one fixed destination (the recorder on the other
// host, P7_RECORDER_TARGET=host:port). It cannot be told to go anywhere else, and it reads nothing it forwards: the
// recorder authenticates every request. It isn't on the database network. NOT production code.
// Both ports listen on the internal interface's address only. Port 8788 is a self-check: it reports whether THIS container can reach a fixed list of destinations it must not
// reach (lib/netcheck.mjs). Only the gateway has a route out, so only it can show the host firewall limits that route.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { createForwarder, createSelfCheck, internalAddress } from './lib/gateway.mjs';
import { parseTarget } from './lib/netcheck.mjs';

const target = process.env.P7_RECORDER_TARGET ?? '';
const t = parseTarget(target);
if (!t) { console.error('P7_RECORDER_TARGET must be host:port'); process.exit(1); }
const tcp = (host, port, ms = 1500) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (o) => { s.destroy(); resolve(o); };
  s.setTimeout(ms, () => done('timeout'));
  s.once('connect', () => done('connected'));
  s.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : `error:${e.code}`));
});
// Both listeners bind to the internal (harness-facing) address only, never to every address: nothing listens on the
// egress network. If that address can't be told apart, the gateway does not start (and the harness then reaches nothing).
const bind = internalAddress(os.networkInterfaces(), fs.readFileSync('/proc/net/route', 'utf8'));
if (!bind) { console.error('gateway: could not identify the internal interface (expected two IPv4 interfaces, one of them with the default route); not listening'); process.exit(1); }
const fwd = createForwarder(t), check = createSelfCheck({ target, tcp, interfaces: () => os.networkInterfaces(), listeners: () => [fwd, check].map((s) => ({ port: s.address()?.port ?? null, address: s.address()?.address ?? null })) });
fwd.listen(8787, bind, () => console.log(`gateway: forwarding ${bind}:8787 to the recorder only`));
check.listen(8788, bind, () => console.log(`gateway: egress self-check on ${bind}:8788`));
