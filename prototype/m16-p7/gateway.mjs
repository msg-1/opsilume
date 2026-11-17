#!/usr/bin/env node
// P7 recorder gateway: the ONLY path out of the test stack. The harness container has no outbound network; it reaches
// this container on an internal network, and this forwards raw TCP to one fixed destination (the recorder on the other
// host, P7_RECORDER_TARGET=host:port). It cannot be told to go anywhere else, and it reads nothing it forwards: the
// recorder authenticates every request. It isn't on the database network. NOT production code.
// Port 8788 is a self-check: it reports whether THIS container can reach a fixed list of destinations it must not
// reach (lib/netcheck.mjs). Only the gateway has a route out, so only it can show the host firewall limits that route.
import net from 'node:net';
import os from 'node:os';
import { createForwarder, createSelfCheck } from './lib/gateway.mjs';
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
createForwarder(t).listen(8787, '0.0.0.0', () => console.log('gateway: forwarding :8787 to the recorder only'));
createSelfCheck({ target, tcp, interfaces: () => os.networkInterfaces() }).listen(8788, '0.0.0.0', () => console.log('gateway: egress self-check on :8788'));
