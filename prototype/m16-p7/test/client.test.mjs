// Post-commit review F23: the recorder client never follows a redirect. HARNESS test only, loopback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { keyFromHex, makeClient, newKeyHex } from '../lib/protocol.mjs';

test('a redirect from whatever answers at the recorder address is an error: the signed request is not sent anywhere else', async () => {
  let elsewhere = 0;
  const other = http.createServer((req, res) => { elsewhere += 1; res.end('{}'); });
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const redirecting = http.createServer((req, res) => { req.resume(); res.writeHead(307, { location: `http://127.0.0.1:${other.address().port}/runs/r1/event` }).end(); });
  await new Promise((r) => redirecting.listen(0, '127.0.0.1', r));
  const call = makeClient({ baseUrl: `http://127.0.0.1:${redirecting.address().port}`, key: keyFromHex(newKeyHex()), run: 'r1', timeoutMs: 3000 });
  await assert.rejects(call('POST', '/runs/r1/event', { kind: 'netcheck' }));
  assert.equal(elsewhere, 0, 'nothing reached the redirect target');
  await new Promise((r) => redirecting.close(r));
  await new Promise((r) => other.close(r));
});
