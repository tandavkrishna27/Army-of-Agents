# Cloud Execution Isolation (E2B) — Design / Scope Spec

**Written:** 2026-08-05. **Status:** DRAFT (for user review). **Type:** design spec — the scope document for the follow-up PR after #316. Feeds `writing-plans`.

**Companion reference (code-grounded, audited 2026-08-05, 21/21 claims confirmed):** [`2026-08-02-execution-isolation-e2b-REFERENCE.md`](./2026-08-02-execution-isolation-e2b-REFERENCE.md). This spec assumes that reference for all file/line citations; it is the *what-to-build* layer on top of the reference's *how-things-work* layer.

---

## 1. Goal

One PR that makes **all three agent-run types — org agents (heartbeat), crew (`kind='aoa'`), and Commander — execute inside a per-run E2B sandbox on `cloud_auth`**, reaching the control plane only through a **networked broker** (run-JWT auth; no database credentials or long-lived secrets inside the VM), with **hybrid statefulness** and **both managed and self-hosted E2B supported behind one config seam**.

This is an **execution-plane** project. **Cross-tenant data isolation is unchanged** — it is already owned by the data plane (company-bound run-JWT + broker scoping every query by `companyId`) and does not depend on any decision in this spec.

## 2. Scope boundary

### In v1 (this PR)
The full §7 build list from the reference doc, decomposed into units **U1–U13** (§5 below): operator-default E2B, the networked MCP broker, a crew run-JWT, crew + Commander lease wiring, the env-posture flip, file movement + workspace capture (org PRs + crew artifacts/`task_outputs`), the hybrid warm-reuse lifecycle, the D1 guard flip, the self-hosted `domain` knob, **plugins re-enabled in cloud (broker → host worker), stdio connectors allowed in-VM, cloud crew/agent auth on the company provider key, and the host one-shot CLIs — extraction, Commander-compaction, and provider-key readiness probes — run in an ephemeral sandbox (U13)**.

### Explicitly deferred to fast-follows (named here so they are not forgotten)
- **Broker-proxy egress** — VM's only egress is the broker (v1 uses an allowlist instead).
- **Broker-injected provider key** — key never enters the VM (v1 injects into VM env).
- **Broker-minted scoped git token** — "git-native" agents that push from inside the VM (v1 has the host make the PR).
- **gVisor self-host** — lighter "no third-party" isolation fallback if Firecracker ops prove heavy.
- **Scenario 2 — tenant-operated local runner** — cloud control plane, execution on the tenant's own machine via local CLI, data access via the same broker, tasks/state synced both ways (single-tenant, multi-user). Enabled by U2 (networked broker); gated by a future D1 guard category for a "tenant-operated isolated runner." **This is also the sanctioned subscription-on-cloud path** — a `tenant_hosted` dedicated execution target where the tenant runs their own subscription (see §14). See §13.

**None of the deferred items require reworking v1.** Each is an additive hardening on top of a seam v1 already establishes.

### Explicitly NOT supported (designed out — not deferred)
- **Per-tenant subscription-login on the *shared* cloud pool** — disabled by design in `cli-auth-topology.ts` (`providerSubscriptionCapability` → `enabled:false` for `trustBoundary:multi_tenant`) and by Anthropic's Consumer ToS (third parties may not route Pro/Max credentials on behalf of users; Feb 2026, server-side enforced). Shared-pool cloud auth = **API key** (U12); do not re-introduce a shared-pool subscription-capture path. The legitimate subscription-on-cloud path is the **`tenant_hosted` dedicated execution target (Scenario 2)** above. See §14.

## 3. Locked decisions (settled with the founder, 2026-08-05)

| # | Decision | Choice | One-line rationale |
|---|---|---|---|
| Q1 | **Statefulness** | **Hybrid** — ephemeral foundation + warm reuse; **default-by-type (warm for `software_development`) + per-agent override + instance default** | Most runs are short (ephemeral is right); only iterative coders benefit from warm — give a persistent "desk" only to those, à la Devin/Replit. Reuses the existing `reuseLease` / workspace-mode concept. |
| Q2 | **Egress** | **Allowlist provider hosts** (broker-proxy later) | Industry-default posture; not a cross-tenant control (data plane owns that), so the simple option is safe now. |
| Q3 | **Provider key** | **Resolve per-company key → inject into VM env** (broker-injected later) | How every provider CLI expects to authenticate; blast radius = that company's own key, destroyed at teardown. |
| Q4 | **Repo strategy** | **Host clones + uploads; host makes the PR** (broker-token later) | Reuses AoA's existing worktree + Create-PR infra; keeps `GITHUB_PAT` off the VM. Agent is fully dev-capable inside the VM; host does the final git push on its behalf. |
| — | **Managed vs self-hosted** | **Both** — ship the `domain`/`E2B_DOMAIN` config knob (unset = managed) | Verified: self-hosted is a ~10-line change across 3 SDK sites; the cost is infra, not code. No forced launch choice. |
| A | **stdio connectors in cloud** | **Allow inside the VM** (v1) | Cloud blocks stdio today because npx = RCE on *shared* infra; the per-run VM is exactly the containment that makes it safe. Unlocks the large stdio/npx MCP library (Notion local, etc.). Adds npm egress + package-pinning to v1. |
| B | **Plugins in cloud** | **Re-enable in v1** — descriptors exposed to sandboxed agents; `executeTool` routed through the broker to the **host-resident** worker (worker never enters the VM) | Plugins are hard-blocked in cloud today; re-enabling gives cloud tenants plugin parity. The worker's powers *are* the tenant DB, so it stays host-side. |
| C | **Cloud crew/agent auth** | **Require the company API key on cloud**; drop the operator `~/.claude` fallback on cloud (keep it on desktop) | The operator login is the platform's, not the tenant's, and must never enter a VM. **The API key is the only sanctioned *shared-pool* cloud path** — Anthropic prohibits routing subscription (Pro/Max) credentials through third-party services (§14); shared-pool cloud auth = tenant API key. (A `tenant_hosted` dedicated target may use a subscription — §14.) |

## 4. Architecture (the two planes)

- **Data plane (built, unchanged):** which rows an agent may touch. Enforced by `companyId` + a company-bound run-JWT (`createLocalAgentJwt`, verified `middleware/auth.ts:312`) + the broker filtering every query by the JWT's `companyId`. Cross-tenant isolation lives entirely here.
- **Execution plane (this PR):** *where* the untrusted CLI process runs. A per-run E2B microVM around the process, reaching the control plane only via the networked broker.

They are orthogonal. A compromised VM can, at worst, leak **its own company's** data + key (intra-company defense-in-depth) — never another tenant's, because the data plane scopes everything server-side regardless of the sandbox.

## 5. Component units

Each unit has one purpose and a defined touch-point. Files cited are current as of the 2026-08-05 audit.

| Unit | Purpose | Key interface / touch-point |
|---|---|---|
| **U1 — Operator-default E2B** | Populate the **platform** layer of the precedence stack so a run with no task/agent/company environment still resolves a sandbox on cloud | environment resolution order becomes `task > agent > company > **platform-default**` (`environment-run-orchestrator.ts`); platform default from operator config / a platform-owned environment |
| **U2 — Networked MCP broker** | **The core re-architecture.** Move **AoA-internal, DB-touching** tool access off the VM: sandbox → control-plane HTTP MCP (`mcp/server.ts:395`, `POST /companies/:cid/mcp`) authed by the run-JWT. Port the **full** internal registry with **identical gating** — not only the coordination/gating tools (`ask_human`, `submit_extracted_items`, `create_scope_draft`, Commander ⚡CONFIRM, the `use_skill` per-agent allowlist gate, connector-tool PreToolUse authz, plugin-tool dispatch) but the **DB-touching read/write families that are the bulk of runtime calls**: internal-agent **memory tools** (`query_memory`, `find_similar_memory`, `remember/update/forget_working_context`, `suggest_memory`, `update_memory`, `write_memory`, `detect_conflicts`, `propose_memory_from_thread`, `archive_stale_memory`, `extract*`) + outbound `memory.search/get/write/retain/suggest-memory` + the **tasks/goals/artifacts** read+write tools. **RBAC is per-agent-actor and NOT always "verbatim" (security):** `query_memory`/`memory.search` already gate (`filterQueryResults` / `actorForAgentRun`+`memoryAccessConditions`+`filterMemoryForActor` + `recordMemoryRetrievals` audit) — keep it. But **`find_similar_memory` + `detect_conflicts` return raw `searchSemantic`/`findSimilarItems` (companyId+status only, NO scope/private filter)** because they were board/Commander-only; exposing them to a sandboxed **agent** actor **requires ADDING `memoryAccessConditions`/`filterMemoryForActor`** (Decisions #118/#119) — porting verbatim would leak cross-scope/private memory. **Unported/unknown tool over the broker = explicit MCP error, never a silent no-op** (a superset-parity test guards the broker registry against the stdio registry — the §13 anti-drift rule). Pin per-call timeout + whether long/streaming DB tools are supported over HTTP. **External MCP connectors are NOT proxied** (HTTP connectors stay CLI-direct — see §14). | replaces the stdio + `DATABASE_URL` bridge (`internal-agent/mcp-bridge.ts:342`) for sandboxed runs; re-point the runtime hook (`heartbeat.ts:4844`/`:4893`, the `usesHttpHookBridge` block) from `127.0.0.1` to a routable URL; the `executionTarget` seam + `syncAdapterExecutionTargetDirectory` are the slot |
| **U3 — Crew run-JWT** | Prerequisite for U2 on crew — crew currently passes `authToken: undefined` (`runner.ts:975`), so it has no networked identity | mint `createLocalAgentJwt` for crew, matching org's mint at `heartbeat.ts:4276-4277` (consumed at `:4880`) |
| **U4 — Crew + Commander lease wiring** | Route crew (`runner.ts:445`, adapterConfig-only today) and Commander (`cwd: tmpdir()` at `cli-mode.ts:1151` claude + `:1560` codex/opencode) through `environmentRunOrchestrator.acquireForRun` like org agents. (The Commander history-compaction one-shot spawn is a *separate* host CLI — covered by **U13**.) | one shared **acquire-execution-context** helper: inputs `{run identity, functionType-or-null, warm-preference, worktree-or-none}` → outputs `{sandbox handle, env context, lease}`; it owns sandbox-acquire + warm-policy (U7) and delegates env-allowlist (U5) + stage-in (U6). Commander (no `functionType`) → ephemeral. Defined once so org/crew/Commander can't drift (§13) |
| **U5 — Env posture flip** | From inherit-minus-denylist to a **from-scratch allowlist**: only provider key + run-JWT + run-identity env enter the VM. **Audit finding: the scrub is opt-in today** — it fires only for connector runs and crew (`isolateAmbientConfig`); a default org/heartbeat run with no connectors, and both Commander spawns (`cliEnv = {...process.env}` at `cli-mode.ts:1146` claude + `:1555` codex/opencode), still inherit `DATABASE_URL` + the master key. So this must be a **hard allowlist for every VM run**. **`OPENAI_API_KEY` disambiguation (critical):** the company **embeddings** key (`llm:openai`) and a codex/openai-provider agent's Q3 auth key share the *same env name* — the allowlist must inject `OPENAI_API_KEY` **only** as the agent's resolved provider key, **never** the embeddings key (embedding runs host-side). Carry the existing strip logic (`runner-model-resolution.ts:30-34`) into the new builder; test: claude agent → no `OPENAI_API_KEY`; codex agent → only its own key. | `mergeChildEnv` (`packages/adapter-utils/src/server-utils.ts:392`) → new positive-allowlist builder gated on the sandbox target |
| **U6 — File movement + workspace capture** | **Org agents:** host clones the repo (PAT host-side) → upload working tree into the VM → `git diff` **inside the VM** → pull changed files out → **host commits/pushes/opens the PR**. **Second guard to reconcile (blocker):** all host-side workspace git flows through `assertLocalWorkspaceCommandAllowed`, which hardcodes `{type:"local"}` and **blanket-refuses on cloud** — U8 flips only the D1 *execution-target* guard, not this one. Add a distinct **"host-orchestration git"** sink (AoA-authored git on a host clone — *not* tenant-CLI-controlled) that the guard permits on cloud, keeping the tenant-command refusal intact. **Changed-file discovery** (`output-detection.ts:288`, called at `heartbeat.ts:5186`) must consume the **in-VM diff**, not the host mtime/git scan (else org `detectedFiles` silently zeroes). **Crew agents (A+ model, R1):** the **sandbox's own working dir IS the per-run workspace** — no host worktree (W3b); produce files in-VM → `task_outputs.detectedFiles`; **artifact versions still route through founder review-confirmation (Decision #67), not auto-minted**; structured deliverables come via broker artifact/memory tools (U2). **No crew PR in v1** (fast-follow). **Preview URLs** (R4): expose the in-VM dev-server via the sandbox port (E2B `getHost(port)`) → `task_outputs`. | E2B provider stages nothing today; touch-points: `sandbox-provider-runtime.ts`, `local-workspace-command-guard.ts`, `workspace-runtime.ts:528`, `github.ts:392`, `execution-workspaces.ts:149`, `output-detection.ts:288` |
| **U7 — Warm-reuse lifecycle** | Hybrid statefulness (§7). Pause (not kill) at run end; resume next run; **default-by-type + per-agent override + instance default**; idle reaper; **#884 workaround** | builds on the existing `reuseLease` flag + `workspaceMode` in the sandbox provider + `environment_leases` |
| **U8 — D1 guard flip** | Recognize a resolved E2B target as **genuine isolation** so the guard goes **refuse → sandbox** on cloud for all three run types | `unsandboxed-multitenant-guard.ts` + `cloud-environment-policy.ts:13-32` |
| **U9 — Self-hosted `domain` knob** | Thread `domain` / `E2B_DOMAIN` through the three SDK call sites so managed ↔ self-hosted is a config flip, not a rewrite | `sandbox-provider-runtime.ts:349` (connect), `:376` + `:409` (create); mirror the existing `apiKey` / `E2B_API_KEY` resolution |
| **U10 — Plugins in cloud** | Lift the cloud plugin-execution block **for the sandboxed-agent tool path**: expose plugin tool descriptors to sandboxed agents; route each `executeTool` call through the broker to the **host-resident** plugin worker (worker stays host-side — its powers are the tenant DB). Preserve all host-side authz (company-ownership, availability toggle, board/company access). | `cloud-plugin-execution.ts` (the block), `plugin-tool-dispatcher.ts` / `plugin-tool-registry.ts` (execute), broker route |
| **U11 — stdio connectors in-VM** | Relax the transport gate (`mcp-connector-transport-gate.ts`) so **stdio** connectors are admissible when the run target is a sandbox; keep the command-pinning check (`isStdioCommandSafe`); allow npm/npx + connector-host egress from the VM. HTTP connectors already work (CLI-direct + injected token). | transport gate + `buildConnectorSpecs`; egress allowlist (Q2) extended per-company |
| **U12 — Cloud crew/agent auth** | On cloud, **require a resolved company provider key** for crew/org/Commander runs; **drop the operator `~/.claude` provisioning** (`isolateAmbientConfig` copy, `execute.ts:456-481`) on the shared pool. Build the credential-injection seam so a **company-own** credential injects identically (API key on the shared pool; a subscription credential only on a `tenant_hosted` dedicated target — §14). Keep the operator-login path for `local_trusted`/desktop. | crew invoke block `runner.ts:968-976` (`isolateAmbientConfig` at `:969`) + the provider-credential ladder; fail-before-spend with "configure your provider key" guidance |
| **U13 — Host one-shot CLIs in a sandbox** | **Three** host-side one-shot provider-CLI families fail closed on cloud and are **not** agent runs (U1–U12 miss them): **(a) extraction** (`extractViaCli`, `extraction-cli.ts:127` — chokepoint for all four sinks: discussion/debrief-push/file-import/crew-memory-extract, **and** the crew-work-discovery path `create_scope_draft`→`extractThreadEntriesAwait`, `thread-agent-actions.ts:791`); **(b) Commander compaction** (`summarizeViaCli`, `cli-summarizer.ts:27`); **(c) readiness probes** (`adapter.testEnvironment` → agent-test `agents.ts`, Commander "Verify" `commander-verify.ts`, provider-key verify `providers.ts`) — all refuse on cloud today, **breaking the BYO-key onboarding we made launch-critical.** Route all three through a shared **"spawn a provider CLI in an ephemeral sandbox with the U12 company key"** helper. **The key seam is NEW:** `resolveCliExtractionContext` has *zero* provider-key injection today (auth = ambient host login); U13 must ADD U12 key resolution and **must NOT carry `extraction-cli.ts:251`'s `buildScrubbedCliEnv` KEEP-list** (`ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` = operator creds, §9). **Behaviors to pin:** one sandbox **per extraction batch/pass** (not per entry); sandbox-acquire **outside** the 180s extraction deadline (or raise it on cloud) so cloud doesn't regress; **budget-preflight before spawn + emit `cost_events`**; file-import stages the uploaded file **as a file** (not stdin); a sandbox/broker failure **preserves the entry-failed + founder-notification path** with a new `sandbox_unavailable` class + **cloud guidance copy (points at provider-key/config, not "install the CLI").** | shared ephemeral-sandbox CLI helper; `extraction-cli.ts:127/251`, `resolveCliExtractionContext`, `cli-summarizer.ts:27`, `testEnvironment` in `agents.ts`/`commander-verify.ts`/`providers.ts` |

## 6. Data flow — the run lifecycle (per run, on cloud)

```
1. DISPATCH (control-plane host)
   - resolve run's company + org
   - resolve per-COMPANY model-provider key (tenant BYO)      [Q3: to be injected into VM env]
   - mint per-RUN company-bound run-JWT (createLocalAgentJwt)  [U3 gives crew this]
   - budget preflight (preflightCrewDispatch) BEFORE any spend

2. ASSEMBLE CONTEXT (host — needs broad tenant-DB access)
   - persona bundle + task Why/What/How + bounded memory + history → finished prompt

3. RESOLVE ENVIRONMENT + ACQUIRE SANDBOX                       [U1 default, U4 for crew/commander]
   - precedence: task > agent > company > platform-default
   - warm policy (U7): if this agent is "warm" AND a live paused sandbox exists → RESUME (~15ms)
     else → CREATE fresh

4. STAGE IN (host → VM)                                        [U5 env, U6 files]
   - assembled prompt via stdin; persona/skills/mcp-config files
   - provider key in env (Q3); AOA_API_URL + run-JWT (the only control-plane credential in)
   - upload repo working tree INTO the VM (Q4)
   - env built from a positive allowlist (U5)
   ✗ NEVER: DATABASE_URL, secrets master key, GITHUB_PAT, operator ~/.claude

5. RUN the CLI (egress = ALLOWLIST: broker, model-provider API, git/npm)   [Q2]

6. LIVE TOOLS via BROKER                                       [U2]
   CLI --(MCP over allowlisted egress, auth = run-JWT)--> control-plane BROKER
   broker runs each tool against Postgres SCOPED to the JWT companyId
   (memory/tasks/goals/artifacts, ask_human, writes) — VM never touches the DB

7. CAPTURE OUTPUTS                                             [U6]
   git diff INSIDE the VM → pull changed files OUT → asset-storage / task_outputs
   host commits + pushes + opens the PR using the company PAT (host-side)

8. TEARDOWN                                                    [U7]
   if warm → PAUSE (snapshot), remember lease id on agent/workspace
   else     → DESTROY
   revoke/expire the run-JWT
```

Tenant boundary is enforced at **step 6** and holds regardless of steps 3–5,7.

**Memory reaches a run two ways** (don't conflate): bounded **pre-assembly host-side at step 2** (`crew-context-bundle` `loadScopedMemoryLines`, folded into the prompt, stays host-side) **and** on-demand **runtime tool calls at step 6** (`query_memory` / `memory.search` / `write_memory` / …) — only the latter is what U2 brokers. **The E2B exec adapter must return the CLI's stdout + token-usage to the host** so cost events (`computeCostCents`) and run-summary token/cost fields stay populated for VM runs (otherwise cost tracking silently zeroes). The embedding worker stays **host-side** (an HTTP call via `createOpenAiEmbedder`, not a VM CLI) — do not sandbox it.

## 7. Statefulness policy (the warm-reuse detail)

**Concept:** ephemeral = a fresh rental laptop each run (clean, but re-clones + re-installs every time). Warm = the agent keeps its own desk; the laptop is **paused (snapshotted)** when idle and **resumed in ~15ms** with repo + deps + caches intact — the Devin/Replit "teammate at their desk" feel. Hybrid = give a persistent desk only to agents that benefit.

**When does an agent get a warm sandbox?**
- **Default by type:** warm ON for **org `software_development` agents**; ephemeral for everyone else. **Crew (`kind='aoa'`) is always ephemeral, never warm — regardless of `functionType`**: the A+ decision makes the crew sandbox a *per-run* workspace, so a persisted crew sandbox would contradict it (a crew agent needing warm iterative coding is modeled as an org agent). Commander (no `functionType`) is ephemeral.
- **Per-agent override (org agents only):** a "keep workspace warm between runs" setting overrides the type default for **org** agents either way; it **cannot** make a crew agent warm in v1 (crew is always ephemeral — see above; warm crew is a named fast-follow).
- **Instance default:** an operator-level baseline.

This reuses AoA's existing per-task workspace-preference shape (`shared / isolated / reuse_existing`) rather than introducing a new concept.

**Mechanics:** at run end, `pause()` the sandbox (E2B snapshots fs + memory) instead of `kill()`; store the lease/sandbox id; next run for that agent → `resume()` instead of `create()`. An **idle reaper** destroys any sandbox paused longer than a TTL (**default ≈30 min**, instance-configurable, per-agent-overridable) to cap cost. **A per-company cap on live+paused sandboxes** (related to the D5 `HEARTBEAT_MAX_CONCURRENT_RUNS` clamp) bounds accumulation; acquiring past the cap **evicts the oldest paused sandbox** (never blocks a run).

**E2B #884 workaround (mandatory):** persistence breaks after *repeated* pause/resume cycles. The lifecycle **pauses once per agent turn** (at run end only), never repeatedly mid-run. If a resume finds a dead/GC'd sandbox, **fall back to create-fresh transparently** — never error the run.

**OAuth connector tokens vs warm reuse (#317):** an injected `AOA_MCP_*_TOKEN` is a *point-in-time* OAuth access token with a bounded TTL. So the host **re-resolves + re-injects** the connector token into VM env at **every** stage-in — **including on warm `resume()`**; a paused sandbox's stale env token is never trusted as current. Known limitation: a token that expires **mid-run** cannot be refreshed from inside the VM (refresh needs the DB + signing/master keys, none of which enter the VM) — that connector degrades until the next run. Broker-proxying OAuth connectors (the deferred §14/U2 hardening) is the eventual per-call fix.

## 8. Error handling

| Failure | Behavior |
|---|---|
| Sandbox acquire fails | Run fails cleanly with an actionable error. **No silent local fallback** — the D1 guard forbids unsandboxed execution on cloud. |
| Broker unreachable / tool call fails | Error surfaces to the agent; run marked failed. |
| Warm resume finds a dead/GC'd sandbox | **Transparent create-fresh** — never error the run. |
| File movement fails (clone/upload/diff/pull) | Run fails with the failing stage named. |
| Provider-key resolution fails | Fail **before** sandbox spend with "configure your provider key" guidance. |
| Over budget | `preflightCrewDispatch` blocks **before** any sandbox spend (extend the preflight to U13 one-shot spawns too). |

**Founder-facing surface (per run type).** The internal outcomes above map to what the founder *sees*, and it differs by run type: **org** → run-summary task comment; **crew** → `postCrewFailureCard` + summary into the originating thread (W3a); **Commander** → SSE error; **U13 extraction** → discussion entry marked failed + `notifications`. **Partial failure:** a U6 run that produced files but failed at capture/push must **preserve + show the partial outputs**, not discard them. **Silent-degrade guard:** Commander **compaction** failure (R3) has no surface today — it must raise a founder notification, else it degrades invisibly into context overflow.

## 9. Security invariants (assert in code + tests)

- **Credential taxonomy (the definitive rule, from the 2026-08-05 audit):**
  - **NEVER enters the VM** (infra/operator secrets): `DATABASE_URL` / `DIRECT_DATABASE_URL`, the secrets **master key**, `GITHUB_PAT`, `BETTER_AUTH_SECRET` / `AOA_AGENT_JWT_SECRET`, `REDIS_URL`, the embeddings key, the **operator `~/.claude`** login, **and its env-var forms** `CLAUDE_CODE_OAUTH_TOKEN` + any host-ambient `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` that is **not** the tenant company's own resolved key (the extraction path's `buildScrubbedCliEnv` KEEP-list carries exactly these — U13 must drop it). (U5 allowlist + a test asserting their absence, incl. the subscription-OAuth token.)
  - **MAY be injected into the VM** (a company's **own** runtime credentials — blast radius = that company): its model-provider **API key** (Q3), its **connector tokens** (`AOA_MCP_*_TOKEN`), and the per-run **run-JWT** (`AOA_API_KEY`). Signing secrets that *mint* these stay host-side; only the minted value crosses in. **For an OAuth connector (#317) this is the resolved short-lived ACCESS token only** — the OAuth *refresh* token, the signed bundle (`mcp:oauth:<id>` company secret), the bundle-signing key (`BETTER_AUTH_SECRET`/`AOA_AGENT_JWT_SECRET`), and the master key that decode/mint it are all host-side-only (already in the never-in-VM set); OAuth resolution + refresh runs host-side at stage-in and only the minted bearer crosses (test: the refresh token / signed-bundle string is absent from VM env). *(A subscription credential is deliberately NOT in this list — provider policy forbids subscription creds on the shared pool; see §14.)*
  - **MUST route through the broker** (AoA-internal, DB-touching): the `aoa` tool bridge, `use_skill` gating, plugin-tool dispatch, connector-tool PreToolUse authz, the runtime-permission hook.
  - **Staged in as files:** persona/instructions, skill bundles (via the existing remote-dir sync; the managed marketplace-skills root with its cross-company siblings is **never** mounted), stdin prompt.
- **Cross-tenant isolation = data plane, unchanged.** No unit here weakens or is relied upon for it.
- **Blast radius of a compromised VM** = that one company's own data + own provider key. Intra-company defense-in-depth, not a tenant breach.
- **BYO override key** stays an encrypted company secret / environment config; on cloud any override must still resolve to a genuinely isolated sandbox (D1 guard).

## 10. Testing strategy

- **Unit:** precedence resolution (`task > agent > company > platform`); env allowlist (asserts the never-in-VM set is **absent**, incl. the OAuth refresh token / signed bundle; and `OPENAI_API_KEY` present only as a codex agent's own key, never the embeddings key); warm policy (default-by-type + override + instance default); `domain` threading (managed vs self-hosted); resume-finds-dead-sandbox → create-fresh; OAuth token re-resolved on warm resume.
- **Integration (real embedded-PG):** broker authenticates a crew and a Commander run-JWT and scopes queries to `companyId`, incl. the **memory/tasks/goals/artifacts** read+write tools with RBAC preserved; crew + Commander resolve an E2B target on cloud; **U13 extraction-in-sandbox produces items on cloud** (discussion→scope-draft no longer fails closed); crew capture → artifacts + `task_outputs`; the D1 guard flips refuse → sandbox once a real target resolves.
- **CI reality:** no live E2B in CI. Introduce a **fake/mock sandbox provider at the `importE2b` seam** (mirroring the existing `AOA_E2E_FAKE_EMBEDDER` pattern) so the full path — acquire, stage-in, broker round-trip, capture, teardown/pause — is exercised without a real VM. Live-E2B validation is manual / staging (documented, not silently skipped).

## 11. Build order (all one PR, staged internally)

1. **U9 + U1** — config seam (`domain` knob) + platform-default resolution (foundation, no behavior change until wired).
2. **U2 + U3** — networked broker + crew run-JWT (the core; crew gets a networked identity).
3. **U4 + U5 + U12** — crew + Commander lease wiring + env-posture flip + cloud auth (coverage; require the company key before any VM run).
4. **U13** — host one-shot CLIs (extraction + Commander compaction + provider-key readiness probes) in an ephemeral sandbox (reuses the U4/U5/U12 seam) — unblocks discussion→task on cloud, keeps Commander from overflowing, and restores BYO-key verify.
5. **U6** — file movement + workspace capture (org stage-in/diff/PR; crew in-sandbox workspace → artifacts/`task_outputs`, no crew PR).
6. **U11** — stdio connectors admissible in-VM (connector coverage on top of the working sandbox).
7. **U10** — plugins re-enabled in cloud via the broker → host worker.
8. **U7** — warm-reuse layer on top of the ephemeral foundation (`reuseLease`).
9. **U8** — flip the D1 guard **last**, once the sandbox path is real for all run types.

Ephemeral is built first; warm is a layer on top — so "warm in v1" still lands on a safe, tested foundation. **Recommended carve-out if review size bites:** land the core sandbox (U1–U9, U12, U13) first, then **U10 (plugins) + U11 (stdio)** as a fast-follow — they sit on top of the working sandbox and don't block it.

## 12. Open risks / notes

- **Managed-E2B egress is not fully lockable.** On managed E2B, sandboxes get fairly open egress; the "allowlist" (Q2) may be closer to open in practice there. Acceptable given the blast-radius reframe (§9); a real driver for the self-hosted path for egress-strict customers.
- **The broker tool-registry port (U2) is the largest single surface** — it must preserve every gating rule the stdio bridge enforces today (per-agent skill allowlist fail-closed, Commander runtime-approval policy applying only to `actorType:"commander"`, `ask_human` requiring a live task run). Parity here is the top review focus.
- **Warm reuse depends on a known-buggy E2B path (#884).** The once-per-turn pause rule + create-fresh fallback (§7) are the mitigations; they must be enforced by the lifecycle, not left to callers.
- **stdio connectors run npx-fetched code in the VM (U11).** Contained to the company's own sandbox (blast radius = that company), but it's a per-company supply-chain vector — keep `isStdioCommandSafe` pinning + scope npm egress; document that arbitrary npx fetch is permitted only inside the sandbox.
- **v1 is large.** 13 units (incl. U13 extraction/compaction/readiness-probes + the A+ crew workspace) make this a big PR; the build order stages it. **Recommended carve-out if review size bites:** land the core sandbox (U1–U9, U12, U13) first, then **U10 (plugins) + U11 (stdio)** as a fast-follow — they sit on the working sandbox and don't block it.
- **Cloud subscription-login is prohibited by provider policy — designed out, not deferred.** Anthropic does not permit third parties to route Pro/Max subscription credentials on behalf of users (Consumer ToS, Feb 2026, server-side enforced, account-disablement risk). Shared-pool cloud auth is API-key-only (U12); subscriptions run only on desktop or a `tenant_hosted` dedicated target (§14). Do not re-introduce a *shared-pool* subscription-capture path. See §14.

---

## 13. Deployment-mode interaction (desktop / `local_trusted`)

**The desktop version is unaffected, and the 2026-08-05 audit confirmed every credential/tool path is unchanged on `local_trusted`.** Desktop runs agents on the host via the local CLI; there is no tenant isolation, the D1 guard is a no-op, and E2B is not forced. Both **subscription login and API key** work on desktop today, unchanged.

**The rule that keeps it that way — sandbox-scope every unit.** None of U1–U13 may become a *global* replacement; each is conditioned on "is this run targeting a sandbox?"

| Unit | Desktop keeps | Rule |
|---|---|---|
| U2 broker | the stdio + `DATABASE_URL` bridge (own DB, own machine) | broker is an **additional** transport for sandboxed runs, not a replacement |
| U5 env allowlist | full host env (PATH, tools, `~/.claude`) | from-scratch allowlist applies **inside the sandbox only** |
| U6 file movement | agents work directly on the real worktree | clone-upload-into-VM is **sandbox-only** |
| U7 warm reuse | local worktree already persists | pause/resume is a VM concept; moot on desktop |
| U10/U11/U12 | plugins / stdio / operator-login all work locally | the cloud-only changes gate on `tenantIsolationEnforced()` |

**Shared-registry rule:** U2 must **share the tool implementations** between the stdio bridge (desktop) and the HTTP broker (cloud) — only the transport differs. Reimplementing tool logic twice would let desktop and cloud drift; a review checkpoint.

**Scenario 2 — tenant-operated local runner (future).** The roadmap goal: cloud control plane, execution on the tenant's own machine via local CLI, data via the same broker, tasks/state synced both ways so multiple users in one tenant work whether on the cloud sandbox or their laptop. Three cheap v1 hooks keep the door open (no v1 build):
1. **Broker (U2) must not assume co-location** — auth by run-JWT over HTTPS, never "trust because localhost/same-VPC."
2. **D1 guard (U8) shape must be extensible** — a future "tenant-operated isolated runner" is a distinct *allowed* target category, not a hard "all local = refused."
3. **The execution-context seam must hold a third type** — `local host` / `sandbox` / **`remote tenant runner`** side by side.

## 14. Connectors, plugins, skills & the injection taxonomy (grounded 2026-08-05)

The 4-way audit of how connectors/plugins/skills/credentials reach an agent run today (34 findings, all file:line-grounded) produced the classification the plan must honor.

**Connectors split cleanly by transport:**
- **HTTP connectors (static-secret)** → the CLI opens the MCP connection to the third-party `url` **directly**; AoA is not in the path. Treatment: **inject the company's own token** (`AOA_MCP_*_TOKEN` — real value in env, `${PLACEHOLDER}` in the config file, already the pattern) and **allowlist-egress the connector's host**. **Not** broker-proxied (it never touches the tenant DB). Broker-proxying connectors is the deferred hardening.
- **OAuth connectors (#317, e.g. `notion-hosted`)** → also HTTP transport (CLI → provider `url` directly, `Authorization: Bearer ${AOA_MCP_*_TOKEN}`), so at the delivery surface the resolved bearer is injected into VM env **identically** to a static-secret HTTP connector + host allowlist-egressed. **The difference:** the token is a short-lived, refreshable, **host-minted** OAuth access token — resolution + refresh (`resolveConnectorToken` → `coordinateOAuthRefresh`, `mcp-connector-token-refresh.ts`) need the DB (`mcp_connector_oauth_refresh_leases`), the master key, and the bundle-signing key, so they **stay host-side**; the VM receives only the minted access token, never the signed bundle / refresh token / refresh path (§9). Re-resolved + re-injected at **every** stage-in incl. warm resume (§7).
- **stdio connectors** → the CLI spawns a local command (e.g. `npx …`). Blocked in cloud today (RCE on shared infra); **U11 admits them inside the sandbox** (the VM is the containment) with `isStdioCommandSafe` pinning + npm egress.
- **Internal `aoa` tools** (which today share the same `--mcp-config` file as connectors, and carry `DATABASE_URL`) → **broker** (U2).

**Plugins:** the worker is a **host** child-process (`fork`), and its capabilities *are* the tenant DB (`buildHostServices`) — so it **stays host-side** and is already DB-isolated (minimal env, host-side company-ownership checks). Cloud hard-blocks it today. **U10** re-enables the *agent tool path*: descriptors exposed to the sandboxed agent, `executeTool` routed through the broker to the host worker; all host-side authz preserved. The worker never enters the VM.

**Skills:** `use_skill` is an MCP tool → its **per-agent `skillKeys` gate (D7/D8 fail-closed)** is enforced by the **broker** (it reads the tenant DB for the agent identity). Skill **files** are **staged into the VM** via the existing remote-dir sync (`syncAdapterExecutionTargetDirectory`); built-in AoA skills can be baked into the sandbox template; the **managed marketplace-skills root is never mounted** (cross-company siblings on disk).

**Auth model (resolves the cloud/local/subscription question):**

| | Their own API key | Their own subscription login | Operator's login |
|---|---|---|---|
| **Local / desktop** (`user_hosted`) | ✓ | ✓ (their `~/.claude`, own machine, official CLI) | = same person, fine |
| **Cloud — dedicated target** (`tenant_hosted`, Scenario 2) | ✓ | ✓ operator-enabled (tenant's own execution target) | ✗ |
| **Cloud — shared pool** (`aoa_hosted`) | ✓ required (U12) | ✗ disabled by `cli-auth-topology` (multi-tenant) + Anthropic policy | ✗ forbidden — never in a VM |

**Why subscription-login is not offered on cloud (grounded 2026-08-05):** Anthropic's Claude Code policy states OAuth (subscription) auth is *"intended exclusively"* for native Anthropic apps and that they *"do not permit third-party developers to ... route requests through Free, Pro, or Max plan credentials on behalf of their users."* As of Feb 2026 using subscription OAuth in third-party tools is a **Consumer ToS violation**, enforced server-side (account disablement without notice); the Claude Agent SDK supports **API keys only**. Capturing a tenant's subscription to run on AoA cloud infra would risk the tenant's Claude account — a comparable agent runtime (OpenClaw's Hermes) declined it for the same reason. **The sanctioned cloud path is the API key.** Subscriptions remain a **desktop** capability (user's own machine + own login driving the official CLI — the most defensible case, and pre-existing).

**Onboarding-mode implication — already governed by `cli-auth-topology.ts` (grounded 2026-08-05; corrects an earlier draft that wrongly called this "structural / single host credential").** The provider sign-in ("login through URL", `commander-login.ts`) is **already company-scoped** and writes to a **per-(company, user, execution-target) auth home** (`resolveScopedCliAuthHome` → `.aoa/execution-targets/<target>/auth/<company>/<user>/<provider>`) — it is *not* a single shared host credential. What gates it is the **CLI auth topology**, keyed on **execution ownership**:
- `user_hosted` (desktop) → subscription **enabled** + API key. **Unchanged** by this project.
- `tenant_hosted` (a **dedicated execution target** / Scenario 2) → subscription **enabled** (operator-flag) + API key.
- `aoa_hosted` (shared cloud pool) → subscription **disabled** — `providerSubscriptionCapability` returns `enabled:false` for `trustBoundary:multi_tenant` (message: *"Use a company API key or a dedicated execution target"*), and `onCredentialEvidence` fail-closes. API key required.

So this project does **not build** the "no subscription on the shared pool" gate — it already exists. U12's job is narrower: ensure the sandbox run path on `aoa_hosted` resolves the **company API key** (never the operator login). **And the sanctioned way to use a subscription "on cloud" is the `tenant_hosted` dedicated execution target = Scenario 2** — the auth home is already keyed by `executionTargetId`, so it is architecturally anticipated. (The Anthropic ToS point still applies to the *shared* pool; the dedicated/tenant-hosted target is the tenant running their own subscription on their own execution target — the defensible case, same trust class as desktop.)

---

## 15. Open items surfaced by the latest-main review (2026-08-06) — RESOLVED

A 4-agent review of this spec against **latest `main`** (#316 + #317 OAuth broker + #318 memory) confirmed the code refs (line-drift fixes folded in above) and surfaced these (IDs `R1–R4`, to avoid colliding with the "D1 guard"). **All four resolved with the founder 2026-08-06** (rationale kept below): **R1 → A+** (crew gets an in-sandbox workspace + artifact/`task_output` capture; the sandbox *is* the per-run workspace, so **no host-side W3b worktree**; **no crew PR** in v1); **R2 → A** (new **U13**); **R3 → A** (compaction folded into U13); **R4 → A** (expose sandbox port). Crew PRs + host worktrees, and a warm sandbox **pool** for high-volume background crew, are named fast-follows.

**R1 — Crew workspace (W3b): how does crew capture files without a per-run worktree?** *(was a blocker)*
Crew has no `execution_workspaces` worktree — `resolveCrewExecutionWorkspace` (`crew-workspace.ts:85-97,192-199`) returns the shared `project_primary` checkout, no PR path, `detectedFiles=[]`. U6's clone→diff→PR story is written against the *org/heartbeat* worktree.
- **(A+, chosen)** the sandbox *is* the per-run workspace: produce files in-VM → capture to `task_outputs` (artifacts still via founder review, Decision #67); **no host-side W3b worktree, no crew PR** in v1 (both fast-follows).
- **(B)** Build a real per-run crew workspace (the deferred "W3b") + crew PRs as part of this PR — larger.

**R2 — Extraction CLI is cloud-dead: fix in v1 or defer?** *(was a blocker)*
`extractViaCli` (`extraction-cli.ts:127`) throws on `tenantIsolationEnforced()` — the chokepoint for **all four** extraction sinks (discussion / debrief-push / file-import / crew memory-extract) **and** on the crew-work-discovery path (`create_scope_draft` → `extractThreadEntriesAwait`, `thread-agent-actions.ts:791`). So after this PR, agent *runs* work on cloud but **a cloud founder still can't turn a discussion into a task at all** — a core workflow stays broken.
- **(A, chosen)** Add **U13**: run the extraction one-shot CLI inside an **ephemeral** E2B sandbox reusing the U1/U4/U5/U12 seam + the company key — so discussion→extract→scope-draft→crew-dispatch works on cloud.
- **(B)** Defer — cloud founders can't extract tasks from discussions until a follow-up (cloud is half-usable at launch).

**R3 — Commander history-compaction spawn (`cli-summarizer.ts:27`) is a second cloud-dead CLI.** *(was should-fix)*
U4 sandboxes the main Commander run, but compaction is a separate host spawn that fails closed on cloud → long Commander conversations never compact → `summarizedContext` stalls → context overflow.
- **(A, chosen)** Fold into **U13** — route the summarizer through the shared ephemeral-sandbox + company-key helper (small).
- **(B)** Cap Commander conversation length on cloud (cheaper, worse UX).

**R4 — In-VM runtime services / preview URLs.** *(was should-fix)*
Warm `software_development` agents start dev servers; the host loopback path fails closed on cloud (`local-workspace-command-guard`). U6 captures files but not live ports.
- **(A, chosen)** Expose the sandbox port as a preview URL (E2B `getHost(port)`) and record it in `task_outputs`.
- **(B)** Defer — preview-URL `task_outputs` are org/desktop-only in v1.

**Accepted (A+/A/A/A).** Scope delta: **+U13** (extraction + compaction + readiness probes in a sandbox) and the **A+ crew workspace** model folded into U6 — reflected in §2 / §5 / §11 above. This tips the §12 size call toward carving **U10/U11 into a fast-follow** to keep the core PR reviewable.

---

## Appendix — relationship to prior work

- Builds directly on the merged multi-tenant data plane (PR #316) and its D1 guard, which was authored as the explicit placeholder for exactly this sandbox work.
- The companion reference doc holds the audited code map; this spec holds the build decisions. Keep both in sync if the code drifts.
