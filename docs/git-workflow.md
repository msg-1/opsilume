# Git workflow

OpsPilot uses a GitFlow-style model: two long-lived branches and four kinds of short-lived branch.

## Branches

| Branch | Created from | Merges into | Purpose |
|---|---|---|---|
| `main` | — | — | Released, production-ready code. Changes only through release and hotfix merges. Every commit on it is tagged. |
| `develop` | — | — | Integration branch. Always passes CI. |
| `feature/<name>` | `develop` | `develop` | One logical feature |
| `bugfix/<name>` | `develop` | `develop` | A non-urgent fix |
| `release/<version>` | `develop` | `main`, then back into `develop` | Stabilising a release: version bump, changelog, fixes only |
| `hotfix/<name>` | `main` | `main`, then back into `develop` | An urgent fix to released code |

Names are lowercase with hyphens: `feature/log-live-tail`, `bugfix/login-throttle`, `release/0.2.0`, `hotfix/token-expiry`.

```
main     ●───────────────────────────●──────────●   (tags: v0.1.0, v0.1.1)
          \                         / \        /
release    \            ●──●──●────●   \      /
            \          /            \   hotfix ●
develop      ●──●──●──●──────────────●────────●──●
                 \   /        \     /
feature/bugfix    ●─●          ●───●
```

## Day-to-day: a feature

```bash
# 1. Start from an up-to-date develop
git checkout develop
git pull --ff-only origin develop

# 2. Create the branch
git checkout -b feature/log-live-tail

# 3. Work, then verify what you touched
npm run lint && npm run typecheck
npm test                                   # API + web   (needs: npm run infra:up)
npm run test:ai                            # if services/ai changed

# 4. Commit using Conventional Commits
git add -A
git commit -m "feat(logs): add live tail to the log explorer"

# 5. Push and open a pull request into develop
git push -u origin feature/log-live-tail
gh pr create --base develop --fill

# 6. After review and green CI, merge with a merge commit
gh pr merge --merge --delete-branch
```

A `bugfix/*` branch follows exactly the same steps.

### Without network access

`develop` and `main` are protected on GitHub, so a local merge cannot be pushed to them: changes arrive through a pull request whose checks pass. Working offline, run the checks yourself and keep the work on its feature branch until it can be pushed. In a private fork without protection, the local equivalent of a pull request is:

```bash
git checkout develop
git merge --no-ff feature/log-live-tail -m "Merge feature/log-live-tail into develop"
```

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org): `type(optional-scope): summary`.

| Type | Use for |
|---|---|
| `feat` | New behaviour visible to users or API clients |
| `fix` | A bug fix |
| `security` | A change whose purpose is to close a vulnerability or harden a control |
| `refactor` | Restructuring with no behaviour change |
| `test` | Tests only |
| `docs` | Documentation only |
| `chore` | Tooling, dependencies, build, CI |

Rules:
- Subject in the imperative, 100 characters or fewer, no trailing full stop.
- The body says why, and names the audit finding or issue it addresses when there is one.
- A breaking change has `!` after the type (`feat(api)!: …`) and a `BREAKING CHANGE:` paragraph.
- One logical change per commit.
- **No AI or tool attribution**: no `Co-Authored-By` lines for assistants and no "generated with" lines.

Enable the local check once per clone:

```bash
git config core.hooksPath .githooks
```

The same script runs in CI on every pull request.

## Pull requests

- Target `develop`, except `release/*` and `hotfix/*`, which target `main`.
- Fill in the template: what and why, how it was verified, the checklist.
- Keep them small enough to review in one sitting. Split unrelated changes.

### Review requirements

| Target | Approvals | Reviewer checks |
|---|---|---|
| `develop` | 1 | Correctness, tests for changed behaviour, tenancy and permission checks on new routes, no secrets |
| `main` | 1, from someone other than the author of the release branch | Changelog and version are right; the full verification in [release-process.md](release-process.md) passed |

With a single maintainer, the review is a self-review against the checklist, and the required CI checks are the gate.

### Merge policy

| Merge | Method | Why |
|---|---|---|
| `feature/*`, `bugfix/*` → `develop` | Merge commit (`--no-ff`) | Keeps each feature visible as a unit in history |
| `release/*`, `hotfix/*` → `main` | Merge commit (`--no-ff`) | The merge commit is what gets tagged |
| `release/*`, `hotfix/*` → `develop` (back-merge) | Merge commit | Brings release fixes back |

Never rebase or force-push `main` or `develop`. Rebasing your own unpublished feature branch is fine. Delete short-lived branches after merging.

## Continuous integration

| Workflow | Runs on | Jobs |
|---|---|---|
| `ci.yml` | Pull requests into `develop` and `main`; pushes to `develop`, `main`, `release/**`, `hotfix/**` | Commit messages · Frontend (lint, typecheck, unit tests) · Backend (lint, typecheck) · Database integration tests (PostgreSQL + pgvector) · AI service (lint, tests, agent evaluations) · Build verification (builds, dependency audit, container images) |
| `e2e.yml` | Pull requests into `develop` and `main`; pushes to `release/**`, `hotfix/**`; manual | Builds a throwaway copy of the whole stack (its own Compose project, generated secrets, rule-based engine, no provider key), runs the browser tests against it, then the failure drills, the backup and restore drill and a reduced load test. Uploads screenshots, Playwright traces and service logs when it fails. Not a required check |
| `security.yml` | Pull requests into `develop` and `main` that change dependencies, Dockerfiles, `docker-compose.yml` or the workflow itself; pushes to `develop`; weekly (Monday 04:17 UTC); manual | Python dependency audit (`pip-audit` 2.9.0 on the AI service's locked production dependencies) and a container image scan (Trivy 0.76.1, pinned by digest; HIGH and CRITICAL with a fix; report only) of the api, ai and web images. Not a required check |
| `release.yml` | Push of a `vX.Y.Z` tag | Checks the tag is on `main` and matches `package.json`, then publishes a GitHub release |

The repository is published at https://github.com/msg-1/opspilot. `ci.yml` runs on every pull request and has passed on `develop`; `e2e.yml` has passed on `release/0.1.0` and, since Milestone 6, runs on every pull request. `release.yml` has never run, because no version tag has been pushed.

### What CI verifies, and what it does not

Reviewed on 15 November 2026 against the workflow files and the branch protection then in force. Every job uses the rule-based engine or a mocked provider; no job has a provider key, and `e2e.yml` asserts that before it runs anything.

| Concern | Where | State |
|---|---|---|
| API tests (206) on PostgreSQL with pgvector and Redis | `ci.yml` → Database integration tests | Required on `develop` and `main` |
| AI service tests (232), lint, and the 14 evaluation scenarios | `ci.yml` → AI service | Required |
| Web lint, typecheck and tests (53) | `ci.yml` → Frontend | Required |
| API lint and typecheck | `ci.yml` → Backend | Required |
| Contract drift: generated frontend types, shared contracts in both languages, the Python export | `ci.yml` → Backend and AI service (`git diff --exit-code` after regenerating), and `contract.test.ts`, `api-contract.test.ts` | Required |
| Builds, container images, the demo's build | `ci.yml` → Build verification | Required |
| Dependency advisories | `npm audit --omit=dev --audit-level=high` in Build verification | Required. Covers shipped Node dependencies of the workspaces only |
| Python dependency advisories | `security.yml` → Python dependency audit (pip-audit) | **Not required.** Fails on any known advisory |
| Container image vulnerabilities (api, ai, web) | `security.yml` → Container image scan (Trivy, report only) | **Not required.** Reports HIGH and CRITICAL findings with a fix; fails on none |
| Commit message rules and no tool attribution | `ci.yml` → Commit messages | Runs on pull requests; **not a required check** on either branch |
| Browser journeys (12) on a stack built from nothing | `e2e.yml` → Browser end-to-end tests | Required on `main`; **not required on `develop`** |
| Failure drills (11) | same job | as above |
| Backup and restore drill (9 steps) | same job | as above |
| Load test, reduced (`npm run loadtest -- --smoke`): fails if anything sent is not stored exactly once, a request fails, or the API is not ready afterwards. Asserts no timing | same job | as above |

Not covered by any job:

- **Static security analysis.** Python dependency advisories and container images are scanned by `security.yml`, which is not a required check. The image scan only reports: it fails on nothing until its findings have been reviewed and a threshold agreed.
- **The image scan's first findings are open.** First run on 15 November 2026 (run 43704593518): `pip-audit` found no known vulnerabilities. Trivy reported HIGH findings with a fix and no critical ones:

  | Image | Findings | Package | Installed | Fixed |
  |---|---|---|---|---|
  | `api`, `web` | 10 HIGH each, in Node packages | `brace-expansion`: five CVEs | 2.0.2 | 2.1.6 |
  | | | `ip-address` | 10.1.0 | 10.3.1 |
  | | | `pacote` | 19.0.2, 20.0.1 | 21.5.1 |
  | | | `picomatch` | 4.0.3 | 4.0.4 |
  | | | `sigstore` | 3.1.0 | 4.1.1 |
  | `ai` | 2 HIGH, in Debian packages | `zlib1g` | `1:1.3.dfsg+really1.3.1-1+b1` | `…-1+deb13u1` |

  **Where they come from.** None of the Node packages, at these versions, is in `package-lock.json`. Our `brace-expansion` is 2.1.8 and our `picomatch` 4.0.7. `pacote` and `sigstore` are npm's own internals. So these are very likely the npm CLI bundled in the `node:22-slim` base image, not the application's dependencies. The scan output does not show file paths, so this is not confirmed. One of the two `zlib1g` entries carries a title naming an unrelated package (webpack-dev-middleware) in the scanner's database.

  **Remediation options, not applied here** (each changes a runtime image):
  - remove npm from the `web` runtime stage, which does not use it;
  - for `api`, change the `migrate` command from `npx prisma migrate deploy` to run Prisma directly before removing npm;
  - for `ai`, rebuild on a refreshed `python:3.12-slim` or upgrade `zlib1g` in the image.
- **Five moderate advisories in shipped Node dependencies are open**, reviewed on 15 November 2026. `npm audit --omit=dev` fails only at high, and passes. They are two advisories and the packages that depend on them, all reached through one chain: `@opentelemetry/auto-instrumentations-node` → `@opentelemetry/resource-detector-gcp` → `gcp-metadata` 8.1.4 → `gaxios` 7.1.3 → `rimraf` 5 → `glob` 10 → `minimatch` 9.
  - `glob` >=9.0.0 <=14.0.1: GHSA-3g3m-2fjr-6pw4.
  - `minimatch` >=7.0.0 <11.0.1: GHSA-g3hv-75wg-m249.

  **Exposure:** none is a direct dependency. `gaxios` 7.1.3 declares `rimraf` but its built code never loads it, and the API never runs the GCP detector (`autoDetectResources: false` in `apps/api/src/telemetry.ts`). Nothing in our code uses `glob` or `minimatch`.

  **No compatible update exists:** `gcp-metadata` 8.1.4, the newest 8.x, pins `gaxios` to exactly 7.1.3; the fixed `gcp-metadata` is 9.x, a major version the detector does not accept; and the newest OpenTelemetry release (0.83.1) has the same chain.

  **Remediation options, each an owner decision:**
  - an npm `overrides` entry forcing `gaxios` 7.1.4, a patch release whose only relevant change is that it no longer depends on `rimraf`, against `gcp-metadata`'s exact pin;
  - wait for an OpenTelemetry release that moves to `gcp-metadata` 9.
- **Development dependencies and the `demo/` packages** are outside `npm audit --omit=dev`.
- **Dependabot alerts and automatic security updates** are repository settings and are not enabled. Secret scanning and push protection are. Dependabot *version* updates are configured in `.github/dependabot.yml`: weekly for npm, uv, the Dockerfiles and the GitHub Actions; majors ignored, because they are pinned in `docs/decisions.md`; commit messages `chore(deps): …`. They take effect once the file is on `develop`, the default branch. To enable alerts, the owner can run `gh api -X PUT repos/msg-1/opspilot/vulnerability-alerts`, or use Settings → Code security.
- **Performance regressions.** The full load test and `scripts/perf-probe.mjs` are run by hand; their numbers depend on the machine, so CI asserts none. A query that became ten times slower would pass CI.
- **The demo end to end** (about 25 minutes) and **anything involving a model or github.com**.
- **Post-merge end-to-end**: `e2e.yml` does not run on pushes to `develop`. A merge is covered by the run on its pull request, which, because the branch must be up to date, is the same tree.

The one gap in enforcement: **the check named `Browser end-to-end tests` is missing from the required status checks of `develop`.** It carries the browser journeys, all three drills and the load-test smoke, so today a pull request into `develop` can be merged with any of them failing. Nothing was changed in branch protection; the steps are below.

## Branch protection

Applied to `main` and `develop` on GitHub (pull request required, required checks, branch must be up to date, administrators included, no force pushes, no deletions). The required approval count is currently 0 because the project has one maintainer; raise it when there are reviewers. Recommended settings for a team:

**`main`**
- Require a pull request before merging; 1 approval; dismiss stale approvals
- Require status checks to pass, and require branches to be up to date:
  `Frontend (lint, typecheck, unit tests)`, `Backend (lint, typecheck)`, `Database integration tests (PostgreSQL + pgvector)`, `AI service (lint, tests, agent evaluations)`, `Build verification`, `Browser end-to-end tests`
- Require linear history: **off** (release merges are merge commits)
- Do not allow force pushes; do not allow deletions
- Apply to administrators

**`develop`**
- Require a pull request before merging; 1 approval (0 for a solo maintainer)
- Require the same checks except `Browser end-to-end tests`

### Requiring the end-to-end check on `develop`

State on 15 November 2026 (read from the API, not changed): `develop` requires five checks (Frontend, Backend, Database integration tests, AI service, Build verification). The end-to-end workflow runs on every pull request into `develop` and reports the check **`Browser end-to-end tests`**, but that check is **not required** there: a pull request can be merged while it is red or still running. `main` does require it.

To require it, the repository owner can either:

- in GitHub: Settings → Branches → the rule for `develop` → "Require status checks to pass before merging" → search for `Browser end-to-end tests` → add it → Save; or
- with the CLI:

  ```bash
  gh api -X POST repos/msg-1/opspilot/branches/develop/protection/required_status_checks/contexts \
    -f 'contexts[]=Browser end-to-end tests'
  ```

It adds about twelve minutes to every pull request. The name of the job in `.github/workflows/e2e.yml` and the name in branch protection must stay identical: renaming one without the other leaves pull requests waiting for a check that never reports (this happened to `main` in Milestone 6 and was corrected in Milestone 7).
- Do not allow force pushes; do not allow deletions

With the GitHub CLI, after the remote exists (replace `OWNER/REPO`):

```bash
gh api -X PUT repos/OWNER/REPO/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": [
    "Frontend (lint, typecheck, unit tests)", "Backend (lint, typecheck)",
    "Database integration tests (PostgreSQL + pgvector)", "AI service (lint, tests, agent evaluations)",
    "Build verification", "Browser end-to-end tests" ] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```

Use the same call for `develop` without `"Browser end-to-end tests"`. Branch protection on private repositories requires a paid GitHub plan; on a free plan it works for public repositories only.
