# E2B Cloud Execution Isolation — Implementation Plan (Wave 6: wave6-warm)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec (authoritative):** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Execute waves in order 0→7; U8 / guard-flip is LAST.** Each wave is an independently testable PR-cut candidate.

---

## Wave 6 — Warm-reuse lifecycle

**Goal:** Layer hybrid statefulness on top of the ephemeral sandbox foundation from earlier waves — pause (snapshot) a sandbox at run end instead of killing it, resume it on the agent's next run, and bound accumulation with an idle reaper and a per-company cap. Ephemeral remains the default and the safe fallback; warm is opt-in by type and override. **Covers U7 only.**

This wave builds on: the `reuseLease` flag already parsed by `createE2bSandboxRuntimeProvider` (`sandbox-provider-runtime.ts:186,201,448-452` — it already `pause()`s vs `kill()`s on release), the `environment_leases` table (`packages/db/src/schema/environment_leases.ts`), the acquire path (`environmentRunOrchestrator(db).acquireForRun` → `environmentRuntimeService.acquireRunLease`), and the release path (`environmentRuntimeService(db).releaseRunLeases(run.id)`, called at `heartbeat.ts:2398/2643/2706/5398`). Today `leasePolicy` is hardcoded `"ephemeral"` at every acquire site and there is **no resume path** (acquire always `Sandbox.create`) — this wave adds all of it.

**Design invariants this wave must enforce (from §7 + §8 + §9):**
- Warm ON only for **org `software_development`** agents (type default, instance-configurable); **crew (`kind='aoa'`) ALWAYS ephemeral, never warm**; **Commander (no `functionType`) ephemeral**.
- Per-agent override (org only) can force warm on/off; it **cannot** make crew warm.
- **#884 workaround:** pause **once per agent turn** (at run end only), never mid-run; a resume that finds a dead/GC'd sandbox falls back to **create-fresh transparently — never errors the run**.
- Idle reaper destroys any sandbox paused longer than a TTL (**default ≈30 min**, instance-configurable + per-agent-overridable).
- Per-company cap on live+paused sandboxes; acquiring past the cap **evicts the oldest paused sandbox** (never blocks a run).
- On warm `resume()`, the OAuth connector token is **re-resolved + re-injected** — a paused sandbox's stale env token is never trusted.

---

### Task: U7.1 — Warm lease persistence (schema + shared constants)

Add the columns and status/policy literals the warm lifecycle needs to find an agent's paused sandbox on its next run.

**Files:**
- Modify: `packages/db/src/schema/environment_leases.ts`
- Modify: `packages/shared/src/constants.ts` (`ENVIRONMENT_LEASE_STATUSES`, `ENVIRONMENT_LEASE_POLICIES`)
- Modify: `packages/shared/src/types/environment.ts` (lease type carries new fields)
- Create (generated): `packages/db/drizzle/0204_*.sql` via `pnpm db:generate` (next number after `0203`)
- Test: `packages/db/src/__tests__/environment-leases-schema.test.ts` (new; structural)

**Steps:**

1. **Write the failing test.** In `environment-leases-schema.test.ts`, import `{ environmentLeases }` and assert the new columns exist and the shared unions carry the new literals:
   ```ts
   import { environmentLeases } from "@armyofagents/db";
   import { ENVIRONMENT_LEASE_STATUSES, ENVIRONMENT_LEASE_POLICIES } from "@armyofagents/shared";
   it("carries warm-reuse columns", () => {
     expect(environmentLeases.agentId).toBeDefined();
     expect(environmentLeases.pausedAt).toBeDefined();
   });
   it("has a paused status and reuse_by_agent policy", () => {
     expect(ENVIRONMENT_LEASE_STATUSES).toContain("paused");
     expect(ENVIRONMENT_LEASE_POLICIES).toContain("reuse_by_agent");
   });
   ```
2. **Run it — expect FAIL** (`pnpm --filter @armyofagents/db test` + shared test): columns and literals absent.
3. **Implement (shared).** In `constants.ts:458` add `"paused"` to `ENVIRONMENT_LEASE_STATUSES` (→ `["active","released","expired","failed","retained","paused"]`) and at `:461` add `"reuse_by_agent"` to `ENVIRONMENT_LEASE_POLICIES`. `EnvironmentLeaseStatus`/`EnvironmentLeasePolicy` derive automatically. Note in a comment: `paused` = E2B snapshot held for warm resume (`releasedAt` stays NULL so the reaper/lookup can find it), distinct from the pre-existing `retained`.
4. **Implement (schema).** In `environment_leases.ts` add:
   ```ts
   agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
   pausedAt: timestamp("paused_at", { withTimezone: true }),
   ```
   (import `agents` from `./agents.js`), plus an index for the warm lookup and the reaper:
   ```ts
   companyAgentEnvironmentStatusIdx: index("environment_leases_company_agent_environment_status_idx")
     .on(table.companyId, table.agentId, table.environmentId, table.status),
   pausedReaperIdx: index("environment_leases_paused_reaper_idx").on(table.status, table.pausedAt),
   ```
5. **Implement (type).** In `packages/shared/src/types/environment.ts` add `agentId: string | null;` and `pausedAt: string | null;` to the `EnvironmentLease` shape (mirroring `heartbeatRunId`/`releasedAt`).
6. **Generate the migration.** Run `pnpm db:generate`. Verify the emitted SQL only `ADD COLUMN` + `CREATE INDEX` (additive, nullable — safe on a populated table). Do NOT hand-edit DDL (Critical Rule #1).
7. **Run — expect PASS** (schema test + `pnpm db:generate` no-drift check).
8. **Commit:** `feat(environments): warm-reuse lease columns (agentId, pausedAt, paused status, reuse_by_agent policy)`

---

### Task: U7.2 — Warm-policy resolver (pure function)

A single pure resolver so org/crew/Commander cannot drift on the warm decision. Default-by-type + per-agent override + instance default, with crew/Commander hard-wired ephemeral.

**Files:**
- Create: `server/src/services/warm-sandbox-policy.ts`
- Test: `server/src/__tests__/warm-sandbox-policy.test.ts`

**Steps:**

1. **Write the failing test.** Encode the full truth table from §7:
   ```ts
   import { resolveWarmSandboxPreference } from "../services/warm-sandbox-policy.js";
   const base = { instanceDefaultWarmForSoftwareDev: true };
   it("org software_development defaults warm", () => {
     expect(resolveWarmSandboxPreference({ ...base, runType: "org", functionType: "software_development", agentWarmOverride: null }).warm).toBe(true);
   });
   it("org non-software_development is ephemeral", () => {
     expect(resolveWarmSandboxPreference({ ...base, runType: "org", functionType: "marketing", agentWarmOverride: null }).warm).toBe(false);
   });
   it("per-agent override forces warm off for a software_development org agent", () => {
     expect(resolveWarmSandboxPreference({ ...base, runType: "org", functionType: "software_development", agentWarmOverride: false }).warm).toBe(false);
   });
   it("per-agent override forces warm on for a non-software_development org agent", () => {
     expect(resolveWarmSandboxPreference({ ...base, runType: "org", functionType: "marketing", agentWarmOverride: true }).warm).toBe(true);
   });
   it("instance default off suppresses the type default", () => {
     expect(resolveWarmSandboxPreference({ instanceDefaultWarmForSoftwareDev: false, runType: "org", functionType: "software_development", agentWarmOverride: null }).warm).toBe(false);
   });
   it("CREW is ALWAYS ephemeral — override cannot make it warm", () => {
     const r = resolveWarmSandboxPreference({ ...base, runType: "crew", functionType: "software_development", agentWarmOverride: true });
     expect(r.warm).toBe(false);
     expect(r.reason).toBe("crew_always_ephemeral");
   });
   it("Commander is always ephemeral", () => {
     expect(resolveWarmSandboxPreference({ ...base, runType: "commander", functionType: null, agentWarmOverride: null }).warm).toBe(false);
   });
   ```
2. **Run it — expect FAIL** (module absent).
3. **Implement.** In `warm-sandbox-policy.ts`:
   ```ts
   export type WarmRunType = "org" | "crew" | "commander";
   export interface WarmSandboxPolicyInput {
     runType: WarmRunType;
     functionType: string | null;
     agentWarmOverride: boolean | null;      // agent.runtimeConfig.warmWorkspace
     instanceDefaultWarmForSoftwareDev: boolean;
   }
   export interface WarmSandboxDecision { warm: boolean; reason: string; }

   export function resolveWarmSandboxPreference(i: WarmSandboxPolicyInput): WarmSandboxDecision {
     // Hard rules first — crew/Commander can never be warm in v1 (spec §7).
     if (i.runType === "crew") return { warm: false, reason: "crew_always_ephemeral" };
     if (i.runType === "commander") return { warm: false, reason: "commander_always_ephemeral" };
     // Org: per-agent override wins either way.
     if (i.agentWarmOverride === true) return { warm: true, reason: "agent_override_on" };
     if (i.agentWarmOverride === false) return { warm: false, reason: "agent_override_off" };
     // Type default, gated by the instance baseline.
     const typeDefault = i.functionType === "software_development" && i.instanceDefaultWarmForSoftwareDev;
     return { warm: typeDefault, reason: typeDefault ? "type_default_software_development" : "type_default_ephemeral" };
   }

   export function readAgentWarmOverride(runtimeConfig: unknown): boolean | null {
     const rc = runtimeConfig && typeof runtimeConfig === "object" ? runtimeConfig as Record<string, unknown> : {};
     return typeof rc.warmWorkspace === "boolean" ? rc.warmWorkspace : null;
   }
   ```
   `readAgentWarmOverride` reads `agents.runtimeConfig.warmWorkspace` (jsonb, `agents.ts:34`) following the `contextMode`/`autoRunSummary` runtimeConfig convention.
4. **Run — expect PASS.**
5. **Commit:** `feat(sandbox): pure warm-sandbox policy resolver (default-by-type + override + instance default; crew/commander ephemeral)`

---

### Task: U7.3 — Instance + reaper settings surface

Add the operator baseline (warm-for-software-dev on/off, idle-TTL minutes) and the per-company cap constant.

**Files:**
- Modify: `packages/shared/src/validators/instance.ts` (`instanceExperimentalSettingsSchema`)
- Modify: `server/src/services/instance-settings.ts` (`normalizeExperimentalSettings`)
- Create: `server/src/services/warm-sandbox-constants.ts`
- Test: `server/src/__tests__/instance-settings-warm.test.ts` (new); extend `warm-sandbox-policy.test.ts` for the clamp

**Steps:**

1. **Write the failing test.** Assert defaults and clamping:
   ```ts
   import { normalizeWarmIdleTtlMinutes, WARM_SANDBOX_MAX_PER_COMPANY_DEFAULT } from "../services/warm-sandbox-constants.js";
   it("defaults warm idle TTL to 30 minutes", () => {
     expect(normalizeWarmIdleTtlMinutes(undefined)).toBe(30);
   });
   it("clamps warm idle TTL to a sane range", () => {
     expect(normalizeWarmIdleTtlMinutes(0)).toBe(30);      // falsy → default
     expect(normalizeWarmIdleTtlMinutes(100000)).toBe(1440); // cap at 24h
   });
   it("defaults the per-company warm cap", () => {
     expect(WARM_SANDBOX_MAX_PER_COMPANY_DEFAULT).toBe(5);
   });
   ```
   And an instance-settings test asserting `getExperimental()` returns `warmSandboxDefaultForSoftwareDev: true` and `warmSandboxIdleTtlMinutes: 30` by default.
2. **Run it — expect FAIL.**
3. **Implement (constants).** In `warm-sandbox-constants.ts`:
   ```ts
   export const WARM_SANDBOX_MAX_PER_COMPANY_DEFAULT = 5;   // bounds live+paused sandboxes/company (sibling of D5 HEARTBEAT_MAX_CONCURRENT_RUNS)
   export const WARM_SANDBOX_IDLE_TTL_MINUTES_DEFAULT = 30;
   export function normalizeWarmIdleTtlMinutes(v: unknown): number {
     const n = Math.floor(typeof v === "number" ? v : Number(v));
     if (!Number.isFinite(n) || n <= 0) return WARM_SANDBOX_IDLE_TTL_MINUTES_DEFAULT;
     return Math.max(1, Math.min(1440, n));
   }
   ```
4. **Implement (validators).** In `instance.ts:36` add to `instanceExperimentalSettingsSchema`:
   ```ts
   warmSandboxDefaultForSoftwareDev: z.boolean().default(true),
   warmSandboxIdleTtlMinutes: z.number().int().positive().default(30),
   enableWarmSandboxReaper: z.boolean().default(true),
   ```
5. **Implement (service).** In `instance-settings.ts` `normalizeExperimentalSettings` (both success and fallback branches, `:59-69`) add the three fields with the same defaults so `getExperimental()` always returns them.
6. **Run — expect PASS.**
7. **Commit:** `feat(instance): warm-sandbox operator settings (default-for-software-dev, idle TTL, reaper toggle) + per-company cap constant`

---

### Task: U7.4 — Provider resume + pause-persist mechanics

Give the sandbox provider a `resumeLease` operation (E2B `Sandbox.connect` auto-resumes a paused snapshot) that signals **dead → create-fresh** rather than throwing, and prove `releaseLease` already pauses-not-kills under `reuseLease`.

**Files:**
- Modify: `server/src/services/sandbox-provider-runtime.ts` (interface + fake + E2B provider + registry passthrough)
- Test: extend `server/src/__tests__/sandbox-provider-runtime.test.ts`

**Steps:**

1. **Write the failing tests.** Add to the E2B suite:
   ```ts
   it("resumes a paused E2B sandbox by connecting to its id", async () => {
     const connect = vi.fn(async () => ({ sandboxId: "e2b-1", sandboxDomain: "d", commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: "/home/user\n", stderr: "" })) }, setTimeout: vi.fn() }));
     const provider = createE2bSandboxRuntimeProvider({ importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }), env: { E2B_API_KEY: "k" } });
     const r = await provider.resumeLease!({ providerLeaseId: "e2b-1", leaseMetadata: { template: "base", timeoutMs: 60000, reuseLease: true }, config: null });
     expect(r.resumed).toBe(true);
     expect(connect).toHaveBeenCalledWith("e2b-1", { apiKey: "k", timeoutMs: 60000 });
   });
   it("reports resumed:false (create-fresh) when the paused sandbox is gone — never throws", async () => {
     class SandboxNotFoundError extends Error {}
     const connect = vi.fn(async () => { throw new SandboxNotFoundError("gone"); });
     const provider = createE2bSandboxRuntimeProvider({ importE2b: async () => ({ Sandbox: { create: vi.fn(), connect }, SandboxNotFoundError }), env: { E2B_API_KEY: "k" } });
     await expect(provider.resumeLease!({ providerLeaseId: "dead", leaseMetadata: { reuseLease: true }, config: null }))
       .resolves.toMatchObject({ resumed: false });
   });
   it("pauses (not kills) on release when reuseLease is true", async () => {
     const pause = vi.fn(async () => undefined); const kill = vi.fn(async () => undefined);
     const connect = vi.fn(async () => ({ commands: { run: vi.fn() }, pause, kill }));
     const provider = createE2bSandboxRuntimeProvider({ importE2b: async () => ({ Sandbox: { create: vi.fn(), connect } }), env: { E2B_API_KEY: "k" } });
     await provider.releaseLease({ providerLeaseId: "e2b-1", leaseMetadata: { reuseLease: true }, config: { reuseLease: true } });
     expect(pause).toHaveBeenCalled(); expect(kill).not.toHaveBeenCalled();
   });
   ```
   Add a fake-provider test: `resumeLease` echoes `resumed:true` unless `leaseMetadata.__dead === true` → `resumed:false` (so higher-level tests can simulate a GC'd sandbox).
2. **Run — expect FAIL** (`resumeLease` undefined).
3. **Implement (interface).** Add to `sandbox-provider-runtime.ts`:
   ```ts
   export interface SandboxProviderResumeInput { providerLeaseId: string; leaseMetadata: Record<string, unknown> | null; config?: Record<string, unknown> | null; }
   export interface SandboxProviderResumeResult { resumed: boolean; providerLeaseId: string; metadata: Record<string, unknown>; }
   ```
   Add optional `resumeLease?(input): Promise<SandboxProviderResumeResult>` to `SandboxRuntimeProvider`, and a passthrough in `sandboxProviderRuntime` (mirroring `execute`, guarded so a provider without it throws a clear "provider does not support resume").
4. **Implement (E2B).** Add `resumeLease` to `createE2bSandboxRuntimeProvider`: `configFromE2bLease` → `connect(config, providerLeaseId)` (reuse the existing `connect` closure at `:347`), `await sandbox.setTimeout?.(config.timeoutMs)`, rebuild metadata via `buildE2bLeaseMetadata`, return `{ resumed: true, providerLeaseId, metadata }`. Wrap in try/catch: `SandboxNotFoundError` **or any other error** → `logger`-warn and return `{ resumed: false, providerLeaseId, metadata: { deadOnResume: true } }` (honor §8 "never error the run"). The `pause()` path in `releaseLease` (`:448-452`) already exists — leave it.
5. **Implement (fake).** `resumeLease` returns `resumed: input.leaseMetadata?.__dead !== true` echoing the id.
6. **Run — expect PASS.**
7. **Commit:** `feat(sandbox): provider resumeLease op (connect auto-resume; dead sandbox → create-fresh signal, never throws)`

---

### Task: U7.5 — Warm acquire/release wiring (environment-runtime + environments + orchestrator + org call site)

Thread the warm preference + agentId into the acquire path, resume a paused lease when one exists, pause-not-kill on release, and enforce the per-company cap on create.

**Files:**
- Modify: `server/src/services/environments.ts` (extend the existing `acquireLease` (`:104-152`) to accept + persist `agentId`; new lease queries: `findResumablePausedLease`, `listLiveAndPausedProviderLeasesForCompany`, `markLeasePaused`, `reactivatePausedLease`)
- Modify: `server/src/services/environment-runtime.ts` (`EnvironmentDriverAcquireInput` gains `warmPreference` + `agentId`; `createSandboxDockerEnvironmentDriver.acquireRunLease` resume-or-create + pass `agentId` into `acquireLease`; `releaseRunLease` pause-vs-kill — pass `{ ...providerConfig, reuseLease: true }` on the reuse branch)
- Modify: `server/src/services/environment-run-orchestrator.ts` (`acquireForRun` accepts + forwards `warmPreference` + `agentId`)
- Modify: `server/src/services/heartbeat.ts` (compute `warmPreference` at the `acquireForRun` call site, `:4181`)
- Test: `server/src/__tests__/environment-runtime.test.ts` (extend); `server/src/__tests__/environment-warm-acquire.integration.test.ts` (new, embedded-PG)

**Steps:**

1. **Write the failing unit test** (mock DB + fake provider). In `environment-runtime.test.ts`:
   ```ts
   it("resumes an existing paused lease for a warm agent instead of creating", async () => {
     // environments stub returns a paused e2b lease for (company, agent, env)
     // provider.resumeLease → resumed:true
     const rec = await runtime.acquireRunLease({ companyId, environment: e2bEnv, agentId: "a1", warmPreference: true, issueId: "i1", heartbeatRunId: "r2", persistedExecutionWorkspace: null });
     expect(createSpy).not.toHaveBeenCalled();
     expect(resumeSpy).toHaveBeenCalled();
     expect(rec.lease.leasePolicy).toBe("reuse_by_agent");
   });
   it("falls back to create-fresh when resume finds a dead sandbox — run does not error", async () => {
     resumeSpy.mockResolvedValue({ resumed: false, providerLeaseId: "dead", metadata: { deadOnResume: true } });
     const rec = await runtime.acquireRunLease({ ...warmInput, heartbeatRunId: "r3" });
     expect(createSpy).toHaveBeenCalled();          // transparent create-fresh
     expect(rec.lease.status).toBe("active");
   });
   it("pauses (status=paused, releasedAt null) on release of a reuse_by_agent lease", async () => {
     const released = await runtime.releaseRunLease({ environment: e2bEnv, lease: warmLease, status: "released" });
     expect(released?.status).toBe("paused");
     expect(pauseProviderSpy).toHaveBeenCalled();   // reuseLease → provider pauses
   });
   it("kills (status=released) on release of an ephemeral lease", async () => {
     const released = await runtime.releaseRunLease({ environment: e2bEnv, lease: ephemeralLease, status: "released" });
     expect(released?.status).toBe("released");
   });
   ```
2. **Run — expect FAIL** (no `warmPreference`/`agentId` on the input; no resume branch).
3. **Implement (environments.ts queries).** Add to `environmentService`:
   - **Extend the existing `acquireLease` (`environments.ts:104-152`) to persist `agentId`.** Today its `input` type carries no `agentId` and its `.values({...})` insert never sets the column — so a warm create writes `agent_id = NULL` and `findResumablePausedLease` (keyed on `agentId`) can never match, making warm reuse **silently inert**. Add `agentId?: string | null;` to the `acquireLease` input type (alongside `heartbeatRunId`/`providerLeaseId`) and `agentId: input.agentId ?? null,` to the `.values({...})` object (mirroring `heartbeatRunId: input.heartbeatRunId ?? null`). Ephemeral callers omit it → `null`, byte-identical to today.
   - `findResumablePausedLease({ companyId, agentId, environmentId })` → newest `environment_leases` row where `status="paused"` AND `agentId`/`companyId`/`environmentId` match AND `providerLeaseId` is not null (uses the new `companyAgentEnvironmentStatusIdx`).
   - `reactivatePausedLease(id, { heartbeatRunId, issueId, executionWorkspaceId })` → `UPDATE … SET status='active', pausedAt=null, heartbeatRunId=…, issueId=…, lastUsedAt=now, updatedAt=now WHERE id=… AND status='paused' RETURNING *` (guarded on `status='paused'` so two concurrent runs can't both claim it — one gets the row, the other falls through to create-fresh).
   - `markLeasePaused(id, { cleanupStatus })` → `SET status='paused', pausedAt=now, releasedAt=null, lastUsedAt=now`.
   - `listLiveAndPausedProviderLeasesForCompany(companyId)` → rows where `status IN ('active','paused')` AND `provider` is a non-docker provider (for the cap), ordered by `pausedAt asc nulls last`.
4. **Implement (environment-runtime acquire).** Extend `EnvironmentDriverAcquireInput` with `warmPreference?: boolean` and `agentId?: string | null`. In `createSandboxDockerEnvironmentDriver.acquireRunLease`, inside the non-docker provider branch (`:328`):
   - If `input.warmPreference && input.agentId`: `const paused = await environmentsSvc.findResumablePausedLease(...)`. If found, `const r = await providerRuntime.resumeLease(provider, { providerLeaseId: paused.providerLeaseId, leaseMetadata: paused.metadata?.providerMetadata ?? null, config: providerConfig })`. If `r.resumed`, `reactivatePausedLease(paused.id, { heartbeatRunId, issueId, … })` and return it; else `markLeasePaused`→`releaseLease(status:"expired", cleanupStatus:"success")` on the dead row and fall through to create.
   - **Before creating a fresh warm sandbox:** enforce the cap — `const live = await environmentsSvc.listLiveAndPausedProviderLeasesForCompany(companyId)`; if `live.length >= cap`, evict the oldest **paused** entry (call the shared eviction from U7.6) — never block; if none are paused (all active), proceed anyway (cap is a soft ceiling on accumulation, not a run gate).
   - When creating warm: pass `providerConfig.reuseLease = true`, and call `environmentsSvc.acquireLease({ …, leasePolicy: "reuse_by_agent", agentId: input.agentId })` (the `agentId` passthrough added in step 3 above — without it the paused lease stores `agent_id = NULL` and never resumes). Ephemeral path stays byte-identical (`leasePolicy: "ephemeral"`, no `reuseLease`, no `agentId`).
5. **Implement (environment-runtime release).** In `createSandboxDockerEnvironmentDriver.releaseRunLease` (`:400-432`): if `readString(input.lease.leasePolicy) === "reuse_by_agent"` (or `metadata.reuseLease === true`), call `providerRuntime.releaseLease` and then `environmentsSvc.markLeasePaused(input.lease.id, { cleanupStatus: released.cleanupStatus })` instead of `releaseLease(...,status)`. **Critical:** the release path resolves `providerConfig` **fresh** from the environment via `resolveRuntimeProviderConfig` (`environment-runtime.ts:404-411`) — and that config does **not** carry `reuseLease:true` (the environment row is the ephemeral base template; `reuseLease` lives on the *lease*, not the environment). Since `configFromE2bLease` resolves `reuseLease: config.reuseLease ?? metadata.reuseLease` (`sandbox-provider-runtime.ts:320`) and the E2B `releaseLease` pauses only when `config.reuseLease` is truthy (`sandbox-provider-runtime.ts:448-452`), you **must explicitly pass** `providerRuntime.releaseLease(provider, { providerLeaseId, leaseMetadata, config: { ...providerConfig, reuseLease: true } })` on this reuse branch — otherwise it **kills instead of pauses** and warm reuse is dead. (Mirror-image of U7.6 step 3, which forces `reuseLease: false` on the `forceDestroy` reaper path.) Ephemeral path unchanged (kill + `released`). `releaseRunLeases` (the run-teardown loop, `:477`) drives this via `getDriver(env).releaseRunLease` — no change needed there beyond passing the real environment (already does).
6. **Implement (orchestrator).** In `environment-run-orchestrator.ts` `acquireForRun` input, add `warmPreference: boolean` + `agentId: string | null`; forward both into `runtime.acquireRunLease({ … })` (`:206`).
7. **Implement (org call site).** In `heartbeat.ts` before `acquireForRun` (`:4181`): resolve `functionType` from the agent's project (`projects.functionType`, `projects.ts:20`), read `readAgentWarmOverride(agent.runtimeConfig)`, read `instanceSettingsService(db).getExperimental()` → `warmSandboxDefaultForSoftwareDev`, call `resolveWarmSandboxPreference({ runType: "org", functionType, agentWarmOverride, instanceDefaultWarmForSoftwareDev })`, and pass `warmPreference: decision.warm, agentId: agent.id` into `acquireForRun`. (Crew + Commander call sites — added in the U4 `acquireExecutionContext` helper — pass `warmPreference: false`; add a one-line assertion in the U4 helper's tests that crew/Commander never pass `true`, cross-referencing U7.2.)
8. **Write the integration test** (`environment-warm-acquire.integration.test.ts`, embedded-PG, fake sandbox provider via the `importE2b` seam): create an e2b `environments` row; run 1 with `warmPreference:true` → lease `active`+`reuse_by_agent`; release → lease `paused`, `pausedAt` set, `releasedAt` NULL; run 2 same agent → **resume** the same `providerLeaseId`, no new lease row; simulate dead (fake `__dead`) → run 3 creates a fresh lease and does not throw.
9. **Run — expect PASS** (unit + integration).
10. **Commit:** `feat(environments): warm acquire/release — resume paused lease per agent, pause-not-kill at run end, create-fresh on dead resume`

---

### Task: U7.6 — Idle reaper + per-company cap eviction

Destroy sandboxes paused past the TTL and provide the evict-oldest-paused primitive the acquire path calls when the per-company cap is hit.

**Files:**
- Create: `server/src/services/warm-sandbox-reaper.ts`
- Modify: `server/src/services/environments.ts` (reuse `listLiveAndPausedProviderLeasesForCompany` + add `listPausedLeasesOlderThan`)
- Modify: `server/src/index.ts` (schedule the reaper alongside the TTL sweeper, `:831`)
- Test: `server/src/__tests__/warm-sandbox-reaper.test.ts` (unit, mock DB + fake provider); extend the integration test from U7.5

**Steps:**

1. **Write the failing test.**
   ```ts
   it("destroys sandboxes paused longer than the idle TTL", async () => {
     // paused lease with pausedAt = now - 45min, instance ttl = 30min
     const res = await sweepIdleWarmSandboxes(db);
     expect(res.reaped).toBe(1);
     expect(releaseProviderSpy).toHaveBeenCalled();     // provider kill (reuseLease=false on the reaper release)
     // lease row now status=expired, cleanupStatus=success
   });
   it("leaves sandboxes paused within the TTL untouched", async () => {
     // pausedAt = now - 5min
     expect((await sweepIdleWarmSandboxes(db)).reaped).toBe(0);
   });
   it("no-ops when the reaper flag is off", async () => {
     // getExperimental().enableWarmSandboxReaper = false
     expect((await sweepIdleWarmSandboxes(db)).reaped).toBe(0);
   });
   it("evictOldestPausedSandbox destroys the oldest paused lease and never touches active ones", async () => {
     const evicted = await evictOldestPausedSandbox(db, companyId);
     expect(evicted?.id).toBe(oldestPausedId);
   });
   ```
2. **Run — expect FAIL** (module absent).
3. **Implement.** In `warm-sandbox-reaper.ts`, modeled on `workspace-ttl-sweeper.ts`:
   - `sweepIdleWarmSandboxes(db)`: read `getExperimental()`; if `!enableWarmSandboxReaper` return `{ scanned:0, reaped:0 }`. Resolve `ttl = normalizeWarmIdleTtlMinutes(experimental.warmSandboxIdleTtlMinutes)`. For each company (or globally via a single `status='paused' AND pausedAt < cutoff` query using `pausedReaperIdx`), destroy each: `getDriver(env).releaseRunLease({ environment, lease, status: "expired" })` **forcing kill** — pass a `forceDestroy` flag so the release path calls `providerRuntime.releaseLease` with `config.reuseLease = false` (a reaped lease must be killed, not re-paused). Mark the row `expired` + `cleanupStatus`. Best-effort per-lease try/catch (mirror the sweeper's `logger.warn`).
   - `evictOldestPausedSandbox(db, companyId)`: `listLiveAndPausedProviderLeasesForCompany` → pick the oldest `status='paused'` by `pausedAt asc`; destroy it the same way; return the evicted lease or null. Called by U7.5 step 4 when `live.length >= cap`.
   - `scheduleWarmSandboxReaper(db, intervalMs = 5 * 60 * 1000)`: `setInterval` mirroring `scheduleTtlSweeper` (`workspace-ttl-sweeper.ts:218`), catch+log. A 5-min tick with a 30-min TTL bounds idle cost while staying cheap.
   - Add the `forceDestroy` branch to `createSandboxDockerEnvironmentDriver.releaseRunLease` (U7.5): when `input.forceDestroy === true`, ignore `leasePolicy` and always kill (build `providerConfig` with `reuseLease:false`).
4. **Wire the schedule.** In `index.ts` after `scheduleTtlSweeper(db as any)` (`:831`), add `scheduleWarmSandboxReaper(db as any);` with an explaining comment (no-ops when the flag is off, like the TTL sweeper).
5. **Run — expect PASS.**
6. **Commit:** `feat(sandbox): idle warm-sandbox reaper (~30min TTL) + per-company cap evict-oldest-paused`

---

### Task: U7.7 — OAuth connector token re-resolution on warm resume (invariant)

A paused sandbox's env holds a stale, bounded-TTL `AOA_MCP_*_TOKEN` (#317). On warm resume the host must re-resolve + re-inject it; the stale one is never trusted. Encode this as the guard that resume goes through the same stage-in env build as create.

**Files:**
- Modify: `server/src/services/environment-runtime.ts` (resume returns a fresh lease record so the caller's stage-in re-runs; assert no reuse of `paused.metadata` env)
- Test: `server/src/__tests__/warm-resume-connector-token.test.ts` (new)

**Steps:**

1. **Write the failing test.** Simulate a warm resume where the paused lease metadata carries an old connector token and assert the resumed run's injected env comes from a fresh re-resolution, and the stale token is absent:
   ```ts
   it("re-resolves the connector token on warm resume — stale paused-env token is never reused", async () => {
     // paused lease metadata.providerMetadata.env carries AOA_MCP_NOTION_TOKEN="stale"
     // host connector resolver returns "fresh" at resume-time stage-in
     const staged = await acquireAndStageWarmResume({ agentId: "a1", warmPreference: true });
     expect(staged.env.AOA_MCP_NOTION_TOKEN).toBe("fresh");
     expect(JSON.stringify(staged.env)).not.toContain("stale");
   });
   it("resume never carries env forward from the paused lease metadata", async () => {
     const rec = await runtime.acquireRunLease({ ...warmInput });
     // the returned lease record exposes NO pre-baked env — stage-in (U5/U6) rebuilds it every run
     expect((rec.lease.metadata as any)?.env).toBeUndefined();
   });
   ```
2. **Run — expect FAIL** (if resume copies `paused.metadata` env forward).
3. **Implement.** Ensure `reactivatePausedLease` (U7.5) does **not** copy any `env`/token fields from the paused row into the returned lease — it only reactivates status/run-linkage. The env for the run is built fresh at stage-in (the U5 allowlist + U6/connector re-resolution added in earlier waves), which already runs on **every** `acquireForRun` return regardless of create-vs-resume. Add a defensive assertion/comment in `reactivatePausedLease` and strip any `providerMetadata.env` before returning. Cross-reference §7 ("re-resolves + re-injects the connector token at every stage-in — including on warm `resume()`") and §9 (only the minted short-lived access token crosses; refresh token/signed bundle stay host-side).
4. **Run — expect PASS.**
5. **Commit:** `fix(sandbox): warm resume re-resolves connector tokens at stage-in — never trust a paused sandbox's stale env token`

---

**Wave 6 exit criteria:**
- `resolveWarmSandboxPreference` unit table passes: org `software_development` → warm; org other → ephemeral; per-agent override wins both ways; **crew and Commander are ALWAYS ephemeral** (override cannot flip them).
- Instance settings expose `warmSandboxDefaultForSoftwareDev` / `warmSandboxIdleTtlMinutes` (default 30) / `enableWarmSandboxReaper`; `WARM_SANDBOX_MAX_PER_COMPANY_DEFAULT = 5`.
- Provider `resumeLease` resumes a live snapshot and returns `resumed:false` (never throws) for a dead/GC'd sandbox; `releaseLease` pauses under `reuseLease`, kills otherwise — all via the `importE2b` fake seam (no live E2B in CI).
- Embedded-PG integration proof: warm agent run 1 → `active`/`reuse_by_agent`; release → `paused` (`pausedAt` set, `releasedAt` NULL); run 2 → **resume** the same `providerLeaseId`, no new lease row; simulated dead sandbox → transparent create-fresh, run does not error.
- Idle reaper destroys leases paused past the TTL and no-ops when the flag is off; `evictOldestPausedSandbox` frees a slot when the per-company cap is hit without blocking the run.
- Warm resume re-resolves the OAuth connector token at stage-in; the stale paused-env token is provably absent from the resumed run's env.
- `pnpm db:generate` shows no drift (only the additive `0204` migration); `pnpm typecheck` + the full server unit suite green.

**PR-cut note:** Wave 6 is **not** a standalone PR-cut point on its own — per §11 it is build-order step 8, layered on the ephemeral foundation (U1–U6, U12, U13) that must already be merged or stacked beneath it. It is, however, a clean **internal stage boundary**: everything here is gated on `warmPreference`/`reuse_by_agent`, so with warm disabled (instance flag off, no per-agent override) the system behaves exactly as the ephemeral foundation — making this wave safe to land incrementally ahead of the D1 guard flip (U8, Wave following).
