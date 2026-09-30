# SVC-007a — service create, generation and the desired-state control — TERRAIN + DESIGN

**Epic:** E9 · **Lane:** B · **Base:** `053f90fc8` (branched from `docs/replatform-program`)

> **★ SVC-007 HAD ZERO FILES ON DISK at `053f90fc8`** — no terrain, no design, no result. It
> existed as the `#### SVC-007` node in `program-design.md` and as **55 references across 24
> files** (measured at `053f90fc8` over `docs/` and `scripts/`, `*.md` + `*.json`) — other
> tickets' scope-outs, register rows, and findings that named it as an inheritor they could not
> legally point at. Terrain and design were therefore part of this
> unit's job, exactly as they were for SVC-003a. Every citation below was re-measured at
> source; none is inherited.

---

## 1. TERRAIN — what exists, and the one sentence three documents agree on

SVC-007's Outcome is *"tenant-scoped create/update/pause/resume/stop controls and a view of
desired state, generation, active instance, health, checkpoint, budget, and restart history"*.
At base, **none of it existed**, and the consequence was larger than a missing feature.

Three shipped records say the same thing, in their own words, and all three are right:

| Source | The sentence |
|---|---|
| `SVC-002-result.md` §7 | *"Nothing creates a service. `repos.services.insert` keeps its zero production callers and SVC-002 adds no routes. The reconciler reconciles rows only a test can create." / "Nothing writes a generation. `service_generations` still has zero writers."* |
| `SVC-003a-result.md` §2 | *"NOTHING CREATES A SERVICE … On a real deployment there is no `services` row, so no instance, so nothing for this projection to move."* |
| `README.md` | *"every pass stalls at `no_generation` on a real deployment"* |

So **SVC-002's reconciler and SVC-003a's projection were both shipped and both structurally
unreachable.** E9 had a control loop, a placement authority, a lifecycle fence and a
projection, and no way to put a row in front of any of them.

### 1.1 What the storage layer already provides

`services` (SVC-001, E2-D06) carries `desired_state` (CHECK against a hand-written copy of the
frozen `SERVICE_DESIRED_STATES`) and `generation`, with the composite `services_org_company_fk`
as the SOLE company FK — `aoa.organization_id` is the only GUC, so company scoping is
necessarily app-layer and that FK's integrity is the whole tenant guarantee.

`service_generations` (SVC-001) is the immutable definition. **Immutability is a GRANT, not a
trigger**: the migration grants `aoa_app` only SELECT and INSERT — no UPDATE, no DELETE — and
the relation-ACL certificate is fail-closed. Its parent FK is RESTRICT rather than CASCADE for
a subtle reason the schema header records: a referential action executes with the CONSTRAINT's
rights, so `ON DELETE CASCADE` would erase rows `aoa_app` holds no DELETE on, and the obvious
acceptance test would still pass.

There is deliberately no `services.current_generation_id`; the current generation resolves by
`(organization_id, service_id, services.generation)` against
`service_generations_service_generation_uq`.

### 1.2 The three dead symbols

Measured with the wiring guard's own `countProductionCallers` at `053f90fc8`:

| Symbol | Base callers | What it is |
|---|---|---|
| `repos.services.insert` | **0** call sites (grep over non-test sources; the counter cannot see a property access) | the only insert into `services` in the tree |
| `service_generations` writers | **0** | there is no method at all — the repository exposes only `findServiceGenerationDefinition` |
| `canTransitionServiceDesiredState` | **0** | the FROZEN desired-state lifecycle. Its only references were its own definition, the package barrel (which the counter strips) and its own unit test — the SAME shape `canTransitionServiceInstanceStatus` was in before SVC-003a armed it |

### 1.3 The cancellation branch nobody had a service reason to read

`repos.jobControl.requestCancellation` (`packages/db/src/repositories/tenant/job-control.ts`,
`async requestCancellation`) has a branch — `if (!lease || !attempt || !lease.workerId ||
!lease.attemptNumber)` — that **finalizes** a cancellation directly rather than queueing a
control command, because there is no fenced worker to drain. It emits no event, by
construction. Terrain-relevant because a service stop necessarily goes through it, and because
`E9-F002` means a service job is typically never leased, so that branch is the NORMAL path
rather than a rare one. See §4.4 and **E9-F006**.

---

## 2. DESIGN — the shape, and the two things it refuses to do

### 2.1 Scope: create + generation + desired state. NOT rollout.

Unit A ships the two symbols the epic is blocked on, plus the control that makes shipping them
safe:

* **create** — one `services` row and its generation-1 `service_generations` row, in ONE
  transaction;
* **the desired-state control** — `running` / `paused` / `stopped`, fenced by the frozen table,
  with a stop that actually reaches the shipped cancellation channel;
* **a partial view** — desired state, generation, that generation's definition, live instance.

**`update` is NOT here, and the reason is a fence rather than a budget.** Minting generation
N+1 is a rollout, and SVC-005's acceptance says *"No two generations may perform external
effects simultaneously unless a later approved architecture decision explicitly permits
overlap"*. That fence does not exist. A generation writer that could mint N+1 without it would
be shipping the overlap E9 forbids and calling it an update.

### 2.2 Why the stop control is not a later unit

A create path with no stop path is not a smaller version of this ticket. The thing being
created is a workload that does not end, whose replacement SVC-002's reconciler mints
automatically whenever its instance goes terminal. Shipping the producer with no off switch
leaves an operator with a spend loop and no lever.

**And the off switch has to switch something off.** `services.desired_state = 'stopped'` alone
stops the reconciler CREATING a replacement — SVC-002's own header says the loop has no channel
to a running instance. A control that flipped only that column would be a Stop button that
provably does not stop. So it composes JOB-006's `requestCancellation` (graceful) against the
live instance's job. Nothing new is built; the shipped channel the JOB-008 `drain` route uses is
reused — though the ROUTE-level `jobOperations.drainJob` wrapper is not, because it opens its own
transaction and §2.3 needs the service lock held across the call.

### 2.3 The stop is ONE transaction, and ordering alone was not enough

> ★★★ **THIS SECTION IS A CORRECTION.** As designed and first shipped, the stop was TWO
> transactions ordered desired-state-FIRST, cancellation-second — reversed, a reconciler tick
> landing between them would observe the instance going terminal while `desired_state` still read
> `running` and mint a REPLACEMENT of the thing the operator just stopped. External review of
> PR #412 (P1) showed that ordering closes only the RECONCILER interleaving: a concurrent
> `stopped → running` committing in the same gap leaves the older stop draining a job the operator
> has **already resumed**. The design was wrong and the review was right; it is recorded here
> rather than rewritten as if it had always said this.

The shipped control performs the desired-state write, the graceful cancellation and the instance
terminalization in **ONE transaction, under the service's own row lock**. A resume cannot commit
between the read of `desired_state` and the cancellation, because it cannot acquire the row. That
also removes the split outcome the two-transaction shape had to report: a cancellation failure
now rolls the desired-state write back with it.

**The lock order is stated rather than assumed**, because `requestCancellation`'s own header warns
that getting it wrong deadlocks (40P01): service advisory lock + `services` row FIRST, then that
method's untouched `lease → attempt → job` hierarchy, then `service_instances`. Nothing in the
tree takes a job-side lock and THEN the service advisory lock — SVC-002's reconciler takes the
service locks first exactly as this does, and the JOB-005 ingest takes no service lock at all and
reaches `service_instances` only while already holding the attempt, the same direction as this.

The cancellation **still runs on the `unchanged` verdict**, and survives the rewrite for a
DIFFERENT reason than the two-transaction design gave: *"already stopped" does not imply "nothing
is running"* — a reconcile pass that began before an earlier stop can commit an instance after
that stop moved the column, and without this arm the operator could never reach it.

### 2.4 The definition boundary

`normalizeServiceDefinition` refuses in four named ways, in this order:

1. **ingress** — driven by the SHIPPED `SERVICE_INGRESS_DENY_KEYS` from
   `service-job-config.ts`, not a second copy, so a key added there is refused here without
   anyone editing this module;
2. **control-plane-owned** — `serviceId`, `serviceInstanceId`, `generation`,
   `checkpointArtifactId`, each with its own reason so the loop cannot be deleted with a green
   suite (they would otherwise fall through to `unknown_field`, which still refuses);
3. **unknown field**;
4. the **frozen bounds**, from `serviceWorkloadV1Schema.pick(...)`.

★ **The partition is asserted at module load.** `service-job-config.ts` already records that a
derived allow-list AUTO-WIDENS. Requiring every key of the frozen workload to be in EXACTLY ONE
of `SERVICE_DEFINITION_FIELDS` / `SERVICE_CONTROL_PLANE_OWNED_WORKLOAD_FIELDS` turns a frozen
schema change into an import failure naming the field.

★ **Clause (d) inherits its limit verbatim.** `service-job-config.ts` states that "no public
port/ingress configuration is accepted" governs DECLARATIVE CONFIGURATION and not reachability
— E2B serves arbitrary in-sandbox ports publicly at a URL derivable from the sandbox id, so a
service that merely LISTENS is reachable with no ingress configuration at all. That is still
true. `args` is still not scanned for `--port`, for the reason that file gives.

### 2.5 What is deliberately not stored

`service_generations.ttl_seconds` and `.checkpoint_artifact_id` exist and are written NULL.
Nothing enforces a TTL (SVC-005) and nothing restores a checkpoint (SVC-004), so accepting
either would store a bound no code keeps — *a column nothing reads makes a clause vacuously
true*, which is the failure this epic has already filed twice (`SVC-001-design.md` §4 on the
absent `actor_context_policy_id`; `E9-F002`'s ceiling).

`deleted` is likewise not accepted by the control: it is terminal in the frozen table and the
RESTRICT FK makes a service with any generation undeletable, so it is an irreversible tombstone
whose semantics SVC-005 owns.

---

## 3. AUTHORITY AND TENANCY

* **Authority** is `assertOrgAdmin` — the same `execution_target:manage` org owner/admin gate
  every JOB-008 operator mutation on this router uses, run FIRST on every route so a caller
  without it gets a uniform 403 whether or not the org, company or service exists.
* **The WHOLE BODY is validated AFTER the gate** — the definition and the request schema alike.
  ★ The first revision put the request schema in `validate(...)` middleware, which runs BEFORE the
  handler and therefore before `assertOrgAdmin`; external review of PR #412 (P2) pointed out that
  the route's own "authority first" sentence was then false, since an unauthorized caller with a
  malformed body got a 400 about their body. These four routes now carry no `validate` middleware
  and parse the schema inside the handler; a thrown `ZodError` reaches the same error handler, so
  only the ORDER moved. Same ordering constraint BRW-001 established.
* **The org/company pair is proven by `services_org_company_fk`**, not by an app-layer read: a
  second query to check the pair would itself be a cross-tenant existence oracle. The 23503 is
  mapped to the SAME uniform 404 an absent company produces.
* **Company scoping in every read is explicit**, because `aoa.organization_id` is the only GUC
  and RLS cannot do it.
* `assertAdmissibleOrganization` runs before every transaction, matching the reconciler and
  `jobSubmissionService.submit` (FND-007, Decision #121).

---

## 4. THE FOUR THINGS MOST LIKELY TO GO WRONG, AND WHAT STOPS EACH

### 4.1 A create path with no caller

This is the programme's signature defect and this ticket is the likeliest place to ship it —
`repos.services.insert` reads exactly like `createStartupReconciler`, `createResultCommitter`
and `jobAuditBridge` — all three MEASURED at **0** production callers at head with the
register's own counter, all three named in the gate-clause guard's own header as capabilities
that shipped inside epics reported `complete`. **★ The brief that opened this unit also named
"the reaper" as such a path, and that is WRONG: `reapOrganization` measures 4 production callers
and `reapExpiredLeases` 3. Corrected rather than repeated — an orchestrator's given is an
unverified claim.** Stopped by composing the route in
`jobControlRoutes` (mounted by `createApp` inside the `distributedExecutionEnabled` block) and
by counting callers base vs head with the register's own counter rather than asserting them.

### 4.2 A service row without its generation

Not a partial success: a `services` row whose generation is missing makes
`findServiceGenerationDefinition` answer `null` FOREVER, so the reconciler stalls at
`no_generation` on every tick for the life of the row, with no route able to repair it (this
unit mints generation 1 only, and 1 is taken). ONE transaction, proven by a rollback probe —
a write on its own connection would survive the outer rollback.

### 4.3 A lifecycle proven over a sample instead of over the table

E9-F004 is exactly this mistake one lifecycle over: SVC-003a's predicate was proven over the
transitions its suite happened to exercise, the one terminal it drove was the one reachable from
everywhere, and a predicate that refused EVERY NORMAL SERVICE STOP survived a named positive
control and thirteen killed mutants. So the desired-state control is asserted over the WHOLE
4×3 table against `canTransitionServiceDesiredState`, with an anti-vacuity check that both
answers occur.

### 4.4 ★★★ A stop that orphans its own instance — E9-F006

`requestCancellation`'s finalize branch (§1.3) emits no worker event, so SVC-003a's
attempt-terminal backstop — which lives in `decideServiceProjection`'s `terminal` arm and fires
only from an INGESTED event — cannot run. The instance stays non-terminal inside
`service_instances_live_service_uq`; `countNonTerminalInstances` answers 1 forever; a later
resume converges NOTHING on every tick.

The fix is a control-plane half of the same backstop, deriving `toStatus` and
`allowedFromStatuses` **from `decideServiceProjection` itself** for the same attempt status, so
the two paths cannot drift. Its four bounds are in the finding. The residual — that JOB-006's
behaviour is unchanged, so SVC-005's TTL and budget stops will meet it again — is stated in
E9-F006 §4 rather than left to be rediscovered.

---

## 5. WHAT THIS UNIT DOES NOT DELIVER

Stated here so a green suite is not over-read; repeated with measurements in the result.

* **No generation rollout** (§2.1). SVC-005.
* **No TTL, budget or checkpoint** (§2.5). SVC-004/SVC-005.
* **No `deleted`** (§2.5). SVC-005.
* **The view is partial**: no checkpoint, no budget, no restart history.
* **No service job is leased anywhere in this suite.** `E9-F002` keeps `workload.service`
  unofferable on a fleet like the test fixture's, so the DAEMON half of *"created, supervised,
  projected"* is not exercised. **E9's exit gate is not met and is not claimed.**
* **Create is not idempotent.** `services` has no natural key and no idempotency column. A
  client-chosen id would make `services.id` — a GLOBAL primary key — into a cross-tenant
  existence oracle on conflict, so it is refused. Bounded rather than prevented: the duplicate
  is visible in the list read and stoppable by the control shipped here.
* **No `activity_log` row** for a control action. Structured logger lines beside `drain`'s and
  `revoke`'s; `jobAuditBridge` still has zero production callers (DE-01).
* **`E10-REALTIME-FOUNDATION`**: SVC-007's Depends-on names it, and this unit makes **no
  reconnect-safe or durable-catch-up claim** of any kind — the view is a plain read with no
  realtime channel, so the gate is not consumed. The `every control action is … reflected
  through durable event catch-up` half of SVC-007's Acceptance is NOT delivered.
