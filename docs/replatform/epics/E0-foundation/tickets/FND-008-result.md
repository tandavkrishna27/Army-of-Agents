# FND-008 Result — Disable Cloud Plugin Runtime and Browser Surfaces

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E0-foundation`
**Plan task:** `Task 8: FND-008 — Disable Cloud Plugin Runtime and Browser Surfaces`
**Implementer:** FND-008 implementer subagent (Claude)
**Start SHA:** 271deab570b4e934ec7e1ac70b2f0a9e5657dcec

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the Independent review section and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen.

## Delivered scope

Completes Decision #103's cloud-plugin exclusion at the runtime / HTTP / MCP surface, on top of FND-006's process-composition denial (crosswalk CP-003/CP-004; CP-005 preserved).

- **Registered 503 denial stubs in `cloud_auth` (the FND-006→008 seam).** FND-006 left the effectful `pluginRoutes` / `pluginCompanySettingsRoutes` / `companyPluginRoutes` UNMOUNTED in cloud (a request 404s). FND-008 MOUNTS them in the cloud branch of `app.ts` with the effectful runtime deps ABSENT and two inert cloud-denial facades (`buildCloudPluginDenialLoader` / `buildCloudPluginDenialLifecycle`, exported from `plugins.ts`). Every effectful route now short-circuits to the exact Decision #103 **503** envelope (`error` = `CLOUD_PLUGIN_BLOCK_MESSAGE`, `code = "PLUGIN_WORKER_BLOCKED_IN_CLOUD"`, `docs = "/docs/guides/cloud-plugin-execution"`) at its `rejectBlockedCloudExecution` / `blockActivationInCloud` gate BEFORE touching any loader/lifecycle/worker effect — never a 404. No worker manager, event/stream bus, job store/scheduler/coordinator, or tool dispatcher is constructed; `__pluginSubsystem` / `__paperclipPluginToolDispatcher` stay unset (index.ts starts no plugin background work; heartbeat injects no plugin tools).
- **Two previously-ungated mutating routes now deny.** DELETE `/plugins/:id` (uninstall) and POST `/plugins/:id/disable` gained an entry `rejectBlockedCloudExecution` gate so they return the canonical 503 before any lifecycle effect (they previously fell through to a generic 400 when the lifecycle threw). Every other effectful route already carried the gate (FND-006-era) and is now reachable-and-denied because the router is mounted.
- **Metadata-only reads still serve persisted data.** `GET /plugins`, `/plugins/:id`, `/health`, `/logs`, `/config`, `/dashboard`, and the company/legacy-settings list reads use the real `db`/registry and `projectCloudPluginPolicyState` (status → `error` + reason + message). No manifest JavaScript is ever evaluated.
- **Non-HTTP MCP dispatcher fails closed before dispatch.** `dispatchPluginToolCall` (`server/src/mcp/tools/plugin-broker-tools.ts`) now returns its typed `forbidden` denial carrying `CLOUD_PLUGIN_BLOCK_MESSAGE` at the very top — before resolving the dispatcher, reading the registry, or reaching a worker — whenever `isCloudPluginExecutionBlocked()`. The broker maps this to HTTP 403 / JSON-RPC -32003 (mcp/server.ts, unchanged). In the real hosted parent the dispatcher is never set anyway; this is defense-in-depth that holds even if a stale dispatcher were present. `readPluginToolDefinitions` stays metadata-only (registration is metadata; unset dispatcher → `[]` in cloud).
- **Browser-code (ui-static) surface unchanged and re-characterized.** `plugin-ui-static.ts`'s `isCloudPluginExecutionBlocked("ui-static")` → 503 gate was already correct (FND-006/RW5a) and is preserved; only its test was strengthened to assert the exact error/code/docs envelope.
- **Stale RW5a "stays allowed on cloud" comments cleaned (resolves E0-F007 item 2).** `routes/plugins.ts` (the `rejectBlockedCloudExecution` helper), `routes/company-plugins.ts` (the rollback gate), and `services/plugin-loader.ts` (the `loader-import` + install/upgrade `loader` gates) now describe the FND-006/008 reality (every sink fails closed in cloud).
- **Source-boundary checker extended.** 7 new FND-008 mutations reject: drifting the Decision #103 docs path, dropping a 503-envelope field, removing the MCP broker denial, removing the ui-static browser-code gate, dropping a cloud-denial facade export, unmounting the cloud denial stubs (→ 404), and restoring a cloud background plugin starter (a 2nd `__pluginSubsystem` assignment).

### Non-goals preserved

- **CP-005 external-adapter denial preserved, not weakened.** The external-adapter install/reload/reinstall/uninstall/UI-parser boundary still fails closed in cloud (a separate boundary from the plugin worker) — regression-guarded in `cloud-external-adapter-execution.test.ts`.
- **Self-hosted positives unchanged.** `local_trusted` and single-tenant `authenticated` plugin install/enable/disable/uninstall/upgrade/tool-dispatch run exactly as before (proven off-cloud in the route matrix + the unit dispatcher characterization).
- **FND-006 not re-enabled or weakened.** No effectful worker/lifecycle/loader machinery is constructed in cloud; `isCloudPluginExecutionBlocked` / `stripHostedPluginWorkerMarker` untouched; the FND-006 composition guard + its 7 mutations still pass.
- **Marketplace INSTALL router intentionally stays unmounted in cloud** (fail-closed 404 before any package I/O); its async orchestrator already records the `errorCode`/`errorDocs` cloud contract and is unreachable without the loader — see Deviations.

## Changed files

| File | Responsibility |
|---|---|
| `server/src/app.ts` | Cloud (`else`) branch mounts the 3 plugin routers as registered 503 stubs via the inert `buildCloudPluginDenialLoader`/`buildCloudPluginDenialLifecycle` facades (no effectful machinery). |
| `server/src/routes/plugins.ts` | Export the two cloud-denial facades; add entry 503 gates to uninstall (DELETE) + disable (POST); clean the stale RW5a comment in `rejectBlockedCloudExecution`. |
| `server/src/routes/company-plugins.ts` | Clean the stale RW5a rollback-gate comment (loader sink now fails closed in cloud). |
| `server/src/services/plugin-loader.ts` | Clean the 3 stale RW5a "stays/always allowed on cloud" comments on the `loader-import` + install/upgrade `loader` gates. |
| `server/src/mcp/tools/plugin-broker-tools.ts` | Add the typed cloud denial at the top of `dispatchPluginToolCall` (fail closed before dispatch). |
| `server/src/__tests__/cloud-plugin-runtime-exclusions.test.ts` | NEW — unit-local matrix (MCP broker RED→GREEN + envelope + sink re-affirmation + dispatch sentinel); runs on every platform. |
| `server/src/__tests__/cloud-external-adapter-execution.test.ts` | FND-008 CP-005 regression framing on the preserved external-adapter denial. |
| `server/src/__tests__/plugin-ui-static-tenant-scope.test.ts` | FND-008 characterization: the ui-static 503 carries the exact error/code/docs envelope. |
| `scripts/check-distributed-execution-foundation.mjs` | FND-008 source-boundary check: envelope drift, MCP broker denial, ui-static gate, 503 stub + facade exports, cloud denial mount, no cloud background starter. |
| `scripts/check-distributed-execution-foundation.test.mjs` | +7 FND-008 mutations; copy `plugins.ts` / `plugin-ui-static.ts` / `plugin-broker-tools.ts` into the fixture tree. |
| `docs/replatform/epics/E0-foundation/tickets/FND-008-result.md` | This result. |

### Additional files (deviation — see Deviations)

| File | Responsibility |
|---|---|
| `server/src/__tests__/cloud-plugin-runtime-exclusions.integration.test.ts` | NEW — the real HTTP route matrix (install/uninstall/upgrade/enable/disable/tools/jobs/webhooks/bridge/stream/ui-contributions/config-test + company + settings routers, incl. the NEW uninstall/disable gates, projected reads, self-hosted positives, facade throws). Imports `pluginRoutes` → Windows-collection-skip on the E0-F005 drizzle cycle, Linux-CI-authoritative. |
| `server/src/__tests__/plugin-broker-cloud.integration.test.ts` | Flip: the broker now denies a cloud plugin `tools/call` BEFORE dispatch (403 / -32003 + block message) instead of falling through to the registry's -32000 "not running". |

`server/src/routes/plugin-ui-static.ts` is in the plan's Files list as "Modify" but was left **source-unchanged** — its `ui-static` 503 gate was already correct pre-FND-008 (FND-006/RW5a); only its characterization test changed. See Deviations.

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| MCP broker dispatch fails closed with the typed denial BEFORE any dispatch effect (cloud) | `cloud-plugin-runtime-exclusions.test.ts` broker RED→GREEN + dispatch sentinel (ran locally) | `pass` |
| Off-cloud broker dispatch still reaches the worker (self-hosted positive) | `cloud-plugin-runtime-exclusions.test.ts` off-cloud case (ran locally) | `pass` |
| Stable Decision #103 503 envelope (error/code/docs) exact | `cloud-plugin-runtime-exclusions.test.ts` envelope case + checker (i1) (ran locally) | `pass` |
| Every sink + bare form fail closed in cloud; nothing off-cloud | `cloud-plugin-runtime-exclusions.test.ts` sink matrix (ran locally) | `pass` |
| Uninstall + disable routes 503 before any lifecycle effect (cloud) | `cloud-plugin-runtime-exclusions.integration.test.ts` RED→GREEN cases (Linux-CI-authoritative) | `pass (binds on Linux CI)` |
| Full effectful route matrix 503 with the canonical envelope (cloud) | `cloud-plugin-runtime-exclusions.integration.test.ts` matrix (Linux-CI-authoritative) | `pass (binds on Linux CI)` |
| Metadata reads still project the blocked state; no manifest eval | `cloud-plugin-runtime-exclusions.integration.test.ts` reads case (Linux-CI-authoritative) | `pass (binds on Linux CI)` |
| Company + legacy-settings routers 503 in cloud | `cloud-plugin-runtime-exclusions.integration.test.ts` company case (Linux-CI-authoritative) | `pass (binds on Linux CI)` |
| ui-static 503 carries the exact envelope (browser surface) | `plugin-ui-static-tenant-scope.test.ts` FND-008 case (Linux-CI-authoritative) | `pass (binds on Linux CI)` |
| External-adapter (CP-005) denial preserved | `cloud-external-adapter-execution.test.ts` (Linux-CI-authoritative) | `pass (binds on Linux CI)` |
| Broker `tools/call` denied before dispatch end-to-end (cloud) | `plugin-broker-cloud.integration.test.ts` flip (Linux-CI / embedded-PG, Windows-skip) | `pass (binds on Linux CI)` |
| FND-008 mutations (envelope/broker/ui-static/facade/mount/background-starter) fail the checker | `check-distributed-execution-foundation.test.mjs` 7 new mutations (ran locally) | `pass` |
| FND-006 process-composition + gate matrix not regressed | `cloud-plugin-execution.test.ts` + `cloud-plugin-process-composition.test.ts` (ran locally) | `pass` |

## Commands

Marked **local** (ran on this Windows box; exit 0 binds) or **Linux-CI** (Windows collection fails on the pre-existing drizzle-orm `require(esm)` cycle per E0-F005 — verdict binds on Linux CI).

| Command | Exit code | Result summary |
|---|---:|---|
| `git rev-parse HEAD` (before first change) | `0` | `271deab570b4e934ec7e1ac70b2f0a9e5657dcec` |
| **RED** (local) `vitest run cloud-plugin-runtime-exclusions.test.ts` | `1` | 1 failed / 7 passed — the intentional MCP-broker-dispatch RED (`'ok'` vs `'forbidden'`, executeTool called) on the unfixed broker |
| **GREEN** (local) `vitest run cloud-plugin-runtime-exclusions.test.ts` | `0` | 8/8 pass |
| **GREEN** (local) `vitest run cloud-plugin-runtime-exclusions.test.ts cloud-plugin-execution.test.ts cloud-plugin-process-composition.test.ts` | `0` | 28/28 pass (FND-006 units not regressed; the off-cloud fork-attempt ERROR log is the self-hosted positive, not a failure) |
| Plan Step-3 focused set (`cloud-plugin-runtime-exclusions + cloud-external-adapter-execution + plugin-ui-static-tenant-scope`) | Windows: `1` | Unit file 8/8 GREEN; the 2 route-importing files Windows-collection-fail (E0-F005), bind on Linux CI |
| **Linux-CI** `vitest run cloud-plugin-runtime-exclusions.integration.test.ts` | Windows: `1` (collection cycle) | Binds on Linux CI: uninstall/disable RED→GREEN + full matrix + reads + company + facades + self-hosted positive (source-derived, typecheck-clean) |
| **Linux-CI** `vitest run plugin-broker-cloud.integration.test.ts plugin-tenant-routes.test.ts cloud-external-adapter-execution.test.ts plugin-ui-static-tenant-scope.test.ts` | Windows: `1` (collection cycle / embedded-PG) | Binds on Linux CI: broker deny-before-dispatch flip + unchanged route/adapter/ui-static behavior |
| `pnpm --filter @armyofagents/server typecheck` | `0` | tsc clean (covers every modified test file, incl. the Linux-only ones) |
| `pnpm --filter @armyofagents/server build` | `0` | tsc build clean |
| `pnpm check:distributed-foundation` | `0` | `distributed execution foundation: PASS` |
| `node --test scripts/check-distributed-execution-foundation.test.mjs` | `0` | tests 169, pass 169, fail 0 (was 162; +7 FND-008 mutations) |
| `git diff --check` | `0` | clean (only benign LF→CRLF warnings on the two `.mjs` files) |
| `git diff -- pnpm-lock.yaml` | `0` | EMPTY (byte-unchanged) |

## Verification log

**RED (local, against unfixed code) — `cloud-plugin-runtime-exclusions.test.ts`: 1 failed / 7 passed (exit 1).** The failing case is the intentional RED: on the FND-007 baseline `dispatchPluginToolCall` has NO cloud gate, so on `cloud_auth` it reaches the dispatcher and calls `executeTool` (`expected 'ok' to be 'forbidden'`; the dispatch sentinel `executeTool not called` also fails). The 7 passing were the off-cloud dispatch characterization, the board-actor denial (already `forbidden` by the actor gate today), the metadata-listing characterization, the exact 503 envelope, and the six-sink cloud/off-cloud matrix.

**GREEN (local) after the fix:** the broker denies with `forbidden` + `CLOUD_PLUGIN_BLOCK_MESSAGE` before dispatch; 8/8. The route matrix (uninstall/disable RED→GREEN + the full effectful set + projected reads + company routers + self-hosted positive + facade throws) is Linux-CI-authoritative — its file imports `pluginRoutes`, which tips vitest into the drizzle-orm `require(esm)` cycle on Windows (finding E0-F005), so it fails COLLECTION on Windows exactly like `plugin-tenant-routes.test.ts`. The route flips are derived directly from the handler source (`rejectBlockedCloudExecution` / `blockActivationInCloud` / `projectCloudPluginPolicyState`) and are typecheck-clean.

**Multi-replica drain + rollback (Step 2).** The hosted cloud parent composes NO plugin worker/lifecycle/loader (FND-006), so there is zero in-parent background plugin work to drain: no job scheduler/coordinator starts, no `loadAll()` runs, and `__pluginSubsystem`/`__paperclipPluginToolDispatcher` stay unset (checker (i5) pins both to a single off-cloud assignment). New triggers are denied first — every HTTP surface 503s at its gate before effect, and the MCP dispatcher fails closed before dispatch. Queued/stale rows are reconciled metadata-only and idempotently at boot by FND-006's `reconcileCloudBlockedPlugins(db)` (safe on every replica during a rolling upgrade; already landed in `index.ts`). Rollback retains the deny-stub/status contract because it is derived from the static `tenantIsolationEnforced()` deployment mode — there is no operator override and nothing re-enables hosted plugin execution. The operational cancel-running / close-bridge-stream steps concern the self-hosted runtime; in the hosted parent there is nothing to cancel (composition-gated).

## Deviations

**1. Extra route-matrix test file (E0-F005 split).** The plan's single `cloud-plugin-runtime-exclusions.test.ts` cannot hold BOTH the unit-local dispatcher/envelope cases (which must RUN on Windows) and the route matrix (which imports `pluginRoutes` and therefore fails Windows collection on the drizzle-orm `require(esm)` cycle, E0-F005). Putting both in one file would sink the unit-local cases into the same collection failure. So the route matrix lives in `cloud-plugin-runtime-exclusions.integration.test.ts` (Linux-CI-authoritative), mirroring `plugin-tenant-routes.test.ts`. This is the E0-F005/E0-F006 precedent (a necessary file the plan's literal list omitted, with rationale).

**2. Extra test flip — `plugin-broker-cloud.integration.test.ts`.** Adding the required MCP broker cloud denial (`dispatchPluginToolCall` fails closed before dispatch) inverts that FND-006 integration test's one cloud-`tools/call` assertion: it asserted the OLD mechanism (fall-through to the registry's -32000 "not running"); the denial now fires strictly earlier (403 / -32003 + block message). The file is not in the plan's `git add` list, but the assertion MUST change or it goes red on Linux CI. Test-only, source-derived; mirrors the E0-F007 item-1 precedent. (Windows-skip via embedded-PG; Linux-CI-authoritative.)

**3. `plugin-ui-static.ts` left source-unchanged.** The plan Files list marks it "Modify", but its `isCloudPluginExecutionBlocked("ui-static")` → 503 browser-code gate was already correct pre-FND-008 (FND-006/RW5a). No source change was warranted; only its characterization test was strengthened (exact error/code/docs envelope). The FND-008 checker (i3) still pins the gate as a regression guard.

**4. Marketplace INSTALL router stays unmounted in cloud.** The `createMarketplaceInstallRouter` / `createMarketplaceCompanyRouter` (separate files, not in the plan's `git add` set) remain unmounted in `cloud_auth` (fail-closed 404 before any package I/O — CP-004 "reject before I/O" is satisfied). Their async operation orchestrator already records the `errorCode = PLUGIN_WORKER_BLOCKED_IN_CLOUD` / `errorDocs` cloud contract (`services/marketplace-install/orchestrator.ts`) and is unreachable without the loader; that contract is PRESERVED, not weakened. Mounting them as 503 stubs would require touching out-of-scope files for an async surface that is already fail-closed; deferred rather than in-scoped here.

**5. Windows-collection-skip test files (E0-F005, not a regression).** `cloud-external-adapter-execution.test.ts` and `plugin-ui-static-tenant-scope.test.ts` (both in the plan's `git add` list) already import route modules that trip the drizzle-orm cycle, so they fail COLLECTION on Windows independently of this change — Linux-CI-authoritative, same class as `plugin-tenant-routes.test.ts`. Only `cloud-plugin-runtime-exclusions.test.ts` of the plan's three RUNs on Windows.

## Findings

Consumes E0-F005 (route/app-importing tests use the Windows-skip / Linux-CI-authoritative pattern) and **resolves E0-F007 item 2** (the stale RW5a "stays allowed on cloud" comments in `routes/plugins.ts` + `routes/company-plugins.ts` — plus the same-class comments in `services/plugin-loader.ts`, which this ticket also re-touches — now reflect the FND-006/008 reality). No new findings. (The stale comments in `services/plugin-lifecycle.ts:500-502` and `services/marketplace-install/plugin-installer.ts:95-101`, flagged by the FND-006 review, are in files outside this ticket's `git add` set and remain carried forward.)

## Follow-up tickets

None required for E0. Optional 1.1 hardening: mount the marketplace INSTALL router as an explicit cloud 503/operation-error stub (Deviation 4); clean the residual stale comments in `plugin-lifecycle.ts` / `marketplace-install/plugin-installer.ts` when those files are next touched.

## Gate recommendation

`ready for independent review` — the unit-local dispatcher denial (RED→GREEN), the exact 503 envelope, the six-sink matrix, the FND-006 non-regression, and the dependency-free foundation checker + 7 new FND-008 mutations all pass locally (8/8 + 28/28 + 169/169); typecheck + build clean; `pnpm-lock.yaml` byte-unchanged. The real HTTP route matrix (uninstall/disable RED→GREEN, the full effectful set, projected reads, company routers, self-hosted positives) and the broker end-to-end flip bind on Linux CI — the Windows collection failure is the pre-existing drizzle `require(esm)` cycle (E0-F005), not a regression. A reviewer with a Linux runner should confirm `cloud-plugin-runtime-exclusions.integration.test.ts`, `plugin-broker-cloud.integration.test.ts`, `plugin-tenant-routes.test.ts`, `cloud-external-adapter-execution.test.ts`, and `plugin-ui-static-tenant-scope.test.ts` run green; those flips are source-derived + typecheck-clean but were not locally executed.

## Independent review

**Reviewer:** FND-008 independent reviewer subagent (Claude)
**Reviewed revision:** 0f04cc747c7054ba860de2401756430934f5c6c2
**Disposition:** `approved`
**Review evidence:**

Independent adversarial code-quality review of `git diff 271deab57..0f04cc747` (13 files). Reviewed revision = repo `HEAD` (`0f04cc747c7054ba860de2401756430934f5c6c2`); tree clean. Implementer role differs from reviewer role.

Commands re-run independently on this Windows box:

| Command | Exit | Result |
|---|---:|---|
| `node scripts/check-distributed-execution-foundation.mjs` | `0` | `distributed execution foundation: PASS` |
| `node --test scripts/check-distributed-execution-foundation.test.mjs` | `0` | tests 169, pass 169, fail 0 — incl. all 7 FND-008 mutation cases (docs-path drift, 503-envelope field drop, MCP broker denial removal, ui-static gate removal, facade-export drop, router-unmount→404, 2nd `__pluginSubsystem` starter) verified failing on mutation |
| `npx vitest run cloud-plugin-runtime-exclusions.test.ts` | `0` | 8/8 pass (MCP dispatch denial before `executeTool`; envelope; six-sink matrix; metadata-only listing) |
| `npx vitest run plugin-ui-static-tenant-scope.test.ts cloud-external-adapter-execution.test.ts` | `1` | Windows COLLECTION failure on the pre-existing drizzle-orm `require(esm)` cycle (E0-F005); the cycle-triggering route/app imports are unchanged context lines — not a regression, Linux-CI-authoritative (ratified) |
| `pnpm --filter @armyofagents/server typecheck` | `0` | `tsc --noEmit` clean — the `ReturnType<typeof pluginLoader>` / `PluginLifecycleManager` facade casts and every route call-site compile |

Code-quality findings — no Critical, no Important.

- **Denial-facade design (robust).** `cloudPluginDenialProxy` returns a throwing function on *every* property access; invocation (not access) throws, so no construction-time throw. `pluginRoutes` passes the facade as `lifecycleOverride` (arg 7), so `pluginLifecycleManager(...)` is never constructed; `registry = pluginRegistryService(db)` uses the real `db`. Verified every `lifecycle.*`/`loader.*` call site in `plugins.ts` (install 982/enable 1724-26/uninstall 1677/disable 1785/upgrade 1964-2006/config restartWorker 2150/rollback 2915-19/PUT settings 3076-3128) and `company-plugins.ts` (upgrade/approve/rollback/PATCH settings) is either behind an entry `rejectBlockedCloudExecution`/`isCloudPluginExecutionBlocked("loader")` gate or a `blockActivationInCloud` facade-throw caught by `respondIfCloudPluginBlocked` → canonical 503, with the facade call the first statement before any DB effect. No metadata-read path (GET list/detail/health/logs/dashboard) touches a facade — they use `db`/registry + `projectCloudPluginPolicyState`. `config` POST's `lifecycle.restartWorker` is guarded by `!isCloudPluginExecutionBlocked("worker-manager")` (false on cloud → never invoked).
- **Cloud else-branch control flow (clean).** `app.ts` else-branch builds only the two facades + mounts the 3 routers with real `db`; no worker manager / event+stream bus / job store / scheduler / coordinator / tool dispatcher constructed; `__pluginSubsystem` and `__paperclipPluginToolDispatcher` remain assigned exactly once each in the off-cloud `if` branch (checker (i5) pins count===1; grep confirms comment mentions don't match the `\s*=` assignment regex). All three router signatures match the facade arg mapping.
- **MCP denial ordering (correct).** `dispatchPluginToolCall` returns typed `forbidden` + `CLOUD_PLUGIN_BLOCK_MESSAGE` as the first statement after destructuring — before `readPluginDispatcher()`, `getTool`, `resolvePluginRunProjectId`, and any worker dispatch. `readPluginToolDefinitions` unchanged/metadata-only.
- **Checker additions (sound).** Static rules are genuine (envelope error/code/docs via `extractFunctionBody`; broker `isCloudPluginExecutionBlocked()` call vs import token; ui-static `("ui-static")`+503; plugins.ts 503-stub + both facade exports; app.ts mount + single-assignment starter guard). All 7 mutations proven to fail; no false-negative path observed. Checker remains dependency-free.
- **No silent catch-and-ignore.** Every `catch` either matches `CloudPluginExecutionBlockedError` → 503 or re-throws; comment cleanups accurate; no dead code introduced.

Minor observations (non-blocking, not recorded as findings): (M1) on a migrated cloud instance, a company enable/disable settings route could, in the narrow pre-boot-reconciliation window where a row is still persisted `status:"ready"`, return 503 *after* persisting the `enabled=false` metadata write — outcome is safe (disabled, never enabled/run) and self-corrects at boot. (M2) the `enable`/PUT/PATCH routes use the `blockActivationInCloud` facade-throw + catch rather than a pure entry gate — functionally correct (503, no effect leak) but less uniform than the new uninstall/disable entry gates. (M3) `plugin-ui-static.ts:270-273` retains a stale "RW5a" comment (file out of this ticket's modification set; gate itself correct).

Recorded deviation (ratified, not a defect): marketplace INSTALL router stays fail-closed 404 in cloud (deferred 503-stub to 1.1) — acknowledged per the spec-compliance verdict.

Confidence: HIGH on both the denial-facade robustness and the cloud-mount control-flow correctness. Basis: static reading of the actual mount path; the unit-local suite (8/8) proving the MCP dispatch denial + envelope + sink matrix on Windows; the checker + 7 mutations locking the source boundary; clean typecheck confirming the facade types; and the Linux-CI-authoritative route-matrix / broker-flip integration files exercising the real `buildCloudPluginDenial{Loader,Lifecycle}` + `pluginRoutes` mount path. The residual — full HTTP route-matrix runtime behavior on cloud — is the ratified E0-F005 Linux-CI-authoritative split (controller runs it in a short-path embedded-PG worktree before Task 9); source-derived + typecheck-clean give high confidence it passes.

Disposition: `approved`. No Critical/Important issues; all runnable focused commands pass. Status flipped to `complete`.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
| 1 | FND-008 independent reviewer subagent (Claude) | `0f04cc747c7054ba860de2401756430934f5c6c2` | `approved` | Re-ran independently: checker PASS (exit 0); `check-*.test.mjs` 169/169 (7 FND-008 mutations proven); `cloud-plugin-runtime-exclusions.test.ts` 8/8; server typecheck clean (exit 0). The 2 route-importing unit files Windows-collection-fail on the pre-existing E0-F005 drizzle cycle (unchanged imports; Linux-CI-authoritative). Adversarial read confirmed: facade throw-on-every-method robust; every effectful `lifecycle.*`/`loader.*` call site gated-or-caught → canonical 503 before effect; metadata reads use real `db`/registry; MCP denial is the first statement pre-dispatch; cloud else-branch constructs no worker/bus/scheduler/dispatcher and leaves `__pluginSubsystem`/`__paperclipPluginToolDispatcher` unset (single off-cloud assignment). No Critical/Important. Minor (non-blocking): narrow boot-window 503-after-disable-persist (safe); enable/settings routes use facade-throw+catch vs entry gate; residual RW5a comment in out-of-scope `plugin-ui-static.ts`. Marketplace-install 404 acknowledged as ratified deviation. Status flipped to `complete`. |
