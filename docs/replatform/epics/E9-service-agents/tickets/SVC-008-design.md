# SVC-008 — The daemon service supervisor, and the capability widening it earns — DESIGN

**Epic:** E9 · **Lane:** worker-daemon (E9's only daemon-side ticket) · **Start SHA:** `afebb0e51`
**Owns:** finding **E9-F002** (`../findings.md`) — the register is repointed at this ticket in the
same commit.
**Status:** designed, NOT implemented, and **NOT implementable as one unit** — see §0 and §11.
**Five open questions (§9) are stated, not settled.**
**★★★ START AT §0, THEN §1.** The measurement that produced this ticket named the capability
constant as the blocker. It is not the binding one. **Five deeper constraints make a service
structurally unrunnable today**, and four of them are not in any register.

---

## 0. ★★★ THE CORRECTION — the wire is ready; the PROVIDER is not

**Revision 2 (2026-09-09), after external review.** Revision 1 of this document concluded there is
no Protocol Custodian STOP, and inferred from that that SVC-008 is one self-contained unit. **The
first half is still true and the second half does not follow from it.** Revision 1 conflated two
different claims:

| Claim | Verdict | Where |
|---|---|---|
| **No WIRE change.** Frozen v1 already carries the nine service event types, the instance state machine and `serviceSlots`. | **TRUE, re-verified.** Citations in §0.1. | §0.1 |
| **No PROVIDER change.** | **FALSE.** The provider port can neither witness a launch nor stop a process. | §1.3(c), §1.3(d) |

The wire being ready does not help if the provider cannot produce what the events assert. Two of
the events this design emits assert facts **no implementation of the current
`SandboxProvider` port can witness**, and one of the operations it sequences (`cancel` before
`kill`, honouring `gracefulStopSeconds`) **does nothing on the only real provider**.

**So: SVC-008 as scoped in revision 1 cannot be implemented as written.** It needs a provider
primitive first. §11 states the resulting split plainly, and §11.2 says which half is the bigger
unit.

### 0.1 What is still true — the wire, verified independently of the measurement

Frozen v1 carries `serviceWorkloadV1Schema` (`packages/worker-protocol/src/job.ts:312-323`), all
nine service event types (`events.ts:353-372`) with strict payloads (`:266-311`), the
service-instance machine (`states.ts:199-222`), `checkpoint`/`restore`/`health` in
`PROVIDER_OPERATIONS` (`capabilities.ts:125-135`), and `serviceSlots` in capacity. **No event,
payload, status or frozen operation name changes.** That claim survived review intact and is the
reason §11's recommended split needs no Protocol Custodian decision either.

### 0.2 What is NOT true — and the precedent that says how big the fix is

The port change §1.3(c)/(d) require does **not** need a frozen-package edit, because this exact
situation already has a shipped precedent on this exact port. `digestArtifact` / `exportArtifact`
(DAT-009) and `stageFiles` (CLI-008 Unit B) are `SandboxProvider` methods that are deliberately
**NOT** members of the frozen `ProviderOperation` union; support is declared by a separate mode
field (`artifactExportMode`, `fileStagingMode`) and an unsupported call throws
`UnsupportedProviderOperation`. The port says so verbatim
(`packages/worker-daemon/src/supervisor/provider.ts:406-410, 434-439`).

**A process-supervision pair follows that precedent exactly** (§3.4). What the precedent also
shows is the *cost*: `stageFiles` had to be implemented on every implementer, and the networked
driver had to declare `"none"` **honestly**, because `#post` is typed to the frozen vocabulary and
there is no wire route — `packages/provider-wire/src/driver.ts:84-93`, whose comment is the model
for §3.4's own honesty clause:

> *"this driver has no wire route to reach a remote provider's `stageFiles`. Giving the
> adapter-manager wire an inbound staging route is its own piece of work; claiming support without
> one would silently drop every staged file."*

That is five implementers plus a conformance surface, and it is why §11 splits the ticket.

> **Method.** Written against source re-opened at `afebb0e51`. Every line number below was opened,
> not inherited. Where the measurement that commissioned this design was wrong or incomplete, §1.4
> says so explicitly rather than quietly correcting it — and §1.4 now also records where **this
> document's own revision 1** was wrong. Where this design could not settle a question it is in §9,
> not decided in a subordinate clause.

---

## 1. ★★★ What actually blocks a service today — and why the constant is the smallest of it

### 1.1 The advertised blocker (real, and already filed as E9-F002)

`packages/worker-daemon/src/enrollment/hello-provisioning.ts:27` —
`export const SUPERVISABLE_WORKLOAD_CAPABILITIES: readonly WorkerCapability[] = ["workload.batch"];`
Its docstring: *"Batch only — the supervisor for browser_session/service composes in later sprints,
and D4 forbids reporting a workload the daemon cannot run. Widening this is a deliberate edit, not
a config."* `deriveHelloProvisioning` (`:29-52`) **intersects** the admin ceiling with
`deviceCanProvide`, so `workload.service` is filtered out of every daemon's hello regardless of what
the ceiling says. Placement then demands `workload.${input.workloadType}` unconditionally
(`server/src/services/job-placement.ts:177`, returned at `:190`), so a service job is `queued` /
`no_eligible_target` forever. Pinned in the negative at
`server/src/__tests__/u0-d1-placement-reachability.test.ts:324`.

### 1.2 ★ The mis-supervision blocker — a service dispatched today runs as a batch and *reports success*

`createSpecFor` (`packages/worker-daemon/src/supervisor/supervisor.ts:328-334`) reads only
`workload.command` / `workload.args`. `serviceWorkloadV1Schema` **also** has `command`/`args`
(`job.ts:316-317`), so a service job flows through the batch path with no type error and no branch:
`execute` is a single blocking call raced to a deadline (`supervisor.ts:717-729`), and *when it
returns, the run is over* — `terminal` is emitted from `exec.exitCode` (`:792-795`) and the sandbox
is destroyed (`:808`). The poll loop reads `offer.job.workloadType` **only** as a concurrency class
(`poll/poll-loop.ts:541-542`); nothing else in the daemon branches on it.

**That is the D4 harm in its worst form: mis-supervision that looks like success.** A long-running
service that happens to exit 0 after its startup script finishes is reported `succeeded`. This is
strictly worse than the current `queued` state, and it is the reason the constant and the supervisor
must land in ONE unit (§2.1).

### 1.3 ★★★ The four constraints nobody has filed — and they are the ones that decide this ticket

**(a) The run budget is wrong by construction, and its ceiling is four minutes.**
`resolveRunOpDeadlineMs` (`lifecycle/run-op-deadline.ts:56-68`) reads `workload.maxRuntimeSeconds`.
`batchWorkloadV1Schema` has that field (`job.ts:294`); **`serviceWorkloadV1Schema` does not** — it
has `gracefulStopSeconds` (`job.ts:322`) and nothing else time-shaped. So a service falls to
`RUN_OP_DEADLINE_FLOOR_MS = 60_000` (`:33`), and the sandbox is **born with a 60-second TTL**
(`create` passes `ctx.deadlineMs` straight through to `transport.create({timeoutMs})` and an
idempotent `setTimeout`, `packages/sandbox-e2b-provider/src/e2b-provider.ts:291-292, 319-327`).

Raising the workload's budget does not fix it, because the ceiling is derived, not arbitrary:

```
RUN_OP_DEADLINE_CEILING_MS = OWNED_LABELS_CAPABILITY_TTL_MS (300_000) - RUN_TEARDOWN_HEADROOM_MS (60_000)
                           = 240_000                                   (run-op-deadline.ts:36-46)
```

**(b) The effect authority expires after five minutes and is never re-minted.** The owned-labels
capability is minted at `expiresAt = min(authorityNow + shortTtlMs, leaseDeadline)`
(`server/src/services/owned-labels-mint.ts:92`, `OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS = 5 * 60_000`
at `:46`) and is minted on **exactly one route**, `POST /worker-control/execution-secrets/resolve`
(`server/src/routes/worker-control.ts:709`, applied at `:764-765`). It is **not** re-issued by
`/leases/:leaseId/renew` (`:511`) — verified by whole-file grep: `ownedLabelsCapability` appears in
that file only at `:764-765`. The supervisor already knows what this costs and says so at
`supervisor.ts:794-806`:

> *"the cap is lease-clamped + never re-minted, so a run longer than its TTL reaches here with an
> EXPIRED cap … Record an HONEST orphan DIRECTLY and return"* → `recordOrphan(run,
> "cap_expired_before_happy_destroy")`.

**Read together: on the networked (sandbox) lane, EVERY service run longer than five minutes ends
with a billable orphaned sandbox that the worker cannot tear down.** Not a slow path — the only
path. And the E2B TTL cannot be stretched afterwards: `transport.setTimeout` is called only from
`create` (`e2b-provider.ts:326-327`), and there is **no TTL-extension operation on the frozen
provider port** (`supervisor/provider.ts:385-404` — `create`/`execute`/`cancel`/`kill`/`destroy`/
`list`/`inspect`/`reconcileCleanup`, plus optional `checkpoint`/`restore`/`health`).

**(c) ★★★ NOTHING ON THE PROVIDER PORT CAN WITNESS A LAUNCH, so `service_instance_started` as
revision 1 specified it would be a durable false claim.** Read at source:

- `SandboxProvider.execute` (`supervisor/provider.ts:395`) returns `Promise<ExecuteResult>` carrying
  `exitCode`/`signal`/`timedOut` — **a completion**, not an acknowledgement. There is no `start`,
  no handle, no pid, nowhere for one to go.
- The E2B binding is the same shape all the way down. `E2bSandboxProvider.execute`
  (`sandbox-e2b-provider/src/e2b-provider.ts:332-375`) awaits `transport.runCommand`, and
  `RealE2bTransport.runCommand` (`real-transport.ts:107-175`) does
  `await sandbox.commands.run(full, …)` — **which this file's own comment records as `start()` then
  `CommandHandle.wait()`** (`:128-131`, derived from real E2B run 33789547290). The promise settles
  **only when the command exits**. Nothing is returned before then.
- **The two ops that could stand in describe the SANDBOX, not the command.** `inspect` →
  `transport.getInfo` → the sandbox record (`e2b-provider.ts:436-448`, `real-transport.ts:204-212`).
  `health` → `transport.isRunning` → `sandbox.isRunning()` (`e2b-provider.ts:597-601`,
  `real-transport.ts:263-270`). A sandbox is up from the moment `create` resolves, so **both answer
  "healthy" for a command that never started, crashed on line 1, or is wedged.**

**Consequence, and it is the D4 harm in its worst form.** Revision 1 emitted
`service_instance_started` on entry to the run and then a per-tick `service_health` from the
provider's verdict. On the real E2B lane that is: a durable "started" for a launch nobody
established, followed by an unbroken stream of durable `healthy` for a process that may not exist —
**mis-supervision that reads as success, recorded forever, and strictly more confident than the
batch mis-supervision of §1.2.** §3.1 and §3.2 are rewritten around this; §3.4 is the primitive that
would fix it.

**(d) ★★★ THERE IS NO STOP PRIMITIVE, so `gracefulStopSeconds` cannot be honoured — and the
existing cancel→kill ladder is already vacuous on real E2B.** Read at source:

```
RealE2bTransport.signal(sandboxId, _kind)          real-transport.ts:177-187
  -> await this.#sdk.getInfo(sandboxId, ...)       // a READ
  -> return { delivered: true }                    // ...and on throw, ALSO { delivered: true }
```

`_kind` is **ignored** — the underscore is the file admitting it. Its comment states the fact
plainly: *"E2B has no in-sandbox graceful-cancel primitive distinct from teardown; a signal is
best-effort and reported delivered. The escalation ladder relies on the forced `terminate` for
reclamation."* `E2bSandboxProvider.cancel` and `.kill` (`e2b-provider.ts:378-386`) both call it, so
**both are the same read**, and the first actual termination anywhere on this lane is
`transport.terminate` → `Sandbox.kill` inside `destroy`/`reconcileCleanup` (`:388-393`,
`real-transport.ts:189-202`).

An implementation following revision 1's §3.1 would therefore emit
`service_graceful_stop_observed`, call `cancel` (a read), wait `gracefulStopSeconds` (during which
the process keeps serving), call `kill` (the same read), emit **`service_instance_stopped` while the
command is still running**, and only then hard-kill the whole sandbox in `destroy`. Every one of
those events would be false, and the last one falsely terminal.

**★ And this is not confined to services.** `CleanupAuthority.#convergeOne`
(`supervisor/cleanup-authority.ts:279-290`) escalates to `kill` only when
`cancel.outcome === "ignored"`, and its docstring says *"A compliant `cancel` (outcome `stopped`)
skips `kill`"*. Real E2B's `signal` never returns `delivered: false`, so `outcome` is **always**
`"stopped"` and the ladder's `kill` rung is **structurally unreachable on the real provider today**.
Batch survives this because `destroy` runs last unconditionally and reclaims the resource anyway —
so it is a fabricated outcome value and a dead rung, not a leak. **SVC-008 would be the first
consumer that acts on that value**, which is what converts a latent falsehood into
mis-supervision. §10 says who should file it; it is not E9's finding.

### 1.4 Where the commissioning measurement was wrong — and where revision 1 of THIS document was

- It named `job-placement.ts:196`'s `Math.min(600, …)` as *"the real long-running constraint … a
  hard ceiling"*. It is neither hard nor the real one. `boundedDemand` derives demand from the
  **resolved target's own** profile (`job-placement.ts:193-210`, called at `:261`), and
  `providerDemandFits` compares that demand against each candidate (`:504-511`), so the clamp is a
  *demand assertion* that can only ever narrow the candidate set — never a runtime enforcement. The
  runtime enforcement is §1.3(a), which the measurement did not reach.
- It reported *"no daemon file mentions `generation`/`serviceInstanceId`"* and inferred the gap is
  daemon-side implementation only. True as far as it goes, and it stops one layer above the
  authority model that makes the implementation impossible to do safely today.
- It did not surface `RUN_OP_DEADLINE_CEILING_MS`, the never-re-minted capability, or the absence of
  a TTL-extension port operation. Those three are the substance of §3 and §4.
- ★ It recorded `config.concurrency.service` as defaulting to **1**. That reading was **correct**,
  and revision 1 of this document contradicted it in §5.1(4) by asserting the default is 0. The
  measurement was right; see the next bullet.

**And where revision 1 of this document was wrong** — recorded here rather than silently corrected,
because a design that quietly fixes itself teaches nothing:

- **It conflated "no wire change" with "no provider change".** They are different claims. The first
  holds (§0.1); the second is false (§1.3(c), §1.3(d)). That conflation is what produced the
  "one self-contained unit" scoping, and §11 restates the conclusion.
- **It specified `service_instance_started` as an assertion the provider cannot witness**, and a
  `service_health` tick sourced from an op that answers about the sandbox. §1.3(c).
- **It specified `cancel` → wait → `kill` as a graceful-stop ladder** on a provider where all three
  of `cancel`, `kill` and "delivered" are one `getInfo`. §1.3(d).
- **★ It claimed `config.concurrency.service` "defaults to 0 today"** (§5.1 clause 4) and listed
  "one config default (`config/config.ts:186`)" among the edits (§2). **Both are false**, and they
  contradicted this ticket's own commissioning measurement. Opened at source:
  `packages/worker-daemon/src/config/config.ts:186` reads
  `service: parseIntEnv(env, ENV.concurrencyService, { defaultValue: 1, min: 0, max: 10000 })`,
  and it reads identically at this commit's parent (`git cat-file blob afebb0e51:…`). The
  provisioned hello already advertises it — `serviceSlots: config.concurrency.service`
  (`bin/worker-daemon.ts:529`). **So clause 4 was already satisfied before SVC-008 existed, the
  listed edit has nothing to change, and revision 1's second T0 mutant could not have represented a
  regression SVC-008 introduces.** Clause 4 and T0 are rewritten to separate the *slot default*
  (already true, and a pre-existing invariant worth a guard) from the *capability advertisement*
  (the thing that actually changes).

**Everything else the measurement asserted was re-verified and holds**: frozen v1 completeness, the
zero-production-caller `recordServiceHealth` (`packages/db/src/repositories/tenant/job-control.ts:3181`
— whole-tree grep returns the declaration, its interface line `:469`, two fence allow-lists, and
three test files), the generic `terminal`-only projection in ingest
(`server/src/services/job-events.ts:58-78`), `serviceSlots` accounting including the hardcoded
`serviceSlots: 0` on the unprovisioned path (`enrollment/desktop-hello.ts:183`), and
`capabilitiesForIsolation` contributing no `workload.*` name at all.

---

## 2. What SVC-008 builds, and the one sentence that bounds it

**A daemon that can hold a process open under supervision for as long as its authority is valid, and
an advertised capability that is true when it does.** That is the whole ticket.

- **Zero new wire surface.** Every event, payload, status and frozen operation name used here is
  frozen v1 and already on disk. SVC-008 consumes them. (§0.1.)
- **Zero new relations, zero migrations.** No control-plane schema change (that is SVC-002/003).
- **★ A NEW PROVIDER-PORT SURFACE, and it is not free.** §1.3(c)/(d) mean the daemon half cannot be
  built alone. The port pair is §3.4; the implementers it lands on are §11.1. **This is the sentence
  revision 1 did not have, and it is why §11 splits the ticket.**
- **The daemon half**: one new module (`supervisor/service-lifecycle.ts`), one branch in
  `runLifecycle`, one resolver change (`run-op-deadline.ts`), one constant edit
  (`hello-provisioning.ts:27`).
- **NOT a config-default edit.** `config.concurrency.service` already defaults to 1
  (`config/config.ts:186`, unchanged at this commit's parent) and the provisioned hello already
  reports it (`bin/worker-daemon.ts:529`). Revision 1 listed this edit; it does not exist. §1.4.

**And the sentence that bounds it:** SVC-008 supervises **one instance, on one worker, for one lease
generation**, and emits what it observes. It does **not** decide what any of those observations
mean. Health *policy* (does a missed health kill the instance?), lease/ownership semantics, restart,
checkpoint, drain and generation are all SVC-003/004/005 — see §8. The acceptance table must read
"a service job reaches a worker and is supervised as a service", **never** "services are managed."

---

## 3. The service lifecycle, and exactly how it differs from batch

### 3.1 The shape mismatch, named precisely

For batch, **`execute` returning IS the run ending**. There is no representation of "the process is
still up", so a workload that does not end has no state in this supervisor. The service path
therefore cannot be a parameterisation of the batch path; it is a different sequencer over the same
authorities.

| Step | Batch (`runLifecycle`, `supervisor.ts:468-830`) | Service (`runServiceLifecycle`, new) |
|---|---|---|
| secrets | `materializeRunSecrets` once (`:520`-ish), mints the owned-labels cap | **once, then RE-MATERIALIZED on a schedule** — §4.1 and **§9.1** |
| create | `create` (`:571`), TTL = `opDeadlineMs` | `create`, TTL = the service budget (§3.3) |
| stage | optional `stageFiles` (`:605`) | same, unchanged |
| start | `attempt_started` (`:710`) | `attempt_started`, then **`service_instance_started`** carrying `{serviceId, serviceInstanceId, generation, providerResourceId: sandboxId}` (`events.ts:266-268`) — **meaning `starting`, and ONLY that: §3.1a** |
| run | **`execute` blocking, raced to `opDeadlineMs`** (`:717-729`) | `startProcess` (§3.4) returns an **acknowledged handle**; the supervisor enters a **supervise loop**. Without §3.4 there is no launch witness at all (§1.3c) |
| observe | best-effort `observeRun` log/progress/usage (`:774`) | the same observation channel, PLUS a health tick emitting **`service_health`** (`events.ts:271-275`) — **only when the provider's health op witnesses the PROCESS: §3.2 step 2** |
| stop | n/a | on stop signal: **`service_graceful_stop_observed`** with a deadline (`:287-289`), then `signalProcess("cancel")`, then `signalProcess("kill")` after `gracefulStopSeconds`. **`provider.cancel`/`provider.kill` are NOT this ladder** — on real E2B both are one `getInfo` (§1.3d) |
| end | `terminal` from `exec.exitCode` (`:792`) | **`service_instance_stopped`** (`:292-294`) or **`service_instance_lost`** (`:297-299`), THEN `terminal` — and `_stopped` is emitted only once the process is **observed** gone, never on the stop *request* |
| destroy | `destroy` (`:808`), orphan-record if cap expired (`:800-803`) | identical, and §4.1 is what keeps the cap alive to reach it |

**The load-bearing difference is the third-from-last row.** A service emits an instance-terminal
event *before* the attempt terminal, because the instance and the attempt are different objects in
the frozen model (`states.ts:199-222` is a machine the attempt machine does not contain). Emitting
only `terminal` is exactly today's mis-supervision (§1.2) with extra steps.

### 3.1a ★★★ What each event is allowed to CLAIM — the rule revision 1 did not have

The fix for §1.3(c) is half semantic and half a primitive, and the semantic half is free because
**the frozen state machine already draws the line**. `SERVICE_INSTANCE_TRANSITIONS`
(`states.ts:214-224`) is `leased → starting → {healthy | unhealthy | stopping | failed | lost}`.
`starting` is a distinct state, and `service_instance_started`'s payload names a
`providerResourceId` — **the sandbox** — not a process (`events.ts:266-268`).

So, as a rule this design now binds itself to:

| Event | May be emitted when, and ONLY when | Witnessed by |
|---|---|---|
| `service_instance_started` | `create` resolved a `sandboxId` **and** a launch has been requested on it. It asserts **`starting`** — "an instance exists on this provider resource and a start was issued" — and **NOTHING about the process**. | `create` (today) |
| `service_health: "healthy"` | the provider's health op witnesses **the supervised process**, not its container. **The current E2B `health` witnesses the sandbox** (`isRunning`) and therefore may NOT source this event. | §3.4 `processStatus` (does not exist yet) |
| `service_health: "unhealthy"` | same op, negative verdict. Symmetric: a fabricated *unhealthy* is as wrong as a fabricated *healthy*, and it would additionally drive SVC-003 to kill a working service. | §3.4 |
| `service_instance_stopped` | the process is **observed** gone (a settled exit, or a status read that says gone). **Never on a stop request, never on a signal's return value.** | §3.4, or `execute` settling |
| `service_instance_lost` | the provider cannot describe the **sandbox** (`inspect` → `SandboxNotFoundError`). This one IS witnessable today. | `inspect` (today) |

**★ The rule that generalises all five rows:** an event may assert only what an op the daemon
actually called returned. A sandbox-scoped answer may not be reported as a process-scoped fact.
That is the same rule §3.2 step 2 already stated for the *absent* health op ("do not synthesize a
`healthy`") — revision 1 simply failed to notice that on the real provider the *present* health op
is, for this purpose, equally absent.

**Consequence for a hung launch, stated so it cannot be read as success:** with §3.4, a launch that
never acknowledges is `service_instance_lost` with a reason (§4.3). **Without** §3.4, the instance
stays in `starting` and **never advances to `healthy`** — because nothing may witness it — until the
budget lapses. That is honest and it is also, plainly, useless: a service that can never be reported
healthy is not a service. Which is §11.

### 3.2 The supervise loop, exactly

One `setInterval`-free, `schedule`-driven tick (reusing the supervisor's injected `schedule`, so
tests drive it with a fake clock — the existing `withDeadline` already does this, `:335-345`). Per
tick, in order, each step best-effort and individually try/caught:

1. **Cap freshness.** If `run.capExpiresAt` is within `RUN_TEARDOWN_HEADROOM_MS` of `now()`,
   re-materialize (§4.1). If re-materialization fails, this is a **planned stop**, not a crash —
   §4.4.
2. **Health — and the gate is NOT `advertisedOperations.has("health")`.** ★ Revision 1 gated on
   advertisement and was wrong, because the advertised op answers the wrong question. `health` →
   `transport.isRunning` → `sandbox.isRunning()` (`e2b-provider.ts:597-601`,
   `real-transport.ts:263-270`) — **the sandbox, which is up from the moment `create` resolved.**
   Sourcing `service_health` from it would emit `healthy` for a process that never started. The gate
   is therefore **`processSupervisionMode !== "none"`** (§3.4): call `processStatus(handle, ctx)` and
   emit `service_health` with its verdict verbatim (the wire enum is the same two values,
   `SERVICE_HEALTH_STATUSES`, `events.ts:271`, so no mapping table exists to get wrong). **If the
   provider cannot witness the process, emit nothing — do not synthesize a `healthy`, and do not
   launder a sandbox-scoped answer into a process-scoped one.** A fabricated health signal is the
   failure class this programme keeps re-learning; §1.3(c) is that failure class arriving through
   an op that *is* advertised, which is why the advertisement gate does not catch it.
3. **Liveness.** `inspect(sandboxId, ctx)`. A sandbox the provider no longer knows about is
   `service_instance_lost` (§4.3). **This is the one liveness signal that is honest today** — it is
   sandbox-scoped and it is reported as a sandbox-scoped fact.
4. **Stop signal.** The existing control-command channel already rides lease renewal
   (`lease/lease-renewal.ts` header: *"A `renewed` with `cancelRequested` is a server-initiated
   cooperative cancel"*). SVC-008 **reuses `cancelRequested` and adds no new channel** — a
   service-specific stop verb is SVC-005's.

**The loop never renews the lease itself.** Lease renewal is already a separate, shipped driver that
DECORATES the supervisor seam (`lease/lease-renewal.ts:1-9`), and its loss path
(`onLeaseLost` → fence close → cleanup) is the mechanism §4.5 relies on. Duplicating it inside the
service loop would create a second, unfenced renewer — the exact shape SVC-002 §4.1 argues against
for its own duplicate-insert problem.

### 3.3 Where the service's budget comes from, since the workload does not carry one

`resolveRunOpDeadlineMs` gains a service arm. **The source of truth is the target's provider
constraint profile**, which already carries the right field:
`providerConstraintProfileV1Schema.maxContinuousRuntimeSeconds`
(`packages/worker-protocol/src/capabilities.ts:174`, min 1, max 604_800). The handoff carries the
resolved target, so the value is available without a wire change.

**But it is clamped by the effect-authority window, not by the profile**, and that clamp is the whole
of §9.1. Until the re-mint question is settled, the service budget is:

```
serviceOpDeadlineMs = min(profile.maxContinuousRuntimeSeconds * 1000, RUN_OP_DEADLINE_CEILING_MS)
```

which is **240 seconds**. A four-minute service is not a service. **This is the single fact that
decides whether SVC-008 can honestly widen the constant**, and it is §5.

### 3.4 ★★★ The provider primitive this needs — the part revision 1 assumed existed

§1.3(c) and §1.3(d) are the same missing thing seen from two ends: **the port has no concept of a
process inside a sandbox.** `execute` is a completion oracle; `cancel`/`kill` are sandbox-scoped and,
on the only real provider, are one `getInfo`. Supervision needs a handle.

**Shape, following the `stageFiles` precedent exactly (§0.2) so no frozen edit is required:**

```
// packages/worker-daemon/src/supervisor/provider.ts — NOT members of the frozen
// ProviderOperation union; support declared by the mode below, exactly as
// artifactExportMode / fileStagingMode already do.

startProcess(sandboxId, input: ExecuteInput, ctx): Promise<ProcessStartResult>
  // Resolves ONLY when the launch is ACKNOWLEDGED by the provider, carrying an
  // opaque `processHandle`. It does NOT wait for the process to exit. A launch
  // that cannot be acknowledged is a THROW, never a handle.

processStatus(sandboxId, handle, ctx): Promise<ProcessStatusResult>
  // { state: "running" | "exited" | "gone", exitCode: number | null }
  // About the PROCESS. Never about the sandbox.

signalProcess(sandboxId, handle, kind: "cancel" | "kill", ctx): Promise<StopResult>
  // The REAL ladder: SIGTERM then SIGKILL, in-sandbox, to that handle.
  // `outcome: "ignored"` MUST be reachable — see the honesty clause below.

readonly processSupervisionMode: "none" | "handle"
```

**Three clauses that make it not-a-repeat of the defects it fixes:**

1. **★ `outcome: "ignored"` must be reachable on every implementer.** Today's
   `RealE2bTransport.signal` returns `{delivered: true}` on **both** branches including the catch
   (`real-transport.ts:181-186`), which is exactly why `CleanupAuthority`'s `kill` rung is dead
   (§1.3d). A `signalProcess` that always says "stopped" would rebuild that defect one layer up. The
   verdict must be **read from a subsequent `processStatus`**, not from the signal call's return.
2. **★ `processSupervisionMode: "none"` must be declared honestly where it is true.**
   `NetworkedProviderDriver` (`provider-wire/src/driver.ts`) will declare `"none"` for the same
   reason it declares `fileStagingMode: "none"` — `#post` is typed to the frozen vocabulary and
   there is no wire route. **Say so in the field's docstring, as CLI-008 Unit B did**, rather than
   claiming support that would silently drop every signal. The containerized/networked lane
   therefore **cannot run services** until an adapter-manager route exists; that is its own piece of
   work and this design does not smuggle it in.
3. **★ The E2B implementation is a code reading, not a provider measurement, and is labelled as
   such.** `real-transport.ts:128-131` records — from real E2B run 33789547290 — that
   `sandbox.commands.run()` is `start()` then `CommandHandle.wait()`, so a background-launch handle
   exists in the SDK and this transport simply does not expose it. **Whether `commands.run` accepts
   a background mode, what the handle exposes (a pid?), and whether an in-sandbox signal to it is
   possible were NOT verified against a real E2B account** — the SDK is not installed in this
   checkout and the isolation conformance suite's two call sites are keyless doubles (`E0-F015`).
   This carries the same label as §9.4 and for the same reason. **§9.5 is the open question.**

**And the fallback if §3.4 is refused**, stated so nobody has to infer it: the daemon may still be
built, but §3.1a binds it to emit `service_instance_started` (`starting`) and then **no
`service_health` at all**, with `service_instance_stopped` only when `execute` settles and
`gracefulStopSeconds` **explicitly not honoured**. That is truthful supervision of a service that
can never be reported healthy and can never be stopped gracefully. **Under §5.1 that does not earn
the capability widening** — which is the whole point of §5.

## 4. Failure modes — what the daemon does, for each

| # | Failure | What the daemon does | The mechanism it reuses |
|---|---|---|---|
| **4.1** | **Effect authority (owned-labels cap) nears expiry.** Unavoidable on any run > 5 min. | Re-materialize secrets on the tick, re-deriving the cap and rebuilding the per-run authorities — the SAME rebuild `runLifecycle` already performs once after redemption (`supervisor.ts:858-863` builds no-op authorities; `runLifecycle` rebuilds them over the real per-run driver). If re-materialization is refused (denied / non-`sandbox_local_only` seam / no control-plane key — `owned-labels-mint.ts:110-118` returns the outcome UNCHANGED in each case), treat it as a **stop deadline**: begin graceful stop NOW, while the current cap is still valid, so `destroy` still runs under authority. **★ Never continue past cap expiry**: that is precisely the orphan at `supervisor.ts:800-803`, and doing it deliberately would be a designed leak. **This is OPEN — §9.1.** |
| **4.2** | **The process exits on its own** (exit 0 or non-zero). | `processStatus` reports `exited` (or the un-awaited launch settles). Emit `service_instance_stopped` with `exitCode` (`events.ts:292-294`), then `terminal` (`succeeded` iff exit 0, matching the batch rule at `:792`), then `destroy`. **A service that exits is not a success by default and not a failure by default** — the exit code decides, and *whether an exit should be replaced* is SVC-004's. | §3.4 `processStatus`, existing `terminal` + `destroy` |
| **4.2a** | **★ The launch never establishes** — `startProcess` throws, or the command dies on line 1. | **This is the row revision 1 did not have, and its absence is §1.3(c).** No handle ⇒ **no `service_instance_started`**: the instance never leaves `leased`, and the run goes `terminal` `failed` + `destroy`. If the handle was acknowledged and the process then died immediately, that is 4.2 with a non-zero exit — **not** a started service that later stopped being healthy. The distinction is the whole difference between a recorded launch and a recorded fiction. | §3.4 `startProcess` (throws), `escalateCleanup` |
| **4.3** | **The process hangs / the sandbox is gone / the provider stops answering.** | **Three** distinct answers now; revision 1 had two and conflated the first with the third. (i) *Up but unhealthy* — `processStatus` says `running`, the health verdict is negative → `service_health` `"unhealthy"`, **keep supervising** (SVC-003 owns the kill policy). (ii) *Hung with no witness* — `processSupervisionMode === "none"`, so nothing can distinguish serving from wedged: the instance stays `starting`, **no `service_health` is emitted at all**, and the budget (§3.3) is the only terminator. (iii) *Sandbox gone* — `inspect` throws `SandboxNotFoundError` → `service_instance_lost` with a reason (`events.ts:297-299`), then `terminal` `failed`, then `escalateCleanup` (`supervisor.ts:349`). | §3.4, `inspect`, `escalateCleanup` |
| **4.3a** | **★ A stop is requested and the process ignores it.** | Emit `service_graceful_stop_observed` with `deadline = now + gracefulStopSeconds` (this event observes the **request**, and its payload is only `{ref, deadline}` — honest either way). Then `signalProcess("cancel")`, then re-read `processStatus`. **The verdict comes from the status read, never from the signal's return value** (§3.4 clause 1). Still `running` at the deadline → `signalProcess("kill")`, re-read again. Still `running` → **`service_instance_lost`, not `_stopped`**, then `escalateCleanup`. ★ `service_instance_stopped` is never emitted for a process that was not observed gone. | §3.4 `signalProcess` + `processStatus` |
| **4.4** | **Provider pause/resume** (the accepted E2B caveat, E9 README). | The frozen pair `service_provider_interrupted` / `service_provider_resumed` (`events.ts:302-311`) is emitted when `inspect` reports the sandbox suspended and then live again. **SVC-008 emits; it does not recover.** Recovery is checkpoint/restore = SVC-004. |
| **4.5** | **The lease expires mid-run / renewal is refused.** | **Unchanged from batch, deliberately.** The renewal driver closes the fence-close proxy first, then calls `Supervisor.onLeaseLost`, and every governed effect is denied locally (`lease-renewal.ts:20-25`). The service loop must therefore **check the run's cancelled/lost flag on every tick and stop emitting**, exactly as the batch path checks `run.cancelled` (`supervisor.ts:730`). ★ A service loop that keeps emitting after fence close would be the first daemon component to write past a closed fence. |
| **4.6** | **The control plane goes away** (events cannot be uploaded). | Unchanged: the encrypted SQLite event outbox (WRK-006) buffers, `event-upload.ts` retries without busy-spinning, and a session-terminal condition surfaces as lease loss (4.5). **SVC-008 adds no new durability assumption** — but it does add *volume*: a health tick per interval for hours. **§9.3.** |
| **4.7** | **The daemon restarts under a live service.** | Unchanged: WRK-007 restart recovery + orphan cleanup. The sandbox is reclaimed by label. SVC-008 does **not** attempt restart-in-place — a new instance after a daemon restart is a control-plane replacement decision (SVC-004). |

---

## 5. ★★★ What makes it safe to widen the constant

The docstring at `hello-provisioning.ts:24-26` states the rule this ticket has to satisfy: **"D4
forbids reporting a workload the daemon cannot run."** So the widening is not a step in the plan; it
is a *claim* that becomes true at a specific moment, and the honest form of this section is the exact
condition plus the way a reader checks it.

### 5.1 The condition, stated as a conjunction

`"workload.service"` may be added to `SUPERVISABLE_WORKLOAD_CAPABILITIES` **when all five hold, in
the same commit**. Revision 1 had four; clause 5 is new and clause 4 was factually wrong:

1. **A service branch exists and is reached.** `runLifecycle` dispatches on
   `handoff.offer.job.workloadType === "service"` to `runServiceLifecycle`, and the branch is
   covered by a test that fails if the dispatch is removed (§6, T1).
2. **A service run emits the instance events, not just `terminal` — and each one claims only what
   §3.1a permits.** At minimum `service_instance_started` on a launch that was *requested on a
   created sandbox* (asserting `starting`, nothing more) and exactly one of
   `service_instance_stopped` / `service_instance_lost` on end, `_stopped` only for a process
   **observed** gone. This is what makes the run *distinguishable from a batch run* to anyone
   downstream — the direct refutation of §1.2 — and §3.1a is what stops the refutation being
   replaced by a better-dressed falsehood.
3. **★ The run's authority outlives the run, or the run stops before the authority does.** Formally:
   for every service run, `destroy` is attempted while `run.capExpiresAt > now()`. This is the
   clause that is NOT satisfiable today (§1.3b) and is the whole of §9.1. **Until it is satisfied,
   the honest budget is 240 s and the honest advertisement is `workload.service` on a daemon that
   can run a service for four minutes.** Whether that is worth advertising is §9.1's real question.
4. **The advertised capacity is non-zero and real — and this clause is ALREADY SATISFIED, before
   SVC-008 exists.** ★ Revision 1 asserted `config.concurrency.service` "defaults to 0 today". It
   does not: `config/config.ts:186` reads `defaultValue: 1` and reads the same at this commit's
   parent, and the provisioned hello already reports `serviceSlots: config.concurrency.service`
   (`bin/worker-daemon.ts:529`). **So there is no config edit in this unit** (§2), and the clause
   reduces to a *preservation* obligation: the widening must not disturb the existing default, and
   the unprovisioned path's hardcoded `serviceSlots: 0` (`enrollment/desktop-hello.ts:183`) stays —
   an unprovisioned daemon advertising service slots would be a second false claim one field over.
   **What actually changes in SVC-008 is the capability advertisement (clause 1's constant), not the
   slot count.** Conflating the two is what made revision 1's T0 second mutant test a pre-existing
   invariant while presenting it as an SVC-008 regression; T0 is rewritten accordingly.
5. **★ NEW — every event the run emits is witnessed by an op the daemon actually called.** Formally:
   no `service_health` is emitted unless `processSupervisionMode !== "none"` and the verdict came
   from `processStatus`; no `service_instance_stopped` is emitted unless a status read or a settled
   launch observed the process gone; no `service_instance_started` is emitted unless `create`
   resolved a `sandboxId`. **This clause is NOT satisfiable today** (§1.3c, §1.3d) and it is what
   §3.4 exists to satisfy. Under the §3.4 fallback (no provider primitive), clauses 2 and 5 can both
   be met only by a daemon that never reports a service healthy and never stops one gracefully —
   which is truthful and does not earn the widening. **This clause, not clause 4, is the second
   blocker on the constant.**

### 5.2 How a reader checks it, without trusting this document

Four checks, each mechanical:

- **Is the branch reached?** `grep -n 'workloadType === "service"' packages/worker-daemon/src/supervisor/` returns a
  line in `runLifecycle`'s dispatch, and deleting it reds T1. (A branch that exists but is never
  dispatched to is this programme's most-repeated defect; a caller count is the check.)
- **Are the events emitted from the shipped path?** `grep -rn 'service_instance_started' packages/worker-daemon/src`
  returns a **production** file, not only a test. Today it returns nothing at all.
- **Does the authority outlive the run?** Read `RUN_OP_DEADLINE_CEILING_MS`
  (`run-op-deadline.ts:44-46`) and `OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS`
  (`owned-labels-mint.ts:46`). If the ceiling is still `TTL − headroom` and no re-mint path exists,
  clause 3 is **unsatisfied** and the widening is advertising a four-minute service. That is a
  two-file read, and it is deliberately the shortest of the three.
- **★ Is every emitted event witnessed?** `grep -n "processSupervisionMode" packages/worker-daemon/src/supervisor/provider.ts`
  returns a field, **and** `grep -n "isRunning\|getInfo" packages/sandbox-e2b-provider/src/real-transport.ts`
  is NOT reachable from whatever sources `service_health`. If `service_health` is sourced from
  `provider.health` on the E2B lane, clause 5 is **unsatisfied** and the daemon is emitting a
  sandbox-liveness answer as a process-health fact (§1.3c). One grep and one call-chain read.

### 5.3 What is NOT a sufficient condition, said out loud

- **Placement returning `leased` is not sufficient.** A lease proves the capability advertisement was
  believed, not that the run was supervised. The mis-supervised batch run of §1.2 would also be
  leased.
- **A green test suite over doubles is not sufficient for clause 3.** The capability window is a
  *server-minted* value; a fake provider and a fake clock can satisfy every assertion while the real
  cap expires. §6's T6 is written to fail on the real arithmetic rather than on a mocked expiry.
- **★★★ A green test suite over doubles is not sufficient for clause 5 EITHER — and here the doubles
  are actively misleading, which is worse.** `MockE2bTransport.signal` **honours `kind`** and really
  transitions the record: it returns `{delivered: false}` when `ignoreCancel`/`ignoreKill` is set and
  otherwise sets `record.state = "stopped"` (`mock-transport.ts:140-147`). `RealE2bTransport.signal`
  does none of that (`real-transport.ts:177-187`, §1.3d). **So the entire graceful-stop ladder — T3,
  and `CleanupAuthority`'s existing `kill` rung — passes on the mock and is vacuous against real
  E2B.** A double that is *more capable than production* is this programme's most expensive shape:
  it manufactures a green that means the opposite of what it appears to mean. §6 adds **T8** as the
  conformance test that catches this class, and §10 says who should file the underlying defect.

---

## 6. Test plan — each with the failing case that must be OBSERVED RED first

Every case names its red state and a mutant, because this programme's recurring defect is a test
that was green before the fix and nobody checked.

| # | Test | The failing case that must be observed RED **before** the fix exists | Mutant that must re-red it after |
|---|---|---|---|
| **T0** | **★ THE REACHABILITY TEST — a service job actually reaching a worker.** End-to-end against the existing placement harness: enroll a daemon whose ceiling includes `workload.service` and whose capacity has `serviceSlots ≥ 1`; submit a service job; assert `decideJobPlacement` returns a **`leased`/eligible** disposition naming that worker, and that the daemon's `poll` → `ack` path hands the offer to the supervisor seam. | **Red today and red for a structural reason:** with `SUPERVISABLE_WORKLOAD_CAPABILITIES = ["workload.batch"]`, `deriveHelloProvisioning` intersects `workload.service` away, so placement returns `queued` / `no_eligible_target`. Run it and watch the disposition, not an exception. | **One mutant, not two.** Revert the constant → `queued` → red. ★ Revision 1's second mutant ("revert the capacity default to 0") is **withdrawn as written**: `config.concurrency.service` already defaults to 1 at this commit's parent (§1.4), so setting it to 0 mutates code SVC-008 never touched and reds a **pre-existing** gate — it cannot represent a regression this unit introduces, and presenting it as one would overstate the mutant's coverage. It is retained, relabelled, as **T0′′** below: a guard on an invariant that was already true. |
| **T0′** | **★ What happens to the pinned negative, `u0-d1-placement-reachability.test.ts:324`.** It asserts `expect([...SUPERVISABLE_WORKLOAD_CAPABILITIES]).toEqual(["workload.batch"])` under a comment saying that if either ceiling widens, *"every reachability conclusion below is re-derivable rather than silently stale."* **It goes RED on the widening, and that is the test working, not breaking.** It is **updated, not deleted**: the assertion becomes `toEqual(["workload.batch", "workload.service"])`, the comment is kept verbatim, and **the conclusions below it in that file are re-derived rather than re-asserted** — specifically every case that concludes "the daemon is offerable batch and nothing else" must be re-read and either re-stated for service or explicitly narrowed to batch. ★ **Do not weaken it to `toContain`.** An exact-equality pin is what makes the NEXT widening (browser_session) announce itself; `toContain` would let a third workload in silently, which is the same hole one workload over. | The pin is currently green and must be **observed going red on the constant edit alone**, before any conclusion is re-derived. If it does not go red, the constant being read by the test is not the constant being edited. | Change the pin to `toContain` → the browser_session widening stops announcing itself. There is no automated mutant for that; it is a review rule, recorded here so it is refusable. |
| **T1** | **The service branch is dispatched.** A service handoff reaches `runServiceLifecycle`, a batch handoff reaches `runLifecycle`'s batch body. | **Red today: a service handoff runs the batch body and emits a batch-shaped `terminal`.** Build that assertion first and watch it produce `terminal` with no `service_instance_started` — this is §1.2 exhibited, and it is the strongest single argument in this ticket. | Delete the dispatch → the service handoff runs the batch body → red. |
| **T2** | **A service that does not exit stays supervised.** Fake clock; `execute` never settles. Assert: `service_instance_started` emitted once; **N** `service_health` events across N ticks; **no `terminal`**; the run is still active after the batch op-deadline (60 s) has passed. | Red today: the batch path races `execute` to `opDeadlineMs` and emits `terminal` with `errorCode: "execute_timeout"` at 60 s (`supervisor.ts:727-736`). The red state is that `terminal` appearing. | Restore `withDeadline(execute, opDeadlineMs)` on the service arm → `terminal` at 60 s → red. Drop the health tick → zero `service_health` → red. |
| **T0′′** | **The service slot gate, labelled as the PRE-EXISTING invariant it is.** Set `config.concurrency.service` to 0; assert the daemon advertises `serviceSlots: 0` and that placement/leasing refuses a service offer (`job-leasing.ts:505` pushes `"service"` only when `capacity.serviceSlots > live.service`). | **Not red today and never was** — `defaultValue: 1` at `config.ts:186` predates this ticket (§1.4). This test's honest job is to **prevent a future regression**, not to demonstrate one SVC-008 fixes. ★ Recorded this way because revision 1 presented exactly this mutant as an SVC-008 regression, and a mutant that reds on untouched code overstates what the unit is proven to do. | Remove the `serviceSlots > live.service` guard at `job-leasing.ts:505` → a zero-slot daemon is offered a service → red. |
| **T3** | **Graceful stop honours `gracefulStopSeconds` — against a provider that can actually refuse.** Deliver a `cancelRequested` renewal; assert `service_graceful_stop_observed` with a deadline `= now + gracefulStopSeconds`, then `signalProcess("cancel")`, then a `processStatus` read, then — only after the deadline lapses **with `processStatus` still reporting `running`** — `signalProcess("kill")`, another status read, then `service_instance_stopped`, then `terminal`, then `destroy`, **in that order**. | Red today for **two** reasons, and revision 1 named only the first. (i) No stop path exists; the run ends only when `execute` settles. (ii) ★ **Even a correct-looking implementation is untestable against the real provider**: `provider.cancel`/`kill` are one `getInfo` that always answers `delivered: true` (§1.3d), so the ladder never escalates and `service_instance_stopped` would fire on a live process. **T3 must therefore be written against `signalProcess`/`processStatus` (§3.4), not `cancel`/`kill`** — a T3 written against the old ops is green on the mock and meaningless on E2B. | Swap `cancel`→`kill` (skip graceful) → the ordering assertion reds. Read `gracefulStopSeconds` from the wrong field (or default it) → the deadline assertion reds. **★ Derive the stop verdict from `signalProcess`'s return value instead of a `processStatus` read** → the test still passes on the mock (which honours `kind`) and the real lane silently regresses → **caught by T8, not by this mutant**; that is exactly why T8 exists. **Assert the SEQUENCE, not the set** — a set assertion passes under a supervisor that kills first and emits the graceful event afterwards. |
| **T4** | **The provider does not advertise `health`.** Assert **zero** `service_health` events and that supervision continues. | Red against the naive implementation, which synthesizes `healthy` when it cannot ask. Build that variant and watch a fabricated health signal appear — it is the failure class, in miniature. | Synthesize `healthy` on the unadvertised path → a `service_health` event appears → red. |
| **T5** | **Fence close stops the loop.** Trigger lease loss mid-supervision. Assert: no further `service_health` after the close, `onLeaseLost` cleanup converges, and **nothing is emitted past the closed fence**. | Red against a loop that does not consult the cancelled/lost flag — which is what a first implementation does, because the batch path only needs the check at one point. | Remove the per-tick cancelled/lost check → post-close emissions → red. |
| **T6** | **★ The authority clause of §5.1(3), tested on the real arithmetic.** With `capExpiresAt` derived from the actual constants (`OWNED_LABELS_CAPABILITY_DEFAULT_TTL_MS` and `RUN_TEARDOWN_HEADROOM_MS`, imported, not hardcoded), run a service past the cap window. Assert: **either** the cap was re-materialized and `destroy` ran under a valid cap, **or** graceful stop began before expiry and `destroy` ran under the original cap. Assert `recordOrphan` was **not** called. | **Red today and red under the obvious implementation**: a service loop that just keeps ticking reaches `destroy` with an expired cap and `recordOrphan(run, "cap_expired_before_happy_destroy")` fires. That orphan **is** the red state, it is reachable, and it must be run and seen. | Delete the cap-freshness step from the tick → `recordOrphan` fires → red. Hardcode the TTL in the test instead of importing it → the test survives a constant change that would break production → **caught by review, not by a mutant**; recorded here as the reason for the import. |
| **T7** | **Capacity accounting.** A daemon with `serviceSlots: 1` running one service refuses a second service offer (`poll-loop.ts:541-542` concurrency class) and still accepts a batch offer. | Red today only in that nothing dispatches; the *class* separation is already shipped, so this test's job is to prove SVC-008 did not collapse the classes. | Make the limiter key on a constant instead of `workloadType` → the batch offer is refused → red. |
| **T8** | **★★★ THE DOUBLE-VS-PRODUCTION CONFORMANCE TEST — the one that catches the class §5.3 names.** A **transport-level** test asserting, for **every** `E2bTransport` implementation in the tree, that a `signalProcess`-class refusal is representable: given a target configured to ignore the signal, the implementation reports the process still running on the follow-up status read. Run it against `MockE2bTransport` **and** against `RealE2bTransport` in the keyed lane (`E2B_API_KEY` present). | ★ **Red today, and red in a way that is the finding**: `MockE2bTransport.signal` honours `kind` and can return `{delivered: false}` (`mock-transport.ts:140-147`); `RealE2bTransport.signal` ignores `_kind` and returns `{delivered: true}` on both branches (`real-transport.ts:177-187`). **The mock is strictly more capable than production**, so the existing ladder tests are green and vacuous. Run both arms and watch them disagree — that disagreement is §1.3(d), and it is also why `CleanupAuthority`'s `kill` rung has never executed on real E2B. | Give the real implementation a hardcoded `delivered: true` again → the arms disagree → red. ★ **Delete the real arm and keep only the mock** → green, and meaningless — there is no automated mutant for that, which is precisely why the test must name both implementations by construction (a directory walk over transport implementers, not a hand-listed pair). |

**Windows** runs the integration arms via `AOA_RUN_WIN_INTEGRATION=1`; otherwise Linux CI. **T8's
real arm runs only in the keyed E2B lane and must be reported as SKIPPED, never as passed, when the
key is absent** — a keyless "green" on the arm whose whole purpose is to disagree with the double
would be the failure class one level up.

---

## 7. Sequencing — why the constant is IN this unit and the control-plane consumer is NOT

The commissioning measurement proposed three units (daemon supervisor / control-plane consumer /
the constant) and suggested the constant last.

**The constant belongs in THIS unit, not after it.** Splitting them creates a window in which the
daemon advertises `workload.service` and nothing supervises it — which is §1.2's mis-supervision,
deliberately shipped. The docstring's rule ("D4 forbids reporting a workload the daemon cannot run")
is a conjunction, and §5.1 is its **five** clauses; a commit that satisfies clauses 1-2-4 and widens
the constant is a commit that made the docstring false. **The widening is one line and it is the last
line of this unit's diff.**

**★ And the provider primitive belongs BEFORE it, which revision 1 did not see.** §5.1 clause 5 says
the events must be witnessed; §3.4 is the only thing that can witness them; §3.4 lands on five
implementers and a conformance surface. **That is not the last line of a diff — it is a unit.** §11
is the resulting sequence, and it is the honest answer to "is SVC-008 still one unit?": **no.**

**The control-plane consumer is NOT in this unit, and the cost of that is stated rather than hidden.**
Ingest is generic — `toAcceptInputs` (`job-events.ts:58-78`) durably appends **any** event type and
sets `terminalStatus` only for `terminal`, so every `service_health` /
`service_instance_started` / `_stopped` / `_lost` SVC-008 emits **is durably stored and projects no
state change**. `recordServiceHealth` keeps its zero production callers. That is honest evidence (the
rows exist, are fence-checked and are queryable) and it is **not** convergence. Wiring the projection
is SVC-003's, because deciding what a health event *means for ownership* is literally SVC-003's
Outcome ("Health events do not extend ownership without a successful lease renewal").

---

## 8. What this unit does NOT do, and which ticket owns each

- **Health *semantics*, liveness deadline, bounded lease renewal, fencing an unreachable worker,
  and the `service_health` → `recordServiceHealth` projection → SVC-003.** SVC-008 emits a health
  observation from the provider's own verdict and draws no conclusion from it. It also does not
  touch `ServiceHealthStatus` (`tenant/job-control.ts:620`) — that is **E9-F001**, SVC-003's.
- **Restart, backoff, crash-loop terminalization, checkpoint prepare/restore → SVC-004.** SVC-008
  emits `service_checkpoint_prepared`/`_restored` **never** — it does not call `checkpoint` or
  `restore` at all, even though the port has them (`provider.ts:402-403`). A checkpoint with no
  policy about when to take one and no consumer is a leak of scope.
- **Pause, drain of a running instance, generation rollout, budget/TTL stop, `generation` bumps →
  SVC-005.** SVC-008 **reads** `generation` off the workload and stamps it into every event; it never
  writes or compares one. It reuses the existing `cancelRequested` control signal and adds no
  service-specific stop verb.
- **Duplicate placement, the reconciler, desired state → SVC-002.** SVC-008 has no opinion about how
  many instances should exist; it supervises the one it was handed.
- **Lifting `boundedDemand`'s `Math.min(600, …)` → SVC-002 or SVC-003.** §9.2 explains why it is not
  free and why SVC-008 does not take it.
- **Any control-plane route, UI, or human path to create a service → SVC-007.** After SVC-008 there
  is still no way for a person to start a service.

---

## 9. ★ Open questions this design could not settle

**9.1 — Should the daemon re-mint the owned-labels capability mid-run, and if so how?** This is the
question §5.1(3) turns on and the only one that decides whether `workload.service` means anything.
Three answers, none obviously right. **(a) Re-materialize secrets on the tick** — the route exists
(`/worker-control/execution-secrets/resolve`), the mint is a pure function of the resolve outcome
(`applyOwnedLabelsCapability`, `owned-labels-mint.ts:110-118`), and the supervisor already knows how
to rebuild per-run authorities. Against: it re-runs a **secret resolution** on a schedule, which
widens the blast radius of a compromised worker from one materialization to N, and nobody has ruled
on that. **(b) Issue a fresh cap on lease renewal** — architecturally cleaner (the cap is already
lease-clamped, so binding its refresh to renewal is coherent), but it is a **server** change on the
renew route (`worker-control.ts:511`) and therefore not SVC-008's to make. **(c) Accept the ceiling
and ship a four-minute service** — defensible only if E9's acceptance language is amended to say so,
which is a founder-level edit to the epic, not a ticket decision. **Not decided here.** Whoever rules
should note that (b) also fixes long batch runs, which have the identical orphan today.

**9.2 — Is a service exempt from `boundedDemand`'s `Math.min(600, …)`?** (`job-placement.ts:198`.)
The measurement called it a hard ceiling; §1.4 shows it is a demand assertion, so lifting it is not
free in the direction people assume: **raising** the demanded runtime *narrows* the candidate set
(`providerDemandFits`, `:509-511` refuses any candidate whose `maxContinuousRuntimeSeconds` is below
the demand), so a service demanding 604 800 s would be placeable only on a fleet advertising a
seven-day continuous runtime. The honest options are "leave it and accept that a service's *recorded*
demand understates its runtime" or "derive the demand from the workload for service only". **Not
decided here**, and it is a control-plane decision — SVC-002's or SVC-003's, not SVC-008's.

**9.3 — What is the health tick interval, and who bounds the event volume?** A 10-second tick over
72 hours is ~26 000 `service_health` rows per instance in `job_events` — durably stored, fence-checked,
and (until SVC-003) projecting nothing. A 60-second tick is ~4 300. The frozen wire imposes no rate.
The interval interacts with SVC-003's liveness deadline, so choosing it here would pre-empt SVC-003.
**Recorded, unmade.** Whoever picks it should say what the retention story is, because
`FINDING-retention-authority-and-DE-11.md` says nobody currently owns one.

**9.4 — Does anything extend an E2B sandbox's TTL after `create`?** Measured: `transport.setTimeout`
is called only from `create` (`e2b-provider.ts:326-327`), and the frozen provider port
(`provider.ts:385-404`) has no extension operation. So a service's whole lifetime is fixed at create
time by `ctx.deadlineMs`. If the answer to 9.1 is (a) or (b) and the budget rises above the E2B
template's own maximum, this becomes the next binding constraint. **Not investigated against a real
E2B account** — the two call sites of the isolation conformance suite are both keyless doubles
(recorded in `E0-F015`), so this claim is a code reading, not a provider measurement, and it is
labelled as such.

**9.5 — ★ Can E2B actually support the §3.4 primitive, and who owns the port change?** Two halves,
neither settled.

**(i) The provider question.** `real-transport.ts:128-131` records, from real E2B run 33789547290,
that `sandbox.commands.run()` is `start()` then `CommandHandle.wait()` — so a background-launch
handle **exists in the SDK** and this transport collapses it. But whether `commands.run` exposes a
background mode on the version pinned here (`e2b: ^2.30.5`), what the handle carries (a pid?), and
whether an in-sandbox SIGTERM/SIGKILL to it is reachable were **NOT verified against a real E2B
account or even against an installed SDK** — the package is not present in this checkout, so §3.4 is
specified from a comment in this repo plus the port's own shape. **Same label, same reason, as 9.4.**
If the answer is no, §3.4 is unbuildable for E2B and §11's recommendation collapses to the §3.4
fallback: a service that can never be reported healthy, which does not earn the widening.

**(ii) The ownership question.** §3.4 changes `SandboxProvider` and lands on `E2bSandboxProvider`,
`RealE2bTransport`, `MockE2bTransport`, the fake provider (`sandbox-fake-provider`), and
`NetworkedProviderDriver` (`provider-wire`), plus the conformance surface
(`sandbox-provider-contract`). **That is E4/CLI's port, not E9's.** SVC-008 can specify it and can
consume it; it should not be the ticket that lands it. **Not decided here** — §11.1 proposes the
split and names what a ruling would have to say.

---

## 10. Register obligations for the landing commit

- **E9-F002 is repointed from `unowned` to `owned` by SVC-008** in `../findings.md` and
  `scripts/finding-ownership.json`, in the same commit as this document — SVC-008 now has a file on
  disk and a `#### SVC-008` node in `program-design.md`, which is the existence bar
  `owner_ticket_missing` enforces (`scripts/lib/finding-ownership.mjs:417-424`). **The finding stays
  `open`**: a design is not a supervisor, and its stated resolution ("a daemon advertises
  `workload.service` and a service job is observed leased") is T0, which this document plans and does
  not run.
- **E9-F002's own text is amended** to carry §1.3 — the run budget, the never-re-minted capability,
  **and (revision 2) the two provider gaps**. Its current §1 chain is correct and incomplete, and a
  finding that names only the smallest of five blockers will be closed by fixing the smallest of
  five.
- **★ The provider defect of §1.3(d) is FILED, and it is filed in E7 — not here.** It is now
  **[E7-F034](../../E7-coding-e2b/findings.md#e7-f034)** (`open` · `unowned` · **MEDIUM**), with
  **T8 (§6) named as its resolution test**. The jurisdiction
  reasoning stands: "`RealE2bTransport.signal` ignores `_kind` and always reports delivered, so
  `CleanupAuthority`'s `kill` rung is unreachable on the real provider and `MockE2bTransport` is
  strictly more capable than production" is a defect in the **`packages/sandbox-e2b-provider`
  transport lane**, affecting **batch today**, not only services, and E9 does not file into another
  epic's register. **What was wrong was leaving it recorded ONLY here.** A live defect in this §10
  is invisible to `scripts/check-finding-ownership.mjs`, which globs only
  `docs/replatform/epics/*/findings.md` — the same invisibility class this programme closed
  elsewhere. Filing it `unowned` **with a reason** is the manifest's own provision for "no successor
  exists yet"; that is not an orphan, it is the orphan being declared. **This document is no longer
  the record — E7-F034 is.**
- **★ Two of this document's own claims were CORRECTED by that re-verification**, and the corrected
  versions are in E7-F034 rather than here. (i) **Nothing is leaked.** Both ladder call sites run a
  forced `destroy` *unconditionally, outside the `if`* (`cleanup-authority.ts:293-307`;
  `per-op-adapter.ts:271-275`), so the sandbox is reclaimed regardless of the cancel outcome — what
  is lost is the **rung**, not the resource. (ii) **The "vacuous ladder tests" are 5 cases across 3
  distinct doubles, only 1 of which is `MockE2bTransport`**; the three `CleanupAuthority` tests use
  `worker-daemon/src/__tests__/support/fake-provider.ts` and never touch E2B code at all. §1.3(d)'s
  and T8's wording are left as written — they record what was measured on the day — and E7-F034
  carries the corrected pins.
- **A gate-clause entry is NOT added.** `countProductionCallers`
  (`scripts/check-gate-clause-wiring.mjs:155-186`) returns 0 for a symbol that does not exist and an
  `unwired` clause with count 0 **passes**, so a clause naming `runServiceLifecycle` today would be
  admitted and would assert nothing — this programme's defining failure class. **The SVC-008
  implementation commit adds `E9-2-service-supervisor`, `unwired`, symbol `runServiceLifecycle`.**
- **No `ownerTicketDeferrals` entry is created or removed by this commit.**

---

## 11. ★★★ THE CONCLUSION, RESTATED — what this ticket actually is after review

Revision 1 concluded: *"Nothing here needs a wire change, so this is a design and not a decision
request."* **That conclusion was built on a conflation and it is withdrawn.** The honest version:

### 11.1 The two claims, separated

- **A WIRE change is NOT required.** Every event, payload, status, frozen operation name and
  capacity field is already on disk in frozen v1 (§0.1). **No Protocol Custodian STOP.** This
  survived review and survives the split below — including §3.4, which follows the shipped
  `stageFiles` precedent of declaring non-frozen port methods behind a mode field (§0.2).
- **★ A PROVIDER change IS required.** Plainly: **the `SandboxProvider` port cannot witness that a
  process started, cannot tell whether it is still running, and cannot stop it.** Three of the nine
  frozen service events assert facts no implementation of the current port can produce. **SVC-008
  as scoped in revision 1 cannot be implemented as written** — not "is harder than expected", but
  "would durably record claims nothing observed", which is the D4 harm this ticket exists to
  prevent.

### 11.2 Is SVC-008 still one unit? **No.** The recommended split

| Unit | Contents | Size |
|---|---|---|
| **SVC-008a — provider process supervision** | §3.4: `startProcess` / `processStatus` / `signalProcess` + `processSupervisionMode` on `SandboxProvider`; implemented on `E2bSandboxProvider` + `RealE2bTransport` + `MockE2bTransport`; declared `"none"` **honestly** on `NetworkedProviderDriver`; the fake provider; the conformance surface; **T8**. No daemon behaviour change, no event emitted, **no capability widening**. | **Larger than the daemon half.** Six packages, and it is **E4/CLI's port, not E9's** (§9.5 ii). |
| **SVC-008b — the daemon service supervisor** | Everything else in this document: `service-lifecycle.ts`, the `runLifecycle` branch, the `run-op-deadline.ts` service arm, §3.1a's event-claim rule, §4's failure table, T0–T7, and **the constant widening as the last line of the diff**. Depends on 008a for §5.1 clause 5. | The unit revision 1 described, minus the config edit that does not exist. |

**The dependency is hard, not stylistic.** 008b without 008a can be *built* — §3.4's fallback — but
it produces a daemon that emits `starting`, never `healthy`, never honours `gracefulStopSeconds`, and
therefore **fails §5.1 clause 5 and does not earn the widening**. Shipping 008b alone and widening
anyway is the mis-supervision of §1.2 with better events.

### 11.3 The plain statement, for anyone reading only this section

**This needs a provider primitive first.** The wire is ready and has been all along; the provider is
not, and no amount of daemon code closes that. An honest design that says so is worth more than one
that reads as implementable and would, on its first real run against E2B, durably record a service
as started and healthy when nothing had checked either.

### 11.4 What review did NOT change, recorded so it is not lost in the correction

Three of revision 1's findings were challenged, re-verified, and stand unweakened:

- **The 5-minute effect-authority window** — `min(authorityNow + shortTtlMs, leaseDeadline)`
  (`owned-labels-mint.ts:46,92`), minted on **exactly one route**
  (`/worker-control/execution-secrets/resolve`, `worker-control.ts:709,764-765`) and **not** on
  `/leases/:leaseId/renew` (`:511`). §1.3(b), §4.1, §9.1 stand as written.
- **The 60-second budget fallback and its 240-second ceiling** — `serviceWorkloadV1Schema` carries no
  `maxRuntimeSeconds`, so `resolveRunOpDeadlineMs` falls to `RUN_OP_DEADLINE_FLOOR_MS`, and
  `RUN_OP_DEADLINE_CEILING_MS = TTL − headroom = 240_000`. §1.3(a) and §3.3 stand as written.
- **The absence of a TTL-extension operation** (§9.4). Stands, with its original "code reading, not a
  provider measurement" label intact.

These were independently valuable and are **not** superseded by §1.3(c)/(d) — they are three
independent blockers, and §11.2's split resolves none of them. Even with 008a shipped, a service run
longer than five minutes still ends in a billable orphan until §9.1 is ruled on.
