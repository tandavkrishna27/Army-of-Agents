# CLI-005 Result — Bridge org heartbeat runs to distributed jobs (shadow + non-leasable convert + drain)

**Status:** `complete + review-fixed (no-key core green)`. Fifth E7 ticket. A CONSUMER + shadow comparator + rollback-safety layer over the E3/E4 substrate; the legacy `adapter.execute` remains the sole authoritative executor in every rollout state (worker execution = MIG-002).
**Disposition:** `pass` (scope-honest: in-process/mocked evidence; no worker executes).
**Date opened (UTC):** `2026-08-19`. **Start SHA:** `9d94339e4` (design). **Design:** `CLI-005-design.md`.
**Implementer:** Claude subagent (general-purpose, fail-first TDD, no commit). **Reviewer:** Claude adversarial-review Workflow (4 dimensions → refute-by-default verify, 14 agents) + controller independent re-verification + fix round.

## What shipped

Behind the default-off `AOA_DISTRIBUTED_EXECUTION_ENABLED` flag + a config-driven per-org/workload rollout source (`AOA_DISTRIBUTED_EXECUTION_ROLLOUT`, default-off), an org heartbeat run resolves to `off | shadow | active`:

- **A single dormant hook in `heartbeat.ts`** (`heartbeat-distributed-rollout.ts`) — injected by the composition root ONLY when `config.distributedExecutionEnabled`; absent otherwise → the seam is byte-identical legacy. Flag-first `resolveRunRolloutState` returns `off` with no DB lookup when the flag is off.
- **Shadow (D2)** — `job-shadow-comparator.ts`: effect-free routing/provenance/policy diff; holds **no Db handle** (structurally cannot write), sync + fully wrapped (never throws into the run), records to an observability sink. Non-leasable by construction.
- **Active convert (D3)** — `job-convert-orchestrator.ts`: durable **non-leasable** job via the composed E3 bridges (`admitAndSubmit`); the bridge owns the ONE checkout (harness suppressed for active runs). Non-leasable + never-placed (O1) → legacy stays the sole executor.
- **Drain (D4)** — `job-distributed-drain.ts`: per-org active-attempt iterator → fence-revoking `requestCancellation`, `assertRollbackSafe`-gated, abort-resistant. Shipped as dormant forward-infrastructure (see deferrals).

**5 new services/config + 5 test files; 29 CLI-005 unit tests green; server typecheck clean; foundation + forbidden-token checkers PASS; 67 heartbeat-adjacent + distributed regression tests unchanged.**

## Review findings → resolution (9 raw → 4 REFUTED, 3 CONFIRMED, 2 PARTIAL)

### mustFix (fixed, fail-first RED→GREEN where unit-testable)

1. **CONFIRMED (MEDIUM) — active-convert fired a checkout on wakes the harness would not.** The active-convert block was gated on `state==="active"` but NOT on `shouldAutoCheckout`, so a `mention`/`execution_*`/`null` wake in active mode drove a bridge checkout (status→in_progress, `startedAt` reset, extra `issue.status_changed` broadcast) that flag-off legacy never produces — a parity break of Invariant 3. **Fix:** hoisted `shouldAutoCheckoutForWake` above both blocks and added it to the active-convert guard, so the bridge owns the checkout ONLY on the exact (comment-driven, assigned) wakes the harness would have. (`heartbeat.ts`.)

2. **Controller re-verification (the review's failure dimension MISSED this) — convert-failure `releaseTaskClaim` reset the still-legacy-owned issue.** On a failed active-convert (e.g. capacity 429 → `admitAndSubmit` throws), the orchestrator called `releaseTaskClaim` → `issueService.release`, which resets the issue to `status:'todo'`, `assigneeAgentId:null`, `checkoutRunId:null` **while the legacy adapter is about to execute it** — a double-assignment window + board flicker + an inconsistent (`executionRunId=runId` but unassigned) state. This was a flaw in the design's original Invariant 5 that I introduced (release is correct only at the MIG-002 cutover, not the inert phase). **Fix (fail-first):** the orchestrator no longer releases on failure — a failed convert is a no-op on issue state (the whole submit tx rolled back, so the legacy claim is already intact). The retained-claim test RED→GREEN; Invariant 5 amended in the design.

3. **PARTIAL (MEDIUM) — drain aborted the whole sweep on one `requestCancellation` throw.** The per-attempt loop was unguarded (unlike the `assertRollbackSafe` skip). **Fix (fail-first):** wrapped enumeration + per-attempt cancellation in try/catch (skip-and-continue, record `enumerate_error`), mirroring the rollback-safety skip. New RED→GREEN test: a throw on attempt 2 of 3 still cancels the rest + the next org.

> **CLOSURE NOTE added by MIG-005/006/007 (Wave 3 item 4).** Deferrals 2 and 3 below are now
> CLOSED, and **not by MIG-002** — the admissibility probe is built and wired
> (`job-shadow-admissibility.ts`), and the identity mapping is GONE (`match` is now
> `agree|diverge|not_compared`, with the record carrying its own denominator).
>
> The "always matches" item in the Refuted list was correct as CLI-005 scoped it — the identity
> mapping WAS the intended inert model, and this document said so plainly. What went wrong is
> downstream and worth naming: the Wave-3/4 handoff later wrote a gate clause requiring a
> "stated divergence rate" from this comparator, and instructed the next agent to wire three
> more sinks into it. Both documents were true in isolation; together they would have produced
> a 0% rate with a volume figure and no meaning (measured: 2,000 randomized snapshots,
> 0 divergences, by construction).
>
> **The lesson is not that a finding was wrongly refuted. It is that a documented deferral does
> not travel to the document that later depends on it.** See
> `epics/E10-desktop-migration-realtime/tickets/MIG-005-006-007-shadow-result.md`.

### Refuted (no code change — the review confirmed these are the intended design)

- **Shadow identity-mapping "always matches"** — REFUTED: `identityDistributedIntent` is the intended CLI-005 model (Invariant 8 "diff-clean mapping"; a divergence = a mapping bug). The `deriveDistributedIntent` injection seam exists so MIG-002 supplies a divergence-capable derivation.
- **Shadow provenance/policy placeholders** (`credentialKind`/`budgetPolicyId`/`effectiveCompletionPolicy`) — REFUTED as a defect: they are never emitted to the sink and never meaningfully diffed (identity self-comparison). LOW doc note only (§7 O7).
- **`checkedOutByHarness=true` on active wakes** — REFUTED: on every `converted:true` path the bridge genuinely checked out, so the flag truthfully mirrors a real pre-checkout; forcing it false would cause the double-checkout Invariant 3 forbids.
- **Rollback-safety org-vs-company scope** — REFUTED: the gate is per-org by design (D4/Invariant 6); the correct fail-closed adapter is an org-wide receipt scan.

## Scope-honesty deferrals (documented, not blockers — consistent with the E3/E4 dormant-infrastructure pattern)

1. **Flag-disable drain ships as dormant forward-infrastructure.** The "stops new distributed jobs" half of the acceptance is genuinely met (flag-off → `resolveRunRolloutState`→`off`, runtime-dynamic, no restart). The drain SERVICE + rollback-safety + abort-resistance are built + fully unit-tested, but the live per-org `listActiveAttempts` SQL enumerator + the auto-trigger on flag-disable are **deferred to MIG-002** — CLI-005's attempts are non-leasable + never-placed (O1), so there is nothing leasable to drain yet. This mirrors how E3/E4 shipped the 5 parity bridges dormant until CLI-005 consumed them. The design §6 acceptance mapping was corrected (post-review) to stop claiming the live drain trigger as met.
2. **Shadow comparison is diff-clean by construction** (identity mapping) and its provenance/policy snapshot fields are placeholders; a divergence-capable independent derivation + real `credentialKind`/`budgetPolicyId`/`effectiveCompletionPolicy` are MIG-002 (O7). The infrastructure (effect-free, never-throws, mismatch-detection) is real + tested.
3. **The read-only admissibility probe is not wired** (`admissible` is always the safe `null`); provenance is still compared via principal-kind. Deferred to MIG-002 (O7).
4. **No worker execution / no cutover** (O1); active-mode jobs are inert until MIG-002.

## Commands (controller re-run)

| Command | Result |
|---|---|
| `vitest run` × 5 CLI-005 suites | **29 passed** |
| convert-orchestrator retained-claim test (post-fix) | RED (releaseTaskClaim called) → **GREEN** (never called) |
| drain abort-resistance test (post-fix) | RED (sweep aborted) → **GREEN** (continues) |
| regression: distributed-policy + heartbeat-kind-guard + reap-orphaned-runs + job-placement.property + job-source-admission-matrix | **67 passed** (unchanged) |
| `tsc -p server/tsconfig.json --noEmit` | clean |
| `check-distributed-execution-foundation.mjs` + `check-forbidden-tokens.mjs` | PASS |

## Residual risk

1. **heartbeat.ts seam is inspection-verified, not executeRun-unit-tested** — `executeRun` is impractical to unit-test in isolation (huge dependency surface); the parity guards are verified by inspection + the new-service unit tests + the regression suite. Consistent with prior CLI heartbeat-seam changes.
2. **Drain live wiring + shadow independent-derivation + admissibility probe are MIG-002 deferrals** (documented above).
3. **No frozen `worker-protocol` / `SandboxProvider`-port edit; no `DE-*` threat edit; no new hosted-API call; no migration** (config-driven rollout source).

## Gate recommendation

`ready for independent review` — the two mustFix parity defects (#1 active-convert checkout gate, #2 convert-failure release) are fixed fail-first, the drain abort-resistance (#3) is fixed, the drain live-wiring overclaim is corrected to an honest MIG-002 deferral, and the no-key core is green (29 CLI-005 + 67 regression).

## Review attempt history

| Attempt | Reviewer | Disposition | Evidence/findings |
|---:|---|---|---|
| 1 | Claude adversarial-review Workflow (14 agents) + controller re-verification | `approved after fix` | 9 raw → 4 REFUTED + 3 CONFIRMED + 2 PARTIAL; 2 mustFix parity defects fixed fail-first (active-convert checkout gate; convert-failure release — the latter caught by controller re-verification, not the Workflow) + drain abort-resistance; drain live-wiring overclaim corrected to a documented MIG-002 deferral; 29 CLI-005 + 67 regression green |
