# Validating the GitHub integration

**Status, 15 November 2026: not validated against github.com. Everything that is verified is verified locally.**

| | |
|---|---|
| Real GitHub API (`api.github.com`) | **Not tested.** No request has been sent to it by this integration |
| Real webhook delivery from GitHub | **Not tested** |
| Local stand-in for the GitHub API | Tested by `apps/api/tests/github.test.ts` and the GitHub cases in `integrations.test.ts` and `intelligence.test.ts`, in CI on every pull request |
| The validation procedure (`npm run github:validate`) | Tested against the stand-in. Without credentials it sends nothing and exits with code 2 (confirmed 15 November 2026) |

Why: validation needs a token created for the purpose, limited to one test repository and read-only, given explicitly in `GITHUB_VALIDATION_TOKEN` and `GITHUB_VALIDATION_REPO`. Neither was set during Milestone 8 or Milestone 9. Credentials that happen to exist on a developer's machine (the `gh` login, `.env`, a keychain) were deliberately not used and not looked for: they are not test credentials, they can usually write, and they reach repositories that matter.

What this means for a pilot: connecting GitHub is **the first real test of this integration**. Do the procedure below, on a test repository, before connecting a repository that matters. It needs a person with a GitHub account and about ten minutes, and it is the only thing that closes this gap.

## What still has to be done, with a real token

It takes about ten minutes and writes nothing to GitHub.

1. **Create a dedicated test repository** in an account or organisation that is not used for real work, for example `your-org/opsilume-integration-test`. Push two or three commits to its default branch and open and merge one pull request, so there is something to read. Do not use a repository that matters.
2. **Create a fine-grained personal access token** (GitHub → Settings → Developer settings → Fine-grained tokens) with:
   - Repository access: **only** the test repository;
   - Permissions: **Contents: read-only** and **Pull requests: read-only** (Metadata is added automatically);
   - a short expiry (7 days).
3. **Run the read-only check**, giving the token in the environment of that one command. It is not read from `.env`, is never printed, and is used only for `GET` requests:

   ```bash
   GITHUB_VALIDATION_TOKEN=github_pat_...  GITHUB_VALIDATION_REPO=your-org/opsilume-integration-test  npm run github:validate
   ```

   Expected: five lines beginning `PASS` (token accepted, token is read-only, repository readable, commits readable, pull requests readable) and exit code 0. A classic token that can write is reported as a failure of "token is read-only".
4. **Then in the application** (on a test installation, not one holding real data): Settings → GitHub → save the same token; Code changes → connect the test repository and link it to a service; Integrations → GitHub → "Check connection". Expected: "Authenticated as …", "1 of 1 connected repositories can be read", and after a synchronisation the status "Receiving data" with the commits and the pull request under Code changes.
5. **Optionally, the webhook**: in the test repository → Settings → Webhooks, add `https://<your installation>/api/v1/webhooks/github/<organisation slug>` with content type `application/json`, the secret you saved under Settings → GitHub, and the events "Pushes" and "Pull requests". GitHub sends a `ping`; its delivery page should show a 200 with `pong`. Push a commit: it should appear under Code changes without a synchronisation. This needs the installation to be reachable from the internet.
6. **Revoke the token** and delete the webhook when done.

Record the result here:

| Date | Who | Repository | `github:validate` | In the application | Webhook | Token revoked |
|---|---|---|---|---|---|---|
| (not yet run) | | | | | | |

## What was tested without GitHub

Against a local HTTP server that answers as the GitHub REST API does (`apps/api/tests/github.test.ts`, `integrations.test.ts`, `intelligence.test.ts`):

| Area | Verified |
|---|---|
| Token | Checked against `/user` before it is stored; a rejected token is not stored; stored encrypted (AES-256-GCM); never returned by the API, written to the audit log or included in an error |
| Reading | Repository metadata, commits with file-level detail for the newest, pull requests with labels and merge state; synchronising twice stores nothing twice |
| Redirects | A redirect within the API (a renamed repository) is followed; a redirect to another host is refused and that host receives nothing; a loop ends after three |
| Failures | Rate limit (403 with no requests remaining), server error (502) and permission refusal (403) are recorded as a failed synchronisation in our own words; GitHub's message, and anything it echoes, is not stored or shown; the status becomes "needs attention" and recovers without reconfiguration |
| Only reads | Every request the client made in these tests was a `GET` |
| Permissions | Admins and owners configure; engineers may synchronise; viewers may only look; an API key can do neither |
| Webhook signatures | Accepted only when the HMAC-SHA256 covers exactly the body received. Refused: a body changed after signing, another organisation's secret, SHA-1, malformed or empty signatures, an organisation with no secret (400), an unknown organisation (404) |
| Webhook content | A push to the default branch stores its commits once however often it is redelivered; pushes to other branches, unhandled events and repositories that are not connected are acknowledged and ignored; a pull request event updates that pull request once |
| The validation procedure itself | `npm run github:validate` passes against the stand-in, reports a writable token, never prints the token, and only sends `GET` |

## What the stand-in cannot show

- That GitHub's real responses have the shapes the client expects, in every field it reads, today.
- Pagination beyond the first 100 commits or pull requests (the client asks for one page).
- Real rate-limit behaviour, secondary rate limits and abuse detection.
- Fine-grained token permission errors as GitHub actually phrases and codes them.
- GitHub Enterprise Server (the base address is fixed to `api.github.com`).
- Webhook delivery from GitHub's network, including its retries and its 10-second timeout.
