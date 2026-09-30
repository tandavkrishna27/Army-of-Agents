# E9 Service agents — findings

Scoped discoveries for E9. Opened 2026-09-08 by SVC-002 design + terrain mapping at `921b2c1f9`,
after adversarial review returned FIX_FIRST on the design and required these to be **filed** rather
than recorded in prose. Both were fully written out in `tickets/SVC-002-terrain.md` §7 item 3; the
filing here is a transcription of that wording plus the verification re-run for the review.

## E9-F001 — `ServiceHealthStatus` still carries `"interrupted"` while the DB CHECK forbids it, and a shipped result document says the edit was made

**Status:** `resolved` 2026-09-10 by **SVC-003a** (`tickets/SVC-003a-result.md`) · **Severity:** MED
**Filed:** 2026-09-08, by SVC-002 terrain mapping (§5.1); re-verified at `921b2c1f9`.
**Affected tickets:** SVC-003 (owned the fix), SVC-001 (source of the false claim).
**Blocks gate:** no. Latent until resolution; it would have gone live the moment SVC-003 wired health,
which is the same commit that closed it.

> **★ CLOSED ON BOTH CONJUNCTS, AND THAT IS THE ONLY WAY IT COULD BE CLOSED.** §3's resolution is a
> conjunction — delete the literal **and** add the missing subset assertion — and half of it is not
> it. Both are in the closing commit: `| "interrupted"` is gone (the type is now derived from a new
> `SERVICE_HEALTH_ASSERTABLE_STATUSES` constant, and the only two `"interrupted"` strings left in the
> tree are inside that constant's own docstring explaining the finding), and
> `server/src/__tests__/service-health-projection.test.ts` carries the reconciliation the finding
> asked for, in both directions, plus a third case pinning that every status the projection can
> actually drive is storable. Observed RED under a mutant that re-adds `"interrupted"` — which is
> literally the base-tree state — killing 2 cases. §3's "do not fix it by widening to all nine" is
> honoured: the domain is FIVE of the nine, with a recorded reason for each of the four omissions,
> and a test that pins the set so a later widening has to be a decision. The
> `scripts/finding-ownership.json` key is deleted in the same commit.

### 1. The contradiction

`packages/db/src/repositories/tenant/job-control.ts:620` still reads:

```ts
export type ServiceHealthStatus = "healthy" | "stopped" | "lost" | "interrupted";
```

It is the **only** `"interrupted"` literal left in `server/src` + `packages/` — verified by
`grep -rn '"interrupted"' server/src packages/*/src`, which returns that one line and nothing else.

Migration `0264` narrowed `service_instances_status_check` to the frozen nine, which exclude
`interrupted`. So `recordServiceHealth({ healthStatus: "interrupted" })` **typechecks and fails at
runtime** with a `23514` CHECK violation, where before SVC-001 it succeeded. The type is also far
narrower than the nine in the other direction — `pending`, `leased`, `starting`, `unhealthy`,
`stopping` and `failed` cannot be expressed at all — and `recordServiceHealth` (`:3181-3189`) is the
only UPDATE path to `service_instances.status` that exists.

### 2. ★ The false self-claim, which is the half that generalises

`SVC-001-design.md` §3.2 CORRECTION 6a instructed *"narrow the edit to removing `interrupted`
only"*. `SVC-001-result.md:192` records it as done:

> *"**`ServiceHealthStatus`** narrowed to *removing* `interrupted` only; widening it would take
> SVC-003's scope on a governed fence mutator."*

**The edit did not happen, and CI was green.** A shipped, dated result document asserts a code change
that is not in the tree. That is a recurring class in this programme, not a one-off: a release gate
claiming a deviation was *"stated in `--list`"* when it never was, and a CLI header narrating a
predicate the code no longer had — twice. The common shape is a **document narrating its own diff**
with nothing comparing the narration to the diff.

**Not corrected in place, deliberately.** `docs/replatform/artifact-policy.md` freezes a `complete`
result: *"a later correction creates a finding and a new ticket/result rather than rewriting approved
evidence."* A dated result document is a measurement. Rewriting it would destroy the record that the
claim was ever made, which is the only durable evidence of the class. This finding is the amendment:
it states what was claimed and what is actually there.

### 3. Why `unowned`, and what would close it

`unowned` because the narrowing edit is SVC-003's by `SVC-001-design.md` §3.2 CORRECTION 6a — it
touches a governed fence mutator's input domain — and **SVC-003 has zero files on disk**, so naming
it as owner would red `owner_ticket_missing` and would be the false-ownership claim E4-F013 exists to
refuse. NOT `accepted`: a shipped result document that misreports its own diff is not something to
accept.

**Resolution.** Delete `| "interrupted"` at `tenant/job-control.ts:620` **and** add the missing
subset assertion against the frozen `SERVICE_INSTANCE_STATUSES`, or the same drift recurs. **Do not
fix it by widening the type to all nine** — that expands a governed fence mutator's input domain,
which CORRECTION 6a reserved for SVC-003. Then flip this Status and DELETE the
`scripts/finding-ownership.json` key in the SAME commit.

## E9-F002 — no worker can ever be offered a service job: the daemon's capability intersection removes `workload.service` before placement ever sees it

**Status:** `open`, **NARROWED** 2026-09-09 by SVC-008b (see §1.6) · **Severity:** HIGH
**Owner:** **`unowned`** as of 2026-09-09 — SVC-008 shipped both halves and an open finding owned by
shipped work is owned by nothing (E4-F013). The natural inheritor is **SVC-003**, which has a node in
`program-design.md` but **no ticket file on disk**, so it cannot be named as a `successor` without
failing the guard's existence bar. Declared rather than hidden; see §1.6 and
`scripts/finding-ownership.json`. (Previously: **SVC-008**, `tickets/SVC-008-design.md`, repointed
2026-09-09 — see §4.)
**Filed:** 2026-09-08, by SVC-002 terrain mapping (§2) and re-verified line-by-line for the design's
adversarial review. **Amended 2026-09-09** with §1.5: the capability constant is the *smallest* of
**five** blockers, and the other four were not in this register. (§1.5 items 4-5 were added the same
day by external review of the SVC-008 design; the first amendment named three.)
**Affected tickets:** SVC-002 through SVC-007 (all of E9's dispatch half), DE-12.
**Blocks gate:** yes for any E9 clause asserting a service is dispatched, leased or run.

### 1. The chain, verified at `921b2c1f9`

1. `packages/worker-daemon/src/enrollment/hello-provisioning.ts:27` —
   `SUPERVISABLE_WORKLOAD_CAPABILITIES: readonly WorkerCapability[] = ["workload.batch"]`. Its
   docstring: *"Batch only — the supervisor for browser_session/service composes in later sprints,
   and D4 forbids reporting a workload the daemon cannot run."*
2. `deriveHelloProvisioning` (`:44-50`) builds `deviceCanProvide` from that constant plus
   `capabilitiesForIsolation`, then **intersects**:
   `reportedCapabilities = parsed.data.capabilityCeiling.filter((cap) => deviceCanProvide.has(cap))`.
   **Widening the admin ceiling alone therefore changes nothing** — the intersection removes
   `workload.service` regardless.
3. Placement demands it unconditionally: `workload.${input.workloadType}` at
   `server/src/services/job-placement.ts:177`, returned in the required set (`:190`). A free
   `serviceSlots` is additionally required (`packages/worker-protocol/src/capabilities.ts:528-530`),
   but that is not the binding constraint.

Pinned by `server/src/__tests__/u0-d1-placement-reachability.test.ts:324`, which asserts the constant
equals `["workload.batch"]` so the conclusion cannot go stale unnoticed.

### 1.5 ★★★ AMENDMENT (2026-09-09) — the constant is the smallest of FIVE blockers

Measured at `afebb0e51` while designing SVC-008. Closing §1 alone would make service dispatch
reachable and structurally broken, which is worse than the current inert state.

1. **Mis-supervision that looks like success.** `createSpecFor`
   (`packages/worker-daemon/src/supervisor/supervisor.ts:328-334`) reads only `workload.command` /
   `args`, which `serviceWorkloadV1Schema` also has (`worker-protocol/src/job.ts:316-317`). So a
   service dispatched today runs the **batch** body — `execute` blocking, raced to a deadline
   (`:717-729`) — and emits a batch-shaped `terminal` (`:792-795`). Nothing branches on
   `workloadType` outside the poll loop's concurrency class (`poll/poll-loop.ts:541-542`).
2. **The run budget is wrong by construction and its ceiling is four minutes.**
   `resolveRunOpDeadlineMs` (`lifecycle/run-op-deadline.ts:56-68`) reads
   `workload.maxRuntimeSeconds`; `batchWorkloadV1Schema` has it (`job.ts:294`),
   `serviceWorkloadV1Schema` does **not**. A service falls to `RUN_OP_DEADLINE_FLOOR_MS = 60_000`
   and the sandbox is born with a 60-second TTL (`sandbox-e2b-provider/src/e2b-provider.ts:291,319-327`).
   The ceiling is `RUN_OP_DEADLINE_CEILING_MS = 240_000` (`run-op-deadline.ts:36-46`).
3. **★ The effect authority expires after five minutes and is never re-minted.** The owned-labels
   capability is `min(now + 5 min, leaseDeadline)` (`server/src/services/owned-labels-mint.ts:46,92`)
   and is minted on exactly one route, `/worker-control/execution-secrets/resolve`
   (`server/src/routes/worker-control.ts:709`, applied `:764-765`) — **not** on
   `/leases/:leaseId/renew` (`:511`). The supervisor already documents the consequence at
   `supervisor.ts:794-806` and answers it with `recordOrphan(run, "cap_expired_before_happy_destroy")`.
   **So on the sandbox lane every service run longer than five minutes ends with a billable orphaned
   sandbox the worker cannot tear down.** And it cannot be papered over at create time: `setTimeout`
   is called only from `create` (`e2b-provider.ts:326-327`) and the frozen provider port
   (`worker-daemon/src/supervisor/provider.ts:385-404`) has **no TTL-extension operation**.

4. **★★★ Nothing on the provider port can witness that a process STARTED.**
   `SandboxProvider.execute` (`worker-daemon/src/supervisor/provider.ts:395`) returns a
   **completion** — `exitCode`/`signal`/`timedOut` — with no launch acknowledgement and no process
   handle, and `RealE2bTransport.runCommand` (`sandbox-e2b-provider/src/real-transport.ts:107-175`)
   settles only when the command exits (its own comment at `:128-131` records that
   `sandbox.commands.run()` is `start()` then `CommandHandle.wait()`). The two ops that could stand
   in describe the **sandbox**, not the command: `inspect` → `getInfo` (`e2b-provider.ts:436-448`)
   and `health` → `sandbox.isRunning()` (`:597-601`, `real-transport.ts:263-270`), both of which
   answer "up" from the moment `create` resolves. **So a failed or hung launch would be durably
   recorded as `service_instance_started` and then as an unbroken stream of `service_health:
   healthy` — mis-supervision that reads as success, which is (1) with more confidence.**
5. **★★★ There is no stop primitive, so `gracefulStopSeconds` cannot be honoured.**
   `RealE2bTransport.signal` (`real-transport.ts:177-187`) **ignores `_kind`**, performs a `getInfo`,
   and returns `{delivered: true}` on both branches including the catch. `E2bSandboxProvider.cancel`
   and `.kill` (`e2b-provider.ts:378-386`) are therefore the same read, and the first actual
   termination on this lane is `terminate` inside `destroy` (`:388-393`). A cancel→wait→kill ladder
   would emit `service_instance_stopped` while the command is still running and then hard-kill the
   sandbox in cleanup. ★ **This is already live for batch:** `CleanupAuthority.#convergeOne`
   (`worker-daemon/src/supervisor/cleanup-authority.ts:279-290`) escalates to `kill` only when
   `cancel.outcome === "ignored"`, which real E2B never returns, so the ladder's `kill` rung is
   structurally unreachable on the real provider — and it is masked by `MockE2bTransport.signal`
   (`mock-transport.ts:140-147`), which **does** honour `kind` and **is therefore more capable than
   production**. Batch survives it (the unconditional `destroy` reclaims anyway), so it is a
   fabricated outcome value and a dead rung rather than a leak. **It belongs in E4/CLI's register,
   not this one** — SVC-008 design §10 records who should file it.

(3) is the binding one for **runtime**; (4) and (5) are the binding ones for **honesty**, and unlike
(1)-(3) they cannot be fixed daemon-side at all. (3) is an **effect-authority** question, recorded
unresolved as SVC-008 design §9.1. (4) and (5) require a **provider-port primitive** —
`startProcess`/`processStatus`/`signalProcess` behind a `processSupervisionMode` field, following the
non-frozen `stageFiles`/`artifactExport` precedent so no wire change is needed — specified as SVC-008
design §3.4 and left open as §9.5. **The wire being ready does not help if the provider cannot
produce what the events assert**, and SVC-008 design §11 restates its conclusion around that: no
Protocol Custodian STOP, but a provider change IS required, and the provider half is the larger unit
and belongs to E4/CLI.

**★ AMENDMENT (2026-09-09) — the provider half is now a written ticket.**
**[SVC-008a](tickets/SVC-008a-design.md)** turns SVC-008 §3.4 into a standalone design: the
`startProcess`/`processStatus`/`signalProcess` trio behind a locally-defined `processSupervisionMode`
(the verified `stageFiles`/`artifactExport` non-frozen precedent, `provider.ts:408`, `:433`, `:437`,
`:460`), every implementer, and a conformance test with both arms. **Blockers (4) and (5) of §1.5 are
SVC-008a's; (1), (2) and the consumption of (5) are SVC-008b's** — the daemon supervisor and the
constant widening, which remain everything else in `SVC-008-design.md`. **(3) — the never-re-minted
effect authority — is SVC-008b's**, and stays open as its `SVC-008-design.md` §9.1.

★ **Correction (2026-09-09, review).** An earlier draft of this amendment said blocker (3) was
"owned by neither", which contradicted this finding's unchanged `SVC-008` owner and
`scripts/finding-ownership.json`'s reason that SVC-008 owns E9-F002 end to end. It was also simply
wrong on its own terms: **SVC-008b *is* everything else in `SVC-008-design.md`**, and §9.1 is in
that document — so (3) was never outside the split, only unlisted in it. The split partitions all
five blockers; nothing is unowned and **no manifest change is implied.**

Two things SVC-008a establishes that this finding did not. **(i) The root cause of (5) is a TYPE:**
`StopOutcome` (`worker-daemon/src/supervisor/provider.ts:146`) has no inhabitant for "I witnessed
nothing", so a provider that cannot observe is forced into an affirmative claim. **(ii) The fix
splits**, and only one half depends on the unverified E2B SDK question — the verdict repair reads a
record the current code already fetches and discards, so it needs no new provider capability at all.
**If the SDK cannot express a detached handle, that is the finding** (SVC-008a §9.1) and SVC-008b
falls to its §3.4 fallback, which SVC-008 §5.1 clause 5 says does not earn the widening.

**This finding's Status, Severity and Owner are unchanged.** It is still `open`, still HIGH, still
owned by `SVC-008` — SVC-008a resolves for it to be *possible*, not for it to be *done*, and the
resolution criterion is still T0: a service job observed leased by a real daemon.

### 1.6 ★★★ NARROWED (2026-09-09) — SVC-008b landed; four of five blockers are closed and the finding STAYS OPEN on the fifth

**★★★ READ THIS FIRST: THIS IS NOT A CLOSURE, AND AN EARLIER DRAFT OF THIS SECTION WAS WRITTEN AS
ONE.** `scripts/finding-ownership.json`'s entry for E9-F002 states the resolve criterion as a
**conjunction**: *"SVC-008's T0 green on a shipped daemon (a service job observed leased) **AND**
blocker (3) answered rather than deferred, OR E9's acceptance language amended…"*. T0 is green.
Blocker (3) is **bounded, not answered** — SVC-008 §9.1 is still unruled — and E9's acceptance
language is unamended. So neither disjunct holds, and flipping the status would be exactly the
defect `gate-clause-wiring.json`'s own `$comment` records from earlier the same day: *"A CLAUSE IS
THE UNIT OF CLAIM, AND HALF A CONJUNCTIVE CLAUSE MAY NOT BE ENROLLED."* The finding stays `open`
and its ownership entry stays in the manifest. What follows is what changed, per blocker.

The half that IS met is met **mechanically**, not by assertion.
`server/src/__tests__/u0-d1-placement-reachability.test.ts` runs the **shipped daemon's derived
hello** (via `deriveHelloProvisioning` + `buildDesktopHello`, the same calls
`bin/worker-daemon.ts` makes) against **D1's committed `worker-b` profile** through the **real**
`evaluateStaticLeaseEligibility`, and a `service` job now returns `eligible: true` with a null
reason code. Reverting the constant reds that case and the exact-equality pin, while both batch
cases stay green.

Per blocker, stated so no reader has to infer which are actually gone:

| # | Blocker | State | Where |
|---|---|---|---|
| §1 | the capability intersection removes `workload.service` | **CLOSED** | `SUPERVISABLE_WORKLOAD_CAPABILITIES` is `["workload.batch", "workload.service"]`; the pin at `u0-d1-placement-reachability.test.ts` is UPDATED to exact-equality on the new pair, deliberately not weakened to `toContain` |
| §1.5(1) | mis-supervision that looks like success | **CLOSED** | `runLifecycle` dispatches `workloadType === "service"` to `runServiceLifecycle` (`supervisor/service-lifecycle.ts`) BEFORE `execute`; T1 asserts `execute` is never called on a service run |
| §1.5(2) | the 60 s budget floor | **CLOSED** | `resolveRunOpDeadlineMs` gains a service arm returning the 240 s ceiling. ★ WITNESSED, and it was not at first: `dispatch-runtime.test.ts`'s pure-resolver block asserts the ceiling for a handoff typed `workloadType: "service"` carrying a service workload with no runtime field, AND the 60 s floor for that same workload untyped — neutralising the arm (`&& false`) reds it. Before that pair the arm had ZERO coverage and the whole 154-file / 1020-test worker-daemon suite stayed green with it dead, i.e. this row read CLOSED on an unwitnessed branch. ★ It does NOT use §3.3's stated source: `maxContinuousRuntimeSeconds` is measured absent from the worker side of the wire (the envelope carries a provider-constraint *reference*), so the profile clamp could not be applied and the deviation is recorded at the call site |
| §1.5(3) | the effect authority expires and is never re-minted | **BOUNDED, NOT FIXED** | The supervise loop stops on `capExpiresAt - RUN_TEARDOWN_HEADROOM_MS` and tears down under a valid cap, so no service run orphans a billable sandbox (T6, on the imported constants). What is NOT done is re-minting: SVC-008 §9.1 is UNRULED and the scheduled-re-materialization option would re-run a secret resolution on a timer. **The consequence is a 240-second service.** |
| §1.5(4) | nothing can witness a launch | **CLOSED by SVC-008a, CONSUMED here** | `startProcess` is the launch witness; no handle ⇒ no `service_instance_started` (T4) |
| §1.5(5) | no stop primitive | **CLOSED by SVC-008a, CONSUMED here** | The ladder derives its verdict from `ProcessSignalResult.observation`, never from `accepted`; a process that survives cancel AND kill is `service_instance_lost`, never `_stopped` (T3) |

**★ TWO ZERO-CALLER CLAUSES BECAME REAL, and they are named because a zero-caller function makes
its clause vacuously true.** SVC-008a shipped `EffectAuthority.startProcess`/`.processStatus`/
`.signalProcess` and `deriveStopVerdict` with its own disclosure that they had **zero production
callers** and that "SVC-008b's service loop is the consumer". Measured with the register's own
`countProductionCallers`, before/after: `startProcess` 10→11, `processStatus` 15→16,
`signalProcess` 10→11, and **`deriveStopVerdict` 0→2** — SVC-008b is its first production consumer.

**★ WHAT IS STILL NOT TRUE AFTER THIS.** A daemon can be offered a service job and will supervise
one; nothing yet *creates* one. SVC-008b adds **no consumer** of `recordServiceHealth` and no
`service_health` projection — its `countProductionCallers` reading is **2 at base and 2 at head**,
unchanged by this diff. (An earlier draft of this line said it "keeps its zero production callers";
that number was false against the very instrument cited two paragraphs above, which counts the
declaration and the implementation. The substance — no new consumer — is what the clause needs.)
Ingest is generic (`toAcceptInputs` durably appends any event type and sets `terminalStatus` only for
`terminal`), so every `service_health` / `_started` / `_stopped` / `_lost` emitted here is durably
stored and **projects no state change**. Wiring that projection is SVC-003's, because deciding what
a health event means for ownership is SVC-003's Outcome. Restart/checkpoint are SVC-004's; drain and
generation are SVC-005's; a human path is SVC-007's.

**WHAT WOULD CLOSE THIS FINDING, unchanged from the manifest and restated so nobody has to
reconstruct it:** blocker §1.5(3) answered rather than bounded — a ruling on SVC-008 §9.1 (re-mint
on the tick, re-mint on lease renewal, or accept the ceiling) — **or** E9's acceptance language
amended to say a service is dispatchable only within the effect-authority window, with DE-12's
`deliveryEvidence` corrected to carry that reason. Until one of those, a "service" on this fleet is
a four-minute service, and that sentence is the finding.

**★ AND IT IS NOW `unowned`, which is a downgrade in accountability, said out loud.** SVC-008 owned
this end to end; SVC-008 has shipped. §9.1 option (b) — a fresh capability minted on
`/leases/:leaseId/renew` — is a **server** change on the renew route that SVC-008 §9.1 itself says is
*"not SVC-008's to make"*, and option (a) is an unruled security question. The inheritor that fits is
**SVC-003** (`program-design.md` §SVC-003, "Long-session lease and health semantics"), whose Outcome
is the lease/ownership authority question — but SVC-003 has **no file** under
`docs/replatform/epics/*/tickets/`, and the guard holds `successor` to the same existence bar as
`ticket`. Naming SVC-002 instead (which *does* have a file) to get past that check would be exactly
the register-accuracy defect the guard exists to prevent. **What blocks:** any E9/D4 clause asserting
a *long-running* service, and the 72-hour D4 continuity canary specifically — it cannot be run
against a 240-second service. It no longer blocks service **dispatch** or **supervision**. When
SVC-003 gets a ticket file, flip this back to `owned` and name it.

### 2. Consequence, and why it is filed at HIGH

A reconciler built to `SVC-002-design.md` **creates jobs that can never be placed or leased**. The
placement outcome is `queued` / `no_eligible_target` (`job-placement.ts:642-654`), not a failure, so
nothing errors and nothing alerts: every reconciled service accumulates one `queued` job and one
`pending` instance forever. `GO-BOOK.md:1763-1769` already records the sequencing —
*"enabling `workload.service` dispatch is a prerequisite step before health/restart/drain, not a
given"* — but no register carried it as a finding, and it is additionally **a third and unrecorded
reason DE-12's control cannot fire** (`docs/architecture/distributed-execution-audit-debt.json`
records two).

### 3. Why it was `unowned`, and what would close it

It was `unowned` because the change is a worker-daemon one — widen the constant **and** compose the
service supervisor the daemon does not have — and **no ticket on disk carried it**. SVC-002 through
SVC-007 are control-plane tickets; naming any of them would have been false ownership. HIGH may never
be `accepted` and is not being accepted.

**Resolution.** A daemon advertises `workload.service` and a service job is observed leased **or**
E9's acceptance language is amended to say no service is dispatchable and DE-12's `deliveryEvidence`
is corrected to carry this third reason. Then flip this Status and DELETE the
`scripts/finding-ownership.json` key in the SAME commit.

### 4. Ownership (2026-09-09) — repointed to SVC-008, and the finding stays OPEN

**SVC-008** (`tickets/SVC-008-design.md` + a `#### SVC-008` node in `docs/replatform/program-design.md`)
is filed as E9's only daemon-side ticket and owns this finding. It designs the service lifecycle, the
budget derivation, the four-clause safety condition for widening the constant, and the reachability
test — including what happens to the negative pin at `u0-d1-placement-reachability.test.ts:324`
(updated to an exact-equality pin over both workloads, **not** deleted and **not** weakened to
`toContain`).

**The Status stays `open`, deliberately.** SVC-008 is a *design*; its own resolution criterion —
a service job **observed leased** by a real daemon — is its T0, which the design plans and does not
run. Flipping this finding on a design document would be the "document narrating its own diff"
failure that E9-F001 exists to record. It closes when T0 is green on a shipped daemon, and blocker
(3) of §1.5 is answered rather than deferred.

## E9-F003 — a `service_reconcile` job's executor principal is the SERVICE id under the kind `service_instance`, and that mislabel reaches the worker's lease envelope

**Status:** `open` · **Severity:** MED · **Owner:** `unowned`
**Filed:** 2026-09-10, by the SVC-002 implementation unit, after external review of PR #406
raised it against the shipped reconciler. Recorded in prose since 2026-09-08
(`tickets/SVC-002-terrain.md` §5.4) and **never filed** — which is the weak form this programme
keeps re-learning, so it is filed now.
**Affected tickets:** SVC-003 (the natural inheritor, no file on disk), SVC-002 (first producer).
**Blocks gate:** no for dispatch; yes for any clause asserting that a job is attributable to a
service INSTANCE from the job side.

### 1. The mislabel, verified at `ca5089663`

`serviceSourceIsAdmitted` (`packages/db/src/repositories/tenant/job-control.ts`) selects `id` from
**`services`** and returns it as `{ kind: "service_instance", id: row.id }`. That value becomes
`jobs.executor_principal_kind` / `executor_principal_id`, whose kind column is unconstrained `text`
with no CHECK (`packages/db/src/schema/jobs.ts:54`), so nothing refuses it.

**It does not stop at the row.** `job-leasing.ts`'s `principal()` maps
`kind === "service_instance"` to `principalType: "service"`, and the `service_reconcile` arm of
`source()` puts that `defaultExecutor` into the lease envelope's `executionPrincipal`. So a worker
receives an envelope whose `executionPrincipal.principalId` is the **service** id while the same
envelope's `serviceWorkloadV1` carries a **different** UUID in `serviceInstanceId`. Nothing
reconciles the two, and nothing today reads `executor_principal_id` expecting an instance
(`execution-secret-handle-mint-runner` reads it only for `agent`; `job-fence.ts`'s
`ownerPrincipalId` comparison is self-consistent with whatever was minted), so the consequence
today is a **mislabel**, not a broken flow. It becomes load-bearing the moment SVC-003 fences or
attributes anything instance-scoped from the job side.

### 2. Why SVC-002 did not fix it, and why the obvious fix is worse

The reviewer's proposed repair — *"pass the created instance identity through the admission path
and persist it as the executor principal"* — is not available to SVC-002:

1. **`serviceReconcileSourceSchema` carries no `serviceInstanceId`**
   (`packages/worker-protocol/src/source.ts`). Adding it is a **frozen wire change and a Protocol
   Custodian STOP**, recorded unresolved as `SVC-002-design.md` §10.2, which says a custodian
   should rule because SVC-003's fence work will face the same question with less freedom.
2. **Reading the instance id off the workload instead would be strictly worse.** That field is
   caller-controlled and validated against nothing (`stampServiceIdentity` covers `serviceId` and
   `generation` only, and says so). Promoting an unauthorized caller-supplied value into a
   persisted principal id turns a mislabel into an authorization defect.

**What SVC-002 did deliver instead, and it is a different guarantee:** `service_instances.job_id`
and `.attempt_id` (migration 0275), written in the same transaction, correlate the instance with
the job **from the instance side**. That is the attribution SVC-003 needs for its own rows. What
remains missing is the job-side and envelope-side identity, which is this finding.

### 2a. ★ 2026-09-10 — SVC-003a consumed that attribution, and the finding is NOT closed by it

SVC-003a (`tickets/SVC-003a-result.md`) built the projection §1's last sentence anticipated, and it
resolves the instance **exactly** the way §2 says it must: from `service_instances.job_id`/
`.attempt_id`, never from the envelope's `executionPrincipal` and never from the workload's
caller-controlled `serviceInstanceId`. The payload's instance id is treated as a CLAIM that must
match the attributed row, and a mismatch is refused (`identity_mismatch`, pinned by T4 and killed by
a mutant that drops the comparison).

**That narrows the blast radius; it does not close the finding, and the difference matters.** What
SVC-003a proves is that ONE consumer does not depend on the mislabel. The mislabel itself is
unchanged: `jobs.executor_principal_id` for a `service_reconcile` job still holds a **service** id
under the kind `service_instance`, and the lease envelope still carries it. Any future reader that
takes `executionPrincipal.principalId` for an instance id is still wrong, and the fix is still
either the frozen-wire ruling of §2(1) or a redefinition of what that column means for this source
kind — neither of which SVC-003a made. **Status stays `open`; owner stays `unowned`** (SVC-003a is
shipped, and an open finding owned by shipped work is owned by nothing — E4-F013).

### 3. Why `unowned`, and what would close it

`unowned` because the fix is either a frozen-wire ruling or a change to what
`executor_principal_id` means for this source kind, and the ticket that owns instance identity and
fencing is **SVC-003**, which has a node in `program-design.md` and **no file** under
`docs/replatform/epics/*/tickets/`. Naming it would fail the guard's existence bar; naming SVC-002
(which does have a file) to get past that check would be exactly the register-accuracy defect the
guard exists to prevent — SVC-002 shipped and cannot make a custodian ruling. Not `accepted`: an
identity field that names the wrong entity is not something to accept.

**Resolution.** A Protocol Custodian ruling on `SVC-002-design.md` §10.2 — either add
`serviceInstanceId` to `serviceReconcileSourceSchema` so admission can authorize and stamp it, or
rule that the executor principal for `service_reconcile` is deliberately the SERVICE and rename the
kind from `service_instance` to `service` so the label stops lying. Either way the lease envelope's
`executionPrincipal` and the workload's `serviceInstanceId` must agree or be documented as
different things on purpose. Then flip this Status and DELETE the
`scripts/finding-ownership.json` key in the SAME commit.


## E9-F004 — the frozen lifecycle makes `stopping` the sole predecessor of `stopped`, and NO frozen worker event can assert `stopping`

**Status:** `open` · **Severity:** MED · **Owner:** `unowned`
**Filed:** 2026-09-10, by SVC-003a, after external review of PR #410 caught the consequence in the
shipped diff. **Found by ARMING a symbol that had zero production callers** — the gap had existed
since the table was frozen and nothing could see it, because nothing consumed the table.
**Affected tickets:** SVC-005 (owns the stop-request side and is the natural place for a `stopping`
writer), SVC-003 (first consumer), SVC-008 (the emitter side).
**Blocks gate:** no — SVC-003a works around it. Yes for any clause asserting the instance lifecycle
is traversed edge-by-edge as the frozen table models it.

### 1. The contradiction, verified at `6b39c77f6`

`SERVICE_INSTANCE_TRANSITIONS` (`packages/worker-protocol/src/states.ts`) gives `stopped` exactly
one predecessor:

```
  starting:  [... "stopping" ...]      healthy: [... "stopping" ...]
  unhealthy: [... "stopping" ...]      leased:  [... "stopping" ...]
  stopping:  ["stopped", "failed", "lost"]
```

**No frozen worker event can assert `stopping`.** The five service events are
`service_instance_started` (`starting`), `service_health` (`healthy`/`unhealthy`),
`service_instance_stopped`, `service_instance_lost`, and `service_graceful_stop_observed` — whose
payload is `{ref, deadline}` and which observes a REQUEST, so projecting a process fact from it is
the E7-F034 fail-open SVC-008a exists to refuse. And the shipped supervisor does not pass through
it either: in `packages/worker-daemon/src/supervisor/service-lifecycle.ts`, `runServiceLifecycle`'s
`case "process_exited"` arm (~:293) emits `service_instance_stopped` directly on an observed
`exited`/`gone` — **from `healthy`** — and `gracefulStop`'s `verdict === "stopped"` branch (~:362)
does the same after the graceful ladder.

### 2. What it cost, and why it was invisible

SVC-003a's first revision derived its legality predicate as the DIRECT edges of the frozen table.
Under that derivation **every normal service stop** was refused as `illegal_transition`: the
instance stayed `healthy` inside `service_instances_live_service_uq`, so SVC-002's reconciler could
never replace it — a permanent wedge, and the exact opposite of the ticket's purpose.

**It passed a suite with a named positive control and thirteen killed mutants.** The end-to-end
case drove `service_instance_lost`, which the frozen table makes reachable from every non-terminal
status, so the one status with an unreachable predecessor was the one status never driven. *A
lifecycle table proven over the transitions a suite happens to exercise is not proven over the
table.*

### 3. The workaround SVC-003a shipped, and the residual it leaves

`predecessorsOf` admits every status from which the target is reachable by a legal path whose every
INTERMEDIATE step is a status no event can project (`pending`, `stopping`). In one sentence: *a
worker may skip only the states it cannot witness.* The safety property is untouched at any path
length — the three terminals have no outgoing edges, so no path leaves one and none is ever a
predecessor.

**The residual is real and is why this stays open.** `stopped` is now admitted from `leased` as
well as from the live states, which is wider than the frozen table permits in one hop. The
projection cannot distinguish "skipped `stopping` because nothing writes it" from "skipped
`starting` and `healthy` too", so a service that never started can be reported `stopped`. Nothing
downstream depends on that distinction today; SVC-004's restart policy might.

### 4. What would close it

Either (a) **SVC-005 writes `stopping`** when it issues the graceful stop — a control-plane write
from the request side, which is legitimate because the request IS the control plane's own fact,
unlike a worker asserting it; or (b) a **frozen-table amendment** removing `stopping` from the
`stopped` path, which is a v1 wire change and a Protocol Custodian call. `unowned` because SVC-005
has **no file on disk** and naming it would fail the guard's existence bar (E4-F013). Not
`accepted`: a lifecycle model with an unassertable mandatory state is not something to accept.

## E9-F005 — the daemon emits an attempt terminal with NO service event on the no-handle path, stranding the instance

**Status:** `resolved` 2026-09-10 by **SVC-003a** (`tickets/SVC-003a-result.md`) · **Severity:** MED
**Filed:** 2026-09-10, by SVC-003a, after external review of PR #410. Filed although it is resolved
in the same commit, because the DAEMON behaviour is unchanged and SVC-004's restart policy will meet
it again.
**Affected tickets:** SVC-003 (resolved it), SVC-004 (restart policy), SVC-008 (the emitter).
**Blocks gate:** no.

### 1. The path

`runServiceLifecycle`'s §4.2a launch comment, in
`packages/worker-daemon/src/supervisor/service-lifecycle.ts` (~:166), says it in its own words:

> *"No handle ⇒ NO `service_instance_started`. The instance never leaves `leased` and the attempt
> fails."*

So a launch whose `startProcess` throws — and a workload rejected before the supervise loop — emits
`attempt_started` and then a failed `terminal`, with **no service event at all**. The attempt is
terminal while the instance sits `leased` (or `pending`, if `attempt_started` never landed either)
**inside** `service_instances_live_service_uq`, where SVC-002's reconciler can never replace it. It
is E9-F004's permanent wedge reached through a different door, and SVC-008b's own accounting —
*"emits exactly one of `service_instance_stopped` / `service_instance_lost` before the attempt
`terminal`"* — is true only of the paths that got that far.

### 2. How SVC-003a resolved it, and the bound it carries

A **non-succeeded** attempt `terminal` drives the instance to `failed`. Three bounds keep it a
backstop rather than a second opinion: a `succeeded` terminal projects nothing (the service already
emitted `_stopped`, and re-asserting would be the projection overruling an observation); it carries
no claim, so the target is fixed by (job, attempt) attribution; and it is the ONLY projection with
`whenAlreadyTerminal: "noop"`, so on the normal path — where the instance is already terminal — it
is a no-op rather than a refusal on the happy path of every service run. Every service event keeps
`"refuse"`, so the split-brain refusal is untouched; a mutant that flips that default reds the
split-brain case.

**Left for SVC-004:** `failed` is the honest instance status for a run that ended badly, but WHETHER
such an instance should be restarted, and with what backoff, is SVC-004's crash-loop clause. SVC-003a
has no opinion about it.

## E9-F006 — a cancellation that FINALIZES rather than drains emits no worker event, so SVC-003a's attempt-terminal backstop cannot fire and the instance is stranded

**Status:** `resolved` 2026-09-10 by **SVC-007a** (`tickets/SVC-007a-result.md`) · **Severity:** MED
**Filed:** 2026-09-10, by SVC-007a, while building the stop control. Filed although it is resolved in
the same commit, because the JOB-006 behaviour that causes it is unchanged and every future
control-plane terminalizer meets it again.
**Affected tickets:** SVC-007 (resolved it), SVC-003 (owns the worker-side half), SVC-005 (TTL and
budget stop will terminalize the same way), JOB-006 (the cancellation branch).
**Blocks gate:** no — but it would have wedged the stop/resume loop of the ticket that found it.

> ★★★ **ID COLLISION WITH A CONCURRENT BRANCH — RULED, AND THE RULING IS APPLIED.** PR **#413**
> (`svc-003b-liveness`, SVC-003b's liveness deadline) filed THREE findings against the same base
> and numbered the first of them **`E9-F006`** — a DIFFERENT defect with the same id. The two
> branches were independent and neither could see the other's register, so `check-register-id-
> uniqueness` was green on each alone and would have gone **RED on whichever merged second** —
> the guard doing exactly its job, a detectable blocking failure rather than a silent one.
> **Ruled by first-filed order: PR #412 (this one, opened 06:11:11Z) KEEPS `E9-F006`; PR #413
> (opened 06:29:51Z) RENUMBERED its three to `E9-F007`, `E9-F008` and `E9-F009` — order and
> content unchanged.** #413 applied that renumber in the commit that merged this base, so the
> registers no longer overlap and no waiver is needed. #413's commit messages from before that
> merge still say `E9-F006`; that is history, and the register at head is the authority.

### 1. The path, verified at `053f90fc8` plus this diff

`repos.jobControl.requestCancellation` has a branch — `if (!lease || !attempt || !lease.workerId ||
!lease.attemptNumber)`, `packages/db/src/repositories/tenant/job-control.ts` (~:4465 at head) —
whose own comment says why it exists:

> *"No fenced worker to drain: the reaper's expired-lease scan never reaches an unleased attempt …
> Finalize the cancellation DIRECTLY."*

It drives the attempt and the job to `cancelled` under the locks it already holds. **No worker event
is emitted, because there is no worker.**

SVC-003a's attempt-terminal backstop lives in `decideServiceProjection`'s `terminal` arm
(`server/src/services/service-health-projection.ts` ~:216) and fires only from an INGESTED event. On
this branch it never runs. So `service_instances.status` stays `pending`, the row stays inside
`service_instances_live_service_uq`, and `countNonTerminalInstances` answers 1 forever.

### 2. What that costs, and why it is not theoretical

SVC-002's reconciler short-circuits on the observed state — `if (live >= 1) return { action:
"none", reason: "instance_present" }` (`server/src/services/service-reconciler.ts` ~:211). So after
a stop, a later `stopped → running` resume converges **nothing, on every tick, for the rest of the
service's life**. The operator sees `desired_state = 'running'` and no instance, with no error
anywhere.

This is the E9-F004/E9-F005 wedge reached through the control plane instead of the daemon, and it is
on the happy path of the stop control SVC-007a ships — not an edge case. It is also the **normal**
path today rather than a rare one: `E9-F002` keeps `workload.service` unofferable on most fleets, so
a service job is typically never leased, and every stop takes the finalize branch.

### 3. How SVC-007a resolved it

`setServiceDesiredState` calls a new
`repos.jobControl.terminalizeServiceInstanceForCancelledAttempt` after the cancellation, deriving
`toStatus` and `allowedFromStatuses` from **`decideServiceProjection` itself**, for the same attempt
status (`cancelled`) — so the control-plane path and the worker path cannot drift into two ideas of
what a cancelled attempt means. Four bounds keep it a backstop:

* the attempt it is attributed to must ALREADY be terminal and NOT `succeeded`, re-read under the
  instance's row lock, so a live instance can never be terminalized;
* an already-terminal instance is a `noop`, never a refusal on the happy path;
* legality is the frozen predecessor set, and an EMPTY set refuses rather than writing;
* the write goes through `writeServiceInstanceStatus`, the ONE writer of that column, conditional on
  the status read under the lock.

**No projection receipt is written**, and that is forced rather than chosen:
`job_projection_receipts.source_fence` is `NOT NULL` and this path has no fence, by definition.
Idempotency comes from the conditional write plus the already-terminal no-op.

### 4. What is NOT closed by this

The **JOB-006 behaviour is unchanged**: `requestCancellation` still finalizes silently and still
emits nothing. Any other control-plane path that terminalizes a service job — SVC-005's TTL stop and
budget stop are the named ones — will strand its instance the same way unless it makes the same call.
That is a residual on SVC-005, stated here so it is not rediscovered a third time.

---

## E9-F007 — the liveness deadline terminalizes the INSTANCE and does not fence the WORKER, so a silent-but-renewing worker overlaps its own replacement

**Status:** `open` · `unowned` · **Severity:** HIGH
**Filed:** 2026-09-10, by **SVC-003b**, in the commit that creates the condition. Filed rather than
folded into the design note because it is a real overlap window with external effects on one side of
it, and because the ticket that must close it (SVC-005) already owns the clause it belongs to.
**Affected tickets:** SVC-003 (created it), SVC-005 (owns the clause), SVC-004 (restart policy).
**Blocks gate:** no — E9's exit gate is not met for several larger reasons already on record. It
does bound what SVC-003b's clause may be read to claim.

### 1. The mechanism, verified at source

SVC-003b's sweep (`sweepServiceInstanceLiveness`, `packages/db/src/repositories/tenant/job-control.ts`)
writes exactly ONE table. That is deliberate and pinned: E9's acceptance for SVC-003 opens *"health
events do not extend ownership without a successful lease renewal"*, and a sweeper that revoked or
expired a lease would be a second authority over ownership beside `renewLease` and
`reapExpiredLeases`. `L-T11` asserts the lease's `status`, `expires_at` and `fence` are byte-identical
across a terminalization, and mutant `L17` (expire the lease alongside the status write) reds it.

The consequence is that the WORKER is untouched. The dangerous case is exactly the one the deadline
exists for: `runServiceLifecycle`'s supervise loop handles an unanswerable `processStatus` read with
`unknown ⇒ EMIT NOTHING` (`packages/worker-daemon/src/supervisor/service-lifecycle.ts`), while
`lease-renewal.ts` renews on a separate driver. So the worker emits nothing, keeps renewing, keeps
its fence — and its supervised PROCESS may still be running and still performing external effects —
while the deadline drives its instance `lost` and SVC-002's reconciler starts a replacement.

### 2. What IS protected, and what is not

**Protected:** the replacement's instance row. The old worker's late events land on a row that has
reached a frozen terminal status, and SVC-003a's split-brain refusal returns `illegal_transition`
rather than resurrecting it — the three terminal statuses have no outgoing edges, so they appear in
no predecessor set. Two live rows under one partial-unique key remains impossible.

**Not protected:** the old worker's EXTERNAL EFFECTS. Two processes for one service can overlap for
as long as the old lease survives, which is bounded only by the lease TTL and the reaper's interval,
not by anything this ticket added. That is precisely SVC-005's acceptance clause — *"no two
generations may perform external effects simultaneously unless a later approved architecture decision
explicitly permits overlap and defines its fencing and idempotency policy"* — reached one ticket
early, by a same-generation route rather than a rollout.

### 3. Why it was not fixed here, and what would close it

The alternative to accepting the overlap is not terminalizing at all, which is the permanent wedge
SVC-003b exists to remove and is strictly worse: a stuck service no code notices. So the overlap is
the smaller harm and is taken deliberately.

Closing it needs an authority this ticket does not have: either the deadline gains the right to
revoke a fence (a second ownership writer, which needs a ruling against E9's own acceptance
sentence), or SVC-005's stop/drain path is issued to the old lease at the moment of terminalization
— which needs a `graceful_stop` producer, and E9-F008 records that no such producer exists anywhere
in the tree. Until one of those lands, the window is real and is stated in
`SVC-003b-result.md` §2 rather than implied.

---

## E9-F008 — three of the six frozen control-command kinds have ZERO producers, one of them cannot be persisted at all, and a repository docstring says otherwise

**Status:** `open` · `unowned` · **Severity:** MED
**Filed:** 2026-09-10, by **SVC-003b**, while measuring SVC-003's graceful-stop and checkpoint-request
outcome clauses. Filed rather than recorded in the result note because it is the reason two of
SVC-003's five outcome conjuncts cannot be delivered by any ticket that does not first add a
producer, and because part of it is a record disagreeing with the code it describes.
**Affected tickets:** SVC-003 (blocked by it), SVC-004 (checkpoint), SVC-005 (graceful stop, drain),
JOB-006 (the docstring).
**Blocks gate:** no.

### 1. The measurement, at `053f90fc8` and re-measured at this ticket's head

`CONTROL_COMMAND_KINDS` (`packages/worker-protocol/src/transport.ts`) freezes six kinds:
`cancel`, `product_approval_result`, `runtime_decision_result`, `checkpoint`, `graceful_stop`,
`drain`. Only three of them are ever produced:

| Kind | Persistable? | Producers in the tree |
|---|---|---|
| `cancel` | yes | 2 literals, both inside `requestCancellation` |
| `product_approval_result` | yes | 1, via `queueGovernedControlCommand` from `job-approval-bridge.ts` |
| `runtime_decision_result` | yes | 1, same path |
| `graceful_stop` | yes | **none** |
| `drain` | yes | **none** |
| `checkpoint` | **no** | **none** |

`checkpoint` is additionally excluded by `job_control_commands_kind_check`
(`packages/db/src/schema/job_control_commands.ts`), which permits five of the six — so a checkpoint
command cannot be written at all, not merely is not written. SVC-003a recorded that half already;
this finding adds the other two kinds and the type-level obstruction below.

### 2. The generic queuer is narrowed at the TYPE level, so this is not a one-line gap

`queueGovernedControlCommand` is the only general-purpose producer, and its input type
(`GovernedControlCommandInput.commandKind`, `packages/db/src/repositories/tenant/job-control.ts`)
admits exactly `"product_approval_result" | "runtime_decision_result"`. A `graceful_stop` cannot be
handed to it without widening a repository interface. The worker end is complete: the frozen
transport defines the command, the DB CHECK admits it, `renewLease` surfaces it in
`cancelRequested` and in the `dev.aoa.job/control-v1` extension, and the daemon's
`control-commands.ts` classifies it. The channel is finished at both ends and has nothing entering
it.

### 3. ★ The record that disagrees with the code

`JobControlCommandKind`'s docstring says *"JOB-006 issues `cancel`/`drain`/`graceful_stop` from the
reaper/cancellation"*. Measured at head: `requestCancellation` hard-codes `commandKind: "cancel"` at
both of its insert sites, and `reapExpiredLeases` contains no insert into `job_control_commands` at
all. Two of the three kinds that sentence names are issued by nothing. It is the same failure class
this programme keeps meeting — a comment describing an intention as a fact — and it is left in place
rather than silently corrected, because correcting the prose without adding the producer would make
the gap invisible again.

### 4. What would close it

A producer for `graceful_stop` (SVC-005's operator stop/pause, and the fencing half of E9-F007),
plus the widening of `GovernedControlCommandInput` that a producer needs; a producer for `drain`
(SVC-005); and for `checkpoint`, a migration widening `job_control_commands_kind_check` before any
producer is possible (SVC-004). The docstring is corrected by whichever of those lands first.

---

## E9-F009 — a `lost` instance records the STATUS and not the AUTHOR, so a deadline kill and a worker-reported loss are indistinguishable after the fact

**Status:** `open` · `unowned` · **Severity:** MED
**Filed:** 2026-09-10, by **SVC-003b**, after external review of PR #413 raised it. The observation
was verified against source and is right; the fix review proposed (an `activity_log` write from the
sweep) is not taken, for the reason in §3.
**Affected tickets:** SVC-003 (created the second author), SVC-007 (the evidence experience that
must display it), JOB-013 (owns the `activity_audit` projection kind).
**Blocks gate:** no. E9's gate does say *"telemetry explains every transition"* (SVC-006), so this
is on that clause's path.

### 1. The gap, verified at source

`service_instances` carries `status` and `updated_at` and nothing that says WHO moved the row. Two
different authorities can now write `lost`:

* a worker's own `service_instance_lost` observation, through
  `applyServiceProjectionForFence` — which DOES leave a durable trace, a
  `job_projection_receipts` row with `projection_kind = 'service_instance_status'` keyed on the
  driving event's identity; and
* SVC-003b's liveness deadline, through `sweepServiceInstanceLiveness` — which writes **only** the
  status. There is no event, so there is no `sourceIdentity`, so there is no receipt.

After the fact the two are indistinguishable in the database. An operator asking *"did the service
report itself gone, or did the control plane give up on it?"* — a materially different question,
because the second means the worker may still be running (E9-F007) — cannot answer it from durable
state.

### 2. What SVC-003b did deliver, so this is not read as nothing

The sweep returns `terminalized[]` with the instance id, the service id and the status each row was
driven out of, and `createServiceReconciler` now calls `onTerminalized` once **per instance**; the
composition root logs each one. That makes the record instance-specific rather than an aggregate
per-tick count. **It is not durable, and a log line is not a record** — which is the half this
finding is about.

### 3. Why the reviewed fix was not taken

Review proposed an `activity_log` write inside the sweep's transaction. Measured: **no repository
method under `packages/db/src/repositories/tenant/` writes `activity_log` at all** — not
`applyServiceProjectionForFence`, not `reapExpiredLeases`, not SVC-002's reconciler. Introducing one
from a liveness sweeper would be a new convention entering the layer through its least prominent
door, and a convention nothing else in the layer follows is the kind of thing that is correct once
and wrong thereafter.

### 4. What would close it

The in-house mechanism already exists and is one migration away: a `job_projection_receipts` row
with a new `projection_kind` (the CHECK is `job_projection_receipts_projection_kind_check`, widened
by `db:generate` exactly as SVC-003a's `0277` widened it for `service_instance_status`), a
deterministic `source_identity` — `deadline:{serviceInstanceId}` is unique by construction, since a
terminal instance can never be terminalized twice — and the instance's own `job_id`/`attempt_id`,
which attribution already guarantees are present. Alternatively JOB-013's `activity_audit` kind, if
whoever owns that decides the deadline belongs on the activity trail. Either way it is a migration
plus a write, and it should land with SVC-007's evidence surface so the record has a reader.

### 5. ★ What SVC-005a delivered of this, and what it did NOT

**DELIVERED — the instance's own author, durably.** `service_instances.terminalized_by` (migration
`0279`) records WHO drove a row terminal, in **four** values: `worker_stopped` (the worker saw the
process go — the only witness), `worker_unconfirmed` (the worker's own `service_instance_lost`, i.e.
it could NOT confirm the stop), `liveness_deadline` and `control_plane_backstop`. ★ The split of the
worker's own event into two was external review of PR #415's P1: a single author would have read
*"the process survived cancel and kill"* as proof that it stopped. It is written at the single
chokepoint `writeServiceInstanceStatus`, whose `author` parameter is REQUIRED so a fifth call site
cannot arrive unclassified. So the question §1 says
an operator cannot answer from durable state — *"did the service report itself gone, or did the
control plane give up on it?"* — is now answerable for any instance terminalized after `0279`.
SVC-005a needed it as a FENCE INPUT rather than as telemetry, which is why it landed here.

**NOT DELIVERED — the projection-receipt route §4 names, and the reader.** No
`job_projection_receipts` row, no new `projection_kind`, no `activity_log` write; §3's reason for
declining a repository-layer `activity_log` write stands unchanged. And a pre-`0279` terminal row
still carries NULL — correctly, since inventing an author for a row nobody witnessed is the forged
attribution the column exists to prevent. There is still no operator surface that displays it
(SVC-007's evidence experience).

**THIS FINDING STAYS OPEN.** Its title is about a `lost` instance being unattributable *after the
fact*, and the durable half of that is now closed — but the clause it sits under is
`telemetry explains every transition` (SVC-006), and a column with no reader and no receipt does not
explain a transition. Half a conjunction is not the conjunction.

> ★ **PARTIAL CORRECTION FROM `E9-F010`, 2026-09-10.** §3's measurement — *"no repository method
> under `packages/db/src/repositories/tenant/` writes `activity_log` at all"* — is RE-MEASURED AND
> STILL TRUE at this commit, and SVC-007b did not change it. But the conclusion drawn beside it,
> that an `activity_log` write from the distributed path would be "a new convention entering the
> layer through its least prominent door", holds only for the REPOSITORY layer. In the SERVICE
> layer the convention already exists and now has three users: `stageJobInputFiles`
> (`server/src/services/job-input-staging.ts`), `jobAuditBridge`, and SVC-007b's
> `service-control-audit.ts`. This finding's own remedy is unaffected — a liveness sweep runs
> inside a repository method and has no service-layer caller to hang an audit on — but a reader
> should not carry §3 across as "the distributed path cannot write `activity_log`".

> ★ **NARROWING NOTE, 2026-09-11, by the `de12-generation-audit` unit — and this does NOT
> resolve the finding.** The DE-12 register row and the generation-roll route comment both cited
> this finding's **§3** as the standing reason a durable `activity_log` row was not written for a
> **generation roll**. That dependency is now removed: a roll writes a durable
> `service.generation_roll` row inside its own tenant transaction
> (`recordServiceGenerationRollActivity`, `server/src/services/service-control-audit.ts`, pushed
> from `rollServiceGenerationWithinTenant`), delivering DE-12 conjunct **3c**. That is a
> **SERVICE-layer** write, exactly the convention the E9-F010 correction above says §3's
> **repository-layer** measurement must not be carried across to — so it neither overturns §3 nor
> touches the sweep §3 is about. **This finding's OWN concern is unchanged and STAYS OPEN:** the
> liveness-deadline `lost` instance still has no `job_projection_receipts` receipt and no reader
> (§4, §5's "NOT DELIVERED" half), which needs the `job_projection_receipts_projection_kind_check`
> widening — a `db:generate` migration this unit did not do. The generation-roll audit is a
> *different* record from the one this finding names; it is cross-referenced here so the register
> and the route no longer read as leaning on §3, not because §4's remedy has landed.

---

## E9-F010 — the recorded reason these routes write no `activity_log` row is refuted at source: the fence is `jobAuditBridge`'s requirement, not the table's

**Status:** `open` — **HALF RESOLVED** 2026-09-10 by **SVC-007b**
(`tickets/SVC-007b-result.md`) · **Severity:** MED
**Filed:** 2026-09-10, by SVC-007b, whose whole assignment was to verify the claim before building
on it. Filed although half of it is resolved in the same commit, because the OTHER half — three
sibling mutations on the same router — is still silent for the same refuted reason, and because a
false "X is blocked" is the class this programme gets wrong most.
**Affected tickets:** SVC-007 (filed and half-resolved it), JOB-008 (owns `drain`/`revoke`),
JOB-013 (owns the fenced bridge; unchanged by this).
**Blocks gate:** no. It bounds what AGENTS.md §9's *"Write activity log entries for mutations"* may
be read to guarantee on the distributed-execution router.

### 1. The claim, quoted rather than paraphrased

`SVC-007a-result.md` §4a(iii) declined an `activity_log` row for its four new service routes and
explicitly gave a mechanical reason rather than a scope preference:

> *"the shipped distributed-execution audit path is `jobAuditBridge.recordAcceptedActivity`, and its
> input contract **requires** `fence: ActiveFenceRequest` … **A service CREATE has no attempt, and a
> desired-state change has no fence** … So that bridge is structurally unusable here, and writing
> `activity_log` directly would create a SECOND, unguarded audit path that JOB-013's exactly-once
> machinery does not cover."*

§7 restates it as *"not merely unwritten, it is currently **unwritable** from here"*.

### 2. What is true, re-verified at source

The FIRST half is exactly right and is not disputed. `RecordAcceptedActivityInput.fence` is a
required, non-optional field (`server/src/services/job-audit-bridge.ts`), and the bridge uses it
TWICE — `repos.jobControl.lockActiveFence(input.fence)` for the TOCTOU serialization, and
`recordGovernedProjection({...input.fence, projection})` for the receipt. No service control has a
lease, an attempt or a fence. **That bridge genuinely cannot be called from these routes.**

### 3. What is false — three independent measurements

1. **The fence is the BRIDGE's admission requirement, not the TABLE's.** `insertActivityLog`
   (`server/src/services/activity-log.ts`) takes a plain `Db` — a transaction handle is one — and
   requires no lease, no attempt and no fence. The bridge calls it that way itself, on `tx`.

2. **`aoa_app` may write the table, with no exemption.** `GRANT SELECT, INSERT ON "activity_log" TO
   "aoa_app"` — `packages/db/src/migrations/0213_e2_serving_role_correction.sql:98`, re-affirmed at
   `0214_e2_serving_role_hardening.sql:166`. No migration enables RLS on `activity_log`, and
   `0245_job_activity_audit_rls.sql`'s own header says so: *"`activity_log` and `hub_audit` are
   deliberately NOT touched here: both are CAV-005 legacy, non-forced, app-layer-company-scoped
   tables (table-level grants to aoa_app — activity_log SELECT+INSERT …) — already cover the
   transactional audit writes."*

3. **★ A FENCELESS TRANSACTIONAL `activity_log` WRITE ALREADY SHIPS ON THE DISTRIBUTED PATH.**
   `stageJobInputFiles` (`server/src/services/job-input-staging.ts`) writes one bundle-level audit
   row via `insertActivity(tx, …)` inside `runInTenant`, with `leaseId` and `fenceToken` NULL and no
   receipt — and its own comment forbids repairing that: *"NO LEASE, NO FENCE … do not 'tidy' this
   behind `guardActiveFence`, which cannot be satisfied here and would remove the capability rather
   than secure it."* Measured with the register's own `countProductionCallers` at base
   `c27feeea8` AND re-measured at this commit's head — unchanged by this unit: `stageJobInputFiles`
   **2** production callers (reached from `server/src/index.ts:1269`), `jobAuditBridge` **0**. So
   the direct transactional write is not "a SECOND path" — it is the FIRST one, and the fenced
   bridge is the one nothing calls.

★ The inversion is worth naming because it is the general shape: the exceptional, unreached
mechanism was mistaken for the norm, and the norm for a deviation from it.

### 4. Why the receipt is not needed here, rather than merely unavailable

JOB-013's header states its own premise: *"insertActivityLog has NO native dedup. On a **replay** the
JOB-005 receipt identity … is the guard."* The bridge audits an accepted mutation on a distributed
attempt delivered **at-least-once**: the same `acceptedEventId` can arrive twice, the mutation may
already have been applied by the earlier delivery, and the audit insert would then be the only new
write in its transaction — nothing else pins it, so it needs an identity-keyed receipt.

A service control action is **re-requested, not replayed**. There is no redelivery machinery in front
of these routes, and `SVC-007a-result.md` §7 says of the mutation itself that *"two POSTs create two
services"*. Two services must leave two audit rows; a receipt keyed on a client id would make the
audit under-report exactly where the mutation over-produced. So the guard here is the TRANSACTION:
the audit row is written inside the same tenant transaction as the mutation, so a commit yields
exactly one of each and a rollback yields neither. That is stronger than reconciling two things that
can be written apart, because they cannot be written apart.

### 5. What SVC-007b resolved, and what it did NOT

**RESOLVED — the two MUTATING service routes.** `POST …/services` and
`POST …/services/:serviceId/desired-state` each write one `activity_log` row
(`service.create` / `service.desired_state`) inside the mutation's own tenant transaction, through
`server/src/services/service-control-audit.ts`. Pinned by T14–T18 in
`service-management.integration.test.ts` (real embedded PostgreSQL, `aoa_app` pool) and B1–B10 in
`service-control-audit.test.ts`; twelve mutants, all killed, listed in `SVC-007b-result.md` §4.
(The other two service routes are GETs and mutate nothing.)

**★ NOT RESOLVED, WHICH IS WHY THIS FINDING STAYS OPEN.** Three mutating endpoints on the SAME
router still write nothing durable — `POST …/companies/:companyId/jobs`,
`POST …/companies/:companyId/jobs/:jobId/drain`, and
`POST …/organizations/:organizationId/workers/:workerId/revoke`. Measured at this commit: neither
`server/src/services/job-submission.ts` nor `server/src/services/job-operations.ts` contains any
`activityLog` / `insertActivity` / `logActivity` reference, so the handler's logger line is the
whole record. They are unaudited because nobody wired them — NOT because they are blocked. The split
is written into `jobControlRoutes`' own header so a reader of those handlers sees it.

**NOT TOUCHED:** `jobAuditBridge` keeps its zero production callers, and DE-01 is unaffected — its
`audit` clause is *"query and policy-denial events recorded in the control-plane audit log"*, which
is a different clause from AGENTS.md's mutating-action invariant. Nothing here closes DE-01.

**Resolve** = wire the three remaining mutations (the same shape, one call each, no new mechanism),
then flip this Status and DELETE the manifest key in the SAME commit.

---

## E9-F011 — a create whose generation insert conflicts COMMITS a service with no generation, and the docstring says it rolls back

**Status:** `open` · `unowned` · **Severity:** LOW (unreachable by construction today; the RECORD
is what is wrong)
**Filed:** 2026-09-10, by **SVC-007b**, found while deciding where the create's audit row belongs —
the question "what is audited when the create returns `null`?" is what exposed it.
**Affected tickets:** SVC-007 (owns the create path), SVC-005 (owns generation rollout, and will
add the first REACHABLE conflict).
**Blocks gate:** no.

### 1. The contradiction, at source

`createServiceWithinTenant` (`server/src/services/service-management.ts`) documented its `null`
return as *"the caller turns it into a definite refusal and the transaction rolls back"*, and the
route's own comment calls the case *"Unreachable by construction; reported as a definite refusal
rather than retried"*.

Returning `null` does not roll anything back. Three facts compose:

* `insertServiceGeneration` catches its `23505` **on a SAVEPOINT**
  (`packages/db/src/repositories/tenant/job-control.ts`), explicitly so the OUTER transaction stays
  alive and the caller can answer — its own comment says so.
* `runInTenant` is `withTenantTx`; a callback that RETURNS commits. Only a throw rolls back.
* the route's `throw new HttpError(409, …)` runs **after** `createService` has already returned, so
  it cannot reach the transaction.

So on that path the `services` row COMMITS with no `service_generations` row — precisely the
permanent `no_generation` wedge the same function's docstring calls "not a partial success", and
which every reconcile pass then stalls on forever with no route able to repair it (this unit mints
generation 1 only, and 1 is taken). It also commits with NO audit row, since SVC-007b writes one
only on success.

### 2. Why it is LOW rather than a live defect

`service_generations_service_generation_uq` is on `(service_id, generation)`, and the service id is
minted by the `repos.services.insert` call immediately above it, in the same function and the same
transaction. `(fresh uuid, 1)` cannot already exist, so the
`null` branch is unreachable from the shipped caller. **The defect filed here is the FALSE RECORD**,
which is this programme's dominant failure class: a reader repairing or extending this function
would be reasoning from a rollback that does not happen.

### 3. When it becomes reachable

SVC-005's generation rollout mints generation **N+1** on a service id that ALREADY EXISTS, where a
`(service_id, generation)` conflict is a genuine concurrent-rollout outcome rather than an
impossibility. A rollout composed on this function's stated contract would commit half of itself.

### 4. What SVC-007b did instead of fixing it

Corrected the docstring in place — it now states that the transaction commits, names the SAVEPOINT
as the reason, and points here. NOT fixed, because the fix changes what the function RETURNS (throw
rather than `null`, or an explicit rollback signal), which changes the route's 409 path and needs its
own observed red. `unowned`: SVC-007 has a `-result.md` on disk so it counts as completed, and
naming it would be owning an open finding with shipped work (E4-F013); SVC-005 has no file on disk
at all, so naming it would fail the guard's existence bar.

**Resolve** = make the `null` branch roll back (throw from `createServiceWithinTenant`, or have
`createService` re-throw inside the transaction), with a test that drives a REAL `(service_id,
generation)` conflict — which SVC-005's rollout makes constructible for the first time. Then flip
this Status and DELETE the manifest key in the SAME commit.

---

## E9-F012 — a generation rollout cannot prove the old generation's PROCESS stopped, so SVC-005's acceptance clause has an un-closeable half

**Status:** `open` · `unowned` · **Severity:** HIGH
**Filed:** 2026-09-10, by **SVC-005a**, in the commit that makes generation rollout possible —
i.e. in the commit that makes this residual reachable, exactly as SVC-003b filed E9-F007 in the
commit that created its condition.
**Affected tickets:** SVC-005 (owns the clause), SVC-003 (created the same residual one ticket
early, as E9-F007), SVC-008 (the daemon side that could witness a stop), SVC-006 (the canary that
would have to observe it).
**Blocks gate:** no — E9's exit gate is unmet for several larger reasons already on record. It does
bound what SVC-005a may be read to claim, and that is why it is filed rather than left implied.

### 1. The clause, and the half that is delivered

E9's acceptance for SVC-005 reads:

> No two generations may perform external effects simultaneously unless a later approved
> architecture decision explicitly permits overlap and defines its fencing and idempotency policy.

SVC-005a delivers: **no two generations are PLACED while the older one is un-drained or
unwitnessed.** Two mechanisms, both verified at source:

* **Un-drained** — `service_instances_live_service_uq` permits exactly ONE non-terminal instance per
  `(organization, service)`, and `listReconcilableServices` filters on the byte-identical predicate.
  So the reconciler cannot place generation N+1 while generation N's instance is live, whatever
  `services.generation` says. Replace-after-stop is structural.
* **Unwitnessed** — step 4b of `reconcileServiceWithinTenant` refuses a CROSS-generation placement
  while a previous generation's instance is terminal-by-assumption (`terminalized_by` not
  `worker_stopped` — NULL and the worker's own `worker_unconfirmed` both included) AND its attempt
  is non-terminal. `R-T4` pins the refusal; `R-T5` pins that it clears; `R-T7c` pins that a worker's
  `lost` report is NOT a witness.

### 2. The half that is NOT delivered, and why no control-plane fact can close it

**A closed fence stops the old worker WRITING. It does not stop its PROCESS.**

The recovery condition SVC-005a uses — the old attempt reaching a terminal status — is a real and
verifiable fact with a real consequence: `classifyFence`
(`packages/db/src/repositories/tenant/job-fence.ts`) returns `attempt_terminal` BEFORE any other
test, so from that instant the old worker cannot write anything through the fenced ingest. That is
genuinely stronger than "we asked it to stop". It is still not the clause.

Nothing in the control plane observes a remote process. E9-F007 §3 already established the same
thing for the same-generation case and named the two authorities that would close it — the deadline
gaining the right to revoke a fence (which needs a ruling against E9's own acceptance sentence about
ownership), or a `graceful_stop` issued to the old lease at the moment of terminalization (which
needs a producer, and **E9-F008** records that no producer for `graceful_stop` or `drain` exists
anywhere in the tree, and that `queueGovernedControlCommand` is narrowed at the TYPE level against
both). SVC-005a adds a third and stronger candidate that is equally unavailable today: SVC-008a's
`processStatus`/`signalProcess` port, reached from the control plane, would let a stop be
**witnessed** rather than requested — but there is no channel from the control plane to that port,
and building one is not this unit's work.

### 3. Why the honest stall was taken instead

The alternative to stalling is bumping and placing anyway, which is *"a rollout that assumes the old
generation stopped because we asked it to"* — the fail-open SVC-008b's stop-verdict work exists to
refuse. The alternative to a RECOVERY CONDITION is a stall that never clears, which is the permanent
wedge this epic keeps meeting and is strictly worse than the overlap. So the shape is: refuse while
the evidence is absent, clear on the strongest available evidence, and **state the residual rather
than let a green suite imply it is gone**.

### 4. What would close it

Any ONE of: (a) a control-plane-reachable `processStatus` over SVC-008a's port, so a stop is
witnessed rather than assumed; (b) a `graceful_stop` producer plus an ACK the worker cannot forge,
so the old generation's exit is attributable — which needs E9-F008 closed first; (c) an approved
architecture decision that PERMITS overlap and defines its fencing and idempotency policy, which the
clause's own final sentence explicitly contemplates and which would convert this from a gap into a
documented allowance. (c) is the cheapest and is a founder/Protocol-Custodian call, not an
engineering one.

**Affected clause text, so nobody re-derives it:** the DE-12 register row's `deliveryStatus` is
deliberately left at `partial` by SVC-005a, and its audit conjunction (`partition, drain, and
generation changes are audited`) gains no whole conjunct — a `logger.info` line is not a durable
record.
