# Breadth terrain audit — S6–S9 verified against the tree, 2026-08-27

Four read-only terrain agents, one per breadth sprint, verified every go-book §4 scope claim for
Sprints 6–9 against the current tip (`3e9aec704`, worktree `C:\e3`). **Verdict: no drift — every
scope claim is STILL TRUE.** The value is in the gaps each surfaced early, recorded here so the
eventual sprint plans start from them rather than rediscover them mid-flight.

This is terrain, not a plan. Per the programme's own rule, each breadth sprint still writes its
full implementation plan at its own start, against the tree as it is then.

## Sprint 6 — execution-sink cutover (E10) · all 4 claims STILL TRUE

- MIG-005/006/007 are still shadow-only (`cli-mode.ts:1004-1017`, `aoa-agents/runner.ts:842-861`,
  `one-shot-sandbox-cli.ts:284`); the port is inert unless rollout is `shadow` and swallows errors.
- **GAP — five parity bridges, not three.** Besides `jobApprovalBridge`/`jobBudgetCostBridge`/
  `jobOutputBridge` (all zero-caller), **`jobAuditBridge` (`job-audit-bridge.ts:158`) is also
  zero-caller and tracked by NO gate clause** — invisible to the wiring register. Sprint 6's
  "promote the bridges" must include it or explain the omission.
- **GAP — the drain is more than a param rename.** Beyond the `organizationId`/`companyId` mismatch
  (`job-distributed-drain.ts:50,118` vs impls taking `companyId`), `listActiveAttempts` has **no SQL
  implementation** (interface + call site only), and `createExecutionTargetRevocationFanout`
  (register E3-18) has **zero callers while its producer is live** (Revoke writes a `pending` row
  nothing reads). Both are Sprint-6-adjacent teardown holes.
- **PREREQUISITE the note omits — Deferral #1** (worker receives no provider credential) still blocks
  MIG-005/006/007 **active**, per `MIG-005-006-007-shadow-result.md:189-190`. Note the overlap with
  E7-F001/CLI-007's canary-credential work — the same "credential reaches the run" theme.
- **FAVORABLE update:** MIG-002's per-sink dial has since shipped, so the go-book's "one sink at a
  time, do not batch" ordering — previously *unexpressible* — is now achievable
  (`config/distributed-execution-rollout-source.ts:270-271`).

## Sprint 7 — browser agents (E8) · all 4 claims STILL TRUE; the security item is STILL LIVE

- `packages/browser-runtime` still has **zero importers**; Sprint 3 did **not** deliver the promised
  execution path (the scope note's "Sprint 3 gives it an execution path" is stale — it's deferred to
  BRW-004+). Register `E8-1-sandbox-local-browser` still `unwired`.
- **LIVE SECURITY ITEM — still live, and with ZERO automated coverage.** The host-side
  `npx @playwright/mcp@0.0.75 --headless` spawn is still reachable from a boot root
  (`cli-mode.ts:347-352`, `:235`; reached from `heartbeat-mcp.ts:165` and
  `aoa-agents/runner.ts:795`). Critically: **`check-gate-clause-wiring.mjs` cannot catch this** — the
  register tracks only the positive `runBrowserSession` symbol, not the negative "no host-side spawn"
  clause, which lives only as exit-gate prose (`epics/E8-.../README.md:7`). The guard that would flag
  it is BRW-008's anti-orphan boundary check, which **does not exist** (no ticket, no node). So the
  clause is false AND green-by-absence. Sprint 7 must close the spawn or build that check — the note's
  "either close it or rewrite the clause" is unstarted.
- BRW-004/005/006 are nodes only (no files); BRW-007/008 need nodes. `BRW-003a-d` sub-tickets are
  absorbed under the `BRW-003` node by the coverage checker's id regex — no latent redness (verified).

## Sprint 8 — service agents (E9) · all claims STILL TRUE

- SVC-001 shipped storage only; `service_generations` has grants (`SELECT, INSERT`) but **no
  production writer** — the only INSERT is a test (`service-desired-state-schema.integration.test.ts:140`).
  It describes a property of an empty table.
- **SHARPENING — service dispatch isn't reachable at all yet.** The daemon is batch-only
  (`hello-provisioning.ts:22-27`, `SUPERVISABLE_WORKLOAD_CAPABILITIES = ["workload.batch"]`;
  `desktop-hello.ts:183` `serviceSlots: 0`). So the note's "needs dispatch plus health/restart/drain"
  understates it: **enabling `workload.service` dispatch is a prerequisite step before** health/
  restart/drain — the daemon refuses to advertise service work today.
- **GAP — E9 has no gate-clause entry** in `gate-clause-wiring.json`, so the wiring guard cannot catch
  a future false "E9 complete" the way it does for E3–E11. Create one when SVC work starts.

## Sprint 9 — hardening and release (E11/E0) · all claims STILL TRUE

- 30/30 Critical/High trust crossings name REL-001/002/003/005 as their release test
  (`docs/architecture/distributed-execution-threat-controls.json`). **Only REL-004 has ticket
  files**; REL-001/002/003/005 are plan nodes only.
- **The crux, pinned exactly:** `check-distributed-execution-foundation.mjs:745-751`
  (`crossingHasReleaseTest`) accepts a crossing if `c.releaseTest` is any non-empty string **or**
  `ownerTickets` contains a `REL-\d+`-shaped token — **never checking the ticket exists on disk**. So
  E0's gate is falsely-green. Sprint 9's two jobs stand: write the four REL tickets, and make the
  checker require the named release-test ticket to exist (flips E0 to honestly-red until E11 lands).
- Red herring cleared: the §5 debt row's "README.md:6" is the **E2** epic README (tenant-kernel gate
  revision), unrelated to E0/E11's release gate.

## Net

The go-book's S6–S9 scope survives contact with the tree — a good sign for the programme's honesty.
The material additions for the eventual plans: **S6** owns five bridges + a drain that needs real SQL
+ a credential prerequisite; **S7**'s live security item has zero automated coverage and must build
its own guard; **S8** must enable service dispatch before health/restart/drain and file an E9 gate
clause; **S9**'s checker gap is a two-line non-existence check away from honest. None changes the
sequence; all sharpen the prompts.
