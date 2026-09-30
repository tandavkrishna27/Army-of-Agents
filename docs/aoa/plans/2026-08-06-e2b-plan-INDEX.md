# E2B Cloud Execution Isolation — Implementation Plan (INDEX)

> **For agentic workers:** REQUIRED SUB-SKILL — execute each wave with `superpowers:subagent-driven-development`. **Recommended first step for the executing session:** run `superpowers:plan-review` (or a code-reviewer pass) over Wave 1 before coding — the broker is the highest-risk surface.

**Written:** 2026-08-06. **Worktree/branch:** `C:/Users/TK/.aoa/wt/e2b-exec` on `feat/cloud-execution-isolation-e2b` (off latest `main` = #316 + #317 + #318). **Spec (authoritative):** [`2026-08-05-cloud-execution-isolation-e2b-spec.md`](./2026-08-05-cloud-execution-isolation-e2b-spec.md) · **Reference (code map):** [`2026-08-02-execution-isolation-e2b-REFERENCE.md`](./2026-08-02-execution-isolation-e2b-REFERENCE.md).

**Goal:** Make **all three agent-run types — org (heartbeat), crew (`kind='aoa'`), Commander — execute inside a per-run E2B sandbox on `cloud_auth`**, reaching the control plane only through a **networked broker** (run-JWT auth; no DB creds or long-lived secrets in the VM), with hybrid statefulness and managed + self-hosted E2B behind one config seam.

**Architecture:** Two orthogonal planes — **DATA** (companyId + company-bound run-JWT + broker scoping, *already built* by #316) and **EXECUTION** (the E2B sandbox, *this plan*). Cross-tenant isolation is owned by the data plane and unchanged. 13 units (U1–U13), built in dependency order across 8 waves.

**Tech stack:** TypeScript (server `server/src/`), Drizzle ORM (`packages/db/src/schema/`), Vitest, E2B SDK (`e2b`), the existing `environment_leases` / `environmentRunOrchestrator` / `sandbox-provider-runtime` seam.

---

## Status (as of 2026-08-06)

| Stage | State |
|---|---|
| **Spec** (design) | ✅ **Complete** — 5 review rounds, all blockers fixed |
| **Implementation plan** (these docs) | ✅ **Complete** — 8 waves, TDD, grounded in code |
| **Implementation** (code) | ⬜ **Not started** — ready to hand to a fresh session |

**Per-wave build tracker** — the executing session ticks each box as it lands a wave:

| Wave | Units | Spec | Plan | Built | Merged |
|---|---|:--:|:--:|:--:|:--:|
| W0 Foundation | U9, U1 | ✅ | ✅ | ✅ | ⬜ |
| W1 Broker + crew JWT | U2, U3 | ✅ | ✅ | ⬜ | ⬜ |
| W2 Coverage + auth | U4, U5, U12 | ✅ | ✅ | ⬜ | ⬜ |
| W3 One-shot CLIs | U13 | ✅ | ✅ | ⬜ | ⬜ |
| W4 Files | U6 | ✅ | ✅ | ⬜ | ⬜ |
| W5 Connectors + plugins | U11, U10 | ✅ | ✅ | ⬜ | ⬜ |
| W6 Warm | U7 | ✅ | ✅ | ⬜ | ⬜ |
| W7 Guard flip | U8 | ✅ | ✅ | ⬜ | ⬜ |
| W8 Staging validation (live gate) | — | ✅ | ✅ | ⬜ run | — |

**Test coverage in the plan:** unit (TDD, every task) ✅ · integration (real embedded-PG, 38 refs) ✅ · full sandbox path via a **fake provider** at the `importE2b` seam (no real VM needed for CI) ✅ · browser E2E for UI-facing pieces (Wave 8 D) ✅ · **real-E2B + live user-flow verification (Wave 8)** ⬜ = the manual staging gate (real microVMs can't run in CI, and the path is `cloud_auth`-only, so this can't be automated — it's a scripted live pass). Wave 8 is the definition-of-done for "cloud actually works."

> **Nothing is implemented yet** — spec + plan are done; code has not started. No content has been removed from the spec at any point; it has only grown.

---

## Waves (execute in order; U8 / guard-flip is LAST)

| Wave | File | Units | What it does | PR-cut? |
|---|---|---|---|---|
| **0** | [wave0-foundation](./2026-08-06-e2b-plan-wave0-foundation.md) | U9, U1 | Self-hosted `domain` knob + platform-default E2B resolution. **Inert** (no caller reaches it yet). | ✅ can land alone |
| **1** | [wave1-broker](./2026-08-06-e2b-plan-wave1-broker.md) | U2, U3 | **The core:** networked MCP broker (DB-touching tools off the VM, agent-actor RBAC, fail-closed) + crew run-JWT. | Land with W2 |
| **2** | [wave2-coverage-auth](./2026-08-06-e2b-plan-wave2-coverage-auth.md) | U4, U5, U12 | Shared acquire-execution-context helper (crew + Commander onto the lease path) + env from-scratch allowlist + cloud company-key auth. | — |
| **3** | [wave3-oneshot-clis](./2026-08-06-e2b-plan-wave3-oneshot-clis.md) | U13 | Extraction + Commander-compaction + provider-key readiness probes in an ephemeral sandbox (unblocks discussion→task on cloud). | — |
| **4** | [wave4-files](./2026-08-06-e2b-plan-wave4-files.md) | U6 | File movement + workspace capture; reconcile the second `assertLocalWorkspaceCommandAllowed` guard; crew A+ capture. | — |
| **5** | [wave5-connectors-plugins](./2026-08-06-e2b-plan-wave5-connectors-plugins.md) | U11, U10 | stdio connectors in-VM + plugins re-enabled (broker → host worker). | ✅ **recommended carve-out to a fast-follow PR** |
| **6** | [wave6-warm](./2026-08-06-e2b-plan-wave6-warm.md) | U7 | Warm-reuse lifecycle (crew always ephemeral; reaper + cap; #884 workaround). | ✅ fast-follow candidate |
| **7** | [wave7-guard-flip](./2026-08-06-e2b-plan-wave7-guard-flip.md) | U8 | Flip the D1 guard refuse→sandbox on cloud — **done last**, once the path is real. | Lands with the core |
| **8** | [wave8-staging-validation](./2026-08-06-e2b-plan-wave8-staging-validation.md) | — (validation) | **Live ship gate:** real-E2B staging + 13 user-flow checks + live never-in-VM/cross-tenant proofs + browser E2E + desktop-regression. Runs *after* 0–7 build green. | Not a PR — the ship gate |

**Suggested PR sequencing:** **PR-1** = W0 (inert foundation). **PR-2 (the core)** = W1+W2+W3+W4+W7 — this is "cloud is genuinely usable" (all agents run isolated, discussion→task works, files captured, BYO-key auth, guard flipped). **PR-3 (fast-follow)** = W5+W6 (connectors/plugins/warm). Adjust to taste; the waves are independently testable.

## Shared seams — canonical cross-wave contracts (READ FIRST)

The waves were authored in parallel; these are the ONE canonical shape for each seam multiple waves share. Do **not** invent variants — the 2026-08-06 eng-review found the waves had drifted here.

- **S1 — Platform-default environment resolution.** `acquireExecutionContext` (U4) passes `environmentId: input.environmentId ?? null` **straight** into `environmentRunOrchestrator.acquireForRun`. The platform default is resolved **inside** the orchestrator's null-branch: `resolveEnvironment` (`environment-run-orchestrator.ts`) so `environmentId == null` → `ensurePlatformDefaultEnvironmentRow(db, companyId, deploymentMode, env)` (returns `Environment | null`, in `platform-default-environment.ts`); non-null ⇒ synthesize the lease/target from it; null ⇒ throw as today (non-cloud / no key). **No `resolvePlatformDefaultEnvironmentId`, no sentinel id passed by callers.**
  - **U1b amendment (2026-08-07):** the original S1 contract (pinned above by U1/U4) said the platform default was purely **synthetic**, with no persisted id (`resolvePlatformDefaultEnvironment` returning `id: "platform-default-e2b"` directly). That was a foundational gap: `environment_leases.environment_id` is a **NOT NULL FK to `environments.id`** (a Postgres `uuid` PK), and `environmentService(db).acquireLease()` does a real row lookup that throws `"Environment not found for company"` when no row exists — so a real cloud lease against the synthetic sentinel could **never** succeed (U4's integration test only passed by faking the `environments` DB layer for that path — see its GROUNDING NOTE). Fixed by **lazily MATERIALIZING** the platform default as a real per-company `environments` row: `ensurePlatformDefaultEnvironmentRow` derives a **deterministic uuid** from `companyId` (RFC 4122 UUIDv5, self-implemented in `platform-default-environment.ts` — no `uuid` npm dependency) and idempotently inserts it (`onConflictDoNothing` on the PK, no migration, no new unique constraint — the PK itself is the dedup key). `resolvePlatformDefaultEnvironment` remains the pure **template builder** (config/driver/name, still returns the cosmetic `"platform-default-e2b"` id and never touches the db) that `ensurePlatformDefaultEnvironmentRow` wraps; the operator's `E2B_API_KEY` still never lands in the persisted row's config (resolved from env at acquire time, unchanged). Proof: `server/src/__tests__/platform-default-environment-materialization.integration.test.ts`.
- **S2 — `buildSandboxEnvAllowlist`.** Signature `buildSandboxEnvAllowlist(overlay: Record<string,string>, opts: { provider: string }): Record<string,string>`, in `packages/adapter-utils/src/sandbox-env-allowlist.ts` (exported from the package index). It **filters** `overlay` to the allowlist (the agent's own provider key for `opts.provider`, run-JWT, `AOA_*` run identity) and drops the never-in-VM set. Callers **build the overlay first** (`{ [cred.envName]: cred.value, AOA_API_URL, AOA_RUN_ID, … }`) then call it — the builder does **not** inject the credential itself.
- **S3 — Company provider-key resolver (one-shot CLIs).** `resolveCompanyProviderCredential(db, companyId, { cliTool }): Promise<{ envName, value, provider, model }>`, built in **U13 (task U13.0)** as a thin adapter over the existing `resolveProviderCredential` (`provider-resolution.ts:307`) — pull the provider env var + value from its `envPatch` + the resolved model. On cloud with no company key it throws `ProviderUnavailableError` (mapped to `sandbox_unavailable` guidance). **U12 builds the catch-mapper `mapCloudProviderKeyError(err, …)` + `CloudProviderKeyMissingError`** (it wraps the `ProviderUnavailableError` the existing `resolveProviderCredential` already throws on cloud). **There is NO `assertCloudProviderKeyResolved`** — an assert-on-returned-credential gate is dead code on cloud (the resolver throws, never returns `host_login_fallback`); no wave may reference that symbol.
- **S6 — One-shot / lease exec shape.** `acquisition.lease` is an `EnvironmentLease` (`environment-runtime.ts`): fields are `provider`, `providerLeaseId`, `metadata` — **NOT** `providerKey`/`leaseMetadata`. A one-shot exec resolves the provider `config` via `resolveRuntimeProviderConfig(...)` and reads `leaseMetadata = readObject(lease.metadata).providerMetadata`, exactly as `executeRunLeaseCommand` (`environment-runtime.ts:512-540`) does — do **not** call `sandboxProviderRuntime().execute(...)` with a hand-built shape and no `config` (it throws "require an API key"). Prefer routing one-shot exec through the runtime/orchestrator. Fakes mirror the `EnvironmentLease` shape.
- **S7 — `brokered` activation (not just declaration).** U2d adds `brokered?` to `buildMcpConfig` (default false). **U4 (W2) must actually SET it:** at the real sandbox call sites (`heartbeat-mcp.ts:131` org, `runner.ts:435` crew, `cli-mode.ts:514/610` Commander) the sandbox is **acquired BEFORE `buildMcpConfig`**, and `brokered = acquisition.environment.driver === "sandbox"` + `apiBaseUrl` + `companyId` are passed in. This also covers the **codex/opencode path** that consumes `buildMcpBridgeSpec` directly — U2d only re-points claude's `aoa` entry, so the bridge-spec `DATABASE_URL` still leaks for non-claude adapters unless the HTTP treatment is applied there too. An integration test must assert a *non-test-forced* sandbox dispatch produces an HTTP `aoa` entry with **no `DATABASE_URL`**.
- **S4 — Egress allowlist.** The sandbox provider `create`/`resume` takes an optional `egressAllowlist?: string[]` (recorded in lease metadata; enforced where the provider supports it — E2B network config / self-hosted firewall; **best-effort on managed E2B** per §12). **U6 (W4) introduces the parameter + threads it;** U11 (W5) unions connector hosts + npm into it. A threaded param, not a hard guarantee on managed E2B.
- **S5 — Acquisition-result driver.** Read `acquisition.environment.driver === "sandbox"` (or `isProviderSandboxLease(acquisition.lease)`). `EnvironmentAcquisitionResult` has **no** top-level `driver`; mocks must mirror `{ environment: { driver }, lease, … }`.
- **Cross-references cite unit IDs (U1–U13), not "Wave N".** The INDEX table maps units→waves; waves are 0–7 (there is no Wave 8/9).

## Invariants every wave must preserve (from the 5-round spec review)

- **Never in a VM:** `DATABASE_URL`/`DIRECT_DATABASE_URL`, secrets master key, `GITHUB_PAT`, `BETTER_AUTH_SECRET`/`AOA_AGENT_JWT_SECRET`, `REDIS_URL`, embeddings key, operator `~/.claude` **and its env forms** (`CLAUDE_CODE_OAUTH_TOKEN`, host-ambient `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`). Every wave that builds a VM env has a test asserting their absence.
- **Broker RBAC:** memory read/write tools keep their gating; `find_similar_memory` + `detect_conflicts` must **gain** `memoryAccessConditions`/`filterMemoryForActor` for an agent actor (not "verbatim"). Unported tool → **explicit MCP error**, never silent.
- **Crew = always ephemeral** (never warm), the sandbox *is* its per-run workspace (no host W3b worktree), **no crew PR** in v1.
- **Cross-tenant isolation = data plane, unchanged** — nothing here weakens it.
- **Guard flip (U8) is last.** Until then, cloud crew/Commander stay refused (safe).

## Deferred fast-follows (named, not in this plan)

Broker-proxy egress · broker-injected key · git-native crew PRs + host worktrees (W3b) · warm crew pool · gVisor self-host · **Scenario 2 (tenant-operated local runner** — the sanctioned subscription-on-cloud path). **NOT supported:** subscription-login on the *shared* cloud pool (provider ToS; see spec §14).
