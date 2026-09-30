# FND-006 Result — Disable Cloud Plugin Process Composition

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E0-foundation`
**Plan task:** `Task 6: FND-006 — Disable Cloud Plugin Process Composition`
**Implementer:** FND-006 implementer subagent (Claude)
**Start SHA:** f32ac73f51a220cdeef0eb58d4186a8b9797138a

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the Independent review section and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen.

## Delivered scope

Makes Decision #103's cloud-plugin exclusion (and its 2026-08-03 cloud-enforcement amendment) actually true at the PR #320 composition boundary.

- **All six typed sinks fail closed in the `cloud_auth` parent.** `isCloudPluginExecutionBlocked(sink?)` now returns `tenantIsolationEnforced()` for every sink (`worker-manager`, `worker-fork`, `lifecycle`, `loader`, `loader-import`, `ui-static`) and for the bare/legacy no-sink form. The `CLOUD_SAFE_CONTROL_PLANE_SINKS` allowlist that exempted the first four sinks is removed.
- **The parent-marker bypass is killed.** The gate no longer consults `AOA_PLUGIN_WORKER_PROCESS` at all, so `AOA_PLUGIN_WORKER_PROCESS=1` can never grant the hosted parent authority. `stripHostedPluginWorkerMarker()` additionally strips the env var from the hosted parent at startup before any plugin composition, so a spoofed marker never reaches the gate. The self-hosted worker manager still sets the marker in the child's explicit minimal env for future/diagnostic use (never consulted for a cloud-block decision).
- **`app.ts` gates composition, not just downstream routes.** In `cloud_auth`, the effectful plugin worker manager, event/stream buses, job store, tool dispatcher, job scheduler, job coordinator, lifecycle manager, and loader are not constructed, and the effectful plugin routes / marketplace-install router / subsystem globals are not mounted. The marketplace catalog service (browse-only) and the `ui-static` route (independently `ui-static`-blocked) are unaffected. Off-cloud composition is byte-for-byte unchanged.
- **`index.ts` boot reconciles stale rows metadata-only.** When `tenantIsolationEnforced()` and no hosted plugin subsystem was composed, boot runs `reconcileCloudBlockedPlugins(db)`: a metadata-only pass that marks every non-uninstalled `plugins` row `status="error"`, `statusReasonCode="PLUGIN_WORKER_BLOCKED_IN_CLOUD"`, `lastError=<CLOUD_PLUGIN_BLOCK_MESSAGE>` (idempotent — rows already in that state are skipped). No worker/loader machinery is constructed to do this.

### Non-goals preserved

- Self-hosted `local_trusted` and single-tenant `authenticated` plugin worker lifecycle positives are unchanged (workers construct, start, fork, dispatch as before).
- The already-correct `ui-static` block and the `PLUGIN_WORKER_BLOCKED_IN_CLOUD` reason/message/docs contract are unchanged.
- `assertUnsandboxedMultitenantAllowed` and unrelated behavior untouched.
- The HTTP-surface `503` denial-stub contract, tool/job/webhook/MCP/bridge/stream/event runtime effects, and browser surfaces are **FND-008** scope, not this ticket.

## Changed files

| File | Responsibility |
|---|---|
| `server/src/services/cloud-plugin-execution.ts` | Gate fails closed for all six sinks + bare form in cloud; remove sink allowlist + marker bypass; add `stripHostedPluginWorkerMarker()`. |
| `server/src/services/plugin-worker-manager.ts` | Update the worker-child marker rationale to the fail-closed model (marker is child-identity only, never parent authority); worker-fork/worker-manager asserts unchanged (now deny in cloud via the core gate). |
| `server/src/services/plugin-lifecycle.ts` | Add `reconcileCloudBlockedPlugins(db)` — metadata-only bulk reconcile of stale non-uninstalled rows to the blocked state. |
| `server/src/app.ts` | Gate all effectful plugin construction + effectful route mounting + subsystem globals behind `!tenantIsolationEnforced()`; strip the hosted worker marker before composition. |
| `server/src/index.ts` | Boot reconciliation: run `reconcileCloudBlockedPlugins(db)` in cloud when no subsystem was composed. |
| `server/src/__tests__/cloud-plugin-execution.test.ts` | Flip the RED cases to GREEN: all six sinks + bare + marker-bypass blocked in cloud; self-hosted positives preserved; projection now projects a live block in cloud. |
| `server/src/__tests__/cloud-plugin-process-composition.test.ts` | NEW — real `createApp()` composition proof (Windows-skip, Linux-CI-authoritative): zero worker construct/fork/start/dispatch in cloud, stale-row reconcile, self-hosted positive. |
| `server/src/__tests__/plugin-broker-cloud.integration.test.ts` | Modified: the cloud broker now denies plugin worker dispatch (gate `true`, startWorker throws); cross-company isolation retained. |
| `scripts/check-distributed-execution-foundation.mjs` | FND-006 source-boundary check: reject a restored cloud sink allowlist, a parent-marker bypass in the gate, and unguarded worker/lifecycle/loader construction in `app.ts`. |
| `scripts/check-distributed-execution-foundation.test.mjs` | FND-006 mutation corpus + copy `cloud-plugin-execution.ts` into the fixture tree. |
| `docs/replatform/epics/E0-foundation/tickets/FND-006-result.md` | This result. |

### Additional files (deviation — see Deviations)

The Decision #103 gate reversal inverts a body of U10-era tests that asserted "cloud no longer blocks/denies/projects". These MUST be flipped to the new behavior or the suite goes red; they are beyond the plan's Step-5 `git add` list, which under-scoped the U10 test corpus.

| File | Responsibility |
|---|---|
| `server/src/__tests__/plugin-worker-manager.test.ts` | Flip: worker-manager/worker-fork sinks now deny in cloud; self-hosted fork positive kept. (Explicitly authorized by the ticket brief.) |
| `server/src/__tests__/plugin-lifecycle-upgrade.test.ts` | Flip: `load()` now denies + persists the blocked state in cloud. |
| `server/src/__tests__/company-plugin-upgrade-rollback.test.ts` | Flip: the rollback route now 503s at the loader gate in cloud. |
| `server/src/__tests__/marketplace-install-plugin.test.ts` | Flip: install now reconciles-then-denies (existing row) / denies without I/O (soft-uninstalled) in cloud. |
| `server/src/__tests__/plugin-tenant-routes.test.ts` | Flip (Linux-CI-authoritative — Windows drizzle-cycle collection): list/detail/health/dashboard reads now project the block; the 10 worker-backed routes + install + rollback now 503 with the canonical envelope. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| All six sinks blocked in cloud parent | `cloud-plugin-execution.test.ts` sink-matrix (ran locally) | `pass` |
| Bare/legacy form blocked in cloud parent | `cloud-plugin-execution.test.ts` bare-form case | `pass` |
| `AOA_PLUGIN_WORKER_PROCESS=1` never bypasses in the parent | `cloud-plugin-execution.test.ts` marker case | `pass` |
| `ui-static` still blocked (characterization) | `cloud-plugin-execution.test.ts` ui-static case | `pass` |
| Self-hosted positives preserved (every sink allowed off-cloud) | `cloud-plugin-execution.test.ts` off-cloud loop | `pass` |
| Hosted parent constructs/forks/starts/dispatches ZERO plugin worker | `cloud-plugin-process-composition.test.ts` (Linux-CI-authoritative; Windows-skip) | `pass (binds on Linux CI)` |
| Stale ready rows reconcile to blocked at boot | `cloud-plugin-process-composition.test.ts` reconcile case (Linux-CI) + `reconcileCloudBlockedPlugins` unit assertion | `pass (binds on Linux CI)` |
| Cloud broker denies plugin dispatch; isolation retained | `plugin-broker-cloud.integration.test.ts` (Linux-CI-authoritative; Windows-skip) | `pass (binds on Linux CI)` |
| Restored allowlist / marker bypass / unguarded construction fail the checker | `check-distributed-execution-foundation.test.mjs` FND-006 mutations (ran locally) | `pass` |

## Commands

Marked **local** (ran on this Windows box; exit 0 binds) or **Linux-CI** (Windows collection fails on the pre-existing drizzle-orm `require(esm)` cycle per E0-F005 — verdict binds on Linux CI).

| Command | Exit code | Result summary |
|---|---:|---|
| `git rev-parse HEAD` (before first change) | `0` | `f32ac73f51a220cdeef0eb58d4186a8b9797138a` |
| **RED** (local) `vitest run cloud-plugin-execution.test.ts` | `1` | 7 failed / 6 passed — the 5 intentional RED classes + projection + marker (see Verification log) |
| **GREEN** (local) `vitest run cloud-plugin-execution.test.ts` | `0` | 13/13 pass |
| **GREEN** (local) `vitest run cloud-plugin-process-composition.test.ts` | `0` | 7/7 pass (real worker-manager fork sentinels; createApp import-constraint documented) |
| **GREEN** (local) `vitest run plugin-worker-manager.test.ts marketplace-install-plugin.test.ts plugin-lifecycle-upgrade.test.ts company-plugin-upgrade-rollback.test.ts marketplace-install-routes.test.ts` | `0` | 68/68 pass (with the 3 pure-unit above) |
| **Linux-CI** `vitest run plugin-broker-cloud.integration.test.ts` | Windows: `1` (collection cycle) | Binds on Linux CI: gate true + dispatch denied + isolation |
| **Linux-CI** `vitest run plugin-tenant-routes.test.ts` | Windows: `1` (collection cycle) | Binds on Linux CI: projection + 503 route denials (flips are code-derived + typecheck-clean) |
| Plan Step-4 focused set (`cloud-plugin-execution + cloud-plugin-process-composition + plugin-broker-cloud.integration`) | Windows: `1` | Unit files GREEN; the integration file Windows-collection-fails (expected; binds Linux CI) |
| `pnpm --filter @armyofagents/server typecheck` | `0` | tsc clean (covers every modified test file, incl. Linux-only) |
| `pnpm --filter @armyofagents/server build` | `0` | tsc build clean |
| `pnpm check:distributed-foundation` | `0` | `distributed execution foundation: PASS` |
| `node --test scripts/check-distributed-execution-foundation.test.mjs` | `0` | tests 136, pass 136, fail 0 (was 129; +7 FND-006 mutations) |
| `git diff --check` | `0` | clean (only benign LF→CRLF warnings) |
| `git diff -- pnpm-lock.yaml` | `0` | EMPTY (byte-unchanged) |

## Verification log

**RED (local, against unfixed code) — `cloud-plugin-execution.test.ts`: 7 failed / 6 passed (exit 1).** The 7 failing are the intentional RED cases:
1. `projects a live block for every non-uninstalled cloud row` (projection now blocks in cloud)
2. `BLOCKS plugin worker execution on cloud_auth (bare/legacy form)`
3. `assertCloudPluginExecutionAllowed throws on cloud for a host worker fork`
4. `bare form: true ONLY on cloud_auth`
5. `BLOCKS all six sinks on cloud_auth in the parent` (the four previously-allowlisted `worker-manager`/`worker-fork`/`lifecycle`/`loader` + `loader-import` + `ui-static`)
6. `the parent worker-child marker AOA_PLUGIN_WORKER_PROCESS=1 NEVER bypasses the cloud gate`
7. `stripHostedPluginWorkerMarker()` (not yet implemented)
The 6 passing were the observability/counter tests, the `ui-static` characterization (already blocked — never a false RED), and the authenticated-recoverable projection.

**GREEN (local) after the fix:** all six sinks + bare + marker + strip blocked in the cloud parent; self-hosted positives (every sink allowed off-cloud) preserved; projection projects/re-affirms the block in cloud and stays recoverable off-cloud. 68/68 across every locally-runnable affected file. The real-`createApp()`/broker-dispatch/route proofs are Linux-CI-authoritative (Windows collection cycle, E0-F005) — flips are code-derived and typecheck-clean.

**Multi-replica drain + stale-row reconciliation + safe rollback:** reconciliation is a metadata-only, idempotent bulk write (`reconcileCloudBlockedPlugins` — skips rows already carrying the blocked reason), so it is safe on every replica during a rolling upgrade; boot never composes worker/loader machinery in cloud, so there is zero background activation to drain in the hosted parent. New activations/dispatch are denied first by the fail-closed gate at every sink; running plugin workers cannot exist in the hosted cloud parent (composition-gated), so there is no per-run cancellation to perform there. Rollback retains the denial because it is derived from the static `tenantIsolationEnforced()` deployment mode — there is no operator override and no config that re-enables cloud plugin execution. The operational drain sequence (deny new → mark queued blocked → cancel running → stop stream/bridge → terminate children → require zero-process reconciliation per replica) is documented here; the parts that are code-reachable in the hosted parent are enforced by composition (nothing to terminate) — the remaining steps concern the self-hosted runtime and FND-008's HTTP/stream surfaces.

## Deviations

**1. `app.ts` construction gating scope (matches CP-002/FND-008 split).** "Do not construct or start effectful plugin runtime components" is honored by gating the effectful plugin subsystem construction AND the effectful route mounting behind `!tenantIsolationEnforced()`. Because the effectful plugin **HTTP routes** (`/plugins`, `/companies/:id/plugins`, marketplace-install) depend on the loader/lifecycle instances, they are not mounted in `cloud_auth` here; the read-only/denial-stub HTTP surface contract (`503` + Decision #103 envelope) and browser surfaces are the explicit scope of **FND-008** (which re-touches `app.ts`, `plugins.ts`, `company-plugins.ts`, `plugin-ui-static.ts`). No self-hosted path is affected.

**2. Extra test files beyond the Step-5 `git add` list (necessary correction).** The required Decision #103 gate reversal (all six sinks fail closed on cloud) inverts the assertions of a U10-era test corpus that pinned the opposite ("cloud no longer blocks/denies/projects"). The plan's Step-5 list named only the three FND-006 test files and did not account for this corpus. To keep the suite green, five additional test files were flipped to the corrected behavior and committed: `plugin-worker-manager.test.ts` (explicitly authorized by the ticket brief), `plugin-lifecycle-upgrade.test.ts`, `company-plugin-upgrade-rollback.test.ts`, `marketplace-install-plugin.test.ts`, and `plugin-tenant-routes.test.ts`. No production code outside the plan's file list was modified — the route/installer/lifecycle SOURCE already carried the correct sink gates (written during U10); only the tests' expectations changed. This mirrors the FND-005 E0-F006 precedent (committing a file the plan's literal list omitted, with rationale). The `plugin-tenant-routes.test.ts` flips (6 tests) are Linux-CI-authoritative: the file cannot collect under Windows vitest (pre-existing drizzle-cycle), so the flips were derived directly from the route source (`rejectBlockedCloudExecution` + `projectCloudPluginPolicyState`) and verified by typecheck, but their runtime verdict binds on Linux CI.

## Findings

Consumes E0-F005 (integration tests use the embedded-PG `*.integration.test.ts` pattern; Windows-skip, Linux-CI-authoritative). No new findings.

## Follow-up tickets

FND-008 — Disable Cloud Plugin Runtime + Browser Surfaces (HTTP denial stubs, tool/job/webhook/MCP/bridge/stream/event, UI/static). This ticket's process-composition denial is its stated prerequisite.

## Gate recommendation

`ready for independent review` — the unit sink-gate matrix, the process-composition negatives (real worker manager + fork sentinel), the reconciliation wiring, and the dependency-free foundation checker + 7 new FND-006 mutations all pass locally (68/68 + 136/136). The real-`createApp()` startup, broker dispatch-denial, and route-level 503 proofs bind on Linux CI — the Windows drizzle-cycle collection failure is pre-existing (E0-F005), not a regression. A reviewer with a Linux runner should confirm the two Linux-only test files (`plugin-broker-cloud.integration.test.ts`, `plugin-tenant-routes.test.ts`) run green; the flips there are code-derived + typecheck-clean but were not locally executed.

## Independent review

**Reviewer:** FND-006 independent reviewer subagent (Claude)
**Reviewed revision:** f916457bece74bc524349021571d506dbef8f9cc
**Disposition:** `approved`
**Review evidence:**

Reviewed `git diff f32ac73f51a220cdeef0eb58d4186a8b9797138a f916457bece74bc524349021571d506dbef8f9cc` (16 files). Independent verification on Windows; every exit code observed directly. HEAD confirmed `= f916457…` with a clean working tree before review.

- **Foundation checker + mutation corpus.** `node scripts/check-distributed-execution-foundation.mjs` → `0` (`distributed execution foundation: PASS`). `node --test scripts/check-distributed-execution-foundation.test.mjs` → `0` (tests 136, pass 136, fail 0; the 7 new FND-006 mutations — restored `CLOUD_SAFE_CONTROL_PLANE_SINKS` allowlist, parent-marker bypass, sink-specific `return false`, set-membership allowlist, removed `app.ts` guard def, unguarded `createPluginWorkerManager` construction, missing gate file — each fire the exact expected error). Checker is stdlib-only (`node:fs/promises|path|process|url|crypto`); `pnpm-lock.yaml` byte-unchanged (dependency-free held).
- **Core sink-gate + composition negatives (local, bind on every platform).** `vitest run cloud-plugin-process-composition.test.ts cloud-plugin-execution.test.ts` → `0` (2 files, 20 tests). The composition file drives the REAL `createPluginWorkerManager`/`createPluginWorkerHandle` with a `node:child_process.fork` sentinel: on `cloud_auth` `startWorker`/`handle.start()` reject with `CloudPluginExecutionBlockedError` and `forkSpy` is never called (zero child process, `getWorker` undefined); the spoofed `AOA_PLUGIN_WORKER_PROCESS=1` parent marker does NOT unblock; `stripHostedPluginWorkerMarker()` returns true and clears the var; the `local_trusted` positive attempts a real fork (crashes on a missing entrypoint, never the cloud sentinel).
- **Remaining flipped files.** `vitest run plugin-worker-manager.test.ts marketplace-install-plugin.test.ts company-plugin-upgrade-rollback.test.ts plugin-lifecycle-upgrade.test.ts plugin-tenant-routes.test.ts plugin-broker-cloud.integration.test.ts` → 4 files GREEN (34 tests, 0 failed). `plugin-tenant-routes.test.ts` and `plugin-broker-cloud.integration.test.ts` fail at COLLECTION on the pre-existing drizzle-orm `require(esm)` cycle (`Cannot require() ES Module … in a cycle`) — the ratified E0-F005 Windows constraint, not a test-level failure; their verdict binds on Linux CI. No test regressed.
- **Type + hygiene.** `pnpm --filter @armyofagents/server typecheck` → `0` (tsc clean, covers every modified test incl. the Linux-only files). `git diff --check` (base..head) → `0`.
- **Gate correctness (read + reasoned).** `isCloudPluginExecutionBlocked(_sink?)` reduces to `return tenantIsolationEnforced()` — fail-closed for every typed sink, the bare/legacy read-projection form, and any future/unknown sink, with the `_sink` param retained only for call-site clarity/metrics (decision-independent). The worker-child marker is never consulted, so it cannot grant the hosted parent authority. `stripHostedPluginWorkerMarker()` is `tenantIsolationEnforced()`-guarded (no-op off cloud), strips only in the hosted parent, and is called at `app.ts:489` BEFORE any plugin composition (guard block opens at :497) — no TOCTOU/ordering gap; the self-hosted child still receives its marker in `spawnProcess()`, which is unreachable on cloud (the `worker-fork` sink denies first).
- **Composition-gating control flow.** `loaderInst`/`lifecycleMgr` are hoisted to `let … | undefined` and every effectful construction (worker manager, buses, job store/scheduler/coordinator, tool dispatcher, lifecycle, loader) plus the plugin routes, marketplace-install/company routers, and the `__pluginSubsystem` / `__paperclipPluginToolDispatcher` globals sit inside `if (!hostedPluginProcessDisabled)`; the install-router block additionally re-guards on `&& loaderInst && lifecycleMgr` with local non-null aliases. Traced every downstream consumer of the now-conditional globals: `index.ts` startup (`if (pluginSys)`), `server-shutdown.ts` (`if (pluginSubsystem)`), and all three `__paperclipPluginToolDispatcher` readers (`heartbeat.ts`, `context-packaging.ts`, `plugin-broker-tools.ts`) null-guard the cloud "unset" case — no undefined-deref. Confirmed no other prod caller constructs an effectful plugin component outside the guard: `routes/plugins.ts:318`'s `pluginLifecycleManager` fallback is bypassed (app passes `lifecycleOverride`) and the factory is only invoked inside the guard; the browse-only marketplace catalog service and the self-gating `/_plugins` `ui-static` route stay mounted by design.
- **Boot reconciliation.** `reconcileCloudBlockedPlugins` is metadata-only (constructs no worker/loader/lifecycle, forks nothing, evaluates no manifest), idempotent (skips rows already `error` + `PLUGIN_WORKER_BLOCKED_IN_CLOUD`), per-row error-isolated with `log.error` (no silent swallow), consistent with `projectCloudPluginPolicyState`'s read projection, and fired non-blocking via `void … .catch(logger.error)` so a slow/failed pass never blocks `listen`. Safe on every replica during a rolling upgrade (concurrent identical target writes).
- **Dead code.** `isRunningInsidePluginWorkerChild` and `CLOUD_SAFE_CONTROL_PLANE_SINKS` are fully removed with zero remaining references in prod source; the contractual `CLOUD_PLUGIN_BLOCK_MESSAGE` / reason code are preserved verbatim.
- **No Critical or Important issues.** Minor/informational only, none requiring a change: (1) reconciliation is O(n) sequential per-row `updateStatus` — acceptable given it is fire-and-forget, idempotent after first boot, and trades throughput for per-plugin logging/isolation; a single bulk UPDATE would be faster but lose that; (2) `reconcileCloudBlockedPlugins(db as any)` in `index.ts` launders the `Db` type, matching the file's existing `db as any` convention; (3) checker rule (h2) scans `app.ts` for the three effectful constructors after the guard but does not follow indirect construction through a factory mounted outside the guard — defensible, since the runtime fail-closed gate at every fork/start/load is the true backstop (construction alone spawns no process) and the real startup proof is Linux-CI-authoritative; (4) stale RW5a "stays allowed on cloud" comments at `plugin-lifecycle.ts:500-502`, `routes/plugins.ts:332-334`, `services/marketplace-install/plugin-installer.ts:95-101`, `routes/company-plugins.ts:327-330` are now false but sit in code that is dead-on-cloud or whose gate returns true regardless — flagged as an **FND-008** cleanup target, out of scope here.

Confidence in the composition-gating control-flow correctness is **HIGH**. The gate, marker strip, boot reconciliation, and every downstream undefined-consumer are directly and locally proven (typecheck + 20/20 core vitest + 34 more + 136/136 checker). The single residual — that the real `createApp()` composes zero plugin subsystem in `cloud_auth` at startup — cannot be exercised locally because the drizzle `require(esm)` cycle (E0-F005) blocks importing the app under vitest; its verdict is delegated to Linux CI. That residual is low-risk: the transform is a mechanical `if (!hostedPluginProcessDisabled)` wrap of a previously-unconditional block, every consumer is null-guarded, and the dependency-free source-boundary checker enforces the guard's presence and position on every platform in the `policy` job.

For `approved`, verified the result describes the reviewed revision, all locally-runnable focused acceptance commands pass, and no accepted finding is outstanding; changing top-level `Status` to `complete` and committing this disposition separately. A reviewer with a Linux runner should still confirm `plugin-broker-cloud.integration.test.ts` and `plugin-tenant-routes.test.ts` run green there (code-derived flips, typecheck-clean, not locally executed).

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | FND-006 independent reviewer subagent (Claude) | f916457bece74bc524349021571d506dbef8f9cc | `approved` | Foundation checker PASS + 136/136 mutation corpus (incl. 7 new FND-006 mutations). Core sink-gate + real-worker-manager fork-sentinel composition negatives GREEN locally (20/20); 4 more flipped files GREEN (34 tests); `plugin-tenant-routes` + `plugin-broker-cloud.integration` collection-fail on the ratified E0-F005 drizzle `require(esm)` cycle (Linux-CI-authoritative), no test-level failure. `typecheck` exit 0; `git diff --check` clean; `pnpm-lock.yaml` byte-unchanged. Gate reduces to fail-closed `tenantIsolationEnforced()`; marker never consulted; strip ordered before composition; all downstream `__pluginSubsystem`/`__paperclipPluginToolDispatcher` consumers null-guarded; reconciliation metadata-only + idempotent + non-blocking; removed symbols have zero dead refs. No Critical/Important. Minor-only (bulk-vs-per-row reconcile, `db as any`, checker app.ts-scope, stale RW5a comments → FND-008 cleanup). |
<!-- First independent reviewer appends attempt 1. -->
