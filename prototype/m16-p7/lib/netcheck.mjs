// Network isolation checks for the P7 stack (pure: every probe is injected, so the rules are tested without a network).
// Used by `p7.mjs netcheck` inside the harness container and by gateway.mjs for its own egress self-check.
// Strict mode (qualifying runs, preflight) is an allowlist and fails closed: a destination counts as blocked only when
// the probe timed out or the network said unreachable. An empty or incomplete probe set is a failure, never a pass.

/** Outcomes that show a destination is blocked. Name-resolution errors are accepted only because the harness has no DNS. */
export const STRICT_BLOCKED = /^(timeout|error:(EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND))$/;
/** compose.yml puts the harness on exactly two bridge networks (p7db, p7gw). Strict mode requires both to be probed. */
export const HARNESS_BRIDGES = 2;
export const INTERNET = [['1.1.1.1', 443], ['8.8.8.8', 53], ['9.9.9.9', 443], ['140.82.112.3', 443]];
const HOST_PORTS = [22, 80, 443, 2375, 2376, 5432, 8787];
const NAME = 'the name does not resolve here; this shows no DNS, it is not a routing test';

/** The first address of every IPv4 subnet this container is on: the host's address on that bridge. */
export function bridgeHosts(interfaces) {
  const hosts = new Set();
  for (const ifs of Object.values(interfaces ?? {})) for (const i of ifs ?? []) if (i.family === 'IPv4' && !i.internal && i.address && i.netmask) {
    const ip = i.address.split('.').map(Number), mask = i.netmask.split('.').map(Number);
    hosts.add(ip.map((b, k) => (k === 3 ? (b & mask[k]) + 1 : b & mask[k])).join('.'));
  }
  return [...hosts].sort();
}
export function parseTarget(target) {
  const m = /^([A-Za-z0-9.-]{1,253}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(target ?? '');
  return m ? { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) } : null;
}

/**
 * What the GATEWAY must not be able to reach. The list is fixed here and by the gateway's own interfaces: a caller
 * cannot name a destination, so the self-check can't be used to reach anything.
 */
export function egressTargets(target, interfaces) {
  const t = parseTarget(target);
  return [
    ...INTERNET.map(([h, p]) => ({ name: `gateway to internet ${h}:${p}`, host: h, port: p })),
    ...(t ? [22, t.port + 1].map((p) => ({ name: `gateway to the recorder host on another port (${t.host}:${p})`, host: t.host, port: p })) : []),
    ...bridgeHosts(interfaces).flatMap((h) => [22, 2375].map((p) => ({ name: `gateway to host or bridge ${h}:${p}`, host: h, port: p }))),
  ];
}
export async function gatewayEgress({ tcp, interfaces, target }) {
  const probes = [];
  for (const t of egressTargets(target, interfaces)) probes.push({ name: t.name, outcome: await tcp(t.host, t.port, 1500) });
  return { probes };
}

/**
 * deps: tcp(host, port, ms) -> 'connected' | 'refused' | 'timeout' | 'error:CODE'; resolves(name) -> 'resolved:..' | 'error:CODE';
 * authenticated() -> null or the error; unsigned() -> HTTP status or 'error:..'; egress() -> { probes } from the gateway;
 * interfaces: os.networkInterfaces(); target: P7_RECORDER_TARGET.
 */
export async function runNetcheck({ strict = false, tcp, resolves, authenticated, unsigned, egress, interfaces, target }) {
  const probes = [];
  const add = (name, expect, outcome, ok, note) => probes.push({ name, expect, outcome, ok: ok === true, ...(note ? { note } : {}) });
  const blocked = (o) => (strict ? STRICT_BLOCKED.test(String(o)) : o !== 'connected');
  const nameNote = (o) => (/EAI_AGAIN|ENOTFOUND/.test(o) ? NAME : undefined);

  const auth = await authenticated();
  add('recorder through the gateway, authenticated', 'reachable', auth ?? 'authenticated', auth === null);
  const u = await unsigned();
  add('recorder without authentication', 'rejected (401)', u, u === 401);
  const d = await tcp('db', 5432);
  add('postgresql (db:5432, internal network)', 'reachable', d, d === 'connected');
  const t = parseTarget(target);
  if (t) { const o = await tcp(t.host, t.port); add(`recorder host directly (${t.host}:${t.port}), bypassing the gateway`, 'blocked', o, blocked(o), nameNote(o)); }
  else add('recorder target (P7_RECORDER_TARGET)', 'host:port', 'not set or malformed', false);
  for (const [h, port] of INTERNET) { const o = await tcp(h, port); add(`internet ${h}:${port}`, 'blocked', o, blocked(o) && o !== 'refused'); }
  const r = await resolves('example.com');
  add('external DNS (example.com)', 'blocked', r, !String(r).startsWith('resolved'));
  // The gateway is on the same bridge, so a closed port answers `refused`: that is the gateway itself, not a route.
  for (const port of [22, 80, 443, 5432]) { const o = await tcp('gateway', port); add(`gateway:${port} (only 8787 and the self-check port answer)`, 'blocked', o, o !== 'connected'); }

  // Host and bridge addresses. `refused` means the HOST answered: the harness reached the test machine's own address
  // and only the absence of a listener stopped it. Strict mode needs a host firewall that drops this traffic.
  const hosts = bridgeHosts(interfaces);
  let hostAnswers = false;
  for (const h of ['host.docker.internal', ...hosts]) for (const port of [...HOST_PORTS, t?.port].filter(Boolean)) {
    const o = await tcp(h, port, 1000);
    if (o === 'refused') hostAnswers = true;
    add(`host or bridge ${h}:${port}`, strict ? 'dropped by the host firewall' : 'no service', o, blocked(o), nameNote(o) ?? (o === 'refused' ? 'the host answered: reachable, no listener on this port' : undefined));
  }
  if (strict) add('bridge addresses discovered', `${HARNESS_BRIDGES} (the p7db and p7gw networks)`, `${hosts.length}: ${hosts.join(', ') || 'none'}`, hosts.length === HARNESS_BRIDGES,
    hosts.length === HARNESS_BRIDGES ? undefined : 'not every bridge was probed, so the host firewall was not observed on all of them');

  // The gateway's own way out: only it has a route, so only it can show that the firewall limits it to the recorder.
  let eg = null, egErr = null;
  try { eg = await egress(); } catch (e) { egErr = String(e?.message ?? e).slice(0, 120); }
  const got = new Map((Array.isArray(eg?.probes) ? eg.probes : []).map((p) => [String(p.name), String(p.outcome)]));
  const required = egressTargets(target, {}).map((x) => x.name);
  const missing = required.filter((n) => !got.has(n));
  const bridgeProbes = [...got.keys()].filter((n) => n.startsWith('gateway to host or bridge ')).length;
  let egressOpen = false;
  for (const [name, o] of got) {
    const open = !STRICT_BLOCKED.test(o);
    if (open) egressOpen = true;
    add(name, strict ? 'dropped by the host firewall' : 'reported only (no host firewall in a smoke run)', o, strict ? !open : true);
  }
  if (strict) add('gateway egress self-check', 'every fixed destination and at least one bridge address probed', egErr ?? `${got.size} probes; missing: ${missing.length}; bridge probes: ${bridgeProbes}`,
    !egErr && got.size > 0 && missing.length === 0 && bridgeProbes > 0, 'an empty or incomplete probe set is not a pass');
  else if (egErr) add('gateway egress self-check', 'reported only', egErr, true);
  return { ok: probes.length > 0 && probes.every((p) => p.ok), strict, hostAnswersOnBridge: hostAnswers, gatewayEgressOpen: egErr ? null : egressOpen, bridges: hosts, probes };
}
