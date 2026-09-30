# CLI-005 Design — Bridge existing org heartbeat runs to distributed jobs (rollout flag + non-executing shadow)

**Status:** `design` (reviewable artifact; implementation via fail-first TDD + distinct adversarial review). **Medium ticket — a CONSUMER + shadow comparator + rollback-safety proof over the E3/E4 substrate; NO new job-machinery, NO worker execution.**
**Epic:** `E7 — Coding/CLI workload on E2B` (fifth ticket). **Authoritative source:** `program-design.md:783-788` (CLI-005) + `docs/replatform/current-main-crosswalk.md:18` (CM-002).
**Depends on (status verified):** CLI-003 + CLI-004 (landed) + DEP-005 + JOB-009..014 (E3, landed). Frozen `worker-protocol` v1 + the frozen worker-daemon `SandboxProvider` port — never edited.
**Grounded by:** the CLI-005 terrain-map (4 readers + synth) with every load-bearing claim **independently re-verified** in `C:\e3` (see §2).

---

## 1. Scope + framing

**Outcome (program-design.md:785):** convert one existing Organization heartbeat run into a new job WITHOUT moving the whole product domain, and support a non-executing shadow comparison of routing, provenance, and policy.

**Acceptance (program-design.md:786):** one run has exactly one authoritative executor; shadow mode cannot lease or cause external effects; atomic checkout, single assignee, approvals/completion, all budget/cost hard stops, transactional activity, output/run-summary, and failure release match the current path; disabling the rollout flag stops new distributed jobs while explicitly draining or canceling active attempts.

**The thesis.** E3/E4 already built the ENTIRE job machinery (submit→admit→place→lease→execute) + five fail-closed parity bridges (admission/approval/budget-cost/audit/output) + the flag + a 3-tier rollout resolver + the non-executing placement primitive. **Nothing in a live path calls any of it** (grep of `admitAndSubmit`/`jobAdmissionBridge` across `server/src` = bridge sources + `__tests__` only). CLI-005 is the first CONSUMER: it wires the org heartbeat run to that substrate behind the rollout flag, in a way that keeps the **legacy adapter the sole authoritative executor** (worker execution is MIG-002), adds the effect-free shadow comparator, and proves flag-disable drain + rollback safety.

**Non-execution is structural, not promised.** Two independently-verified facts make every CLI-005 job non-executing by construction: (a) placement `leaseEligible = mode === "active"` (`job-placement.ts:670`) → a `shadow`-mode attempt is non-leasable; (b) `.place()`/`placeJobAttempt` have **zero live callers** (`grep` — only definitions) → no scheduler ever places a freshly-submitted attempt, so nothing becomes leasable at all in the current stack. The legacy `adapter.execute` (`heartbeat.ts:5032`) remains the one executor in every rollout state.

| Workstream | Lane | Kind | Responsibility |
|---|---|---|---|
| Rollout-state resolver wiring | `server/src/config` + a per-org/workload source | new (wire) | feed the stubbed `resolveDistributedExecutionRollout` org/workload inputs so `off \| shadow \| active` becomes reachable; default `off` |
| Shadow comparator | new service | new | effect-free routing/provenance/policy diff (pure `decideJobPlacement` + envelope/provenance derivation + read-only admissibility probe) recorded to an observable sink; NO jobs row, NO checkout, NO capacity, NO lease |
| Durable convert (active mode) | compose the 5 bridges at the seam | new (compose) | submit a durable **non-leasable** job via `admitAndSubmit`, with checkout ownership MOVED from the harness to the bridge (exactly one checkout → parity) |
| Flag-disable drain | new service | new | per-org active-attempt iterator → `requestCancellation` (fence-revoking, graceful), honoring `assertRollbackSafe` |
| Parity + rollback proof | tests | new | legacy/new envelope + control-invariant equivalence, double-execution prevention, failed-submit release, flag disablement + rollback, active-attempt drain |

---

## 2. Load-bearing facts (each independently re-verified in `C:\e3`)

1. **Seam.** `executeRun(runId)` `heartbeat.ts:2979` → `claimQueuedRun` `:2985` (atomic queued→running) → `getAgent` `:2993` → **conditional** harness checkout `:3123-3147` (only comment-driven wakes; `issueSvc.checkout(issueId, agent.id, ["todo","backlog","blocked","in_progress"], run.id)` `:3126`) → `adapter.execute(...)` `:5032` (the sole executor, even for E2B targets — the sandbox is a `configPatch.executionTarget` the adapter drives).
2. **`admitAndSubmit`** (`job-admission-bridge.ts:262-322`) drives the SAME run-guarded `issueService.checkout` in-tenant-tx `:293-299`, with a `findIdempotentReplay` fast-path `:291-292` that skips checkout on redelivery (avoids resetting `startedAt` + re-broadcast), and an after-commit publish sink `:277/:313-319` (a rollback fires nothing). `releaseTaskClaim` `:324-339` is run-guarded exactly-once.
3. **`taskSourceIsAdmitted`** (`packages/db/src/repositories/tenant/job-control.ts:1382-1408`) admits a `task_run` source ONLY when `issues.checkoutRunId === runId` **AND** `issues.executionRunId === runId` `:1392-1393`. So a durable submit is admissible only after a checkout for THIS run — the bridge is designed to be that checkout.
4. **`checkout`** (`issues.ts:2165-2247`) is an optimistic run-guarded conditional UPDATE that unconditionally sets `startedAt: now` + `status:"in_progress"` `:2203-2204` and broadcasts `issue.status_changed` `:2231-2244`; its expected-status set for task_run includes `in_progress`. → A SECOND checkout for an already-owned run is NOT byte-idempotent (resets `startedAt`, re-broadcasts). **This is why the shadow must not re-checkout, and why active-mode must move checkout ownership (D3).**
5. **Shadow primitive** (`job-placement.ts:670`) `leaseEligible: input.rollout.mode === "active"`; `shadow` → `reasonCode:"shadow_selected"`, non-leasable. `decideJobPlacement` (`:572`) is a **pure** function (no DB effects).
6. **Prod placement entry** `placeJobAttempt` (`job-placement.ts:420-436`) hardcodes `resolveOrganizationPolicy:()=>({enabled:false,mode:"active"})` + `resolveWorkloadPolicy:()=>false` → always `legacy`. `createJobPlacementService` (`:442-469`) accepts injectable org/workload resolvers — the wiring point that makes `shadow` reachable.
7. **O1 — no live placement/lease.** `.place()`/`placeJobAttempt`/`placeJobAttemptTransaction` have **zero non-test callers** → freshly-submitted attempts are never placed → never leased. Worker→run mapping + cutover = MIG-002.
8. **`task_run` source** (`packages/shared/src/validators/job-control.ts:5-10`) requires `runId`+`issueId`+`assigneeAgentId` (all uuid, non-optional) → issue-bearing runs only.
9. **Flag** `AOA_DISTRIBUTED_EXECUTION_ENABLED` default-false (`config/distributed-execution.ts:22`), startup-static (`config.ts:197`), read per-call by the bridge (`isEnabled`). 3-tier `resolveDistributedExecutionRollout(deployment→org→workload)` (`config/distributed-execution.ts:37-44`), org+workload stubbed.
10. **Disable does not drain today.** `requestCancellation` (fence-bound, idempotent, graceful|hard) `job-reconciliation.ts:100`; `reapOrganization` has no live trigger; no per-org active-attempt iterator; `assertRollbackSafe` (`job-budget-cost-bridge.ts:321-338`) refuses disable while an `authoritative_cost` receipt is pending.

---

## 3. Invariants (each gets a test)

1. **Exactly one authoritative executor.** The legacy `adapter.execute` is the sole executor in every rollout state; no CLI-005 job is leasable (shadow → non-leasable; active → non-leasable + never placed). No double-execution.
2. **Shadow is effect-free.** Shadow writes NO `jobs`/`job_attempts` row, drives NO checkout, claims NO capacity, holds NO lease, emits NO `cost_events`/`activity_log`/run-summary, and NEVER fails the legacy run. Its only output is a comparison record on an observable sink.
3. **Checkout / single-assignee parity.** In `off`/`shadow`, checkout behaves byte-identically to today. In `active`, exactly ONE checkout fires per run (ownership moved harness→bridge) — same `checkoutRunId`/`executionRunId`/`startedAt`/single broadcast, no double.
4. **Approvals/completion, budget & cost hard-stop, transactional activity, output/run-summary parity.** Composed bridge behavior equals the legacy path; the budget/cost + output bridges fire only on ACCEPTED worker usage/output — of which shadow and non-leasable-active have none, so they stay silent.
5. **Failure retains the legacy claim (amended post-review).** A failed submit (any throw) rolls back the whole tenant-tx leaving no job row and the checkout undone → the issue's legacy claim (executionRunId from the wakeup) is already intact. In CLI-005's INERT model the legacy adapter still executes this issue, so a failed convert is a **no-op on issue state** — it MUST NOT call `releaseTaskClaim` (which resets the issue to todo/unassigned out from under the legacy run). *(The original design said "releases the task claim"; that was a flaw — releasing is correct only at the MIG-002 cutover when the job replaces execution, not in the inert phase where legacy continues.)*
6. **Flag disablement + drain.** Disabling stops new distributed jobs AND drains active (non-terminal) attempts per admitted org via fence-revoking `requestCancellation`; a late worker result is rejected `stale_fence`. Refused while an authoritative-cost receipt is pending (`assertRollbackSafe`).
7. **Rollback safety.** Disabling/rolling back creates no second executor and erases no authoritative charge/output.
8. **Envelope/provenance equivalence.** The job envelope + provenance CONVERTED from a run is a faithful, diff-clean mapping of the legacy run's intent (the shadow comparator's core assertion).

---

## 4. Decisions

### D1 — Three rollout states, legacy stays the executor, issue-bearing runs only
Wire `resolveDistributedExecutionRollout`'s org+workload inputs (from a server-owned per-org/workload policy source, default disabled) so a run resolves to `off | shadow | active`. **In ALL states the legacy `adapter.execute` remains the one authoritative executor** (worker execution = MIG-002). Scope to **issue-bearing** runs (`context.issueId != null`): `task_run` requires `issueId`, and the bridges forbid fabricated task IDs. Issue-less org runs (agent/timer wakes, `heartbeat.ts:6314`) are skipped (no source). Everything is gated by `AOA_DISTRIBUTED_EXECUTION_ENABLED` first (default-off dormant).

### D2 — Shadow mode: effect-free compute-and-compare (no durable submission)
At the seam, when a run resolves to `shadow`, compute EFFECT-FREE and diff against the legacy run's actual execution: (a) the would-be `SubmitJobSource` + `batchWorkloadV1` envelope; (b) provenance via a **read-only** `taskSourceIsAdmitted`-shaped probe (no write); (c) the pure `decideJobPlacement` decision in `shadow` mode (non-leasable). Diff routing (`executionTarget.type` from the resolved config after `acquireExecutionContext` `heartbeat.ts:4298`), provenance (execution principal / credential kind `heartbeat.ts:3422`), and policy (model, budget policy, effective completion policy). Record match/mismatch + the mismatched fields to an observable sink (metrics + `job_trace_log`) — **no `jobs` row, no checkout, no capacity, no lease, never fails the legacy run.** This is the primitive that makes Invariant 2 hold by construction. (The placement DECISION is pure, so it is computed without `placeJobAttemptTransaction`, which persists.)

### D3 — Active (convert) mode: durable NON-LEASABLE job, checkout ownership moved
When a run resolves to `active`, submit a durable job via the composed bridges (`admitAndSubmit` → `submitJobWithinTenant`), producing a real `jobs`+`job_attempts` row that is **non-leasable** (shadow/legacy placement + O1 no-placement) so the legacy adapter stays the sole executor. Because `taskSourceIsAdmitted` requires `checkoutRunId===runId` and `checkout` is not byte-idempotent (fact 4), **checkout ownership moves from the harness to the bridge for an active run**: suppress the conditional harness checkout (`heartbeat.ts:3123`) when the run is `active`, and let `admitAndSubmit`'s in-tx checkout be the ONE checkout — same `runId`, same status set, exactly one `startedAt`/broadcast → checkout parity preserved (Invariant 3). The five parity bridges compose across the run lifecycle; a pre-commit throw rolls back the whole submission and releases the claim (Invariant 5). **Active-mode jobs are inert until MIG-002** (documented scope honesty); they exist to establish run↔job identity + provenance and to be the drainable "active attempts."

### D4 — Flag-disable drain via a per-org active-attempt iterator
Build the missing per-org active-attempt enumerator (reuse `listAdmittedOrganizationIds` `index.ts:580-607` as the org enumerator) and, on disable, `requestCancellation(graceful:true)` each non-terminal attempt — **fence-revoking**, so a late worker result is rejected `stale_fence` (NOT a bulk UPDATE). Honor `assertRollbackSafe` (`job-budget-cost-bridge.ts:321-338`): refuse the drain step for an org with a pending `authoritative_cost` receipt. Given the static flag model, disable is env+restart-driven with an explicit drain pass at teardown/admin trigger (a runtime toggle that drains without a bounce is a documented follow-up; the sweeper already supports `enabled=false`→no-op ticks).

### D5 — Rollback safety proof
Prove: disabling/rolling back creates no second attempt for a run, erases no committed `authoritative_cost` charge and no accepted output, and leaves the legacy run untouched. The budget/cost + output bridges are receipt-guarded and only fire on accepted worker usage/output (none here), so shadow/active-inert produce none.

### D6 — Observability sink
Shadow comparisons + drain actions record to the existing `job_trace_log` (`job-trace-log.ts`) + metrics (no new table, no new hosted call). Mismatches are observable without failing any run.

---

## 5. Non-goals / scope honesty

1. **No worker execution / no cutover.** The legacy adapter remains the sole executor; active-mode jobs are non-leasable and inert until MIG-002 wires placement→lease→worker. O1 (no live placement) is preserved, not fixed.
2. **No new job machinery.** Submit/admit/place/lease/bridges are E3/E4; CLI-005 only CONSUMES + composes them and adds the shadow comparator + drain iterator.
3. **Issue-bearing runs only** (D1); issue-less org runs are out of scope (no `task_run` source).
4. **Runtime flag-toggle-without-restart is a follow-up** (D4); CLI-005 delivers env+restart + an explicit drain pass.
5. **No frozen `worker-protocol` / `SandboxProvider`-port edit; no `DE-*` threat edit.** No new hosted-API call (Rule #11). Any new `AOA_*` literal is documented in `docs/deploy/environment-variables.md` (brand-check) and default-off/dormant.

---

## 6. CI + acceptance mapping

| Acceptance clause (L786) | Where satisfied | Gate |
|---|---|---|
| one run has exactly one authoritative executor | legacy adapter sole executor; jobs non-leasable + never placed | `verify` (double-execution-prevention test) |
| shadow cannot lease or cause external effects | D2 compute-and-compare, no writes/checkout/capacity/lease | `verify` |
| checkout/single-assignee/approval/budget/cost/activity/output parity | D3 one-checkout + composed bridges vs legacy | `verify` (parity equivalence) |
| failure retains legacy claim | rollback + **NO** release (amended Invariant 5) | `verify` |
| flag disablement — **stops new distributed jobs** | flag-off → `resolveRunRolloutState`→`off` (runtime-dynamic, no restart) | `verify` |
| flag disablement — **drain active attempts** | D4 drain service + rollback-safety + abort-resistance, unit-tested; ships as **dormant forward-infrastructure** — the live enumerator query + auto-trigger are deferred to MIG-002 (§7), since CLI-005 attempts are non-leasable + never-placed (nothing to drain yet) | `verify` (service unit) |
| rollback safety | D5 no second executor / no erased charge-output | `verify` |
| legacy/new envelope equivalence | D2 comparator diff-clean | `verify` |

**Gate recommendation for implementation:** fail-first — write the shadow-effect-free + one-checkout-parity + drain + rollback-safety assertions RED before the comparator/convert/drain wiring, then GREEN; distinct adversarial review before the result doc. Disposition = `pass` on in-process/mocked evidence (no worker; execution cutover is MIG-002).

---

## 7. Risks / open questions (resolved or deferred)

- **O1 (worker→run mapping):** deferred to MIG-002 — CLI-005 jobs never execute, so no completion mapping is needed; the design does not corner the cutover (identity/provenance are established now).
- **O3 (checkout ownership):** resolved by D3 (move ownership harness→bridge for active runs; shadow never checks out).
- **O4 (rollout backing store):** CLI-005 owns a minimal server-owned per-org/workload policy source (default disabled) feeding the resolver; a richer policy store is JOB-007/MIG-002.
- **O5 (run↔job identity):** one job per (run,issueId) submission keyed by `admitAndSubmit`'s idempotencyKey = the run's stable identity; coalesced re-wakes dedupe via `findIdempotentReplay`.
- **O7 (workload synthesis):** for the shadow envelope, `command/args` are derived as a characterization from the run's adapter/runtime spec; faithful worker-executable synthesis is refined at MIG-002 (shadow only needs a diff-stable provenance mapping).
