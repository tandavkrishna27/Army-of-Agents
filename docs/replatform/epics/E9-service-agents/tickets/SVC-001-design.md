# SVC-001 — Desired-state service schema and API — DESIGN

**Epic:** E9 · **Lane:** B (`C:\e8`) · **Start SHA:** this commit · **Terrain:** [`SVC-001-terrain.md`](./SVC-001-terrain.md)
**Status:** designed, NOT implemented. **One decision (§2) needs sign-off before implementation.**

> **Method.** Five independent design lenses over the terrain, then one adversarial reviewer who
> re-opened every load-bearing file rather than trusting a lens. The reviewer's verdict was *"safe
> with named corrections — not safe as-is"*: it found a HIGH defect in the **majority** schema
> proposal, refuted the terrain's own recommended TTL option, and refuted one of the terrain's
> factual claims. All six mandatory corrections are folded in below and attributed where the
> lenses disagreed — because the defects were concentrated exactly where they disagreed.

---

## 1. What SVC-001 does and does not build

**Zero new wire surface.** The whole per-instance service contract is already frozen
(`serviceWorkloadV1Schema`, `SERVICE_DESIRED_STATES`, nine `SERVICE_INSTANCE_STATUSES`, nine event
payloads, `serviceReconcileSourceSchema`). SVC-001 consumes it. This is the mistake BRW-001 made
and this lane does not repeat.

**One migration (`0264`), one new table, three constraint reconciliations, one validator promotion,
one stamping guard.** No frozen edits, no `job-leasing.ts` edit.

## 2. ★ THE DECISION — C-prime, and why the terrain's own recommendation was wrong

The terrain established that `buildJobEnvelope` (`job-leasing.ts:344-348`) derives every envelope
deadline from `job.input.maxRuntimeSeconds ?? 600`, a field belonging to `batchWorkloadV1Schema`
alone — so **every service job (and every browser job) carries a 600-second deadline**, and the
field cannot be added because `job.input` IS the workload and the schema is `.strict()`.

It recommended option C: *"make service leases long."* **That was refuted during design.**

- **Expressibility.** `leaseDurationMs` is fixed at service construction (`job-leasing.ts:399`,
  default 300 000 ms); `worker-control.ts:100-105` passes none. No per-job or per-workload seam
  exists outside the forbidden file. The one lever outside it is **global**, and
  `reapExpiredLeases` reclaims strictly on `leases.expires_at <= clock_timestamp()`
  (`job-control.ts:3337`) — so a 72 h lease makes a crashed **batch** worker's job unreclaimable
  for 72 hours.
- **Self-contradiction.** The reconciler's stop reaches a worker through exactly one channel:
  `cancelRequested` on the lease-renew response (`job.ts:461`, surfaced `job-control.ts:2388`).
  The daemon renews at `expiresAt − lead` (`lease-renewal.ts:389`). **TTL stop latency is bounded
  by renewal cadence** — so a long lease makes the stop slower. Option C asked one knob to be both
  large and small.

### The decision to take on the record

> **DECISION (SVC-001).** For the `service` workload class the envelope's `deadline` is the bound
> on *this attempt's leased session*, not the service's TTL. Service TTL is control-plane state on
> `services`, spans many instances, and is enforced by the reconciler — never by the worker.
> **Service leases stay SHORT at the 300 s default, precisely because the renew response is the
> only channel by which a stop reaches a worker.** `leaseDurationMs` is not raised;
> `job-leasing.ts` is not edited; nothing frozen changes.

**What makes this defensible rather than a rationalisation:** no worker reads `envelope.deadline`
at all. Verified — the only two repo-wide readers outside tests are a schema invariant
(`job.ts:372`) and cleanup authority's own unrelated config (`cleanup-authority.ts:102`).
`control_command` is ACK-only (`worker-control.ts:725,750`), and the renew response carries no
deadline. `graceful_stop`/`checkpoint` carry a `deadline` on the frozen wire
(`transport.ts:636-637`) **that no delivery path can convey.** So the honest statement is not "the
deadline is wrong for services" but **"the deadline is not the enforcement mechanism for any
workload class"** — said once here so SVC-003 does not rediscover it.

The channel C-prime *does* depend on is real and wired end to end, unlike the budget bridge:
`drainJob → requestCancellation({graceful:true})` → durable `cancel` command → surfaced on renew →
worker drains → reaper finalizes (`job-operations.ts:211-220`, `job-reconciliation.ts:100-112`,
`job-control.ts:3138/3266/3279/2388`).

**Keeping it real:** C-prime is a documentation decision, and this programme's documentation
decisions evaporate. What keeps it honest is a test — `envelope.deadline` has exactly one reader
today and C-prime says it must keep having one. A guard asserting no production module outside
`packages/worker-protocol` reads `.deadline` off a job envelope makes the decision enforceable
instead of re-litigable.

**Also recorded against this lane:** the same line gives every **browser** job a 600 s deadline,
ignoring the `maxSessionSeconds` ceiling BRW-001 validated and mutation-tested. Latent (nothing
reads the deadline), recorded in [`BRW-002-result.md`](../../E8-browser-automation/tickets/BRW-002-result.md) §7.

## 3. Schema — with the six mandatory corrections applied

### 3.1 `service_generations` (new)

Immutable definition rows. Enforcement is **grant omission**: `SELECT, INSERT` only for `aoa_app`,
no `UPDATE`, no `DELETE`. There is no DB backstop available — re-verified, **zero** `CREATE TRIGGER`
or `CREATE RULE` across all 264 migrations — so the ACL is the mechanism, and it is fail-closed
(`assertExactServingRoleAuthority` exact-matches every relation).

**★ CORRECTION 1 (HIGH, the majority proposal was wrong).** Two of three lenses cascaded
generations from `services`. `aoa_app` holds `DELETE` on `services`
(`job-control-legacy-grants.ts:116`), and **a referential action executes with the constraint's
rights, not the caller's** — so `DELETE FROM services` would erase every "immutable" generation
while `aoa_app` holds no DELETE on the table. Worse, the acceptance test all lenses proposed
(`DELETE FROM service_generations` → 42501) **still passes** under that design: a guard that cannot
see the thing it guards. → **`ON DELETE RESTRICT`**, plus a fourth assertion (`DELETE FROM services`
→ `23503`, generations survive), whose mutation is "flip RESTRICT to CASCADE and watch it go red."
Consequence, consistent with the frozen authority: a service with generations becomes undeletable
and `desiredState='deleted'` is the tombstone — `deleted` has no outgoing transitions
(`states.ts:183-188`).

**★ CORRECTION 2 (HIGH).** Company scoping is *necessarily* app-layer — `aoa.organization_id` is
the only GUC (`rls-tenant.ts:81`) — so a denormalized `company_id` carries the entire company
guarantee and its integrity is everything. Two lenses left it forgeable (independent FKs, or none
at all): a generation could carry company B while its service belongs to company A, both inside
org X, with every constraint satisfied. → **triple-composite FK**
`(organization_id, company_id, service_id) → services(organization_id, company_id, id)`, which
requires adding `services_org_company_id_uq`. This is the house pattern: `jobs` carries both
uniques (`jobs.ts:99-108`) and `job_attempts` binds the triple.

**★ CORRECTION 4.** No `services.current_generation_id`. One lens proposed it plus a downward
cascade, i.e. a non-deferrable **RI cycle** whose delete ordering nobody verified. Resolve the
current generation by `(organization_id, service_id, services.generation)` against
`service_generations_service_generation_uq` instead. The cycle disappears; the cost is one
uniqueness invariant that lives in a test rather than a constraint, stated here because no
cross-table CHECK can express it.

**★ CORRECTION 3.** **No `actor_context_policy_id` column.** Three lenses said omit it, one
included it and then conceded "nothing reads it" — which is precisely the vacuously-true acceptance
the terrain flagged. See §4.

`generation` is a plain integer, never `serial`/IDENTITY (a sequence is a separate relation the
exact-match ACL model would have to account for).

### 3.2 Constraint reconciliations

| Constraint | Today | Frozen authority | Action |
|---|---|---|---|
| `services_desired_state_check` | `running, stopped, deleted` | `SERVICE_DESIRED_STATES` = +`paused` (`states.ts:179`) | widen — **`paused` is currently unwritable, so SVC-005's pause has no storage** |
| `service_instances_status_check` | 5, incl. non-frozen `interrupted` | 9 (`states.ts:199-209`) | reconcile; drop `interrupted` |
| `service_instances` uniqueness | **none** | — | add `unique(organization_id, id)` so a composite FK can bind |

**A third hand-listed copy the terrain missed:** `ServiceHealthStatus`
(`job-control.ts:543`) is `"healthy" | "stopped" | "lost" | "interrupted"`, consumed by
`recordServiceHealth` (`:425`) which writes straight into `serviceInstances.status` (`:2985-2987`).
Reconciling only the DB CHECK leaves this drifted. **★ CORRECTION 6a:** narrow the edit to
*removing* `interrupted` only. Widening it to the full nine expands the input domain of a governed
fence mutator (`job-fencing.ts:69`, pinned at `job-fence-surface.contract.test.ts:55`), which is
**SVC-003's** scope.

The `interrupted` backfill is **defensive, not load-bearing**: `grep -arn` finds exactly two hits,
both declarations, no writer and no fixture. Keep it (one idempotent `UPDATE`), don't dress it up.

**`packages/db` cannot import the frozen enum** — it does not depend on `@armyofagents/worker-protocol`
(only `shared`, `drizzle-orm`, `postgres`); `server` depends on both. So the CHECK-vs-frozen
reconciliation test lives server-side.

### 3.3 Migration `0264`

`0263_brief_felicia_hardy.sql` is latest on disk; **re-check at commit, not now** — Lane A may take
0264. Copy the fully-worked house pattern from `0257`: `CREATE TABLE IF NOT EXISTS`, every
`ADD CONSTRAINT` inside `DO $$ … EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
`CREATE INDEX IF NOT EXISTS`, then the C14 security block (REVOKE from PUBLIC + `aoa_operator`,
GRANT the exact privileges to `aoa_app`, ENABLE + FORCE RLS, DROP POLICY IF EXISTS, CREATE POLICY on
`organization_id = current_setting('aoa.organization_id', true)::uuid`). Partial-privilege grants are
precedented (`0257` grants `live_event_sequences` only SELECT/INSERT/UPDATE).

**The idempotency guard is necessary, not belt-and-braces:** `migration-idempotency.test.ts:132`
matches only `/^\s*CREATE (UNIQUE )?(TABLE|INDEX)\s+"/` — **`ADD CONSTRAINT` and `UPDATE` are covered
by no static check**, and the double-apply block (`:222`) is scoped by name to specific migrations.
Add a named `0264` double-apply case.

**Open C14 judgement call, stated rather than slipped past:** whether `pnpm db:generate` originates
the `DROP CONSTRAINT`/`ADD CONSTRAINT` pair for a *changed* CHECK. Nobody ran drizzle-kit. If it does
not, those two swaps are hand-authored DDL and must be recorded as an explicit exception under
CLAUDE.md rule #1, not filed under "C14 guards."

**Registration is a fail-closed trap with three hooks, not two:** absence from
`PLAN_DERIVED_ACL_MATRIX.relations` → runtime throw (`job-control-legacy-grants.ts:721`); absence
from `RELATION_ACL_NULLNESS_CERTIFICATE` → **typecheck** error (`:716` `satisfies`); and `:753-770`
walks `dbSchema` and throws for any serving relation without a checked-in Drizzle table — which makes
the `packages/db/src/schema/index.ts` export line load-bearing. `JOB_CONTROL_NEW_PATH_GRANTS` must
**not** be touched (immutable migration 0214, no exclusion mechanism —
`job-control-legacy-grants.contract.test.ts:748-757`). Plus `appTablePrivileges()`
(`distributed-execution-databases.ts:105-123`).

## 4. Clause (b) — what is delivered and what is deferred by name

Clause (b) has two halves and only one is a schema clause.

**Delivered: desired state is tenant and actor scoped.** RLS on `organization_id`, composite FKs,
app-layer company predicates, and the stamping guard in §5.

**Deferred to SVC-003 by name: memory/context access.** Not because it is hard, but because
*nothing exists to point a column at*:
- `MemoryActor` (`memory-access.ts:10-18`) is `founder | team_lead | team_member | commander | agent`
  — **no `service`** — while frozen `PRINCIPAL_TYPES` *does* include `"service"` and
  `job-leasing.ts:109-118` already maps service → `principalType: "service"`. The wire and the RBAC
  layer disagree, and reconciling them touches Decisions #118/#119 — a successor decision, not a
  quiet edit.
- There is **no memory or context operation** among the ten frozen `WORKER_PROTOCOL_OPERATIONS`
  (`transport.ts:757-767`).
- **★ The terrain was WRONG about the fallback.** It said "what exists instead is a one-shot
  host-side pre-stage." Refuted: `stageCodingRun` (`sandbox-coding-staging.ts:185`) has **zero
  production callers** — six calls, all in its own test file. *Nothing stages a memory bundle into
  any sandbox today.* That strengthens the case for deferral.

Shipping a `contextPolicyId` column here would be the DSK-002 / REL-004 vacuously-true pattern
verbatim: a column, a test that it is tenant-scoped, a green clause, and nothing reading it.
**It is not shipped.**

## 5. Clause (d) — enforcement, and what it honestly buys

**The clause is currently FALSE, not vacuous** — which is good news, because the test has a real red
state. The `service` slot in `WORKLOAD_INPUT_VALIDATORS` is `not_enforced` and passes input through
byte-identically (`workload-input-validators.test.ts:62-64`, `:86-92` both green today), and
`FORBIDDEN_WIRE_KEYS` has no port/host/url. So a service job carrying `{"port": 8080}` is **accepted
with 201 today**, persisted and hashed, and dies silently at envelope parse.

Promote the slot to `enforced` following BRW-001's established registry pattern exactly
(`HttpError(400)`, validation after both authorization stages so it is not an oracle, `commandDigest`
still hashing the raw command so replay is unaffected). Derive the allow-list from
`serviceWorkloadV1Schema.shape` with a module-load disjointness guard against the deny-set — derivation
alone auto-widens, so the deny-set needs its own mutation signature. **Do not scan `args` for
`--port`**: the clause governs declarative configuration, not process arguments.

**★ What clause (d) does NOT buy, stated so nobody misreads it.** E2B serves arbitrary in-sandbox
ports to the public internet unauthenticated at a URL derivable from the sandboxId
(measured, `BRW-002-terrain.md` §1). **A service that merely LISTENS is publicly reachable with no
ingress configuration at all.** Clause (d) prevents *declaring* ingress; it does not prevent
*reachability*. Those are different guarantees and only one is delivered here.

### The stamping guard, and its honest limit

`serviceSourceIsAdmitted` (`job-control.ts:1525-1537`) authorizes on `source.serviceId`/`generation`
and never sees the workload; `validateWorkloadInput` (`job-submission.ts:243`) never sees the source.
So server-stamp `serviceId` and `generation` from the authorized source rather than trusting the
caller.

**★ CORRECTION 6b — this covers two of three identity fields.** `serviceWorkloadV1Schema` requires
`serviceId`, `serviceInstanceId`, `generation` (`job.ts:313-315`), but
`serviceReconcileSourceSchema` (`source.ts:119-128`) has **no `serviceInstanceId`** — so it stays
caller-controlled and validated against nothing. Nothing downstream rescues it: `service_instances`
has no `company_id` and `repos.serviceInstances.getById` filters on `id` alone
(`tenant/index.ts:185-191`). Either add an app-layer lookup asserting the named instance exists with
matching `(organization_id, service_id, generation)`, or state on the record that instance-identity
authorization is SVC-002/SVC-003's. **The result doc must not read T2 as "the service workload's
identity is authorized."**

Also recorded: `serviceSourceIsAdmitted` returns `{ kind: "service_instance", id: row.id }` where
`row.id` is a **`services`** id (`job-control.ts:1536`), which `job-leasing.ts:112-116` maps to
`principalType: "service"`. So `jobs.executor_principal_id` holds a *service* id under a kind named
*service_instance*, and `executor_principal_kind` is unconstrained `text` with no CHECK
(`jobs.ts:54`). SVC-002/SVC-003 will read that expecting an instance id.

`job-shadow-admissibility.ts:156` calls `serviceSourceIsAdmitted` but **not** `validateWorkloadInput`,
so the shadow probe is unaffected by the promotion — and does not get the stamping guard either.

## 6. Tests — each with its red state

| # | Test | Red state it starts from |
|---|---|---|
| T1 schema | CHECK constraints match the frozen enums; `paused` is writable; `service_instances` has `unique(organization_id, id)` | `paused` currently violates the CHECK; the unique does not exist |
| T2 authorization | stamped `serviceId`/`generation` always equal the authorized source's | caller-supplied values are persisted verbatim today |
| T3 generation | `UPDATE`/`DELETE` on `service_generations` as `aoa_app` → 42501; **and `DELETE FROM services` → 23503 with generations surviving** | the table does not exist; the 4th case is red under the rejected CASCADE design |
| T4 invalid-ingress | `{"port": 8080}` on a service submission → 400 | **accepted with 201 today** |

Windows runs these via `AOA_RUN_WIN_INTEGRATION=1` after building `@armyofagents/plugin-sdk`;
otherwise Linux CI.

## 7. Scope-outs — stated, so the acceptance table cannot read them as delivered

- **"instance" beyond the CHECK fix + unique.** The Outcome names it first-class; this design gives
  it two constraints. No `company_id`, no job/attempt/lease linkage, no `started_at`/`last_health_at`.
  `repos.serviceInstances.insert` has zero production callers.
- **The produced-checkpoint half of "checkpoint references."** Generations store a restore-*input*
  pointer; there is no storage for a checkpoint a run *produces*. And
  `job_control_commands_kind_check` permits five of the frozen six kinds — **`checkpoint` was omitted**
  when `0240_familiar_magneto.sql:13` widened three→five — so a checkpoint request cannot be persisted
  at all. `job_events.ts:78` already carries `service_checkpoint_restored`, so the event vocabulary
  exists and the command storage does not. → **SVC-004**, recorded now because its acceptance depends
  on it.
- **`job_artifacts` has no `unique(organization_id, id)`** (only two *partial* uniques, which cannot
  be FK targets), so a composite FK to a checkpoint artifact is not currently possible.
- **Actor/context policy reference** — §4, deferred to SVC-003 by name.
- **The 3-attempt ceiling → SVC-002.** Every genuine loss consumes an attempt and `reapExpiredLeases`
  retries only while `attemptNumber < maxAttempts` (`job-control.ts:3441`, default 3, no submit-time
  override). The uncapped `allocateRetryAttempt` has **zero production callers**, and the lifecycle
  contract already forbids the generic path.
- **TTL granularity is the renewal cadence** (~300 s), not an instant. SVC-005's acceptance should
  assert a **bound**, not immediacy.

## 8. Deployment honesty

Clause (a)'s grant-omission mechanism binds on the `aoa_app` pool. **★ CORRECTION 5:** it is wrong to
write "unenforced in the default deployment." `app.ts:437-447` mounts the entire job-control surface
**only** when `distributedExecutionEnabled`, and refuses owner fallback by name (*"owner fallback is
forbidden"*). Flag-off there is no route, no pool, and no way to create a service or generation at
all. The honest acceptance row is **"unexercised flag-off; enforced on the `aoa_app` pool flag-on."**

The in-process owner handle is still one line away — `db` is passed into `jobControlRoutes` and used
at `routes/job-control.ts:64` — so extend the existing static source-boundary gate
(`check-distributed-execution-foundation.mjs:1806 validateAppSourceBoundary`, invoked at `:2661`) to
cover the new service routes.
