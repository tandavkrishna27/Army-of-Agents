# SVC-007b — the audit invariant SVC-007a's routes could not satisfy — RESULT

**Epic:** E9 · **Lane:** B · **Base:** `c27feeea8` (branched from `docs/replatform-program`)
**Predecessor:** [`SVC-007a-result.md`](./SVC-007a-result.md) · terrain + design in
[`SVC-007a-design.md`](./SVC-007a-design.md)
**Register:** no gate clause enrolled and none claimed. **`E9-F010` OPENED and HALF-RESOLVED here;
`E9-F011` OPENED and left OPEN. `E9-F002`, `E9-F003`, `E9-F004`, `E9-F007`, `E9-F008` and `E9-F009`
are untouched. SVC-007 STAYS OPEN.**

---

## 1. The assignment was to test a claim, not to build on it

SVC-007a shipped four service routes and stated, plainly and without hiding it, that AGENTS.md's
*"Activity logging for all mutating actions"* invariant was **not met** by them — and gave a
mechanical reason for why it could not be:

> *"the shipped distributed-execution audit path is `jobAuditBridge.recordAcceptedActivity`, and
> its input contract **requires** `fence: ActiveFenceRequest` … A service CREATE has no attempt,
> and a desired-state change has no fence … it is not merely unwritten, **it is currently
> unwritable from here**."*

**Half of that is right. The other half is measured false, and it is filed as `E9-F010`.**

---

## 2. ★★★ THE VERIFICATION, BEFORE ANY CODE

### 2a. What is TRUE, and is not disputed

`RecordAcceptedActivityInput.fence` is a required, non-optional field
(`server/src/services/job-audit-bridge.ts`), and the bridge consumes it TWICE: at step (a),
`repos.jobControl.lockActiveFence(input.fence)` — the TOCTOU serialization that makes two concurrent
same-event calls queue rather than double-insert — and at step (e),
`recordGovernedProjection({...input.fence, projection})`, whose receipt carries the composite FK. No
service control action has a lease, an attempt or a fence. **That bridge genuinely cannot be called
from these routes, and nothing below suggests otherwise.**

### 2b. What is FALSE — three independent measurements at source

| # | The measurement | Where |
|---|---|---|
| 1 | **The fence is the BRIDGE's requirement, not the TABLE's.** `insertActivityLog` takes a plain `Db` — a transaction handle is one — and asks for no lease, no attempt, no fence. The bridge calls it exactly that way itself, on `tx`. | `server/src/services/activity-log.ts` (`insertActivityLog`, `insertActivity`) |
| 2 | **`aoa_app` may write the table, with no exemption and no RLS to satisfy.** `GRANT SELECT, INSERT ON "activity_log" TO "aoa_app"`, and no migration ever enables RLS on it — `0245`'s own header states the table is deliberately untouched, "non-forced", and that the table-level grants "already cover the transactional audit writes". | `packages/db/src/migrations/0213_e2_serving_role_correction.sql:98`; re-affirmed `0214_e2_serving_role_hardening.sql:166`; `0245_job_activity_audit_rls.sql` header |
| 3 | ★ **A fenceless transactional `activity_log` write ALREADY SHIPS on the distributed path.** `stageJobInputFiles` writes one bundle-level audit row with `insertActivity(tx, …)` inside `runInTenant`, `leaseId` and `fenceToken` NULL, no receipt — and its own comment forbids repairing it: *"NO LEASE, NO FENCE … do not 'tidy' this behind `guardActiveFence`, which cannot be satisfied here and would remove the capability rather than secure it."* | `server/src/services/job-input-staging.ts`; reached from `server/src/index.ts:1269` |

**Counted with the register's own `countProductionCallers`, at base `c27feeea8` and re-measured at
this commit's head:**

| Symbol | Base | Head | Note |
|---|---|---|---|
| `stageJobInputFiles` (the fenceless writer) | **2** | **2** | untouched by this unit |
| `jobAuditBridge` (the fenced bridge) | **0** | **0** | untouched by this unit |
| `insertActivity` | 5 | **6** | the sixth is this unit's `insertServiceControlActivity` |
| `recordServiceCreateActivity` | — | **1** | `createServiceWithinTenant` |
| `recordServiceDesiredStateActivity` | — | **1** | `setServiceDesiredStateWithinTenant` |
| `publishServiceControlActivity` | — | **2** | the two transaction-owning wrappers |
| `createService` / `setServiceDesiredState` | 1 / 1 | **1 / 1** | the two routes, unchanged |

★ **The inversion is the lesson.** The exceptional, zero-caller mechanism was taken for the norm and
the norm for a deviation from it. Writing `activity_log` directly is not "a SECOND, unguarded audit
path" — measured over non-test sources, `logActivity` has **283** production callers and
`insertActivity`/`insertActivityLog` **6**/**5**, and there are **36** direct
`.insert(activityLog)` sites in `server/src` — tracked files, excluding `__tests__` and excluding
COMMENT lines. ★ The exclusions are the measurement, and each excluded occurrence is accounted for
rather than waved at: a plain `grep` answers **42** occurrences over **41** lines; **4** are in
`__tests__` (all in `e0-f013-unattributable-denial-sink.integration.test.ts`) and **2** are prose
ABOUT the sites rather than sites — both on the single comment line `activity-namespace.ts:23`,
which names `db.insert(activityLog)` and `tx.insert(activityLog)` in one breath. 42 − 4 − 2 = **36**,
and reporting the bare 42 is the trap. `packages` contributes **0**, so this is the same scope
`activity-namespace.ts`'s own "THIRTY-FOUR … in `server/src`" used
— two more than when that sentence was written, and it is left alone rather than edited from here.
`jobAuditBridge` has **0**. The direct write is the first path; the fenced bridge is the one nothing
calls.

### 2c. Why no receipt is needed here — the design question, answered

JOB-013's header states its own premise: *"insertActivityLog has NO native dedup. On a **replay** the
JOB-005 receipt identity … is the guard."* The word carrying the weight is REPLAY. The bridge audits
an accepted mutation on a distributed attempt delivered **at-least-once**: the same
`acceptedEventId` can arrive twice, the mutation may already have been applied by the earlier
delivery, and the audit insert would then be the **only new write in its transaction** — nothing
else pins it, so it needs an identity-keyed receipt of its own.

**A service control action is RE-REQUESTED, not replayed, and the two are different events.** There
is no at-least-once redelivery machinery in front of these routes. `SVC-007a-result.md` §7 says of
the mutation itself that *"`services` has no natural key and no idempotency column, so two POSTs
create two services"*. Two services must leave two audit rows. A receipt keyed on a client-chosen id
would make the audit **under-report exactly where the mutation over-produced** — the wrong direction
for an audit surface.

★★★ **So the replay guard is the TRANSACTION, and it is exact rather than approximate:**

```
committed transaction   →  exactly one mutation  AND  exactly one audit row
rolled-back transaction →  no mutation           AND  no audit row
```

There is no interleaving in which the two disagree, because there is no window in which one is
durable and the other is not. **That is a stronger guarantee than the bridge's, not a weaker one** —
a receipt reconciles two things that CAN be written apart; here they cannot be written apart at all.

**So the answer to the brief's three-way question is (a): a fence-free guard is available, and it is
not an idempotency key or a natural key — it is the transaction the mutation already opens.** No
decision request is filed, and AGENTS.md is not amended.

---

## 3. What shipped

`server/src/services/service-control-audit.ts` is a new module carrying two writers — one per
audited action, each with its action hard-coded as a module constant — and an after-commit drain.
Both go through `insertActivity` → `insertActivityLog`, so `assertUnreservedActivityNamespace` and
`sanitizeRecord` run over every row. That is the rule `activity-namespace.ts` states for anyone
adding a writer, followed in both halves at once: *"a direct `insert(activityLog)` must hard-code
its `action`; if the action comes from the caller, route through `insertActivityLog` instead."*

`ServiceControlAuditContext` — `{ tx, actor, published }` — is a **required** parameter on both
`…WithinTenant` functions. Required, not optional, and that is the enforcement: an optional argument
would leave the invariant exactly as unenforced as a convention, since a caller that omitted it
would compile, run, mutate and audit nothing. `tx` is the mutation's OWN transaction handle;
`published` is the after-commit sink the two wrappers drain once `runInTenant` has returned — the
identical shape `jobAuditBridge` uses, and for the identical reason.

**What is audited, and what is not:**

| Route | Mutates? | Audited |
|---|---|---|
| `POST …/companies/:companyId/services` | yes | `service.create`, on success |
| `POST …/services/:serviceId/desired-state` | yes | `service.desired_state`, on `updated` and `unchanged` |
| `GET …/services` · `GET …/services/:serviceId` | no | n/a — reads |

★ **`unchanged` IS audited, and that is not sloppiness.** The stop still runs on `unchanged` — a
reconcile pass that began before an earlier stop can commit an instance AFTER that stop moved the
column — so an `unchanged` control action can cancel a job and terminalize an instance. Treating it
as a no-op would leave a real act unrecorded.

★ **`illegal`, `conflict` and `absent` are NOT audited.** The first two write nothing. `absent`
returns a uniform 404 whose whole purpose is that a caller cannot tell it from a cross-tenant miss,
and a row there would record a mutation that did not happen. AGENTS.md's invariant is over MUTATING
actions; a refusal is a denial-audit question and belongs to `security-denial-audit.ts`'s reserved
namespace.

★ **The operator's `reason` now reaches a durable sink on every verdict that mutates.** External
review of PR #412 raised that the route REQUIRES a `reason` and a RESUME then put it nowhere; SVC-007a
fixed that for the process log only. A process log does not outlive the process. `T15` reads the
resume's reason back out of the database.

**Lock order is unchanged.** `activity_log` is an append with no unique index and no other writer on
this path, and the audit insert is the LAST write in the control's transaction, after the
cancellation and the terminalization so it can record what happened to the instance. It adds no edge
to the order `setServiceDesiredState`'s docstring states.

---

## 4. Reds observed, the NAMED POSITIVE CONTROL, and the twelve mutants

**★ HOW THE REDS WERE OBSERVED, stated so they are not over-read.** As in SVC-007a, there is **no
genuine base-tree red** available: a suite that drives a module which does not exist at base reds on
"cannot import", which proves nothing. **Every red below is a MUTATION result**, from a harness that

* **refuses to apply when a backup already exists** (the stacking failure SVC-003a hit);
* **tries BOTH line-ending forms of every anchor and THROWS when neither matches** — this tree is
  mixed, and the campaign below matched **CRLF** on four mutants and **LF** on eight, which is
  exactly why the harness tries both rather than assuming;
* **decides applied-ness by comparing BYTES**, never by whether a step threw;
* **restores only when the apply provably landed**, so a stale anchor is never masked by a
  "NO BACKUP" error from the `finally` — and verifies the restore by **md5** plus a
  `git status --porcelain` sweep for surviving `.mutbak` files.

**NAMED POSITIVE CONTROL: `★ T9 POSITIVE CONTROL — a service with no generation still stalls at
no_generation`** — SVC-007a's own control, inherited deliberately rather than replaced. **Green
under all twelve mutants below.** It hand-inserts a `services` row and touches no audit path, so if
it ever reds under an audit mutant, the mutant broke something other than what it names.

**TWELVE MUTANTS over 46 cases** — 10 new pure (`service-control-audit.test.ts`, B1–B10) + 18
existing pure (`service-management.test.ts`) + 18 integration
(`service-management.integration.test.ts`, of which 5 are new: T14–T18). **All twelve killed.**

★ **THE TABLE BELOW IS ONE SNAPSHOT, RE-RUN WHOLE AT FINAL HEAD**, not a matrix assembled from
rows measured at different commits. The campaign ran once during the build and was run again in
full after the last source edit; both runs produced the identical twelve rows — same red counts,
same anchor forms, positive control green throughout — and `git status --porcelain` was clean
after each. A row here is not a remembered figure from an earlier revision.

| # | Mutant | Anchor | Result |
|---|---|---|---|
| M1 | Delete the create audit call entirely — **the BASE-TREE state** | CRLF | **4 red** — T14, T15, T17, T18 |
| M2 | Delete the desired-state audit call entirely | CRLF | **3 red** — B7, B8, T15 |
| M3 | Audit on EVERY verdict, including the refusals | LF | **2 red** — B9, T16 |
| M4 | Skip the audit on `unchanged` (treat a re-issued stop as a no-op) | LF | **2 red** — B8, T15 |
| M5 | Write the create audit in a SECOND transaction (a second connection) | CRLF | **4 red** — T14, T15, T17, T18 |
| M6 | Drop the after-commit drain from `createService` | CRLF | **1 red** — T18 |
| **M7** | Pass a `runId` through instead of forcing it null | LF | **17 red** — see below |
| M8 | Publish INSIDE the recorder (a pre-commit poke) | LF ×2 | **3 red** — B5, B6, T18 |
| M9 | Drop the operator's `reason` from the desired-state details | LF | **4 red** — B2, B7, B10, T15 |
| M10 | Omit the `from` key on `unchanged` rather than writing null | LF | **3 red** — B3, B8, T15 |
| M11 | Drop the try/catch from the after-commit drain | LF | **1 red** — B6 |
| M12 | Bypass `insertActivity`'s sanitizer with a raw insert | LF | **1 red** — B10 |

★ **M7 IS THE ONE TO READ, and its size is the point rather than a surprise.** Seventeen cases red,
including `★ T2` — the chain SVC-007a's whole ticket rests on — because `activity_log.run_id` FKs
`heartbeat_runs`, so a non-run id raises **23503** and rolls the CREATE back with it. A wrong audit
here does not merely mis-record; **it deletes the mutation**. That is why `runId: null` is forced at
the single private helper both writers pass through rather than left to each call site. **T9 stayed
green under it** — which is what a positive control is for: it separates "the audit path broke" from
"the reconciler broke".

★ **M12 KILLS ON ONE CASE ONLY, AND THE RESIDUAL IS STATED RATHER THAN DROPPED.** It reds `B10`, the
redaction case, and nothing else. The mutant ALSO removes the reserved-namespace guard from these
two writers, and **nothing reds for that** — `B4` drives a reserved action through the shipped
`insertActivity` directly, which the mutant does not touch, so what `B4` proves is that the guard
bites, not that these two writers reach it. Reaching it is a code-reading fact (both go through
`insertActivity`), not a measured one. It is a weak residual — both actions are module constants
outside every reserved prefix, so no caller can steer them there — but it is a residual.

**Suites:**
`server/src/__tests__/service-control-audit.test.ts` (10 new pure cases, B1–B10) and
`server/src/__tests__/service-management.integration.test.ts` (5 new cases, T14–T18, real embedded
PostgreSQL over the `aoa_app` pool, `AOA_RUN_WIN_INTEGRATION=1`), plus T1 and T13 — SVC-007a's own
rollback probes — **extended to count audit rows**, which is where the co-commit property is pinned.
All 46 cases green at head (28 pure + 18 integration).

★ **WHAT T18 DOES NOT PROVE, said in the test file too.** It proves a committed create pokes the
live feed exactly once with the right payload, and that the row is durable when the caller returns.
It does **not** prove the poke happened after the commit rather than just before it: the poke leaves
no database trace, and a second connection reading at the instant of the poke would block until
commit and answer "visible" either way. That ordering is held by construction — the drain sits after
`runInTenant` returns — and by `B5`, which pins that recording publishes nothing at all.

---

## 5. E9-F011 — the `null` that commits a wedge, found by asking what to audit

Filed OPEN, not fixed. The question "what is audited when `createServiceWithinTenant` returns
`null`?" is what exposed it: `createServiceWithinTenant`'s docstring said the `null` return means
*"the transaction rolls back"*. **It does not.** `insertServiceGeneration` catches its `23505` on a
SAVEPOINT precisely so the outer transaction survives; `runInTenant` is `withTenantTx`, where a
callback that RETURNS commits; and the route's `throw new HttpError(409, …)` runs after
`createService` has already returned. So that path commits a `services` row with **no generation** —
the permanent `no_generation` wedge the same docstring calls "not a partial success" — and no audit
row.

It is **unreachable by construction today** (the service id is minted by the `repos.services.insert`
call immediately above, in the same function, so
`(fresh uuid, 1)` cannot collide), which is why the severity is LOW and why the fix is not taken
here: it changes what the function returns and needs its own observed red. **The defect filed is the
FALSE RECORD.** The docstring is corrected in place and points at the finding. SVC-005's generation
rollout — minting N+1 on an id that already exists — is where the conflict becomes constructible for
the first time. Full statement in `../findings.md`.

---

## 6. Decisions this unit made, and what it refused

* **AGENTS.md is NOT amended, and was never going to be by this unit.** The brief named narrowing an
  invariant until it is satisfiable as a founder ruling, not a builder's edit. It is moot: the
  invariant turned out to be satisfiable as written for the routes in scope.
* **No decision request is filed**, because option (b) does not apply — the fence is not inherent to
  replay-safety, only to the one caller shaped around a redelivered event.
* **`jobAuditBridge` is NOT touched, and its zero production callers are NOT closed.** Calling it
  from here would require inventing a fence, which is the "tidying" `stageJobInputFiles` explicitly
  warns against. Its gap stays on the register.
* **DE-01 is NOT closed and is not claimed.** Its `audit` clause is *"query and policy-denial events
  recorded in the control-plane audit log"* — a different clause from AGENTS.md's mutating-action
  invariant. SVC-007a routed its gap to DE-01; that pointer is correct only for the sub-claim
  "`jobAuditBridge` has zero production callers", which is on DE-01's row. The mutating-action gap
  was on no register until `E9-F010`.
* **The three JOB-008/submission mutations are left silent, deliberately and on the record.**
  Wiring them is the same shape and needs no new mechanism — but each needs its own observed red,
  and `SVC-007a` §4a(ii) already established the precedent that a sibling route's defect is noted
  rather than fixed silently. **`E9-F010` therefore stays OPEN. Half of a conjunction is not it.**
* **No `job_projection_receipts` row is written**, and that is forced rather than chosen:
  `source_fence` is `NOT NULL` and this path has no fence — the same forced answer SVC-007a's §5
  backstop reached. `T14` asserts the receipt count is zero rather than assuming it.
* **`E9-F009`'s §3 measurement is left standing and annotated, not rewritten.** *"No repository
  method under `packages/db/src/repositories/tenant/` writes `activity_log` at all"* is re-measured
  and STILL TRUE — this unit writes from the SERVICE layer, following `job-input-staging.ts`. A note
  is added there so a reader does not carry §3 across as "the distributed path cannot write
  `activity_log`".

---

## 7. What is still NOT true after this

* **Three mutating endpoints on `jobControlRoutes` write nothing durable** — job submission, `drain`
  and worker `revoke`. Measured: neither `job-submission.ts` nor `job-operations.ts` contains any
  `activityLog` / `insertActivity` / `logActivity` reference. `E9-F010` stays OPEN on this.
* **Nothing in SVC-007a's own "still not true" list moved.** No generation rollout, no TTL, no
  checkpoint, no budget, no restart history, no UI, no realtime, no D4 canary — and **no service job
  has ever been leased in any E9 suite**, so "created, supervised, projected" is still not proven end
  to end.
* **The E9 exit gate is NOT met and is NOT claimed.** This unit moves none of its ten items; an audit
  row is not one of them.
* **`E9-F002`, `E9-F003`, `E9-F004`, `E9-F007`, `E9-F008` and `E9-F009` are untouched.** No conjunct
  of any of them moved.
* **The audit is not a UI.** `E9-F009` §4 asks for a durable record "with a reader" and names
  SVC-007's evidence surface as where it should land. This is a durable record for two CONTROL
  actions; it is not the instance-transition receipt that finding wants, and it does not close it.
* **★ THE ROW REACHES THE PRODUCT ACTIVITY FEED, AND RENDERS UNDECORATED — checked, not
  assumed.** `activity_log` is served to a company through `GET /companies/:companyId/activity`,
  so a `service.create` row is visible to that company's board today. Both UI switches on
  `entityType` have a `default` arm — `entityBorderColor`
  (`ui/src/components/settings/sections/ActivitySection.tsx`) returns `transparent` and
  `entityLink` (`ui/src/lib/activityFormat.ts`) returns `null` — so `"service"` degrades to a
  plain, unlinked row rather than crashing or blanking. **That is fail-soft, not finished:**
  there is no `/services/:id` route to link to, because SVC-007's UI is item 9 of the exit gate
  and is not delivered. Adding the entity to those two switches belongs with that UI, not here.

---

## 8. Files

| File | Change |
|---|---|
| `server/src/services/service-control-audit.ts` | new — the two writers, the after-commit drain, and the header carrying the source verification of §2 |
| `server/src/services/service-management.ts` | `ServiceControlAuditContext` (required) threaded onto both `…WithinTenant` functions and both wrappers; `applyServiceDesiredState` split out so the audit fires once on the verdict rather than at each of that function's **seven** `return` statements (re-counted at head after the last edit — an earlier draft of this row said six); `createServiceWithinTenant`'s `null`-return docstring corrected (`E9-F011`), and `createService`'s "on failure ROLLING BACK" line, which conflated a throw with a `null` return |
| `server/src/routes/job-control.ts` | both mutating service routes pass the operator actor; both logger lines read the shared action constants; **a router-level header recording which mutations on it ARE audited and which are not, and that the recorded reason for the second group is refuted** |
| `server/src/__tests__/service-control-audit.test.ts` | new — 10 pure cases (B1–B10) |
| `server/src/__tests__/service-management.integration.test.ts` | 5 new cases (T14–T18); T1 and T13 extended to count audit rows; the `create()` helper and the six existing `setServiceDesiredState` call sites carry the actor, and the two direct `…WithinTenant` probes carry the audit context |
| `server/src/__tests__/service-management.test.ts` | the control helper supplies the now-required audit context |
| `docs/replatform/epics/E9-service-agents/findings.md` | `E9-F010` filed (half-resolved, OPEN), `E9-F011` filed (OPEN), `E9-F009` §3 annotated |
| `docs/replatform/epics/E9-service-agents/tickets/SVC-007a-result.md` | §4a(iii) and §7 corrected in place — the struck sentence is left visible with its correction beside it |
| `docs/replatform/epics/E9-service-agents/README.md` | SVC-007b's paragraph; the "no `activity_log` row" clause in SVC-007a's paragraph struck and corrected |
| `scripts/finding-ownership.json` | `E9-F010` and `E9-F011`, both `unowned` with reasons |
| `docs/.../tickets/SVC-007b-result.md` | new — this document |

**Eleven files, and the table above is all eleven** — counted against `git diff --stat` at head
rather than listed from memory.

**No migration, no schema change, no new relation, no wire change.** `activity_log` already had
every grant this unit uses, and it needed none it did not have.
