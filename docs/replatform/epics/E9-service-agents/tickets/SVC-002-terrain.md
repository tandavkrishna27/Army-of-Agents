# SVC-002 — Service reconciler and placement — TERRAIN

**Epic:** E9 · **Lane:** B · **Mapped at:** `921b2c1f9`
**Status:** terrain complete. **One blocker (§2) must be acknowledged on the record before design,
and it is not SVC-002's to fix.**
**Depends on:** SVC-001 ✅ (merged, `e974364d2`), JOB-003 ✅, JOB-009 ✅

**Spec.** Outcome: reconcile desired state into one compatible service-instance job without
duplicate placement. Acceptance: repeated reconciliation is idempotent; tenant quota and worker
drain are respected; stopped services create no new instance.
Test: concurrent reconcilers, quota, stopped state, and drained worker.

> **Method.** Every claim below was re-opened in source at `921b2c1f9` rather than carried from a
> ticket status or a GO-BOOK row. Where a handoff or a prior result document says something this
> mapping could not reproduce, the disagreement is named and the measurement wins. Negatives use
> `grep -a` (the tree carries NUL bytes; plain `grep` reports "Binary file … matches" and
> **suppresses** the hit). Two prior claims were refuted; one shipped result document is wrong
> about its own work (§5.1).

---

## 1. SVC-002 is the first ticket in this epic with a producer, and it has no consumer

SVC-001 shipped the **storage half**: three tables, their constraints, their grants, their RLS,
and a submit-time workload validator. What it did not ship — deliberately, and it says so — is
anything that *writes*. The census at `921b2c1f9`:

| Relation | Writers in the whole tree | Production callers |
|---|---|---|
| `services` | one `insert` (`packages/db/src/repositories/tenant/index.ts:217`). **No `update` anywhere** | **0** (two test call sites) |
| `service_instances` | one `insert` (`tenant/index.ts:230`); one `update`, `recordServiceHealth` (`tenant/job-control.ts:3181-3189`) | **0** |
| `service_generations` | **none.** No repository method exists | **0** |

`services.desiredState` has **zero readers** in production: its only two occurrences are the column
declaration and the CHECK (`packages/db/src/schema/services.ts:25`, `:41`). SVC-002 is the ticket
that gives that column a reader, and the reconciler is the first thing in E9 that will write
anything at all.

**The receiving surface is complete and has no producer.** Every arm exists:
`serviceSourceIsAdmitted` (`tenant/job-control.ts:1667-1679`), the frozen
`serviceReconcileSourceSchema` (`packages/worker-protocol/src/source.ts:119-128`) and
`serviceWorkloadV1Schema` (`job.ts:312-322`), a `service_reconcile` case in
`job-admission-bridge.ts:187-196`, `job-approval-bridge.ts:207-209`,
`job-authoritative-rate.ts:122` and `job-shadow-admissibility.ts:154-161`. **Nothing anywhere
constructs a `{kind:"service_reconcile"}` source.** Every hit is a `switch` case consuming one, or
a test.

And it could not, today, even if written: `SOURCE_REQUESTER_KINDS.service_reconcile = ["system"]`
(`server/src/services/job-submission.ts:99`), while `principalFor`
(`server/src/routes/job-control.ts:20-60`) can mint only `user` / `local_board` / `agent` / `mcp` /
`commander`. The single `{kind:"system"}` producer in the tree
(`server/src/services/one-shot-sandbox-cli.ts:293`) feeds the **read-only shadow recorder**, not a
submission, and submits `one_shot`. **SVC-002's reconciler will be the first real `system`-principal
submitter this repo has ever had**, which is worth saying plainly because it means no existing test
exercises that principal on the live submit path.

**There is no reconciler of any kind, partial or unwired.** Whole-tree searches for `reconcil*`
over service symbols, for every writer of the three tables, and a filename sweep for
`*service*reconcil*` return nothing. The one same-named neighbour is
**`workspace_runtime_services`** (`packages/db/src/schema/workspace_runtime_services.ts`, desired-state
logic at `server/src/services/workspace-runtime.ts:3294-3326`, `:3675`, `:3759`, `:3833`) — the
legacy in-product dev-server preview proxy, with `port`, `url` and `healthStatus` columns. That is
the **public-port model SVC-001's clause (d) forbids**, named by `SVC-001-terrain.md:44-46` as the
thing not to extend. It is not a precedent for anything here.

## 2. ★ THE BLOCKER: no worker can be a candidate for a service job, and SVC-002 cannot fix it

This is the fact that shapes the whole design, and it was not in SVC-002's dependency list.

```ts
// packages/worker-daemon/src/enrollment/hello-provisioning.ts:27
export const SUPERVISABLE_WORKLOAD_CAPABILITIES: readonly WorkerCapability[] = ["workload.batch"];
```

`deriveHelloProvisioning` intersects the admin-ratified capability ceiling with what the device can
actually provide (`:44-50`), and `SUPERVISABLE_WORKLOAD_CAPABILITIES` is one of the two sets it
intersects against. **`workload.service` is therefore never advertised by any daemon, on any
device, under any admin ceiling.** The file's own comment says so: *"Batch only — the supervisor for
browser_session/service composes in later sprints, and D4 forbids reporting a workload the daemon
cannot run."*

Placement demands it unconditionally: `submittedCapabilities`
(`server/src/services/job-placement.ts:176-177`) always includes `workload.${workloadType}`, and
`workerSatisfiesRequirements` additionally requires a free `serviceSlots`
(`packages/worker-protocol/src/capabilities.ts:528-530`).

**This is a THIRD independent reason DE-12's control cannot fire, and neither of the two already on
the record covers it.** E0-F011 item 4 records (i) the `system` requester-kind gate and (ii)
`services.generation` having no writer. Both are control-plane facts SVC-002 changes. The capability
intersection is a **worker-side** fact SVC-002 does not touch, and no findings register anywhere
mentions `SUPERVISABLE_WORKLOAD_CAPABILITIES` (`grep -a` over every `findings.md` → zero hits), nor
does DE-12's own `deliveryEvidence`. Closing E0-F011's two items would therefore leave DE-12 reading
as unblocked while this stands. **To be filed as E9-F002 (HIGH, `unowned`); §7 item 3 carries the
wording and the reason it is not filed in a docs-only commit.**

**What actually happens, and it is not a failure.** With no eligible candidate,
`decideJobPlacement` returns `disposition: "queued"` with `reasonCode: "no_eligible_target"`
(`job-placement.ts:642-654`) — **not** `"failed"`. So a service job submitted today is created,
persisted, placed as `queued`, never leased, and never errors. Its instance row sits at `pending`
forever.

**Why that is the right shape for SVC-002 anyway, and why the ticket is still worth building.**
A reconciler whose acceptance clauses are *idempotent*, *quota-respecting*, *drain-respecting* and
*stopped-aware* is testable end to end against a `queued` placement, because all four clauses are
decided **before** a lease is ever offered. The clause SVC-002 cannot demonstrate is one it was
never given: *"one compatible service-instance job"* can be proven compatible-by-construction and
placed, but not **run**. The design must say which of its own claims are load-bearing on a real
worker and which are not, or the acceptance table will read as "services work".

## 3. Per-clause readiness

### (a) "Repeated reconciliation is idempotent" — SUFFICIENT, and the lever is subtler than it looks

The mechanism exists and is exercised: `jobs_submission_idempotency_uq`
(`packages/db/src/schema/jobs.ts:109-117`) over
`(organization_id, company_id, authenticated_principal_kind, authenticated_principal_id,
authenticated_source_kind, authenticated_source_identity, idempotency_key)`, consumed by
`insertJobOnce`'s `onConflictDoNothing` (`tenant/job-control.ts:1681-1698`) with a real replay path
that returns the winner's `jobId` and `replayed: true` (`job-submission.ts:298-315`), failing closed
if the winner is somehow not visible.

**★ The trap, and it is the single most important fact in this section.**
`authenticated_source_identity` is **part of the composite**, and for a `service_reconcile` source
it is `source.reconciliationId` (`packages/shared/src/job-control-source.ts:31-32`). So an
identical resubmission that mints a **fresh** `reconciliationId` **does not collide** — the
idempotency key alone does not make repeated reconciliation idempotent. `reconciliationId` is a
branded **UUID** (`packages/worker-protocol/src/ids.ts:37`), so it cannot be a readable derived
string; it must be a *deterministic* UUID or the whole composite is unstable.

The house precedent for exactly that exists: `derivePlatformDefaultEnvironmentId`
(`server/src/services/platform-default-environment.ts:91-110`), a self-contained RFC 4122 v5
implementation added because no `uuid` package is a resolvable direct dependency of `server/`.

**And the job is only half of it.** Idempotent *submission* does not prevent a duplicate
`service_instances` row — the two writes are independent, `service_instances` has **no uniqueness
of any kind beyond its PK and `service_instances_org_id_uq`** (`schema/service_instances.ts:46`),
and `serviceInstanceId` is caller-controlled and validated against nothing (§5.3). Nothing today
structurally prevents two active instances. That is the literal failure mode of DE-12.

### (b) "Tenant quota … respected" — SUFFICIENT, and it comes for free

`admitAttemptCapacity` (`server/src/services/org-concurrency.ts:213-260`) is already composed into
the submit path (`job-submission.ts:341-355`, gated on the deployment flag). It serializes
count-then-claim under `pg_advisory_xact_lock(hashtext('aoa:org-capacity'), hashtext(org))` (`:223`),
checks **budget first** (`:242`, reason `"budget"`), then capacity (`:247`, reason `"capacity"`),
and any throw propagates so the caller **fails closed**. A denial raises `HttpError(429)` from
`job-submission.ts:349`, which rolls the whole submission transaction back.

**The consequence for the design:** anything the reconciler writes in that same transaction is
rolled back too. If the instance row is written outside it, quota exhaustion leaves an orphan
instance with no job. The composition is therefore load-bearing, not a convenience.

### (c) "Worker drain … respected" — SUFFICIENT, and narrower than the sentence

Drain is real and reaches placement: `execution_targets.status` is
`active | draining | offline | disabled` (`packages/db/src/schema/execution_targets.ts:35`), set by
the worker's own heartbeat (`server/src/services/execution-targets.ts:458-486`), and `candidateFits`
refuses any candidate whose `registry.status !== "active"` (`job-placement.ts:537`). A draining
target cannot be selected.

**But that is the whole of it.** Refusing a drained target for a **new** placement is a different
guarantee from draining a **running** instance off a target that has just started draining. Nothing
in the tree does the second. `SVC-005`'s Outcome names *"worker drain"* alongside pause and rollout;
`SVC-003` owns the fence a live instance would be moved under. SVC-002's clause is the first
guarantee only, and the acceptance table must not be allowed to read it as the second.

### (d) "Stopped services create no new instance" — SUFFICIENT, and currently FALSE

This is the clause with a genuine red state, and SVC-001 handed it here **by name**
(`SVC-001-terrain.md:200-201`).

`serviceSourceIsAdmitted` (`tenant/job-control.ts:1667-1679`) filters on
`id`, `organizationId`, `companyId` and `generation` — and **no `desiredState` predicate**. So a
`service_reconcile` submission naming a service whose `desired_state` is `'stopped'`, `'paused'` or
`'deleted'` is admitted today. The clause has no enforcement anywhere.

`SERVICE_DESIRED_STATES` is the frozen four (`packages/worker-protocol/src/states.ts:179`), storable
since SVC-001 widened `services_desired_state_check` (`schema/services.ts:41-44`), with `deleted`
terminal — no outgoing transitions in either the frozen machine (`states.ts:183-188`) or
`docs/architecture/distributed-execution-lifecycles.json` (`lifecycles.serviceDesired`).

## 4. Schema scope — smaller than SVC-001's, and every column has a writer in the same commit

`service_instances` today is the E2 stub plus SVC-001's two constraint fixes: `id`,
`organization_id`, `service_id`, `generation`, `status`, timestamps, the frozen-nine CHECK
(`:39-42`), `service_instances_org_id_uq` (`:46`), and the composite
`service_instances_org_service_fk` → `services(organization_id, id)` `ON DELETE CASCADE` (`:52-56`).

What it lacks, measured: **no `company_id`**, no `job_id` / `attempt_id` / `lease_id` / `worker_id`,
no `started_at` / `last_health_at`, and **no uniqueness that constrains how many instances a service
may have**. `repos.serviceInstances.getById` filters on `id` alone (`tenant/index.ts:233-240`).

The partial-unique-as-idempotency-key pattern SVC-002 needs is already the house pattern, three
times over, in `job_artifacts` (`packages/db/src/schema/job_artifacts.ts:94-116`, DAT-002/006/009) —
drizzle-generated, with the docstring *"a replayed commit is a DO-NOTHING (the fence-first mutator
returns the existing row)"*. Latest migration on disk is `0273_trust_rule_agent_binding.sql`;
re-check at commit, not at design.

**Registration is a fail-closed trap and SVC-002 does not spring it**, because it adds no new
*relation*: the four hooks (`PLAN_DERIVED_ACL_MATRIX` → `job-control-legacy-grants.ts:800`,
`RELATION_ACL_NULLNESS_CERTIFICATE` → `:805` plus a `satisfies` typecheck at `:794`, the
serving-relation/Drizzle-table walk at `:848`, and `appTablePrivileges()`) all key on relations, and
`service_instances` is already registered. The **key-order** hazard that cost SVC-001 three CI
rounds (`RLS_RELATIONS` vs `POLICY_COUNTS`, `SVC-001-result.md` §3a) is likewise not reachable for
the same reason. Columns and indexes on an existing registered relation are ordinary
`pnpm db:generate` output.

**What IS reachable, and must not be assumed away:** `job-fence-surface.contract.test.ts` AST-scans
the real repository and fails closed on any method absent from `EXPECTED_GUARDED` (`:45-58`) or
`EXPECTED_UNGUARDED` (`:68+`). **Every new repository method SVC-002 adds reds that test until it is
classified in the same commit.**

## 5. Broken and misleading things nearby — five, all verified at `921b2c1f9`

### 5.1 ★ `ServiceHealthStatus` and the DB CHECK now contradict each other, and a shipped result document claims otherwise

`tenant/job-control.ts:620` still reads:

```ts
export type ServiceHealthStatus = "healthy" | "stopped" | "lost" | "interrupted";
```

It is the **only** `"interrupted"` literal left in `server/src` + `packages/`. Migration `0264`
narrowed `service_instances_status_check` to the frozen nine, which excludes it. So
`recordServiceHealth({ healthStatus: "interrupted" })` typechecks and now fails at runtime with a
`23514` CHECK violation, where before SVC-001 it succeeded.

`SVC-001-design.md` §3.2 CORRECTION 6a instructed *"narrow the edit to removing `interrupted` only"*
and `SVC-001-result.md` §6 claims it was done. **It was not** — a shipped result document asserts a
code change that did not happen, and CI was green. **To be filed as E9-F001 (MED, `unowned`); §7 item 3
carries the wording.** Latent
today (`recordServiceHealth` has zero production callers), live the moment SVC-003 wires health.

The type is also far narrower than the nine in the other direction — `pending`, `leased`,
`starting`, `unhealthy`, `stopping` and `failed` cannot be expressed at all — and
`recordServiceHealth` (`:3181-3189`) is the **only** UPDATE path to `service_instances.status` that
exists. **SVC-002 cannot drive an instance to a terminal status without either widening a governed
fence mutator (SVC-003's scope, per SVC-001 CORRECTION 6a) or adding its own writer.**

### 5.2 `recordServiceHealth` is scoped by `(organization_id, serviceInstanceId)` only

No company, no service, no generation predicate (`:3186-3188`). `SVC-001-terrain.md:202-203` hands
this to SVC-003. SVC-002 must not assume the instance-status mutator is tenant-complete.

### 5.3 `serviceInstanceId` is caller-controlled and validated against nothing

`serviceWorkloadV1Schema` requires all three of `serviceId` / `serviceInstanceId` / `generation`
(`job.ts:313-316`), but `serviceReconcileSourceSchema` carries **no `serviceInstanceId`**
(`source.ts:119-128`) — so `stampServiceIdentity` covers two of three and says so in its own
docstring (`server/src/services/service-job-config.ts:129-135`). Nothing downstream rescues it.
`SVC-001-result.md` §6 records that a test asserts the attacker-supplied instance id **survives**.
SVC-001 handed this to SVC-002/003 by name.

### 5.4 `serviceSourceIsAdmitted` returns a `services` id under the kind `service_instance`

`{ kind: "service_instance", id: row.id }` where `row.id` is selected from `services`
(`:1668`, `:1678`). It becomes `jobs.executor_principal_id`, whose `executor_principal_kind` is
unconstrained `text` with **no CHECK** (`schema/jobs.ts:54`). Any SVC-002 code that reads that field
expecting an instance id gets a service id.

### 5.5 The three-attempt ceiling, and why it is **not** the constraint SVC-001 thought it was

`reapExpiredLeases` retries only while `attempt.attemptNumber < job.maxAttempts`
(`tenant/job-control.ts:3646`); `jobs.max_attempts` defaults to `3` (`schema/jobs.ts:70`) and is
never set at submit — no override exists. Beyond it the job **dead-letters** (`:3666-3673`).
`allocateRetryAttempt`, the uncapped path, has zero production callers.

`SVC-001-design.md` §7 handed this to SVC-002 as *"a 72-hour service that loses its instance three
times is dead-lettered."* **That framing is wrong, and the frozen contract says why.**
`distributed-execution-lifecycles.json` `forbiddenCrossLifecycleEdges` contains
`serviceInstance:lost → attempt:failed`, *"because the reconciler replaces the instance with a new
attempt and fence."* A replacement is a **new job**, at `attemptNumber` 1. The ceiling binds the
attempts of **one** instance's job; it does not bind how many times a service may be replaced. This
is machine-checked by `scripts/check-distributed-execution-foundation.mjs` in the always-on `policy`
job — SVC-002 gets a free structural gate on getting the shape right.

## 6. ★ The biggest risk

**SVC-002 will be written as a loop, and the acceptance clause that matters is a
uniqueness invariant.**

Three of the four clauses are satisfied by *reading the right thing before acting*: the desired
state, the quota, the target status. Those are control-flow properties and a loop can hold them.
The fourth — *"without duplicate placement"* — is a property of the **storage**, and this programme
has shipped the wrong version of it before: a lock that a future writer need not take, a check the
happy path passes and the racing path skips, a guard that cannot see the thing it guards
(`SVC-001-result.md` §3, where three immutability tests all stayed green under a mutant that erased
every row they claimed to protect).

**The specific failure mode to design against:** SVC-002 serializes reconcile passes with an
advisory lock or a `SELECT … FOR UPDATE`, the concurrency test spawns two reconcilers, one row
appears, the clause goes green — and then SVC-004's restart path or SVC-007's manual "start now"
control inserts an instance **without taking the lock**, because nothing forces it to. The
invariant was never in the database. The four-test acceptance suite cannot see that, exactly as
SVC-001's three immutability tests could not see `ON DELETE CASCADE`.

The mechanism must therefore be one that binds **every** writer, including one that has not been
written yet, and the concurrency test must be able to fail under a mutant that removes it.

## 7. Three register obligations, one of them a hard CI gate

1. **★ `ownerTicketDeferrals["DE-12"]` goes STALE the moment any `SVC-002-*.md` lands and the
   required `policy` job goes RED.** `findTicketIds`
   (`scripts/check-threat-control-audit-debt.mjs:109-123`) derives ticket ids from filenames under
   `docs/replatform/epics/*/tickets/` via `/^([A-Z]+-\d+)/`; the staleness rule is at `:231-243`
   (*"Remove the entry in the landing commit"*). The checker runs in `.github/workflows/pr.yml`'s
   required `policy` job. **The deferral must be deleted in the same commit as these documents**,
   and its removal is safe because the crossing's `deliveryStatus` is `partial` and it will then
   name an on-disk owner ticket, which is exactly what the guard demands.

2. **The E9 gate-clause entry — and the GO-BOOK contradicts itself about it.**
   `scripts/gate-clause-wiring.json` carries 21 clauses and **none for E9**.
   `GO-BOOK.md:1771-1772` (marked *"Terrain-verified 2026-08-27"*) asks SVC-002 to create one.
   `GO-BOOK.md:171-176` — dated **2026-08-28**, one day later — records that the E9 gate-clause
   guard **did not survive scoping**: *"PREMATURE (no real service-execution symbol to track until
   SVC-002 lands … so a clause would be vacuous) — resolved 2026-08-28."* The later passage wins,
   and it names its own release condition: *until SVC-002 lands.* Verified against the checker:
   `countProductionCallers` (`scripts/check-gate-clause-wiring.mjs:155-186`) returns `0` for a
   symbol that does not exist, and an `unwired` clause with count 0 **passes** — so a clause added
   now would be admitted and would assert nothing. It belongs in the implementation commit, keyed
   to a symbol that exists by then.

3. **★ E9 has no `findings.md`** while E0–E8, E10 and E11 all do, and this mapping found two
   defects that belong in one: **§5.1** (`ServiceHealthStatus` still carries `interrupted` while the
   DB CHECK no longer permits it — a live contradiction, and `SVC-001-result.md` §6 claims the edit
   that never happened) and **§2** (`SUPERVISABLE_WORKLOAD_CAPABILITIES` is batch-only, a third and
   unrecorded reason DE-12's control cannot fire, invisible to every register in the repo).

   Both are written out in full above and neither is SVC-002's to fix. **Creating
   `docs/replatform/epics/E9-service-agents/findings.md` with them as `E9-F001` (MED, `unowned`) and
   `E9-F002` (HIGH, `unowned`) is an obligation of the SVC-002 implementation commit**, along with
   their entries in `scripts/finding-ownership.json` — a new open finding is born undeclared and
   undeclared **fails** (`scripts/lib/finding-ownership.mjs:409-411`), so the register cannot be
   created and then forgotten. Suggested wording:
   - **E9-F001** — `unowned` because the narrowing edit is SVC-003's by `SVC-001-design.md` §3.2
     CORRECTION 6a and SVC-003 has zero files on disk; NOT `accepted`, because a shipped result
     document that misreports its own diff is not something to accept. Resolution: delete
     `| "interrupted"` at `tenant/job-control.ts:620` **and** add the missing subset assertion
     against the frozen `SERVICE_INSTANCE_STATUSES`, or the same drift recurs. **Do not fix it by
     widening the type to all nine** — that expands a governed fence mutator's input domain, which
     CORRECTION 6a reserved for SVC-003.
   - **E9-F002** — `unowned` because the change is a worker-daemon one (widen the constant **and**
     compose the service supervisor the daemon does not have) and no ticket on disk carries it;
     HIGH, and HIGH may not be `accepted`. Resolution: a daemon advertises `workload.service` and a
     service job is observed leased, or E9's acceptance language is amended to say no service is
     dispatchable and DE-12's `deliveryEvidence` is corrected to carry this third reason.

   A defect recorded only in a design document is the weak form this programme keeps re-learning;
   the reason these are recorded here rather than filed here is that this is a docs-only commit and
   filing a finding is a code-register act, not a prose one.
