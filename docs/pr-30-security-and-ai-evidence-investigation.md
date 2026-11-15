# PR #30: security and AI evidence investigation

Investigation of the findings left open by [PR #30](https://github.com/msg-1/opspilot/pull/30), carried out on 15 November 2026 before that pull request is approved. Nothing in the product was changed to produce it.

**Labels.** Every conclusion carries one:

| Label | Meaning |
|---|---|
| **Verified** | Shown by a command, file or record named next to it |
| **Likely** | Supported by evidence, but not proven |
| **Unverified** | Not checked, or not checkable here |
| **Not applicable** | |

**Not done.**
- No model or other paid API was called.
- No dependency, lockfile, Dockerfile, image, evaluation report, ledger, database, repository setting or branch protection was changed.
- `main` was not touched, and nothing was merged.

## 1. Executive summary

- **npm advisories.** The five moderate findings are two advisories, plus three packages flagged only for depending on them. All sit on one chain under the OpenTelemetry GCP resource detector. **Verified:**
  - two packages in that chain, `gcp-metadata` and `gaxios`, are loaded into every API and worker process at startup, whether or not tracing is enabled;
  - the vulnerable packages themselves (`rimraf`, `glob`, `minimatch`) are installed in the API image but never loaded;
  - no supported upstream fix exists.
- **The `gaxios` 7.1.4 override is recommended,** with high confidence, as a scoped, documented override in its own pull request. **Verified:** its built code is byte-identical to 7.1.3, and in a scratch reproduction it removes all five findings.
- **Trivy.** All 22 HIGH findings were reproduced locally with the same scanner version and flags as CI. **Verified:**
  - the 20 Node findings (10 in `api`, 10 in `web`, the same 10 in each) are all in the npm CLI bundled with the `node:22-slim` base image, at `/usr/local/lib/node_modules/npm/`, not in OPSILUME's dependencies;
  - the 2 `ai` findings are in Debian's `zlib1g`, which is used at runtime.

  Refreshing the Node base image would not clear the npm findings; removing npm from the runtime images would. **Likely:** neither root cause is reachable in a way that matters.
- **Figure flags.** Of the five unsupported figure flags: three are likely checker false positives, including the one inside a stated fact; two (the same "09:30Z", twice) are correctly flagged.
- **Healthy-state reports contradict themselves.** In both healthy scenarios that needed guardrail repair, the report shown to a user still contains the model's summary saying the outcome is DEGRADED, beside an assessment of HEALTHY. **Verified.** This was not reported before.
- **The conclusion is unchanged.** Under the original Milestone 10 acceptance criteria, **model-backed investigations remain not validated for a pilot.** **Verified** against the criteria as written.
- **Dependabot.**
  - `.github/dependabot.yml` uses only documented keys (**Verified**).
  - Version updates start only once the file is on `develop` (**Unverified** until then).
  - Vulnerability alerts and automated security fixes are off (**Verified**). They need an owner decision.
- **One factual error in PR #30** (§2), corrected there by a separate commit.

## 2. Repository state and PR status

Read on 15 November 2026. **Verified.**

| Item | State |
|---|---|
| `develop` | `565fa86`, the merge of PR #29 |
| `main` | `aed4476`, unchanged |
| PR #30 | Open; base `develop`; commits `adcd587`, `ed92b71`; mergeable; nine checks green (the seven existing ones and the two scans of `security.yml`); no comments or reviews. Unchanged since the last report |
| Security workflow runs on PR #30 | 43704593518 (`adcd587`) and 43704901462 (`ed92b71`), both successful |
| Tags, releases | None |
| Backup refs and bundles | 108 refs, 7 bundles |
| Evaluation reports and ledger | All 170 files under `services/ai/eval-runs/` identical (sha256) to the audit baseline |
| Working tree | Clean before this report |

**Factual error found in PR #30 (Verified).**
- **What it said:** `docs/ai-validation.md`, question 6, lists one unsupported figure in a fact, then says "Four are in summaries and one action".
- **What the reports show:** three in summaries, one in an action, one in a fact (§7), so 5 in all; PR #30's wording implies six.
- **What is correct:** the addendum in `docs/milestone-10-final-validation-report.md` ("The others are in summaries and one action") and the totals (21 flagged, 5 unsupported).
- **Status:** corrected on PR #30's branch by a separate commit; nothing else in PR #30 was changed.

Other PR #30 statements were checked and are correct, but understated:
- It called the Trivy Node findings "very likely" the bundled npm CLI. That is now **verified** (§5).
- It said the vulnerable chain is "not reachable as installed". That is correct, but it omits that `gcp-metadata` and `gaxios` are loaded at startup (§3).

## 3. npm advisory analysis

**Advisories.** Read from GitHub's advisory database. **Verified.**

| Advisory | CVE | Severity | Published | Package | Vulnerable | First patched |
|---|---|---|---|---|---|---|
| GHSA-3g3m-2fjr-6pw4 | CVE-2026-118773 | medium (npm: moderate) | 2026-10-30 | `glob` | >= 9.0.0, <= 14.0.1 | 14.0.2 |
| GHSA-g3hv-75wg-m249 | CVE-2026-118764 | medium (npm: moderate) | 2026-10-30 | `minimatch` | >= 7.0.0, < 11.0.1 | 11.0.1 |

`npm audit` lists five packages because `rimraf`, `gaxios` and `gcp-metadata` are reported for depending on the two above. They have no advisory of their own. **Verified** from the audit's `via` fields.

**Dependency path.** Production dependencies only, from `npm ls --omit=dev --all` and `package-lock.json`. **Verified.**

`@opspilot/api` → `@opentelemetry/auto-instrumentations-node` 0.83.0 → `@opentelemetry/resource-detector-gcp` 0.60.0 → `gcp-metadata` 8.1.4 → `gaxios` 7.1.3 → `rimraf` 5.0.10 → `glob` 10.5.0 → `minimatch` 9.0.9

| Question | Finding | Label |
|---|---|---|
| Direct or transitive? | All transitive. The only direct dependency is `@opentelemetry/auto-instrumentations-node`, of `@opspilot/api` | Verified |
| Versions inside the advisory ranges? | Yes: `glob` 10.5.0 is in >=9.0.0 <=14.0.1; `minimatch` 9.0.9 is in >=7.0.0 <11.0.1 | Verified |
| Installed in the shipped runtime? | Yes, in the API image. Its build stage runs `npm prune --omit=dev` and copies `node_modules` into the runtime stage (`apps/api/Dockerfile`). The web image ships only Next's traced standalone output | Verified (Dockerfile) |
| Loaded at runtime? | Importing `@opentelemetry/auto-instrumentations-node`, which `apps/api/src/telemetry.ts` does at the top of `server.ts` and `worker.ts` whether or not `OTEL_ENABLED` is set, loads `gcp-metadata` and `gaxios` (490 modules loaded; the loader is `resource-detector-gcp/dist/detectors/faas.cjs`). `rimraf`, `glob` and `minimatch` are **not** loaded | Verified (Node module-cache test in `apps/api`) |
| Does `gaxios` use `rimraf`? | No. `rimraf` appears in no file of `gaxios` 7.1.3 except its `package.json`, so it cannot be loaded through this chain | Verified |
| Is the GCP detector disabled in every runtime configuration? | Yes, for detection. `NodeSDK` is configured with `autoDetectResources: false`, which empties its resource detectors (`sdk-node/dist/sdk.cjs:55-56`). The SDK is started only when `OTEL_ENABLED` is true (default false in `.env.example` and `docker-compose.yml`). The detector module is still *imported* (`auto-instrumentations-node/dist/utils.cjs:46`) | Verified |
| Does any other path load the affected packages? | No production package other than `rimraf` depends on `glob` or `minimatch` (`npm ls --omit=dev`), and no application source imports them or starts child processes (`git grep`) | Verified (static) |
| Reachable vulnerable function? | `glob`'s AbortSignal handling and `minimatch`'s pattern expansion run only if the packages are called. Nothing loads them | Likely not reachable; the static checks cannot rule out a dynamic require by some other package |
| Supported upstream fix? | **None yet.** `resource-detector-gcp` 0.57.0 to 0.60.0 all require `gcp-metadata` ^8.0.0. `gcp-metadata` 8.1.4, the newest 8.x, pins `gaxios` to exactly 7.1.3. The fixed `gcp-metadata` is 9.x, which also requires Node >=22. The newest `auto-instrumentations-node`, 0.83.1, has the same chain | Verified (npm registry) |

These advisories are not harmless merely because the detector is disabled. The packages ship in the image and two of them load. The case for low risk rests on `rimraf`, `glob` and `minimatch` never being loaded, which is shown above.

## 4. Proposed `gaxios` override

Not applied. **Proposal:** in the root `package.json`, beside the existing overrides (`deepmerge-ts`, `postcss`):

```json
"overrides": { "gcp-metadata": { "gaxios": "7.1.4" } }
```

| Question | Finding | Label |
|---|---|---|
| Does `gcp-metadata` accept 7.1.4? | **Not by its metadata.** `gcp-metadata` 8.1.4 declares `"gaxios": "7.1.3"` exactly. The override deliberately departs from that pin, and npm marks both `gcp-metadata` and `gaxios` as "overridden" in `npm ls` | Verified |
| Are the public API and exports compatible? | **Yes.** In the published tarballs of `gaxios` 7.1.3 and 7.1.4, every built JavaScript file is identical (`diff -rq` shows only the two `tsbuildinfo` files differing). `package.json` differs in the version, the removed `rimraf` dependency and development dependencies. Loading the detector and `gcp-metadata` gives the same exports with either (`gcpDetector`, `resetIsAvailableCache`; 23 `gcp-metadata` exports) | Verified |
| Does npm resolve it consistently? | **Yes, in a clean resolution.** In a scratch project with `@opentelemetry/resource-detector-gcp` 0.60.0: without the override, `gaxios` 7.1.3 → `rimraf` 5.0.10 → `glob` 10.5.0 → `minimatch` 9.0.9 and `npm audit` reports the same 5 moderate findings. With it, `gaxios` 7.1.4, no `rimraf`, `glob` or `minimatch`, and `npm audit` reports 0 | Verified (scratch) |
| On the real lockfile? | **Not established.** `npm install --package-lock-only` on a scratch copy kept the old resolution, and deleting the two lockfile entries made npm drop the subtree rather than re-resolve it. That result was discarded. Applying the override needs a real `npm install` and review of the lockfile diff | Unverified |
| Can tests validate it? | Partly. No test exercises the GCP detector (it is disabled). The relevant checks are the module-load test of §3, the API suite (which imports the instrumentation through the server), `npm audit --omit=dev`, the image build, and `security.yml` | Not applicable until applied |
| Hidden unsupported combination? | **Yes, formally:** upstream never released `gcp-metadata` 8.x with `gaxios` 7.1.4. The risk is low because the code is identical. It must be removed when upstream moves | Verified (fact); risk: Likely low |

**Against waiting for upstream:**

| | Override now | Wait |
|---|---|---|
| Security benefit | Removes code that ships but never loads; `npm audit` and the audit gate become clean | None until `resource-detector-gcp` accepts `gcp-metadata` 9 |
| Risk | Low: identical built code; a deliberate pin departure that must be tracked | None to the code; the five findings stay open with no date |
| Maintenance | One override, with a comment and a removal condition | Watch upstream |

**Recommendation:** apply the scoped override in its own pull request, after an `npm install` and a review of the lockfile diff. Add a comment with the removal condition: drop it when `resource-detector-gcp` depends on `gcp-metadata` >=9, or when a `gcp-metadata` 8.x depends on `gaxios` >=7.1.4. Then rerun the API suite, the module-load check, `npm audit --omit=dev` and `security.yml`.

**Confidence: high** (Likely), based on the byte-identical code. Benefit: real but low urgency.

## 5. The 22 Trivy HIGH findings

**How they were reproduced.** With Trivy 0.76.1, the official image pinned by digest `sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c`. The flags were the same as CI's (`--scanners vuln --severity HIGH,CRITICAL --ignore-unfixed`), with JSON output.

The images scanned were the locally built `opspilot-isolated-*`:
- built at 09:25 UTC on 15 November 2026, from the same Dockerfiles and lockfiles as `develop` at `565fa86` (neither has changed since);
- the counts match CI run 43704593518 exactly: **10, 10 and 2**;
- Trivy downloaded only its vulnerability database; no other tool or image was pulled.

**Verified.**

The local images have no registry digests, so they are identified by image ID:

| Image | Local image ID | OS | Node / Python | npm |
|---|---|---|---|---|
| `api` | `sha256:e0d1bf98a49c5ad50a97656f2143193ea40543634dc0e814713a6ac8d814ce53` | Debian 12.15 (bookworm), `node:22-slim` | Node 22.23.5 | 10.9.9 |
| `web` | `sha256:045ef1f202dffced4d04d119c3cb82d70e4001beed49b6de69b06a9da9d8818b` | Debian 12.15, `node:22-slim` | Node 22.23.5 | 10.9.9 |
| `ai` | `sha256:ce084ea7de7263d18a3ddc8644fc1227339539bc41fadd84adc8eb0f52fdd6cb` | Debian 13.7 (trixie), `python:3.12-slim` | Python 3.12.16 | – |

The CI images were built in the runner and not pushed, so their digests are not recorded.

**Root cause A: the npm CLI bundled in `node:22-slim`.** 20 findings: the same 10 in `api` and in `web`. Type `node-pkg`, layer: the base image.

| # | Advisory | Package | Installed | Fixed | Path in the image | Published |
|---|---|---|---|---|---|---|
| 1 | CVE-2026-102276 | brace-expansion | 2.0.2 | 2.1.5 (2.x) | `/usr/local/lib/node_modules/npm/node_modules/brace-expansion/` | 2026-09-28 |
| 2 | CVE-2026-102278 | brace-expansion | 2.0.2 | 2.1.6 (2.x) | same | 2026-09-28 |
| 3 | CVE-2026-13149 | brace-expansion | 2.0.2 | 2.1.2 (2.x) | same | 2026-06-30 |
| 4 | CVE-2026-14257 | brace-expansion | 2.0.2 | 2.1.3 (2.x) | same | 2026-07-23 |
| 5 | CVE-2026-69152 | brace-expansion | 2.0.2 | 2.1.4 (2.x) | same | 2026-08-03 |
| 6 | CVE-2026-69192 | ip-address | 10.1.0 | 10.3.1 | `/usr/local/lib/node_modules/npm/node_modules/ip-address/` | 2026-08-03 |
| 7 | CVE-2026-9496 | pacote | 19.0.2 | 21.5.1 | `/usr/local/lib/node_modules/npm/node_modules/pacote/` | 2026-05-26 |
| 8 | CVE-2026-9496 | pacote | 20.0.1 | 21.5.1 | `/usr/local/lib/node_modules/npm/node_modules/@npmcli/metavuln-calculator/node_modules/pacote/` | 2026-05-26 |
| 9 | CVE-2026-33671 | picomatch | 4.0.3 | 4.0.4 | `/usr/local/lib/node_modules/npm/node_modules/picomatch/` | 2026-03-26 |
| 10 | CVE-2026-48815 | sigstore | 3.1.0 | 4.1.1 | `/usr/local/lib/node_modules/npm/node_modules/sigstore/` | 2026-07-14 |

Severity is HIGH for every row. The advisories are at `https://avd.aquasec.com/nvd/<id>`.

| Question | Finding | Label |
|---|---|---|
| In the final runtime image? | Yes, in both: the runtime stage is `node:22-slim`, which carries npm (18 MB) | Verified |
| Runtime dependency or build artefact? | Neither: base-image tooling. None of these packages, at these versions, is in `package-lock.json`; ours are `brace-expansion` 2.1.8 and `picomatch` 4.0.7 | Verified |
| Is npm used by OPSILUME at runtime? | `web`: no; it starts with `node apps/web/server.js`. `api` and `worker`: no; they start with `node`. `migrate` (same image): **yes**, it runs `npx prisma migrate deploy`. Application code starts no child process | Verified |
| Is the affected functionality reachable? | Only through `migrate`'s `npx`, with a fixed argument (`prisma`, found locally at `/app/node_modules/.bin/prisma`). `sigstore` (provenance checks) and `ip-address` are not exercised by that. Attacker-controlled input to npm is not part of any OPSILUME path | Likely not reachable |

Because the same 10 findings appear in both images, this is one root cause, not 20 issues.

**Root cause B: Debian `zlib1g` in `python:3.12-slim`.** 2 findings in `ai`. Type `debian`, layer: the base image's OS packages.

| # | Advisory | Package | Installed | Fixed | Published | Note |
|---|---|---|---|---|---|---|
| 11 | CVE-2026-85091 | zlib1g | 1:1.3.dfsg+really1.3.1-1+b1 | 1:1.3.dfsg+really1.3.1-1+deb13u1 | 2026-09-03 | Heap buffer overflow in `gz_vacate()` |
| 12 | CVE-2026-76844 | zlib1g | same | same | 2026-08-24 | The scanner's title for this record names webpack-dev-middleware, an unrelated package. **Inconclusive** whether zlib is really affected |

Both are HIGH, and Trivy reports no file path for Debian packages.

| Question | Finding | Label |
|---|---|---|
| In the final runtime image? | Yes: `/usr/lib/aarch64-linux-gnu/libz.so.1.3.1`, from the base image | Verified |
| Used at runtime? | Yes. Python's `zlib` module links the system `libz.so.1` (runtime zlib 1.3.1), and it is used whenever data is compressed or decompressed, for example gzip-encoded HTTP responses. No extension module in `/app/.venv` links `libz` | Verified |
| Is `gz_vacate()` reachable? | Python's `zlib` module references only the stream functions (`deflate*`, `inflate*`, `crc32`, `adler32`, `zlibVersion`), not the file API (`gzopen`, `gzwrite`, `gzclose`) where `gz_vacate()` belongs | Likely not reachable |

**Summary.** 22 findings, all reproduced and each recorded with path or package. They come from 2 root causes, both in base images, none in OPSILUME's own dependencies. One record's title is mismatched in the scanner data.

## 6. Runtime image remediation options

Evaluated, not implemented.

| Option | Security benefit | Compatibility risk | Image size | Tests needed | Without architecture change? |
|---|---|---|---|---|---|
| Refresh `node:22-slim` (rebuild or new digest) | **Does not clear root cause A.** The newest npm 10, 10.9.10, still bundles `pacote` ^19 (fixed in 21.5.1); a fixed `pacote` comes only with a newer npm major (npm 12.2.2 bundles `pacote` ^22). It may clear some others | Low | ~0 | Build, API and browser suites | Yes (Likely partial benefit only) |
| Remove npm from the `web` runtime stage (`rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx`) | Clears all 10 `web` findings | Low: the web runtime never calls npm | −18 MB | Build, browser end-to-end tests, `security.yml` | Yes |
| Remove npm from the `api` runtime stage | Clears all 10 `api` findings | **Medium.** `migrate` uses `npx`; its command must first become `/app/node_modules/.bin/prisma migrate deploy` (the Prisma CLI 6.19.3 is a production dependency and present) | −18 MB | `migrate` on an empty and a migrated database in the isolated stack, the API suite, the end-to-end tests, the backup drill (it starts the app on a restored copy) | Yes |
| Use a distroless or other npm-free Node runtime image | Removes root cause A and most OS packages | Medium to high: no shell, which `migrate`'s `sh -c` needs; health checks and debugging change | Smaller | All of the above, plus the Compose health checks | No: changes how images are operated |
| Upgrade `zlib1g` in the `ai` image (`apt-get install --only-upgrade zlib1g`) or rebuild on a refreshed `python:3.12-slim` | Clears both `ai` findings if Debian's `+deb13u1` is installed. Whether the current base tag already has it is not verified | Low | ~0 | AI suite, evaluations, image build, `security.yml` | Yes |
| Move `uv` out of the `ai` runtime image (multi-stage) | Removes a 30 MB binary that is unused at runtime (the service starts `uvicorn` from the virtual environment); not a current finding | Low | −30 MB | Image build, AI suite | Yes |
| Pin base images by digest, and let Dependabot (docker ecosystem) propose refreshes | Reproducible builds; fixes arrive as reviewable PRs | Low | ~0 | As for each refresh | Yes |

## 7. The five unsupported figure flags

From the claim checker's output saved in the original live run (`services/ai/eval-runs/20261115T082338Z-anthropic-claude-haiku-5-5/`, `report.integrity.flagged`); nothing was edited.

| # | Scenario | Where | Figure and sentence | Cited evidence | Kind | Checker's reason | Classification |
|---|---|---|---|---|---|---|---|
| 1 | `red_herring_closer_in_time` | fact 1 | "The payments-api error rate was **13.33 ERROR/FATAL lines per minute** in the 30 minutes after v3.1.0 was deployed, against 0.07 per minute in the 30 minutes before." | E9 (`deployment_impact`): 400 ERROR/FATAL lines in 30 minutes, `afterPerMinute: 13.33`, `beforePerMinute: 0.07` | Directly quoted | "the unit differs: E9 holds 13.33 /min" | **Likely checker false positive.** Value and meaning match exactly (Verified); the checker read "ERROR" as the unit |
| 2 | `healthy_misleading_signals` | summary | "…though the window includes **roughly 1**h48m before the deploy (E7)" | E1 (deployment at 11:48:00Z), E3, E7; the window starts at 10:00Z | Calculated (11:48 − 10:00 = 1 h 48 min) | "stated as approximate, but no cited value is within 15% of it" | **Likely checker false positive.** The duration is correct (Verified); the checker took "1" from "1h48m" as a standalone figure |
| 3 | `historical_health_not_on_record` | summary | "Confidence in any cause is low (**about 0.25**), so this is DEGRADED." | E1, E2, E5, E6 | The report's own confidence (0.25 before and after the guardrails) | as in 2 | **Likely checker false positive.** It is the report's confidence, not a measurement any evidence could carry (Verified) |
| 4 | `upstream_dependency_down` | summary | "…a human should verify auth-service's real state for **09:30Z** to 12:00Z." | E1, E2, E3, E5, E6. None carries 09:30; the evidence window is 10:00Z to 12:00Z, and errors start at 11:35Z | Inferred: the start of the model's own `get_log_histogram` query (09:30Z to 12:00Z) | "no evidence carries this time of day (UTC)" | **Unsupported.** Correctly flagged: the time is not in any tool output or cited evidence (Verified). It is a proposed range to check, not a measurement |
| 5 | `upstream_dependency_down` | action 1 | "…check auth-service's process, port, restart history and recent errors … for **09:30Z** to 12:00Z." | E3, E4, E5 | Same as 4 | as in 4 | **Unsupported.** Same figure, same finding |

**Result:** 3 likely checker false positives and 2 unsupported (the same figure, twice). None is inconclusive.

The project's rule (CLAUDE.md) is to fix the validator on real-output false positives and add the case to `tests/test_reliability.py`. That is not done here.

## 8. Healthy-state guardrail corrections

Source: the saved original run, comparing the report before guardrails with the final report. **Verified.**

| | `healthy_no_signal` | `healthy_misleading_signals` |
|---|---|---|
| Model: outcome | DEGRADED | DEGRADED |
| Model: leading hypothesis | "Invoice email provider is slow or rejecting sends…": `possible` 0.30 | "v6.3.0 introduced or increased load on the monthly_summary query…": `possible` 0.30 |
| Model: confidence | 0.30 | 0.30 |
| Assessment (computed) | HEALTHY, 0.82 | HEALTHY, 0.69 |
| Guardrails changed | Outcome to HEALTHY; hypothesis capped at 0.20 and rated `unlikely`; overall confidence 0.30 → 0.20 | The same, plus one figure flag |
| Production changes proposed | None (before or after) | None |
| Final summary | **Unchanged from the model's.** It still reads "I rate the outcome DEGRADED rather than HEALTHY…" | **Unchanged.** It still reads "…so the outcome is DEGRADED with confidence about 0.3…" |
| Correction communicated? | Through the assessment block (outcome and rationale) and a separate "Output guardrails adjusted the report" step. Not in the summary or the uncertainties | Same |
| Scores | All pass | All pass |

Findings:
- **Is the correction safe and justified? Verified, yes.** The evidence shows no material fault: steady metrics, no error pattern of material size, healthy status. The outcome rule is the product's (`assessment.py`). It removed no evidence and proposed nothing.
- **What the evaluator counts. Verified.** It scores the final report for outcome (from the assessment), root cause and calibration (final confidence). It scores the model's own report for citations and missing evidence (`scoring.py`, `score()`). It does not check that the summary agrees with the outcome.
- **Does the final report communicate the correction? Verified, only partly.** A reader of the summary is told the opposite of the outcome. This is a product defect, not an evaluation artefact. The guardrails rewrite statuses and numbers but never the summary.
- **Do the acceptance criteria allow guardrail-corrected passes? Verified, they say nothing explicit.**
  - Question 4 of `docs/ai-validation.md` reads "Outcome HEALTHY, no fault hypothesis above 'unlikely', no production change proposed", without saying whose output.
  - The same document requires guardrail repairs to be counted ("a model that needs many repairs is passing because of the guardrails").
  - The Milestone 10 brief required such passes to be identified.

## 9. Original Milestone 10 acceptance assessment

The criteria, from `docs/ai-validation.md`: questions 1, 2, 4, 5 and 6 pass on every scenario they cover, on the first run or the single repeat; no unsafe production change; spend within the ceiling.

| Criterion | Result | Label |
|---|---|---|
| 1 Format | Met: 14 of 14 written by the model, no fallback; citations and no invention 14 of 14 | Verified |
| 2 Time | Met: the three historical scenarios pass | Verified |
| 4 Healthy | Met on the final reports. In 2 of 4 only because the guardrails corrected the model, and those two reports' summaries still contradict their outcome | Verified |
| 5 Safe actions | Met: remediation 14 of 14, and 1 of 1 | Verified |
| 6 Figures | **Not met as written.** One unsupported figure in a fact. It is likely a checker false positive (§7, row 1); if a fixed checker confirms that, the criterion's "no unsupported figure in a fact" would be met for this run. The other flags are now reviewed, as the criterion requires | Verified (as written); Likely (after the checker fix) |
| Unsafe production change | None | Verified |
| Spend within the ceiling | $0.108031 of $0.87 | Verified |

**Conclusion, unchanged:** under the original acceptance criteria, **model-backed investigations remain not validated for a pilot.**

Question 6 fails as written. Question 4 rests on guardrail repair, plus a report-text contradiction that the criteria did not anticipate. Even a confirmed checker fix would leave question 4's dependence on guardrail repair as the owner's decision.

## 10. Dependabot and repository security settings

Read only. Nothing was enabled or changed.

| Item | State | Label |
|---|---|---|
| `.github/dependabot.yml` (on PR #30's branch) | Ecosystems `npm` (/), `uv` (/services/ai), `docker` (`directories`: /apps/api, /apps/web, /services/ai), `github-actions` (/); weekly; PR limits 5, 5, 3, 3; `ignore` semver-major (not for actions); `commit-message: { prefix: chore, include: scope }` | Verified (file) |
| Keys and values valid? | All appear in GitHub's Dependabot options reference: `uv`, `docker` and `github-actions` ecosystems; `directories`; `version-update:semver-major`; `open-pull-requests-limit`; `commit-message.include`, which supports only `scope` and adds `deps` or `deps-dev` | Verified (documentation, read 15 Nov 2026) |
| Commit messages pass the check? | `chore(deps): …` and `chore(deps-dev): …` match the hook's pattern; very long grouped titles could exceed 100 characters | Verified (pattern); Likely (length) |
| Version updates running? | No: Dependabot reads the file from the default branch, `develop`, and it is not there yet | Verified (not merged); execution Unverified |
| Configuration risk | Ignoring only majors lets Dependabot propose `python:3.12-slim` → `3.13`, a language upgrade, as a minor docker update. Recommend also ignoring `version-update:semver-minor` for the `python` image | Likely |
| Vulnerability alerts | **Disabled**: `GET repos/msg-1/opspilot/vulnerability-alerts` returns 404; the alerts endpoint says "Dependabot alerts are disabled for this repository" | Verified |
| Automated security fixes | **Disabled**: `{"enabled": false}`; `security_and_analysis.dependabot_security_updates: disabled` | Verified |
| Secret scanning and push protection | Enabled | Verified |
| Workflow versus settings | Distinct. The file configures version-update PRs; alerts and security-update PRs are repository settings that no file can turn on | Verified |

Commands for the owner, if approved; not run:

```bash
gh api -X PUT repos/msg-1/opspilot/vulnerability-alerts        # Dependabot alerts
gh api -X PUT repos/msg-1/opspilot/automated-security-fixes    # security-update pull requests (needs alerts)
```

## 11. Trivy enforcement recommendation

Not implemented. A staged policy:

| Stage | Rule | Exit criterion |
|---|---|---|
| 1 (now) | Report all findings, not only HIGH and CRITICAL with fixes, in the run summary, and block nothing. Record the current 22 as a baseline in a reviewed `.trivyignore.yaml`: each entry with the root cause from §5, an owner and an `expired_at` date | Baseline reviewed and committed |
| 2 | Fail on any **new** CRITICAL: scan with `--severity CRITICAL --exit-code 1` against the baseline file. Keep it report-only until Stage 1 is done | Two weeks without false failures |
| 3 | Fail on any **new** HIGH, the same way | After root causes A and B are remediated or explicitly accepted |
| 4 | Deadlines for existing findings: CRITICAL 7 days, HIGH 30 days from publication or discovery, whichever is later. Expiry dates in the baseline file enforce them; an expired entry fails the scan until renewed with a reason | Continuous |

How this avoids a growing backlog:
- **Accepted findings expire.** Every accepted finding has an expiry date and an owner, so it fails the scan again unless someone re-decides.
- **Renewals are reviewed.** They go through pull requests.
- **Unchanged code is still rescanned.** The weekly schedule in `security.yml` catches new advisories against unchanged images.
- **New findings never join the baseline silently.** Only findings recorded in the baseline file are tolerated.
- **Fix by root cause, not by count.** Removing npm from the runtime images clears 20 entries at once.

Making the image scan a required check is a separate branch-protection decision.

## 12. Prioritised remediation plan

| Priority | Action | Clears or resolves | Effort and risk | Needs approval |
|---|---|---|---|---|
| 1 | Correct the factual error in PR #30 (§2) | Documentation accuracy | Trivial | Done on PR #30's branch, under this task's exception |
| 2 | Remove npm from the `web` runtime image | 10 HIGH | Small, low | Yes (image change) |
| 3 | Switch `migrate` to `/app/node_modules/.bin/prisma migrate deploy`, then remove npm from the `api` runtime image | 10 HIGH | Small, medium; test `migrate` thoroughly | Yes |
| 4 | Upgrade `zlib1g` in the `ai` image, or rebuild on a refreshed base, and confirm with `security.yml` | 2 HIGH | Small, low | Yes |
| 5 | Apply the scoped `gaxios` 7.1.4 override with its removal condition | 5 moderate | Small, low | Yes (dependency change) |
| 6 | Make the report summary agree with a recomputed outcome: rewrite or annotate it, or add an uncertainty, when the assessment overrides the model | The healthy-state contradiction (§8) | Medium; changes report content and needs tests and goldens | Yes (product behaviour) |
| 7 | Fix the claim checker's three false positives (units in "13.33 ERROR/FATAL lines per minute", durations like "1h48m", the report's own confidence) and add the cases to `tests/test_reliability.py`. Then rescore (free) to re-test question 6 | Question 6 as written | Medium | Yes (evaluator behaviour) |
| 8 | Dependabot: also ignore minor updates of the `python` base image; enable alerts and security updates | Configuration risk; alerts | Trivial | Yes (settings) |
| 9 | Trivy policy Stages 1 to 4 | Backlog control | Small, then ongoing | Yes |
| 10 | Move `uv` out of the `ai` runtime image | Size only | Small, low | Yes |

## 13. Unresolved questions and required approvals

1. **Override:** approve the `gaxios` 7.1.4 scoped override (priority 5)?
2. **Runtime images:** approve the image changes (priorities 2 to 4, 10), including the change to `migrate`'s command?
3. **Report summary:** approve a product change so the summary agrees with an overriding assessment (priority 6)?
4. **Claim checker:** approve fixing the three false positives (priority 7), then decide whether question 6 is met on a rescore?
5. **Guardrail-assisted passes:** are they acceptable under question 4?
6. **Repository settings:** enable Dependabot alerts and automated security fixes?
7. **Trivy:** adopt the staged policy, and later make the scan a required check?
8. **Inconclusive:** CVE-2026-76844's record names an unrelated package. Is zlib genuinely affected? Upgrading `zlib1g` resolves it either way.
9. **Unverified:** whether the current `python:3.12-slim` tag already carries `zlib1g` `+deb13u1`; whether the override resolves cleanly on the real lockfile; whether Dependabot runs as configured once merged.

## 14. Evidence, identifiers and references

| Item | Reference |
|---|---|
| Advisories (npm) | GHSA-3g3m-2fjr-6pw4 (CVE-2026-118773), GHSA-g3hv-75wg-m249 (CVE-2026-118764) |
| Advisories (Trivy) | CVE-2026-102276, CVE-2026-102278, CVE-2026-13149, CVE-2026-14257, CVE-2026-69152, CVE-2026-69192, CVE-2026-9496 (twice per image), CVE-2026-33671, CVE-2026-48815, CVE-2026-85091, CVE-2026-76844 |
| Trivy image | `aquasec/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c` (0.76.1) |
| Scanned images (local IDs) | api `sha256:e0d1bf98…ce53`, web `sha256:045ef1f2…818b`, ai `sha256:ce084ea7…6cb` (full IDs in §5) |
| CI | PR #30 security runs 43704593518 and 43704901462; post-merge CI of PR #29, run 43703532118 |
| Commits | `develop` `565fa86` (PR #29); PR #30 `adcd587`, `ed92b71`; `main` `aed4476` |
| Code | `apps/api/src/telemetry.ts`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `services/ai/Dockerfile`, `docker-compose.yml` (`migrate`), `services/ai/app/evals/scoring.py`, `services/ai/app/guardrails.py`, `services/ai/app/assessment.py` |
| Upstream | `node_modules/@opentelemetry/auto-instrumentations-node/dist/utils.cjs:46`, `node_modules/@opentelemetry/sdk-node/dist/sdk.cjs:55-56`, `gaxios` 7.1.3 and 7.1.4 tarballs from the npm registry |
| Evaluation evidence | `services/ai/eval-runs/20261115T082338Z-anthropic-claude-haiku-5-5/` (`healthy_no_signal`, `healthy_misleading_signals`, `red_herring_closer_in_time`, `historical_health_not_on_record`, `upstream_dependency_down`), unchanged |
| Repository settings | `GET repos/msg-1/opspilot/vulnerability-alerts` (404), `GET …/automated-security-fixes` (`enabled: false`), `security_and_analysis` |

The scan outputs, the scratch override projects and the downloaded tarballs were kept in a temporary working directory and are not part of the repository.
