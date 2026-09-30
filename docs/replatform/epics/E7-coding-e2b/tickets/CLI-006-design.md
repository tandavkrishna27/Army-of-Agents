# CLI-006 Design — First coding golden journey and tenant canary (E7 GATE)

**Status:** `design` (reviewable artifact; implementation via fail-first TDD + distinct adversarial review). **Medium ticket — the FIRST transfer of execution ownership from the legacy adapter to the distributed path, for exactly ONE canary Organization.**
**Epic:** `E7 — Coding/CLI workload on E2B` (sixth and final ticket — the **epic exit gate**). **Authoritative source:** `program-design.md:790-795` (CLI-006) + `docs/replatform/epics/E7-coding-e2b/README.md` (exit gate) + `docs/replatform/test-gates.md` (D1 §86-96, D2 §113-122).
**Depends on (status verified landed on this branch):** CLI-005 (`e0da663c6`), JOB-008 (E3 complete), DEP-009 (E6 complete), MIG-008 (`089ed3458`), `E10-REALTIME-FOUNDATION` (closed by MIG-003 `9a6910aed`).
**Start SHA:** `cd93ef8ff`. Frozen `packages/worker-protocol` v1 (source SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`) and the worker-daemon `SandboxProvider` port — never edited.

---

## 1. Scope + framing

**Outcome (program-design.md:793):** route one Organization's coding task through the distributed path and surface its durable evidence in the existing run experience.

**Acceptance (program-design.md:794):** MIG-008 has reconciled legacy environment leases/resources and moved provider-control authority **before the rollout flag can transfer the first live execution**. Create task, schedule, lease, stage, execute, stream, produce patch, review, retry, cancel, audit, and operator inspection all succeed; existing non-canary tenants remain on the legacy path.

**The thesis.** Every prior E7/E3/E4 ticket shipped its half **deliberately inert**:

| Landed | Deliberately inert because |
|---|---|
| CLI-005 active convert | job is **non-leasable + never placed**; `adapter.execute` stays the sole executor (O1) |
| CLI-003 producers | live streaming population is the **E4-D12** seam; `observeRun` default-off |
| CLI-002 staging | admitted, but nothing calls it from a live lease |
| CLI-004 reconciliation | no live leaked-sandbox producer yet |
| MIG-008 reconciler + credential resolver | **no runtime caller** |
| MIG-003 durable realtime | wired, but no distributed run produces events yet |
| E4 worker daemon | `bin/worker-daemon.ts` poll loop **inert-until-provisioned** (E4-D12) |

CLI-006 is the ticket that makes exactly one Organization's coding run traverse all of it **live**, and is therefore the first place a *double-execution* or *ownership-split* defect can exist. Its entire risk budget is spent on one question: **who executes this run?** Everything else is surfacing and evidence.

**What CLI-006 is NOT.** It is not the cutover. Non-canary Organizations must stay byte-identically legacy, which is what makes this reviewable and rollback-safe; the full tenant/domain cutover is MIG-002, and the per-sink cutovers are MIG-005/006/007.

| Workstream | Lane | Kind | Responsibility |
|---|---|---|---|
| `canary` rollout mode | `distributed-execution-rollout-source.ts` | extend (config) | a fourth resolved state above CLI-005's `active`; config-only, default-absent |
| MIG-008 preflight gate | new service | new | fail-closed durable assertion that reconciliation + credential-authority move completed for this org **before** first transfer |
| Execution-ownership transfer | new service + `heartbeat.ts` seam | new | ONE decision point: place the attempt (leasable) **and** suppress the legacy execute, or neither |
| Run-experience projector | new service | new | distributed attempt evidence → `heartbeat_runs` / run events / run-summary comment |
| Cancel + retry routing | wire | wire | canary run cancel → fence-revoking `requestCancellation`; retry → JOB-006 policy |
| Journey + failure matrix | tests + D1 lane | new | no-key core on the PR gate; live journey in `d1-merge-train.yml`; keyed D2 cases |

---

## 2. Load-bearing facts (each independently re-verified in `C:\e3` at `cd93ef8ff`)

1. **The convert is non-leasable purely by omission.** `job-convert-orchestrator.ts` calls `bridge.admitAndSubmit` and *nothing else* — it "holds no placement dependency at all" (module header). Leasability is therefore **added by calling placement**, not by flipping a column.
2. **Placement gates leasability on rollout mode.** `job-placement.ts:663` — `leaseEligible: input.rollout.mode === "active"`. A canary attempt must resolve to a rollout mode that placement treats as `active`, or it will be placed non-leasable and silently never run. *(CLI-005's design cited `:670`; the line has since drifted — re-verified at `cd93ef8ff`.)*
3. **`placeJobAttempt` still has zero live callers** (CLI-005 §2 O7, re-verified — the only other reference is `job-placement-transaction.ts:103`, itself uncalled) — CLI-006 introduces the first one. `createJobPlacementService` (`job-placement.ts:442`) accepts injectable org/workload resolvers; `placeJobAttempt` (`:420`) hardcodes `enabled:false`, so the **service** form is the wiring point, not the bare function.
4. **The legacy executor is one call site.** `await adapter.execute({…})` at `heartbeat.ts:5147` — the single point that must be suppressed for a canary-owned run. *(CLI-005's design cited `:5032`; re-verified at `cd93ef8ff`.)*
5. **The convert seam already exists and is correctly gated.** `heartbeat.ts:3193-3228`, guarded on `distributedRolloutHook && state==="active" && shouldAutoCheckoutForWake && issueId && issueContext && assignee===agent.id`. *(This fact stands, but the original inference from it — "CLI-006 extends this block" — was wrong: the envelope cannot be built this early. See **D3a**.)*
5a. **The job envelope is immutable and carries context as artifacts.** `batchWorkloadV1Schema` (`packages/worker-protocol/src/job.ts:288-296`) = `command` / `args` / `stdinArtifactId` / `maxRuntimeSeconds`, plus the workspace `manifestArtifactId` (`:272`). The envelope is fixed at submission, so submission cannot precede context assembly.
5b. **`admitAndSubmit` always checks out.** `job-admission-bridge.ts:291-299` drives `issueService.checkout` for every `task_run`; the only bypass is `findIdempotentReplay` (`:290`), which covers redelivery, not a first submit. `taskSourceIsAdmitted` (`packages/db/src/repositories/tenant/job-control.ts:1391-1393`) admits exactly when `checkoutRunId === runId && executionRunId === runId`, so a harness checkout satisfies admission — but a later `admitAndSubmit` would still check out a second time. (See **D3a**.)
6. **Rollout config shape.** `AOA_DISTRIBUTED_EXECUTION_ROLLOUT` = `{organizations:{<id>:{mode:"shadow"|"active",workloads:[…]}}}`; `resolveRunRolloutState` consults `readDistributedExecutionDeploymentFlag` FIRST, so `AOA_DISTRIBUTED_EXECUTION_ENABLED=false` defeats any map entry. A new `mode` value is a parser change in `parseDistributedExecutionRolloutMap` (which currently *throws* on any mode other than `shadow`/`active` — a forward-compat trap: an old binary reading a new config fails loudly at startup, which is the correct fail-closed direction).
7. **MIG-008 durable evidence exists to gate on — but it is COMPANY-scoped and closure is COMPUTED, not stored.** `packages/db/src/schema/legacy_resource_reconciliation.ts` keys on `companyId` (unique `(companyId, resourceKey)`); `server/src/services/legacy-resource-reconciliation.ts` exposes `assertClosure` (a **pure** function over `inventoryKeys` + `records`), `reconcileCompanyLegacyResources(companyId, …)`, and a `LegacyReconciliationStore` with `listLeases` / `platformDefaultEnv` / `currentKeyGeneration` / `casClaimPaused` / `insertRecordIfAbsent`. There is **no persisted "reconciliation complete" flag** and **no `listRecords` read method**. Neither has a runtime caller — CLI-006's preflight is that caller. → two consequences: the preflight must **recompute** closure (D2), and the store needs one additive read method.
8. **Organization ⊃ Company, and the two scopes do not coincide.** `companies.organizationId → organizations.id` (`companies.ts:20`); the mapping helper is `resolveCompanyOrganizationId(appDb, companyId)` (`job-admission-bridge.ts:252`). The rollout/canary map is keyed by **`organizationId`**, while MIG-008 closure is per **`companyId`**, and one Organization may hold many Companies. Checking only the run's Company would let an Organization be canaried while a **sibling Company's** legacy leases/resources stay unreconciled — a fail-open against the acceptance clause, which scopes the gate to the Organization the flag transfers. (See D2.)
9. **The worker daemon is fake-control-plane tested and inert.** `packages/worker-daemon/src/__tests__/support/fake-control-plane.ts`; `bin/worker-daemon.ts` composes the poll loop **inert** per E4-D12 (WRK-003/004/007 results). The *live* worker↔control-plane path exists only in `docker-compose.d1.yml` (`worker-a`, `worker-b`, `fake-provider`, 2 control planes, Toxiproxy, MinIO).
10. **The D1 lane is live and iterable.** `.github/workflows/d1-merge-train.yml` fires on push to `docs/replatform-program` under a path filter; `docker/d1/campaign.env` selects `AOA_D1_CAMPAIGN=bounded|foundation` and doubles as the re-trigger nonce. **`server/src` is NOT on its path filter** — a server-only change must bump `campaign.env` to rebuild the control-plane image.
11. **Operator inspection already ships.** JOB-008 landed tenant-scoped job/attempt/event/worker/placement inspection + cancel + drain + revoke (`job-operations.ts`, `job-operations-routes.test.ts`). CLI-006 asserts the canary's rows are inspectable and redacted; it does not build a new surface.
12. **D1/D2 are volume gates, not code.** `test-gates.md:86-96` (D1: ≥1,000 lease races, ≥100,000 events, ≥100 lifecycle faults, 20 seeds × 10,000 ops) and `:113-122` (D2: ≥120 real E2B jobs, ≥20 each across six classes, **three consecutive passing runs**, p95 cancellation ≤30s). These are campaign records produced by the D1 lane and an operator-dispatched keyed campaign — they cannot be discharged by a ticket's unit tests, and claiming otherwise would be the exact overclaim CLI-005 had to retract.

---

## 3. Invariants (each gets a test)

1. **Exactly one executor, decided once.** For any run, `adapter.execute` runs XOR a leasable distributed attempt exists. The decision is computed at a **single** point and both consumers read that one value — never two independent predicates that can disagree.
2. **Fail-safe direction is legacy.** Every failure mode in the transfer path (preflight refusal, placement throw, config error, missing capacity, DB error) resolves to *legacy executes* — never to "neither executes" and never to "both execute". A canary run must never be silently dropped.
3. **Preflight precedes first transfer.** No canary run transfers ownership unless MIG-008 reconciliation **and** the credential-authority move are durably recorded complete for that Organization. The gate is fail-closed on absence, unreadability, and staleness.
4. **Non-canary isolation.** An Organization absent from the canary map is byte-identical to `cd93ef8ff` legacy — same checkout, same executor, same events, no placement, no preflight query. Proven by a matrix test across `off`/`shadow`/`active`/`canary`.
5. **Placement-then-suppression is not two steps.** Suppression is derived from a durable placement outcome, not asserted alongside it. If placement did not durably produce a leasable attempt, the legacy path runs.
6. **Cancellation reaches terminal.** Cancelling a canary run revokes the fence (`requestCancellation`) and the attempt reaches a durable terminal state; a late worker result is rejected `stale_fence`. (Latency bounds are D1-05/D2-04 campaign clauses, not unit assertions.)
7. **Retry does not double-execute.** A retried canary attempt is a new fenced attempt; the prior fence is dead. Retry never resurrects the legacy executor for the same run while a live attempt exists.
8. **Evidence surfaces without inventing authority.** The projector writes the distributed attempt's durable evidence into the existing run experience; it is a **read/project** path and never a second source of truth for run state.
9. **Rollback is a config edit.** Removing the org from the map (or flipping `mode` back to `active`) returns the next run to legacy with no code change, no migration, and no orphaned leasable attempt.

---

## 4. Decisions

### D1 — A fourth rollout mode `canary`, not an overload of `active`
CLI-005's `active` semantics ("durable non-leasable convert, legacy executes") are landed, reviewed and CI-green; overloading them would silently change the meaning of an existing config and make rollback ambiguous. `canary` is a strict superset: everything `active` does, **plus** placement + suppression. `parseDistributedExecutionRolloutMap` gains `"canary"`; `resolveRunRolloutState` returns it; **`resolveDistributedExecutionRollout`'s placement input maps `canary → "active"`** so `job-placement.ts:663` yields `leaseEligible: true` (fact §2.2). Rollback = delete the key or set `active`.

### D2 — MIG-008 preflight: recomputed closure, over EVERY Company in the Organization
A new `canary-preflight.ts` asserts, for the Organization the flag transfers, that (a) legacy environment-lease/resource reconciliation closure holds, and (b) provider-control credential authority has moved (the MIG-008 composite `<secretId>:<version>` generation is current). Absence, staleness, unreadability, or any throw → **refuse** → legacy executes (Invariant 2). The gate's result is part of the single ownership decision (Invariant 1), not a separate precondition someone can forget to check.

Two consequences fall out of fact §2.7-8 and drive the shape:

- **Recompute, don't read a flag.** MIG-008 persists crosswalk *records*, not a completion marker, and `assertClosure` is a pure function. The preflight therefore re-derives closure from `listLeases` + the persisted records on each canary run, reusing MIG-008's own authority function rather than a second definition of "reconciled". This is self-healing in the right direction: a legacy lease appearing after reconciliation makes closure false and the canary falls back to legacy. It needs **one additive read method** on `LegacyReconciliationStore` (`listRecords(companyId)`); no schema change, no migration.
- **Enumerate the Organization's Companies, not just the run's.** Closure is per-Company; the flag is per-Organization; an Organization may hold many Companies. The preflight resolves the Organization (`resolveCompanyOrganizationId`), enumerates **every** Company under it, and requires closure for all of them — a single unreconciled sibling refuses the transfer. Checking only the run's Company would be a fail-open (fact §2.8) and is the first thing the adversarial review should try.

Canary volume is low by definition, so the per-run recomputation is not cached; a cache whose stale `true` outlives a newly-unreconciled resource would reintroduce exactly the fail-open this decision closes.

### D3 — One ownership decision: `resolveRunExecutionOwner`
The crux. A single service returns a discriminated result — `{owner:"distributed", jobId, attemptId}` or `{owner:"legacy", reason}` — computed by: rollout state is `canary` → preflight passes → convert succeeds → **placement durably yields a lease-eligible attempt**. Any step short-circuits to `{owner:"legacy", reason}`. `heartbeat.ts` stores this one value; the suppression at `:5032` reads *that value*, never re-derives the condition. This is the design property that makes double-execution structurally hard rather than merely tested-against.

### D3a — ORDERING REVISION (found during implementation; supersedes D3's placement in the run)

D3's decision logic is right and is landed. Its **position in the run** was wrong, and the correction is load-bearing.

**The problem.** The frozen batch envelope (`packages/worker-protocol/src/job.ts:288-296`) carries the run's context as *artifacts* — `stdinArtifactId` plus the workspace `manifestArtifactId` (`:272`) — and the envelope is part of the **immutable submission**. So a job cannot be submitted before the run's context has been assembled. But context assembly happens in the ~2,000 lines *after* the CLI-005 convert seam (`heartbeat.ts:3193-3228`), so converting there can only ever submit a context-free envelope that no worker can execute.

Moving the convert later collides with checkout ownership: `admitAndSubmit` drives its own `issueService.checkout` for every `task_run` (`job-admission-bridge.ts:291-299`), and its only bypass is the `findIdempotentReplay` fast-path — which does not apply to a first submit. Harness-checkout-then-late-submit therefore checks the run out **twice** (status→in_progress, `startedAt` reset, duplicate `issue.status_changed`) — Invariant 3, the exact break CLI-005's review caught for active mode.

**The three shapes, and the choice.**

1. *Convert early, fill context later* — impossible without changing the immutable-submission contract (E3-owned). Rejected.
2. *Convert late, with a checkout-already-owned bypass on the bridge* — the harness checks out exactly as it does today (byte-identical, so canary needs no change at `heartbeat.ts:3165`), and `admitAndSubmit` gains a small guard mirroring its existing replay fast-path: when `issues.checkoutRunId === runId && executionRunId === runId` already hold, the checkout is already precisely what it would establish, so skip it and proceed to submit. Admission (`taskSourceIsAdmitted`) still passes because it tests exactly those two columns. **Chosen.**
3. *Hoist context assembly above the seam* — a ~2,000-line refactor of the legacy path for a canary feature. Rejected on risk.

**Consequences for the next increment.** The canary decision moves to just before `adapter.execute` (`heartbeat.ts:5147`), where the context exists; the convert+placement+suppression then sit adjacent, so ownership is decided and acted on at one point rather than 2,000 lines apart. The harness checkout stays untouched for canary, which retires the `:3165` concern recorded in commit `c1575ae4b`. The bridge bypass is additive, E3-owned, and needs its own fail-first test proving a run is never checked out twice and that a genuinely un-checked-out run is still refused.

### D4 — Suppression is derived, and it is the only edit to the legacy call site
The `adapter.execute` call site gains exactly one guard reading the D3 result. No other legacy behavior changes. If the guard is absent the system is legacy — the safe default under partial deployment.

### D5 — Run-experience projector
`canary-run-projector.ts` consumes the attempt's durable events (JOB-005 ingest + MIG-003 realtime catch-up) and projects into `heartbeat_run_events`, the run's terminal state, and `postRunSummaryComment` (the shared writer — heartbeat and crew already delegate to it). Projection is best-effort per-substep and never fails the run; it is explicitly **not** a second authority for run state (Invariant 8).

### D6 — Cancel + retry routing
A canary-owned run's cancel routes to `requestCancellation` (fence-revoking, idempotent, graceful|hard) instead of the legacy kill; retry routes through JOB-006 attempt policy. Both are wiring over landed mechanisms.

### D7 — Operator inspection is asserted, not built
JOB-008's surface already exists (fact §2.12). CLI-006 adds assertions that the canary job/attempt/events are tenant-scoped, redacted, secret-free, and explain queued/leased/terminal — no new operator UI.

### D8 — Test split: no-key core (PR gate) / live journey (D1 lane) / keyed journey (D2 lane)
Following the handoff's scoping note and the CLI-001 precedent:

- **No-key core — PR `verify`.** The ownership decision matrix (every short-circuit → legacy), the preflight fail-closed matrix, non-canary byte-identity across all four modes, projector behavior, cancel/retry routing, and double-execution prevention. In-process/mocked; this is where the *logic* is proven.
- **Live journey — `d1-merge-train.yml`.** The 13 acceptance verbs end-to-end through the real topology (2 control planes, real worker, fake provider, MinIO, Toxiproxy) plus the failure matrix at **bounded** volume. Requires a `campaign.env` bump because `server/src` is off the path filter (fact §2.10).
- **Keyed D2 journey — `keyed-e2b-conformance.yml`.** The real-E2B coding journey, SKIP-guarded off `E2B_API_KEY`, dispatched by the operator via a `.github/keyed-e2b-trigger` bump.

### D9 — Volume gates are wired and dispatched, never claimed
The D1-01..07 and D2-01..08 volume clauses (fact §2.12) are recorded as **campaign records the operator runs**, with CLI-006 supplying the harness and the cases. The result doc will state which clauses are discharged by this ticket and which await a campaign run — no clause is marked met on unit evidence.

---

## 5. Non-goals / scope honesty

1. **Not the cutover.** Non-canary orgs stay legacy (Invariant 4). Full tenant/domain cutover = MIG-002; per-sink cutover = MIG-005/006/007.
2. **D1/D2 volumes are not discharged here** (D9). Three consecutive passing D2 runs across 120 real E2B jobs is an operator campaign with real spend.
3. **E4-D12 general provisioning stays open.** CLI-006 makes the poll loop live *in the D1 topology and for the canary*, not for arbitrary enrolled workers.
4. **Old-key kill-switch enforcement remains REL-004.** MIG-008 shipped AoA-side refusal + the generation tag; live force-kill of superseded-generation sandboxes is REL-004's.
5. **Deferred CLI-005 items stay deferred** — live drain enumeration, shadow independent derivation, admissibility probe (MIG-002); pre-staged rather than brokered memory (DAT-007).
6. **No frozen-artifact edits** — `worker-protocol`, the `SandboxProvider` port, `DE-*` threat docs. No new hosted-API call (Rule #11). No migration is anticipated; if the preflight needs durable state beyond MIG-008's tables it is drizzle-generated with C14 idempotency guards covering the **generated** DDL (the MIG-008 CI lesson).

---

## 6. CI + acceptance mapping

| Acceptance clause | Evidence | Lane |
|---|---|---|
| MIG-008 reconciled before first transfer | preflight fail-closed matrix (D2) | PR `verify` |
| create / schedule | submission + placement decision tests | PR `verify` + D1 |
| lease | live worker lease of the canary attempt | D1 lane |
| stage / execute | CLI-002 staging + CLI-001 provider under a live lease | D1 lane + keyed D2 |
| stream | producers → durable sink → projector | D1 lane |
| produce patch | fenced idempotent result commit; base/result hash | D1 lane + keyed D2 (D2-06) |
| review / retry | projector surfaces review state; JOB-006 retry | PR `verify` + D1 |
| cancel | fence-revoking cancel → durable terminal | PR `verify` + D1 (+ D2-04 latency = campaign) |
| audit | audit bridge parity on the canary path | PR `verify` |
| operator inspection | JOB-008 surface assertions (D7) | PR `verify` |
| non-canary tenants remain legacy | four-mode byte-identity matrix (Invariant 4) | PR `verify` |

Always-on checkers that must stay green: `check-distributed-execution-foundation.mjs`, `check-forbidden-tokens.mjs`, `check-worker-daemon-boundary.mjs`, `check-sandbox-e2b-provider-boundary.mjs`, `check-sandbox-coding-disposition.mjs`, `check-ci-lanes.mjs`, plus `migration-idempotency` + `migration-readiness` if any DDL lands.

---

## 7. Risks / open questions

1. **Double execution is the whole risk.** Mitigated structurally by D3 (one decision, two readers) rather than by test coverage alone. The adversarial review must attack this specifically: partial deployment, config change mid-run, replayed convert, placement succeeding after the suppression check, worker leasing an attempt whose run already went legacy.
2. **The `heartbeat.ts` seam is inspection-verified, not `executeRun`-unit-tested** — the standing CLI-003/005 limitation (`executeRun`'s dependency surface is impractical to unit-test). The D1 live journey is the compensating evidence, which is stronger than what CLI-005 had.
3. **`campaign.env` path-filter trap** (fact §2.10) — a server-only CLI-006 change will silently not run the D1 lane unless the nonce is bumped. This has bitten DEP-009 already.
4. **Parser strictness on the new mode** (fact §2.6) is deliberate: an old binary reading a `canary` config fails loudly at startup rather than silently disabling the canary. Rollback guidance must say "remove the key", not "downgrade the binary".
5. **Recurring CI flakes** to re-run rather than chase: `job-retry-capacity-transfer.integration.test.ts` (CI-DB contention), the `distributed-execution-db-startup` module-load sentinel, UI remount churn.
