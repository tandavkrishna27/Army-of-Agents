# SVC-003a — service health semantics: the projection and its fence — TERRAIN + DESIGN

**Epic:** E9 · **Lane:** B · **Base:** `6b39c77f6` · **Result:** [`SVC-003a-result.md`](./SVC-003a-result.md)

> **★ SVC-003 HAD ZERO FILES ON DISK.** Not a design, not a terrain, not a result — the only
> SVC-003 artefact anywhere was the `program-design.md` node and eleven references to it from
> other tickets' scope-outs and from three `unowned` findings that named it as the natural
> inheritor they could not legally point at. So the terrain and the design were part of this
> unit's job, and this file is both. It is written against source re-opened at `6b39c77f6`,
> not against ticket statuses.

---

## 1. What SVC-003 is chartered to do, and what this unit actually delivers

`program-design.md` §SVC-003 — *Long-session lease and health semantics*:

> **Outcome:** Add service health, liveness deadline, graceful stop, checkpoint request, and
> bounded lease renewal semantics.
> **Acceptance:** Health events do not extend ownership without a successful lease renewal;
> memory/context callbacks and connector refresh/materialization require the current fence;
> unreachable workers are fenced and replaced by policy.
> **Test:** Missed health, missed renewal, delayed event, stale-fence context/connector
> request, duplicate instance, and network partition tests.

**The Outcome is a five-way conjunction and this unit delivers ONE of the five.** That is stated
here, at the top, in the ticket's own terms, because this programme's signature failure is a half
enrolled as a whole. §8 is the full ledger of what is left out and why; the short version:

| Outcome clause | This unit |
|---|---|
| service **health** | **DELIVERED** — the projection, its fence, and its legality gate |
| **liveness deadline** | NOT delivered — needs a durable last-observation column and a sweeper (§8.1) |
| **graceful stop** | NOT delivered — SVC-005 owns the request side (§8.2) |
| **checkpoint request** | NOT delivered — `job_control_commands_kind_check` cannot even store one; SVC-004 (§8.3) |
| **bounded lease renewal** | NOT delivered as a change; the negative half IS pinned (§8.4) |

So the ticket ships as **SVC-003a**, on SVC-008's precedent (`SVC-008a`/`SVC-008b`, both resolving
to `SVC-008` for register guards). **SVC-003 stays OPEN.**

---

## 2. ★★★ THE TERRAIN FINDING THAT MOTIVATES THE WHOLE UNIT: three documents agree, and they are right

Measured at `6b39c77f6`, and each of these is a re-read of the cited source, not an inherited
citation:

1. `packages/db/src/repositories/tenant/job-control.ts` — `recordServiceHealth` is the ONLY
   `UPDATE` of `service_instances.status` in the tree. A whole-tree grep for the symbol returns
   its interface declaration, its implementation, two governed-mutator inventories
   (`job-fence.ts`, `job-fencing.ts`), the fence-surface contract test, and three test call
   sites. **No production consumer.**
2. `server/src/services/job-events.ts` + `acceptEvent` — the JOB-005 ingest projects exactly two
   event types (`attempt_started`, `terminal`). The five frozen service event types are
   digest-verified, durably appended to `job_events`, and **project nothing**.
3. `packages/worker-protocol/src/states.ts` — `canTransitionServiceInstanceStatus` and the frozen
   `SERVICE_INSTANCE_TRANSITIONS` table it reads have **ZERO production callers**. Measured with
   the register's own `countProductionCallers`: 0. Its only references are its own definition,
   the package barrel re-export (stripped by the counter), and its own unit test. A frozen
   lifecycle that nothing consults is a clause that is vacuously true.

The three epic documents that name this seam all say the same thing and all three are correct:

* `README.md` — *"the loop converges once and goes quiescent because `recordServiceHealth` still
  has no consumer (SVC-003)"*.
* `SVC-002-result.md` §7 — *"`recordServiceHealth` is still the only writer of
  `service_instances.status` and still has no consumer, so nothing drives an instance terminal
  and nothing triggers a replacement. SVC-003."*
* `SVC-008b-result.md` §7 — *"every service event emitted here is durably stored and **projects
  no state change**. Wiring that projection is SVC-003's."*

**So SVC-003a's centre of gravity is not in doubt.** What was in doubt, and is settled below, is
what a projection may CONCLUDE from an observation and what it must REFUSE.

---

## 3. ★ THE HANDOFF FROM SVC-002, AND WHETHER THIS UNIT TAKES IT

`SVC-002-design.md` scopes the generation writer out in its own words, quoted in the DE register:

> *"SVC-002 reads generation under a row lock and never bumps it; `services.generation` still has
> no writer after this ticket."*

and hands the **instance fence** to SVC-003 (`SVC-002-design.md` :481-485, :435, :438-439), with
generation ROLLOUT, pause and drain going to SVC-005 (:489-492).

**This unit TAKES the fence and DECLINES the writer, and the split is deliberate.**

* **TAKEN — the fence.** The projection refuses any event whose claimed generation is not the
  generation recorded on the instance row. That is a real refusal with a real test (T3) and a
  mutant that kills it, and it is the piece SVC-002 could not build because it had no consumer of
  a worker's generation claim.
* **DECLINED — the writer.** `services.generation` still has no writer after this ticket either.
  Bumping it is a *rollout*: it means minting a new `service_generations` row, deciding
  replace-before-stop vs replace-after-stop, and guaranteeing that no two generations perform
  external effects simultaneously. `program-design.md` assigns every one of those to **SVC-005**
  by name, and its acceptance clause ("no two generations may perform external effects
  simultaneously unless a later approved architecture decision explicitly permits overlap") is an
  architecture decision this unit has no standing to make.

**The consequence, said plainly rather than buried:** the generation fence built here is
**correct and currently unexercisable in production**, because nothing bumps a generation, so no
worker can hold a stale one. It is exercised by T3, which sets up the divergence directly. That is
the same shape as SVC-002 shipping a `service_generations` read for a table only SVC-007 can fill,
and it is disclosed for the same reason.

**Which generation is authoritative, and this is not obvious.** The comparison is against
`service_instances.generation`, **not** `services.generation`. The instance's generation is what
it was PLACED at; comparing against the service would refuse every event the moment SVC-005 bumps —
including events from the very instance that is legitimately being drained, which is exactly the
window SVC-005 needs to observe.

---

## 4. The design: where the projection lives, and why it is not a background worker

**Inside `acceptEvent`, in the same transaction as the durable append, under the fence guard that
has already admitted.** Three properties fall out of that placement and none of them survives a
background projector:

1. An event is never ACKed as accepted while its projection is lost, and a projection can never
   outlive a refused append. There is no window in which the durable log and the instance row
   disagree.
2. `guardActiveFence` has already proven an ACTIVE lease for this attempt, so the projection
   inherits the whole fence — stale fence and terminal attempt are refused **before** any service
   row is read, preserving the documented fence-first precedence.
3. The instance row is locked `FOR UPDATE` for the rest of the transaction, so two events for one
   instance in one batch apply in order and a concurrent reconciler pass waits rather than reading
   a half-applied projection.

**The decision is made server-side; the repository only applies it.** `packages/db` deliberately
does not depend on `packages/worker-protocol` — the `services` and `service_instances` schema
headers say so, and it is why the status CHECK and the partial-index predicate are already
hand-written copies of a frozen list. Re-deriving `SERVICE_INSTANCE_TRANSITIONS` inside the
repository would be a **fifth** copy. So `server/src/services/service-health-projection.ts` (pure,
no I/O) computes the target status and the legal-predecessor set from the frozen helper, and
`applyServiceProjectionForFence` applies it as a predicate. This is the shape
`commitArtifactVersion` already uses for its pre-evaluated `prefixValid`/`tenantValid`, and it is
what gives `canTransitionServiceInstanceStatus` its **first production caller**.

---

## 5. What an observation MEANS — the mapping, and the six events that mean nothing

This is the Outcome's actual content, so every line carries its justification.

| Event | Status | Why |
|---|---|---|
| `attempt_started` | `leased` | The control plane's own fact. `guardActiveFence` has just proven an ACTIVE lease. **Nothing else in the tree writes `leased`**, and the frozen table's only edge into `starting` is from `leased` — so without this arm `pending` is a dead end and the entire projection is production-unreachable. |
| `service_instance_started` | `starting` | SVC-008b's emitter docstring: *"asserts `starting` and NOTHING about the process"*. |
| `service_health` `healthy` | `healthy` | The provider's verdict about the supervised process, from a `processStatus` read of the run's handle. |
| `service_health` `unhealthy` | `unhealthy` | Same source, other verdict. |
| `service_instance_stopped` | `stopped` | *"the process was OBSERVED gone"* — never a stop request, never a signal's return value. |
| `service_instance_lost` | `lost` | The instance can no longer be accounted for. |
| `terminal` (non-succeeded) | `failed` | ★ **THE BACKSTOP, added after review — E9-F005.** `runServiceLifecycle`'s §4.2a launch comment (`service-lifecycle.ts`, ~:166) says a launch resolving no handle emits NO `service_instance_started`, so *"the instance never leaves `leased` and the attempt fails"*. Without this arm the attempt is terminal while the instance sits live forever. A `succeeded` terminal projects NOTHING (the service already emitted `_stopped`). |

**And the five that project nothing, each for a reason rather than by omission:**

* `service_graceful_stop_observed` — a stop **request**, not an observation. Its frozen payload is
  `{ref, deadline}` and SVC-008b's emitter says it *"claims nothing about the process"*. Moving the
  row to `stopping` from it would assert a process fact from a request, which is precisely the
  E7-F034 fail-open (`ProcessSignalResult.accepted` describes the CALL) that SVC-008a exists to
  refuse. SVC-005 owns the request side.
* `service_checkpoint_prepared` / `_restored` — checkpoint policy is SVC-004's, and neither event
  says anything about whether the process is up.
* `service_provider_interrupted` / `_resumed` — **no emitter exists** and none can:
  `SandboxState` has no suspended inhabitant (SVC-008b §6.3). A consumer of something nothing can
  produce is vacuously true and untestable end to end.
* `log` / `progress` / `usage` / `artifact_prepared` / … — attempt-scoped, not instance-scoped.

A worker therefore has **no event** that produces an instance status it cannot witness. That is
the property; it is not an accident of coverage.

### 5.1 — ★★★ WHAT A LEGAL MOVE IS, and the frozen-table gap review exposed (E9-F004)

The first revision of this design derived the legal-predecessor set as the **direct edges** of the
frozen table. That was wrong, and it was wrong in the one place that mattered:

> `SERVICE_INSTANCE_TRANSITIONS` gives `stopped` exactly one predecessor — `stopping` — and **no
> frozen worker event can assert `stopping`**. The supervisor emits `service_instance_stopped`
> directly on an observed exit, **from `healthy`** (`runServiceLifecycle`'s `case "process_exited"`
> arm, `service-lifecycle.ts` ~:293, and `gracefulStop`'s `verdict === "stopped"` branch ~:362 after
> the graceful ladder), and `service_graceful_stop_observed` cannot supply it because it observes a
> REQUEST.

So a direct-edge derivation refused **every normal service stop**, leaving the instance `healthy`
inside `service_instances_live_service_uq` where the reconciler could never replace it — the exact
opposite of this ticket's purpose. It passed a suite with a named positive control and thirteen
killed mutants, because the one end-to-end case drove `service_instance_lost`, which the frozen
table makes reachable from everything. *A lifecycle table proven over the transitions a suite
happens to exercise is not proven over the table.*

**The rule that replaces it, in one sentence: a worker may skip only the states it cannot witness.**
`predecessorsOf(to)` admits every status from which `to` is reachable by a legal path whose every
INTERMEDIATE step is a status no event can project (`pending`, `stopping`).

* It is **not** plain reachability. That would also make `starting` reachable from `pending` via
  `leased` — and `leased` IS projectable (`attempt_started` asserts it), so admitting it would
  delete a real ordering guarantee to fix an unrelated gap. `predecessorsOf("starting")` stays
  exactly `["leased"]`.
* **The safety property is untouched at any path length**, which is why this is safe: the three
  terminals have no outgoing edges, so no path of any length leaves one, so none is ever in a
  predecessor set. `stopping` is deliberately not terminal, so traversing through it cannot smuggle
  a terminal in.
* **The residual is real and is on the register** (E9-F004): `stopped` is now admitted from
  `leased` too, wider than the table permits in one hop. Closing it properly means SVC-005 writing
  `stopping`, or a frozen-table amendment.

---

## 6. The refusals, and why each is a distinct outcome rather than a boolean

`ServiceProjectionOutcome` has six arms. Collapsing them would collapse the one distinction
SVC-008b's whole stop-verdict work exists to preserve.

| Outcome | Meaning |
|---|---|
| `applied` | The row moved. |
| `noop_same_status` | Idempotent replay. Checked BEFORE legality: no status has a self-edge in the frozen table, so a repeated health tick would otherwise be reported `illegal_transition`, which is false and would drown the real refusals. |
| `noop_already_terminal` | ★ The attempt-terminal backstop landing on an instance that is already terminal — the NORMAL path. Reachable **only** when the caller passes `whenAlreadyTerminal: "noop"`, which only the `terminal` arm does; every service event keeps `"refuse"`, so the split-brain refusal is untouched. No write happens under either value, so it can never admit a move `"refuse"` would block. |
| **`unattributed`** | ★ **UNKNOWN, NOT ABSENT.** No instance is attributed to this (job, attempt), so nothing here can say what the observation is about. Writes nothing. A batch job's `attempt_started` lands here too, and for it this is the correct and only answer. |
| `identity_mismatch` | The payload named an instance the control plane did not attribute to this attempt. E9-F003 made load-bearing (§7). |
| `stale_generation` | ★ The fence (§3). |
| `illegal_transition` | The frozen lifecycle forbids the move — including every move out of a terminal status (§7.2). |

The outcomes are returned from `acceptEvent` and logged by the ingest, so a refusal is
**observable**. A projection that silently declined to write would be indistinguishable from one
that was never attempted, which is how a dead arming path stays invisible.

---

## 7. The two security properties, stated as properties

### 7.1 — the worker's payload is a CLAIM, never an authority

E9-F003: the lease envelope's `executionPrincipal` for a `service_reconcile` job names the
**service** under the kind `service_instance`, while the same envelope's workload carries a
different `serviceInstanceId` — and `stampServiceIdentity` re-stamps `serviceId` and `generation`
from the authorized source but **not** `serviceInstanceId`, which is therefore caller-controlled
and validated against nothing.

So the AUTHORITY is `service_instances.job_id`/`.attempt_id`, which SVC-002's reconciler wrote in
its own transaction — *"without this the instance row is UNATTRIBUTABLE and SVC-003 has nothing to
fence against"*. The payload's three identity fields must MATCH that row; a mismatch refuses. A
projection that trusted the payload could write status onto any instance in the tenant.

**`attempt_started` is the one arm with no claim to check** (its frozen payload is `{sandboxId}`).
That is not a bypass: the target row is still fixed by attribution, and the only status it may
drive is `leased`, whose sole legal predecessor is `pending` — so it cannot escape a terminal
status, skip a generation, or touch a row the worker was not already leased.

### 7.2 — ★★★ the split brain, which is the DE-12 crossing

`service_instances_live_service_uq` is unique on `(organization_id, service_id)` WHERE
`status NOT IN ('stopped','failed','lost')`. An instance that reached a terminal status has LEFT
that index, and SVC-002's reconciler has already created its replacement.

A late event from the dead worker's still-active fence, resurrecting the corpse to `healthy`,
would put **two live rows under one partial-unique key**: at best a 23505 that fails the whole
ingest transaction and makes the worker replay that batch forever; and if the index predicate were
ever widened, two live instances for one service — the split brain itself.

The three frozen terminals have no outgoing edges, so they appear in **no** predecessor set and
every move out of one is refused. An empty `allowedFromStatuses` refuses too, so a caller that
computed nothing gets a refusal rather than an unconditional write. This is what makes the frozen
transition table load-bearing instead of decorative.

---

## 8. ★ WHAT IS DELIBERATELY LEFT OUT, with the reason for each

Not narrowed silently. Each of these is a clause of SVC-003 that this unit does not deliver.

**8.1 — the liveness deadline. NOT BUILT, and it is the largest omission.** SVC-008b §6.2 hands it
here by name. A worker that stops emitting **without** emitting `_stopped`/`_lost` — the crash, the
partition, the sandbox that vanishes — leaves its instance in whatever status it last projected,
forever. Today its LEASE is reaped by `reapExpiredLeases`, but nothing propagates that to the
instance row, so the reconciler still sees a live instance and never replaces it. Closing it needs
(a) a durable last-observation timestamp on `service_instances` — a migration this unit does not
add — and (b) a sweeper that terminalizes past a deadline, plus the replacement POLICY, which is
SVC-004's crash-loop/backoff clause. Half of that is not it, so none of it is claimed.

**8.2 — graceful stop.** The stop REQUEST side is `requestCancellation` +
`service_graceful_stop_observed`, and `program-design.md` assigns operator pause/drain/stop to
SVC-005. This unit deliberately projects nothing from the observed-stop event (§5).

**8.3 — checkpoint request.** Structurally unavailable: `job_control_commands_kind_check` permits
five of the frozen six command kinds and **omits `checkpoint` entirely**, so a checkpoint request
cannot be persisted at all. SVC-001 recorded this and handed it to SVC-004.

**8.4 — bounded lease renewal.** No change to `renewLease`. What IS delivered is the negative half
of the acceptance clause, as a pinned property: **the projection writes exactly one table and does
not touch `leases`**, so a health event cannot extend ownership. T6 asserts `leases.expires_at` is
byte-identical across a health batch, and a mutant that bumps it reds T6 alone.

**8.5 — memory/context callbacks and connector refresh under the current fence. NOT BUILDABLE
YET, and that is a measurement, not a deferral.** `MemoryActor` has no `service` kind, no memory or
context operation exists among the ten frozen worker operations, and SVC-001 already declined
`actor_context_policy_id` on `service_generations` for exactly this reason — *"a column nothing
reads would make clause (b) vacuously true"*. Building the fence check for a callback that cannot
be made would be the same vacuity one layer up.

**8.6 — the network-partition test.** No replica identity and no partition detector exist anywhere
in the tree (`replicaId|replica_id|AOA_CONTROL_PLANE_REPLICA|controlPlaneId` returns zero hits),
so no partition is representable, let alone testable. Already on the register under E0-F013's
ruling that DE-12's audit clause asserts nothing pending these controls.

**8.7 — E9-F002 and E9-F003 are NOT closed and NOT inherited.** SVC-003 now has a file, so the
guard's existence bar no longer blocks naming it as a successor — but naming it would be a claim
this unit does not honour. E9-F002's residual is the never-re-minted effect authority (SVC-008
§9.1, unruled); E9-F003's is the envelope-side principal identity, which needs a Protocol Custodian
ruling. This unit touches neither. Both stay `open`/`unowned`.

---

## 9. What must be observed before any of this is believed

* Every new case observed RED under a named mutant on the shipped source, each mutant **verified
  applied** against both line-ending forms of its anchor before its result is read. (This tree is
  mixed: the repository file is CRLF, the new module is LF, and this programme has three times
  shipped a "surviving" mutant that was never applied.)
* A NAMED positive control that stays green under every mutant, so a harness break is
  distinguishable from a feature break.
* Caller counts base vs head with the register's own `countProductionCallers`, for every symbol
  added or widened — including the cautionary zero-caller neighbours.
* The one genuine BASE-TREE red available: E9-F001's `"interrupted"` state, reproduced as a
  mutant, because everything else here is new code and a suite that reds on "cannot import" proves
  nothing about the shipped path.
