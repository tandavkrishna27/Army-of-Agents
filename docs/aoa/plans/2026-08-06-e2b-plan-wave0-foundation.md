# E2B Cloud Execution Isolation — Implementation Plan (Wave 0: wave0-foundation)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec:** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Shared seams:** the INDEX. Execute waves 0→7; U8/guard-flip LAST.

---

## Wave 0 — Foundation

**Goal:** Land the two inert seams the rest of the E2B project builds on — the self‑hosted `domain`/`E2B_DOMAIN` knob threaded through the E2B SDK call sites, and a platform‑default layer under the environment precedence stack — with **zero runtime behavior change** until later waves wire them. Covers **U9** (self‑hosted domain knob) and **U1** (operator‑default E2B resolution).

This wave is a **natural first PR‑cut point**: both units are additive and dormant (no current caller reaches the new code paths), so it can merge on `main` ahead of the broker/coverage work without flipping any behavior on cloud or desktop.

---

### Task: U9 — Self‑hosted `domain`/`E2B_DOMAIN` knob

Thread an optional `domain` (base‑URL) config through the three E2B SDK call sites in `sandbox-provider-runtime.ts`, mirroring exactly how `apiKey`/`E2B_API_KEY` already resolve. Unset `domain` = managed E2B (unchanged); a set `domain` = self‑hosted. The value must survive a warm lease (persisted in lease metadata, re‑read on `connect`) so `releaseLease`/`execute` on a paused sandbox still target the same host.

**Files:**
- **Modify:** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/sandbox-provider-runtime.ts`
- **Test (modify):** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/sandbox-provider-runtime.test.ts`

**Steps:**

1. **Write the failing test — managed (unset) stays clean + self‑hosted threads `domain`.** In `sandbox-provider-runtime.test.ts`, extend the existing "acquires E2B leases through an injected E2B SDK importer" block and add two new cases. The existing exact‑match assertion already encodes "managed = no `domain` key":
   ```ts
   // existing assertion — must stay exact (managed E2B injects NO domain):
   expect(create).toHaveBeenCalledWith("base", {
     apiKey: "key-from-env",
     timeoutMs: 60_000,
     metadata: { aoaProvider: "e2b", companyId: "company-1", environmentId: "env-1" },
   });

   it("threads E2B_DOMAIN into create for self-hosted", async () => {
     const create = vi.fn(async () => sandbox);
     const provider = createE2bSandboxRuntimeProvider({
       importE2b: async () => ({ Sandbox: { create, connect: vi.fn() } }),
       env: { E2B_API_KEY: "key-from-env", E2B_DOMAIN: "e2b.aoa.internal" },
     });
     await provider.acquireLease({
       companyId: "company-1", environmentId: "env-1", issueId: null, heartbeatRunId: "run-1",
       config: { provider: "e2b", template: "base", timeoutMs: 60_000, reuseLease: true },
       workspaceMode: null,
     });
     expect(create).toHaveBeenCalledWith("base", expect.objectContaining({ domain: "e2b.aoa.internal" }));
   });

   it("re-uses the lease-persisted domain on connect() for release", async () => {
     const connect = vi.fn(async () => sandbox);
     const provider = createE2bSandboxRuntimeProvider({
       importE2b: async () => ({ Sandbox: { create: vi.fn(), connect }, SandboxNotFoundError: class extends Error {} }),
       env: {}, // no E2B_DOMAIN in env — must come from lease metadata
     });
     await provider.releaseLease({
       providerLeaseId: "e2b-sandbox-1",
       leaseMetadata: { provider: "e2b", template: "base", timeoutMs: 60_000, reuseLease: false, domain: "e2b.aoa.internal" },
     });
     expect(connect).toHaveBeenCalledWith("e2b-sandbox-1", expect.objectContaining({ domain: "e2b.aoa.internal" }));
   });
   ```
   Also assert a `config.apiKey`‑style precedence: `config.domain` wins over `env.E2B_DOMAIN` (add a one‑line `resolveE2bDomain` precedence assertion).

2. **Run it — expect FAIL** (`domain` is not on `E2bDriverConfig`, not parsed, not passed to any SDK site). Command: `pnpm --filter @armyofagents/server test sandbox-provider-runtime`.

3. **Implement — add `domain` to the config type + parser + a resolver, and thread it through all three SDK sites + lease metadata.** (Grounded: `E2bDriverConfig` at l.182, `parseE2bDriverConfig` at l.195, `sanitizedE2bConfig` at l.205, `resolveE2bApiKey` at l.235, `buildE2bLeaseMetadata` at l.257, `configFromE2bLease` at l.309, `connect` SDK site at l.349, `probe` create at l.376, `acquireLease` create at l.409, and the two warm‑lease `connect(config, …)` reuse sites — `releaseLease` at l.447, `execute` at l.473.)
   - Extend the interface (l.182) — the real interface today is exactly `{ template; apiKey; timeoutMs; reuseLease }`; add `domain` between `apiKey` and `timeoutMs`:
     ```ts
     interface E2bDriverConfig {
       template: string;
       apiKey: string | null;
       domain: string | null;   // NEW — unset = managed E2B
       timeoutMs: number;
       reuseLease: boolean;
     }
     ```
   - In `parseE2bDriverConfig` (l.195): add `domain: readString(raw.domain),` (mirroring the existing `readString`‑based fields).
   - Add a resolver next to `resolveE2bApiKey` (l.235), mirroring it but **nullable** (unset is legal = managed):
     ```ts
     function resolveE2bDomain(config: E2bDriverConfig, env: Record<string, string | undefined>): string | null {
       return config.domain ?? readString(env.E2B_DOMAIN);
     }
     ```
   - Add a small helper so we never emit a `domain: undefined` key: `function e2bDomainOption(domain: string | null) { return domain ? { domain } : {}; }`.
   - `connect` (l.349) — the real body today is `return await e2b.Sandbox.connect(providerLeaseId, { apiKey: resolveE2bApiKey(config, env), timeoutMs: config.timeoutMs });`. Spread the domain in: `…, timeoutMs: config.timeoutMs, ...e2bDomainOption(resolveE2bDomain(config, env)) });`. Because `configFromE2bLease` (l.309) is what builds `config` for the `releaseLease` (l.447) and `execute` (l.473) reuse sites, threading it here covers all three warm‑lease reuse paths.
   - `probe` create (l.376) and `acquireLease` create (l.409): spread `...e2bDomainOption(resolveE2bDomain(config, env))` into the options object alongside the existing `apiKey`/`timeoutMs`/`metadata`.
   - Persist it for warm reuse: `buildE2bLeaseMetadata` (l.257) does **not** currently receive `env`, so compute the resolved domain in `acquireLease` (l.407, where `env` is in the closure scope — same `env` `resolveE2bApiKey(config, env)` reads at l.410) and pass it in: `const resolvedDomain = resolveE2bDomain(config, env);` then add `resolvedDomain` to the `buildE2bLeaseMetadata({...})` call at l.424 (extend the builder's input type with `resolvedDomain: string | null`). This captures an env‑only domain too. **Spread the domain CONDITIONALLY** inside the returned object so a managed lease gains **NO** `domain` key: `...(input.resolvedDomain ? { domain: input.resolvedDomain } : {})`. Do **not** write `domain: input.resolvedDomain` unconditionally — that emits `domain: null` on a managed lease and breaks the exact `lease.metadata` `toEqual` at `sandbox-provider-runtime.test.ts:123‑136`. Then in `configFromE2bLease` (l.309) carry it back into the `parseE2bDriverConfig({...})` call: `domain: config.domain ?? metadata.domain,` (config = passed‑in override, metadata = persisted lease record — same override order the existing `template`/`timeoutMs`/`reuseLease` lines use).
   - Surface it in `sanitizedE2bConfig` (l.205) for observability: add `selfHosted: Boolean(config.domain ?? readString(env.E2B_DOMAIN)),`. Do **not** add `domain` to `validateE2bDriverConfig` errors — it is optional.

4. **Run — expect PASS.** `pnpm --filter @armyofagents/server test sandbox-provider-runtime`. Confirm **both** managed‑path assertions still pass unchanged, proving no `domain` key leaks when unset: (a) the original exact‑match `create` assertion at l.115‑119, and (b) the exact `lease.metadata` `toEqual` at l.123‑136 — the latter goes red on a stray `domain: null`, so it is the guard that catches an unconditional spread in `buildE2bLeaseMetadata`.

5. **Commit.** `feat(e2b): thread self-hosted domain/E2B_DOMAIN knob through E2B SDK sites (U9)`

---

### Task: U1 — Operator‑default E2B (platform layer of the precedence stack)

Give `environmentRunOrchestrator` the ability to resolve a **platform‑default** E2B environment when a run resolves *no* task/agent/company environment — synthesized in‑memory from operator config, only on `cloud_auth`, only when `E2B_API_KEY` is present. This completes the precedence `task > agent > company > platform‑default`.

**Canonical seam (S1):** the exported symbol is **`resolvePlatformDefaultEnvironment`**, which returns `Environment | null` (a full synthesized `Environment` object, or `null`). There is **no** `resolvePlatformDefaultEnvironmentId` and **no** routable sentinel `environmentId` — `resolveEnvironment`'s null branch either returns the synthesized non‑null `Environment` directly (which `acquireForRun` then feeds unchanged into `runtime.acquireRunLease({ environment })` to mint the provider‑sandbox lease/target, exactly as a DB‑backed environment does) or, when the resolver returns `null`, throws `environment_not_found` as it does today. The synthesized row's `id` is a purely cosmetic in‑memory label — it is never passed to `environmentsSvc.get`, never round‑trips through the id lookup path, and carries no routing meaning.

It stays **inert**: every current caller guards `acquireForRun` behind a non‑null `environmentId` (`heartbeat.ts:4180` `if (environmentRuntime.environmentId)`, `agents.ts:677` ternary), so nothing passes `null` yet. Wiring callers to actually reach the platform default is a later wave — the platform‑default overlay is passed straight through by **U4** (`acquireExecutionContext` forwards `environmentId: input.environmentId ?? null` into `acquireForRun`), and the caller guards are removed at **U8** (guard flip, LAST).

**Files:**
- **Create:** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/platform-default-environment.ts`
- **Modify:** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/services/environment-run-orchestrator.ts`
- **Test (create):** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/platform-default-environment.test.ts`
- **Test (modify):** `C:/Users/TK/.aoa/wt/e2b-exec/server/src/__tests__/environment-run-orchestrator.test.ts`

**Steps:**

1. **Write the failing unit test for the resolver.** Create `platform-default-environment.test.ts`:
   ```ts
   import { describe, expect, it } from "vitest";
   import { resolvePlatformDefaultEnvironment } from "../services/platform-default-environment.js";

   const COMPANY = "00000000-0000-0000-0000-000000000001";

   it("synthesizes a cloud e2b platform environment when E2B_API_KEY is set", () => {
     const env = resolvePlatformDefaultEnvironment({
       companyId: COMPANY, deploymentMode: "cloud_auth",
       env: { E2B_API_KEY: "op-key", E2B_TEMPLATE: "aoa-base", E2B_DOMAIN: "e2b.aoa.internal" },
     });
     expect(env).not.toBeNull();
     expect(env!.driver).toBe("sandbox");
     expect(env!.companyId).toBe(COMPANY);
     expect(env!.config).toMatchObject({ provider: "e2b", template: "aoa-base", domain: "e2b.aoa.internal" });
     expect(env!.target).toBeNull();
     expect(env!.executionTargetId).toBeNull(); // must satisfy cloud-environment-policy
   });

   it("returns null off-cloud (desktop/local_trusted keeps host execution)", () => {
     expect(resolvePlatformDefaultEnvironment({
       companyId: COMPANY, deploymentMode: "local_trusted", env: { E2B_API_KEY: "op-key" },
     })).toBeNull();
   });

   it("returns null on cloud when no operator E2B_API_KEY is configured", () => {
     expect(resolvePlatformDefaultEnvironment({
       companyId: COMPANY, deploymentMode: "cloud_auth", env: {},
     })).toBeNull();
   });

   it("does NOT leak operator secrets into the synthesized config", () => {
     const env = resolvePlatformDefaultEnvironment({
       companyId: COMPANY, deploymentMode: "cloud_auth", env: { E2B_API_KEY: "op-key" },
     });
     // the platform key is injected at the SDK layer via E2B_API_KEY (U9-style env read),
     // never embedded in the environment row that flows through the app.
     expect(JSON.stringify(env!.config)).not.toContain("op-key");
   });
   ```

2. **Run it — expect FAIL** (module does not exist). `pnpm --filter @armyofagents/server test platform-default-environment`.

3. **Implement the resolver.** Create `platform-default-environment.ts`. The `id` const is a local cosmetic label only — deliberately **not** exported (no sentinel id surface, per S1):
   ```ts
   import type { DeploymentMode, Environment } from "@armyofagents/shared";

   // Cosmetic label only — this in-memory row is NEVER looked up by id and never
   // routes through environmentsSvc.get. It is NOT a sentinel/resolvable id.
   const PLATFORM_DEFAULT_ENVIRONMENT_ID = "platform-default-e2b";

   function read(env: Record<string, string | undefined>, key: string): string | null {
     const v = env[key]?.trim();
     return v && v.length > 0 ? v : null;
   }

   /**
    * The PLATFORM layer of the precedence stack (task > agent > company > platform).
    * Synthesized in-memory (never a DB row) from operator config, ONLY on cloud_auth
    * and ONLY when an operator E2B_API_KEY exists. Returns a full Environment or null —
    * there is no id-resolver variant. The API key itself never enters this object — it
    * is read at the SDK layer (resolveE2bApiKey / E2B_API_KEY, U9). The synthesized shape
    * MUST satisfy assertEnvironmentRuntimeSupportedForDeployment: driver "sandbox",
    * provider "e2b", target null, executionTargetId null.
    */
   export function resolvePlatformDefaultEnvironment(input: {
     companyId: string;
     deploymentMode: DeploymentMode;
     env?: Record<string, string | undefined>;
   }): Environment | null {
     if (input.deploymentMode !== "cloud_auth") return null;
     const env = input.env ?? process.env;
     if (!read(env, "E2B_API_KEY")) return null;

     const now = new Date(0).toISOString();
     const domain = read(env, "E2B_DOMAIN");
     const timeoutRaw = Number(read(env, "E2B_TIMEOUT_MS") ?? "");
     const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 3_600_000;
     return {
       id: PLATFORM_DEFAULT_ENVIRONMENT_ID,
       companyId: input.companyId,
       name: "Platform default (E2B)",
       description: null,
       driver: "sandbox",
       status: "active",
       config: {
         provider: "e2b",
         template: read(env, "E2B_TEMPLATE") ?? "base",
         timeoutMs,
         reuseLease: false,
         ...(domain ? { domain } : {}),
       },
       metadata: { platformDefault: true },
       envVars: {},
       connectionTarget: null,
       target: null,
       executionTargetId: null,
       createdAt: now,
       updatedAt: now,
     };
   }
   ```
   The synthesized `config.domain` is the same key U9 threads into the E2B SDK sites, so a self‑hosted operator gets a consistent host across the platform‑default path and any warm lease reuse.

4. **Run — expect PASS.** `pnpm --filter @armyofagents/server test platform-default-environment`.

5. **Write the failing orchestrator test — null `environmentId` resolves the platform default on cloud.** In `environment-run-orchestrator.test.ts` add. The `acquireRunLease` mock mirrors the **real** `EnvironmentRuntimeLeaseRecord` shape `{ environment, lease, leaseContext }` (grounded: `environment-runtime.ts:63`), and the platform‑default `Environment` must flow through it — this is the "synthesized Environment → provider‑sandbox target" path (S1). Per S5, the environment carries the acquisition driver **inside** `environment.driver` (`EnvironmentAcquisitionResult` has no top‑level `driver`):
   ```ts
   it("resolves the platform-default e2b environment when environmentId is null on cloud", async () => {
     setDeploymentMode("cloud_auth");
     process.env.E2B_API_KEY = "op-key";
     const lease = makeLease({ provider: "e2b" });
     const acquireRunLease = vi.fn(async ({ environment }) => ({
       environment, lease, leaseContext: { executionWorkspaceId: null, executionWorkspaceMode: null },
     }));
     const getEnv = vi.fn(); // must NOT be called for the platform-default path
     const orchestrator = environmentRunOrchestrator({} as never, {
       environments: { get: getEnv },
       environmentRuntime: { acquireRunLease },
     });

     const result = await orchestrator.acquireForRun({
       companyId: COMPANY, environmentId: null, adapterType: "claude_local",
       issueId: null, heartbeatRunId: RUN_ID, persistedExecutionWorkspace: null,
     });

     expect(getEnv).not.toHaveBeenCalled();
     // the synthesized Environment flows straight into acquireRunLease → provider-sandbox lease
     expect(acquireRunLease).toHaveBeenCalledWith(expect.objectContaining({
       environment: expect.objectContaining({ driver: "sandbox", config: expect.objectContaining({ provider: "e2b" }) }),
     }));
     expect(result.environment.driver).toBe("sandbox");
     expect(result.adapterType).toBe("claude_local");
     delete process.env.E2B_API_KEY;
   });

   it("still throws environment_not_found for null environmentId off-cloud (no behavior change on desktop)", async () => {
     setDeploymentMode("local_trusted");
     const orchestrator = environmentRunOrchestrator({} as never, {
       environments: { get: vi.fn() }, environmentRuntime: { acquireRunLease: vi.fn() },
     });
     await expect(orchestrator.acquireForRun({
       companyId: COMPANY, environmentId: null, adapterType: "claude_local",
       issueId: null, heartbeatRunId: RUN_ID, persistedExecutionWorkspace: null,
     })).rejects.toMatchObject({ code: "environment_not_found" });
   });

   it("throws environment_not_found for null environmentId on cloud with no operator key", async () => {
     setDeploymentMode("cloud_auth");
     delete process.env.E2B_API_KEY;
     const orchestrator = environmentRunOrchestrator({} as never, {
       environments: { get: vi.fn() }, environmentRuntime: { acquireRunLease: vi.fn() },
     });
     await expect(orchestrator.acquireForRun({
       companyId: COMPANY, environmentId: null, adapterType: "claude_local",
       issueId: null, heartbeatRunId: RUN_ID, persistedExecutionWorkspace: null,
     })).rejects.toMatchObject({ code: "environment_not_found" });
   });
   ```
   (`makeEnvironment`/`makeLease` helpers already exist in this file; `setDeploymentMode` is already imported at line 7.)

6. **Run it — expect FAIL** (today `resolveEnvironment` throws `environment_not_found` immediately on a null `environmentId` at `environment-run-orchestrator.ts:123`, before any platform‑default attempt). `pnpm --filter @armyofagents/server test environment-run-orchestrator`.

7. **Implement the platform‑default branch in the orchestrator.** In `environment-run-orchestrator.ts`:
   - Import at top: `import { resolvePlatformDefaultEnvironment } from "./platform-default-environment.js";` (and reuse the already‑imported `getDeploymentMode` from `../config/deployment-mode.js` at l.11 and `assertEnvironmentRuntimeSupportedForDeployment` from `./cloud-environment-policy.js` at l.12).
   - In `resolveEnvironment` (opens at l.119), replace the **exact** current null branch (l.123–125):
     ```ts
     if (!input.environmentId) {
       throw new EnvironmentRunError("environment_not_found", "No environment selected.");
     }
     ```
     with a platform‑default attempt that preserves the existing throw when the resolver returns `null`:
     ```ts
     if (!input.environmentId) {
       const platformDefault = resolvePlatformDefaultEnvironment({
         companyId: input.companyId,
         deploymentMode: getDeploymentMode(),
       });
       if (!platformDefault) {
         // unchanged behavior: nothing resolves → environment_not_found (as today)
         throw new EnvironmentRunError("environment_not_found", "No environment selected.");
       }
       // enforce the cloud policy on the synthesized env (driver/provider/target checks),
       // then hand the full Environment back to acquireForRun, which feeds it straight
       // into runtime.acquireRunLease({ environment }) to mint the provider-sandbox lease.
       assertEnvironmentRuntimeSupportedForDeployment(getDeploymentMode(), platformDefault);
       return platformDefault;
     }
     ```
     (The resolver reads operator config from `process.env` by default, which is where `E2B_API_KEY`/`E2B_DOMAIN`/`E2B_TEMPLATE` live — the same env `resolveE2bApiKey` reads at the SDK layer in U9. No `env` needs threading through the orchestrator.)
   - Leave the rest of `resolveEnvironment` (l.127–160: company‑scoped `environmentsSvc.get`, `normalizeEnvironment`, `status !== "active"` check, `assertEnvironmentRuntimeSupportedForDeployment`) untouched — the non‑null path is unchanged, so existing callers keep their exact behavior. `acquireForRun` (l.191) calls `resolveEnvironment` at l.199 and passes the returned `environment` into `runtime.acquireRunLease` at l.206 with no changes: a synthesized platform‑default `Environment` traverses the identical code as a DB row.

8. **Run — expect PASS**, and run the whole orchestrator + resolver suite to confirm the existing non‑null tests are green (proves inertness). `pnpm --filter @armyofagents/server test environment-run-orchestrator platform-default-environment`.

9. **Typecheck.** `pnpm --filter @armyofagents/server typecheck` (or repo‑root `pnpm typecheck`) — confirms the synthesized object matches the shared `Environment` type exactly.

10. **Commit.** `feat(e2b): resolve platform-default E2B environment under the precedence stack (U1)`

---

**Wave 0 exit criteria:**
- `sandbox-provider-runtime.test.ts` proves: managed E2B emits **no** `domain` key (both the original exact‑match `create` assertion and the exact `lease.metadata` `toEqual` at l.123‑136 stay intact, catching any stray `domain: null`); `E2B_DOMAIN`/`config.domain` threads into `create` **and** `connect`; a warm lease re‑reads `domain` from persisted lease metadata on release/execute even when the env var is absent.
- `platform-default-environment.test.ts` proves `resolvePlatformDefaultEnvironment` returns a valid `driver:"sandbox"` / `provider:"e2b"` / `target:null` / `executionTargetId:null` `Environment` **only** on `cloud_auth` with `E2B_API_KEY`, and `null` otherwise, with no operator key embedded in the row. The module exports **only** `resolvePlatformDefaultEnvironment` (Environment|null) — no id‑resolver, no exported sentinel id.
- `environment-run-orchestrator.test.ts` proves a `null` `environmentId` resolves the platform default on cloud (bypassing the company‑scoped `environments.get`), that the synthesized `Environment` flows into `acquireRunLease` and out through `result.environment.driver === "sandbox"` (S5: driver read from `environment.driver`, not a top‑level field), and still throws `environment_not_found` off‑cloud and on‑cloud‑without‑key.
- **No behavior change is observable at runtime**: `heartbeat.ts:4180` and `agents.ts:677` still guard `acquireForRun` behind a non‑null `environmentId`, so no live dispatch reaches the new platform‑default branch until U4 forwards `environmentId ?? null` and U8 (LAST) removes those guards; desktop/`local_trusted` is fully unchanged.
- `pnpm --filter @armyofagents/server typecheck` clean; the full `sandbox-provider-runtime`, `environment-run-orchestrator`, and new `platform-default-environment` suites pass.

**PR‑cut note:** This is the recommended first PR — a self‑contained, inert foundation (the `domain` knob + the dormant platform layer). It can merge to `main` before the broker/coverage waves land, matching the spec §11 build order step 1 ("U9 + U1 — foundation, no behavior change until wired").

---

Grounded file references (all verified under `C:/Users/TK/.aoa/wt/e2b-exec`):
- `server/src/services/sandbox-provider-runtime.ts` — `E2bDriverConfig` (l.182, today `{ template; apiKey; timeoutMs; reuseLease }`), `parseE2bDriverConfig` (l.195), `sanitizedE2bConfig` (l.205), `resolveE2bApiKey` (l.235), `buildE2bLeaseMetadata` (l.257, today takes `{config; sandbox; remoteCwd; workspaceMode}` — no `env`; the conditional‑spread fix adds a passed‑in `resolvedDomain`), `configFromE2bLease` (l.309), `connect` SDK site (l.349), `probe` create (l.376), `acquireLease` create (l.409; `env` in closure scope at l.410, calls `buildE2bLeaseMetadata` at l.424), warm‑lease `connect(config,…)` reuse in `releaseLease` (l.447) and `execute` (l.473).
- `server/src/__tests__/sandbox-provider-runtime.test.ts` — managed‑path guards: exact `create` assertion (l.115‑119) and exact `lease.metadata` `toEqual` (l.123‑136, no `domain` key) — the latter goes red on an unconditional `domain: null` spread.
- `server/src/services/environment-run-orchestrator.ts` — `getDeploymentMode` import (l.11), `assertEnvironmentRuntimeSupportedForDeployment` import (l.12), `resolveEnvironment` (opens l.119; null‑branch throw l.123–125), `acquireForRun` (l.191; `resolveEnvironment` call l.199; `runtime.acquireRunLease({ environment })` l.206).
- `server/src/services/environment-runtime.ts` — `EnvironmentRuntimeLeaseRecord = { environment; lease; leaseContext }` (l.63), the exact shape the test's `acquireRunLease` mock mirrors (S5).
- `server/src/services/cloud-environment-policy.ts` — the cloud policy the synthesized env must satisfy (`driver:sandbox` + `provider:e2b` + `target==null` + `executionTargetId==null`).
- Callers proving inertness: `server/src/services/heartbeat.ts:4180` (`if (environmentRuntime.environmentId)`), `server/src/routes/agents.ts:677` (ternary‑guarded `acquireForRun`).
- Test harnesses: `server/src/__tests__/sandbox-provider-runtime.test.ts` (injected `importE2b` pattern), `server/src/__tests__/environment-run-orchestrator.test.ts` (`makeEnvironment`/`makeLease`, `setDeploymentMode` imported l.7).
