# SVC-008b — the daemon service supervisor, and the capability widening — RESULT

**Epic:** E9 · **Lane:** worker-daemon · **Base:** `fffc7e1de` (branched from `docs/replatform-program`)
**Design:** `SVC-008-design.md` §11.2 (the 008b half) · **Depends on:** SVC-008a (`088de1084`)
**Register:** E9-F002 **NARROWED, NOT CLOSED**; gate clause `E9-2-service-supervisor` enrolled `wired`.

---

## 1. What shipped, in one paragraph

`runLifecycle` now dispatches `workloadType === "service"` to a new sequencer
(`supervisor/service-lifecycle.ts`) that launches the workload with SVC-008a's `startProcess` — an
**acknowledgement**, not a completion — emits `service_instance_started` meaning `starting` and
nothing more, health-ticks from `processStatus` (never from the frozen `health` op, which answers
about the sandbox), runs a real cancel→kill graceful ladder whose verdict comes from an
**observation** rather than from `ProcessSignalResult.accepted`, and emits exactly one of
`service_instance_stopped` / `service_instance_lost` before the attempt `terminal`.
`resolveRunOpDeadlineMs` gains a service arm. `SUPERVISABLE_WORKLOAD_CAPABILITIES` gains
`workload.service` — **in the same commit as the supervisor branch, never ahead of it**, because
advertising before the branch existed would have shipped SVC-008 §1.2's mis-supervision
deliberately. (An earlier draft called this "the last line of the diff". That reads like a
checkable property and is not one — this is one commit, and the file is not last in file order.
Same-commit is the property that is real.) Zero wire change: every event,
payload and status is frozen v1 and already on disk.

---

## 2. The capability widening, enumerated

The instruction that governs this section is that a widening is exactly the shape that silently
enables things, so here is what became supervisable that was not, and whether it is intended.

| What changed | Intended? | Why |
|---|---|---|
| A daemon whose **admin-ratified ceiling** grants `workload.service` now **reports** it, so placement can lease it a service job | **Yes** — this is the ticket | `deriveHelloProvisioning` intersects the ceiling with `SUPERVISABLE_WORKLOAD_CAPABILITIES`; the widening is what stops the intersection removing it |
| A daemon whose ceiling does **not** grant it | **Unaffected** | The intersection still removes it — the widening raises no ceiling, it stops narrowing one |
| `workload.browser_session` | **Not widened** | Still absent from the set and still filtered out; its supervisor is BRW's |
| `config.concurrency.service` (default 1) and the provisioned hello's `serviceSlots` | **Untouched** — and they were already true before this ticket | SVC-008 §1.4 corrected revision 1's claim that the default was 0. It reads `defaultValue: 1` at the base commit, so there is no config edit in this unit |
| The **unprovisioned** path's hardcoded `serviceSlots: 0` | **Untouched, deliberately** | An unprovisioned daemon advertising service slots would be a second false claim one field over |
| `Supervisor.onLeaseLost` no longer delegates to `cancel` | **Yes**, and it is a no-op for batch | It now takes the non-graceful stop path. `run.serviceStop` is null on every batch run, so the graceful block is unreachable there and batch behaviour is byte-identical. For a service it is §4.5: a closed fence is not a negotiation |
| `EffectAuthority.startProcess` / `.processStatus` / `.signalProcess`, and `deriveStopVerdict` | **Yes** — this is the consumption SVC-008a named | They shipped with **zero production callers**, which made their clauses vacuously true. §5 has the measured counts |

**Every new member of the widened set is exercised by a test that was observed red first.** The
widening is not a claim here; `service` is the only new member and T0 is its proof.

---

## 3. Reds observed, and the named positive control

Every case below was run against the **unchanged tree at `fffc7e1de`** before any implementation
existed. The assertions go through `createSupervisor` + the fake provider — never against the new
module in isolation, because a unit test over a not-yet-existing module reds on "cannot import",
which proves nothing about the shipped path.

**`packages/worker-daemon/src/__tests__/svc-008b-service-supervisor.test.ts` — 12 failed / 2 passed.**

| Case | Red observed |
|---|---|
| T1 dispatch | `expected 1 to be +0` — `execute` was called once; the service ran the batch body |
| T1 identity | `expected null to deeply equal {…}` — no `service_instance_started` anywhere |
| T1 exit | `expected -1 to be greater than -1` — no `service_instance_stopped` |
| T2 supervision | `expected 0 to be greater than or equal to 3` — zero `service_health` |
| T3 ladder | `expected false to be true` — no ladder, and the settle timed out |
| T3 lost | `expected false to be true` |
| T4 unwitnessed | `expected ['attempt_started','terminal'] to include 'service_instance_started'` |
| T4 `"none"` mode | `expected {status:'succeeded',…} to match {status:'failed',…}` — **the finding in one line: a service on a provider that cannot supervise processes was reported SUCCEEDED** |
| T4 refused launch | same shape |
| T5 fence | `expected false to be true` |
| T6 authority | `expected … not to contain 'cleanup_outcome{outcome="orphaned"}'` — the batch body destroyed past the cap and orphaned a billable sandbox |
| contiguity | `expected 2 to be greater than 3` |

**GREEN BEFORE AND AFTER — the named positive control:**
`POSITIVE CONTROL — batch is untouched: create → execute → terminal(succeeded) → destroy`. It stayed
green in the red run, in the green run, and under **every** mutant in §4. Had it reded alongside the
service cases, the harness broke rather than the feature.

**Also green before and after: T7.** Recorded as what it is — a **pre-existing invariant**, not a
regression this unit fixes. The workload concurrency classes were already separated
(`poll-loop.ts` keys the limiter on `offer.job.workloadType`); T7's honest job is to prevent
SVC-008b from collapsing them. SVC-008 §6 makes the same point about revision 1's withdrawn mutant,
and presenting T7 as a demonstrated fix would overstate what this unit is proven to do.

**`server/src/__tests__/u0-d1-placement-reachability.test.ts` — 2 failed / 4 passed before the
widening.** T0: `expected ['workload.batch'] to include 'workload.service'` — red **for a structural
reason**, not an exception: `deriveHelloProvisioning` intersects `workload.service` away regardless
of the ceiling. The T0′ pin reded on the same edit, which is the pin working.

---

## 4. Mutants killed

Each was applied to the shipped source, run, and reverted. The count is the number of cases that
reded; the positive control was green in all six.

| Mutant | Result |
|---|---|
| Delete the service dispatch (`if (false)`) | **12 red** |
| Synthesize `healthy` when the status read could not answer | **1 red** (T4 unwitnessed) |
| Derive the stop verdict from `ProcessSignalResult.accepted` instead of its observation | **2 red** (T3 ladder + T3 lost) |
| Drop the per-tick fence check | **1 red** (T5) |
| Drop the capability-freshness stop | **1 red** (T6) |
| Kill first, skipping the graceful rung | **1 red** (T3 ordering — the assertion is on the SEQUENCE, not the set) |
| Revert `SUPERVISABLE_WORKLOAD_CAPABILITIES` to `["workload.batch"]` | **2 red** (T0 + the pin); both batch cases stayed green |

★ **One near-miss worth recording.** The first two mutant attempts on `hello-provisioning.ts` used
`\n` in a `String.replace` against a **CRLF** working tree, matched nothing, and the suite came back
green — a mutant that "survived" because it was never applied. The fix is the rule this programme
already knows: a mutant must be **verified applied** (here, by grepping the rebuilt `dist/` for the
mutated array) before its result means anything.

---

## 5. Caller counts — measured, not asserted

Using the register's own `countProductionCallers` (comments, imports, re-export blocks and string
literals stripped), at `fffc7e1de` vs. this branch:

| Symbol | Before | After |
|---|---|---|
| `runServiceLifecycle` | — (did not exist) | **1** — the `workloadType === "service"` branch in `runLifecycle` |
| `parseServiceWorkload` | — | **1** |
| `SERVICE_HEALTH_TICK_MS_DEFAULT` | — | **1** |
| `finishRun` | — | **2** (batch arm + service arm; extracted verbatim so the orphan check cannot drift per workload type) |
| `stopRun` | — | **3** (`cancel`, `onLeaseLost`, `shutdown`) |
| the five `EventSequencer` service emitters | — | 2–3 each |
| `EffectAuthority.startProcess` | 10 | **11** |
| `EffectAuthority.processStatus` | 15 | **16** |
| `EffectAuthority.signalProcess` | 10 | **11** |
| `deriveStopVerdict` | **0** | **2** |

★ `deriveStopVerdict` is the one that matters. SVC-008a shipped it with **zero** production callers
and disclosed that "SVC-008b's service loop is the consumer". Until this commit its clause — the
stop predicate stated once so no caller re-derives it wrong — was **vacuously true**. It is now
load-bearing, and mutant 3 above is what proves it.

The chain above `runServiceLifecycle` is real: `createSupervisor` → `accept` → `runLifecycle`, and
`createSupervisor` is composed in production by `lifecycle/dispatch-runtime.ts` (called from
`bin/worker-daemon.ts`). **Note for a future reader:** `supervisor/events.ts` carries a docstring
saying *"`createSupervisor` has zero production callers"*. That sentence is **stale** — it has four
references and a real composition root. It is left untouched here because correcting a neighbouring
comment is not this diff's job, but it should not be read as evidence.

---

## 6. Deviations from the design, each with its reason

Stated rather than silently narrowed.

**6.1 — §3.3's budget source does not exist on the worker side of the wire.** The design specified
`min(profile.maxContinuousRuntimeSeconds * 1000, CEILING)` and asserted "the handoff carries the
resolved target, so the value is available without a wire change". **Measured false:** the job
envelope carries only a provider-constraint **reference** (`{profileId, version, digest}`), and
`maxContinuousRuntimeSeconds` is read nowhere on the worker side — its only readers are
`job-placement.ts` and `job-leasing.ts`, both server-side. The service arm therefore returns the
**ceiling**, which is the honest bound anyway (it is exactly the effect-authority window). What is
lost: a fleet advertising **less** than 240 s of continuous runtime would get a budget above its own
profile — bounded by the server, since `providerDemandFits` refuses any candidate whose profile is
below the demanded runtime, so such a target is never offered the job.

**6.2 — §3.2 step 3's `inspect` liveness tick is not implemented.** `EffectAuthority` has no
`inspect`, and adding one would widen a **disclosure** surface: the op returns the full, unredacted
`InspectResult` (`command`/`env`/`logs`/`secrets`/`objectGrants`), which is precisely why it lives on
`CleanupAuthority`, whose contract is to return only a `RedactedResourceProjection`. The signal is
already representable without it: SVC-008a's `ProcessUnknownReason` includes `"sandbox_unreachable"`,
which both the real and mock transports produce, and it arrives through the process-scoped op. It is
an `unknown` — "a read that was attempted and did not answer" — so it is **not** laundered into an
affirmative absence; a sandbox that stays unreachable rides the loop to its budget, where the
ladder's undetermined verdict lands on `service_instance_lost`. SVC-003 owns the liveness *deadline*.

**6.3 — §4.4's `service_provider_interrupted` / `_resumed` are not emitted, and no emitter exists.**
§4.4 names `inspect` reporting the sandbox "suspended and then live again" as the witness.
`SandboxState` has no suspended or paused inhabitant — `creating`/`running`/`cancelling`/`stopped`/
`destroyed`/`failed`. Adding the emitter would hand a caller a durable claim nothing in this tree can
witness, which is §1.3(c) one event over. **Not built, and the absence is the honest answer.**

**6.4 — §4.3a's "re-read again" after each signal rung is one call, not two.** SVC-008a's port
defines `signalProcess` as "deliver the signal, then **re-read** its status and report what that read
saw", so `ProcessSignalResult.observation` **is** the re-read; a second caller-side `processStatus`
would be an extra provider round-trip that cannot see anything the first did not. The property the
design wanted is preserved and tested: the verdict comes from an observation, never from `accepted`
(mutant 3). The **graceful window itself is still polled** with real `processStatus` reads, so a
process that stops on its own inside it is never escalated to a kill.

**6.5 — §4.1's cap re-materialization is NOT implemented; only its other arm is.** §4.1 offers
"re-materialize secrets on the tick" or "treat it as a stop deadline". SVC-008b takes the second.
The first is SVC-008 §9.1 and is **unruled**: it re-runs a secret **resolution** on a schedule,
widening the blast radius of a compromised worker from one materialization to N, and this ticket has
no standing to decide that. The consequence is §7.

---

## 7. The residual, stated plainly

**A service supervised by this daemon runs for at most 240 seconds.** The owned-labels effect
authority is minted with a 5-minute TTL on exactly one route and is never re-minted, so the supervise
loop stops on the teardown headroom and destroys under a valid cap rather than continue past its own
authority and leak a billable sandbox. That is honest and it is also, plainly, a short service.

This is why **E9-F002 stays open**. Its resolve criterion in `scripts/finding-ownership.json` is a
**conjunction** — T0 green **and** blocker (3) answered rather than deferred, or E9's acceptance
language amended — and only the first conjunct holds. Half a conjunctive clause may not be enrolled
as delivery; the register's own `$comment` records that lesson from earlier the same day. What would
close it: a ruling on §9.1, or an amendment to E9's acceptance language with DE-12's
`deliveryEvidence` corrected to carry the reason.

**Also still not true after this:** nothing *creates* a service. SVC-008b adds **no consumer** of
`recordServiceHealth` and **no `service_health` projection** — its `countProductionCallers` reading
is **2 at base and 2 at head**, unchanged by this diff. ★ RETRACTED: an earlier draft of this
paragraph said `recordServiceHealth` "keeps its zero production callers", which is false against the
very instrument this document cites — the two are its interface declaration and its implementation,
and the register's counter has always reported them. The substance is unchanged (no new consumer, no
state projection); the number was wrong, and a result document asserting a figure its own cited
instrument contradicts is the failure class E9-F001 exists to record. Ingest is generic, so every
service event emitted here is durably stored and
**projects no state change**. Wiring that projection is SVC-003's; restart and checkpoint are
SVC-004's; drain and generation are SVC-005's; the human path is SVC-007's. The acceptance sentence
is *"a service job reaches a worker and is supervised as a service"*, never *"services are managed"*.

---

## 8. Register changes in this commit

- `scripts/gate-clause-wiring.json`: **added** `E9-2-service-supervisor`, `wired`, symbol
  `runServiceLifecycle`. Enrolled `wired` rather than the `unwired` SVC-008 §10 predicted, because
  that line was written while the widening was still hypothetical — the symbol now has a real
  production caller, and declaring `unwired` with a non-zero count would fail the guard as
  `unwired_but_now_has_caller`.
- `docs/replatform/epics/E9-service-agents/findings.md`: E9-F002 **narrowed**, per-blocker table,
  status left `open`.
- `scripts/finding-ownership.json`: E9-F002 repointed **`owned`/SVC-008 → `unowned`**, with the
  residual, what it blocks, and the resolve criterion written out. **The key is not deleted.**

  ★ **This was forced by a guard, and the guard was right.** Adding `SVC-008b-result.md` makes
  SVC-008 *shipped* on disk, and `check-finding-ownership.mjs` immediately failed the commit with
  *"owned by a ticket that has already SHIPPED — owned by nothing"* + *"names no `successor`"*
  (E4-F013). The natural inheritor of the §9.1 residual is **SVC-003** — its `program-design.md`
  node is literally "Long-session lease and health semantics", and §9.1 option (b) is a change to
  the renew route that §9.1 itself calls *"not SVC-008's to make"*. But SVC-003 has **no ticket
  file**, and `successor` is held to the same existence bar as `ticket`. Naming **SVC-002** instead
  — which does have a file — would have satisfied the guard with a pointer to the reconciler ticket,
  which has nothing to do with effect-authority minting: the register-accuracy defect the guard
  exists to prevent, one field over. So the entry declares the orphan, which is the manifest's own
  provision for "no successor exists yet" and the same shape SVC-008a used for E7-F034.
- `scripts/test-inventory.json`: `packages/worker-daemon` pin 160 → 161, **hand-edited to one line**.
  `--write` additionally bumped four unrelated `floor` counts (`adapter-manager` 11→16,
  `browser-runtime` 9→11, `db` 58→59, `provider-wire` 3→4) — pre-existing drift in trees this ticket
  does not touch, reverted rather than smuggled into this diff.
- `docs/replatform/epics/E9-service-agents/README.md`: 008a/008b marked shipped, with the residual.
