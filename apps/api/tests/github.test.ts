import { createHmac } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validateGithub } from '../src/integrations/githubValidation';
import { githubConfig, syncRepositories } from '../src/modules/github';
import { api, createApiKey, createOrg, createService, prisma } from './helpers';

// The GitHub integration against a local stand-in for the GitHub API, which answers the way
// GitHub does (statuses, headers, shapes). What this cannot show is that the client works
// against github.com itself; that needs a real token and is described in docs/github-validation.md.
const TOKEN = 'ghp_validTokenValidTokenValidToken0123456789';
const SECRET = 'webhook-secret-0123456789';
const sha = (n: number) => String(n).padStart(40, 'a');

let server: Server;
let base = '';
const github = { mode: 'ok' as 'ok' | 'rate_limited' | 'server_error' | 'forbidden', scopes: 'read:user', requests: [] as { method: string; url: string; auth?: string }[] };

beforeAll(async () => {
  server = createServer((req, res) => {
    github.requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
    if (req.url === '/user') return json(200, { login: 'opsilume-test-bot' }, { 'x-oauth-scopes': github.scopes });
    if (github.mode === 'rate_limited') return json(403, { message: 'API rate limit exceeded for user ID 1.' }, { 'x-ratelimit-remaining': '0' });
    if (github.mode === 'server_error') return json(502, { message: 'Server Error: upstream said token=' + TOKEN });
    if (github.mode === 'forbidden') return json(403, { message: 'Resource not accessible by personal access token' }, { 'x-ratelimit-remaining': '4999' });
    if (req.url === '/repos/acme/shop') return json(200, { full_name: 'acme/shop', default_branch: 'main', html_url: 'https://github.com/acme/shop', private: true });
    if (req.url?.startsWith('/repos/acme/shop/commits?')) return json(200, [{ sha: sha(1), html_url: 'https://github.com/acme/shop/commit/1', commit: { message: 'Lower pool size', author: { name: 'Dev', date: new Date().toISOString() }, committer: { date: new Date().toISOString() } }, author: { login: 'dev1' } }]);
    if (req.url === `/repos/acme/shop/commits/${sha(1)}`) return json(200, { stats: { additions: 4, deletions: 1 }, files: [{ filename: 'config/pool.yaml', additions: 4, deletions: 1, status: 'modified' }] });
    if (req.url?.startsWith('/repos/acme/shop/pulls')) return json(200, [{ number: 7, title: 'Lower pool size', body: null, state: 'closed', merged_at: new Date().toISOString(), merge_commit_sha: sha(1), user: { login: 'dev1' }, labels: [{ name: 'config' }], html_url: 'https://github.com/acme/shop/pull/7', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), closed_at: new Date().toISOString(), base: { ref: 'main' }, head: { ref: 'pool' } }]);
    json(404, { message: 'Not Found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  githubConfig.baseUrl = base;
});
afterAll(async () => {
  githubConfig.baseUrl = 'https://api.github.com';
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  github.mode = 'ok';
  github.scopes = 'read:user';
  github.requests = [];
});

type Org = Awaited<ReturnType<typeof createOrg>>;
async function connected() {
  const org = await createOrg();
  await createService(org.owner, 'Shop');
  await org.owner.put('/api/v1/github/integration').send({ token: TOKEN, webhookSecret: SECRET }).expect(200);
  await org.owner.post('/api/v1/github/repositories').send({ fullName: 'acme/shop', service: 'shop' }).expect(201);
  return org;
}
const deliver = (org: Org | { slug: string }, payload: unknown, opts: { event?: string; secret?: string; signature?: string; body?: string } = {}) => {
  const body = opts.body ?? JSON.stringify(payload);
  const signature = opts.signature ?? `sha256=${createHmac('sha256', opts.secret ?? SECRET).update(JSON.stringify(payload)).digest('hex')}`;
  return api().post(`/api/v1/webhooks/github/${org.slug}`).set('content-type', 'application/json').set('x-github-event', opts.event ?? 'push').set('x-hub-signature-256', signature).send(body);
};
const push = (n: number, ref = 'refs/heads/main') => ({ ref, repository: { full_name: 'acme/shop' }, commits: [{ id: sha(n), message: `Change ${n}`, timestamp: new Date().toISOString(), author: { name: 'Dev', username: 'dev1' }, modified: ['src/a.ts'] }] });
const commitCount = (org: Org) => prisma.commit.count({ where: { repository: { organizationId: org.organizationId } } });

describe('GitHub webhooks', () => {
  it('accept a delivery only when its signature covers exactly the body that arrived', async () => {
    const org = await connected();
    const before = await commitCount(org);
    // Signed for one body, delivered with another.
    expect((await deliver(org, push(2), { body: JSON.stringify(push(3)) })).status).toBe(401);
    // The right secret of another organisation; the wrong algorithm; rubbish; nothing.
    const other = await createOrg();
    await other.owner.put('/api/v1/github/integration').send({ webhookSecret: 'another-organisations-secret' }).expect(200);
    expect((await deliver(org, push(2), { secret: 'another-organisations-secret' })).status).toBe(401);
    for (const signature of [`sha1=${createHmac('sha1', SECRET).update(JSON.stringify(push(2))).digest('hex')}`, 'sha256=', 'sha256=zzzz', `sha256=${'0'.repeat(64)}`, `${'f'.repeat(4000)}`, '']) {
      expect((await deliver(org, push(2), { signature })).status, signature.slice(0, 20)).toBe(401);
    }
    expect(await commitCount(org)).toBe(before);
    // An organisation with no secret refuses everything; an unknown organisation does not exist.
    const bare = await createOrg();
    expect((await deliver(bare, push(2))).status).toBe(400);
    expect((await deliver({ slug: 'no-such-organisation' }, push(2))).status).toBe(404);
    // A refused delivery says nothing about why beyond "invalid signature".
    const refused = await deliver(org, push(2), { secret: 'wrong' });
    expect(refused.body.error.message).toBe('Invalid webhook signature');
    expect(JSON.stringify(refused.body)).not.toContain(SECRET);
  });

  it('store what a valid delivery carries, once, and ignore what is not theirs', async () => {
    const org = await connected();
    const before = await commitCount(org);
    expect((await deliver(org, push(2))).body).toEqual({ ok: true, handled: 1 });
    // GitHub redelivers. The same commit is not stored a second time.
    expect((await deliver(org, push(2))).body).toEqual({ ok: true, handled: 1 });
    expect(await commitCount(org)).toBe(before + 1);
    // A push to another branch, an event that is not handled, a repository that is not connected.
    expect((await deliver(org, push(3, 'refs/heads/feature'))).body).toEqual({ ok: true, handled: 0 });
    expect((await deliver(org, { action: 'created', repository: { full_name: 'acme/shop' } }, { event: 'star' })).body).toEqual({ ok: true, handled: 0 });
    expect((await deliver(org, { ...push(4), repository: { full_name: 'acme/other' } })).body).toMatchObject({ ignored: 'repository is not connected' });
    expect((await deliver(org, {}, { event: 'push' })).body).toMatchObject({ ignored: 'repository is not connected' });
    expect(await commitCount(org)).toBe(before + 1);
    // A pull request event updates the pull request it is about.
    const pr = { action: 'closed', repository: { full_name: 'acme/shop' }, pull_request: { number: 9, title: 'Raise pool size', body: null, state: 'closed', merged_at: new Date().toISOString(), merge_commit_sha: sha(2), user: { login: 'dev2' }, labels: [], html_url: 'https://github.com/acme/shop/pull/9', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), closed_at: new Date().toISOString(), base: { ref: 'main' }, head: { ref: 'raise' } } };
    expect((await deliver(org, pr, { event: 'pull_request' })).body).toEqual({ ok: true, handled: 1 });
    expect((await deliver(org, pr, { event: 'pull_request' })).body).toEqual({ ok: true, handled: 1 });
    expect(await prisma.pullRequest.count({ where: { repository: { organizationId: org.organizationId }, number: 9 } })).toBe(1);
    // Each accepted delivery is in the audit log as the system's act, without the payload.
    const audits = await prisma.auditLog.findMany({ where: { organizationId: org.organizationId, action: 'github.webhook' } });
    expect(audits.length).toBeGreaterThanOrEqual(4);
    expect(audits.every((a) => a.actorType === 'system')).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('Raise pool size');
  });
});

describe('GitHub permissions and failures', () => {
  it('lets only admins and owners configure it, engineers synchronise, and no API key do either', async () => {
    const org = await connected();
    const [viewer, engineer] = [await org.member('VIEWER'), await org.member('ENGINEER')];
    for (const who of [viewer, engineer]) {
      expect((await who.agent.put('/api/v1/github/integration').send({ token: TOKEN })).status).toBe(403);
      expect((await who.agent.post('/api/v1/github/repositories').send({ fullName: 'acme/shop' })).status).toBe(403);
      expect((await who.agent.get('/api/v1/github/integration')).status).toBe(200);
    }
    expect((await viewer.agent.post('/api/v1/github/sync').send({})).status).toBe(403);
    expect((await engineer.agent.post('/api/v1/github/sync').send({})).status).toBe(202);
    const key = await createApiKey(org.owner, ['tools:read', 'ingest:logs']);
    expect([401, 403]).toContain((await api().put('/api/v1/github/integration').set('x-api-key', key).send({ token: TOKEN })).status);
    expect([401, 403]).toContain((await api().post('/api/v1/github/sync').set('x-api-key', key).send({})).status);
    // What anyone can read never contains the token or the secret.
    const view = (await viewer.agent.get('/api/v1/github/integration')).body;
    expect(view).toMatchObject({ mode: 'token', accountLogin: 'opsilume-test-bot', webhookSecretSet: true });
    expect(JSON.stringify(view)).not.toMatch(/ghp_|webhook-secret/);
    // Removing the token returns to unauthenticated access.
    expect((await org.owner.put('/api/v1/github/integration').send({ token: null }).expect(200)).body).toMatchObject({ mode: 'public', accountLogin: null });
    expect((await prisma.githubIntegration.findUniqueOrThrow({ where: { organizationId: org.organizationId } })).tokenEncrypted).toBeNull();
  });

  it('records a failed synchronisation as failed, in words, without the upstream text or the token', async () => {
    const org = await connected();
    for (const [mode, expected] of [['rate_limited', 'rate limit exceeded'], ['server_error', 'GitHub API error 502'], ['forbidden', 'GitHub API error 403']] as const) {
      github.mode = mode;
      const [result] = await syncRepositories(org.organizationId);
      expect(result!.error, mode).toContain(expected);
      const view = (await org.owner.get('/api/v1/github/integration')).body;
      expect(view).toMatchObject({ lastSyncStatus: 'error' });
      expect(view.lastSyncError).toContain('acme/shop');
      // Neither GitHub's own message nor anything it echoed back is stored or shown.
      const everything = JSON.stringify([view, (await org.owner.get('/api/v1/integrations')).body, await prisma.githubIntegration.findMany({ where: { organizationId: org.organizationId } })]);
      expect(everything).not.toContain(TOKEN);
      expect(everything).not.toContain('upstream said');
      expect(everything).not.toContain('user ID 1');
      expect((await org.owner.get('/api/v1/integrations')).body.integrations.find((i: { id: string }) => i.id === 'github')).toMatchObject({ status: 'degraded' });
    }
    // It works again once GitHub does, with no reconfiguration.
    github.mode = 'ok';
    expect((await syncRepositories(org.organizationId))[0]).toMatchObject({ commits: 1, pullRequests: 1 });
    expect((await org.owner.get('/api/v1/github/integration')).body).toMatchObject({ lastSyncStatus: 'ok', lastSyncError: null });
    // Synchronising twice stores nothing twice.
    const count = await commitCount(org);
    await syncRepositories(org.organizationId);
    expect(await commitCount(org)).toBe(count);
    // Every request to GitHub was a read.
    expect(new Set(github.requests.map((r) => r.method))).toEqual(new Set(['GET']));
  });
});

describe('the read-only validation procedure (npm run github:validate)', () => {
  it('reports what works without printing the token, sends only GET requests, and warns about a token that can write', async () => {
    const ok = await validateGithub({ token: TOKEN, repository: 'acme/shop', baseUrl: base });
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => [c.name, c.ok])).toEqual([['token accepted', true], ['token is read-only', true], ['repository readable', true], ['commits readable', true], ['pull requests readable', true]]);
    expect(ok.checks[0]!.detail).toBe('Authenticated as opsilume-test-bot.');
    expect(ok.checks[2]!.detail).toContain('acme/shop, default branch main, private');
    expect(ok.checks[3]!.detail).toContain('1 commit(s)');
    expect(ok.checks[4]!.detail).toContain('1 pull request(s)');
    expect(new Set(github.requests.map((r) => r.method))).toEqual(new Set(['GET']));
    expect(JSON.stringify(ok)).not.toContain(TOKEN);

    github.scopes = 'repo, read:user';
    const writable = await validateGithub({ token: TOKEN, repository: 'acme/shop', baseUrl: base });
    expect(writable.ok).toBe(false);
    expect(writable.checks.find((c) => c.name === 'token is read-only')).toMatchObject({ ok: false, detail: expect.stringContaining('can write (repo)') });

    const bad = await validateGithub({ token: 'ghp_not-the-token-not-the-token-000000', repository: 'acme/shop', baseUrl: base });
    expect(bad).toMatchObject({ ok: false, checks: [{ name: 'token accepted', ok: false }] });
    expect(JSON.stringify(bad)).not.toContain('ghp_not');
    expect((await validateGithub({ token: TOKEN, repository: 'acme/missing', baseUrl: base })).checks.at(-1)).toMatchObject({ name: 'repository readable', ok: false });
    expect((await validateGithub({ token: TOKEN, repository: '../..', baseUrl: base })).checks).toEqual([{ name: 'repository name', ok: false, detail: 'Use the form owner/repository.' }]);
  });
});
