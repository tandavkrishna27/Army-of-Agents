# SVC-002 — Service reconciler and placement — DESIGN

**Epic:** E9 · **Lane:** B · **Start SHA:** this commit · **Terrain:** [`SVC-002-terrain.md`](./SVC-002-terrain.md)
**Status:** designed, NOT implemented. **Three open questions (§10) are stated, not settled.**
**★★★ START AT §1: the jobs this reconciler creates cannot be placed or leased today, and the
prerequisite that unblocks them is not SVC-002's.**
**Two defects found and NOT fixed here:** [`SVC-002-terrain.md`](./SVC-002-terrain.md) §5.1 and §2 —
now **filed** as `E9-F001` / `E9-F002` in [`../findings.md`](../findings.md); see §9.2.

> **Method.** Written against source re-opened at `921b2c1f9`, not against ticket statuses. The
> terrain's two refutations carry into this document: the three-attempt ceiling is **not** the
> constraint `SVC-001-design.md` §7 handed over (§8.1), and the GO-BOOK's two passages about the E9
> gate-clause entry disagree with each other (§9.2). Where this design declines to build something,
> §8 names the ticket that owns it; where it could not settle a question, §10 says so rather than
> deciding it quietly.

---

## 1. ★★★ PREREQUISITE — READ BEFORE ANYTHING ELSE. The jobs this reconciler creates cannot be placed or leased today

**A reconciler built exactly to this design produces jobs that no worker can ever be offered.** That
is true at `921b2c1f9`, it is not a defect in this design, and it is not SVC-002's to fix — but an
implementer who learns it on page three has been misled by the document, so it is the first thing
here. **Three citations, each re-opened and verified for this rewrite:**

1. `packages/worker-daemon/src/enrollment/hello-provisioning.ts:27` —
   `export const SUPERVISABLE_WORKLOAD_CAPABILITIES: readonly WorkerCapability[] = ["workload.batch"];`
   Its own docstring says why: *"Batch only — the supervisor for browser_session/service composes in
   later sprints, and D4 forbids reporting a workload the daemon cannot run."*
2. `deriveHelloProvisioning` **intersects** the admin ceiling with what the device can provide
   (`:44-50`: `deviceCanProvide` is built from `SUPERVISABLE_WORKLOAD_CAPABILITIES` +
   `capabilitiesForIsolation`, and `reportedCapabilities = capabilityCeiling.filter(...)`). So
   `workload.service` is filtered out of every daemon's advertised set **no matter what the ceiling
   says** — widening the admin ceiling alone changes nothing.
3. Placement demands the capability unconditionally: `submittedCapabilities` opens with
   ``const workloadCapability = `workload.${input.workloadType}` `` (`job-placement.ts:177`) and
   returns it in the required set (`:190`). A `service` job therefore requires `workload.service`,
   which nothing advertises. (A free `serviceSlots` is additionally required,
   `packages/worker-protocol/src/capabilities.ts:528-530`, but that is not the binding constraint.)

Pinned, so this cannot drift silently: `server/src/__tests__/u0-d1-placement-reachability.test.ts:324`
asserts `expect([...SUPERVISABLE_WORKLOAD_CAPABILITIES]).toEqual(["workload.batch"])`, under a
comment saying that if either ceiling widens *"every reachability conclusion below is re-derivable
rather than silently stale."*

**And the programme already sequenced it.** `GO-BOOK.md:1763-1769` records the same measurement and
concludes: *"enabling `workload.service` dispatch is a prerequisite step before health/restart/
drain, not a given."*

**WHAT MUST HAPPEN FIRST, stated as a sequence rather than a caveat.** Before any service reaches a
worker, someone must (a) widen `SUPERVISABLE_WORKLOAD_CAPABILITIES` to include `workload.service`
**and** (b) compose the service supervisor in the daemon that the constant's docstring says does not
exist. Both are worker-daemon changes. **No ticket on disk owns them** — which is why they are filed
here as **E9-F002** (HIGH, `unowned`) rather than assumed.

> **DECISION (SVC-002).** SVC-002 is a control-plane ticket and does **not** enable
> `workload.service` dispatch. It is designed and accepted against a **`queued`** placement, which
> is what `decideJobPlacement` actually returns with no eligible candidate (`disposition: "queued"`,
> `reasonCode: "no_eligible_target"`, `job-placement.ts:642-654`) — **not** a failure.

**Why that is defensible rather than a dodge.** All four acceptance clauses are decided strictly
*before* a lease is offered: idempotency at `insertJobOnce`, quota at `admitAttemptCapacity`, drain
at `candidateFits`, desired state at `serviceSourceIsAdmitted`. Every one is observable on a job
that is submitted, placed and queued. **The clause that genuinely needs a worker is
"one *compatible* service-instance job"** — compatibility is provable by construction (the workload
validates against the frozen strict schema, so `buildJobEnvelope` will parse it), but that a worker
*accepts and runs* it is not demonstrated by this ticket and must not be claimed by it.

**What this costs, stated so nobody discovers it at SVC-006.** Until a daemon advertises
`workload.service`, every reconciled service accumulates exactly one `queued` job and one `pending`
instance, forever. That is inert, tenant-scoped, and quota-accounted — but it is not nothing, and
SVC-005's budget/TTL stop is the first thing that can clear it.

## 2. What SVC-002 builds, and the one sentence that bounds it

**One service, one running instance, converged from desired state, without duplicate placement.**
That is the whole ticket.

- **Zero new wire surface.** `serviceReconcileSourceSchema` and `serviceWorkloadV1Schema` are frozen
  and complete; SVC-002 consumes them. The mistake BRW-001 made and this lane has now avoided twice.
- **Zero new relations.** SVC-002 adds columns and indexes to `service_instances`, an existing
  registered relation, so none of the four fail-closed registration hooks and neither key-order
  certificate is in play (terrain §4). It is a much smaller migration than SVC-001's.
- **One new service module, one new sweeper composition, four new repository methods, one
  predicate added to an existing repository method.**

**And the sentence that bounds it, said once here so §8 is not a surprise:** SVC-002 reconciles
**zero instances → one instance** and then goes quiescent. It has no way to observe that an instance
has *stopped being one* — the only writer of `service_instances.status` is `recordServiceHealth`, a
governed fence mutator with zero production callers whose input type SVC-001 was supposed to narrow
and did not (terrain §5.1). **Nothing in SVC-002 drives an instance to a terminal status.** So the
convergence loop converges once per service and then does nothing until SVC-003 gives it a terminal
transition to react to. That is not a gap in this design; it is the seam between SVC-002 and SVC-003,
and the acceptance table must not read "the reconciler maintains one running instance."

## 3. The reconcile loop

### 3.1 Composition — copied from MIG-002, deliberately

`server/src/index.ts:1340-1385` composes the convergence sweeper: `createJobControlSweeper` +
`listAdmittedOrganizationIds` as an org-rotating cursor + a backoff timer read from
`nextDelayMs(result)` + `unref()` + `SIGTERM`/`SIGINT` stop, **registered inside the
`config.distributedExecutionEnabled && distributedExecutionDatabases` block** (`:1183`).

The service reconciler composes identically and in the same block, for the same reason the MIG-002
comment gives at `:1334-1339`: **flag-off allocates no `aoa_app` pool at all, so `runInTenant` has
nothing to open.** Registering it unconditionally would not make it a safety net; it would make it a
throw. Copy the shape, including `nextDelayMs` — half the MIG-002 sweeper's interface was
unexercised until someone used it, and that is what made its backoff real.

**Desired state is read from the database, not from an event.** There is no event source: the
routes that would change desired state are SVC-007's and do not exist. A polling sweeper is the
honest shape, and its latency is the tick interval, stated as a bound rather than as "promptly".

### 3.2 One reconcile pass, exactly

For one `(organizationId, serviceId)`, entirely inside **one** `runInTenant(appDb, organizationId,
async (repos, tx) => …)`:

| # | Step | Why here |
|---|---|---|
| 1 | `SELECT pg_advisory_xact_lock(hashtext('aoa:service-reconcile'), hashtext(serviceId))` | Serializes concurrent passes into a clean wait instead of a lost race. **Not the authority** — see §4. |
| 2 | `SELECT … FROM services WHERE organization_id = $org AND id = $svc FOR UPDATE` | Pins `desired_state` **and** `generation` for the whole transaction, so a concurrent SVC-005 generation bump cannot land between the read and the insert. |
| 3 | If `desired_state <> 'running'` → return `{action:"none", reason:"desired_state_not_running"}` | §5. |
| 4 | Count non-terminal instances for `(org, service, generation)`. If ≥ 1 → return `{action:"none", reason:"instance_present"}` | Desired replicas is 1 (SVC-001's Outcome, "initially limited to one"). |
| 5 | `INSERT INTO service_instances (id = randomUUID(), org, company, service, generation, status='pending', job_id, attempt_id)` | The partial unique index (§4) is the backstop under a lost race. |
| 6 | `submitJobWithinTenant(repos, request, tx)` with a `service_reconcile` source | **Same `repos`, same `tx`** — the `jobAdmissionBridge` composition, verbatim (`server/src/services/job-admission-bridge.ts:279`, `:331`). |
| 7 | Commit | Both writes land or neither does. |

Steps 5 and 6 are mutually dependent — the workload carries `serviceInstanceId`, and the instance
row carries `job_id`/`attempt_id` — so in practice step 5 mints the instance id, step 6 submits, and
step 5's row is written with the returned ids before commit. Ordering within the transaction is an
implementation detail; **that they share one transaction is not.**

### 3.3 The submission this builds

```
source = { kind: "service_reconcile",
           serviceId, generation,                       // from the FOR UPDATE'd services row
           reconciliationId: deriveReconciliationId(serviceInstanceId),   // §4.2
           requestedBy:      { kind: "system", id: companyId },
           executionPrincipal: { kind: "system", id: companyId } }
idempotencyKey = `svc-instance:${serviceInstanceId}`     // §4.2
input = { serviceId, serviceInstanceId, generation, command, args,
          checkpointArtifactId, gracefulStopSeconds }    // from service_generations.definition
```

`command` / `args` / `gracefulStopSeconds` / `checkpointArtifactId` come out of
`service_generations.definition` (jsonb, `packages/db/src/schema/service_generations.ts:60`). That
table has **zero writers today** (terrain §1), which makes §10.1 an open question and not a detail.

`serviceId` and `generation` are server-stamped over whatever the workload claimed
(`stampServiceIdentity`, `server/src/services/service-job-config.ts:139-156`), so the two are
tautologically consistent for this caller. `serviceInstanceId` is **not** stamped — see §4.3.

## 4. ★ Duplicate placement — the mechanism, and why it holds under concurrency

This is the central risk and the clause the terrain's §6 says a loop cannot hold. Three layers,
composed, and **only one of them is the authority**.

### 4.1 The authority: a partial unique index on `service_instances`

```
UNIQUE (organization_id, service_id) WHERE status NOT IN ('stopped', 'failed', 'lost')
```

`'stopped'`, `'failed'` and `'lost'` are exactly the three terminals of the frozen
`serviceInstance` lifecycle (`packages/worker-protocol/src/states.ts:198-229`, mirrored in
`docs/architecture/distributed-execution-lifecycles.json`), so the predicate is derived from the
frozen authority rather than hand-picked.

**Why it holds, mechanically.** A unique index is enforced by the storage engine on **every**
insert. Two concurrent transactions inserting a non-terminal instance for the same
`(organization_id, service_id)`: the second blocks on the index entry until the first commits, then
raises `23505`. There is no interleaving in which both commit, and there is no way for a writer to
opt out — including a writer that does not exist yet.

**Why the alternatives are weaker, and this is the whole argument.**

- **The advisory lock alone is advisory.** Nothing forces a future writer to take it. SVC-004's
  restart path and SVC-007's manual "start now" control are exactly the writers that would forget,
  and the concurrency test written against two copies of *this* loop cannot see it. That is the
  failure the terrain's §6 names, and it is the same shape as SVC-001's three immutability tests
  staying green under a mutant that erased every row they protected (`SVC-001-result.md` §3).
- **`SELECT … FOR UPDATE` on `services` alone** locks the parent row, so it serializes two readers
  of that row — but an inserter that never reads `services` takes no lock at all. Same objection.
  It is kept at step 2 for a different job: interlocking with SVC-005's generation bump.
- **The submission idempotency key alone** constrains `jobs`, not `service_instances`. Two
  independently-minted reconciliation identities produce two distinct rows in *both* tables (§4.2).

**Why not simply reuse the existing lease/fence model, as the brief asks.** The fence is real and is
composed over — every worker-side mutation runs through `guardActiveFence` — but it is the wrong
instrument here for a measured reason: `guardActiveFence` compares
`executionTargets.deviceGeneration` (`packages/db/src/repositories/tenant/job-control.ts:1141`,
`:1171-1177`), the **device**-revocation generation of DE-03/DE-13's boundary. It never reads
`services.generation`, `service_generations.generation` or `service_instances.generation`. DE-12's
own delivery evidence says so in capitals. A fence prevents a **stale worker** from acting; it does
not prevent a **second instance** from being created, because creation happens before any lease
exists. Composing the fence here would be composing a mechanism that cannot see the event.

**The house precedent is exact.** `job_artifacts` carries three disjoint partial uniques over a
natural key for precisely this purpose (`packages/db/src/schema/job_artifacts.ts:94-116`,
DAT-002/006/009), with the docstring *"a replayed commit is a DO-NOTHING (the fence-first mutator
returns the existing row)"*. Same pattern, same reason, drizzle-generated.

**★ What the loser does — and the naive version of this paragraph cannot execute.** An earlier draft
said the loser *"catches it and re-reads the winning instance"* inside the mandated single
transaction. **That is impossible.** A `23505` aborts the whole PostgreSQL transaction; every
subsequent statement raises `25P02` until a rollback. This repository has already written the lesson
down, at `server/src/services/companies.ts:391`:

> *"Retrying INSIDE a single transaction is impossible: a 23505 aborts the whole PG tx."*

There were three ways out and this design takes the first.

- **CHOSEN — a SAVEPOINT around step 5's insert alone.** `ROLLBACK TO SAVEPOINT` un-aborts the
  transaction and leaves everything before the savepoint intact, so the loser survives, re-reads,
  and returns without a second connection. It is the house mechanism, not an import: postgres-js
  nests `.transaction()` on a transaction handle as a SAVEPOINT, and `runInTenant`'s own docstring
  says so (`server/src/db/tenant-context.ts:38-41`, JOB-010). **This is the only option that keeps
  §6.1's guarantee** — the instance insert and the submission must share one transaction, or quota
  exhaustion leaves an orphan `pending` instance and wedges the service permanently.
- **REJECTED — a second transaction.** It works, and it breaks the one-transaction composition §6.1
  is built on.
- **REJECTED — return the conflict with no re-read.** It is *sufficient* for the return value (the
  result carries no instance data), and it is strictly less informative for no saving: the savepoint
  is already open.

**The exact sequence.** `SAVEPOINT svc_instance_insert` → `INSERT` → on `23505` **whose constraint
name is the partial unique index** (`error.constraint_name`, checked; anything else re-raises
untouched), `ROLLBACK TO SAVEPOINT svc_instance_insert` → re-read the non-terminal instance for
`(org, service)` → return `{action:"none", reason:"instance_present"}` → commit. Step 6 is not run
by the loser at all.

**Why the re-read is guaranteed to find the winner.** `runInTenant` sets no isolation level
(`server/src/db/tenant-context.ts:46-60` → `withTenantTx`), so the transaction is PostgreSQL's
default **READ COMMITTED**, in which each statement takes a fresh snapshot. A `23505` is raised only
*after* the conflicting inserter **committed** — a winner that rolls back releases the index entry
and the loser's own insert then succeeds — so the post-savepoint `SELECT` sees the winning row by
construction. Under REPEATABLE READ it would be a serialization failure instead, which is why the
isolation level is stated rather than assumed.

**★ And the promise this had to keep:** the loser returns `{action:"none", reason:"instance_present"}`
— byte-identical to what step 4 returns on the sequential path, with no error raised and no extra
field. **The two outcomes are indistinguishable to the caller**, which is what "idempotent" means and
was this design's own claim before the mechanism was corrected.

### 4.2 The idempotency key, and the trap that makes the obvious one wrong

`jobs_submission_idempotency_uq` is a **seven-column composite**
(`packages/db/src/schema/jobs.ts:109-117`) that includes `authenticated_source_identity` — and for a
`service_reconcile` source, that field is `source.reconciliationId`
(`packages/shared/src/job-control-source.ts:31-32`).

**So a resubmission carrying a fresh random `reconciliationId` does not collide, whatever the
idempotency key says.** Pinning `idempotencyKey` while leaving `reconciliationId` random pins six
of seven columns and admits a duplicate. This is stated at length because it is the kind of
one-column oversight that produces a green idempotency test and a duplicate in production.

**Both are therefore derived from the one id the index in §4.1 already guarantees is unique:**

```
idempotencyKey   = `svc-instance:${serviceInstanceId}`
reconciliationId = uuidV5(`service-reconcile:${serviceInstanceId}`, SERVICE_RECONCILE_NAMESPACE)
```

`reconciliationId` must be a UUID — `reconciliationIdSchema = uuidSchema.brand<"ReconciliationId">()`
(`packages/worker-protocol/src/ids.ts:37`) — so it cannot be a readable derived string. The house
pattern for a deterministic UUID is `derivePlatformDefaultEnvironmentId`
(`server/src/services/platform-default-environment.ts:91-110`): a self-contained RFC 4122 v5
implementation, added because no `uuid` package is a resolvable direct dependency of `server/`, with
a fixed never-rotate namespace constant and a comment saying why changing it would orphan rows.
Copy it, including the never-rotate comment.

Every remaining column of the composite is then also a function of the instance: `organization_id`
and `company_id` from the instance's own row, principal kind/id constant (`system` / `companyId`),
source kind constant. **The whole seven-column key reduces to `serviceInstanceId`, which is a primary
key.** Two submissions for one instance are impossible; two non-terminal instances for one service
are impossible.

**★ And a reachability caveat this design owes its own test plan.** *No path in SVC-002 ever submits
twice for one instance id* — the loser returns before step 6 (§4.1), and step 4 short-circuits before
a second tick can. So this property is **unreachable from the reconciler**, and a test that drives
the reconciler cannot kill a "revert `reconciliationId` to `randomUUID()`" mutant. It is pinned by
T1c, in which the *test* performs the second submission; SVC-004's replacement path is its first real
consumer. Stated here because the earlier version of this design claimed the reconciler covered it.

**Why the instance id is random rather than derived.** A deterministic instance id keyed on
`(service, generation)` would make **replacement** impossible — SVC-004 must be able to mint a
*second* instance for the same service and generation after the first reaches a terminal status, and
a derived id would collide with the corpse. Randomness here is a requirement, not a default.

### 4.3 What this does *not* close: `serviceInstanceId` authorization

`serviceReconcileSourceSchema` carries no `serviceInstanceId` (`source.ts:119-128`), so
`stampServiceIdentity` covers two of three identity fields and says so
(`service-job-config.ts:129-135`). SVC-001 handed the third here.

**SVC-002 closes it by construction, not by authorization, and the difference matters.** The only
producer of a `service_reconcile` source in the tree is this reconciler, and the `serviceInstanceId`
it passes is the primary key of a row it inserted in the same transaction. That is airtight for this
caller and **proves nothing about the submission path**: a hypothetical second `system`-principal
caller could still name any instance id. Adding the field to the frozen source schema is a Protocol
Custodian STOP (§10.2). **The result document must say "closed by construction for the reconciler",
never "the service workload's identity is authorized."**

## 5. Stopped services create no new instance — the exact predicate

**Two enforcement points, and they are not redundant in the way they look.**

1. **The sweep filter** (step 3): `desired_state = 'running'`.
2. **The admission authority**: add the same predicate to `serviceSourceIsAdmitted`
   (`packages/db/src/repositories/tenant/job-control.ts:1667-1679`), which today filters on
   `id` / `organizationId` / `companyId` / `generation` and has **no `desiredState` predicate at
   all**. `SVC-001-terrain.md:200-201` hands this here by name.

**The predicate is an allow-list, not a deny-list.** `eq(services.desiredState, "running")`, never
`ne(..., "stopped")`. A deny-list admits `paused` and `deleted`; an allow-list is fail-closed and
gives SVC-005's pause its enforcement for free without SVC-002 implementing pause.

**Why both, given that step 2's `FOR UPDATE` makes them provably identical for this caller.** They
are: the row is locked for the whole transaction, so the sweep filter and the admission predicate
read the same value. The admission predicate's value is entirely in the *other* callers —
a replayed submission, SVC-007's future controls, a direct call — and in locating the guarantee in
**the authority every submission passes through** rather than in one loop's control flow.

**★ And that redundancy is a vacuity hazard the test plan must handle.** Delete the sweep filter and
the reconciler still creates no instance: the admission predicate denies, the transaction rolls back,
and a test asserting "zero instances" stays **green under the mutant**. So the stopped-state test
must assert the *reason* (`{action:"none", reason:"desired_state_not_running"}`) and that **no error
was raised** — otherwise the two guards mask each other exactly as SVC-001's three immutability tests
masked `ON DELETE CASCADE`. See T3 in §7.

## 6. Tenant quota and worker drain — where each is read, and what refusal looks like

### 6.1 Quota — read inside the submission, refusal rolls the instance back

`admitAttemptCapacity` (`server/src/services/org-concurrency.ts:213-260`) is already composed into
`submitJobWithinTenant` (`server/src/services/job-submission.ts:341-355`, gated on the deployment
flag). It serializes count-then-claim under
`pg_advisory_xact_lock(hashtext('aoa:org-capacity'), hashtext(org))` (`:223`), checks **budget
first** (`:242`, reason `"budget"`) and then capacity (`:247`, reason `"capacity"`), and propagates
any throw so the caller fails closed. Denial raises `HttpError(429)` (`job-submission.ts:349`).

**SVC-002 adds nothing here and inherits everything — provided the instance insert is in the same
transaction.** A 429 unwinds step 6, and because step 5 shares the transaction, the instance row
unwinds with it. **Quota exhaustion therefore creates no instance and no job.** If the instance were
written in a separate transaction, quota exhaustion would leave an orphan `pending` instance that
step 4 would then read as "instance present", and the service would never start — a silent permanent
wedge. This is the single strongest reason the one-transaction composition is load-bearing and not
tidiness.

The reconciler catches the 429 and returns `{action:"none", reason:"quota_denied"}`. It does not
retry within the tick; the next tick is the retry, and the backoff is the sweeper's.

### 6.2 Drain — read inside placement, refusal leaves the job queued

`execution_targets.status` is `active | draining | offline | disabled`
(`packages/db/src/schema/execution_targets.ts:35`), written by the worker's own heartbeat
(`server/src/services/execution-targets.ts:458-486`). `candidateFits` refuses any candidate whose
`registry.status !== "active"` (`server/src/services/job-placement.ts:537`), so a draining target is
excluded from the candidate set before any scoring.

**What refusal produces is `queued`, not `failed`** (`job-placement.ts:642-654`,
`reasonCode: "no_eligible_target"`). The job exists, the instance exists at `pending`, nothing
errors, nothing leases.

**★ The duplicate risk lives here, not in the happy path.** A reconciler that asked "is there a
*healthy* instance?" would answer no on every tick under a fully drained fleet and submit forever.
Step 4 asks "is there a *non-terminal* instance?", and `pending` is non-terminal, so a drained fleet
produces exactly one instance and one job no matter how many ticks run. The drained-worker test's
job is to prove that, not to prove that placement declines.

**What SVC-002 does *not* do about drain, stated so the clause cannot be over-read.** It does not
move, stop or replace an instance already running on a target that has *begun* draining. That
requires a fence and a stop channel over a live lease — SVC-003's semantics and SVC-005's Outcome,
which names *"worker drain"* alongside pause and rollout. SVC-002's clause is "a draining worker is
not chosen for a new instance." Two different guarantees; one delivered.

## 7. Tests — each with the failing case that must be OBSERVED RED first

Every case names its red state and its mutant, because this programme's recurring defect is a test
that was green before the fix and nobody checked (`SVC-001-result.md` §4, three such defects in one
ticket).

| # | Test | The failing case that must be observed RED **before** the fix exists | Mutant that must re-red it after |
|---|---|---|---|
| **T1a** | **★ THE INDEX IS THE THING UNDER TEST — two lock-free concurrent inserters.** Two transactions on **separate connections** against real embedded PostgreSQL, neither taking step 1's advisory lock, each inserting a non-terminal `service_instances` row for the same `(organization_id, service_id)`. Interleave them explicitly: A inserts (does not commit) → B inserts and **blocks** → A commits → B's insert returns. Assert: B observes **`23505` naming the partial unique index**, B's savepoint path returns `{action:"none", reason:"instance_present"}` and does not throw, and exactly **one** non-terminal row exists. | **With the index absent, both inserts commit and two non-terminal instances exist for one service.** That is the red state, it is reachable, and it must be run and seen. Nothing serializes these two writers — which is the point: they model the writers §4.1 names (SVC-004's restart path, SVC-007's "start now") that will never take the advisory lock. | Drop the partial unique index → two rows → red. Change the predicate's terminal set (e.g. add `'pending'`) → the two inserts stop conflicting → red. Widen the loser's catch to a bare `catch {}` → the "does not throw" assertion still passes but T1d's foreign-key case goes red. |
| **T1b** | **The lock's job, which is NOT the authority.** Two full reconcile passes for one service, started concurrently, both committing. Assert: exactly one instance, exactly one `jobs` row, the loser returns `{action:"none", reason:"instance_present"}` — **and that the loser reached that answer at step 4, without raising `23505` at all.** | The red state is the whole feature: today there is no reconciler. ★ Do **not** claim the index as this case's red state — with the lock present and the index dropped, the two passes serialize and the second still sees `instance_present` at step 4, so **one** instance appears and the case stays green. That is exactly why T1a exists and why the earlier version of this row pinned nothing. | Remove the advisory lock → T1b must **stay green** (the index catches it; only the loser's path changes from step-4 to `23505`). That "stays green" is the assertion, and it is what proves the lock is a wait-instead-of-race convenience and not the authority. |
| **T1c** | **The §4.2 composite-key trap, pinned where it is actually reachable.** Call the submission path **twice for one `serviceInstanceId`** with the derived source — the *test* is the second submitter. Assert exactly **one** `jobs` row. | Red today in that neither the derivation nor the reconciler exists. ★ **Stated honestly: no path in SVC-002 ever submits twice for one instance id** — the loser returns before step 6 — so a "revert `reconciliationId` to `randomUUID()`" mutant against T1b **cannot kill**, and the earlier version of this plan claimed it would. The property being pinned is the *derivation's*, and SVC-004's replacement path is its first real consumer. | Revert `reconciliationId` to `randomUUID()` → two `jobs` rows → red. This mutant kills **only** because the test itself performs the second submission; if T1c is ever rewritten to drive the reconciler instead, the mutant goes silent again. |
| **T1d** | **The loser's catch is narrow.** Provoke a *different* constraint violation on the same insert — e.g. a `service_id` violating the composite FK of §8 — inside the same savepoint path. Assert it **propagates** and the pass fails. | Red today. | Replace the constraint-name check with a bare `catch {}` → the error is swallowed and the pass reports `instance_present` for a service that has no instance → red. |
| **T2** | **Quota exhaustion.** Set the org concurrency cap to 0 (or force a budget hard-stop through `defaultCapacityBudgetBridge`). Run one pass. Assert: `{action:"none", reason:"quota_denied"}`, **zero** `jobs` rows, and — the load-bearing half — **zero** `service_instances` rows. | Today there is no reconciler; the red state is the whole feature. The specific red state for the *rollback* half: write the instance in its own transaction and the instance row **survives** a 429. That variant must be built and seen red, because it is the version a reasonable implementer writes first. | Move the instance insert out of the submission transaction → the zero-instances assertion goes red while the zero-jobs assertion stays green. |
| **T3** | **Stopped state.** Two cases, and both are required. **(a)** A reconcile pass over a service with `desired_state='stopped'` returns `{action:"none", reason:"desired_state_not_running"}`, raises **no** error, and creates nothing. **(b)** A **direct** `submitJobWithinTenant` with a `service_reconcile` source naming a stopped service is **denied**. Repeat (b) for `paused` and `deleted` to prove the predicate is an allow-list. | **(b) is red today**: `serviceSourceIsAdmitted` has no `desiredState` predicate, so a stopped service is admitted right now (terrain §3d). **(a)** is red only in that no reconciler exists. | Delete the sweep filter → **(a) must go red on the `reason` and the no-error assertion**, per §5. If it stays green, the assertion is the vacuous "zero instances" form and must be rewritten. Delete the admission predicate → (b) red. Change the predicate to `ne('stopped')` → the `paused` case in (b) goes red. |
| **T4** | **Drained worker.** One registered execution target, `status='draining'`. Run **three** reconcile ticks. Assert: exactly one instance and one job after all three; the job's placement disposition is `queued` with `reasonCode: "no_eligible_target"`; nothing raised. Then flip the target to `active` and assert placement selects it — a **positive control**, so the test is not passing because placement is broken in general. | A reconciler keyed on "healthy instance present?" submits three jobs across three ticks. Build that variant and watch it go red; without it, T4 proves only that placement declines, which nothing in SVC-002 caused. | Change step 4's predicate from non-terminal to `status = 'healthy'` → red on ticks 2 and 3. Remove the positive control → the test can no longer distinguish "drain respected" from "placement never selects anything". |

**Why T1 was split into four, recorded so the split is not undone.** The single-row version of T1
declared a red state that **cannot occur** (with the advisory lock in place, dropping the index
still yields one instance), never exercised the index it called "the AUTHORITY", and carried a
`reconciliationId` mutant that **cannot kill**. Three defects in one row, all of the same shape: the
test named a mechanism and then measured something else. T1a is the index, with the lock deliberately
out of the picture; T1b is the lock, whose expected result under a dropped index is **green**; T1c is
the composite key, driven by the test rather than by the reconciler because the reconciler never
submits twice; T1d is the narrow catch. Merging any two of them re-creates the masking.

**Migration idempotency.** The static check in
`packages/db/src/__tests__/migration-idempotency.test.ts:122` matches only
`/^\s*CREATE (UNIQUE )?(TABLE|INDEX)\s+"/`, so the new `CREATE UNIQUE INDEX` **is** covered
(it needs `IF NOT EXISTS`) while `ADD COLUMN` and `ADD CONSTRAINT` are covered by **nothing**. Add a
named double-apply case for the new migration beside the `0264` one (`:295-320`). This is not
belt-and-braces: SVC-001's equivalent case caught a real defect on its first run, because a UNIQUE
constraint materialises an index and a replay raises `duplicate_table`, not `duplicate_object`
(`SVC-001-result.md` §4).

**Windows** runs these via `AOA_RUN_WIN_INTEGRATION=1`; otherwise Linux CI.

## 8. Schema — exactly what, exactly why, and the rule that bounds it

**Every column SVC-002 adds is written by SVC-002's own transaction.** That is the rule, and it is
what keeps this from becoming SVC-001's deferred instance-column set. A column with no writer in the
same commit is the vacuously-true acceptance pattern (`SVC-001-terrain.md` §6), and SVC-001 already
declined `actor_context_policy_id` on exactly this ground.

All of it is Drizzle in `packages/db/src/schema/service_instances.ts` plus `pnpm db:generate`
output. **No hand-authored DDL.** Tables, columns, indexes and FKs are always generated
(CLAUDE.md rule 1, `AGENTS.md`, Decision #122 at `docs/architecture/decisions.md:1971-2050`).
SVC-002 needs **no** C14 class (b) security block: `service_instances` is an already-registered
relation with its grants, RLS and policy in place, and adding columns to it changes no ACL. The only
hand-appended thing is the C14 class (a) idempotency guards on the generated DDL, per §7.

| Change | Why | Writer, in this commit |
|---|---|---|
| `service_instances.company_id uuid NOT NULL` | The reconciler must submit with a `companyId` and `serviceSourceIsAdmitted` filters on it. Company scoping is **necessarily app-layer** — `aoa.organization_id` is the only GUC (`server/src/db/rls-tenant.ts:81`) — so the denormalized column carries the whole company guarantee. | step 5 |
| Composite FK `(organization_id, company_id, service_id) → services(organization_id, company_id, id)`, `ON DELETE CASCADE`, **replacing** the existing pair FK `service_instances_org_service_fk` | E2-F013: independent or single-column FKs let an instance carry company B while its service belongs to company A inside one org, with every constraint satisfied. The triple binds it. The FK target `services_org_company_id_uq` already exists (SVC-001, `schema/services.ts:56-60`). Same correction SVC-001 applied to `service_generations` (its §3.2 CORRECTION 2). | n/a (constraint) |
| `UNIQUE (organization_id, service_id) WHERE status NOT IN ('stopped','failed','lost')` | §4.1. The authority for "no duplicate placement". Terminals derived from the frozen lifecycle. | enforced on step 5 |
| `service_instances.job_id` + `attempt_id` (nullable uuid) | Without them the instance row is **unattributable** — nothing can correlate an instance with the job serving it, and SVC-003 has nothing to fence against. Both ids exist in the same transaction that inserts the row. | step 5/6 |
| `desiredState` predicate on `serviceSourceIsAdmitted` | §5. Not a schema change; listed here so it is not lost. | n/a |

**Deliberately NOT added, with the ticket that owns each:** `lease_id`, `worker_id` (SVC-003 — the
lease is minted after SVC-002's transaction has committed); `started_at`, `last_health_at`
(SVC-003 — health is the only writer and it has none); `restart_count`, `backoff_until`
(SVC-004); `paused_at`, `budget_*`, `ttl_deadline_at` (SVC-005); `services.current_generation_id`
(SVC-001 §3.2 CORRECTION 4 refused it as an RI cycle and that reasoning is unchanged).

**On `job_id`/`attempt_id` being plain columns rather than FKs.** A composite FK to
`jobs(organization_id, company_id, id)` is *available* — `jobs_org_company_id_uq` exists
(`schema/jobs.ts:104-108`). It is not taken here because the direction of the dependency is wrong:
`jobs` is the generic control plane and a service-specific child FK into it would make job cleanup
service-aware. Stated as a judgement call, not as an impossibility. **§10.3.**

**Four new repository methods** (`lockServiceForReconcile`, `countNonTerminalInstances`,
`insertServiceInstance` with the conflict path, `listReconcilableServices`) and **one modified**
(`serviceSourceIsAdmitted`). **★ Every one of them reds
`server/src/__tests__/job-fence-surface.contract.test.ts`** (AST-scans the real repository;
`EXPECTED_GUARDED` at `:45-58`, `EXPECTED_UNGUARDED` at `:68+`) until classified **in the same
commit**. All four are `EXPECTED_UNGUARDED`: none is a worker-side mutation and none is reached
through a lease, so none belongs behind `guardActiveFence`. Modifying the body of the already-listed
`serviceSourceIsAdmitted` adds no method and reds nothing.

### 8.1 The three-attempt ceiling — SVC-001 handed over the wrong constraint

`SVC-001-design.md` §7 recorded *"a 72-hour service that loses its instance three times is
dead-lettered"* and handed it to SVC-002. **Measured, it is not the binding constraint.**
`reapExpiredLeases` retries while `attempt.attemptNumber < job.maxAttempts`
(`packages/db/src/repositories/tenant/job-control.ts:3646`, default 3,
`packages/db/src/schema/jobs.ts:70`, never set at submit), then dead-letters (`:3666-3673`). That
ceiling governs the attempts of **one job**. A service replacement is a **new instance, new
`reconciliationId`, new job, `attemptNumber` 1** — and that is not SVC-002's invention, it is the
frozen contract: `distributed-execution-lifecycles.json` forbids
`serviceInstance:lost → attempt:failed` *"because the reconciler replaces the instance with a new
attempt and fence"*, machine-checked by `scripts/check-distributed-execution-foundation.mjs` in the
always-on `policy` job.

**The residual is real and belongs to SVC-004:** nothing bounds how many times a service may be
replaced. That is the crash-loop clause (*"crash loops terminalize or pause by policy"*), and it
needs a restart counter SVC-002 deliberately does not add.

## 9. Boundaries, registers, and what this ticket does NOT do

### 9.1 Scope-outs, each named to its owner

- **Health, liveness deadline, graceful stop, checkpoint request, bounded lease renewal → SVC-003.**
  SVC-002 writes `status='pending'` once and never writes it again. It also does **not** widen
  `ServiceHealthStatus` (terrain §5.1) — SVC-001 §3.2 CORRECTION 6a places that on a governed fence
  mutator, which is SVC-003's. Terrain §5.1 records the contradiction; it is **filed** as E9-F001
  in this commit and it is not fixed here.
- **Restart, backoff, checkpoint recovery → SVC-004.** No restart counter, no backoff column, no
  checkpoint restore. `service_generations.checkpoint_artifact_id` is a restore-*input* pointer with
  no writer.
- **Pause / drain of a running instance / generation rollout / budget / TTL → SVC-005.** SVC-002
  reads `generation` under a row lock and never bumps it; `services.generation` still has no writer
  after this ticket. `desired_state='paused'` is refused by §5's allow-list, which is enforcement of
  a *policy* SVC-005 owns, not an implementation of pause.
- **The 72-hour canary → SVC-006.** It needs a worker (§1).
- **Create/update/pause/resume/stop controls and any UI → SVC-007.** SVC-002 adds **no routes**.
  There is still no way for a human to create a service; `repos.services.insert` keeps its zero
  production callers. **The reconciler reconciles rows only a test can create.** Said plainly
  because it is the honest scope of "the first ticket in E9 with a producer".
- **Enabling `workload.service` dispatch** → §1; a worker-daemon change, filed in this commit as
  E9-F002, `unowned`.

### 9.2 Register obligations

- **★ `ownerTicketDeferrals["DE-12"]` must be deleted in the same commit as these documents.**
  `findTicketIds` (`scripts/check-threat-control-audit-debt.mjs:109-123`) derives ticket ids from
  filenames under `docs/replatform/epics/*/tickets/`; the staleness rule at `:231-243` errors with
  *"Remove the entry in the landing commit"*, and the checker runs in the **required** `policy` job.
  Removal is safe: DE-12 stays `partial` and now names an on-disk owner ticket, which is what the
  guard demands. **DE-12 is not thereby delivered** — its control is *"desired-state reconciler,
  generation, active fence"*, SVC-002 builds the first third, and SVC-002 is a *design*, not an
  implementation. Nothing about the crossing's measured evidence changed.
  **★ Removing it also reds five of the checker's own self-tests, and the repair is part of this
  commit.** `check-threat-control-audit-debt.test.mjs` borrowed two facts from the real tree: that
  DE-12 carried the sole declared deferral, and that `SVC-002` was an id with zero files on disk.
  Both expired at once — for exactly the reason the deferral's own text predicted. That is the same
  fixture-drift shape the file's W20B note already repaired four tests for, so the repair is the same
  one: each test now **mints** the deferred crossing it is about (`DE-98`) and uses a sentinel ticket
  id (`ZZZNOSUCH-999`) whose absence is a property of the string rather than of what the programme
  has written yet. Proven non-vacuous by mutation — neutering the checker's staleness rule reds M13.
  The next SVC ticket to land a file will not re-break them.
- **The E9 gate-clause entry does NOT land in this commit, and the GO-BOOK agrees with itself once
  you read the dates.** `GO-BOOK.md:1771-1772` ("Terrain-verified 2026-08-27") asks SVC-002 to create
  one; `GO-BOOK.md:171-176`, dated **2026-08-28**, records that it *"did not survive scoping —
  PREMATURE (no real service-execution symbol to track until SVC-002 lands … so a clause would be
  vacuous)"*. The later passage wins and names its own release condition. Verified against the
  checker: `countProductionCallers` (`scripts/check-gate-clause-wiring.mjs:155-186`) returns `0` for
  a symbol that does not exist, and an `unwired` clause with count 0 **passes** — so a clause added
  today would be admitted and would assert nothing, which is this programme's defining failure class.
  **The SVC-002 implementation commit adds `E9-1-service-reconciler`, `unwired`, symbol
  `createServiceReconciler`,** with a reason naming §1's capability blocker as what would have to
  change. At that point the symbol exists and the count is meaningful.
- **★ The E9 findings register is CREATED IN THIS COMMIT, not deferred.** E0–E8, E10 and E11 all
  carry a `findings.md`; E9 did not. The earlier draft of this bullet handed the filing to the
  implementation commit on the ground that *"filing a finding is a code-register act, not a prose
  one"* (terrain §7 item 3). **That reasoning is withdrawn.** A defect recorded only in a design
  document is exactly the weak form this programme keeps re-learning, and adversarial review said
  so. `docs/replatform/epics/E9-service-agents/findings.md` now carries **E9-F001** (MED, `unowned`)
  and **E9-F002** (HIGH, `unowned`), transcribed from terrain §7 item 3, each with its
  `scripts/finding-ownership.json` entry in the same commit — a new open finding is born undeclared
  and undeclared **fails** (`scripts/lib/finding-ownership.mjs:409-411`), so half-doing it reds the
  required `policy` job.
- **E9-F001 is filed rather than corrected in place, and that is the artifact policy, not a
  preference.** `SVC-001-result.md` §6 records an edit to `ServiceHealthStatus` that never happened
  (`tenant/job-control.ts:620` still carries `| "interrupted"`, and it is the last such literal in
  `server/src` + `packages/`). `artifact-policy.md` — *"Once status becomes `complete`, the file is
  frozen; a later correction creates a finding and a new ticket/result rather than rewriting approved
  evidence"* — forbids editing the result doc. A dated result document is a measurement; the honest
  repair is a finding that says what was claimed and what is actually there, which is what E9-F001 §2
  does.
- **★ A finding for the invisible-character class, filed OUTSIDE this epic and deliberately not
  fixed here.** This PR's own `scripts/check-threat-control-audit-debt.test.mjs:97` carried a
  **U+200B** inside a JSDoc comment, between the `*` and the `/` of a glob path — so the string a
  reader sees is not the string on disk. **It was load-bearing, not a slip:** removing it makes
  `*/` close the block comment and the file stops parsing. That is a third instance of the exact use
  `scripts/check-invisible-control-chars.mjs` counted and excused in its own header, whose limit is
  pinned by a **passing** test (`scripts/lib/__tests__/invisible-control-chars.test.mjs:224-241`).
  Repaired by rewriting the block comment as `//` line comments, which need no invisible character
  (24/24 tests green). The **class** is filed as **E6-F020** in the guard's home register, `unowned`,
  with the two things this occurrence establishes: the guard's census is a recurring pattern rather
  than two grandfathered sites, and *"no escape-based repair exists"* is not *"no repair exists"*.
  **The guard is not widened in this PR** — that decision gets made deliberately, not smuggled into a
  ticket about service reconciliation.

### 9.3 Deployment honesty

The reconciler composes inside the `distributedExecutionEnabled && distributedExecutionDatabases`
block (§3.1), and `app.ts:489-497` mounts the whole job-control surface only under that flag,
refusing owner fallback **by name** (*"owner fallback is forbidden"*, `:492`). Flag-off there is no
`aoa_app` pool, no route, and nothing for the reconciler to open. The honest acceptance wording is
**"unexercised flag-off; enforced on the `aoa_app` pool flag-on"** — *not* "unenforced by default",
which SVC-001's CORRECTION 5 already established for this epic.

## 10. ★ Open questions this design could not settle

**10.1 — Where does `service_generations.definition` come from, and what happens when there is
none?** SVC-001 created the table with `SELECT, INSERT` grants and **zero writers** (terrain §1), so
today a running service has no definition to read and the reconciler has no `command` to submit. Two
answers and neither is obviously right: SVC-002 adds a `serviceGenerations` repository and the
reconciler treats "no generation row" as `{action:"none", reason:"no_generation"}` (small, but it
means SVC-002 ships a read for a table only SVC-007 can fill, i.e. still no end-to-end path); or the
insert path belongs to SVC-007 with the create/update controls, and SVC-002's tests construct
generation rows directly (honest, but leaves the acceptance suite driving a table with no production
writer, which is close to the vacuity pattern this epic keeps hitting). **Not decided here.** It
does not change §4 or §5, but it decides whether SVC-002's loop can run at all outside a test.

**10.2 — Should `serviceInstanceId` be added to `serviceReconcileSourceSchema`?** It would close
§4.3 properly, moving instance identity from *authorized-by-construction* to *authorized*. It is a
**frozen wire change and a Protocol Custodian STOP** (`packages/worker-protocol/src/source.ts:119-128`),
which handoff §7 / E4-D02 says must be settled before design, not during it. SVC-002 is designed to
work without it. **Someone with custodian authority should rule**, because SVC-003's fence work will
face the same question with less freedom.

**10.3 — Should `service_instances.job_id`/`attempt_id` carry composite FKs into `jobs` /
`job_attempts`?** The targets exist (`jobs_org_company_id_uq`, `schema/jobs.ts:104-108`). Against:
a service-specific child FK into the generic control plane makes job lifecycle management
service-aware, and `ON DELETE` semantics are not obvious (a deleted job should probably not delete
an instance row that is the audit record of it). For: without it the linkage is a convention, and
this repo's whole tenant model is built on refusing conventions where a constraint is available.
**Recorded as a judgement call, unmade.** It is additive either way and does not block §4.

**Also unresolved, and inherited rather than opened here:** whether `pnpm db:generate` originates the
`DROP CONSTRAINT` / `ADD CONSTRAINT` pair for the FK replacement in §8. `SVC-001-design.md` §3.3
flagged the same question for a changed CHECK and nobody ran drizzle-kit to settle it. If it does
not, that pair is hand-authored DDL needing an explicit exception under CLAUDE.md rule 1 — **not**
something to file under "C14 guards". Settle it by running the generator, not by arguing.
