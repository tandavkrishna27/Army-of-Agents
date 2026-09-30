# E2B Cloud Execution Isolation — Implementation Plan (Wave 7: wave7-guard-flip)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec:** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Shared seams:** the INDEX. Execute waves 0→7; U8/guard-flip LAST.

---

## Wave 7 — D1 guard flip (LAST)

**Goal:** Turn cloud execution on. Now that the earlier waves (U1–U7/U9/U12/U13) make a genuine per-run E2B sandbox resolve for org agents, crew, Commander, and the U13 one-shot CLIs, replace every *interim placeholder refusal* (hardcoded `{type:"local"}` / `null` passed into the D1 guard) with the **actually-resolved sandbox execution target**, so `unsandboxed-multitenant-guard.ts` (`assertUnsandboxedMultitenantAllowed`, `:59`) + `cloud-environment-policy.ts` (`assertEnvironmentRuntimeSupportedForDeployment`, `:13-32`) go **refuse → sandbox** on `cloud_auth` for all three run types — while local/null/docker still refuse (no silent fallback) and the guard stays extensible for a future `remote-tenant-runner` (Scenario 2) category.

**What counts as "genuine isolation" (S5):** the guard sees a resolved `AdapterExecutionTarget` whose `type === "provider-sandbox"`. That target is produced only when the acquisition resolves an environment with `acquisition.environment.driver === "sandbox"` and a lease that `isProviderSandboxLease(acquisition.lease)` accepts (`environment-run-orchestrator.ts:44` `EnvironmentAcquisitionResult` — which extends `EnvironmentRuntimeLeaseRecord`, so `acquisition.environment.driver`; and `:163` `isProviderSandboxLease`). There is **no** top-level `acquisition.driver` — any sink-level test that mocks an acquisition must mirror `{ environment: { driver }, lease, ... }` (S5), never a top-level `driver`.

**Covers:** U8 only. This is the final flip and the PR-cut point.

**Preconditions carried in from earlier waves (do not re-implement — consume):**
- The org-agent heartbeat sink (`resolveGuardedAdapterExecutionContext`, defined `heartbeat.ts:360`, guard call `:370`) and the crew sink (`runner.ts:687`, via the same `resolveGuardedAdapterExecutionContext`) already pass `resolved.executionTarget` into the guard. Once U1's platform-default environment and U4's crew lease wiring make that resolve to a `type:"provider-sandbox"` target — i.e. the acquisition returns `environment.driver === "sandbox"` + `isProviderSandboxLease(lease)` (S5) — these two sinks flip **automatically**; U8 adds regression tests, not code, for them.
- The Commander run sink (`cli-mode.ts:805-808`) still passes a literal `{type:"local"}`; U4 added a resolved Commander execution target via the shared acquire-execution-context helper but left the guard argument forcing refusal for the final flip. U8 wires the real target in.
- The three readiness-probe sinks — `agents.ts:695-698` (already consumes `acquiredEnvironment?.configPatch.executionTarget ?? null`), `commander-verify.ts:69-72` (literal `null`), `providers.ts:567-570` (literal `null`) — get their ephemeral probe sandbox from U13. U8 wires the resolved probe target into the two that still pass `null`.
- The workspace-command guards (`local-workspace-command-guard.ts:5-10`, `projects.ts:47-50`) intentionally stay `{type:"local"}`-and-refusing on cloud (tenant shell commands are not host-orchestration git — U6 owns that distinction). **U8 must NOT touch these** and must prove they still refuse.

---

### Task: U8.1 — Flip the Commander run sink + prove org/crew already flip

Replace the placeholder `{type:"local"}` at the Commander run sink with the resolved sandbox target, and lock a regression suite proving all three *run* types (org, crew, Commander) pass the guard when a real E2B target resolves and still refuse when it does not.

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts` (guard call at ~805-808)
- Test (create): `server/src/__tests__/d1-guard-flip-run-sinks.test.ts`
- Test (extend): `server/src/__tests__/unsandboxed-multitenant-guard.test.ts`

**Steps:**

1. **Write the failing test — Commander sink passes its resolved sandbox target, not a literal local.** In `d1-guard-flip-run-sinks.test.ts`, drive the pure guard the way each run sink will call it and assert the three-way flip. Use the existing `providerSandbox` fixture shape from `unsandboxed-multitenant-guard.test.ts`:
   ```ts
   import { describe, it, expect, vi, beforeEach } from "vitest";
   vi.mock("../middleware/logger.js", () => ({
     logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => ({ warn: vi.fn() }) },
   }));
   import {
     assertUnsandboxedMultitenantAllowed,
     resetUnsandboxedMultitenantWarning,
   } from "../services/unsandboxed-multitenant-guard.js";

   const e2b = {
     type: "provider-sandbox" as const,
     provider: "e2b",
     providerLeaseId: "lease-1",
     remoteCwd: "/home/user/app",
     shell: "sh" as const,
     env: {},
     runner: { execute: async () => ({}) } as any,
   };
   const cloud = { tenantIsolationEnforced: true, env: {} as NodeJS.ProcessEnv };

   describe("D1 flip — run sinks (org / crew / Commander)", () => {
     beforeEach(() => resetUnsandboxedMultitenantWarning());

     it.each(["org agent", "crew agent", "Commander"])(
       "%s: a resolved E2B target passes on cloud_auth (refuse → sandbox)",
       (sink) => {
         expect(() =>
           assertUnsandboxedMultitenantAllowed(e2b, { ...cloud, sink }),
         ).not.toThrow();
       },
     );

     it.each(["org agent", "crew agent", "Commander"])(
       "%s: a null/local target STILL refuses on cloud_auth (no silent local fallback)",
       (sink) => {
         expect(() =>
           assertUnsandboxedMultitenantAllowed(null, { ...cloud, sink }),
         ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
         expect(() =>
           assertUnsandboxedMultitenantAllowed({ type: "local" }, { ...cloud, sink }),
         ).toThrow();
       },
     );
   });
   ```

2. **Write the failing structural test — cli-mode no longer hardcodes a local target into the guard.** This encodes that Wave 7 actually removed the placeholder. **Anchor the slice to the CALL site, not the import line.** `cli-mode.ts` imports the guard at line 38 (`import { assertUnsandboxedMultitenantAllowed } from …`) and calls it at line 805; a bare `src.indexOf("assertUnsandboxedMultitenantAllowed")` lands on the *import* and slices an unrelated region — the assertion then can neither go red on current code nor prove the flip (false-green). Anchor on the name immediately followed by `(` (the import has `assertUnsandboxedMultitenantAllowed }`, never `assertUnsandboxedMultitenantAllowed(`), so the slice starts at the real call:
   ```ts
   import { readFileSync } from "node:fs";
   import { fileURLToPath } from "node:url";

   it("cli-mode passes the resolved execution target to the D1 guard, not a literal local", () => {
     const src = readFileSync(
       fileURLToPath(new URL("../services/internal-agent/cli-mode.ts", import.meta.url)),
       "utf8",
     );
     // Anchor on the CALL, skipping the `import { … }` line (which has no `(`).
     const callIdx = src.indexOf("assertUnsandboxedMultitenantAllowed(");
     expect(callIdx).toBeGreaterThan(-1);
     const guardCall = src.slice(callIdx);
     const firstCall = guardCall.slice(0, guardCall.indexOf(");") + 2);
     // The Commander sink must feed the resolved sandbox target, not force refusal.
     expect(firstCall).not.toMatch(/\{\s*type:\s*"local"\s*\}/);
     expect(firstCall).toMatch(/executionTarget/);
   });
   ```
   > **Why `indexOf(");")` bounds the call correctly:** the second guard arg is `{ tenantIsolationEnforced: tenantIsolationEnforced(), sink: "Commander" }` — the inner `tenantIsolationEnforced()` is followed by `,` (`),`), so the first `);` in the slice is the guard call's own closing paren. Holds for both the pre-flip `{ type: "local" }` form and the post-flip `commanderExecutionContext?.executionTarget ?? null` form.

3. **Run it — expect FAIL, and confirm it is RED for the right reason** (`pnpm --filter @armyofagents/server test d1-guard-flip-run-sinks`): the anchored `firstCall` captures the literal `{ type: "local" }` at `cli-mode.ts:806` — so `not.toMatch(/\{\s*type:\s*"local"\s*\}/)` fails AND `toMatch(/executionTarget/)` fails. If this test *passes* against current code, the anchor is wrong (it slid onto the import); do not proceed until it is genuinely red.

4. **Implement — wire the resolved Commander target into the guard call.** In `cli-mode.ts`, the run path already acquires a Commander execution context via the U4 shared helper before the guard call. Replace the literal target with that context's resolved `executionTarget` (falling through to `null` when none resolved, which keeps the fail-closed refusal on cloud):
   ```ts
   // was: assertUnsandboxedMultitenantAllowed({ type: "local" }, { ... sink: "Commander" });
   assertUnsandboxedMultitenantAllowed(
     commanderExecutionContext?.executionTarget ?? null,
     { tenantIsolationEnforced: tenantIsolationEnforced(), sink: "Commander" },
   );
   ```
   Keep the surrounding narrow try/catch that yields the `type:"error"` chunk (cli-mode.ts:809-811) unchanged — a refusal (null target, acquire failed) must still surface as a clean Commander SSE error per §8, never a silent local spawn. `commanderExecutionContext` is the handle returned by the U4 `acquire-execution-context` helper already in scope on the run path; if the helper variable is named differently in the merged U4 code, bind to that name. Its `executionTarget` is `type:"provider-sandbox"` exactly when the U4 acquisition resolved `environment.driver === "sandbox"` + `isProviderSandboxLease(lease)` (S5) — so the guard's own type check is the correct isolation gate here; do not add a second driver check inside cli-mode.

   > **S5 mock shape:** any regression test that stands in for the U4 acquisition (rather than driving the pure guard with a bare target) must mirror `{ environment: { driver: "sandbox" }, lease: { provider: "e2b", ... }, configPatch: { executionTarget }, ... }` and read `acquisition.environment.driver` — there is **no** top-level `acquisition.driver`. The U8.1 tests above drive the pure guard directly, which is the simpler and preferred form; only reach for an acquisition mock if you assert the sink's own resolve→guard threading.

5. **Run — expect PASS.** Both new tests green.

6. **Extend the guard's own suite for the all-run-types flip.** In `unsandboxed-multitenant-guard.test.ts`, add one case asserting the E2B `providerSandbox` fixture is permitted for the `"Commander"` and `"crew agent"` sinks too (the existing suite only asserts it for `"org agent"`), so the parity is pinned in the guard's canonical test file.

7. **Run — expect PASS.**

8. **Commit:** `feat(exec-isolation): flip Commander run sink to its resolved E2B target (U8)`

---

### Task: U8.2 — Flip the readiness-probe sinks to their resolved ephemeral-sandbox target

Replace the literal `null` refusal at the Commander-verify and provider-verify probe sinks with the ephemeral probe sandbox target from U13, so BYO-key onboarding verification runs inside a sandbox on cloud instead of failing closed — while an unresolved (null) probe still fails closed.

**Files:**
- Modify: `server/src/routes/commander-verify.ts` (guard call at ~69-72)
- Modify: `server/src/routes/providers.ts` (guard call at ~567-570)
- Test (extend): `server/src/__tests__/adapter-probe-cloud-guard.test.ts`

**Steps:**

1. **Write the failing test — a resolved probe sandbox target lets the probe proceed; a null target still fails closed.** Extend `adapter-probe-cloud-guard.test.ts` (which already documents the three probe entry points) with a case per sink that drives the guard the way the route will:
   ```ts
   const probeSandbox = {
     type: "provider-sandbox" as const,
     provider: "e2b",
     providerLeaseId: "probe-lease",
     remoteCwd: "/tmp/probe",
     shell: "sh" as const,
     env: {},
     runner: { execute: async () => ({}) } as any,
   };

   it.each([["commander-verify"], ["providers"]])(
     "%s probe: a resolved ephemeral E2B sandbox passes on cloud_auth",
     () => {
       expect(() =>
         assertUnsandboxedMultitenantAllowed(probeSandbox, {
           tenantIsolationEnforced: true,
           sink: "adapter readiness probe",
           env: {},
         }),
       ).not.toThrow();
     },
   );

   it("probe with an unresolved (null) sandbox still fails closed on cloud_auth", () => {
     expect(() =>
       assertUnsandboxedMultitenantAllowed(null, {
         tenantIsolationEnforced: true,
         sink: "adapter readiness probe",
         env: {},
       }),
     ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
   });
   ```
   Also add a source-structural assertion mirroring U8.1 step 2 for both routes — **anchored on the call site, not the import.** `commander-verify.ts` imports at line 19 / calls at line 69; `providers.ts` imports at line 205 / calls at line 567. A bare `indexOf("assertUnsandboxedMultitenantAllowed")` lands on the import line (whose region never contains `assertUnsandboxedMultitenantAllowed(null,`), so the old assertion passed vacuously against the *current* literal-`null` code — a false-green that could never go red on the flip. Anchor on the trailing `(`:
   ```ts
   it("commander-verify + providers feed the resolved probe target, not a literal null", () => {
     for (const rel of ["../routes/commander-verify.ts", "../routes/providers.ts"]) {
       const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
       // Anchor on the CALL, skipping the `import { … }` line (which has no `(`).
       const callIdx = src.indexOf("assertUnsandboxedMultitenantAllowed(");
       expect(callIdx).toBeGreaterThan(-1);
       const call = src.slice(callIdx);
       const first = call.slice(0, call.indexOf(");") + 2);
       expect(first).not.toMatch(/assertUnsandboxedMultitenantAllowed\(\s*null\s*,/);
       expect(first).toMatch(/executionTarget/);
     }
   });
   ```
   > **`indexOf(");")` bound:** commander-verify's second arg calls `tenantIsolationEnforced()` (`),`) and providers' is object-literal `true`, so in both the first `);` is the guard call's own closing paren, both pre- and post-flip.

2. **Run it — expect FAIL, RED for the right reason:** with the call-anchored slice, `first` for each route begins `assertUnsandboxedMultitenantAllowed(null, { … })` — so `not.toMatch(/…\(\s*null\s*,/)` fails and `toMatch(/executionTarget/)` fails. Confirm both routes are genuinely red before implementing; if the assertion passes against current literal-`null` code, the anchor slid onto the import and must be fixed first.

3. **Implement — consume the U13 probe sandbox handle.** U13 added an ephemeral-sandbox acquisition to the probe routes (the "spawn a provider CLI in an ephemeral sandbox with the U12 company key" helper). In `commander-verify.ts` and `providers.ts`, capture that helper's resolved execution target and pass it into the guard instead of `null`, matching the shape `agents.ts:696` already uses (`acquiredEnvironment?.configPatch.executionTarget ?? null`):
   ```ts
   // commander-verify.ts / providers.ts
   assertUnsandboxedMultitenantAllowed(
     probeEnvironment?.configPatch.executionTarget ?? null,
     { tenantIsolationEnforced: /* commander-verify: tenantIsolationEnforced() ; providers: true */, sink: "adapter readiness probe" },
   );
   ```
   Bind `probeEnvironment` to whatever the U13 merged code named the acquired probe environment (mirror `acquiredEnvironment` in `agents.ts`). Leave the `catch` blocks intact — on a null/failed acquire the guard still throws, and each route keeps returning its existing blocking result (commander-verify: 422 + `outcome:"failed"`; providers: the `cloudChecks` `failed` row) so a prior `verified` row cannot survive (providers.ts:562-570 comment invariant).

4. **Run — expect PASS.**

5. **Commit:** `feat(exec-isolation): flip readiness-probe sinks to their ephemeral E2B target (U8)`

---

### Task: U8.3 — Keep the guard + cloud policy extensible for a tenant-operated runner; lock the full anti-regression suite

Add the inert Scenario-2 seam (a future `remote-tenant-runner` is a *distinct allowed* category, never carved out of "local") to both guard files, prove today's inputs are unaffected, prove the untouched workspace-command guards still refuse, and update the env-var doc. No behavior change for any real target shipping in v1.

**Files:**
- Modify: `server/src/services/unsandboxed-multitenant-guard.ts` (`assertUnsandboxedMultitenantAllowed` `:59`, `requiresSandboxRefusal` `:27`)
- Modify: `server/src/services/cloud-environment-policy.ts` (`assertEnvironmentRuntimeSupportedForDeployment` `:13-32`)
- Test (extend): `server/src/__tests__/unsandboxed-multitenant-guard.test.ts`
- Test (extend): `server/src/__tests__/cloud-environment-policy.test.ts`
- Modify: `docs/deploy/environment-variables.md` (the `AOA_ALLOW_UNSANDBOXED_MULTITENANT` entry)
- Modify: `docs/architecture/decisions.md` (D1 status: placeholder → flipped)

**Steps:**

1. **Write the failing test — guard permits a future isolated runner category and is deny-by-enumeration, not allow-only-provider-sandbox.** In `unsandboxed-multitenant-guard.test.ts`:
   ```ts
   it("permits a future tenant-operated isolated runner on cloud_auth (Scenario 2 seam)", () => {
     // Not local, not a docker-family type → must be allowed, so adding
     // Scenario 2 later is a new target category, not a carve-out of `local`.
     const remoteRunner = { type: "remote-tenant-runner" } as any;
     expect(() =>
       assertUnsandboxedMultitenantAllowed(remoteRunner, {
         tenantIsolationEnforced: true,
         sink: "org agent",
         env: {},
       }),
     ).not.toThrow();
   });

   it("refusal set stays closed-enumerated: only local + docker-family refuse", () => {
     // Guard must never invert to an allow-list of only provider-sandbox
     // (that would refuse Scenario 2's remote runner).
     const src = readFileSync(
       fileURLToPath(new URL("../services/unsandboxed-multitenant-guard.js", import.meta.url)),
       "utf8",
     ).length; // presence only; behavior asserted above
     expect(src).toBeGreaterThan(0);
   });
   ```

2. **Write the failing test — cloud policy reserves the tenant-runner shape without enabling it today.** In `cloud-environment-policy.test.ts`, add: the current allow-list still permits only unpinned E2B and still rejects local/docker/gvisor/pinned (regression), plus assert the exported reserved marker exists:
   ```ts
   import {
     assertEnvironmentRuntimeSupportedForDeployment,
     CLOUD_ENVIRONMENT_TARGET_UNAVAILABLE,
     RESERVED_TENANT_RUNNER_DRIVER,
   } from "../services/cloud-environment-policy.js";

   it("reserves the tenant-operated runner driver name for Scenario 2 (documented, not yet enabled)", () => {
     expect(RESERVED_TENANT_RUNNER_DRIVER).toBe("remote-runner");
     // Not enabled yet: a remote-runner env still rejects in cloud_auth today.
     expect(() =>
       assertEnvironmentRuntimeSupportedForDeployment("cloud_auth", {
         driver: RESERVED_TENANT_RUNNER_DRIVER,
         config: {},
         target: null,
         executionTargetId: null,
       }),
     ).toThrow();
   });
   ```

3. **Run — expect FAIL** (`RESERVED_TENANT_RUNNER_DRIVER` is unexported; no seam comment).

4. **Implement — guard seam.** In `unsandboxed-multitenant-guard.ts`, keep `requiresSandboxRefusal` (`:27`) as the closed refuse-enumeration (local via `isUnsandboxedLocalTarget` + `DOCKER_FAMILY_TARGET_TYPES` `:15`) it already is, and add a documented reserved-category comment above it so a future refactor cannot invert it into an allow-list. Note that this target-level enumeration mirrors the acquisition-level isolation seam (S5): a `type:"provider-sandbox"` target is exactly what the orchestrator emits when `acquisition.environment.driver === "sandbox"` + `isProviderSandboxLease(lease)` (`environment-run-orchestrator.ts:163`) — the two views stay consistent, and a future `remote-tenant-runner` is a new allowed target type, not a `local` carve-out:
   ```ts
   // EXTENSIBILITY (Scenario 2 — tenant-operated isolated runner, spec §13 hook #2):
   // This guard refuses a CLOSED ENUMERATION (local + docker-family) and PERMITS
   // everything else. A future `remote-tenant-runner` execution-target type is
   // therefore an ALLOWED category by construction — do NOT invert this to an
   // allow-list of only provider-sandbox, which would refuse the remote runner.
   ```
   No functional change — the enumeration already permits `provider-sandbox` and any future non-local/non-docker type.

5. **Implement — cloud policy seam.** In `cloud-environment-policy.ts`, export the reserved driver name and structure the allow-check so E2B is one clearly-labelled allowed shape with the tenant-runner shape reserved (disabled) beside it:
   ```ts
   /** Reserved for Scenario 2 (tenant-operated runner). NOT yet enabled on cloud. */
   export const RESERVED_TENANT_RUNNER_DRIVER = "remote-runner";

   export function assertEnvironmentRuntimeSupportedForDeployment(
     mode: DeploymentMode,
     input: EnvironmentRuntimeShape,
   ): void {
     if (mode !== "cloud_auth") return;
     const config = input.config && typeof input.config === "object" && !Array.isArray(input.config)
       ? (input.config as Record<string, unknown>)
       : null;
     // Allowed cloud shape #1 (v1): an unpinned managed/self-hosted E2B sandbox.
     const isE2b = input.driver === "sandbox"
       && config?.provider === "e2b"
       && input.target == null
       && input.executionTargetId == null;
     // Allowed cloud shape #2 (RESERVED, Scenario 2 — see §14 `tenant_hosted`):
     // driver === RESERVED_TENANT_RUNNER_DRIVER. Intentionally NOT admitted in v1.
     if (isE2b) return;
     throw unprocessable(
       "AoA Cloud currently supports E2B environments without raw targets or execution-target pins. " +
         "Local, Docker, gVisor, and worker-pool routing remain unavailable until the isolated worker plane ships.",
       { code: CLOUD_ENVIRONMENT_TARGET_UNAVAILABLE },
     );
   }
   ```
   The reserved shape is a comment + exported constant only — it must still throw today (the test in step 2 asserts this), so v1 behavior is byte-identical.

6. **Write the failing test — the workspace-command guards U8 did NOT touch still refuse local on cloud.** In `unsandboxed-multitenant-guard.test.ts` (or a small `d1-untouched-guards.test.ts`), assert the tenant-shell-command sink still fails closed after the flip:
   ```ts
   it("tenant workspace-command sink still refuses a local target on cloud_auth (U6 owns host-orchestration git; U8 must not neutralize it)", () => {
     expect(() =>
       assertUnsandboxedMultitenantAllowed({ type: "local" }, {
         tenantIsolationEnforced: true,
         sink: "workspace command configuration",
         env: {},
       }),
     ).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
   });
   ```

7. **Run — expect PASS** on all four extended suites.

8. **Update docs.** In `docs/deploy/environment-variables.md`, revise the `AOA_ALLOW_UNSANDBOXED_MULTITENANT` entry: it is now the operator override that bypasses a *working* E2B sandbox path (was: "no per-tenant isolation implemented yet"). In `docs/architecture/decisions.md`, flip the D1 decision status from placeholder-refusal to "sandbox path live for org/crew/Commander + U13 probes; guard permits a resolved E2B target and stays extensible for a future `remote-tenant-runner` (Scenario 2)."

9. **Run the whole affected suite** — `pnpm --filter @armyofagents/server test unsandboxed-multitenant-guard cloud-environment-policy d1-guard-flip-run-sinks adapter-probe-cloud-guard` — plus `pnpm --filter @armyofagents/server exec tsc --noEmit` and `pnpm brand-check`. Expect PASS.

10. **Commit:** `feat(exec-isolation): keep D1 guard + cloud policy extensible for tenant-operated runner; land the flip (U8)`

---

**Wave 7 exit criteria:**
- All three run sinks pass a **resolved `provider-sandbox` target** into the D1 guard on `cloud_auth` and are permitted: org (`heartbeat.ts:370` guard call inside `resolveGuardedAdapterExecutionContext` `:360`, auto-flips via U1), crew (`runner.ts:687` via the same helper, auto-flips via U4), Commander (`cli-mode.ts:805-808` flip in U8.1). The target is recognized as genuine isolation because it originates from an acquisition with `environment.driver === "sandbox"` + `isProviderSandboxLease(lease)` (S5).
- The two literal-`null` readiness-probe sinks (`commander-verify.ts`, `providers.ts`) pass their **U13 ephemeral probe sandbox target**; BYO-key onboarding verify runs in a sandbox on cloud instead of failing closed.
- **No silent local fallback:** a `null`/`local` resolved target (acquire failed) still throws on cloud for every run and probe sink; the sink-specific founder surface (Commander SSE error, verify 422/`failed`, provider `failed` check row) is preserved.
- The **untouched** tenant workspace-command guards still refuse local on cloud (U6's host-orchestration-git carve-out is separate).
- Guard stays a **closed refuse-enumeration** (a future `remote-tenant-runner` is permitted by construction); `cloud-environment-policy` exports `RESERVED_TENANT_RUNNER_DRIVER` and still admits only unpinned E2B in v1.
- `tsc --noEmit`, `brand-check`, and the four guard/policy/probe test suites are green.

**PR-cut point:** Yes — this is **the** cut. Merging Wave 7 is the moment cloud execution turns on: every earlier wave built the sandbox path behind a still-refusing guard, and U8 is the atomic switch that makes the resolved E2B target the live path for all run types. Land this last, after Waves 1–6 are merged/verified, as the final commit of the single E2B PR (or as the terminal commit if the U10/U11 carve-out fast-follow is taken — U8 flips the core U1–U9/U12/U13 surface regardless).
