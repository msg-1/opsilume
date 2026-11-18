# Decision log

Newest last. Each entry: what was decided, why, and what it costs. Entries from 18 onward also give the date the decision was recorded, its context, the alternatives where known, and whether it is still current. Dates before 18 November 2026 are given only where a document or commit records them; no earlier date is inferred.

### 1. Monorepo with npm workspaces and one Python service
`apps/api`, `apps/web`, `services/ai`. One repository keeps the report contract, tool API and UI in step. The Python service uses `uv` and is not an npm workspace.

### 2. Started from an empty repository
The brief mentioned an existing React dashboard and Express API, but the project folder was empty and no such code was found on disk or in the owner's GitHub account. The owner chose to start fresh.

### 3. Pinned to mature major versions
At build time the newest majors were TypeScript 7, Prisma 7/8-rc, Next 16, Zod 4, Vitest 5, BullMQ 6 and ioredis 6. The project pins TypeScript 5.9, Prisma 6.19, Next 15.5, Zod 3.25, Vitest 3.2, BullMQ 5 and ioredis 5 for stability and well-understood behaviour. Cost: an upgrade pass later.

### 4. The API is the only component that touches the database
The AI service gets data through a read-only tool API instead of a database connection. This gives one place for tenancy and permissions, makes the agent's reach auditable (every tool call is in the audit log), and lets the MCP server reuse the same tools. Cost: an HTTP hop per tool call (a few milliseconds locally).

### 5. Milestone order changed
Planned M5 (GitHub) → M6 (queues) → M7 (auth). Built instead: auth, RBAC and tenancy first with the data model, then the queue layer, then features. Every table needs the tenant key and every route needs permissions, so retrofitting them would have meant rewriting each module. Testing was also done per feature rather than as a late milestone.

### 6. Session cookies behind a same-origin proxy
The web app proxies `/api/*` to the API, so auth uses `HttpOnly`, `SameSite=Lax` cookies and the browser never handles tokens in JavaScript. Short access tokens with rotating refresh tokens; replaying a rotated token revokes the user's sessions.

### 7. Three analysis engines, one of them without a model
Claude, OpenAI/Ollama, and a deterministic rule-based engine. The rule-based engine exists because the product must work with no credentials and must never pretend: without a model it still gathers real evidence and correlates it with explicit rules, labels the result as heuristic, and caps confidence at 75%. It is also the fallback when a model call fails mid-investigation.

### 8. Claude through the official Anthropic SDK; other providers through LangChain
The agent loop speaks LangChain message types and LangGraph orchestrates it. Claude is called with the official SDK so current API behaviour is used directly: adaptive thinking (no thinking budget, no sampling parameters), `output_config.effort`, no forced `tool_choice`, and `messages.parse` for structured output. Thinking blocks are replayed unchanged during the tool loop. Default model `claude-opus-5-5`, effort `medium`, both configurable.
Not enabled: Anthropic's server-side refusal fallback (a beta parameter). A refusal is reported as an error and the investigation falls back to the rule-based engine. Enable it in `AnthropicProvider` if refusals turn out to matter in practice.

### 9. Evidence is extracted by code, not written by the model
The model cites evidence numbers; it cannot create evidence. This is the main defence against fabricated logs, commits or metrics, and it is enforced twice (AI service and API).

### 10. 768-dimension vectors for every embedding provider
One fixed `vector(768)` column. OpenAI `text-embedding-3-small` is requested at 768 dimensions, Ollama `nomic-embed-text` is natively 768, and the built-in local embedding hashes words, bigrams and character trigrams into 768 buckets. The local one matches wording rather than meaning; hybrid search with full-text ranking compensates. Each document records its embedding model so vectors from different models are never compared.

### 11. Hybrid retrieval with reciprocal rank fusion
Vector and full-text results are merged by rank, not by score, because the two scores are not on comparable scales. Keyword-only fallback when embeddings are unavailable.

### 12. Remediation does not touch infrastructure
OPSILUME has no credentials for anyone's production. An approved action is either dispatched to a signed webhook the organisation configures, or performed by an operator who attests to it. This is honest about what the software does, and keeps "execute" from being a simulated success.

### 13. Sample GitHub data is opt-in and labelled
The mock adapter is used only for repositories explicitly created as "sample". Its commits and pull requests are flagged in the API, the UI and the agent's tool output. Without a token the real adapter still works for public repositories.

### 14. Logs and metrics in PostgreSQL
Simple to run locally, and adequate at this scale with time-window, trigram and fingerprint indexes. A dedicated store is the scaling path (see database-design.md).

### 15. Integration tests against a real database
API tests run through HTTP against PostgreSQL (`opsilume_test`) with jobs executed inline, and replace only the Python service with a scripted double. Tenancy, constraints, raw SQL and pgvector are therefore actually exercised. Each test creates its own organisation, so tests do not interfere.

### 16. Chart colours
Charts use a palette validated for colour-vision deficiency: status colours (critical, serious, warning) only for severity and error series, blue for a single measured series, one y-axis per chart, a legend for two or more series, and a screen-reader table behind every chart.

### 16a. Default Claude model and spending limits
Development defaults to `claude-haiku-5-5`, the lowest-priced current model, at the product owner's request; Sonnet and Opus are a one-line configuration change. Model ids were checked against Anthropic's models page. Spend is bounded at three levels: per call (output cap, timeout, at most two retries), per investigation (cost and token limits, with the last fifth reserved for the report) and per organisation per day. Costs are estimates from list prices; the Anthropic Console is authoritative.

### 16b. A fatal model error ends model use for that investigation
A rejected key, exhausted credit, unknown model or reached limit will not fix itself mid-run, so the agent stops calling the model immediately and the rule-based engine finishes, stating the reason. Rate limits and timeouts are retried a bounded number of times by the SDK and are not fatal.

### 16c. Patched transitive packages instead of two framework majors
The last high advisories were in `deepmerge-ts` (inside Prisma's CLI) and `postcss` (inside Next), both pinned exactly by their parents with no patched release on the current majors. npm `overrides` pin patched versions of those two packages only; the tools that use them were re-verified end to end. Zod, where the advisory was in the package itself, was upgraded to 4.

### 16d. History rewritten once to remove attribution trailers
With the owner's approval, the 23 commits carrying an AI co-author trailer were rewritten (message only). All 37 commits were verified one-for-one against the originals: same trees, authors, dates and parent relationships. Backups are kept under `refs/backup/pre-attribution-cleanup/*`, `refs/original/*` and a bundle in `.git/backup-pre-attribution-cleanup/` until the owner confirms removal.

### 17. Git workflow
GitFlow-style: `main` for releases, `develop` for integration, `feature/*` and `bugfix/*` merged into `develop` with `--no-ff`, `release/*` and `hotfix/*` into `main` with a back-merge (see git-workflow.md). Commit messages follow Conventional Commits and carry no AI or tool attribution; a small shell hook checks both, locally and in CI, instead of adding a commit-lint dependency. The first seven backend branches were cut from work that already existed when the workflow was requested, so their intermediate commits are not individually runnable; from the AI service onward each branch was tested before merging.

### 18. Post-restore remediation safety: product-owner decisions (17 November 2026)
**Context:** Milestone 16 design and decision review. **Decision:** V1, V2 (24 hours; any verification failure quarantines all API processes) and V3 approved; P1 to P6 approved as design direction, subject to implementation review, security review and integration tests; P8 and P8a approved in principle, subject to production validation and to role and migration testing; P8b rejected; backup retention of 30 days and a tested envelope of 1,000,000 actions approved. P7 (native Linux durability) awaits evidence. **Alternatives and consequences:** in [post-restore-remediation-safety-decision-review.md](post-restore-remediation-safety-decision-review.md). **Current:** yes.

### 19. P7 is a separate, hardware-dependent qualification (16 and 17 November 2026)
**Context:** no native Linux host or hypervisor was available. **Decision:** no durability claim is made from Docker Desktop. P7 needs a native Linux test machine, a separate recorder host and a 20-cycle physical power-cut series. It stays NOT TESTED until then; the harness is built and reviewed in the meantime. **Consequences:** a durability claim waits for hardware. **Current:** yes.

### 20. P7 recorder PASS gate (18 November 2026)
**Context:** independent reviews found ways to store a PASS that the evidence did not support. **Decision:**
- **A:** a worker stop reported after the cut request makes the cycle INCONCLUSIVE.
- **B:** the recorder verifies all mandatory evidence itself before storing a PASS.
- **C:** an evidence boundary ties a PASS to the records its check read.
- A recorder restart during an open cycle makes the cycle INCONCLUSIVE and ends a POWER-CUT series.

**Consequences:** stricter, fail-closed qualification; some honest runs end INCONCLUSIVE. Detail: [m16-p7-second-safety-review.md](m16-p7-second-safety-review.md) sections 14 to 14.3. **Current:** yes.

### 21. P7 recorder failure envelope (18 November 2026)
**Context:** handling of a contradiction that arrives after a stored PASS. **Decision:** the loss of a contradiction held only in memory, when the recorder can write nothing and is then killed, is accepted for the prototype. Replacing or remounting the recorder disk while it runs is outside the supported envelope. The recorder assumes its storage identity is stable while it runs. **Alternatives:** a second independent storage device or host (not adopted). **Consequences:** documented limits; no restart-safety claim under total storage failure. **Current:** yes.

### 22. Portfolio-first scope (recorded 18 November 2026)
**Context:** the owner's stated direction for the project. **Decision:** the goal is a portfolio-ready public prototype, not an enterprise or commercial product. Production-scale infrastructure and commercial functionality (billing, SLAs, compliance) are deferred. **Consequences:** effort goes to a safe public demo, presentation and an honest technical record. **Current:** yes.

### 23. Deployment target: Oracle Cloud Always Free, if eligible (recorded 18 November 2026)
**Context:** the public demo needs hosting at no cost. **Decision:** Oracle Cloud Always Free is the preferred target, subject to verifying account eligibility and that its resources can run the stack. **Alternatives:** other free tiers, not evaluated yet. **Consequences:** a feasibility check comes before any deployment work; nothing is provisioned without the owner's approval. **Current:** yes, unverified.

### 24. Zero monthly deployment budget (recorded 18 November 2026)
**Context:** owner constraint. **Decision:** no paid infrastructure, domain or service without explicit owner approval. **Consequences:** shapes hosting, observability and the demo design. **Current:** yes.

### 25. Public demo without paid AI, on seeded data (recorded 18 November 2026)
**Context:** a public instance must not spend money or touch real systems. **Decision:** the public demonstration uses the built-in rule-based engine (labelled as such in every report) and seeded fictional data. It sends no remediation to real destinations. A model provider stays an opt-in, local configuration. **Consequences:** visitors see real evidence-gathering without model reasoning; the live Claude run stays documented separately. **Current:** yes.

### 26. Public repository, private working notes (recorded 18 November 2026)
**Context:** the repository is a public portfolio. **Decision:** public documentation is tool-neutral engineering documentation. Development-assistant instructions and private session notes are kept out of version control (`.gitignore`). The repository's working rules are in [engineering-rules.md](engineering-rules.md). Existing history is not rewritten without explicit approval. **Consequences:** earlier commits still contain the former assistant instruction file. **Current:** yes.

### 27. One name everywhere: OPSILUME / `opsilume` (18 November 2026)
**Context:** the owner wants no reference to the former working name. **Decision:**
- Every identifier is renamed to `opsilume`: repository, packages, environment variables, headers, database, Docker names and the MCP server.
- The product name stays **OPSILUME** in text.
- Git history is not rewritten.

**Alternatives considered:**
- "ops-illuminate": rejected; OPSILUME is the documented name.
- Visible text only: rejected by the owner.

**Consequences:**
- Existing local installations start with new, empty volumes under the new project name, and the former Docker resources keep their names.
- Webhook receivers must read the new header.
- The name is still not trademark-cleared ([branding/opsilume-branding.md](branding/opsilume-branding.md)); if it is not cleared, the identifiers must be renamed again.

Decision 26's note that earlier commits contain the former instruction file remains true. **Current:** yes.

