# SVC-002 — Service reconciler and placement — RESULT

**Epic:** E9 · **Lane:** B · **Base:** `743c30f08` (branched from `docs/replatform-program`)
**Design:** [`SVC-002-design.md`](./SVC-002-design.md) · **Terrain:** [`SVC-002-terrain.md`](./SVC-002-terrain.md)
**Register:** gate clause `E9-1-service-reconciler` enrolled `wired`. **No finding closed.
E9-F001 and E9-F002 are untouched and both stay `open`; `E9-F003` is OPENED here (§6a(iii)).**

---

## 1. What shipped, in one paragraph

A polling sweeper (`createServiceReconciler`) composed at the composition root inside the
`distributedExecutionEnabled && distributedExecutionDatabases` block drives one reconcile
pass per `(organization, service)`. A pass reads the INTENDED state (`services.desired_state`
and `services.generation`, pinned under a row lock, plus the immutable
`service_generations.definition` for that generation) and the OBSERVED state (the count of
non-terminal `service_instances` rows), and creates exactly one instance and one `service`
job when the intent is `running`, the intent is fully readable, and the observation is zero —
both writes inside ONE transaction, so a quota denial unwinds the instance with the job. The
duplicate-placement invariant is a **partial unique index**, `service_instances_live_service_uq`,
not the loop. `serviceSourceIsAdmitted` gained the `desired_state = 'running'` predicate it
never had. Zero wire change; zero new relations; zero new routes.

---

## 2. Which source is OBSERVED, which is INTENDED, and what happens when the intent is UNKNOWN

| | Source | Read by |
|---|---|---|
| **INTENDED** | `services.desired_state` + `services.generation`, and `service_generations.definition` | `lockServiceForReconcile`, `findServiceGenerationDefinition` |
| **OBSERVED** | count of `service_instances` NOT in a frozen terminal state | `countNonTerminalInstances` |

**The unknown case is not the absent case, and the branch says so.**
`service_generations` has **zero writers in the tree** and SVC-002 adds none — the
create/update controls that would fill it are SVC-007's. So `findServiceGenerationDefinition`
answers `null` for every service on every real deployment today. That `null` is treated as
**"cannot decide"** — `{action:"none", reason:"no_generation"}` — and never as "start it with
a default command". `desired_state='running'` says the intent IS to run; the definition needed
to realize that intent is unreadable; a default branch returning a definite answer there is
exactly the fail-open SVC-008b's `deriveStopVerdict` work exists to refuse. **An honest stall
that does nothing beats a confident wrong verdict that acts.** T3(c) pins it.

---

## 3. The arming path, counted rather than asserted

The brief's warning was that a reconciler is exactly the shape that ships wired to nothing.
Measured with the register's own `countProductionCallers`, base (`743c30f08`) vs head:

| Symbol | Base | Head | What the head count is |
|---|---|---|---|
| `createServiceReconciler` | — (did not exist) | **2** | ONE composition site in `server/src/index.ts` — the `const { createServiceReconciler } = await import(...)` binding plus the call. The guard counts both because its import-stripping regex only blanks static `import … from` forms. The measured figure is reported, not the intuitive one. |
| `reconcileService` | — | **1** | the sweeper's per-service pass |
| `reconcileServiceWithinTenant` | — | **1** | `reconcileService` |
| `deriveReconciliationId` / `deriveServiceIdempotencyKey` | — | **1** each | the submission this builds |
| `createStartupReconciler` (the cautionary neighbour) | **0** | **0** | untouched; still zero |

The chain above the composition is real: the block already builds the `aoa_app` pool, and the
sibling MIG-002 convergence sweeper is registered three statements earlier on the same pool
and the same org enumerator.

**And what that running timer actually does today, said plainly:** `listReconcilableServices`
scans `services`, which has one insert in the whole tree with **zero production callers**.
There is no route by which anyone can create a service. On every real deployment this tick
reads an empty window and converges nothing. What it delivers is that the moment such a row
exists, exactly one instance and one job appear for it and never two.

---

## 4. Reds observed, and the named positive control

**Twelve mutants in total across four revisions; the last four below came out of review and each names a REAL BUG this diff shipped and then fixed.**

**★ HOW THE REDS WERE OBSERVED, stated so it is not over-read.** Only ONE case is red on the
unchanged base tree; the rest are red under mutants applied to the shipped source. A suite
that drives a module which does not exist at base reds on "cannot import", which proves
nothing about the shipped path — SVC-008b's lesson — so the reds below are the mutation
results, and each mutant was **verified applied in the rebuilt `dist/`** before its result was
believed. (That check is not ceremony: `packages/db` tests resolve through `dist`, and this
repo has already shipped a "surviving" mutant that was never applied because a `\n` anchor
missed a CRLF tree. The mutation harness asserted the anchor matched and reported which
line-ending form it matched; several matched CRLF.)

**The genuine base-tree red — T3(b), three cases.** Before SVC-002, `serviceSourceIsAdmitted`
filtered on `id` / `organizationId` / `companyId` / `generation` with **no `desiredState`
predicate at all**, so a `service_reconcile` submission naming a `stopped`, `paused` or
`deleted` service was admitted. Deleting the new predicate reproduces that state exactly, and
all three cases go red on it.

**NAMED POSITIVE CONTROL: `T4 POSITIVE CONTROL — the SAME placement input selects an ACTIVE
service-capable target and refuses a DRAINING one`.** Pure `decideJobPlacement`, the real
JOB-009 authority. It was green before, green after, and green under **every** mutant below.
Had it reded alongside the others, the harness broke rather than the feature — and without it,
T4 could pass because placement never selects anything at all, which would prove nothing
about drain.

| Mutant | Result |
|---|---|
| Drop `service_instances_live_service_uq` | **2 red** — SCHEMA, and T1a (`expected 'inserted' to be 'conflict'`: the second lock-free inserter committed, two live instances for one service) |
| Widen the index predicate with `'pending'` | **2 red** — SCHEMA (`['failed','lost','pending','stopped']` vs the frozen terminals) and T1a |
| Bare `catch {}` in place of the constraint-name check | **1 red** — T1d: a foreign-key violation was swallowed and reported as `conflict` for a service with no instance |
| Revert `reconciliationId` to `randomUUID()` | **1 red** — T1c: two jobs for one instance id |
| Catch the 429 **inside** the transaction | **1 red** — T2's zero-**instances** half, with its zero-**jobs** half still green: the orphan `pending` instance that wedges a service forever |
| Delete the reconciler's sweep filter | **1 red** — T3(a), on the **reason** and the **no-error** assertion (`"Job submission denied"`). A vacuous "zero instances" assertion would have stayed green, because the admission predicate denies and the transaction rolls back — §5's masking hazard, avoided |
| Delete the `desiredState` admission predicate | **3 red** — T3(b) ×3. This is the base-tree state |
| Change that predicate to `ne('stopped')` | **2 red** — `paused` and `deleted`, with `stopped` still green: the allow-list-vs-deny-list discrimination |
| Anchor the per-organization sweep at the head instead of its cursor | **1 red** — T5: `expected [ …(2) ] to deeply equal [ …(5) ]`, two of five services converged and three starved forever. A REAL BUG in revision 1 (§6a(ii)) |
| Drop the `notExists` convergence predicate from `listReconcilableServices` | **2 red** — T4's per-tick `services` count goes `[1,1,1]`, and T6's window still returns all three converged services. A REAL BUG in revision 2 (§6a(vi)) |
| Wrap the sweep cursor on a SHORT page without checking it was fully processed | **1 red** — T7: with three stalled services ahead of it, the fourth is never reached (`expected [] to deeply equal [ Array(1) ]`). A REAL BUG in revision 2 (§6a(v)) |
| Revert the live-instance predicate from inlined literals to `notInArray` | **2 red** — the compiled statement carries three bind parameters, so the partial index cannot be proven applicable and a generic plan seq-scans. A REAL BUG in revision 2 (§6a(vii)) |

---

## 5. ★★★ TWO MUTANTS THE DESIGN NAMED DID NOT KILL

Recorded rather than dropped, because a mutant that was claimed and never checked is how a
clause becomes vacuous.

**5.1 — "change step 4's predicate to `status = 'healthy'` → red on ticks 2 and 3" is FALSE.**
`SVC-002-design.md` §7 names that mutant for T4. Measured: **the suite stays GREEN** (14/14 at the time; T5 was added later, in the review pass).
The reason is the masking shape the design itself warned about for T1:
`countNonTerminalInstances` and `service_instances_live_service_uq` carry **the same
predicate at two layers**. Under the mutant, tick 2 walks past the observed-state check, hits
the index, resolves to `conflict`, and still returns `instance_present` — `created` stays
`[1,0,0]`.

Measured three ways so the clause is not vacuous:

| Mutation | T4 |
|---|---|
| healthy predicate only | **green** (the index masks it) |
| index dropped only | **green** (the count check masks it) |
| index dropped **and** healthy predicate | **RED** — `created` is `[1,1,1]`: three instances and three jobs across three ticks, the exact failure mode the row describes |

The honest reading: the observed-state predicate is a **fast path**, the index is the
**authority**, and the property survives losing either one. What is not true is that T4 pins
the predicate on its own.

**5.2 — the advisory lock is not individually necessary, and neither is the `FOR UPDATE`.**
`lockServiceForReconcile` holds two serializing mechanisms at the same granularity:
`pg_advisory_xact_lock(hashtext('aoa:service-reconcile'), hashtext(serviceId))` and
`SELECT … FROM services … FOR UPDATE`. Removing **either one alone** leaves the suite green;
the serialization case reds only when **both** go. So T1b(ii) pins the pair, and its earlier
title — "the advisory lock actually serializes" — was a false attribution and has been
corrected in the test file. The design gives the two different justifications (step 1
"serializes concurrent passes", step 2 "interlocks with SVC-005's generation bump"); at
SVC-002's granularity those justifications collapse into one. The advisory lock is kept
because the design mandates it and because its only distinct value is for a future writer that
serializes without reading the `services` row — but that value is speculative, and it is
precisely why the duplicate-placement authority is **neither of them**.

**Both facts strengthen rather than weaken the central design claim**: the index is the only
mechanism in this ticket that binds a writer which has not been written yet, and T1a exercises
it with two **lock-free** inserters on separate connections rather than through the
reconciler.

---

## 6. Deviations from the design, each with its reason

**6.1 — SIX repository methods, not four.** The design names `lockServiceForReconcile`,
`countNonTerminalInstances`, `insertServiceInstance` and `listReconcilableServices`. Two more
were unavoidable:

* `attributeServiceInstance` — the design's §8 requires `job_id`/`attempt_id` on the instance
  row and its §3.2 acknowledges steps 5 and 6 are mutually dependent. The ordering is forced:
  the instance id must exist **before** the submission (the frozen workload requires
  `serviceInstanceId`, and the derived idempotency identity is a function of it), and the
  job/attempt ids only exist **after** it. Inserting last would mean the loser of a race had
  already claimed org capacity and written a job before discovering it lost. So the insert is
  first and the attribution is a second write in the same transaction. It touches only
  `job_id`/`attempt_id`; `recordServiceHealth` remains the sole writer of `status`.
* `findServiceGenerationDefinition` — see §6.2.

All six are classified `EXPECTED_UNGUARDED` in `job-fence-surface.contract.test.ts` **in this
commit** (that test fails closed on any unclassified method). None is worker-side, none is
reached through a lease, and at the point they run no job and therefore no fence exists —
`guardActiveFence` would be unsatisfiable rather than stricter, the same reasoning DAT-008's
`insertExecutionSecretHandle` is classified on.

**6.2 — §10.1 is DECIDED, and the decision is option (a).** The design left open where
`service_generations.definition` comes from. SVC-002 adds the **read** and treats a missing
row as a stall. The alternative — tests constructing generation rows while the reconciler has
no reader — would leave the acceptance suite driving a table the shipped code never touches,
which is the vacuity pattern this epic keeps hitting. The cost is stated rather than hidden:
SVC-002 ships a read for a table only SVC-007 can fill, so there is **still no end-to-end
path**. What it buys is that the unreadable-intent branch is real code with a real test
(T3(c)) instead of a paragraph.

**6.3 — the §10 inherited question is SETTLED by running the generator.** "Whether
`pnpm db:generate` originates the `DROP CONSTRAINT` / `ADD CONSTRAINT` pair for the FK
replacement" — it does. Migration `0275` is drizzle-kit output for both statements, exactly as
SVC-001 measured for a changed CHECK. **No hand-authored DDL.** The only hand edits are C14
class (a) idempotency guards (`IF EXISTS` / `IF NOT EXISTS` / a `duplicate_object`+
`duplicate_table` block), and no C14 class (b) security block is needed because
`service_instances` is an already-registered relation whose grants, RLS and policy are in
place and adding columns to it changes no ACL.

**6.4 — §10.2 and §10.3 stay OPEN, and neither was settled by implementing around it.**
`serviceInstanceId` is closed **by construction for the reconciler** (it is the primary key of
a row inserted in the same transaction) and **not by authorization**: a hypothetical second
`system`-principal caller could still name any instance id, and adding the field to
`serviceReconcileSourceSchema` remains a Protocol Custodian STOP. The result must never be
read as "the service workload's identity is authorized". `job_id`/`attempt_id` ship as plain
columns rather than composite FKs into `jobs`, for the design's stated reason (the dependency
direction is wrong and the ON DELETE semantics are not obvious); it is additive either way.

**6.5 — a sentinel-organization assert the design does not name.** `reconcileService` calls
`assertAdmissibleOrganization` before opening its transaction, for parity with
`jobSubmissionService.submit`. `listAdmittedOrganizationIds` already excludes the sentinel, but
this function is exported and a future caller need not come through the sweeper.

**6.6 — the parent-FK rename leaves a STALE CONSTRAINT NAME in a frozen evidence string, and it
is NOT edited here.** `docs/architecture/distributed-execution-threat-controls.json` records, in a
crossing's `deliveryEvidence`, the list of constraints TEN-004's negative test fires on — including
`service_instances_org_service_fk`, which this ticket renamed to
`service_instances_org_company_service_fk`. The sentence is now inaccurate about that one name.
**It is deliberately left alone:** `scripts/check-evidence-immutability.mjs` compares evidence
records against the PR's base revision, so editing an evidence string here would fail the required
`policy` job, and rewriting another ticket's evidence is not this unit's to do. The live test itself
IS updated (`tenant-composite-integrity.integration.test.ts` now asserts the new name, and gained
the company-mismatch arm the old pair FK could not express), so the mechanism is correct and only
the narration is stale. Flagged rather than fixed, and named here so the next unit touching that
crossing corrects it under the right guard.

**6.7 — `service_instances.company_id` is NOT NULL with no backfill.** Safe for a measured
reason: at the base commit the table had exactly one INSERT in the tree with zero production
callers, so no deployment has ever written a row. If that ever stops being true the statement
fails loudly on a non-empty table rather than silently stamping a sentinel company — the
fail-closed direction.

---

---

## 6a. Review findings (PR #406), each verified against source

**SEVEN** were raised across three rounds. **All seven were real. FIVE were bugs in this diff and
are fixed here; TWO are pre-existing and are recorded rather than closed** — one filed as a new
finding, one already on the register.

**(i) P1 — fixtures inserting `service_instances` without `company_id`. REAL, FIXED.** The original
diff's census used the Drizzle symbol and therefore missed four suites that insert with **raw SQL**:
`server/src/__tests__/job-fencing.integration.test.ts` (2 sites),
`server/src/__tests__/tenant-rls-enforcement.integration.test.ts` (2),
`packages/db/src/__tests__/tenant-composite-integrity.integration.test.ts`, and
`packages/db/src/__tests__/tenant-composite-ondelete.integration.test.ts`. Every one would have hit
a NOT NULL violation during setup once 0275 applied, so `verify` could not have passed. All now
supply the service's company. The composite-integrity case additionally had to move off the old
constraint name and **gained the arm the pair FK could not express**: right org, right service,
**wrong company** — E2-F013's exact shape, which is why the FK was widened in the first place.
*A lesson worth keeping: a symbol grep is not a census when the table is also reachable by raw SQL.*

**(ii) P2 — per-organization service cursor. REAL, FIXED, with a regression test.** The sweeper
always requested the FIRST page (`afterServiceId: null`). A converged service stays
`desired_state='running'` forever, so for a tenant with more than `serviceBatchLimit` running
services the same lowest-id rows filled every page on every tick and **every later service was
never reconciled** — silently, with nothing erroring. The sweep now pages from a per-organization
cursor carried across ticks, advancing on admission (so one wedged service cannot pin the rotation)
and wrapping to `null` on a short page. **T5** pins it: five services at a page size of two, three
ticks, all five converged. Observed RED under the exact pre-fix behaviour
(`afterServiceId: null`): `expected [ …(2) ] to deeply equal [ …(5) ]` — two of five, forever.

**A second review round on the fixed diff raised three more. Two were real bugs in my own
fix and are fixed; one is real, epic-wide and already filed elsewhere.**

**(iv) P1 — the reconciler writes no `activity_log` entry. REAL, EPIC-WIDE, PRE-EXISTING,
ALREADY FILED, NOT CLOSED HERE.** Measured: `job-submission.ts` writes no `activity_log` for
**any** source kind, and `jobAuditBridge` — the vehicle purpose-built for exactly this — has
**zero production callers** (`countProductionCallers`, and its only references are its own
definition plus `job-audit-parity.integration.test.ts`). So no distributed submission is
audited: not `task_run`, not `commander_turn`, not `crew_run`, not `one_shot`, not
`browser_request`, and not `service_reconcile`. It is already on the register —
`E0-foundation/findings.md` records it under DE-01, and
`distributed-execution-threat-controls.json` names the caller-less bridge in its own evidence.
Auditing only the service path here would leave five older source kinds unaudited while the
register said the class was being closed, which is worse than the honest gap. The bridge also
has a structural obstacle (`activity_log.run_id` FKs to `heartbeat_runs`, which a distributed
attempt has no row in) that the bridge exists to solve and a bespoke write here would not.

**(v) P2 — the cursor wrapped on a SHORT page even when the budget cut it off part-way. REAL,
FIXED, with T7.** The wrap now requires the page to have been fully processed. ★ The scenario
that makes this reachable is not the obvious one: for services that **converge** it is
harmless, because they leave the window (see (vi)) and a head restart lands on the tail
anyway. It bites services that **stay** in the window — and today that is *every* service on a
real deployment, since `service_generations` has no writer and every pass stalls at
`no_generation`. **T7** drives a controlled monotonic clock so exactly one row is admitted per
tick, with three stalled services sorted before one reconcilable one; observed RED under the
pre-fix wrap (`expected [] to deeply equal [ Array(1) ]` — the fourth service never reached).

**(vi) P2 — the per-organization cursor is process-local, so a restart loses it. REAL, and the
fix is the reviewer's own alternative.** I had argued a lost cursor costs "a wasted read"; the
reviewer's escalation is correct — for a tenant whose service set exceeds one tick budget,
repeated restarts before a full pass completes can starve the tail indefinitely, and the
zero-create ticks in between take the 30-second idle delay. **`listReconcilableServices` now
excludes services that already have a non-terminal instance**, so the window *is* the remaining
work and every tick shortens it whether or not anything was remembered. The `NOT EXISTS` is
served by `service_instances_live_service_uq`, whose index predicate is byte-for-byte the
subquery's. **The cursor is kept but demoted**, and the comment now says which half is
load-bearing. **T6** pins it; observed RED under a dropped predicate (2 cases: T4's per-tick
`services` count goes `[1,1,1]`, and the window still returns all three converged services).
★ T6's own comment records what mutant 13 taught: its *converged-list* assertion does **not**
discriminate — one tick pages the whole tenant with the in-tick cursor — and the
**empty-window** assertion is the one that separates the arms. An earlier draft of that comment
claimed the fresh-sweeper setup was the discriminator; it is not.

**A third round raised one more, and it confirmed a risk I had flagged for review myself.**

**(vii) P1 — the sweep's convergence predicate is emitted as BIND PARAMETERS, so the partial
index is unusable under a generic plan. REAL, FIXED.** I had asked the reviewer to check
exactly this claim ("if that reasoning is wrong, this is a sequential scan per tick per
tenant"). It was wrong. Drizzle's `notInArray` emits the three statuses as `$n` parameters;
postgres-js prepares these statements; and once PostgreSQL promotes a prepared statement to a
GENERIC plan (after five custom executions) it can no longer prove that
`status NOT IN ($1,$2,$3)` implies the LITERAL predicate of `service_instances_live_service_uq`
— so the index drops out of the plan. **Reproduced by the reviewer on PostgreSQL 18: the generic
plan sequentially scanned `service_instances`.** For a tenant with substantial instance history
that turns the per-tick sweep into a full rescan and can push it into the statement timeout,
which delays or prevents reconciliation — the opposite of what the predicate was added to do.

**Fixed with ONE shared helper**, `nonTerminalServiceInstanceStatus()`, which emits the frozen
terminals as inlined SQL literals and is used by **all three** readers of "is there a live
instance" (the sweep `NOT EXISTS`, the observed-state count, and the lost-race re-read), so
they cannot drift from each other or from the index predicate they are meant to match. The
literals are derived from `TERMINAL_SERVICE_INSTANCE_STATUSES` and a module-load guard rejects
any value that is not a bare lowercase identifier, which makes the `sql.raw` provably safe
rather than safe-by-inspection.

**Pinned by `packages/db/src/__tests__/service-instance-live-predicate.test.ts`** (4 cases),
which compiles the predicate through `PgDialect` and asserts **zero bind parameters**. A pure
SQL-shape assertion is the right instrument here: an EXPLAIN-based test would have to force
five custom executions to reach the generic plan, which is slow and timing-dependent, while
the property that actually matters is decidable from the compiled statement. Observed RED under
a revert to `notInArray`: `expected [ 'stopped', 'failed', 'lost' ] to deeply equal []`.

*Worth keeping: an index predicate and a query predicate that are textually identical are still
not interchangeable if one of them is parameterised. "Served by the index" is a claim about the
PLAN, and the plan depends on how the values reach the planner.*

**★ AND THE FIX TRIPPED A GUARD, WHICH IS THE GUARD WORKING.** `sql.raw` is a **dynamic
raw-SQL site**, and `job-leasing-contract.test.ts` keeps an exhaustive inventory of every one in
`server/src` + `packages/db` so that each is a reviewed decision rather than an accident. CI's
`verify (3)` went red on `expected [ …(44) ] to deeply equal [ …(43) ]` — my new site, undeclared.
It is now declared, with the two things a reader needs: **why it is `raw`** (the generic-plan
problem above) and **why it is safe** — the interpolated text is built only from a frozen
`as const` array of three literals in the same module, a module-load guard throws unless every one
matches `/^[a-z_]+$/`, and the helper **takes no arguments at all**, so no caller input can reach
it. That is a mechanism, not an assurance.

*Second lesson, and it is about my own process: `pnpm -r build` plus the suites I could name did
not cover a whole-tree AST contract test in a file I had never touched. The instrument that would
have caught it before CI is the full package suite, not a targeted list.*

**(iii) P1 — the executor principal names the SERVICE under the kind `service_instance`. REAL,
PRE-EXISTING, NOT FIXED, now FILED as `E9-F003`.** `serviceSourceIsAdmitted` returns a `services`
id as `{kind:"service_instance"}`, and `job-leasing.ts` carries that into the lease envelope's
`executionPrincipal` — so a worker gets an envelope whose principal is the service while the same
envelope's workload carries a different `serviceInstanceId`. The reviewer's proposed fix — pass the
instance identity through admission — is **not available to SVC-002**: `serviceReconcileSourceSchema`
carries no `serviceInstanceId` and adding it is a **Protocol Custodian STOP** (design §10.2), while
reading it off the caller-controlled workload instead would promote an *unauthorized* value into a
persisted principal id, turning a mislabel into an authorization defect. What SVC-002 does deliver
is the other direction: `service_instances.job_id`/`.attempt_id`, written in the same transaction.
Recorded in prose since terrain §5.4 and never filed — so it is filed now, `unowned`, with its
`scripts/finding-ownership.json` entry in this commit.

---

## 7. What is still NOT true after this, and what E9's gate still needs

**E9's exit gate is not met and SVC-002 does not meet it.** The gate names desired state,
generation, placement, health, restart, checkpoint, drain, budgets, UI, and a 72-hour D4
canary. SVC-002 delivers the first two-and-a-bit.

* **Nothing creates a service.** `repos.services.insert` keeps its zero production callers and
  SVC-002 adds no routes. The reconciler reconciles rows only a test can create. SVC-007.
* **Nothing writes a generation.** `service_generations` still has zero writers. SVC-007.
* **The loop converges once and goes quiescent.** `recordServiceHealth` is still the only
  writer of `service_instances.status` and still has no consumer, so nothing drives an instance
  terminal and nothing triggers a replacement. SVC-003.
* **Drain means one thing here, not two.** A draining target is not *selected* for a new
  instance. Moving, stopping or replacing an instance already running on a target that has
  begun draining is SVC-003/SVC-005.
* **E9-F003 is OPENED, not closed.** The lease envelope's `executionPrincipal` for a
  `service_reconcile` job names the SERVICE under the kind `service_instance`, while the
  same envelope's workload carries a different `serviceInstanceId`. Closing it needs a
  Protocol Custodian ruling (design §10.2), which this unit cannot make. §6a(iii).
* **No distributed submission writes an `activity_log` entry** — not this one and not the
  five older source kinds. `jobAuditBridge` has zero production callers. Already on the
  register under DE-01; §6a(iv).
* **E9-F001 is untouched.** `ServiceHealthStatus` still carries `"interrupted"` while the DB
  CHECK forbids it. SVC-002 does not widen or narrow a governed fence mutator.
* **E9-F002 stays open**, and its `deliveryEvidence` is unchanged by this ticket. SVC-008b
  closed four of its five blockers; the fifth (the never-re-minted effect authority, SVC-008
  §9.1) is bounded rather than answered, so a supervised service is a 240-second service. A
  job this reconciler submits can now be *offered* to a daemon that advertises
  `workload.service` with a free service slot — the T4 positive control shows the placement
  authority selecting exactly such a target — but nothing in this ticket ran one.
* **The three-attempt ceiling is not the constraint SVC-001 handed over** (design §8.1), and
  the residual it names — nothing bounds how many times a service may be *replaced* — is
  SVC-004's crash-loop clause and needs a restart counter SVC-002 deliberately does not add.

**Deployment honesty.** The reconciler composes inside the
`distributedExecutionEnabled && distributedExecutionDatabases` block, where `app.ts` refuses
owner fallback by name. The accurate wording is **"unexercised flag-off; enforced on the
`aoa_app` pool flag-on"** — not "unenforced by default".
