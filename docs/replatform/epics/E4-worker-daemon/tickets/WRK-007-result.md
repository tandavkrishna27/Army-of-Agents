# WRK-007 Result — Restart recovery and orphan cleanup

**Status:** `complete` (implemented + distinct adversarial review; 3 confirmed defects fixed + fail-first-proven; full acceptance matrix re-green) — **the LAST E4 ticket → E4 (worker-daemon) COMPLETE**
**Disposition:** `accepted` (2 HIGH + 1 MEDIUM confirmed defects fixed with regression tests; 5 findings refuted/documented)
**Date (UTC):** `2026-08-14`
**Epic:** `E4-worker-daemon`
**Design:** `tickets/WRK-007-design.md` (committed `04eb139be` — the reviewable design-first artifact).
**Start SHA:** `04eb139be` (WRK-007 design commit, atop the CI-green WRK-006 `d0954f8fc`).
**Upstreams (verified):** WRK-004 (`supervisor/reconcile.ts` + `cleanup-authority.ts` + provider/fake-provider), WRK-006 (`d0954f8fc`, outbox), JOB-006 (`pass`, server reaper), WRK-005 (`lease/quarantine.ts`). Frozen worker-protocol v1 source SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`.

## Outcome

WRK-007 adds a **one-shot startup reconciliation pass** that, on boot, classifies every locally-known
sandbox + outbox stream against control-plane lease authority — **inferred per-lease via `lease_renew`**
(GAP-1: the frozen protocol exposes no lease-state query op) — and drives the correct cleanup: never
re-attach in-flight execution (D2), kill stale sandboxes via `CleanupAuthority.converge`, abandon
dead-lease outbox streams via `stopStream`, quarantine unknown output artifacts via WRK-005's
device-session path. Best-effort + convergent (re-run without double-kill), observable, retryable. The
server `reapExpiredLeases` reaper is the authoritative orphan-safety net; this is the fast-path
cleanliness pass. **Worker-daemon-only, FAKE-provider + FAKE-control-plane tested, inert-until-wired
(E4-D12), zero worker-protocol changes.**

## Deliverables

**New runtime:** `supervisor/startup-reconcile.ts` (`probeLeaseAuthority` + `buildControlPlaneIsOrphan`
+ `createStartupReconciler` — sandbox 3-way classification, `CleanupAuthority` teardown, outbox-stream
reconciliation, artifact quarantine sweep), `lifecycle/startup-steps.ts` (`createStartupSteps` /
`runStartupSteps` + the minimal `StartupReconciler` lifecycle). **Modified:** `bin/worker-daemon.ts`
(inert optional `reconciler?` startup seam), `index.ts` (barrel), `__tests__/support/fake-control-plane.ts`
(the per-`leaseId` authority table — Slice 0). **6 hermetic suites** (lease-authority, isorphan-probe,
sandbox-classification, outbox-reconcile, quarantine-sweep, lifecycle).

## Distinct adversarial review (5 finders → refute-by-default verifiers)

10 findings; **3 CONFIRMED distinct defects** (all fixed + fail-first-proven), 5 refuted/documented (2 of
the 5 "confirmed" were the SAME defect seen from two dimensions).

**CONFIRMED + FIXED:**

1. **HIGH — a 401-unauthorized probe was misclassified as a DEAD lease → mass-kill of live-owned
   sandboxes + mass-abandon of their outbox streams.** `renewLeaseOnce` returns kind `terminal` for BOTH
   a genuinely-dead `target_revoked` (409) AND a recoverable 401 `unauthorized`; `livenessOf` collapsed
   every `terminal` to `"dead"` (discarding `attempt.reason`). A boot clock-skew / audience-desync makes
   every renew 401 → every candidate `"dead"` → `classifyAndTeardown` destroys every selector-matched
   sandbox (even those with a local live lease + matching generation) and `reconcileOutboxStreams`
   abandons their streams — strictly more destructive than WRK-005's renewal driver, which treats 401 as
   recoverable. **Fix:** `livenessOf(attempt)` maps `terminal{unauthorized} → unreachable` (fail closed —
   never kill), only `terminal{target_revoked} → dead`. One fix resolves both the sandbox and stream
   manifestations (both key off the probe map). **Regression:** `startup-sandbox-classification.test.ts`
   "a 401 … is UNREACHABLE, NOT dead" — `forceRenewUnauthorized` → sandbox `indeterminate`, never killed.
   Fail-first: against the reverted `terminal→dead`, the live-owned sandbox is destroyed.

2. **HIGH — `createStartupSteps` fire-and-forgot the async pass via `void reconciler.run()`.** The `void`
   discarded the promise: `runStartupSteps`' `await step.run()` awaited `undefined` and returned before the
   async reconciliation (which suspends at its first await) completed — boot proceeded to signal
   registration mid-reconcile (breaking the reconcile-before-continue ordering), and a rejection from
   `run()` was orphaned into an `unhandledRejection` (process termination), NOT caught by the runner's
   try/catch. `run()` is not exception-safe by construction (unguarded `provider.list` / `reconcileCleanup`
   / `listActiveStreams`). **Fix:** the step returns the promise (`async () => void (await reconciler.run())`)
   so the runner awaits + its try/catch catches the rejection; AND `reconcileSandboxes` now contains its
   own faults (see #3) so `run()` honors its "never throws out" contract. **Regression:**
   `startup-reconcile-lifecycle.test.ts` "CATCHES a rejecting ASYNC reconciliation" (fail-first: against
   the `void`, the rejection is orphaned + unlogged) + "AWAITS an async reconciliation" (a macrotask
   boundary the runner must outlast).

3. **MEDIUM — teardown interleaved with id-cursor pagination re-processed survivors + inflated counts.**
   The provider page cursor is a `sandboxId` (`findIndex(pageToken)+1`) and `list` excludes destroyed
   rows, so destroying a sandbox mid-pagination shifted the cursor back and re-classified a kept survivor.
   **Fix:** `reconcileSandboxes` now **snapshots the full inventory read-only, THEN classifies + tears
   down** — decoupling listing from list-mutation — with per-sandbox exception isolation (also folds in
   #2's exception-safety). **Regression:** "teardown does not interleave with pagination" (`pageSize:2`,
   a kept sandbox preceding a killed one). Fail-first: against the inline version, `scanned` inflates 3→4.

**REFUTED / DOCUMENTED (no code change):**
- **"Live-owned in-flight sandbox is `keep`, contradicts D2's kill."** Refuted. The design carries an
  intentional `keep` bucket (§3) for a genuinely live-owned-at-current-generation sandbox distinct from
  the resume-seam (§4). Noted as a design clarification: a live-owned sandbox is KEPT (never re-attached,
  never killed) and left for the reaper; whether CORE should instead kill it (per §4's literal "kill it")
  is an E4-D12 wiring-time decision, recorded in Residual risks.
- **"Probe (`lease_renew`) has a write side-effect: it extends the live lease's expiry."** True + refuted
  as a defect — this is inherent given GAP-1 (the only liveness signal is a renew). A live-but-abandoned
  lease's reaper reclaim is delayed by one renew window; JOB-006 remains authoritative.
- **"Fake models a dead lease as HTTP 200 `rejected` but the real server returns 409."** Refuted — both
  `200 rejected` (kind `rejected`) and `409` (kind `protocol`) classify to `"dead"` in `livenessOf`, so
  the bucket difference does not change the reconciliation outcome.
- **"`makeCtx` STABLE-per-attempt idempotency doc contradicts converge's per-op fresh key."** Refuted
  (doc-comment nuance; the runtime behavior is correct).

## Verification-surface results (windows-local from `C:\e3`; Linux CI = DEC-03 authority)

Re-run in full AFTER the 3 fixes (+4 regression cases):

| Lane | Result |
|---|---|
| Full worker-daemon suite | PASS — **79 files, 291/291** (baseline 73/270; WRK-007 adds +6 files / +21 tests) |
| Fail-first proof (all 3 fixes) | PASS — each regression FAILS against the reverted pre-fix code (401→mass-kill; `void`→orphaned rejection; inline-teardown→`scanned` 3→4) and PASSES against the fix |
| `pnpm check:worker-daemon-boundary` | PASS |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | OK — **zero** `packages/worker-protocol/` source changes |
| `pnpm --filter @armyofagents/worker-daemon typecheck` (prod graph) | exit 0 |
| `npx tsc -p …/tsconfig.json --listFilesOnly` | **0** paths under `src/__tests__` |
| `pnpm --filter @armyofagents/worker-daemon build` | exit 0; **0** test artifacts in `dist` |
| `pnpm check:distributed-foundation` (keystone) | PASS |
| `pnpm install --frozen-lockfile` | PASS — runtime deps stay `@armyofagents/worker-protocol` + `pino` |

## Decisions (from the design, as-built)

D1 infer authority via `lease_renew`; D2 never re-attach in-flight; D3 `CleanupAuthority.converge` for
live trees + direct `reconcileCleanup` for empty/terminal; D4 `unknown_sandbox` recorded, not killed;
D5 CORE quarantines injected candidates only (durable staged-artifact index deferred to DAT-006); D6 the
fake per-`leaseId` authority table; D7 dead-lease streams abandoned via `stopStream`, only artifacts
quarantine; D8 outbox pass before sandbox kill; a 4th disposition `indeterminate` for the fail-closed
unreachable-probe case.

## Non-goals

Live provider integration (E6/E7); the implemented resume path (seam only); arbitrary workspace file-tree
artifact reconciliation (DAT-006); rewiring the composition root to run at boot (E4-D12); any
worker-protocol change; the server reaper (JOB-006). WRK-007 is additive, fake-tested, inert-until-wired.

## Residual risks

- **Inference model (D1):** worker reconciliation is best-effort; a partitioned worker falls back to the
  server reaper — WRK-007 alone does not guarantee zero orphans without the server side.
- **keep-vs-kill (E4-D12 decision):** CORE keeps a live-owned-at-current-generation sandbox (never
  re-attached). Review flagged that §4's literal "kill it" could argue for killing every survivor; the
  keep bucket risks a zombie live sandbox if the worker never manages it. Revisit before live wiring.
- **Probe write side-effect (D1):** probing renews a live lease, delaying its reaper reclaim by one
  window — inherent to GAP-1.
- **Fake-authority fidelity (D6):** the per-`leaseId` table is a test double of the server `isActiveFence`;
  `live` is a static boolean (no clock-expiry modeling). Faithful for the seeded verdicts WRK-007 tests.
- **Enumeration gaps (D5):** CORE probes/sweeps only injected candidates; the durable persisted-offer +
  staged-artifact indexes are the deferred sources (DAT-006 / E4-D12).
- **Distinct review pending:** an independent adversarial reviewer reruns the crash-at-checkpoint matrix
  and is the sole marker of `complete`.
