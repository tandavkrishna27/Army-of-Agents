# Re-platform — Wave 2 handoff

> **SUPERSEDED — 2026-08-22.** This handoff describes the state at 66/95 tickets and
> lists CLI-006 as unfinished; both are out of date. CLI-006, DSK-001..004 and REL-004
> (clauses 1 and 2) have since landed CI-green — **72/95, 23 remain**. The current plan
> is [`HANDOFF-wave-3-4.md`](./HANDOFF-wave-3-4.md). Kept for the per-ticket process and
> the trap list, which remain accurate and are carried forward there.



**As of:** branch `docs/replatform-program` tip `976183a28` (ONE PR #323, worktree `C:\e3`). **PR CI 12/12 green. Worktree clean, nothing unpushed.**
**Scope is LOCKED AT MAXIMUM** (operator decision, 2026-08-19): desktop **and** cross-target mobility advertised, on **both Windows and macOS**, nothing deferred to post-beta.
**66 / 95 landed. 29 remain.** CLI-006 is in progress (not landed).

---

## 1. How to start the session

1. **Work in `C:\e3`**, not the OneDrive worktree — embedded Postgres cannot initdb from the deep OneDrive path (MAX_PATH).
2. **Read the plan first:** [`epics/E7-coding-e2b/tickets/CLI-006-seam-plan.md`](epics/E7-coding-e2b/tickets/CLI-006-seam-plan.md). Tasks 2b–8 are fully specified with exact file:line insertion points.
3. **Read the design:** [`epics/E7-coding-e2b/tickets/CLI-006-design.md`](epics/E7-coding-e2b/tickets/CLI-006-design.md), especially **§D3a** (why the convert must run late) and the Invariants.
### The per-ticket process — EVERY ticket in §3, no exceptions

This is not a description of how the last session happened to work. It is the required cycle for **each of the 14 tickets**, including the small ones (REL-004) and the ones that look like pure wiring (MIG-005/006/007). It has been run on ~15 tickets and caught a real, often-HIGH defect on essentially every one — including tickets that looked trivial going in.

```
1. terrain-map        parallel readers → adversarial verify → synthesis
2. re-verify          the load-bearing claims YOURSELF, in the code
3. plan               superpowers:writing-plans → design doc → COMMIT before code
4. implement          superpowers:test-driven-development, fail-first
5. review             adversarial, refute-by-default
6. re-verify + fix    controller re-traces each finding; fixes land fail-first
7. verify             superpowers:verification-before-completion
8. result doc         honest deferrals → commit-by-path → FF-push → CI-watch
```

**Skills, and when:** `superpowers:writing-plans` at step 3 — before touching code, on every ticket. `superpowers:test-driven-development` at step 4. `superpowers:verification-before-completion` at step 7, before claiming anything is done. The plan document's header names the execution sub-skill (`subagent-driven-development` or `executing-plans`).

**Steps 3 and 8 produce committed artifacts**, per the established convention:
- design → `docs/replatform/epics/<EPIC>/tickets/<TICKET>-design.md`
- plan (when the ticket is large enough to warrant one) → `…/<TICKET>-plan.md`
- result → `…/<TICKET>-result.md`

The design doc is committed **before** implementation and its SHA becomes the ticket's Start SHA. That is what makes the design reviewable rather than a post-hoc rationalisation.

### Definition of done — a ticket is not done until all of these hold

- [ ] Design doc committed **before** implementation; its load-bearing facts re-verified by you, not inherited
- [ ] Every acceptance clause from `program-design.md` mapped to evidence, or explicitly deferred with a reason
- [ ] Fail-first: every guard proven RED before GREEN
- [ ] **Every guard mutation-tested** — remove it and the suite must go RED
- [ ] Adversarial review run; each finding either fixed fail-first or refuted in writing
- [ ] Result doc committed, including honest deferrals and residual risk
- [ ] Pushed, **CI watched to green** (not assumed — `ci-required` is the verdict)
- [ ] If it touches `server/src` and needs the live lane: `docker/d1/campaign.env` bumped

### Two rules that produced every defect found

**Never trust a subagent's green, and never trust your own first read.** Every trap in §5 came from that layered net. Several were in code that had already passed review, and two were in code that had already landed and gone green in CI.

**Mutation-test every guard.** A guard whose removal leaves the suite green is not a guard. This session found two vacuous tests that way — one where the mock had never modelled the case the guard protects.

---

## 2. Immediate next work: finish CLI-006

**Landed and CI-green** (20 commits since `cd93ef8ff`): migration 0258 ownership marker · reaper R1 + R1b · after-commit projection trigger · delegating preflight store · projector with finalization and won/lost latch semantics · `finalizeDistributedRun` · Task 1 credential binding (`52317a180`) · Task 2a composition (`f569a9985`). 164 unit tests across 13 files.

**Everything is INERT.** Nothing resolves to `canary` until an Organization is set `mode:"canary"` in `AOA_DISTRIBUTED_EXECUTION_ROLLOUT`, and the seam that READS the ownership decision is not wired. Every safety net landed *before* the thing that arms it; the seam is the switch and it goes last.

### Task 2b is a DESIGN decision, not a thread — start here

`heartbeat.finalizeDistributedRun` is built inside `if (config.heartbeatSchedulerEnabled)`; the distributed path is inside `if (config.distributedExecutionEnabled && distributedExecutionDatabases)`. **Those conditions are independent** — a deployment can run distributed execution with the heartbeat scheduler off, leaving the projector with no finalizer. Decide and write it down before coding. Recommended fail-closed answer: project the terminal and the summary, skip finalization, log — never silently drop.

Also: `createJobEventIngestService` is composed at `routes/worker-control.ts:98` via `app.ts:447`, so `onAttemptTerminal` threads three hops.

Then Tasks 3 (the seam) → 4 (cancel routing, five writers) → 5 → 6 → 7 (D1 lane) → 8 (adversarial review + result doc).

---

## 3. The wave: 14 tickets

Dependencies computed against the 66 landed. Three tracks run genuinely in parallel.

**Each row below runs the full §1 cycle** — terrain-map → re-verify → plan/design doc → fail-first implement → adversarial review → re-verify + fix → result doc → CI-green — and is not done until every box in the §1 Definition of Done is ticked. That applies to REL-004 (small) and to MIG-005/006/007 (mostly wiring) exactly as it applies to CLI-006. The cutover tickets in particular are wiring over existing engines, which is precisely the shape that reads as safe and is not: they move live execution sinks.

| # | Ticket | Track | Unblocked by |
|---|---|---|---|
| 1 | **CLI-006** finish | keystone | — |
| 2 | **REL-004** provider kill-switch | independent | already ready |
| 3 | **DSK-001** desktop enrollment + OS key storage | desktop | already ready |
| 4 | **DSK-002** folder grants, local sandbox, offline policy | desktop | DSK-001 |
| 5 | **DSK-003** desktop host + signed Win/macOS installers | desktop | DSK-002 |
| 6 | **DSK-004** signed update, drain, rollback, repair | desktop | DSK-003 |
| 7 | **MIG-005** cut Commander over | cutover | CLI-006 canary |
| 8 | **MIG-006** cut crew execution over | cutover | CLI-006 canary |
| 9 | **MIG-007** cut one-shot CLI over | cutover | CLI-006 canary |
| 10 | **BRW-001** browser job + policy extensions | browser | CLI-006 |
| 11 | **BRW-002** sandbox-local Playwright runtime | browser | BRW-001 |
| 12 | **SVC-001** desired-state service schema + API | service | CLI-006 |
| 13 | **SVC-002** service reconciler + placement | service | SVC-001 |
| 14 | **MIG-001** cut Decision #117 target/credential routing | cutover | CLI-006 |

**Start DSK-001 and REL-004 immediately, in parallel with finishing CLI-006.** DSK is a strictly serial 4-chain that never touches CLI-006; now that desktop is mandatory it is the longest unblocked chain in the program and will become the end-game critical path if it waits.

**MIG-005/006/007 are dependency-ready today** but the program narrative gates the full sink cutover behind the CLI-006 canary — prove one coding journey live first.

After this wave: BRW-003..006, SVC-003..007, MIG-002, MIG-004, REL-001/002/003/005 (15 remaining).

---

## 4. Hard limits no amount of engineering compresses

- **D6:** three external beta Organizations, each throughout the **same 14 consecutive calendar days**, ≥1,000 attempts, ≥99.5% availability. Partner recruitment and the frozen D6-04 support matrix must exist *before* that window opens — neither is a coding task.
- **D2:** three *consecutive* passing real-E2B runs across ≥120 jobs, on the operator's `E2B_API_KEY`. Real spend, operator-dispatched.
- **Locked scope multipliers:** two advertised OS rows = 2× D6-04 probes (≥200 each) + a desktop beta gate per OS + REL-001/003/004 re-run with desktop. Mobility with desktop directions ≈ 4 directions × (10 handoffs + 3 partition/failure cases).

---

## 5. Traps that cost real time — read before coding

**Migrations**
- The static `migration-idempotency` test covers only `CREATE TABLE`/`CREATE INDEX`. **`ADD COLUMN` has NO static guard** (mutation-proven). The `IF NOT EXISTS` is still required — a bare `ADD COLUMN` errors on replay — but only the live `migration-readiness` re-apply on Linux CI proves it. This is why MIG-008's C14 gap surfaced in readiness, not idempotency.
- A new distributed/RLS table = **two** grant surfaces (`appTablePrivileges`/`operatorTablePrivileges` + the `job-control-legacy-grants.ts` manifest incl. `POLICY_COUNTS` and the contract-test count title).

**TypeScript**
- **Method-shorthand parameter bivariance can hide a wiring bug.** `placement: placementService` typechecks clean and then passes `now: undefined` at runtime → `invalid_placement_input` → every canary transfer silently falls back to legacy. Verified by mutation. The compiler cannot guard this; `toRunExecutionPlacement` is a named, tested function for exactly that reason.

**Heartbeat / runs**
- The run-status vocabulary is `TERMINAL_RUN_STATUSES` = `succeeded|failed|cancelled|timed_out`. **`"completed"` belongs to the WAKEUP vocabulary** and is NOT terminal — writing it leaves a run permanently un-latched. This shipped once and was caught by the terrain map.
- `setRunStatus` returns `null` in **all three** guard-miss branches (row gone / no-op flip / metadata fallback), so `if (!row)` is the correct race predicate.
- **Losing the terminal latch ≠ throwing.** Losing means someone else finalized the run — skip finalization and the summary. Throwing is infrastructure — proceed.
- `reapOrphanedRuns` exempts a run only if it is in the in-process `runningProcesses` map, which a distributed attempt never populates.

**CI**
- Recurring flakes — **re-run, don't chase**: `e2e` cancelled at "Install Playwright" (the `cdn.playwright.dev` stall; makes `ci-required` fail while all other lanes are green — `gh run rerun <id> --failed` clears it), `job-retry-capacity-transfer.integration.test.ts` under CI-DB contention, and the `distributed-execution-db-startup` module-load sentinel.
- **`server/src` is NOT on the `d1-merge-train.yml` path filter** — a server-only change silently does not run the live D1 lane. Bump `docker/d1/campaign.env`. `tests/d1/**` IS on the filter.
- Windows-local skips integration/e2e/d1. **Linux CI is the formal authority (DEC-03).**
- A "documented residual" in a handoff may just be an unread red lane. The D1 lane had been red since the MIG-003 landing on a bigint-vs-string assertion bug; fixing it took the lane to 40/40 and gave `E10-REALTIME-FOUNDATION` real live two-replica evidence.

**Frozen — never edit**
`packages/worker-protocol/` (v1, SHA `b7a842870ce7509d8baa75409e0ab19da375c88a`), the worker-daemon `SandboxProvider` port, `docs/architecture/distributed-execution-threat-*` (DE-*). Drizzle-only for schema (C14 the sole hand-edit exception). No new hosted-API call (Rule #11).

---

## 6. Open deferrals that must be closed or stated

1. **A canary worker receives NO provider credential.** The lease envelope hardcodes `secretHandles: []` (`job-leasing.ts:349`) and `job_secret_handles` has no production writer. The seam can transfer ownership, but a coding task cannot yet authenticate a CLI inside the sandbox. **This limits what CLI-006's D2 leg can claim** and belongs in its result doc.
2. **JOB-006's lease reaper has no live trigger** (`createJobControlSweeper` has no production caller). An attempt whose lease expires *without* emitting a terminal event has no convergence path — its run stays `running`. Scheduling it belongs to MIG-002.
3. **The placement owner check is tautological** — `credentialOwnerId` and `requiredOwnerPrincipalId` both read from the routed target's profile. Safety currently rests on the structural exclusion of `owner_desktop` routing (verified), not on that check. Re-derive that argument before enriching the credential binding.
4. **Old-key kill-switch enforcement** → REL-004 (ticket #2 in this wave).
5. **CLI-005 deferrals** → MIG-002: live drain enumeration, shadow independent derivation, admissibility probe. **DAT-007**: brokered in-VM memory (CLI-002 stages on the host instead).
