# E2B Cloud Execution Isolation — Implementation Plan (Wave 2: wave2-coverage-auth)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec:** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Shared seams:** the INDEX. Execute waves 0→7; U8/guard-flip LAST.

---

## Wave 2 — Coverage + env-flip + cloud auth

**Goal:** Bring crew and Commander onto the same sandbox-lease path org agents already use, flip every VM run's environment from inherit-minus-denylist to a from-scratch positive allowlist, route every sandbox run's `aoa` MCP server through the brokered HTTP transport (never the stdio bridge that injects `DATABASE_URL` into the VM), and require a resolved company provider key (never the operator login) before any cloud run spends a sandbox. Covers **U4** (shared acquire-execution-context helper), **U4b** (wire the `brokered` MCP flag — the S7 blocker), **U5** (env posture flip), and **U12** (cloud crew/agent auth).

This wave assumes Wave 1 landed the `domain`/`E2B_DOMAIN` knob (U9) and platform-default environment resolution (U1) — specifically that **U1 changed `resolveEnvironment` (`environment-run-orchestrator.ts:123`)** so an `environmentId == null` input resolves `resolvePlatformDefaultEnvironment(companyId, deploymentMode, env)` (returns `Environment | null`, in `platform-default-environment.ts`), synthesizing an environment on cloud and throwing `EnvironmentRunError("environment_not_found")` as today when it returns null (desktop/local_trusted). There is **no** `resolvePlatformDefaultEnvironmentId` and **no** sentinel id (S1). It also assumes `tenantIsolationEnforced()` (`server/src/config/deployment-mode.js`) is the cloud signal. This wave does **not** yet flip the D1 guard (U8, the last unit) or add warm reuse (U7); the helper accepts a `warmPreference` field but resolves ephemeral-only here.

This wave also depends on **U2d (Wave 3)** adding the `brokered` / `apiBaseUrl` fields to `McpConfigParams` and teaching `buildMcpBridgeSpec` (`cli-mode.ts:213`) + `buildMcpConfig` (`cli-mode.ts:285`) to honor them (suppress the stdio `DATABASE_URL` injection at `cli-mode.ts:257` and emit the `aoa` server as an `type:"http"` entry pointed at the control plane). U4b here is the **caller-side** half — it SETS `brokered` at every dispatch site. Per §11 build order Wave 2 lands together with Wave 3, so the U4b integration test exercises the end-to-end brokered result.

---

### Task: U4 — Shared acquire-execution-context helper

Create one helper that owns "acquire sandbox lease → produce the config patch" so org (heartbeat), crew (`runAoaAgent`), and Commander cannot drift. Per S1 the helper does **no** default resolution of its own — it passes `input.environmentId ?? null` **straight** into `environmentRunOrchestrator(db).acquireForRun`, and the orchestrator's `resolveEnvironment` (patched by U1) turns a null into the platform-default on cloud or throws `environment_not_found` on desktop. Crew resolves its target from `adapterConfig` only today (`runner.ts:687`, no `acquireForRun`); Commander spawns raw with `cwd: tmpdir()` (`cli-mode.ts:1147`/`:1556`, no environment/lease at all).

**Files:**
- **Create** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/acquire-execution-context.ts`
- **Create** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/acquire-execution-context.test.ts`
- **Create** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/acquire-execution-context.integration.test.ts` (embedded-PG: real orchestrator + helper → `provider-sandbox` for a null-env run on `cloud_auth`)
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/aoa-agents/runner.ts` (crew: acquire the lease BEFORE `buildMcpConfig` at `:435`, fold its patch into `config` at the `resolveGuardedAdapterExecutionContext` call at `:687`)
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/cli-mode.ts` (Commander: acquire an ephemeral sandbox once per turn BEFORE the `McpConfigParams` are built, and route the spawn at `:1147` and `:1556` through `runAdapterExecutionTargetProcess` when a sandbox target resolves)
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/heartbeat.ts` (org: refactor the inline `acquireForRun` block at `:4180-4198` to delegate to the shared helper **inside** the existing `if (environmentRuntime.environmentId)` gate — no behavior change, proves the helper is the single path)
- **Test** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/heartbeat-execution-target.test.ts` (existing — keep green after the refactor)

**Steps:**

1. **Write the failing test** for the helper contract in `acquire-execution-context.test.ts`. Encode the real null-through mechanism (S1) and the local-fallback-on-`environment_not_found` rule. Note the mock mirrors the real `EnvironmentAcquisitionResult` shape — `{ environment: { driver }, lease, adapterType, configPatch }` (S5):
   ```ts
   import { describe, it, expect, vi } from "vitest";
   import { acquireExecutionContext } from "../services/acquire-execution-context.js";
   import { EnvironmentRunError } from "../services/environment-run-orchestrator.js";

   describe("acquireExecutionContext", () => {
     it("passes environmentId ?? null STRAIGHT into acquireForRun and returns {sandbox, lease}", async () => {
       const acquireForRun = vi.fn().mockResolvedValue({
         lease: { id: "lease-1", provider: "e2b", providerLeaseId: "e2b-1", metadata: {} }, // S6: EnvironmentLease shape
         environment: { id: "env-plat", companyId: "c1", driver: "sandbox" }, // S5: real shape
         adapterType: "claude_local",
         configPatch: { executionTarget: { type: "provider-sandbox", provider: "e2b", providerLeaseId: "lease-1", remoteCwd: "/workspace", runner: { execute: () => {} } } },
       });
       const orchestrator = { acquireForRun, resolveEnvironment: vi.fn() };
       const result = await acquireExecutionContext(
         { orchestrator } as any,
         {
           runIdentity: { companyId: "c1", agentId: "a1", runId: "r1", adapterType: "claude_local" },
           functionType: null,          // Commander → ephemeral
           warmPreference: "auto",
           worktree: null,
           environmentId: null,          // nothing pinned → null flows through; orchestrator (U1) resolves platform default
         },
       );
       // S1: the helper does NOT resolve a default id — null is what acquireForRun receives.
       expect(acquireForRun).toHaveBeenCalledWith(expect.objectContaining({ companyId: "c1", environmentId: null }));
       expect(result.sandbox?.configPatch).toBeTruthy();
       expect(result.sandbox?.environment.driver).toBe("sandbox"); // S5
       expect(result.lease).toEqual(expect.objectContaining({ id: "lease-1", provider: "e2b" }));
       // Warm is deferred (U7): a null functionType must resolve ephemeral, never warm.
       expect(result.warmResolved).toBe(false);
     });

     it("threads a pinned environmentId through unchanged (heartbeat path)", async () => {
       const acquireForRun = vi.fn().mockResolvedValue({
         lease: { id: "lease-2", provider: "e2b", providerLeaseId: "e2b-2", metadata: {} },
         environment: { id: "env-pin", companyId: "c1", driver: "sandbox" },
         adapterType: "claude_local",
         configPatch: {},
       });
       const orchestrator = { acquireForRun, resolveEnvironment: vi.fn() };
       await acquireExecutionContext(
         { orchestrator } as any,
         { runIdentity: { companyId: "c1", agentId: "a1", runId: "r1", adapterType: "claude_local" }, functionType: "software_development", warmPreference: "auto", worktree: null, environmentId: "env-pin" },
       );
       expect(acquireForRun).toHaveBeenCalledWith(expect.objectContaining({ environmentId: "env-pin" }));
     });

     it("returns {sandbox:null} when the orchestrator resolves no environment (desktop/local_trusted → environment_not_found)", async () => {
       // S1: on desktop, resolvePlatformDefaultEnvironment returns null and resolveEnvironment
       // throws environment_not_found (as today). That throw is the local-execution signal.
       const acquireForRun = vi.fn().mockRejectedValue(new EnvironmentRunError("environment_not_found", "No environment selected."));
       const orchestrator = { acquireForRun, resolveEnvironment: vi.fn() };
       const result = await acquireExecutionContext(
         { orchestrator } as any,
         { runIdentity: { companyId: "c1", agentId: null, runId: "r1", adapterType: "claude_local" }, functionType: null, warmPreference: "auto", worktree: null, environmentId: null },
       );
       expect(result.sandbox).toBeNull();
       expect(result.lease).toBeNull();
     });

     it("RE-THROWS a non-'not_found' environment error (a cloud misconfig must fail loud, never silently fall to local)", async () => {
       const acquireForRun = vi.fn().mockRejectedValue(new EnvironmentRunError("environment_inactive", "inactive"));
       const orchestrator = { acquireForRun, resolveEnvironment: vi.fn() };
       await expect(
         acquireExecutionContext({ orchestrator } as any, {
           runIdentity: { companyId: "c1", agentId: null, runId: "r1", adapterType: "claude_local" }, functionType: null, warmPreference: "auto", worktree: null, environmentId: null,
         }),
       ).rejects.toThrow(/inactive/);
     });
   });
   ```

2. **Run it — expect FAIL** (`pnpm --filter @armyofagents/server test acquire-execution-context` → module not found).

3. **Implement** `acquire-execution-context.ts`. The helper is a thin, dependency-injected wrapper over `environmentRunOrchestrator` (`environment-run-orchestrator.ts:85`). **No** `cloud-environment-policy` import, **no** default-id resolver (S1). The returned `lease` is the real `EnvironmentLease` (fields `provider`, `providerLeaseId`, `metadata` — S6), passed through verbatim:
   ```ts
   import type { Db } from "@armyofagents/db";
   import {
     environmentRunOrchestrator,
     EnvironmentRunError,
     type EnvironmentAcquisitionResult,
   } from "./environment-run-orchestrator.js";

   export interface AcquireExecutionContextInput {
     runIdentity: { companyId: string; agentId: string | null; runId: string; adapterType: string };
     functionType: string | null;                 // null (Commander) → always ephemeral
     warmPreference: "auto" | "warm" | "ephemeral"; // U7 consumes; here ephemeral-only
     worktree: { id: string; mode: string } | null;
     environmentId: string | null;                 // pinned task/agent/company env, else null → platform default (U1)
     issueId?: string | null;
     heartbeatRunId?: string | null;
   }

   export interface AcquiredExecutionContext {
     sandbox: EnvironmentAcquisitionResult | null;
     lease: EnvironmentAcquisitionResult["lease"] | null; // EnvironmentLease (S6)
     warmResolved: boolean;                         // always false until U7
   }

   interface Deps {
     orchestrator?: ReturnType<typeof environmentRunOrchestrator>;
   }

   export async function acquireExecutionContext(
     db: Db | Deps,
     input: AcquireExecutionContextInput,
   ): Promise<AcquiredExecutionContext> {
     const deps = "orchestrator" in (db as Deps) ? (db as Deps) : {};
     const orchestrator = deps.orchestrator ?? environmentRunOrchestrator(db as Db);

     // S1: pass the pinned environment STRAIGHT through. When null, the orchestrator's
     // resolveEnvironment (U1) resolves the platform default on cloud, or throws
     // environment_not_found on desktop/local_trusted (no platform default). A
     // "no environment" throw is the local-execution signal → sandbox:null. Any other
     // failure (inactive/target_unavailable/lease_acquire_failed) re-throws (fail loud).
     let sandbox: EnvironmentAcquisitionResult;
     try {
       sandbox = await orchestrator.acquireForRun({
         companyId: input.runIdentity.companyId,
         environmentId: input.environmentId ?? null,
         adapterType: input.runIdentity.adapterType,
         issueId: input.issueId ?? null,
         heartbeatRunId: input.heartbeatRunId ?? null,
         persistedExecutionWorkspace: input.worktree,
       });
     } catch (err) {
       if (err instanceof EnvironmentRunError && err.code === "environment_not_found") {
         return { sandbox: null, lease: null, warmResolved: false };
       }
       throw err;
     }
     return { sandbox, lease: sandbox.lease, warmResolved: false };
   }
   ```
   Keep the `db | Deps` overload so production passes `db` and tests pass an injected `orchestrator` (mirrors the `environmentRunOrchestrator(db, options)` DI convention). `functionType`/`warmPreference` are carried for the U7 seam and are intentionally unused here (ephemeral-only).

4. **Run — expect PASS.**

5. **Refactor heartbeat to delegate** (proves single-path). In `heartbeat.ts:4180-4198`, keep the existing `if (environmentRuntime.environmentId)` gate (so desktop stays local — no behavior change) and, inside it, replace the inline `environmentRunOrchestrator(db).acquireForRun({...})` with a call to the shared helper, capturing the result so U4b can read its driver:
   ```ts
   let orgAcquired: Awaited<ReturnType<typeof acquireExecutionContext>> | null = null;
   if (environmentRuntime.environmentId) {
     orgAcquired = await acquireExecutionContext(db, {
       runIdentity: { companyId: agent.companyId, agentId: agent.id, runId: run.id, adapterType: agent.adapterType },
       functionType: issueRef?.functionType ?? null,
       warmPreference: "auto",
       worktree: persistedExecutionWorkspace ? { id: persistedExecutionWorkspace.id, mode: persistedExecutionWorkspace.mode } : null,
       environmentId: environmentRuntime.environmentId, // still the pin — non-null here, so resolveEnvironment resolves it directly
       issueId,
       heartbeatRunId: run.id,
     });
     resolvedConfigWithEnvironmentAcquisition = applyEnvironmentAcquisitionConfig(resolvedConfig, orgAcquired.sandbox);
   }
   ```
   Because `environmentRuntime.environmentId` is non-null inside the gate, `acquireForRun` resolves it directly (never the platform-default branch), and `applyEnvironmentAcquisitionConfig` already no-ops on a null/empty patch. `orgAcquired` is read again by U4b before `prepareHeartbeatMcpDelivery` at `:4610`. Run `heartbeat-execution-target.test.ts` — **expect PASS** (no behavior change).

6. **Wire crew** in `runner.ts`. Acquire the lease **once**, immediately BEFORE `buildMcpConfig` at `:435` (so U4b can set `brokered` on the SAME `mcpParams`), and reuse the result at the guarded-context step at `:687`:
   ```ts
   // Acquire BEFORE buildMcpConfig (:435) so the brokered flag (U4b) is set before
   // the MCP config file / bridge spec are built from mcpParams.
   const acquired = await acquireExecutionContext(db, {
     runIdentity: { companyId: agent.companyId, agentId: agent.id, runId: runId ?? `aoa-${agentId}`, adapterType: agent.adapterType },
     functionType: null,          // R1/Q1: crew is ALWAYS ephemeral, never warm
     warmPreference: "ephemeral",
     worktree: null,              // crew has no host worktree (A+ model, U6)
     environmentId: (agent.adapterConfig as any)?.defaultEnvironmentId ?? null, // null → platform default on cloud (U1), local on desktop
   });
   // (U4b sets mcpParams.brokered / mcpParams.apiBaseUrl from `acquired` HERE — see U4b.)

   const mcp = buildMcpConfig({ ...mcpParams, extraMcpServers });   // :435 (unchanged call)
   // ... cfgPath write + buildMcpBridgeSpec(mcpParams) at :443 (unchanged) ...

   const configWithSandbox = applyEnvironmentAcquisitionConfig(config, acquired.sandbox);
   const { executionTarget, runtimeCommandSpec } = resolveGuardedAdapterExecutionContext(
     configWithSandbox, adapter, { trustBoundary: topology.trustBoundary, tenantIsolationEnforced: tenantIsolationEnforced(), sink: "crew agent" },
   );
   ```
   Import `acquireExecutionContext` and `applyEnvironmentAcquisitionConfig` (the latter is exported from `heartbeat.ts:663`). Pass `configWithSandbox` (not `config`) to `adapter.execute` at `:947`.

7. **Write the failing crew/Commander integration assertion** in `acquire-execution-context.integration.test.ts` (embedded-PG, **real orchestrator + helper**, S1 null-env path): on `cloud_auth` (`AOA_ALLOW_UNSANDBOXED_MULTITENANT` unset, deployment mode `cloud_auth`), call `acquireExecutionContext(db, { environmentId: null, ... })` and assert the resolved `acquired.sandbox` is a `provider-sandbox` target — i.e. `acquired.sandbox!.environment.driver === "sandbox"` (S5) and `applyEnvironmentAcquisitionConfig({}, acquired.sandbox).executionTarget.type === "provider-sandbox"` — using a fake sandbox provider registered at the `importE2b` seam (§10 — mirror `AOA_E2E_FAKE_EMBEDDER`). Cover both a null-env crew dispatch and a null-env Commander turn resolving the same platform-default. **Run — expect FAIL** (helper/U1 not yet wired end-to-end; a null env currently throws or returns local).

8. **Wire Commander** in `cli-mode.ts`. Acquire an ephemeral sandbox once per turn, after CLI-detection and BEFORE the `McpConfigParams` objects are built (codex at `:892`, claude inline at `:1056`), so U4b can set `brokered` on them and the spawn routing can reuse the same `acquired`:
   ```ts
   const acquired = await acquireExecutionContext(db, {
     runIdentity: { companyId: params.companyId, agentId: null, runId: params.runId ?? `commander-${Date.now()}`, adapterType: config.cliTool === "codex" ? "codex_local" : "claude_local" },
     functionType: null, warmPreference: "ephemeral", worktree: null, environmentId: null,
   });
   const commanderExecutionTarget = acquired.sandbox
     ? resolveAdapterExecutionTarget(applyEnvironmentAcquisitionConfig({}, acquired.sandbox).executionTarget, /* hardenForMultiTenant */ tenantIsolationEnforced())
     : { type: "local" as const };
   ```
   Then, at both spawn sites (`:1147` claude and `:1556` codex/opencode), branch: when `commanderExecutionTarget.type !== "local"`, run through `runAdapterExecutionTargetProcess(commanderExecutionTarget, { runId, command: invocation.binary, args: invocation.args, cwd: commanderExecutionTarget.remoteCwd, env: spawnEnv, stdin: prompt, authToken: spawnEnv.AOA_API_KEY ?? null, apiBaseUrl: spawnEnv.AOA_API_URL ?? null, timeoutSec, graceSec, onLog, sandboxProvider: config.cliTool === "codex" ? "openai" : "anthropic" })` (the `sandboxProvider` field is introduced by U5, step 5) instead of raw `spawn(... cwd: tmpdir())`. Keep the raw `spawn()` path (`cwd: tmpdir()`, `:1151`/`:1560`) byte-identical for the `local` target (desktop — no sandbox resolves).

9. **Run the crew + Commander integration tests — expect PASS.**

10. **Commit:** `feat(exec-isolation): shared acquire-execution-context helper routes crew + Commander through the sandbox lease path (U4)`

---

### Task: U4b — Wire the `brokered` MCP flag (S7 blocker: stop the `DATABASE_URL`-into-VM leak)

**Why this task exists (S7 BLOCKER):** U2d (Wave 3) adds the `brokered` / `apiBaseUrl` fields to `McpConfigParams` and teaches `buildMcpBridgeSpec` (`cli-mode.ts:213`) + `buildMcpConfig` (`cli-mode.ts:285`) to honor them, but it declares `brokered` **default-false** and **no wave sets it true**. With nothing setting it, every sandbox (cloud) run still writes the stdio `aoa` bridge — whose env carries `DATABASE_URL` (`cli-mode.ts:257`) plus the secrets-provider config — into the on-disk MCP config file (`--mcp-config` JSON for claude, `$CODEX_HOME/config.toml` for codex) that is then **staged into the VM**. That is a direct control-plane-DB-credential exfiltration into the tenant sandbox, and it passes every test green because no assertion checks the staged file for `DATABASE_URL`. U4b closes it by SETTING `brokered` at every dispatch site the moment a sandbox lease resolves, so the `aoa` server is emitted as a control-plane HTTP endpoint (authenticated by the run-JWT `AOA_API_KEY`) and the stdio `DATABASE_URL` block never runs.

**Contract (do NOT drift):** `brokered = acquisition.environment.driver === "sandbox"` (i.e. `acquired.sandbox?.environment.driver === "sandbox"`, S5) + `apiBaseUrl` (the control-plane origin the in-VM HTTP MCP client dials) + `companyId` (already on `McpConfigParams`). The three fields together let U2d's honoring code build the `aoa` HTTP entry `{ type: "http", url: "<apiBaseUrl>/companies/<companyId>/mcp", headers: { Authorization: "Bearer ${AOA_API_KEY}" } }`.

**U2d cross-reference (bridge-spec coverage):** U2d must gate the `DATABASE_URL` injection at `cli-mode.ts:257` **inside `buildMcpBridgeSpec`** (the shared inner builder), NOT only re-point claude's `aoa` envelope inside `buildMcpConfig`. `buildMcpBridgeSpec` is consumed standalone by the non-claude adapters — crew's codex/opencode/gemini via `buildMcpBridgeSpec(mcpParams)` at `runner.ts:443` and Commander's codex via `buildMcpBridgeSpec(params)` at `cli-mode.ts:610` (→ `writeCodexMcpConfigToml` into `$CODEX_HOME/config.toml`). If U2d only fixes the claude envelope, the bridge-spec `DATABASE_URL` still leaks into the codex/opencode config on every sandbox run. U4b's integration test (step 5) fails loudly if that path is left uncovered.

**Files:**
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/aoa-agents/runner.ts` (crew: set `mcpParams.brokered` + `mcpParams.apiBaseUrl` from `acquired` before `:435`)
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/heartbeat.ts` (org: set `heartbeatMcpParams.brokered` + `apiBaseUrl` from `orgAcquired` before `prepareHeartbeatMcpDelivery` at `:4610`)
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/cli-mode.ts` (Commander: set `brokered` + `apiBaseUrl` on BOTH `McpConfigParams` — codex `:892`, claude inline `:1056` — from `acquired`)
- **Create** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/brokered-mcp-no-db-url.integration.test.ts` (embedded-PG: a non-test-forced sandbox dispatch stages an `aoa` HTTP entry with NO `DATABASE_URL`)

**Steps:**

1. **Write the failing integration test** in `brokered-mcp-no-db-url.integration.test.ts` (embedded-PG, `cloud_auth`, fake sandbox provider at the `importE2b` seam — §10, real orchestrator). This is the assertion the green-but-leaking status quo lacks. It must **not** force the sandbox via a test flag — it drives a real null-env dispatch through the platform default so a regression that stops setting `brokered` goes red:
   ```ts
   // For a claude crew dispatch on cloud_auth (null env → provider-sandbox), the
   // STAGED --mcp-config JSON must carry the aoa server as an http entry pointed at
   // the control plane, with NO DATABASE_URL and NO secrets-provider config anywhere.
   const staged = JSON.parse(await readStagedMcpConfig(runId)); // capture the file written at runner.ts:437
   expect(staged.mcpServers.aoa.type).toBe("http");
   expect(staged.mcpServers.aoa.url).toMatch(/\/companies\/.+\/mcp$/);
   expect(JSON.stringify(staged)).not.toMatch(/DATABASE_URL/);
   expect(JSON.stringify(staged)).not.toMatch(/postgres(ql)?:\/\//);

   // For a codex crew dispatch, the bridge-spec path (buildMcpBridgeSpec → config.toml)
   // must ALSO carry no DATABASE_URL — proving U2d gated :257 inside buildMcpBridgeSpec,
   // not only in buildMcpConfig's claude envelope.
   const toml = await readStagedCodexConfigToml(runId);
   expect(toml).not.toMatch(/DATABASE_URL/);
   ```
   Cover all three actors: crew (claude + codex), org heartbeat, and a Commander turn. **Run — expect FAIL** (nothing sets `brokered`; the stdio `aoa` entry with `DATABASE_URL` is staged verbatim).

2. **Wire crew** (`runner.ts`). Immediately after the U4 `acquired` (before `:435`), set the flag + control-plane URL on `mcpParams` so both `buildMcpConfig(:435)` and `buildMcpBridgeSpec(:443)` see it:
   ```ts
   mcpParams.brokered = acquired.sandbox?.environment.driver === "sandbox";
   mcpParams.apiBaseUrl = resolvedEnv.AOA_API_URL ?? process.env.AOA_API_URL ?? null;
   ```
   (`resolvedEnv` is the run's resolved env already in scope at the crew resolve step; fall back to `process.env.AOA_API_URL`. `companyId` is already `mcpParams.companyId`.)

3. **Wire org** (`heartbeat.ts`). Before `prepareHeartbeatMcpDelivery` at `:4610`, set the flag on `heartbeatMcpParams` from the `orgAcquired` captured in U4 step 5 (null on desktop → `brokered:false`, byte-identical stdio delivery preserved):
   ```ts
   heartbeatMcpParams.brokered = orgAcquired?.sandbox?.environment.driver === "sandbox";
   heartbeatMcpParams.apiBaseUrl = adapterEnv.AOA_API_URL ?? process.env.AOA_API_URL ?? null;
   ```
   `prepareHeartbeatMcpDelivery` passes `input.params` straight into `buildMcpBridgeSpec` (`heartbeat-mcp.ts:103`) and `buildMcpConfig` (`heartbeat-mcp.ts:131`), so both the claude and non-claude branches honor it.

4. **Wire Commander** (`cli-mode.ts`). Set the flag on BOTH `McpConfigParams` from the U4 `acquired` — the codex object at `:892` and the claude inline object at `:1056`:
   ```ts
   // both McpConfigParams:
   brokered: acquired.sandbox?.environment.driver === "sandbox",
   apiBaseUrl: params.apiBaseUrl ?? process.env.AOA_API_URL ?? null,
   ```
   These flow through `resolveCliInvocation` into `buildMcpConfig(:514)` (claude) and `buildMcpBridgeSpec(:610)` (codex), so a sandboxed Commander turn stages an HTTP `aoa` entry with no `DATABASE_URL` for either CLI.

5. **Run the integration test — expect PASS.** Confirm all three staged surfaces (claude `--mcp-config` JSON, codex `config.toml`, Commander) carry an HTTP `aoa` entry and no `DATABASE_URL`. On desktop/local (no sandbox → `brokered:false`) the stdio delivery is unchanged — add a desktop-path assertion that the stdio `aoa` entry and its `DATABASE_URL` are still present (byte-identical to pre-U4b), so the flag is proven strictly additive on the local path.

6. **Commit:** `feat(exec-isolation): set brokered on every sandbox dispatch so the aoa MCP server rides HTTP, never leaking DATABASE_URL into the VM (U4b, S7)`

---

### Task: U5 — Env posture flip (from-scratch allowlist)

Every VM run's environment must be built from a **positive allowlist** — only provider key + run-JWT + run-identity + connector tokens cross — not `process.env` minus a denylist. The scrub is opt-in today (`isolateAmbientConfig` fires only for connectors/crew; org-with-no-connectors and both Commander spawns still inherit `DATABASE_URL` + the master key via `{...process.env}` at `cli-mode.ts:1146`/`:1555`). The chokepoint is the sandbox branch of `runAdapterExecutionTargetProcess`, which already excludes host `process.env` but must be hardened so a caller cannot smuggle a forbidden key through the overlay.

**Files:**
- **Create** `C:/Users/TK/.aoa/wt/e2b-exec/packages/adapter-utils/src/sandbox-env-allowlist.ts`
- **Create** `C:/Users/TK/.aoa/wt/e2b-exec/packages/adapter-utils/src/sandbox-env-allowlist.test.ts`
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/packages/adapter-utils/src/execution-target.ts` (apply the allowlist in the `provider-sandbox` branch `:662-669` and the `sandbox-docker` branch `:697-704` of `runAdapterExecutionTargetProcess`)
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/packages/adapter-utils/src/index.ts` (export the new builder)
- **Test** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/aoa-agents/runner-model-resolution.ts` (no change — its `OPENAI_API_KEY` strip at `:26-34` is the upstream half; assert both halves interlock in a test)

**Steps:**

1. **Write the failing allowlist test** in `sandbox-env-allowlist.test.ts`, encoding the §9 credential taxonomy as assertions. Note the canonical S2 signature — `buildSandboxEnvAllowlist(overlay, { provider })` — the caller BUILDS the overlay first, the builder only FILTERS it:
   ```ts
   import { describe, it, expect } from "vitest";
   import { buildSandboxEnvAllowlist } from "./sandbox-env-allowlist.js";

   const NEVER = [
     "DATABASE_URL", "DIRECT_DATABASE_URL", "AOA_SECRETS_MASTER_KEY", "AOA_SECRETS_MASTER_KEY_FILE",
     "GITHUB_PAT", "BETTER_AUTH_SECRET", "AOA_AGENT_JWT_SECRET", "REDIS_URL", "CLAUDE_CODE_OAUTH_TOKEN",
   ];

   describe("buildSandboxEnvAllowlist", () => {
     it("drops every never-in-VM infra/operator secret even if present in the overlay", () => {
       const overlay: Record<string, string> = { AOA_API_KEY: "jwt", ANTHROPIC_API_KEY: "sk-ant-company" };
       for (const k of NEVER) overlay[k] = "LEAK";
       const out = buildSandboxEnvAllowlist(overlay, { provider: "anthropic" });
       for (const k of NEVER) expect(out[k]).toBeUndefined();
       expect(out.AOA_API_KEY).toBe("jwt");
       expect(out.ANTHROPIC_API_KEY).toBe("sk-ant-company");
     });

     it("keeps run-identity + connector tokens (AOA_MCP_*_TOKEN prefix)", () => {
       const out = buildSandboxEnvAllowlist(
         { AOA_API_URL: "https://cp", AOA_RUN_ID: "r1", AOA_EXECUTION_TARGET_ID: "t1", AOA_RUNTIME_HOOK_TOKEN: "hk", AOA_MCP_NOTION_TOKEN: "ntn", PAPERCLIP_API_KEY: "jwt2" },
         { provider: "anthropic" },
       );
       expect(out).toMatchObject({ AOA_API_URL: "https://cp", AOA_RUN_ID: "r1", AOA_EXECUTION_TARGET_ID: "t1", AOA_RUNTIME_HOOK_TOKEN: "hk", AOA_MCP_NOTION_TOKEN: "ntn", PAPERCLIP_API_KEY: "jwt2" });
     });

     it("OPENAI_API_KEY disambiguation: claude agent → absent; codex agent → present", () => {
       // claude run: overlay carries no OPENAI_API_KEY (embeddings key is host-side only, never in overlay)
       expect(buildSandboxEnvAllowlist({ ANTHROPIC_API_KEY: "sk-ant" }, { provider: "anthropic" }).OPENAI_API_KEY).toBeUndefined();
       // codex run: overlay carries the agent's OWN OPENAI_API_KEY (runner-model-resolution kept it) → survives
       expect(buildSandboxEnvAllowlist({ OPENAI_API_KEY: "sk-agent-openai" }, { provider: "openai" }).OPENAI_API_KEY).toBe("sk-agent-openai");
     });

     it("also drops the OAuth refresh token / signed bundle strings (only the minted bearer crosses)", () => {
       const out = buildSandboxEnvAllowlist(
         { AOA_MCP_NOTION_TOKEN: "access-bearer", AOA_MCP_NOTION_REFRESH: "refresh-tok", "mcp:oauth:notion": "signed-bundle" },
         { provider: "anthropic" },
       );
       expect(out.AOA_MCP_NOTION_TOKEN).toBe("access-bearer");
       expect(out.AOA_MCP_NOTION_REFRESH).toBeUndefined();   // not on the *_TOKEN allowlist tail
       expect(out["mcp:oauth:notion"]).toBeUndefined();       // invalid env name + not allowed
     });
   });
   ```

2. **Run it — expect FAIL** (module missing).

3. **Implement** `sandbox-env-allowlist.ts` with the canonical S2 signature — `buildSandboxEnvAllowlist(overlay: Record<string,string>, opts: { provider: string }): Record<string,string>` — as an explicit positive allowlist. Fixed keys + provider-scoped auth key + prefix classes; everything else dropped. The builder does **not** inject any credential; it only filters what the caller already put in the overlay:
   ```ts
   import { foldEnvKey } from "./server-utils.js";

   /** Provider auth env names, keyed by the resolved provider. The embeddings
    *  OPENAI_API_KEY is host-side only and never appears in a run overlay — so
    *  OPENAI_API_KEY is admissible ONLY for an openai-provider run (the agent's
    *  own resolved key), never for a claude run. */
   const PROVIDER_AUTH_KEYS: Record<string, string[]> = {
     anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
     openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"],
     gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
   };

   /** Run-identity + control-plane credential env that MAY cross (§9). */
   const ALWAYS_ALLOWED = new Set(
     [
       "AOA_API_KEY", "PAPERCLIP_API_KEY",         // the run-JWT
       "AOA_API_URL", "PAPERCLIP_API_URL", "AOA_ORIGIN_API_URL", "AOA_CALLBACK_BRIDGE_URL",
       "AOA_RUN_ID", "PAPERCLIP_RUN_ID", "AOA_EXECUTION_TARGET_ID",
       "AOA_RUNTIME_HOOK_TOKEN",
       "MAX_THINKING_TOKENS", "LANG", "LC_ALL", "CLAUDE_CONFIG_DIR", "CODEX_HOME", // in-VM managed homes
     ].map(foldEnvKey),
   );

   /** Prefix classes admissible in the VM (connector access-token bearers). */
   const ALLOWED_PREFIXES = ["AOA_MCP_"].map(foldEnvKey);
   const ALLOWED_TOKEN_SUFFIX = "_TOKEN"; // AOA_MCP_*_TOKEN only — never *_REFRESH

   export function buildSandboxEnvAllowlist(
     overlay: Record<string, string>,
     opts: { provider: string },
   ): Record<string, string> {
     const providerKeys = new Set((PROVIDER_AUTH_KEYS[opts.provider] ?? []).map(foldEnvKey));
     const out: Record<string, string> = {};
     for (const [key, value] of Object.entries(overlay)) {
       if (typeof value !== "string") continue;
       if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;      // invalid env name (drops "mcp:oauth:*")
       const folded = foldEnvKey(key);
       const isConnectorToken =
         ALLOWED_PREFIXES.some((p) => folded.startsWith(p)) && foldEnvKey(ALLOWED_TOKEN_SUFFIX) === folded.slice(-ALLOWED_TOKEN_SUFFIX.length);
       if (ALWAYS_ALLOWED.has(folded) || providerKeys.has(folded) || isConnectorToken) {
         out[key] = value;
       }
     }
     return out;
   }
   ```
   Reuse the exported `foldEnvKey` (`server-utils.ts:374`) so the case-folding matches the strip rule on Windows. Export from `index.ts`.

4. **Run — expect PASS.**

5. **Wire the allowlist into the sandbox branches** of `runAdapterExecutionTargetProcess` (`execution-target.ts`). The `AdapterExecutionTarget` type does not carry the resolved provider name, so thread it through `AdapterTargetProcessOptions` as a new optional `sandboxProvider?: string` (default `""` → no provider auth key admitted, safe). In both the `provider-sandbox` (`:662-669`) and `sandbox-docker` (`:697-704`) branches, the caller BUILDS the overlay `{ ...(target.env ?? {}), ...opts.env }` first, then the allowlist FILTERS it (S2) before `sanitizeRemoteExecutionEnv`:
   ```ts
   const env = sanitizeRemoteExecutionEnv(
     shapeAoaWorkspaceEnvForExecution({
       env: buildSandboxEnvAllowlist({ ...(target.env ?? {}), ...opts.env }, { provider: opts.sandboxProvider ?? "" }),
       targetType: "sandbox-docker",
       localCwd: workspace.localCwd,
       executionCwd: workspace.executionCwd,
     }),
   );
   ```
   The bridge-injected `AOA_CALLBACK_BRIDGE_URL`/`AOA_API_URL`/`AOA_ORIGIN_API_URL` merge is added AFTER the allowlist (`:714-719`; they are on `ALWAYS_ALLOWED` regardless), so the callback bridge still works. Populate `opts.sandboxProvider` from the callers: the claude-local adapter passes `"anthropic"`, codex-local passes `"openai"` at their `runAdapterExecutionTargetProcess(...)` call sites (claude at `execute.ts:816`); Commander passes it at the U4 spawn sites (step 8).

6. **Write a failing adapter-level test** `packages/adapters/claude-local/src/__tests__/sandbox-env-allowlist.test.ts`: build a `provider-sandbox` target whose overlay carries `DATABASE_URL`, `AOA_SECRETS_MASTER_KEY`, `ANTHROPIC_API_KEY`, `AOA_API_KEY`; run the fake runner; assert the runner's received `env` has the two secrets absent and the two credentials present. **Run — expect FAIL** (env passed verbatim today).

7. **Run — expect PASS** after wiring.

8. **Write the interlock test** (crew half) in `server/src/__tests__/`: a `codex_local` crew run whose `process.env.OPENAI_API_KEY` is the embeddings key and whose agent set no own key → `applyModelResolutionToConfig` strips it (`runner-model-resolution.ts:34`) → the overlay reaching `buildSandboxEnvAllowlist` has no `OPENAI_API_KEY` → VM env has none. A second codex agent that DID set `OPENAI_API_KEY` in `adapterConfig.env` → survives both. Assert both. **Run — expect PASS** (both mechanisms already implemented; this locks the interlock so a future edit to either can't reintroduce the embeddings-key leak).

9. **Commit:** `feat(exec-isolation): from-scratch positive env allowlist at the sandbox boundary (U5)`

---

### Task: U12 — Cloud crew/agent auth (require company key; drop operator provisioning)

On cloud, a crew/org/Commander run must resolve the **company's own** provider key; the operator `~/.claude` login must never reach a VM, and a run with no resolved company key must **fail before any sandbox spend** with actionable guidance. The operator-provisioning block is already short-circuited for remote targets (`claude-local/execute.ts:434` sets `isolateAmbientConfig = ctx.isolateAmbientConfig === true && !isRemoteExecutionTarget`), so the primary new work is the fail-before-spend surface.

**BLOCKER CORRECTION (do not build a `source`-keyed gate — it is dead code):** the earlier plan gated on `ResolvedProviderCredential.source === "host_login_fallback"`. That branch is **unreachable on cloud**: `resolveProviderCredential` (`provider-resolution.ts:445-454`) returns `{ source: "host_login_fallback" }` **only** when `deps.selfHostedSingleTenant` (`:449`), and on multi-tenant/cloud it **throws** `ProviderUnavailableError` (`:450`) instead — it never returns that credential shape. `ProviderUnavailableError` carries `readonly code = "provider_unavailable"` (`:284`). So there is nothing to assert on a returned credential; the credential never returns. The correct mechanism is to **catch the `ProviderUnavailableError` already thrown** by `resolveProviderCredential` (crew: at `runner.ts:580`, before the U4 acquire — its throw propagates to the runner's top-level catch at `:1349`; Commander: rethrown by `resolveCommanderSpawnEnvPatch` at `:773` via `handleCommanderResolveError`) and **map it to founder-facing `CloudProviderKeyMissingError` guidance** (S3). There is NO `assertCloudProviderKeyResolved` — never reference it. On desktop/self-hosted the resolver returns `host_login_fallback` and never throws, so the mapper is never triggered — the operator login stays legitimate. Per S3, U12 builds only this guidance gate (`mapCloudProviderKeyError` + `CloudProviderKeyMissingError`), **not** the `resolveCompanyProviderCredential` resolver (that is U13).

**Files:**
- **Create** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/require-cloud-provider-key.ts` (`CloudProviderKeyMissingError` + `mapCloudProviderKeyError`)
- **Create** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/require-cloud-provider-key.test.ts`
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/aoa-agents/runner.ts` (crew: hoist a function-scope `providerId` capture; map the caught `ProviderUnavailableError` in the top-level catch at `:1349` so BOTH the `internalAgentRuns` failure UPDATE at `:1358` **and** the `postCrewRunFailure` card at `:1395` carry the guidance)
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/internal-agent/cli-mode.ts` (Commander: wrap the `resolveCommanderSpawnEnvPatch` call sites at `:909` codex / `:1088` claude so the cloud rethrow becomes a guidance SSE `error` chunk before the U4 acquire + spawn)
- **Modify** `C:/Users/TK/.aoa/wt/e2b-exec/packages/adapters/claude-local/src/server/execute.ts` (lock the invariant at `:456` that operator `~/.claude` provisioning is unreachable on a sandbox target)
- **Test** `C:/Users/TK/.aoa/wt/e2b-exec/packages/adapters/claude-local/src/__tests__/` (new: sandbox target → `provisionClaudeConfigHome` never called)

**Steps:**

1. **Write the failing mapper test** in `require-cloud-provider-key.test.ts`, exercising the REAL mechanism (mapping a thrown `ProviderUnavailableError`, not a `host_login_fallback` credential):
   ```ts
   import { describe, it, expect } from "vitest";
   import { mapCloudProviderKeyError, CloudProviderKeyMissingError } from "../services/internal-agent/require-cloud-provider-key.js";
   import { ProviderUnavailableError } from "../services/provider-resolution.js";

   describe("mapCloudProviderKeyError", () => {
     it("maps a thrown ProviderUnavailableError to founder guidance on cloud (the REAL no-key outcome — resolveProviderCredential THROWS, never returns host_login_fallback)", () => {
       const mapped = mapCloudProviderKeyError(
         new ProviderUnavailableError("anthropic", "no_assignment", null),
         { tenantIsolationEnforced: true, provider: "anthropic", sink: "crew agent" },
       );
       expect(mapped).toBeInstanceOf(CloudProviderKeyMissingError);
     });
     it("also maps a duck-typed { code: 'provider_unavailable' } (belt-and-suspenders across a module boundary)", () => {
       const mapped = mapCloudProviderKeyError(
         { code: "provider_unavailable" },
         { tenantIsolationEnforced: true, provider: "anthropic", sink: "crew agent" },
       );
       expect(mapped).toBeInstanceOf(CloudProviderKeyMissingError);
     });
     it("returns null on desktop / local_trusted (host login is legitimate; the resolver returns host_login_fallback and never throws)", () => {
       expect(mapCloudProviderKeyError(
         new ProviderUnavailableError("anthropic", "x", null),
         { tenantIsolationEnforced: false, provider: "anthropic", sink: "crew agent" },
       )).toBeNull();
     });
     it("returns null for an unrelated error (a real infra fault must NOT be reshaped into a key-missing message)", () => {
       expect(mapCloudProviderKeyError(
         new Error("ECONNRESET"),
         { tenantIsolationEnforced: true, provider: "anthropic", sink: "crew agent" },
       )).toBeNull();
     });
     it("guidance points at the provider key, never at 'install the CLI'", () => {
       const mapped = mapCloudProviderKeyError(
         new ProviderUnavailableError("anthropic", "x", null),
         { tenantIsolationEnforced: true, provider: "anthropic", sink: "crew agent" },
       )!;
       expect(mapped.message).toMatch(/provider (API )?key/i);
       expect(mapped.message).not.toMatch(/install/i);
     });
   });
   ```

2. **Run it — expect FAIL** (module missing).

3. **Implement** `require-cloud-provider-key.ts`:
   ```ts
   import { ProviderUnavailableError } from "../provider-resolution.js";

   export class CloudProviderKeyMissingError extends Error {
     constructor(provider: string, sink: string) {
       super(
         `No ${provider} provider key is configured for this company. ${sink} runs on cloud require a ` +
         `company API key — configure it in Settings → Providers. (The operator login is never used on ` +
         `the shared cloud pool.)`,
       );
       this.name = "CloudProviderKeyMissingError";
     }
   }

   /**
    * Map a credential-resolution FAILURE to founder-facing guidance.
    *
    * WHY a catch-mapper, not a source-check gate: on cloud (multi_tenant) the ONLY
    * "no company key" outcome from resolveProviderCredential is a THROWN
    * ProviderUnavailableError (provider-resolution.ts:450) — it NEVER returns
    * source:"host_login_fallback" there (that branch is self-hosted-only, :449). So
    * there is nothing to assert on a RETURNED credential; the credential never
    * returns. Callers instead CATCH the throw (crew top-level catch at runner.ts:1349;
    * Commander at the resolveCommanderSpawnEnvPatch call sites) and pass it here.
    *
    * Returns the mapped guidance error when tenant isolation is enforced AND `err` is
    * a provider-unavailable failure; returns null otherwise (caller keeps the
    * original error). On desktop the resolver returns host_login_fallback and never
    * throws, so this is never triggered — the operator login stays legitimate.
    */
   export function mapCloudProviderKeyError(
     err: unknown,
     opts: { tenantIsolationEnforced: boolean; provider: string; sink: string },
   ): CloudProviderKeyMissingError | null {
     if (!opts.tenantIsolationEnforced) return null;
     const isProviderUnavailable =
       err instanceof ProviderUnavailableError ||
       (!!err && typeof err === "object" && (err as { code?: string }).code === "provider_unavailable");
     return isProviderUnavailable ? new CloudProviderKeyMissingError(opts.provider, opts.sink) : null;
   }
   ```

4. **Run — expect PASS.**

5. **Wire the crew mapping** in `runner.ts`. Hoist a function-scope `let outcomeProviderId: string | null = null;` alongside the existing captured locals (`promptSnapshot`, `outcomeAgentName`) — the `providerId` at `:563` is block-scoped inside the try and is out of scope in the catch, exactly like `agent` (see the P1 note at `:1391`). Set `outcomeProviderId = providerId;` right after `:568`. Then in the top-level catch at `:1349`, map the caught error **first**, derive `errMessage` from the mapped result, and thread that single message into **both** failure surfaces:
   ```ts
   } catch (err) {
     log.error({ err }, "aoa run failed (isolated)");
     // U12: on cloud, resolveProviderCredential (:580) THROWS ProviderUnavailableError
     // when no company key is configured — it never returns host_login_fallback on a
     // shared host (provider-resolution.ts:450). Re-shape THAT throw into founder-
     // facing guidance, then thread the SAME message into both failure surfaces.
     const mappedKeyError = mapCloudProviderKeyError(err, {
       tenantIsolationEnforced: tenantIsolationEnforced(),
       provider: outcomeProviderId ?? "provider",
       sink: "crew agent",
     });
     const surfaced = mappedKeyError ?? err;
     const errMessage = surfaced instanceof Error ? surfaced.message : String(surfaced);
     // NOTE: this REPLACES the existing `const errMessage = err instanceof Error ? err.message : String(err);`
     //       at :1351 — errMessage now derives from `surfaced`, not the raw `err`.
   ```
   **Critical (the false-green this fixes):** the `internalAgentRuns` failure UPDATE at `:1358` does **not** use `errMessage` today — it independently re-materializes the message with `errorMessage: String((err as Error)?.message ?? err)`, reading the RAW `err`. So even after mapping, the DB failure row would carry the raw resolver error while only the `postCrewRunFailure` card (`:1403`, already `errMessage`) got the guidance. Change `:1358` to use the mapped message:
   ```ts
   // was: errorMessage: String((err as Error)?.message ?? err),
   errorMessage: errMessage,
   ```
   Now the mapped guidance lands in **all three** places that read `errMessage`: the `internalAgentRuns` failure row (`:1358`), the work-question continuation finalize (`:1379`, `persistedTerminal.errorMessage ?? errMessage`), and the `postCrewRunFailure` card (`:1403`) that surfaces in the originating thread (§8 founder-facing surface). Any non-provider-unavailable error is untouched (mapper returns null → `surfaced === err`).

6. **Wire the Commander mapping** in `cli-mode.ts`. `resolveCommanderSpawnEnvPatch` (`:706`) already rethrows on cloud via `handleCommanderResolveError` (`:773`, which throws whenever `tenantIsolationEnforced` or `code === "provider_unavailable"`). At each call site (`:909` codex, `:1088` claude), wrap the call so the rethrow becomes a guidance SSE `error` chunk before the U4 acquire + spawn:
   ```ts
   let commanderCredentialEnv: Record<string, string>;
   try {
     commanderCredentialEnv = await resolveCommanderSpawnEnvPatch(params.companyId, params.userId, config.cliTool /* or "codex" at :909 */);
   } catch (err) {
     const mapped = mapCloudProviderKeyError(err, {
       tenantIsolationEnforced: tenantIsolationEnforced(),
       provider: config.cliTool === "codex" ? "openai" : "anthropic",
       sink: "Commander",
     });
     yield { type: "error", message: (mapped ?? (err instanceof Error ? err : new Error(String(err)))).message };
     return;
   }
   ```
   The existing `if (Object.keys(commanderCredentialEnv).length > 0)` overlay (`:1093`) stays. This runs before the U4 acquire/spawn, so no sandbox is leased when the key is missing.

7. **Write the failing Commander integration assertion** (embedded-PG, `cloud_auth`, no company provider connection): a Commander turn yields an `error` chunk whose message matches `/company API key/` and **no CLI is spawned** (spy the spawn/`runAdapterExecutionTargetProcess` seam). **Run — expect FAIL** (Commander currently lets the rethrow propagate uncaught / spawns before the miss surfaces).

8. **Lock the operator-provisioning invariant** in `claude-local/execute.ts`. At `:456` (`operatorConfigHome = isolateAmbientConfig ? resolveClaudeConfigHome(process.env) : null`), add an assertion + comment that provisioning is structurally unreachable for a sandbox target:
   ```ts
   // U12: the operator ~/.claude provisioning below must NEVER run for a sandbox
   // (cloud) target — the operator login is the platform's, not the tenant's.
   // isolateAmbientConfig is already forced false for a remote target (:434), so
   // operatorConfigHome is null and provisionClaudeConfigHome (:475) never runs.
   // Assert it so a future edit to :434 cannot silently re-open the path. (No throw:
   // a remote target legitimately authenticates via the injected ANTHROPIC_API_KEY
   // from the U5 allowlist.)
   if (isRemoteExecutionTarget && operatorConfigHome !== null) {
     throw new Error("invariant: operator ~/.claude provisioning must be disabled for a remote/sandbox target");
   }
   ```
   Then a new adapter test asserts: for a `provider-sandbox` target, `provisionClaudeConfigHome` (injected/spied) is **never called** and no `CLAUDE_CONFIG_DIR` per-run home is minted. **Run — expect PASS.**

9. **Run the crew + Commander integration tests — expect PASS.**

10. **Commit:** `feat(exec-isolation): require company provider key on cloud, fail before sandbox spend, drop operator ~/.claude on the shared pool (U12)`

---

**Wave 2 exit criteria:**
- `acquireExecutionContext` is the single sandbox-lease entry point; it passes `environmentId ?? null` straight into `acquireForRun` (S1 — no default-id resolver, no `cloud-environment-policy` import). Org/heartbeat delegates to it inside its existing `environmentRuntime.environmentId` gate with `heartbeat-execution-target.test.ts` still green, and crew + Commander both resolve a `provider-sandbox` `executionTarget` on `cloud_auth` from a **null** env via the real orchestrator + U1 platform default (integration test green: `acquired.sandbox.environment.driver === "sandbox"`, S5), while `local`/desktop resolves `{type:"local"}` unchanged (the orchestrator throws `environment_not_found`, the helper returns `sandbox:null`). The returned `lease` is the real `EnvironmentLease` (`provider`/`providerLeaseId`/`metadata`, S6).
- **`brokered` is SET, not merely declared (S7):** every sandbox dispatch — crew (claude + codex, `runner.ts:435`/`:443`), org heartbeat (`heartbeat-mcp.ts:131`/`:103`), and Commander (`cli-mode.ts:514`/`:610`) — sets `brokered = acquired.sandbox?.environment.driver === "sandbox"` + `apiBaseUrl` + `companyId` on its `McpConfigParams` **before** the MCP config is built. The `brokered-mcp-no-db-url.integration.test.ts` proves a non-test-forced sandbox dispatch stages an `aoa` server as a `type:"http"` control-plane entry with **no `DATABASE_URL`** (and no `postgres://` string) in either the claude `--mcp-config` JSON or the codex `config.toml` — covering the standalone `buildMcpBridgeSpec` path so the leak is closed for non-claude adapters too. On desktop (no sandbox → `brokered:false`) the stdio delivery with `DATABASE_URL` is byte-identical to pre-U4b.
- `buildSandboxEnvAllowlist(overlay, { provider })` (canonical S2 signature) proves — in unit and adapter-level tests — that `DATABASE_URL`, `DIRECT_DATABASE_URL`, `AOA_SECRETS_MASTER_KEY(_FILE)`, `GITHUB_PAT`, `BETTER_AUTH_SECRET`, `AOA_AGENT_JWT_SECRET`, `REDIS_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, the OAuth refresh token, and the signed bundle are **absent** from VM env, while the run-JWT (`AOA_API_KEY`/`PAPERCLIP_API_KEY`), the company provider key, run-identity, and `AOA_MCP_*_TOKEN` bearers are present. The builder only filters the caller-built overlay; it injects no credential.
- The `OPENAI_API_KEY` disambiguation is locked by the interlock test: claude run → absent; codex run → only the agent's own key, never the embeddings key.
- On cloud with no company provider key, `resolveProviderCredential` throws `ProviderUnavailableError`; the crew top-level catch maps it to `CloudProviderKeyMissingError` guidance and threads that single message into **both** the `internalAgentRuns` failure row (`:1358`, no longer re-materialized from the raw `err`) and the `postCrewRunFailure` card in the thread; Commander yields a guidance `error` before spawning; and neither spends a sandbox — while on desktop the resolver returns `host_login_fallback` and the mapper is a no-op.
- Operator `~/.claude` provisioning is proven unreachable for a sandbox target (invariant assertion + `provisionClaudeConfigHome` never-called test).
- Full server + adapter-utils + claude-local suites green; `pnpm typecheck` clean.

**PR-cut note:** This wave is **not** a standalone PR cut — per §11 build order it lands together with Wave 1 (U9+U1) and the Wave 3 broker (U2+U3+U2d); U4b's `brokered` flag is inert until U2d's honoring code (bridge-spec `DATABASE_URL` suppression + HTTP `aoa` entry) is present, and the sandbox path is not usable end-to-end until the broker moves DB access off the VM and U8 (the last unit) flips the D1 guard. The natural PR-cut point remains after U8. Wave 2's value is that crew + Commander now acquire a real sandbox lease with a hardened env, a brokered (non-DB-leaking) MCP transport, and enforced cloud auth, on top of the still-refusing guard.
