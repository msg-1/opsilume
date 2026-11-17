// Network-isolation rules (pure) and the gateway (in-process, loopback only). HARNESS tests only: every probe is a
// fake. Nothing here applies a firewall rule or connects anywhere but 127.0.0.1, and nothing here shows that a real
// host is isolated: that needs the firewall applied and verified on the actual Linux machine.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { HARNESS_BRIDGES, STRICT_BLOCKED, bridgeHosts, egressTargets, gatewayEgress, runNetcheck } from '../lib/netcheck.mjs';
import { createForwarder, createSelfCheck } from '../lib/gateway.mjs';

const TARGET = '192.168.1.20:8787';
const nic = (address, netmask = '255.255.0.0') => [{ family: 'IPv4', internal: false, address, netmask }];
const LO = [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }];
const TWO = { lo: LO, eth0: nic('172.22.0.3'), eth1: nic('172.23.0.2') }; // the harness: p7db and p7gw
const GW = { lo: LO, eth0: nic('172.23.0.3'), eth1: nic('172.24.0.2') };  // the gateway: p7gw and egress
/**
 * A fake stack. `host(ip, port)` says what the test machine does with a packet to its own bridge address:
 * a working firewall drops it ('timeout'); without one the host answers ('refused', or 'connected' where it listens).
 */
function world({ interfaces = TWO, host = () => 'timeout', gateway = () => 'timeout', egress, auth = null, unsigned = 401 } = {}) {
  const seen = [];
  const tcp = async (h, port) => {
    seen.push(`${h}:${port}`);
    if (h === 'db') return port === 5432 ? 'connected' : 'refused';
    if (h === 'gateway') return 'refused';
    if (h === 'host.docker.internal') return 'error:ENOTFOUND';
    if (/^172\./.test(h)) return host(h, port);
    return 'error:ENETUNREACH'; // the harness networks are internal: no route to anything else
  };
  const gwTcp = async (h, port) => gateway(h, port);
  return { seen, deps: { tcp, interfaces, target: TARGET, resolves: async () => 'error:EAI_AGAIN', authenticated: async () => auth, unsigned: async () => unsigned,
    egress: egress ?? (() => gatewayEgress({ tcp: gwTcp, interfaces: GW, target: TARGET })) } };
}
const strict = (o) => runNetcheck({ strict: true, ...world(o).deps });
const failed = (r) => r.probes.filter((p) => !p.ok).map((p) => `${p.name} -> ${p.outcome}`);

describe('bridge discovery', () => {
  test('the host address is the first address of each IPv4 subnet; loopback, IPv6 and malformed entries are ignored', () => {
    assert.deepEqual(bridgeHosts(TWO), ['172.22.0.1', '172.23.0.1']);
    assert.deepEqual(bridgeHosts({ eth0: nic('10.5.7.9', '255.255.255.0') }), ['10.5.7.1']);
    for (const none of [undefined, null, {}, { lo: LO }, { eth0: [{ family: 'IPv6', internal: false, address: 'fd00::2', netmask: 'ffff::' }] }, { eth0: undefined }, { eth0: [{ family: 'IPv4', internal: false }] }]) assert.deepEqual(bridgeHosts(none), []);
  });
});

describe('strict network check: fails closed', () => {
  test('both bridges probed and everything dropped: passes, and every bridge address was actually probed', async () => {
    const w = world();
    const r = await runNetcheck({ strict: true, ...w.deps });
    assert.deepEqual(failed(r), []);
    assert.equal(r.ok, true);
    assert.deepEqual(r.bridges, ['172.22.0.1', '172.23.0.1']);
    for (const h of r.bridges) for (const port of [22, 80, 443, 2375, 2376, 5432, 8787]) assert.ok(w.seen.includes(`${h}:${port}`), `${h}:${port} probed`);
    assert.equal(r.hostAnswersOnBridge, false);
    assert.equal(r.gatewayEgressOpen, false);
  });
  test('no bridge addresses discovered: fails, in every form of "none"', async () => {
    for (const interfaces of [{}, null, { lo: LO }, { eth0: [] }, { eth0: [{ family: 'IPv6', internal: false, address: 'fd00::2', netmask: 'ffff::' }] }]) {
      const r = await strict({ interfaces });
      assert.equal(r.ok, false);
      assert.match(failed(r).join(' | '), /bridge addresses discovered -> 0: none/);
    }
  });
  test('one bridge discovered (a host interface is missing): fails, even though that one bridge is dropped', async () => {
    const r = await strict({ interfaces: { lo: LO, eth0: nic('172.22.0.3') } });
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ['bridge addresses discovered -> 1: 172.22.0.1']);
  });
  test('multiple bridges: exactly the two of compose.yml pass; a third, unexpected network fails', async () => {
    assert.equal(HARNESS_BRIDGES, 2);
    assert.equal((await strict()).ok, true);
    const r = await strict({ interfaces: { ...TWO, eth2: nic('172.30.0.5') } });
    assert.equal(r.ok, false);
    assert.match(failed(r).join(' | '), /bridge addresses discovered -> 3: 172\.22\.0\.1, 172\.23\.0\.1, 172\.30\.0\.1/);
  });
  test('incorrect firewall rules: REJECT instead of DROP, one bridge left open, one port left open, or any other answer', async () => {
    const reject = await strict({ host: () => 'refused' });
    assert.equal(reject.ok, false);
    assert.equal(reject.hostAnswersOnBridge, true);
    assert.equal(failed(reject).filter((x) => /^host or bridge 172\./.test(x)).length, 16, 'every probe of both bridges is named');
    const oneBridge = await strict({ host: (h) => (h === '172.23.0.1' ? 'refused' : 'timeout') });
    assert.ok(failed(oneBridge).length === 8 && failed(oneBridge).every((x) => x.startsWith('host or bridge 172.23.0.1:')), 'only the open bridge is named');
    assert.deepEqual(failed(await strict({ host: (h, p) => (h === '172.22.0.1' && p === 2375 ? 'refused' : 'timeout') })), ['host or bridge 172.22.0.1:2375 -> refused']);
    // Allowlist: an outcome that is neither a timeout nor "unreachable" never counts as blocked.
    for (const odd of ['error:ECONNRESET', 'error:EPERM', 'error:EACCES', 'error:undefined', '', undefined, null, 'ok']) {
      const r = await strict({ host: (h, p) => (p === 22 ? odd : 'timeout') });
      assert.equal(r.ok, false, `outcome ${odd}`);
      assert.equal(STRICT_BLOCKED.test(String(odd)), false);
    }
    for (const fine of ['timeout', 'error:EHOSTUNREACH', 'error:ENETUNREACH']) assert.equal((await strict({ host: () => fine })).ok, true, fine);
  });
  test('a host service reachable from a bridge fails, strict or not', async () => {
    const ssh = (h, p) => (p === 22 ? 'connected' : 'timeout');
    assert.deepEqual(failed(await strict({ host: ssh })), ['host or bridge 172.22.0.1:22 -> connected', 'host or bridge 172.23.0.1:22 -> connected']);
    const smoke = await runNetcheck({ strict: false, ...world({ host: (h, p) => (p === 5432 ? 'connected' : 'refused') }).deps });
    assert.equal(smoke.ok, false);
    assert.deepEqual(failed(smoke), ['host or bridge 172.22.0.1:5432 -> connected', 'host or bridge 172.23.0.1:5432 -> connected']);
  });
  test('the gateway reaching an unauthorised destination fails: the internet, another port of the recorder host, the host itself', async () => {
    assert.deepEqual(failed(await strict({ gateway: (h) => (h === '1.1.1.1' ? 'connected' : 'timeout') })), ['gateway to internet 1.1.1.1:443 -> connected']);
    assert.deepEqual(failed(await strict({ gateway: (h, p) => (h === '192.168.1.20' && p === 22 ? 'connected' : 'timeout') })), ['gateway to the recorder host on another port (192.168.1.20:22) -> connected']);
    assert.deepEqual(failed(await strict({ gateway: (h, p) => (h === '192.168.1.20' && p === 8788 ? 'refused' : 'timeout') })), ['gateway to the recorder host on another port (192.168.1.20:8788) -> refused'], 'a refusal means the packet got there');
    assert.deepEqual(failed(await strict({ gateway: (h, p) => (h === '172.24.0.1' && p === 22 ? 'refused' : 'timeout') })), ['gateway to host or bridge 172.24.0.1:22 -> refused']);
    const open = await strict({ gateway: () => 'connected' });
    assert.equal(open.gatewayEgressOpen, true);
    assert.equal(failed(open).length, egressTargets(TARGET, GW).length);
  });
  test('an empty, incomplete or unavailable gateway self-check is a failure, never a pass', async () => {
    const cases = {
      'no probes': async () => ({ probes: [] }),
      'not a probe list': async () => ({ probes: 'all good' }),
      'nothing': async () => null,
      'unreachable': async () => { throw new Error('fetch failed'); },
      'a fixed destination missing': async () => { const r = await gatewayEgress({ tcp: async () => 'timeout', interfaces: GW, target: TARGET }); return { probes: r.probes.slice(1) }; },
      'no bridge address probed': () => gatewayEgress({ tcp: async () => 'timeout', interfaces: {}, target: TARGET }),
    };
    for (const [name, egress] of Object.entries(cases)) {
      const r = await strict({ egress });
      assert.equal(r.ok, false, name);
      assert.match(failed(r).join(' | '), /gateway egress self-check -> /, name);
    }
  });
  test('the recorder must answer with authentication and refuse without; a missing target fails', async () => {
    assert.match(failed(await strict({ auth: 'recorder GET /runs/x: 401' })).join(), /authenticated -> recorder GET/);
    assert.match(failed(await strict({ unsigned: 200 })).join(), /without authentication -> 200/);
    const w = world();
    assert.match(failed(await runNetcheck({ strict: true, ...w.deps, target: undefined })).join(' | '), /recorder target \(P7_RECORDER_TARGET\) -> not set or malformed/);
  });
  test('a smoke run (not strict) only reports a host that answers and an open gateway; it still fails on a real connection', async () => {
    const r = await runNetcheck({ strict: false, ...world({ host: () => 'refused', gateway: () => 'connected', interfaces: { lo: LO, eth0: nic('172.22.0.3') } }).deps });
    assert.equal(r.ok, true);
    assert.deepEqual([r.strict, r.hostAnswersOnBridge, r.gatewayEgressOpen], [false, true, true]);
    assert.ok(!r.probes.some((p) => p.name === 'bridge addresses discovered'));
  });
});

describe('gateway (loopback only)', () => {
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  test('the self-check takes no input: fixed destinations only, GET / only', async () => {
    const asked = [];
    const srv = createSelfCheck({ target: TARGET, interfaces: () => GW, tcp: async (h, p) => { asked.push(`${h}:${p}`); return 'timeout'; } });
    const port = await listen(srv);
    const r = await (await fetch(`http://127.0.0.1:${port}/`)).json();
    assert.deepEqual(r.probes.map((p) => p.name), egressTargets(TARGET, GW).map((t) => t.name));
    assert.equal(r.probes.length, 4 + 2 + 4);
    for (const bad of ['/?host=10.0.0.1&port=22', '/probe/10.0.0.1/22', '/10.0.0.1:22']) assert.equal((await fetch(`http://127.0.0.1:${port}${bad}`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{"host":"10.0.0.1","port":22}' })).status, 404);
    assert.deepEqual([...new Set(asked)].sort(), egressTargets(TARGET, GW).map((t) => `${t.host}:${t.port}`).sort(), 'nothing but the fixed list was ever probed');
    await new Promise((r2) => srv.close(r2));
  });
  test('the forwarder sends every connection to its one destination', async () => {
    const got = [];
    const upstream = net.createServer((s) => s.on('data', (d) => { got.push(String(d)); s.end('pong'); }));
    const up = await listen(upstream);
    const fwd = createForwarder({ host: '127.0.0.1', port: up });
    const port = await listen(fwd);
    const reply = await new Promise((resolve, reject) => { const c = net.connect({ host: '127.0.0.1', port }, () => c.write('CONNECT 10.0.0.1:22')); let b = ''; c.on('data', (d) => { b += d; }); c.on('end', () => resolve(b)); c.on('error', reject); });
    assert.equal(reply, 'pong');
    assert.deepEqual(got, ['CONNECT 10.0.0.1:22'], 'what the client asks for is just bytes to the one destination');
    await Promise.all([fwd, upstream].map((s) => new Promise((r2) => s.close(r2))));
  });
});
