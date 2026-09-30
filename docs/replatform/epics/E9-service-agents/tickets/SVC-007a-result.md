# SVC-007a — service create, generation and the desired-state control — RESULT

**Epic:** E9 · **Lane:** B · **Base:** `053f90fc8` (branched from `docs/replatform-program`)
**Terrain + design:** [`SVC-007a-design.md`](./SVC-007a-design.md)
**Register:** gate clause `E9-4-service-create-and-desired-state` enrolled `wired`. **`E9-F006`
OPENED and RESOLVED here. `E9-F002`, `E9-F003` and `E9-F004` are untouched and all three stay
`open`/`unowned`. SVC-007 STAYS OPEN.**

> **★ SVC-007 HAD ZERO FILES ON DISK at `053f90fc8`** — no terrain, no design, no result, only the
> `#### SVC-007` node in `program-design.md` and **55 references across 24 files** (measured at
> `053f90fc8` over `docs/` + `scripts/`, `*.md` and `*.json`) — other tickets' scope-outs,
> register rows in `scripts/gate-clause-wiring.json` and two `docs/architecture/*.json`
> registers, and four findings-register lines that named it as an inheritor. Terrain and design
> were part of this unit's job and are in the companion file. Re-measured at source; no citation
> in either document is inherited.

---

## 1. What shipped, in one paragraph

An org admin can now create a service. `createServiceWithinTenant` writes the `services` row and
its immutable generation-1 `service_generations` row inside ONE transaction, behind a definition
boundary that refuses ingress keys (from SVC-001's own shipped deny-set), control-plane-owned
identity fields, unknown fields and anything the frozen `serviceWorkloadV1Schema` rejects.
`setServiceDesiredState` moves `desired_state` through the FROZEN
`SERVICE_DESIRED_TRANSITIONS` table under SVC-002's own per-service row lock, and a stop also
reaches JOB-006's shipped `requestCancellation` (graceful) and then terminalizes the instance that
cancellation orphaned — **all three writes in ONE transaction, under that same lock**, which is
the fix for the P1 external review raised (§4a(i)). Four routes on
`jobControlRoutes` compose it, behind the same `execution_target:manage` gate every other
operator mutation on that router uses. Zero wire change; zero new relations; zero migrations.

---

## 2. ★★★ WHAT IS NOW TRUE THAT WAS NOT, AND WHAT IS STILL NOT TRUE

**Now true.** Three shipped documents carried the same two sentences at base and all three were
right — `SVC-002-result.md` §7 (*"Nothing creates a service … Nothing writes a generation"*),
`SVC-003a-result.md` §2 (*"NOTHING CREATES A SERVICE … so on a real deployment there is no
`services` row, so no instance, so nothing for this projection to move"*) and this epic's
`README.md` (*"every pass stalls at `no_generation` on a real deployment"*). Those sentences are
no longer true. SVC-002's reconciler and SVC-003a's projection were **shipped and structurally
unreachable**; a service created through this path is converged by the reconciler — including
through `createServiceReconciler(...).tick()` — the SAME sweeper the composition root drives,
with its admitted-organization enumerator stubbed and its backoff timer not exercised, so what
that case proves is that a created service ENTERS `listReconcilableServices`'s window and
converges through the sweep, not that the process wiring around the sweeper runs — into exactly
one instance and one `service` job built from the STORED definition.

**★ STILL NOT TRUE, AND E9'S EXIT GATE IS NOT MET.** The gate names ten things. This unit moves
**two of them partly — `desired state` and `generation` — and touches a third, `drain`**. Rows 3
and 4 below are marked from SVC-002 and SVC-003a and are unchanged by this unit; the remaining
six are not delivered at all:

| # | Gate item | After this unit |
|---|---|---|
| 1 | desired state | **partial** — create (`running`/`paused`) and control (`running`/`paused`/`stopped`) ship. `deleted` is refused (terminal tombstone, SVC-005). |
| 2 | generation | **partial** — generation **1** is written. NOTHING mints N+1: a rollout without SVC-005's overlap fence is the overlap E9's acceptance forbids. |
| 3 | placement | unchanged (SVC-002's control-plane half). **No service job is leased anywhere in this suite** — `E9-F002`. |
| 4 | health | unchanged (SVC-003a). No worker is in the loop here, so no worker-driven projection is exercised. |
| 5 | restart | **not delivered.** SVC-004. |
| 6 | checkpoint | **not delivered**, and not storable — `job_control_commands_kind_check` omits `checkpoint` entirely (SVC-001). SVC-004. |
| 7 | drain | **partial** — a job-level graceful stop is now reachable FOR A SERVICE. Worker drain, replace-before/after-stop and force-kill are SVC-005's. |
| 8 | budgets | **not delivered.** Spend is attributed per job; no per-service budget exists and no TTL is accepted (§5). |
| 9 | UI | **not delivered.** Four HTTP routes, no UI. |
| 10 | D4 72-hour canary | **not run.** SVC-006. |

**Do not read this ticket as closing SVC-007.** Its Outcome is a conjunction —
create/update/pause/resume/stop **and** a view of desired state, generation, active instance,
health, checkpoint, budget and restart history — and `update` (generation rollout), checkpoint,
budget and restart history are all absent. Half of a conjunction is not it.

---

## 3. The arming path, counted rather than asserted

The brief's warning was that this is the unit most likely to ship a create path with no caller —
`repos.services.insert` reads exactly like `createStartupReconciler`, `createResultCommitter` and
`jobAuditBridge` — all three MEASURED at **0** production callers at head. (★ The brief also named
"the reaper" as such a path. It is not one: `reapOrganization` measures **4** production callers
and `reapExpiredLeases` **3**. Recorded because an orchestrator's given is an unverified claim,
and repeating it would have put a false measurement in a result document.) Measured with the
register's own `countProductionCallers`, base `053f90fc8` vs head:

| Symbol | Base | Head | What the head count is |
|---|---|---|---|
| `createServiceWithinTenant` | — (did not exist) | **1** | `createService` |
| `createService` | — | **1** | the POST route |
| `setServiceDesiredState` | — | **1** | the desired-state route |
| `setServiceDesiredStateWithinTenant` | — | **1** | `setServiceDesiredState` |
| `readService` / `listServices` / `normalizeServiceDefinition` | — | **1** each | the GET routes and the create route |
| `insertServiceGeneration` | — | **3** | ★ the MEASURED figure. For a tenant-repository method the guard counts the interface declaration and the implementation alongside the one call site. The intuitive figure is 1. |
| `updateServiceDesiredState` | — | **3** | same shape |
| `terminalizeServiceInstanceForCancelledAttempt` | — | **3** | same shape |
| `findServiceForCompany` / `listServicesForCompany` | — | **3** each | same shape |
| `findLiveServiceInstance` | — | **4** | declaration + implementation + two call sites (`setServiceDesiredStateWithinTenant`, `readService`) |
| **`canTransitionServiceDesiredState`** | **0** | **1** | ★ the one that matters — see below |
| `lockServiceForReconcile` | **3** | **4** | the control REUSES SVC-002's per-service advisory lock rather than minting a second key |
| `decideServiceProjection` | **1** | **2** | the control-plane backstop reads its mapping from the worker path's own decider |
| `findServiceGenerationDefinition` | **3** | **4** | the fourth is `readService` — the operator view resolves the CURRENT generation's definition through SVC-002's own reader rather than a second query. (`T4` reads it back too, but the counter excludes tests, so it is not the delta.) |
| `createStartupReconciler` (the cautionary neighbour) | **0** | **0** | untouched; still zero |
| `createServiceReconciler` | **2** | **2** | untouched |
| `requestCancellation` | **17** | **18** | the stop reaches JOB-006's shipped repository mutator directly, INSIDE the control's transaction — not through `jobOperations.drainJob`, which opens its own (§4a(i)) |
| `currentDatabaseTime` | **20** | **21** | the cancellation is anchored to a FRESH database clock, never JavaScript time, exactly as every other caller does it |

`repos.services.insert` is a property access the counter cannot see. Measured by grep over
non-test sources: **0** production call sites at base, **1** at head
(`createServiceWithinTenant`). The two other head matches are comments, in this result's own
subject matter — which is exactly the class `stripComments` exists for.

★ **`canTransitionServiceDesiredState` is the vacuous symbol this unit arms**, and it is the
SECOND dead frozen fence in this epic: `canTransitionServiceInstanceStatus` was in the identical
state until SVC-003a. Its only references at base were its own definition, the package barrel
(which the counter strips) and its own unit test. A lifecycle nothing enforces is a clause that
is vacuously true.

**THE COMPOSITION ROOT, BY NAME:** `jobControlRoutes` in `server/src/routes/job-control.ts`,
mounted by `createApp` (`server/src/app.ts`) inside the `opts.distributedExecutionEnabled` block
over the non-owner `aoa_app` pool — the same router that already carries JOB-008's operator
surface. Nothing new is registered in `server/src/index.ts`.

---

## 4. Reds observed, the NAMED POSITIVE CONTROL, and the mutants

**★ HOW THE REDS WERE OBSERVED, stated so they are not over-read.** There is **no genuine
base-tree red** in this suite, and saying so plainly matters: a suite that drives a module which
does not exist at base reds on "cannot import", which proves nothing about the shipped path
(SVC-008b's lesson, restated by SVC-003a). Every red below is a MUTATION result. Each mutant was
applied by a harness that

* **refuses to apply when a backup already exists** — the failure that let five mutants stack
  silently in SVC-003a's run;
* **tries BOTH line-ending forms of its anchor and THROWS when neither matches** — this tree is
  mixed (`packages/db/src/repositories/tenant/job-control.ts` is CRLF, the new module is LF), and
  every applied mutant's report names which form matched;
* **decides applied-ness by comparing bytes**, not by whether a step threw;
* for a repository mutant, **rebuilds `packages/db/dist` and confirms the mutation is PRESENT in
  the rebuilt `dist`** before the result is believed — the server suite resolves
  `@armyofagents/db` through `dist` while vitest prints `src` paths.

> ★ **AND THIS HARNESS FAILED ONCE TOO, recorded for the same reason SVC-003a recorded its two.**
> Its `finally` restored unconditionally. When `M13`'s anchor MISSED — a stale anchor naming a
> method that no longer followed the one being mutated — `apply` threw *before* writing the
> backup, the `finally` then threw `NO BACKUP to restore`, and **that second error replaced the
> first**: the harness reported a restore problem for what was actually a stale anchor. It now
> restores only when the apply provably landed. `git status --porcelain` and a `MUTANT_` grep
> were checked immediately afterwards and the tree was clean, so no partial write survived.
> *An error handler that can throw over the error it is handling is a check that hides one.*

**NAMED POSITIVE CONTROL: `★ T9 POSITIVE CONTROL — a service with no generation still stalls at
no_generation`.** A hand-inserted `services` row with no generation converges NOTHING and
reports `{action:"none", reason:"no_generation"}` — the exact state the whole tree was in at
base. **Green before, green after, and green under all nineteen mutants.** Without it, every
convergence assertion in this suite could be made green a second way: by weakening the
reconciler until it starts a service with no readable definition. If T9 ever reds, a green T2 was
measuring a broken reconciler rather than a working writer.

**NINETEEN mutants over 31 cases** (18 pure + 13 integration). ★ Counts are the FINAL figures,
re-measured on the shipped source AFTER the review fixes of §4a — not the first campaign's, which
ran seventeen mutants over 30 cases against a control that was still two transactions. The two
extra mutants (9b, 12b) exist because the single-transaction rewrite created two new ways to be
wrong.

| # | Mutant | Result |
|---|---|---|
| 1 | Delete the generation writer entirely — **the BASE-TREE state** (`service_generations` had zero writers) | **10 red**, positive control green |
| 2 | Store the definition under different key names (`cmd`/`argv`/`stopSeconds`) | **7 red** |
| 3 | Ignore the requested `desiredState` and always create `running` | **1 red** — T3 |
| 4 | Write a `ttl_seconds` nothing enforces | **1 red** — T4 |
| 5 | Delete the ingress deny-set loop | **1 red** — P2 |
| 6 | Delete the control-plane-owned field loop | **1 red** — P3, on the REASON (the fields still fall through to `unknown_field`, so collapsing the two reasons would let the loop be deleted with nothing red) |
| 7 | Replace the FROZEN desired-state predicate with `true` | **4 red** |
| 8 | Delete the same-state short-circuit | **4 red** — the frozen table has no self-edges, so a satisfiable request answers `illegal` |
| 9 | Delete the graceful-stop call | **5 red** — the Stop button that moves a column and nothing else |
| **9b** | Cancel NON-gracefully (`graceful: false`) | **1 red** — P10a. The definition's `gracefulStopSeconds` would become a number nothing honours |
| 10 | Delete the control-plane attempt-terminal backstop (**E9-F006**) | **2 red** — including T6's resume leg |
| 11 | Run the backstop with an EMPTY predecessor set | **3 red** — the fail-closed shape is load-bearing |
| 12 | Short-circuit the stop on `unchanged` | **1 red** — ★ P10b |
| **12b** | Cancel on a RESUME too | **2 red** — P10c and T6. A resume would kill the instance it is about to want |
| 13 | Drop the `companyId` predicate from `findServiceForCompany` | **1 red** — T8 |
| 14 | Delete the "attempt must already be terminal and not succeeded" gate | **1 red** — T10 |
| 15 | Widen the generation-conflict catch to a bare `catch { return null }` | **1 red** — T12(a) |
| 16 | Treat an EMPTY `allowedFromStatuses` as "anything goes" | **1 red** — T10 |
| 17 | Drop the compare-and-set predicate from `updateServiceDesiredState` | **1 red** — T12(b) |

★ **MUTANTS 15 AND 17 DID NOT KILL ON THE FIRST PASS, and that is recorded rather than dropped.**
Both guard properties no shipped caller can violate: the generation insert's narrow `23505` catch
has no reachable non-`23505` failure from `createServiceWithinTenant` (the triple-composite
tenant FK is satisfied by construction — the service row was inserted in the same transaction),
and the compare-and-set predicate is redundant while the caller holds the row lock. *A guard whose
mutant nothing kills is a guard that can be deleted with a green suite.* `T12` was added to drive
both directly against the repository, and both mutants then killed it. The residual is stated in
the test file beside the case: neither property is reachable from a shipped caller today; each
exists for a FUTURE one — the narrow catch so a tenant violation is never reported as "a
generation already exists", the CAS so a caller that forgets the lock cannot overwrite a state it
did not read.

★ **MUTANT 1 IS THE ONE TO READ.** It reproduces the base tree exactly — no generation writer —
and TEN of the thirteen integration cases go red, including the sweeper case, the
create→reconcile→stop→resume chain and the single-transaction rollback probe. That is the size of the seam this unit closes.

**Suites:** `server/src/__tests__/service-management.test.ts` (18 pure cases, including a walk of
the WHOLE 4×3 desired-state table against the frozen predicate with an anti-vacuity check that
both answers occur) and `server/src/__tests__/service-management.integration.test.ts` (13 cases,
real embedded PostgreSQL, run with `AOA_RUN_WIN_INTEGRATION=1`).

---

## 4a. ★★★ EXTERNAL REVIEW RAISED THREE THINGS. TWO WERE REAL DEFECTS AND ARE FIXED

Recorded rather than folded in silently, because the shape of each miss is the lesson. Every one
was verified against source before it was believed.

**(i) P1 — THE STOP COULD OVERTAKE A RESUME. REAL, AND FIXED.** The first revision committed the
desired-state write, **released the service lock**, and only then looked up the live instance and
cancelled its job in a second transaction. The ordering was deliberate — state first, so a
reconciler tick between the two could not mint a replacement of the thing being stopped — and the
review's point was that ordering is not enough: a concurrent `stopped → running` landing in the
same gap means the older stop still drains a job the operator has **already resumed**, taking the
service down until the reconciler's next tick replaces it.

★ **The fix is the whole control in ONE transaction under the service's own row lock**, reaching
`repos.jobControl.requestCancellation` (graceful) directly instead of `jobOperations.drainJob`,
which opens its own. A resume cannot commit between the read of `desired_state` and the
cancellation, because it cannot acquire the row. It also removes a split outcome the first
revision had to report: a cancellation failure now rolls the desired-state write back with it, so
the operator gets ONE definite answer instead of *"the column moved but the thing is still
running, please retry"* — and the `status:"failed"` variant is gone from the result type.

★ **THE LOCK ORDER IS STATED RATHER THAN ASSUMED**, because `requestCancellation`'s own header
warns that getting it wrong deadlocks (40P01). This transaction takes the per-service advisory
lock and the `services` row FIRST, then `requestCancellation`'s untouched `lease → attempt → job`
hierarchy, then `service_instances`. Nothing in the tree takes a job-side lock and THEN the
service advisory lock: SVC-002's reconciler takes the service locks first exactly as this does,
and the JOB-005 ingest takes `lease → attempt → service_instances` with no service lock at all —
and both it and this reach `service_instances` only while already holding the attempt, so the two
agree on direction. **T13 is the rollback probe that pins the single transaction**; mutant 12b
pins that a resume still cancels nothing.

**(ii) P2 — AUTHORIZATION DID NOT ACTUALLY RUN FIRST. REAL, AND FIXED.** `validate(schema)` is
express middleware, so it ran BEFORE the handler and therefore before `assertOrgAdmin` — meaning
an unauthorized caller with a malformed body got a 400 about their body while the same caller
with a well-shaped body got the 403. The routes' own comment claimed "authority first". The
schema is now parsed INSIDE the handler after `assertOrgAdmin`; a thrown `ZodError` reaches the
same error handler `validate` relied on, so **only the order moves and the 400 body is
unchanged**. The sibling JOB-008 mutations (`drain`, `revoke`) still use the middleware and have
the same ordering; changing them is not this ticket's, and is noted rather than done silently.

**(iii) P1 — "persist audits for service mutations". HALF REAL. The half that was real is fixed;
the other half is declined WITH ITS REASON.**

* **REAL AND FIXED:** the desired-state route REQUIRED a `reason` (min 1 char) and then
  **discarded it on every transition to `running`**. A stop carries it into
  `job_control_commands.body` through `requestCancellation`, but a resume reached no sink at all —
  a field the caller was forced to supply went nowhere. It is now on the structured audit line.
* **★★★ CORRECTION, 2026-09-10 (`E9-F010`, `SVC-007b-result.md`). THE DECLINE BELOW IS HALF
  RIGHT AND HALF MEASURED FALSE, and the bullet is left standing rather than rewritten so the
  shape of the miss stays legible.** The `fence` requirement on `recordAcceptedActivity` is
  real and re-verified — that bridge genuinely cannot be called from here. What does NOT
  follow is that the TABLE is unwritable: `insertActivityLog` takes a plain `Db` and needs no
  fence, `aoa_app` holds `GRANT SELECT, INSERT ON activity_log` (`0213:98`, re-affirmed
  `0214:166`) under no RLS (`0245`'s own header says so), and a fenceless transactional write
  of that table ALREADY SHIPS on the distributed path — `stageJobInputFiles`, **2** production
  callers against `jobAuditBridge`'s **0**. So the fenced bridge was the deviation and the
  direct transactional write the norm, not the other way round. SVC-007b wires the two
  MUTATING routes of this ticket; the three JOB-008/submission mutations on the same router
  stay silent, which is why `E9-F010` stays OPEN. **§7's sentence "it is currently unwritable
  from here" is withdrawn.**
* **DECLINED, and this is a mechanical reason rather than a scope preference:** the shipped
  distributed-execution audit path is `jobAuditBridge.recordAcceptedActivity`, and its input
  contract **requires** `fence: ActiveFenceRequest` — *"the LIVE distributed attempt to bind the
  audit to (composite FK + fence)"* — because JOB-013 makes the `activity_audit` receipt the sole
  replay guard for an `insertActivityLog` that has no native dedup. **A service CREATE has no
  attempt, and a desired-state change has no fence** (the job is typically queued and unleased).
  So that bridge is structurally unusable here, and writing `activity_log` directly would create a
  SECOND, unguarded audit path that JOB-013's exactly-once machinery does not cover and that DE-01
  would then have to reconcile. `jobAuditBridge` still has **zero production callers** — the gap is
  already on the register under DE-01, it is shared with the sibling JOB-008 mutations, and it is
  named in §7 rather than quietly closed here. AGENTS.md's *"Activity logging for all mutating
  actions"* invariant is therefore **not met by these routes, and that is stated rather than
  claimed**.

---

## 5. ★★★ E9-F006 — the stop that orphaned its own instance

Found while building the stop control, filed, and resolved in this commit. The full statement is
in `../findings.md`; the short version, because the shape is the lesson:

`repos.jobControl.requestCancellation` has a branch that **FINALIZES** a cancellation directly —
attempt and job both `cancelled` under its own locks — precisely when there is no fenced worker
to drain. **No worker event is emitted, because there is no worker.** SVC-003a's attempt-terminal
backstop lives in `decideServiceProjection`'s `terminal` arm and fires only from an INGESTED
event, so on that branch it never runs: the instance stayed non-terminal inside
`service_instances_live_service_uq` forever, `countNonTerminalInstances` answered 1 for the rest
of the service's life, and a later `stopped → running` resume converged **nothing, on every
tick**, with no error anywhere.

★ **That is the NORMAL path today, not an edge case.** `E9-F002` keeps `workload.service`
unofferable on most fleets, so a service job is typically never leased and every stop takes the
finalize branch. A stop control shipped without this fix would have wedged its own happy path.

The fix reads its mapping **from `decideServiceProjection` itself** for the same attempt status,
so the control-plane path and the worker path cannot drift into two ideas of what a cancelled
attempt means. Four bounds keep it a backstop rather than a licence: the attempt must ALREADY be
terminal and NOT `succeeded` (re-read under the instance's row lock, so a live instance can never
be terminalized — mutant 14); an already-terminal instance is a `noop`, never a refusal on the
happy path; an EMPTY predecessor set REFUSES rather than writing (mutants 11 and 16); and the
write goes through `writeServiceInstanceStatus`, the ONE writer of that column, conditional on
the status read under the lock. No projection receipt is written and that is FORCED rather than
chosen — `job_projection_receipts.source_fence` is `NOT NULL` and this path has no fence, by
definition.

**Not closed by this:** JOB-006's behaviour is unchanged. Any other control-plane path that
terminalizes a service job — SVC-005's TTL stop and budget stop are the named ones — strands its
instance the same way unless it makes the same call. Stated in E9-F006 §4 so it is not
rediscovered a third time.

---

## 5a. ★ THE HANDOFF, ANSWERED IN ITS OWN TERMS — which half is taken and which is not

SVC-002's design closes with an explicit scope-out list, and the generation writer appears in it
**TWICE, in two different bullets, handed to two different tickets**. Read carefully, because the
distinction is the whole answer:

> *"**Pause / drain of a running instance / generation rollout / budget / TTL → SVC-005.** SVC-002
> reads `generation` under a row lock and never bumps it; `services.generation` still has no
> writer after this ticket."*
>
> *"**Create/update/pause/resume/stop controls and any UI → SVC-007.** SVC-002 adds **no routes**.
> There is still no way for a human to create a service; `repos.services.insert` keeps its zero
> production callers. **The reconciler reconciles rows only a test can create.**"*

**TAKEN.** The `service_generations` writer — SVC-007's half, reached through the create control.
`insertServiceGeneration` is the first writer that table has ever had, and it writes generation
**1**, in the same transaction as the `services` row that owns it. That is what makes
`findServiceGenerationDefinition` answer something other than `null` on a real deployment, and it
is what "the reconciler reconciles rows only a test can create" stops being true because of.

**NOT TAKEN, and it was never handed here.** The **`services.generation` BUMP** — SVC-002 hands
that to **SVC-005**, in the bullet whose subject is generation ROLLOUT, alongside pause, drain,
budget and TTL. `updateServiceDesiredState` deliberately does not touch `generation`, and this
unit mints no generation N+1. Taking that half without SVC-005's *"no two generations may perform
external effects simultaneously"* fence would be shipping the overlap E9's acceptance forbids
under the name of an update.

So the answer to *"are you taking it?"* is: **the half addressed to SVC-007, yes; the half
addressed to SVC-005, no** — and the two were never the same half.

---

## 6. Decisions this unit made, and what it refused

* **`update` (generation rollout) is NOT here.** SVC-005's acceptance forbids two generations
  performing external effects simultaneously without a later approved decision, and that fence
  does not exist. A generation writer able to mint N+1 without it would be shipping the overlap
  and calling it an update.
* **`ttlSeconds` and `checkpointArtifactId` are REFUSED at the API and written NULL.** Nothing
  enforces a TTL and nothing restores a checkpoint. Storing either would show an operator a bound
  no code keeps — *a column nothing reads makes a clause vacuously true*, which this epic has
  already filed twice.
* **`deleted` is not a controllable state.** Terminal in the frozen table, and the
  `service_generations` RESTRICT FK makes a service with any generation undeletable, so it is an
  irreversible tombstone. SVC-005.
* **The whole stop is ONE transaction under the service's row lock** — the desired-state write,
  the graceful cancellation and the instance terminalization. The first revision ordered two
  transactions (state first, so a reconciler tick between them could not mint a replacement) and
  §4a(i) records why ordering was not enough. T13 is the rollback probe.
* **The stop still runs on the `unchanged` verdict**, and that survives the single-transaction
  fix for a different reason than the first revision gave: *"already stopped" does not imply
  "nothing is running"* — a reconcile pass that began before an earlier stop can commit an
  instance after that stop moved the column, and without this arm the operator could never reach
  it. Mutant 12 is that property.
* **The desired-state control reuses `lockServiceForReconcile`, and NOT for the reason it looks
  like.** ★ An earlier draft of this result and of the module docstring said SVC-002's design
  "named this control as a writer it interlocks with". **That was a misreading of SVC-002's own
  words and is corrected here.** SVC-002-design.md names SVC-007's control as a CAUTIONARY
  example — one of *"the writers that would forget"* the advisory lock — which is exactly why it
  located the duplicate-placement guarantee in `service_instances_live_service_uq` rather than in
  the lock; and it gives step 2's `FOR UPDATE` a different stated job, *"interlocking with
  SVC-005's generation bump"*. Nothing requires this control to take that lock, and the index
  remains the duplicate-placement authority. It takes it anyway because it performs a
  read-modify-write on `services.desired_state` that a concurrent reconcile pass also reads, and
  on the SAME key because a second helper would serialize against nothing. The compare-and-set on
  the repository write is the belt to that braces, for a future caller that does forget (T12(b)).
* **Clause (d)'s limit is inherited verbatim** from `service-job-config.ts`: "no public
  port/ingress configuration is accepted" governs DECLARATIVE CONFIGURATION and NOT reachability.
  E2B serves arbitrary in-sandbox ports publicly at a URL derivable from the sandbox id, so a
  service that merely LISTENS is reachable with no ingress configuration at all. `args` is not
  scanned for `--port`, for the reason that file gives. **A green refusal test must not be read
  as "services cannot be reached".**

---

## 7. What is still NOT true after this, beyond the gate table

* **No service job has ever been leased in any E9 suite.** SVC-003a said this; it is still true.
  The instance in these tests reaches `pending` and, on a stop, `failed` — driven by the control
  plane, never by a daemon. **"Created, supervised, projected" is NOT proven end to end**, and the
  E9 exit gate is **not claimed**.
* **Create is not idempotent.** `services` has no natural key and no idempotency column, so two
  POSTs create two services. A client-chosen id was considered and REFUSED: `services.id` is a
  GLOBAL primary key, so an "insert, else return the existing row" shape would let one tenant
  probe another tenant's ids. Bounded rather than prevented — the duplicate is visible in the
  list read and stoppable by the control shipped here.
* **Nothing bounds how many services an organization may create.** Spend is bounded downstream by
  the org concurrency cap and budget hard-stop that the reconciler's submission passes through,
  not here.
* **No `activity_log` row is written for a control action** — not by this one and not by the
  JOB-008 mutations beside it. `jobAuditBridge` still has zero production callers; already on the
  register under DE-01. ~~**And it is not merely unwritten, it is currently unwritable from
  here**: `recordAcceptedActivity` requires `fence: ActiveFenceRequest`, and a service create has
  no attempt while a desired-state change has no fence (§4a(iii)).~~ The audit is structured
  logger lines with `action: "service.create"` / `"service.desired_state"`, and the operator's
  `reason` is on the latter. **AGENTS.md's "Activity logging for all mutating actions" invariant
  is NOT met by these routes** — stated, not claimed.

  > ★★★ **SUPERSEDED 2026-09-10 BY `SVC-007b` — `E9-F010`.** The struck sentence is measured
  > false: the fence is `jobAuditBridge`'s requirement, not `activity_log`'s. SVC-007b writes
  > one row per mutating service control INSIDE the mutation's own tenant transaction, over the
  > same `aoa_app` pool, with no fence and no receipt. **So the last sentence above is no longer
  > true of THIS ticket's two mutating routes** — it remains true of the three JOB-008/submission
  > mutations beside them, which is the half that keeps `E9-F010` open. See §4a(iii)'s correction
  > and `service-control-audit.ts`'s header.
* **No `E10-REALTIME-FOUNDATION` claim is made.** SVC-007's Depends-on names it and its Acceptance
  says control actions are *"reflected through durable event catch-up"*. This unit's view is a
  plain read with no realtime channel, so that half of the Acceptance is **not delivered** and the
  gate is not consumed.
* **E9-F002, E9-F003 and E9-F004 are untouched.** No conjunct of any of them moved.

---

## 8. Files

| File | Change |
|---|---|
| `server/src/services/service-management.ts` | new — the definition boundary, the create, the desired-state control and the operator read |
| `server/src/routes/job-control.ts` | four routes on the existing distributed-execution router, behind its existing `assertOrgAdmin` gate — with NO `validate(...)` middleware, so the gate runs before body validation (§4a(ii)) |
| `packages/db/src/repositories/tenant/job-control.ts` | `insertServiceGeneration`, `updateServiceDesiredState`, `findServiceForCompany`, `listServicesForCompany`, `findLiveServiceInstance`, `terminalizeServiceInstanceForCancelledAttempt`, plus `SERVICE_GENERATION_INDEX` and its narrow conflict detector |
| `server/src/__tests__/service-management.test.ts` | new — 18 pure cases |
| `server/src/__tests__/service-management.integration.test.ts` | new — 13 integration cases |
| `server/src/__tests__/job-fence-surface.contract.test.ts` | the six new repository methods CLASSIFIED on the closed method surface — that contract fails closed on any unclassified addition, and it went red on this diff before they were added. One of the six, `terminalizeServiceInstanceForCancelledAttempt`, gets its own paragraph there, because it is a THIRD unguarded entry point onto `writeServiceInstanceStatus` and the four things that stand in for the fence had to be written down. A stale sentence already on that list — *"`recordServiceHealth` stays the sole (and guarded) writer of instance status"*, made false by SVC-003a and invisible to the test because both writers are inner functions — is CORRECTED in the same edit rather than deleted. |
| `docs/replatform/epics/E9-service-agents/findings.md` | E9-F006 filed and resolved |
| `docs/replatform/epics/E9-service-agents/README.md` | SVC-007a's paragraph |
| `scripts/gate-clause-wiring.json` | `E9-4-service-create-and-desired-state`, `wired` |
| `docs/.../tickets/SVC-007a-design.md` | new — terrain + design, because SVC-007 had no files on disk |
| `docs/.../tickets/SVC-007a-result.md` | new — this document |

**Eleven files, and the table above is all eleven** — counted against `git diff --stat` at head
rather than listed from memory.

**No migration.** No schema change was needed: SVC-001 built both tables and granted `aoa_app`
exactly the rights this unit uses (INSERT on `service_generations`; INSERT/UPDATE on `services`).
