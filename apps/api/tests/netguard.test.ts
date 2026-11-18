import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnsafeDestinationError, assertSafeOutboundUrl, isDisallowedAddress, netConfig, safeRequest } from '../src/lib/netguard';
import { createOrg, prisma } from './helpers';

// Requests to addresses a tenant supplies. These tests make real connections: a guard that is
// only reasoned about is not a guard. DNS is played by a resolver the test controls, so it can
// do what an attacker's DNS server does: give one answer to the check and another to the
// connection. Local servers stand for "something internal that must never be reached".
type Resolved = { address: string; family: number };
const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 3000 };

let internal: Server; // a plain HTTP service on loopback
let secure: Server; // an HTTPS service with a certificate nobody should trust
let hits: { host: string | undefined; url: string | undefined }[] = [];
let port = 0;
let tlsPort = 0;
const answers: Resolved[][] = [];
const asked: string[] = [];

beforeAll(async () => {
  internal = createServer((req, res) => {
    hits.push({ host: req.headers.host, url: req.url });
    if (req.url === '/redirect') return void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    res.writeHead(200, { 'content-type': 'text/plain' }).end('internal secret: do not relay');
  });
  await new Promise<void>((resolve) => internal.listen(0, '127.0.0.1', resolve));
  port = (internal.address() as AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), 'opsilume-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=not-the-host-you-asked-for.test'], { stdio: 'ignore' });
  secure = createTlsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_req, res) => {
    hits.push({ host: 'tls', url: _req.url });
    res.writeHead(200).end('ok');
  });
  await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve));
  tlsPort = (secure.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((resolve) => internal.close(resolve));
  await new Promise((resolve) => secure.close(resolve));
});

const realResolve = netConfig.resolve;
beforeEach(() => {
  hits = [];
  answers.length = 0;
  asked.length = 0;
  netConfig.allowPrivate = false;
  netConfig.allowedInTests.clear();
  // Each lookup takes the next scripted answer; the last one repeats.
  netConfig.resolve = async (host) => {
    asked.push(host);
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (!next) throw new Error('ENOTFOUND');
    return next;
  };
  return () => {
    netConfig.resolve = realResolve;
    netConfig.allowedInTests.clear();
  };
});
const v4 = (address: string): Resolved => ({ address, family: 4 });
const v6 = (address: string): Resolved => ({ address, family: 6 });
const PUBLIC = v4('93.184.216.34');

describe('which addresses may be called', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '0.1.2.3',
    '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'not-an-address', '',
  ])('refuses %s', (address) => {
    expect(isDisallowedAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '192.167.1.1', '100.63.255.255', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isDisallowedAddress(address)).toBe(false);
  });

  it('judges a URL by what it really points at, however the address is written', async () => {
    for (const url of [
      'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://0/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/',
      'http://169.254.169.254/latest/meta-data/', 'http://[fd00::1]/', 'http://[fe80::1%25eth0]/', 'ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'https://user:secret@example.com/', 'not a url',
    ]) {
      await expect(assertSafeOutboundUrl(url), url).rejects.toMatchObject({ status: 400 });
      await expect(safeRequest(url, request), url).rejects.toMatchObject({ status: 400 });
    }
    expect(asked).toEqual([]); // none of these needed DNS to be refused
    expect(hits).toEqual([]);
  });
});

describe('the connection goes where the check said it would', () => {
  it('connects to the address that was checked, under the host name that was asked for', async () => {
    // The name exists in no DNS. If the request arrives, it used the answer the guard checked.
    netConfig.allowedInTests.add('127.0.0.1');
    answers.push([v4('127.0.0.1')]);
    const res = await safeRequest(`http://hooks.customer.test:${port}/hook`, request);
    expect(res).toEqual({ status: 200, ok: true });
    expect(hits).toEqual([{ host: `hooks.customer.test:${port}`, url: '/hook' }]);
    expect(asked).toEqual(['hooks.customer.test']);
    // Only the status comes back. The body of whatever answered is not available to the caller.
    expect(JSON.stringify(res)).not.toContain('internal secret');
  });

  it('DNS rebinding: a name that passed the check and then points inside is refused at the connection', async () => {
    // Saved while it resolved to a public address…
    answers.push([PUBLIC], [v4('127.0.0.1')]);
    await expect(assertSafeOutboundUrl(`http://rebind.attacker.test:${port}/hook`)).resolves.toBeInstanceOf(URL);
    // …and now, for the connection, the same name answers with loopback.
    await expect(safeRequest(`http://rebind.attacker.test:${port}/hook`, request)).rejects.toBeInstanceOf(UnsafeDestinationError);
    expect(hits).toEqual([]); // the internal service saw nothing
    expect(asked).toEqual(['rebind.attacker.test', 'rebind.attacker.test']);
  });

  it('checks again on every connection, so a later request does not ride on an earlier answer', async () => {
    netConfig.allowedInTests.add('127.0.0.1');
    answers.push([v4('127.0.0.1')], [v4('10.0.0.5')], [v4('127.0.0.1')]);
    const url = `http://flip.attacker.test:${port}/hook`;
    await expect(safeRequest(url, request)).resolves.toMatchObject({ status: 200 });
    await expect(safeRequest(url, request)).rejects.toBeInstanceOf(UnsafeDestinationError);
    await expect(safeRequest(url, request)).resolves.toMatchObject({ status: 200 });
    expect(hits).toHaveLength(2);
    expect(asked).toHaveLength(3);
  });

  it('refuses a name with mixed answers: one internal address among public ones is enough', async () => {
    for (const mixed of [[PUBLIC, v4('127.0.0.1')], [v4('10.0.0.1'), PUBLIC], [PUBLIC, v6('::1')], [v6('2606:4700:4700::1111'), v6('fd00::1')], [PUBLIC, v6('::ffff:169.254.169.254')]]) {
      answers.length = 0;
      answers.push(mixed);
      await expect(assertSafeOutboundUrl(`http://mixed.attacker.test:${port}/`)).rejects.toBeInstanceOf(UnsafeDestinationError);
      await expect(safeRequest(`http://mixed.attacker.test:${port}/`, request)).rejects.toBeInstanceOf(UnsafeDestinationError);
    }
    expect(hits).toEqual([]);
  });

  it('refuses IPv6 answers that point inside, and names that do not resolve', async () => {
    for (const inside of [v6('::1'), v6('fe80::1'), v6('fd12::1'), v6('::ffff:127.0.0.1'), v6('64:ff9b::a00:1'), v6('2002:a00:1::1')]) {
      answers.length = 0;
      answers.push([inside]);
      await expect(safeRequest(`http://v6.attacker.test:${port}/`, request)).rejects.toBeInstanceOf(UnsafeDestinationError);
    }
    answers.length = 0; // the resolver now throws
    await expect(safeRequest(`http://nowhere.attacker.test:${port}/`, request)).rejects.toThrow('could not be resolved');
    answers.push([]);
    await expect(safeRequest(`http://empty.attacker.test:${port}/`, request)).rejects.toThrow('could not be resolved');
    expect(hits).toEqual([]);
  });

  it('does not follow a redirect to somewhere else', async () => {
    netConfig.allowedInTests.add('127.0.0.1');
    answers.push([v4('127.0.0.1')]);
    const res = await safeRequest(`http://hooks.customer.test:${port}/redirect`, request);
    expect(res).toEqual({ status: 302, ok: false });
    // One request, to the first address. The redirect target was never looked up or contacted.
    expect(hits).toHaveLength(1);
    expect(asked).toEqual(['hooks.customer.test']);
  });

  it('still verifies the certificate against the host name', async () => {
    netConfig.allowedInTests.add('127.0.0.1');
    answers.push([v4('127.0.0.1')]);
    // The server answers on the checked address with a certificate for another name, signed by nobody.
    const failure = await safeRequest(`https://hooks.customer.test:${tlsPort}/hook`, request).then(() => null, (err: Error & { cause?: { code?: string } }) => err);
    expect(failure).not.toBeNull();
    expect(failure).not.toBeInstanceOf(UnsafeDestinationError);
    expect(String(failure!.cause?.code ?? failure!.message)).toMatch(/SELF_SIGNED|DEPTH_ZERO|CERT|ALTNAME/);
    expect(hits).toEqual([]); // the handshake failed; no request was sent
  });

  it('gives up at the time limit', async () => {
    netConfig.allowedInTests.add('127.0.0.1');
    answers.push([v4('127.0.0.1')]);
    const stalled = createServer(() => undefined);
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    try {
      const began = Date.now();
      await expect(safeRequest(`http://slow.customer.test:${(stalled.address() as AddressInfo).port}/`, { ...request, timeoutMs: 300 })).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(Date.now() - began).toBeLessThan(2500);
    } finally {
      stalled.closeAllConnections();
      await new Promise((resolve) => stalled.close(resolve));
    }
  });
});

describe('through the application', () => {
  it('a webhook whose name is rebound after it was saved is never called: the test request is refused and an approved action is not sent', async () => {
    const org = await createOrg();
    const url = `http://rebind.attacker.test:${port}/hook`;
    answers.push([PUBLIC]);
    await org.owner.patch('/api/v1/settings').send({ remediationWebhookUrl: url }).expect(200);
    answers.length = 0;
    answers.push([v4('127.0.0.1')]); // from now on the name points at this machine

    const check = (await org.owner.post('/api/v1/integrations/remediation-webhook/check').expect(200)).body;
    expect(check).toMatchObject({ ok: false, detail: expect.stringContaining('private, loopback or link-local') });

    const approver = await org.member('ADMIN');
    const action = (await org.owner.post('/api/v1/remediations').send({ type: 'run_runbook', title: 'Flush the order cache', description: 'Purge every order:* key in orders-cache.', risk: 'LOW' }).expect(201)).body;
    await org.owner.post(`/api/v1/remediations/${action.id}/request-approval`).expect(200);
    await approver.agent.post(`/api/v1/remediations/${action.id}/approve`).send({}).expect(200);
    const executed = (await org.owner.post(`/api/v1/remediations/${action.id}/execute`).send({}).expect(200)).body;
    // Refused before anything left: a certain "not applied", not an unknown outcome.
    expect(executed).toMatchObject({ status: 'FAILED', executionResult: { success: false, outcome: 'not_applied' } });
    expect(executed.executionResult.summary).toContain('Nothing was sent');
    expect(hits).toEqual([]);
    expect(await prisma.serviceEvent.count({ where: { organizationId: org.organizationId } })).toBe(0);
  });
});
