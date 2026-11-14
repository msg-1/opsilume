/**
 * Checks the GitHub integration against github.com, read-only, with credentials supplied for
 * the purpose. See docs/github-validation.md.
 *
 *   GITHUB_VALIDATION_TOKEN=…  GITHUB_VALIDATION_REPO=owner/test-repo  npm run github:validate
 *
 * The token is read from the environment only, is never printed, and is used only for GET
 * requests. Use a dedicated test repository and a token that can read it and nothing else.
 */
import { validateGithub } from '../src/integrations/githubValidation';

async function main() {
  const token = process.env.GITHUB_VALIDATION_TOKEN;
  const repository = process.env.GITHUB_VALIDATION_REPO;
  if (!token || !repository) {
    process.stdout.write('Not run: set GITHUB_VALIDATION_TOKEN and GITHUB_VALIDATION_REPO (owner/repository) in the environment of this command.\nUse a dedicated test repository and a read-only token. See docs/github-validation.md.\n');
    process.exitCode = 2;
    return;
  }
  const result = await validateGithub({ token, repository });
  for (const check of result.checks) process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name.padEnd(24)} ${check.detail}\n`);
  process.stdout.write(result.ok ? '\nThe GitHub client works against github.com for this repository. Nothing was written.\n' : '\nAt least one check failed. Nothing was written.\n');
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).name}\n`);
  process.exitCode = 1;
});
