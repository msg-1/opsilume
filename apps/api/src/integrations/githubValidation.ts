import { GithubError, RestGithubAdapter } from './github';

/**
 * A read-only check of the GitHub integration against the real GitHub API, for the one thing
 * the test suite cannot show: that the client works against github.com with a real token.
 * It only ever sends GET requests. It reports counts and names, never the token and never
 * the content of commits or pull requests.
 *
 * Used by `npm run github:validate` (scripts/github-validate.ts). See docs/github-validation.md.
 */

export interface GithubValidation {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

const REPOSITORY = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;
const WRITE_SCOPES = ['repo', 'public_repo', 'admin:', 'write:', 'delete_repo', 'workflow'];

export async function validateGithub(options: { token: string; repository: string; baseUrl?: string; days?: number }): Promise<GithubValidation> {
  const baseUrl = options.baseUrl ?? 'https://api.github.com';
  const checks: GithubValidation['checks'] = [];
  const record = (name: string, ok: boolean, detail: string) => void checks.push({ name, ok, detail });
  const say = (err: unknown) => (err instanceof GithubError ? err.message : `request failed (${(err as Error).name})`);
  if (!REPOSITORY.test(options.repository)) {
    record('repository name', false, 'Use the form owner/repository.');
    return { ok: false, checks };
  }
  const adapter = new RestGithubAdapter(options.token, baseUrl);

  let login: string | null = null;
  try {
    login = await adapter.whoAmI();
    record('token accepted', !!login, login ? `Authenticated as ${login}.` : 'GitHub returned no account for this token.');
  } catch (err) {
    record('token accepted', false, say(err));
    return { ok: false, checks };
  }

  // What the token may do. A classic token lists its scopes; a fine-grained token lists none
  // here, and its permissions can only be read on GitHub's own settings page.
  try {
    const res = await fetch(`${baseUrl}/user`, { redirect: 'manual', headers: { accept: 'application/vnd.github+json', 'user-agent': 'opsilume', authorization: `Bearer ${options.token}` }, signal: AbortSignal.timeout(20_000) });
    await res.body?.cancel().catch(() => undefined);
    const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const writes = scopes.filter((s) => WRITE_SCOPES.some((w) => s === w || s.startsWith(w)));
    if (!scopes.length) record('token is read-only', true, 'The token reports no classic scopes (a fine-grained token, or one with none). Confirm on GitHub that it has read-only access to Contents and Pull requests of the test repository and nothing else.');
    else record('token is read-only', writes.length === 0, writes.length ? `The token can write (${writes.join(', ')}). OPSILUME only reads; use a token that cannot write.` : `Scopes: ${scopes.join(', ')}.`);
  } catch (err) {
    record('token is read-only', false, say(err));
  }

  try {
    const repo = await adapter.getRepository(options.repository);
    record('repository readable', true, `${repo.fullName}, default branch ${repo.defaultBranch}, ${repo.private ? 'private' : 'public'}.`);
  } catch (err) {
    record('repository readable', false, say(err));
    return { ok: false, checks };
  }

  const since = new Date(Date.now() - (options.days ?? 30) * 86_400_000);
  try {
    const commits = await adapter.listCommits(options.repository, since, 20);
    const withFiles = commits.filter((c) => c.filesChanged?.length).length;
    const wellFormed = commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha) && !Number.isNaN(c.committedAt.getTime()));
    record('commits readable', wellFormed, `${commits.length} commit(s) in the last ${options.days ?? 30} days, ${withFiles} with file-level detail${wellFormed ? '' : '; at least one has a malformed id or date'}.`);
  } catch (err) {
    record('commits readable', false, say(err));
  }
  try {
    const pulls = await adapter.listPullRequests(options.repository, since, 20);
    const wellFormed = pulls.every((p) => Number.isInteger(p.number) && ['open', 'closed', 'merged'].includes(p.state));
    record('pull requests readable', wellFormed, `${pulls.length} pull request(s) updated in the last ${options.days ?? 30} days${pulls.length ? ` (${pulls.filter((p) => p.state === 'merged').length} merged)` : ''}.`);
  } catch (err) {
    record('pull requests readable', false, say(err));
  }
  return { ok: checks.every((c) => c.ok), checks };
}
