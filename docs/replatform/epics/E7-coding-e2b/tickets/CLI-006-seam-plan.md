# CLI-006 Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfer execution ownership of one canary Organization's coding run from the legacy in-process adapter to a distributed worker attempt, and surface its evidence in the existing run experience.

**Architecture:** A durable `execution_owner` marker on `heartbeat_runs` makes the transfer visible to every consumer that would otherwise terminalize, cancel, or reap the run. One decision function (`resolveRunExecutionOwner`) is computed at a single point late in `executeRun` — after context assembly, because the immutable job envelope carries context as artifacts — and both the placement and the legacy-suppression guard read that one value. The attempt becomes the terminal authority; a projector fires from the JOB-005 after-commit ingest hook and finalizes the run.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, Express 5, Postgres. Worktree `C:\e3`, branch `docs/replatform-program` (PR #323).

---

## Status of work already landed

These tasks are **complete and pushed**; they are listed so the plan reads as a whole and so a fresh engineer does not redo them.

| # | Task | Commit |
|---|---|---|
| — | Projector non-terminal-status defect (`succeeded` ≠ `"completed"`) | `089ee34ab` |
| — | Migration 0258 — `execution_owner` / `distributed_job_id` / `distributed_attempt_id` | `113463f92` |
| — | R1: reaper stands down for distributed-owned runs | `d5d7e890c` |
| — | R1b: reaper honours the terminal latch before recovering | `ad2e15eb5` |
| — | After-commit attempt-terminal projection trigger | `ddaa29b78` |
| — | Drizzle canary preflight store (delegating to MIG-008) | `5624beba0` |
| — | Projector finalization + won/lost latch semantics (R7) | `0b6d146f6` |
| — | `finalizeDistributedRun` capability on `heartbeatService` | `eccdfb639` |

**Invariant honoured throughout:** every safety net lands *before* the thing that arms it. Nothing above changes behaviour for any existing run — the marker is null everywhere, the trigger is unwired, the resolver is uncomposed. The seam (Task 3) is the switch, and it goes last.

---

## File structure for the remaining work

| File | Responsibility |
|---|---|
| `server/src/services/canary-credential-binding.ts` | **Create.** Resolve which provider credential a canary attempt binds to. Delegates to MIG-008's authority; never re-implements it. |
| `server/src/index.ts` | **Modify** (~1073-1101). Compose `ownerResolver` + preflight + placement service into the rollout hook, and wire `onAttemptTerminal` → projector → `finalizeDistributedRun`. |
| `server/src/services/heartbeat.ts` | **Modify** (~5145-5147). The ownership call and the suppression guard. The only edit to the legacy call site. |
| `server/src/services/heartbeat.ts` | **Modify** (cancel writers ~6761/6809/6857/6894). Route a distributed-owned run's cancel to `requestCancellation`. |
| `server/src/routes/issues.ts` | **Modify** (~177-197). The raw `tx.update` cancel writer that bypasses `setRunStatus` entirely. |
| `docker/d1/campaign.env` | **Modify.** Nonce bump — `server/src` is off the D1 lane's path filter. |

---

## Task 1: Credential binding resolver — DONE

**Files:**
- Create: `server/src/services/canary-credential-binding.ts`
- Test: `server/src/__tests__/cli-006-canary-credential-binding.test.ts`

**Outcome: compose a constant, non-asserting binding (four explicit nulls). REFUSE any credential-derived resolver.**

The adversarial map established that a credential-derived resolver is not merely risky here, it is not constructible. `resolveCredentialBinding` receives four fields (`job-placement.ts:398-403`); `resolveProviderCredential` needs nine (`provider-resolution.ts:155-165`). Three of the six missing ones cannot be threaded:

- **`currentEnv` is an ordering impossibility.** The heartbeat computes `resolvedEnv` at `heartbeat.ts:3378` and `hbProviderId` at `:3430` — 140+ and 190+ lines AFTER the convert/place seam that reaches this resolver. A resolver here would have to re-derive the run's own credential decision from inputs that do not exist yet, producing two decisions per run that can disagree.
- **`executionTargetId` is circular.** `chooseGovernedSubscriptionBinding` validates against an expected target; placement is what chooses one.
- **`agentId` is not on the job.** Reachable only through `jobs.executorPrincipalId`, which is overloaded (`{kind:"worker", id: agentId}` for task_run, an opaque operationId for one_shot).

**Verified independently before accepting:** `requestedTarget: null` is hardcoded on every submitted job (`job-submission.ts:134-138`), and `TARGET_KIND_BY_CLASS` maps `owner_desktop` to `{desktop, local_host}` only while `pooled_gvisor` sits under `managed_cloud` (`execution-target-resolver.ts:52-55`). With four nulls the pin is null, routing falls to the `pooled_gvisor` branch (`:195`), and **no reachable path reaches an `owner_desktop` target** — the DE-29 owner-misrouting class is structurally excluded.

That exclusion is load-bearing because the check that would otherwise catch misrouting is **tautological**: `credentialOwnerId` is read off the routed target's profile (`job-placement.ts:279-281`) and `requiredOwnerPrincipalId` off the same profile (`:289`), so `candidateFits` compares a value to itself (`:548-555`).

**Do not enrich this binding.** A rotating value (a key generation, a freshly-read credential row) is hashed into `placementInputDigest`/`placementPolicyDigest`; a digest that changes between first placement and a retry throws `placement_already_decided` → `transfer_error` → that run falls back to legacy permanently. Credential-generation freshness belongs to the preflight, which already owns it.

- [x] Implementation + 8 tests locking the nulls, byte-stability, key-set stability, and copy-on-return.

## Task 2a: Compose the canary ownership path — DONE

**Files:** Modify `server/src/index.ts:1055-1101`; test `server/src/__tests__/cli-006-run-execution-owner.test.ts`.

Composed `ownerResolver` from the shared rollout source, the MIG-008 preflight over its delegating store, the existing convert orchestrator, and the placement SERVICE with the null credential binding. `deploymentEnabled` uses the already-resolved `config.distributedExecutionEnabled`, not a second `process.env` read — two reads of the gate can disagree after a reload.

**The placement adapter is extracted as a named, tested `toRunExecutionPlacement` because the compiler cannot guard it.** `JobPlacementServiceInput` requires `now` and `maxHeartbeatAgeMs`, which `RunExecutionPlacement.place` does not supply; since `place` uses method-shorthand syntax, TypeScript's parameter bivariance lets `placement: placementService` compile clean — **verified by mutating the real composition root and running `tsc` (exit 0)**. At runtime that hands `decideJobPlacement` `now: undefined`, failing its `now instanceof Date` check → `invalid_placement_input` → every canary transfer silently falls back to legacy, with no type error and no failing test.

- [x] Composition + 4 adapter tests (22 total in that file). Commit `f569a9985`.

---

## Task 2b: Wire the projector into the ingest hook

**Files:**
- Modify: `server/src/services/job-events.ts` — already accepts `onAttemptTerminal` (landed `ddaa29b78`)
- Modify: `server/src/routes/worker-control.ts:74-98` — add `onAttemptTerminal` to opts, pass to `createJobEventIngestService`
- Modify: `server/src/app.ts:446-454` — thread it through
- Modify: `server/src/index.ts` — build the callback
- Test: `server/src/__tests__/cli-006-projector-wiring.test.ts` (create)

**Composition-ordering problem — RESOLVED. Decision below, written before any code.**

### Terrain, re-verified in `C:\e3` at `dba9d0abf` (not inherited)

1. **The ordering constraint is stronger than this plan first stated.** `createApp` is called at `index.ts:846` — *before* both the distributed block (`:1055`) and the heartbeat block (`:1146`). So the problem is not merely that the two conditionals are independent; **neither one has run yet** when `createApp` composes `workerControlRoutes` → `createJobEventIngestService`. An eager callback referencing either block's locals is impossible, not just awkward.
2. **`server.listen` is at `:1870`**, after all composition. A lazy mutable holder would therefore be *observably* safe — no HTTP request can arrive before every block has run. That is exactly why it is the wrong answer: it would make correctness rest on a startup ordering invariant that nothing enforces and no test can see.
3. **`heartbeatService` (`heartbeat.ts:1435`) is a plain factory, not a singleton**, and `finalizeDistributedRun` (`:6623`) closes over only `db`-derived helpers — `getRun`, `setWakeupStatus`, `releaseIssueExecutionAndPromote`, `finalizeAgentStatus`. It touches neither the scheduler nor the `distributedRollout` option. `index.ts:1770` already constructs a second unconditional instance today (`runtimeDecisionTimeoutHeartbeat`), so a further construction is established practice — but the factory calls the module-global `setSecretResolver` (`:1453`), so construction is not side-effect-free.

### 2b-D1 — Eager and self-contained: the callback owns its dependency graph

The callback is composed **immediately before `createApp`**, from `db` and `distributedExecutionDatabases.appDb` — both already in scope at `:562`. It never reaches into the `:1055` or `:1146` block. No holder, no reordering of existing blocks, no late binding.

`finalizeDistributedRun` comes from a **lazily-constructed, memoized** `heartbeatService(db)` created inside the callback on first use. Lazy because the factory mutates a module global; a deployment that never canaries should not pay a third `setSecretResolver` registration at startup. Memoized so repeated terminals construct once.

**This dissolves the question the plan asked rather than answering it.** There is no "distributed on, scheduler off" degraded mode to fail closed against, because the capability was never sourced from the scheduler's instance. The proposed fallback — project terminal and summary, skip finalization, log — becomes unreachable by construction. That is strictly better than a branch: consistent with D3's "structurally hard, not merely tested-against", and it removes a partial-deployment path in which an agent pins at `running` and, because `finalizeAgentStatus` recomputes from the count of running rows, drags every other run of that agent with it (R7).

### 2b-D2 — `expired` → `timed_out` is a real vocabulary break, and the whole reason the fold is a named pure function

The signal carries `terminalStatus: TerminalEventStatus`, whose protocol vocabulary is **`succeeded | failed | cancelled | expired`** (`packages/worker-protocol/src/events.ts:320`). The projector consumes `CanaryAttemptOutcome` = **`succeeded | failed | cancelled | timed_out`** (`canary-run-projector.ts:23`). The sets differ in both directions.

`runStatusForOutcome` (`canary-run-projector.ts:125`) is an exhaustive switch with **no `default`**. It compiles only because its parameter type excludes `expired`; a cast at the boundary would return `undefined` at runtime and write a run status of `undefined`. This is the same shape as the `succeeded` ≠ `"completed"` defect already fixed in `089ee34ab` — a vocabulary crossing that typechecks clean and fails silently. It gets an explicit total mapping and a test per member, not a cast.

### 2b-D3 — `costUsd` is null by protocol, not by omission

`usagePayloadV1Schema` (`events.ts:82`) is `.strict()` over `inputTokens` / `outputTokens` / `cachedInputTokens` / `runtimeMillis` and deliberately rejects every pricing field. So the folded evidence carries `costUsd: null` and `durationMs` from `runtimeMillis`. `detectedFiles` is `[]`: `artifact_prepared` (`:294`) carries `artifactId` + `kind`, never a path — the same honest `[]` the W3a crew loopback ships.

### Shape

A new `server/src/services/canary-terminal-projection.ts` holding two pieces, so the logic is testable without the composition root:
- `foldAttemptEvidence(rows, terminalStatus)` — **pure**; `job_events` rows → `CanaryAttemptEvidence`, including the 2b-D2 mapping, sequence ordering, and `eventId` dedupe.
- `createAttemptTerminalProjectionHandler(deps)` — resolve the run by `(distributedJobId, distributedAttemptId)` **and** `executionOwner = "distributed"`, read the attempt's events under `runInTenant`, fold, project. No matching run → return silently: that is a non-canary attempt, or one whose run fell back to legacy.

- [x] **Step 1: ordering decision written** (above), then the failing test.
- [x] **Step 2: Ran it — RED** (module absent).
- [x] **Step 3: Built `canary-terminal-projection.ts`** — pure fold + handler + two adapters.
- [x] **Step 4: `onAttemptTerminal` threaded** through `workerControlRoutes` and `app.ts`, under one named `JobEventIngestTerminalHook` type so the three hops cannot drift.
- [x] **Step 5: Composed in `index.ts` before `createApp`**, per 2b-D1.
- [x] **Step 6: Mutation-checked** — ownership predicate removed → RED; `expired`→`failed` → RED; a dep demanding an extra required field → `tsc` TS2322. All three restored green.
- [x] **Step 7: 21 new tests; 123 green across the CLI-006 family; server suite shows no regression** (the 6 Windows-local failures are byte-identical with and without the change).

### What Task 2b actually landed, beyond the plan

- **`heartbeatService.projectDistributedAttemptTerminal`** — the projector needs `setRunStatus` (the terminal latch) and `appendRunEvent`, both private closures over the service's `db`. Publishing them would hand any caller the ability to terminalize a run, which is the second authority Invariant 8 forbids. So one narrow capability is exposed and the latch stays private — the `finalizeDistributedRun` precedent. Its single injected port is `listAttemptEvents`, the one read heartbeat's `db` cannot do (tenant-scoped `job_events` behind RLS, reachable only via `runInTenant` over `aoa_app`).
- **`finalizeDistributedRunImpl` extracted** to a private closure, so the exposed method and the projector's `finalizeRun` share one implementation instead of the object literal referencing itself.
- **`toProjectorTerminalWriter`** — `setRunStatus` resolves `row | null`; the projector's dep resolves `won: boolean`. Inverting that polarity is invisible to the compiler and fails in the worst direction: every projection believes it LOST the latch, skips finalization, and pins the agent at `running` (R7). Named and tested, per the `toRunExecutionPlacement` precedent.
- **`projectionSeqBase`** — the Task 3 handoff lifecycle event writes seq 1 and the attempt's own sequence also starts at 1. `heartbeat_run_events` has only a NON-unique `(run_id, seq)` index, so the collision does not error; it silently interleaves the distributed log with the handoff notice. Projected seqs are offset above the run's existing max.
- **Every port on `AttemptTerminalProjectionDeps` uses arrow-property syntax, not method shorthand** — proven by mutation to reject a dependency that demands an extra required field (TS2322), which is precisely the hole `placement: placementService` slipped through in Task 2a.

---

## Task 3: The suppression seam

**Files:**
- Modify: `server/src/services/heartbeat.ts` (ownership call before `:5145`; guard between `:5146` and `:5147`)
- Test: `server/src/__tests__/cli-006-seam-suppression.test.ts` (create)

**The insertion point is load-bearing and verified.** The `return` must be **inside** the inner `try`, not before it. `heartbeatMcpDelivery.cleanup()` has exactly one call site (`:5192`, in that inner `finally`) and `deregisterRuntimeHook` one (`:5190`). Returning before `try {` skips both, leaking a 24h-valid runtime-permission token and a tmpdir MCP config file that, for non-brokered `claude_local`, **embeds `DATABASE_URL`** — no TTL, no sweeper.

- [x] **Step 1-2: failing test, RED** — 9 cases. `executeRun` is impractical to unit-test (Risk #2), so the test proves what can be proven: the decision and the marker write are pure functions, and the RETURN'S POSITION is asserted **structurally** against `heartbeat.ts` source.
- [x] **Step 3: ownership call added** on exactly the planned predicate. `tsc` confirms `issueContext`, `distributedRolloutOrganizationId` and the `"canary"` state are in scope and well-typed there — the plan's claim re-verified by the compiler, not by reading.
- [x] **Step 4: suppression guard** as the first statement inside the inner `try`; `markRunHandedOffToDistributed` writes the marker (no `status` — the attempt is the terminal authority now) and appends one lifecycle event.
- [x] **Step 5: `tsc` exit 0** — definite-assignment on `adapterResult` survives the early return, asserted by the compiler as required.
- [x] **Step 6: mutation-checked** — hoisting the `return` above `try {` turns the structural test RED. Restored green.
- [x] **Step 7: committed `3799c8048`.** 350 green across the CLI-006, heartbeat and reaper suites.

**D3a's checkout bypass was verified present, not assumed.** A canary run reaching a late `admitAndSubmit` without it is checked out twice — the exact Invariant 3 break CLI-005's review caught. It is present at `job-admission-bridge.ts:292-308`, keyed on `taskSourceIsAdmitted`, and active mode is unaffected because there the harness suppresses its own checkout.

**Why a structural test earns its place here.** One line earlier the `return` typechecks, passes every behavioural test, and leaks a 24h-valid runtime-permission token plus a `DATABASE_URL`-bearing tmpdir MCP config. Nothing else in this repo catches that; the mutation proves the assertion is live.

---

## Task 4: Cancel routing for distributed-owned runs (R3)

**Files:**
- Modify: `server/src/services/heartbeat.ts` (`:6761` `cancelRun`, `:6809`/`:6857`/`:6894` `cancelBudgetScopeWork`)
- Modify: `server/src/routes/issues.ts:177-197`
- Test: `server/src/__tests__/cli-006-cancel-routing.test.ts` (create)

**Today cancel is a lie for these runs.** Every writer's only stop mechanism is `runningProcesses.get(run.id)`, which misses; `grep requestCancellation server/src/services/heartbeat.ts` returns zero hits. Worse, the writer latches the run `cancelled`, so the projector's later terminal is discarded and the distributed evidence is lost.

**Three corrections to this task, found by re-verifying the terrain at `a78e6013f` before writing code. The plan as written cannot work.**

**(1) The trap is in a different file, and it is a BULK writer.** It is `server/src/services/issues.ts:176-187`, not `routes/issues.ts`. The line number carried over correctly; the path did not. It matters more than a typo, because the writer is not per-run: it `tx.update`s **every** id in `activeRunIds` in one statement, bypassing `setRunStatus` entirely, and in the same transaction nulls `issues.executionRunId`. Routing it means partitioning that id set by `execution_owner`, not adding a guard to a single-run path.

**(2) Constructor injection cannot reach the cancel writers — verified.** `cancelRun` has exactly three non-test callers, and **none of them holds an instance built with options**:

| Caller | Instance | Constructed |
|---|---|---|
| `routes/agents.ts:2161` | `agents.ts:198` | `heartbeatService(db)` — no options |
| `routes/issues.ts:386` | `issues.ts:99` | `heartbeatService(db)` — no options |
| `index.ts:1835` | `index.ts:1828` | `heartbeatService(db)` — no options |

Only the scheduler instance (`index.ts:1205`) receives `distributedRollout`. So a `requestCancellation` port added to `heartbeatService`'s options would be `undefined` at **every** real cancel — the code would look wired, typecheck, and never fire. This is the same shape as the Task 2a bivariance defect: a composition that reads as correct and is inert.

The port is genuinely needed, because `requestCancellation` lives on `createJobReconciliationService({appDb})` and runs under `runInTenant` over `aoa_app`, which heartbeat's owner-pool `db` cannot reach.

**Two viable shapes; recommend the first.**
- **Module-level registration** — `setDistributedCancellationPort(port)` called once from the `index.ts` distributed block, read lazily at cancel time. This is an idiom heartbeat.ts already uses twice (`setSecretResolver` at `:1453`, `registerRuntimeHook`), it keeps the blast radius at the seam, and it is instance-independent by construction, which is exactly the property that failed above.
- Re-compose the three route factories to receive the port. Correct but a wider blast radius through route signatures, for no additional safety.

**(3) The unset-port fail-safe is a real decision, not a default.** A marked run can only exist because the seam ran, which requires distributed execution enabled — but a control-plane **restart with the flag off** leaves marked runs behind and no port. Refusing to write a terminal then strands them forever; falling through to the legacy cancel converges, because with the subsystem disabled no worker will ever terminalize that attempt. **Fall through to the legacy cancel, and log loudly.** The cost is losing distributed evidence for a run the operator has already disabled the subsystem for; the alternative is an unkillable run. This is the opposite direction from the seam's own fail-safe and that asymmetry is deliberate: suppression must never strand a run, and cancel must never leave one unkillable.

### Part 1 — LANDED (`e7cfae545`)

`server/src/services/distributed-cancellation-port.ts`: `resolveCancelRoute` + the module-level port. Inert — nothing calls the resolver and nothing registers the port. 9 tests; all three guards mutation-proven (owner check, port check, job-id check each removed in turn → RED).

### Part 2 — the four heartbeat writers, the bulk writer, and one more decision

All four heartbeat writers share one shape: `setRunStatus(…, "cancelled")` → `setWakeupStatus` → `cancelRuntimeDecisionPromptsForRun` → kill the local process → release the issue. For a distributed-owned run the first two must not happen (the projector owns the terminal); the runtime-decision cancel still should.

| Writer | Location | Shape |
|---|---|---|
| `cancelRun` | `heartbeat.ts:7039` | single run, **throws to an HTTP caller** |
| `cancelActiveForAgent` | `:7087` | loop over an agent's runs |
| `cancelBudgetScopeWork` (agent scope) | `:7135` | loop, budget hard-stop |
| `cancelBudgetScopeWork` (company scope) | `:7172` | loop, budget hard-stop |
| task-ineligible bulk | `services/issues.ts:176-187` | **one `tx.update` over `activeRunIds`** |

**4-D1 — a THROWING port is not the same failure as a MISSING one, and must not share its fail-safe.**

Part 1 established that a missing port falls through to the legacy write, because with the subsystem disabled no worker will ever terminalize that attempt, so the legacy write is the only convergent outcome. **That reasoning does not transfer to a port that throws.** There the subsystem is enabled and the worker is *live*: writing `cancelled` locally would claim a stop that did not happen, latch the run, and cause the projector to discard the attempt's real terminal when it arrives. The run would read cancelled in the UI while the sandbox kept burning budget.

So on a port throw: **never write a terminal.** Then split by caller, because the callers have genuinely different obligations:

- **`cancelRun` — propagate.** It answers an HTTP request. An operator who asked to cancel must be told it failed rather than shown a false success; retry is theirs to make.
- **The three loops and the bulk writer — log and skip that run, continue the batch.** One unreachable attempt must not abort a company-wide budget hard-stop for every other run. The skipped run stays `running` and is revisited by the next sweep.

**4-D2 — the bulk writer partitions, it does not branch.** `services/issues.ts:176-187` updates every id in `activeRunIds` in a single statement inside a transaction that also nulls `issues.executionRunId`. The fix is to partition `activeRunIds` by `execution_owner` and narrow the `tx.update` to the legacy subset; the distributed subset is routed after the transaction commits, because `requestCancellation` runs under `runInTenant` on a different pool and must not be entangled with this transaction's lifetime. Note the issue-lock release must still cover both subsets — a distributed run whose task became ineligible still has to give the lock back.

- [x] **Steps 1-2: 4-D1 matrix tested fail-first** — `dispatchCancel`, 15 cases.
- [x] **Step 3: four heartbeat writers routed** through the private `routeRunCancellation` over `dispatchCancel`. `cancelRun` uses `onError:"propagate"`; the three loops use `"skip"`.
- [x] **Step 4: the bulk writer.** It turned out NOT to need a JS partition — the exclusion goes in the SQL predicate itself (`or(isNull(executionOwner), ne(executionOwner, "distributed"))`), which mirrors `resolveCancelRoute`'s semantics exactly and cannot drift from the id list. The distributed subset is routed by a new `routeDistributedCancelsForRuns` called AFTER the transaction at both `terminateTrackedRuns` sites, because `requestCancellation` runs through `runInTenant` on a different pool. This closed a hole the plan had not named: `terminateTrackedRuns` only signals an in-process child, which a distributed attempt never has, so a task going ineligible previously left the worker running with nothing to stop it.
- [x] **Step 5: port registered** in `index.ts`'s distributed block, resolving the Organization from `companyId` there (a `heartbeat_runs` row carries none, and heartbeat cannot reach the mapping).
- [x] **Step 6: mutation-checked** — SQL exclusion removed → RED; one writer's routing removed → RED; a throw latching a local terminal → RED; the propagate branch removed → RED.
- [x] **Step 7: committed.** 21 tests in the routing file, 147 green across the CLI-006 family, all six policy checkers pass, and the six Windows-local failures are byte-identical with and without the change (6 failed / 103 passed both ways, verified by stashing).

**What is NOT routed, deliberately:** `cancelRuntimeDecisionPromptsForRun` still runs for a distributed run — those prompts belong to a run that is stopping either way. What the distributed branch must NOT do is write a terminal, write a wakeup status, or release the issue execution lock: releasing it while the attempt is live would let another run claim the issue underneath a running worker. The projector does all three when the real terminal arrives.

---

## Task 5: Org capacity double-count (R4)

**Files:**
- Test: `server/src/__tests__/cli-006-capacity-trap.test.ts` (create)

`resolveOrgCapacityUsage = legacyRunning + heldAttempts` (`org-concurrency.ts:136-144`). A suppressed run satisfies `legacyRunning` (still `status='running'`) while its attempt satisfies `heldAttempts`, and capacity is claimed at submit — inside the convert, i.e. inside `resolveRunExecutionOwner`. **At `concurrency_cap = 1` — the natural operator choice for a canary — the transfer is structurally impossible:** admission denies with 429 → `convert_failed` → legacy, silently.

This task documents the trap with tests rather than changing the capacity engine (JOB-007 owns it); the operator guidance goes in the result doc.

- [x] **Characterised in `cli-006-capacity-trap.test.ts` (7 tests).** Re-verified in the code rather than inherited: `countRunningRunsForOrg` (`org-concurrency.ts:82-94`) counts EVERY `status='running'` heartbeat run for the Organization with **no owner exclusion**, `resolveOrgCapacityUsage` returns `legacyRunning + heldAttempts`, and `admitAttemptCapacity` denies on `usageForReport >= cap`.
- [x] **The consequence is worse than "cap 1 is tight".** At the moment the seam resolves ownership the run is ALREADY `running`, so it is counted against itself before its attempt has claimed anything. At `cap = 1` usage is 1 on a **completely idle Organization** → denied → `convert_failed` → legacy, silently. Nothing errors and nothing surfaces at the operator's altitude; the canary simply never happens. `cap = 1` is the natural first choice for a pilot.
- [x] **Operator guidance for the result doc:** the cap must be **strictly greater than the Organization's concurrent legacy runs**, not merely greater than 1. `cap = 2` works only on an otherwise-idle org.
- [x] **Proven non-vacuous** — adding an `executionOwner` exclusion to `countRunningRunsForOrg` (which would dissolve the trap) turns the suite RED.

---

## Task 6: The unguarded await in the outer finally (R6)

**Files:**
- Modify: `server/src/services/heartbeat.ts:5799`
- Test: add to `server/src/__tests__/cli-006-seam-suppression.test.ts`

`dispatchQueuedRunsAfterAgentSignal` at `:5799` is the only bare `await` in the outer `finally` (the neighbours at `:5783`/`:5792`/`:5795` are `.catch`-chained). It throws in the tenant-isolated branch (`:2829`). If it throws after a suppression `return`, `executeRun`'s promise rejects into the call-site `.catch` (`:2717`/`:2780`), which — seeing the run still `running` — writes `pre_spawn_failed` and releases the issue. **That is exactly the legacy finalization the seam exists to prevent, reached through an exception.**

- [x] **Re-verified, then fixed fail-first.** Confirmed in the code: it is the only bare `await` in `executeRun`'s outer `finally` — the workspace run lock, the runtime services and the environment leases above it are all `.catch`-chained — and `dispatchQueuedRunsAfterAgentSignal` genuinely throws in the tenant-isolated branch when an Organization cannot be resolved.
- [x] **Chained with a logging `.catch`**, matching its three neighbours rather than swallowing silently.
- [x] **Structural test RED first**, then green; a companion asserts the neighbours still hold the line, so the property stays "nothing in this finally can reject" rather than "one call was fixed".

---

## Task 7: Fire the D1 lane

**Files:**
- Modify: `docker/d1/campaign.env`

`server/src` is **not** on `d1-merge-train.yml`'s path filter, so a server-only change silently does not run the live lane. This bit DEP-009 already.

- [x] **Nonce bumped** to `cli-006-seam-387447d35`, with a comment naming exactly what is off the filter: Tasks 2b/3/4/6 land in `server/src` ONLY.
- [ ] **Watch the D1 lane to green** (fires on push).

---

## Task 8: Adversarial review and result doc

- [ ] **Step 1: Adversarial review workflow** — refute-by-default, targeting double-execution specifically: partial deployment, config change mid-run, replayed convert, placement succeeding after the suppression check, and a worker leasing an attempt whose run already went legacy.
- [ ] **Step 2: Controller re-verification** — re-trace each confirmed finding personally; fix fail-first.
- [ ] **Step 3: Write `CLI-006-result.md`** — including an honest deferral list. Known deferrals: the D1/D2 volume clauses are operator campaign records; the JOB-006 sweeper still has no production trigger, so a lease that expires without a terminal event has no convergence path.
- [ ] **Step 4: Commit, push, watch CI.**

---

## Self-review notes

- **Spec coverage:** the 13 acceptance verbs map to Tasks 2-4 (create/schedule/lease/stage/execute/stream/patch/review/retry/cancel) and the existing JOB-008 surface (audit/operator inspection); non-canary isolation is the four-mode matrix already landed in `cli-006-canary-rollout-mode.test.ts`.
- **Known gap, deliberately not hidden:** with the JOB-006 sweeper unscheduled, an attempt whose lease expires without emitting a terminal event strands its run in `running` forever. Task 8 records it; scheduling `createJobControlSweeper` belongs to MIG-002's cutover, not to the canary.
- **Task 1 is genuinely unwritten**, not a placeholder — it is blocked on a security decision in flight, and the plan says so rather than inventing steps.
