# SVC-001 — Desired-state service schema and API — TERRAIN

**Epic:** E9 · **Lane:** B (`C:\e8`) · **Mapped at:** `3c405671c`
**Status:** terrain complete. **One decision must be taken on the record before design (§2).**
**Depends on:** CLI-006 ✅, TEN-004 ✅, PRT-002 ✅

**Spec.** Outcome: service definition, generation, desired replicas (initially 1), instance,
restart policy, TTL, budget, checkpoint references, actor/context policy reference.
Acceptance: updates create a new immutable generation; desired state and memory/context access
are tenant and actor scoped; workers receive neither database credentials nor direct
memory-table access; no public port/ingress configuration is accepted.
Test: schema, authorization, generation, invalid-ingress.

> **Method.** Four lenses mapped the tree; a critic re-verified every load-bearing claim,
> resolved one hypothesis, and flagged six conclusions as unsafe. All negatives use `grep -a`.
> The critic received only three of four lens reports and says so — anything the fourth found
> is unrepresented.

---

## 1. Far more exists than the ticket title implies — and none of it is reachable

**The frozen wire already carries the entire per-instance service surface. SVC-001 needs ZERO
new wire schema** (the mistake BRW-001 made and this lane has now learned twice):
`serviceWorkloadV1Schema` (`job.ts:312`) with serviceId / serviceInstanceId / generation /
command / args / checkpointArtifactId / gracefulStopSeconds; `"service"` in `WORKLOAD_TYPES`;
`workload.service` in `KNOWN_WORKER_CAPABILITIES` plus `serviceSlots` capacity and the slot
check in `workerSatisfiesRequirements`; `SERVICE_DESIRED_STATES` and nine
`SERVICE_INSTANCE_STATUSES` with transition functions; **nine** service event payload schemas;
`serviceReconcileSourceSchema`; provider `checkpoint`/`restore`/`health` ops; and branded
`serviceIdSchema`/`serviceInstanceIdSchema`.

**Two tables already exist** — `services` and `service_instances` — with RLS forced, composite
tenant FKs, grants, and tenant repositories. But they are **E2 stubs**: `services` has only
`desiredState` + `generation`; `service_instances` only `generation` + `status`. Their own
comments say *"Rich service columns are deferred to E3 (additive)"* — and **E3 shipped without
adding them**, so SVC-001 inherits the whole additive set.

**Nothing is reachable in production.** No code anywhere constructs a `service_reconcile`
source; `SOURCE_REQUESTER_KINDS` restricts it to `["system"]` and the HTTP route's
`principalFor` cannot mint a system principal; `repos.services`, `repos.serviceInstances` and
`recordServiceHealth` have **zero non-test callers**.

**The thing SVC-001 must NOT extend:** `workspace_runtime_services` — long-running dev servers
with port/url/health/stopPolicy behind an HTTP preview proxy. It is the closest in-product
shape and the wrong one: it is exactly the "public port" model this ticket forbids.

## 2. ★ THE DECISION: every service job gets a 600-second deadline

`buildJobEnvelope` (`server/src/services/job-leasing.ts:344-348`) derives the envelope
deadline as:

```js
input.databaseNow.getTime() + Math.max(1, Number(
  (input.job.input as Record<string, unknown>).maxRuntimeSeconds ?? 600)) * 1_000
```

`maxRuntimeSeconds` is a field of **`batchWorkloadV1Schema` only**. Service has no runtime
bound at all; browser has `maxSessionSeconds`. And because `job.input` IS the workload and the
schema is `.strict()`, **you cannot add `maxRuntimeSeconds` to a service input** — it produces
`unrecognized_keys`, a null envelope, and the silent-never-leases defect BRW-001 exists to
prevent.

**So every service envelope carries `now + 600 s` — a ten-minute deadline on the workload class
whose exit gate is 72 wall-clock hours.**

Three ways out, and SVC-001 must pick one **on the record**:

1. **Add a runtime bound to `serviceWorkloadV1Schema`** — a frozen wire change and a **Protocol
   Custodian STOP** (`job.ts:312`, a field beside `gracefulStopSeconds`). Settle before design
   per handoff §7 / E4-D02.
2. **Edit the deadline derivation** — `job-leasing.ts` is in the **DO-NOT-TOUCH** set.
3. **Declare that the deadline is the LEASE, not the TTL** — carry service TTL
   control-plane-side as a reconciler stop decision. **The only option needing neither a wire
   change nor a do-not-touch edit.**

> **★ CORRECTION (design stage). The wording of option 3 above — "let `leaseExpiresAt + 1`
> dominate by making service leases long" — IS NOT IMPLEMENTABLE, and was refuted during
> design.** Both halves fail independently. *Expressibility:* `leaseDurationMs` is fixed at
> service construction (`job-leasing.ts:399`, default 300 000 ms) and `worker-control.ts:100-105`
> passes none — there is no per-job or per-workload seam outside the forbidden file, and the one
> lever that IS outside it is global, so a 72 h lease would make a crashed *batch* worker's job
> unreclaimable for 72 hours (`reapExpiredLeases` fires only on `expires_at <= clock_timestamp()`,
> `job-control.ts:3337`). *Self-contradiction:* the reconciler's stop reaches a worker through
> exactly one channel — `cancelRequested` on the lease-renew response (`job.ts:461`) — so a long
> lease makes renewals rare and the TTL stop SLOWER. Option 3 asked one knob to be both large and
> small. The corrected form (**C-prime**: leases stay SHORT at the 300 s default *because* the
> renew response is the only stop channel) is specified in
> [`SVC-001-design.md`](./SVC-001-design.md) §2, which supersedes this paragraph.

**Severity today: LATENT, not live.** The envelope `deadline` is set and schema-validated but
read by **nothing** in production (`grep -a` over `server/src` + `packages/worker-daemon/src`
finds no consumer; the one `.deadline` hit is cleanup authority's own unrelated config). It
bites the moment a worker honours it.

**★ This is also a defect in THIS LANE'S OWN completed work.** The same line means a browser
job's `maxSessionSeconds` — the ceiling BRW-001 validated, defaulted and mutation-tested — is
**never read for the deadline** either. A browser session configured for 3600 s carries a 600 s
envelope deadline. BRW-001, BRW-002 and BRW-003 all missed it. Recorded in
`BRW-002-result.md` §7 as a cross-cutting finding.

## 3. Per-clause readiness

### (a) "Updates create a new immutable generation" — SUFFICIENT to design against

`services.generation` is a **mutable integer** and is never bumped anywhere (`grep -a
"update(services)"` → nothing). There is no generation table. There are **zero** triggers or
rules in all 264 migrations, so immutability has no DB backstop anywhere in this repo — the
existing patterns (artifact_versions, memory_item_versions) enforce by convention.

The one real mechanism available is **grant omission**: a relation registered without INSERT/
UPDATE privileges cannot be written by `aoa_app`, and the ACL certificate throws at **import**
if a relation is unregistered (`job-control-legacy-grants.ts:722-727`).

**Unknown:** that binds only under `AOA_DISTRIBUTED_EXECUTION_ENABLED` on the `aoa_app` pool.
Default deployments connect as table owner, where a grant constrains nothing. **SVC-001 must
state which deployment its acceptance test asserts against.**

### (b) "desired state and memory/context access are tenant and actor scoped" — NOT designable

This is the clause that is not a schema clause, and it is §6's biggest risk.

*Tenant* scoping is designable: `aoa.organization_id` is the **only** GUC — no company GUC, no
actor GUC — so company and actor scoping are necessarily app-layer, and `repos.services.getById`
has no company predicate at all (within one org it returns another company's service).

*Memory/context* is not:
- **There is no memory or context operation on the frozen wire.** `WORKER_PROTOCOL_OPERATIONS`
  is exactly ten (`transport.ts:756-768`) and none of them is memory. There is no
  `actorPolicyRef`; the only policy-reference pattern is `networkPolicyRefSchema`.
- **The mechanism a policy reference would point at is explicitly deferred.** DAT-007 owns the
  brokered surface and its own result doc says its core is *"BLOCKED on out-of-worktree
  substrate + needs a design decision"*, with an unbuilt, security-critical
  `runId → job → active-lease/fence` resolver named in its residual.
- **What exists instead is a one-shot host-side pre-stage** (`sandbox-coding-memory-bundle.ts`),
  built for a bounded coding run. For a service whose gate is 72 hours, a bundle frozen at
  start is stale for three days — while SVC-003's acceptance requires callbacks that *"require
  the current fence"*, i.e. a live call.
- **The wire and the RBAC layer disagree about whether a service is an actor.** Frozen
  `PRINCIPAL_TYPES` includes `"service"`, and `job-leasing.ts:109-118` already maps
  service/service_instance → `principalType: "service"`. But `MemoryActor`
  (`memory-access.ts:9-16`) is `founder | team_lead | team_member | commander | agent` — **no
  service**. Widening it touches Decisions #118/#119 and needs a successor decision, not a
  quiet edit.

### (c) "workers receive neither DB credentials nor direct memory-table access" — SUFFICIENT

Already structurally true: workers get opaque secret handles only, there is no memory operation
to abuse, and the package boundary is CI-enforced.

**But it is in tension with (b), and the resolution is written down nowhere.**
`denyControlPlane: z.literal(true)` (`policy.ts:90`) is unrelaxable, and a live
memory/context callback from a service sandbox is *by definition* a call to the control plane.
Whether a brokered channel is exempt (being authenticated rather than sandbox egress) is
**undocumented** — flagged as a hypothesis, not a finding.

### (d) "no public port/ingress configuration is accepted" — SUFFICIENT, and currently FALSE

Empirically verified against the built schema: `port`, `ingress`, `publicUrl` and `hostname`
all produce `unrecognized_keys` — the **wire** rejects them.

**But the clause says *accepted*, and the acceptance surface is submission, not leasing.** The
`service` slot in `WORKLOAD_INPUT_VALIDATORS` is `not_enforced` and passes input through
byte-identically, and `FORBIDDEN_WIRE_KEYS` contains no `port`/`host`/`url`/`ingress`. **So a
service job carrying `{"port": 8080}` is accepted with 201 today, persisted and hashed, and
dies silently at envelope parse with no lease and no error.**

That is good news: the invalid-ingress test has a **real red-to-green target** rather than a
vacuous one. Do not carry "already satisfied by absence" into design — that was the lenses'
error and the critic corrected it.

**The sharper question, from this lane's own measurement:** E2B serves arbitrary in-sandbox
ports to the public internet unauthenticated, at a URL derivable from the sandboxId
(`BRW-002-terrain.md` §1). **A service that merely LISTENS is publicly reachable with no
ingress configuration at all.** "No public ingress" governs a config field while the actual
exposure comes from somewhere else entirely. SVC-001 should state what the clause does and does
not buy.

## 4. Migration scope — larger than one table

| Table | Change |
|---|---|
| `services` | the additive Outcome columns, **and widen `services_desired_state_check`** — it is `IN ('running','stopped','deleted')` while the frozen authority has four states including `paused`. **`paused` is currently unwritable, so SVC-005's pause/resume has no storage.** |
| `service_instances` | reconcile `service_instances_status_check` — 5 values (`pending, healthy, stopped, lost, interrupted`) against the frozen **9**; **`interrupted` is not a frozen state at all**. Also add `unique(organization_id, id)`: it has none, so nothing can bind a composite FK to an instance. |
| new `service_generations` | the immutable definition row. |

**Numbering:** latest on disk is `0263`. Lane A holds 0262/0263, so 0264 looks free — re-check
at commit, not at design. A new distributed table costs **two** grant surfaces plus a C14
idempotency hand-append, and per this programme's MIG-008 experience the **drizzle-generated**
`CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT` also need `IF NOT EXISTS` / `duplicate_object`
guards, or `migrations` passes on first apply while `migration-idempotency` and `readiness`
fail.

## 5. Boundaries and things to hand on, not absorb

SVC-001's writes land outside the do-not-touch set — BRW-001's submission-time strategy
transfers cleanly. Two adjacent defects should be **recorded and handed on** rather than fixed
here, to keep the diff honest:

- `serviceSourceIsAdmitted` has no `desiredState` predicate — that is **SVC-002's** acceptance
  clause ("stopped services create no new instance").
- `recordServiceHealth` writes health into the instance-status column scoped only by
  `organizationId` — that is **SVC-003's**.

**Budget has no scope that fits.** `budget_policies.scopeType` is `"company" | "agent"`; there
is no per-service or per-job scope. And the distributed budget mechanism
(`job-budget-cost-bridge.ts`, JOB-012) has **zero production callers** — so SVC-005's *"budget
stop … cannot be overridden by the worker"* rests on an inert bridge. SVC-001's budget column
has neither a scope to reuse nor a live enforcement path.

**Cheap existing gates to hang evidence on:** `distributed-execution-lifecycles.json`
`forbiddenCrossLifecycleEdges` has four service-specific edges, machine-checked by
`scripts/check-distributed-execution-foundation.mjs` in the always-on `policy` job. One is a
direct structural instruction: *"A lost instance does not drive a generic attempt terminal; the
reconciler replaces the instance with a new attempt and fence."* And
`distributed-execution-threat-controls.json` DE-12 "Service split brain" is **Critical**,
verified in D4, owned by SVC-002/003/005 — SVC-001 owns no control there but builds the schema
all three need.

## 6. ★ The biggest risk

**SVC-001 will be written as a schema ticket, and clause (b) is not a schema clause.**

"Memory/context access are tenant and actor scoped" cannot be satisfied by columns. It needs an
actor kind a service instance can *be* (which `MemoryActor` lacks) and a transport by which a
running instance asks for context under the current fence (which does not exist on the frozen
wire, whose in-VM form is DAT-007's deferred core, and whose only shipped substitute is a
one-shot pre-stage that is stale within minutes of a 72-hour service).

**The failure mode is specific and this programme has lived it:** SVC-001 ships a
`contextPolicyId` column, a test asserts the column is tenant-scoped, the clause is marked
green — and the acceptance sentence is **vacuously true because nothing reads the column**.
That is the DSK-002 / REL-004 pattern verbatim. Three tickets later SVC-003 must make
*"callbacks require the current fence"* real, finds the resolver DAT-007 flagged was never
built, and either invents a security-critical auth surface under schedule pressure or defers —
leaving SVC-006's D4 canary, which requires *"actor-authorized memory context"* for 72 hours,
without the thing it certifies. D4 is a three-day lead-time gate that cannot be pulled forward.

**Therefore:** SVC-001's design must state explicitly what clause (b) does and does not deliver,
and either the actor-kind question is settled first or the clause is deferred by name to the
ticket that can satisfy it.
