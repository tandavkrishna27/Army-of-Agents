# DECISION REQUEST — the six clause-halves E0-F013 says cannot be delivered as written

**Date:** 2026-09-10
**Decision:** `E0-F013` **Decision 1** — *"What happens to the clause-halves that cannot be
delivered as written."*
**Register under discussion:** `docs/architecture/distributed-execution-threat-controls.json`
**Status changes made by this document:** **NONE.** No finding is closed, struck, re-dispositioned
or re-owned; no `deliveryStatus` is moved; no clause text in the register is edited; no
`scripts/gate-clause-wiring.json` enrolment is added or changed. **Amending the register IS the
decision being requested**, so this paper does not pre-empt it by making the amendment.
**Production code written:** none.

---

## 0. The headline, stated so it cannot outrun its own measurement

Six clause-halves were queued here. **Measured at source, they are not one shape and not one
verdict, and on THREE of the six the stated blocker does not hold. On two of those three the clause
turns out to be deliverable; on the third — DE-17 — a different and harder blocker takes its place.**

| # | Clause-half | E0-F013's stated blocker | Measured verdict |
|---|---|---|---|
| 1 | **DE-01** `audit`, read-denial conjunct | "needs a `BYPASSRLS` comparator, the privilege `client.ts:325` forbids" | ★ **THE BLOCKER IS FALSE** — already refuted in-tree and in CI. Deliverable. The residual objection is a **design** cost, not an impossibility. ★ **RULED 2026-09-11 (Decision 1.1c):** the read-denial conjunct is AMENDED to a documented DECLINE — a filtered read is a legal empty result, so there is no inline event to record at any privilege; the blocker stays false; a narrow offline verifier is chartered but UNFUNDED (read as (a)-plain, not coverage); conjuncts 1a/1b stay unblocked-but-unwritten; DE-01 stays `partial` and in E0-F010's cohort. |
| 2 | **DE-27** `audit`, cross-replica + partition conjuncts | "the system has no replica identity; the clause is unsatisfiable" | **SPLIT.** The *partition* conjunct is genuinely vacuous. The *cross-replica admission* conjunct is **ambiguous, not unsatisfiable** — under the weaker of its two readings it is ordinary Group B/C work. |
| 3 | **DE-12** `audit`, generation-change conjunct | "`services.generation` has no writer" | **PARTLY undeliverable.** The clause has **three** conjuncts. ★ **FACT CORRECTION 2026-09-11 (see §4):** conjunct 3c ("generation changes are audited") is **now DELIVERED** — `services.generation` has a writer (`bumpServiceGeneration`) and a roll writes a durable `activity_log` row. Only **3a (partition)** and **3b (drain)** remain vacuous; those are the amend targets. Row stays `partial`. ★ **RULED 2026-09-11:** (a) CORRECTED — drop ONLY 3a+3b as vacuous and RECORD 3c DELIVERED (enacted in the register). The §4.3 "drop all three" text and its "SVC-003/SVC-005 zero files" census are STALE-FALSE at HEAD; see the §4.3 SUPERSEDED banner. |
| 4 | **DE-20** `audit`, rollback conjunct | "`createDistributedExecutionDrain` has zero production callers" | **CONFIRMED undeliverable** for the rollback conjunct (4b). ★ **FACT CORRECTION 2026-09-11 (see §5):** the *other* conjunct (4a, cutover selection) is **now DELIVERED at HEAD** for BOTH arms (`cutover-selection-audit.ts`) — it was "closable today" at branch point and has since been closed. Only 4b remains, and it does not belong in this decision. |
| 5 | **DE-11** `audit` (whole clause) | "the controls themselves are absent; nothing decides, so there is nothing to record" | ★★ **THE PREMISE IS STALE.** Something *does* decide, at a named line, with a tenant and a live DB handle already in scope. **Deliverable, cheaply.** ★ **RULED 2026-09-11:** REMOVED from this decision (rescheduled). |
| 6 | **DE-17** `audit` (whole clause) | "needs a wire hop, and `worker-protocol` is v1-FROZEN" | ★ **STILL BLOCKED — but not by the freeze, and the real blocker is HARDER.** ★★ **CORRECTED ON REVIEW, see §6.2.** The extension container *is* additive under the freeze and *is* a real carrier — but the worker-event **ingest** path is fence-guarded and the adapter-manager's wire capability is **not authority-typed**, so neither channel reaches DE-17's post-fence boundary. ★ **RULED 2026-09-11 (corrected same day after a Codex P1, verified at source):** UN-BUNDLED, but 6a is **NOT** deliverable-now — the post-fence cleanup (`CleanupAuthority.converge`) runs off-plane in the worker daemon with no worker→CP carrier for its outcome, and the existing drain carries denials, not cleanup outcomes. So 6a ALSO needs that unbuilt cleanup-outcome carrier (SIMPLER than 6b — report the outcome, no authority-typing); 6b needs EITHER E0-F014 authority-typing (the adapter-manager then reports the escalation over its OWN CP channel, no worker carrier) OR a worker self-report. Both halves need an unbuilt mechanism — different ones; the v1 freeze is not the blocker; DE-17 stays the sole hard-block. |

**So: of the six, THREE are hard (DE-12, DE-20's rollback conjunct, DE-17), ONE is half-hard
(DE-27), and TWO were mis-blocked (DE-01, DE-11).** Per the brief's standing rule — *exoneration
needs strictly more evidence than conviction* — each of those two is evidenced at a file:line below,
and neither is claimed **delivered**; they are claimed **not blocked for the stated reason**.

★★ **AND DE-17 IS THE STANDING RULE BITING THIS PAPER.** As first written, §6.2 concluded that
DE-17's stated blocker (the protocol freeze) does not hold — which is **true** — and then took the
further step of concluding it was therefore *not architecturally blocked*, recommending a split by
channel. **That further step was wrong, and it was wrong in this programme's own worst way: it named
a carrier without measuring whether the carrier reaches the durable store on the path DE-17
actually names.** Raised as P1 by Codex on PR #407, verified at source, and corrected in §6.2 and in
Decision 1.6 rather than footnoted. The refutation of the *stated* blocker stands; the exoneration
does not. **Disproving one blocker is not proving deliverability** — and this paper had to relearn
that on its own page.

**And the arithmetic in the finding is off by one, in the direction that flatters it.** §7 shows the
working: under `E0-F013`'s *own* groupings the number is **ELEVEN**, not twelve. *(That is E0-F013's pre-ruling baseline. After the 2026-09-11 ruling freed five of the six Group-D halves, §7 settles the post-ruling **closable-ever ceiling at SIXTEEN** — a different figure, and distinct again from the current **twelve-open** count.)*

---

## 1. Method, and what this paper refuses to inherit

Every clause below is quoted **verbatim** from
`docs/architecture/distributed-execution-threat-controls.json` at branch point `743c30f08`, then
decomposed into **conjuncts** and judged one conjunct at a time.

**★ THE UNIT OF ANALYSIS IS THE CONJUNCT, NOT THE ROW, AND NOT THE "HALF".** This programme has
twice recorded a whole clause for a half (`DE-06`'s retraction, 2026-09-09) and once corrected it in
the same document that committed it (`E7-F011`). It has also recorded a *half* for a *third*: `DE-12`'s
audit clause is a **three**-way conjunction and `E0-F013` queues only one of the three here. That is
the same error at a smaller scale, and §4 fixes it.

Nothing below is inherited from `E0-F013`'s Group D, from the register's `deliveryEvidence`, or from
the Decision 2 paper. Each is re-run at tip.

### ★★★ 1.1 THAT PROMISE WAS BROKEN TWICE, AND THIS IS WHERE IT SAYS SO

**The first draft of this paper inherited from `deliveryEvidence` in two places, and in both places
what it inherited was stale.** Both were caught on review and both are corrected below rather than
footnoted. They are recorded here, at the promise, because a method section that states a rule and
does not record its own violations is the weaker half of the failure this paper is about.

1. **The `SVC-*` census (§2.5, §4.3, §4.4, Decision 1.3).** *"All three ownerTickets have ZERO files
   on disk — the only crossing in the register with no on-disk owner ticket at all — and the only
   authored `SVC` ticket disclaims it in writing"* is **the register's own DE-12 `deliveryEvidence`,
   reproduced element for element in the same order.** It was true when W20 measured it at
   `360d0b0ed` (2026-09-08 15:47). **`SVC-002-design.md` (604 lines) and `SVC-002-terrain.md` (350
   lines) landed nine hours later in `08746b160` (PR #388, 2026-09-09 00:23) — before this paper's
   own branch point.** The census is re-run from scratch in §4.3 and every assertion that depended on
   it is corrected. ★ **This is the paper's own thesis turned on itself: a census must be re-run, not
   inherited, and the one the paper did not re-run is the one that was wrong.**
2. **DE-11's access citations (§6.1, conjunct 5a).** The file:line list under "access is gated and
   denies" reproduced DE-11's `deliveryEvidence` verbatim — same lines, same parentheticals, same
   order — and **two of the three had moved**. Re-verified at source and corrected in §6.1, which
   records what each cited line actually is.

**The tell in both cases is the same and is worth naming for the next reader: an inherited citation
reads as measured because it is precise.** A line number is not evidence of a measurement; it is
evidence that *someone* measured, once, at a tip that may not be yours. Conjunct 5b of §6.1 is the
control — it re-measured, found the register's `artifact-commit.ts:172-173` had moved to `:259-260`,
and is right. The two that were inherited are the two that are wrong.

---

## 2. DE-01 (Critical) — the read-denial conjunct

### 2.1 The clause, verbatim

> `"audit": "query and policy-denial events recorded in the control-plane audit log"`

### 2.2 Conjuncts

| # | Conjunct | Verdict | Why |
|---|---|---|---|
| 1a | **"query … events recorded"** | **ABSENT — and never blocked by anything.** | The tenant GUC has exactly two writers, both in `server/src/db/with-tenant-tx.ts` (`withTenantTx` `:36`, `withReadOnlyTenantTx` `:75`), and a whole-tree sweep for `set_config('aoa.organization_id'` outside tests returns those two lines and nothing else. Recording who queried what under which organization needs **no database privilege at all**. ★ **This conjunct is not in Decision 1's queue and never was** — it is unblocked instrumentation nobody has written. |
| 1b | **"policy-denial events recorded" — WRITE side** | **ABSENT, closable.** | An RLS `WITH CHECK` violation raises catchable SQLSTATE `42501`; `with-tenant-tx.ts` is the single interception point. `E0-F013` already classes this "genuinely closable". |
| 1c | **"policy-denial events recorded" — READ side** | ★ **ABSENT, and NOT BLOCKED FOR THE STATED REASON.** | See below. |

### 2.3 The measured refutation of 1c's stated blocker

`E0-F013` Group D and `E0-F010` both say the read half needs "a `BYPASSRLS`/owner connection,
exactly the privilege `packages/db/src/client.ts:325` throws at boot to forbid."

**That is measured FALSE**, in-tree, against real PostgreSQL, and in CI —
`docs/replatform/MEASUREMENT-de-01-read-half-does-not-need-bypassrls.md` with harness
`server/src/__tests__/de01-read-half-alternatives.integration.test.ts` (10 arms, green on the
`verify (1)` shard of PR #400's run `34381776576`). Two shipped shapes deliver a cross-tenant read
with the serving pool at `rolbypassrls=false` and `client.ts:325` still passing:

- **ALT-B** — a role-targeted `CREATE POLICY … TO "aoa_operator"` on a FORCE-RLS table. **No
  precondition, no privileged role anywhere.** Already in production on
  `distributed_cutover_markers` (`0233_distributed_cutover_marker_rls.sql:49-51`) and thirteen
  sibling `aoa_operator` policies.
- **ALT-A** — an owner-owned `SECURITY DEFINER` function on the `0268` model. **Carries a
  precondition** (the function's owner must itself be `SUPERUSER`/`BYPASSRLS`; `ALT-A(iii)` is the
  control that shows the identical function returning **zero rows** without it, *silently*).

The finding's own text already carries this correction inline, so **`E0-F013` has caught up on the
page — but its Group D verdict and its arithmetic have not.** That is the drift this paper closes.

**What the correction does NOT do.** It does not make the clause advisable. The clause asks for
**service-path** recording — denial events as they happen on the live tenant query path — and the
only mechanism that produces a read-denial *event* is re-running each query without the policy and
diffing. That is a comparator on **the hot path of every tenant read across 24+ relations, holding
authority the serving pool deliberately does not have.** The measurement doc declines to promote it
and this paper agrees: **possible is not advisable.**

### 2.4 Options

**(a) AMEND.** Exact replacement text (the original words are kept; the amendment is appended, in
the house style of `DE-15.audit` and `DE-20.revocation`):

> `"audit": "query and policy-denial events recorded in the control-plane audit log. ★ AMENDED <date> by founder ruling (E0-F013 Decision 1). The clause is SPLIT along its own conjunction and one conjunct is NARROWED. (1) 'query events': unchanged and unblocked -- the tenant GUC has exactly two writers (server/src/db/with-tenant-tx.ts:36 and :75) and recording them needs no database privilege. (2) 'policy-denial events', WRITE side: unchanged -- an RLS WITH CHECK violation raises catchable SQLSTATE 42501 at the same chokepoint. (3) 'policy-denial events', READ side: NARROWED to 'no read-denial event is recorded, because PostgreSQL emits none'. An RLS USING clause filters rows inside a query that SUCCEEDS; zero rows is a legal, indistinguishable result. ★ THIS IS A DELIBERATE DECLINE, NOT A LIMIT: docs/replatform/MEASUREMENT-de-01-read-half-does-not-need-bypassrls.md measured that a cross-tenant comparator needs NO BYPASSRLS and that packages/db/src/client.ts:325 is not the obstacle (ALT-B, a role-targeted policy, needs no privileged role at all). The programme declines the mechanism because it is a comparator on the hot path of every tenant read holding authority the serving pool is built not to have -- a materially worse control surface than what it would detect. WHAT IS LOST: a successful cross-tenant READ that RLS silently filtered leaves no trace, so probing for another tenant's rows is invisible to the audit log; only writes and the query itself are visible. WHAT COMPENSATES: RLS still DENIES the read (the confidentiality clause is separately measured holding), and the two boot certificates at server/src/db/distributed-execution-databases.ts:1754-1770 pin the serving role's authority and the exact SECURITY DEFINER function set, so a privilege that WOULD enable such a read cannot be added without failing startup."`

- **What is lost, and who is harmed.** An operator investigating a suspected cross-tenant probe
  cannot tell a *filtered* read from a legitimately empty one. The party harmed is **a tenant whose
  rows were probed for and not returned**: the probe leaves no evidence in anyone's log, so it
  cannot be counted, rate-limited on evidence, or produced in an incident review. This is a
  **detection** loss, not a containment loss — the read is still refused.
- **How a reader knows the scope changed.** The original clause text is retained verbatim ahead of
  the amendment, exactly as `DE-15.audit` and `DE-20.revocation` do today; the amendment names the
  ruling and the measurement that says the decline is a choice.

**(b) CHARTER.** A serving-path read comparator. Tickets: none exist; it would need a new `TEN-*`
ticket plus an ALT-B migration (C14 class (b), Decision #122, delta-free `--custom`) and a
certificate update at `assertExactCatalogCertificate`. Depends on nothing — it could start today.
**Does the programme intend to build it? No**, and it should say so rather than leave it implied:
the mechanism is a per-read cross-tenant query on every serving path, which is a larger attack
surface than the thing it detects.

**(c) THIRD PATH — split the conjunct and charter only the offline half.** Amend conjunct 3 as in
(a), and separately charter a **narrow offline verifier** — one org-bound, column-projected `0268`-
shape function answering a specific invariant on a schedule, not on the serving path. That is what
`0268` already is; it is within the measured alternatives; and it recovers *some* detection without
the hot-path surface.

### 2.5 ★ RECOMMENDATION — **(c)**

Amend conjunct 3 to the decline, and charter the offline verifier as a separate, later ticket that
does **not** gate this class. Rationale: (a) alone loses all read-side detection; (b) buys detection
at a price the measurement itself argues against; (c) is the only option that keeps the register
honest *and* leaves a chartered route to partial detection.

**★ THE STRONGEST ARGUMENT AGAINST (c).** *A chartered-but-unscheduled verifier is this programme's
own worst failure class.* A clause that says "declined on the serving path, offline verifier
chartered" reads as covered while the verifier has zero files — which is what `DE-12`'s `SVC-003`
and `SVC-005` do today (**zero files on disk**, re-measured in §4.3), and what `SVC-002` does in the
more instructive way: it has **954 lines of design and terrain and no implementation**, and its
design hands the very mechanisms `DE-12` names to the two tickets that have nothing. **A chartered
ticket is not a funded one, and a designed ticket is not a built one.** If the founder is not
prepared to fund the verifier in a named wave, **take (a) plain and write the loss down** — a
stated, unmitigated gap is worth more than a mitigation that never lands.

---

## 3. DE-27 (High) — the cross-replica and partition conjuncts

### 3.1 The clause, verbatim

> `"audit": "cross-replica admission and partition events are audited"`

### 3.2 Conjuncts

| # | Conjunct | Verdict | Why |
|---|---|---|---|
| 2a | **"cross-replica admission … events are audited"** | ★ **AMBIGUOUS — one reading is deliverable, the other is not.** | See §3.3. |
| 2b | **"… partition events are audited"** | **UNDELIVERABLE — vacuous.** | Re-measured at tip, whole-tree over `server/` and `packages/`: `replicaId\|replica_id\|AOA_CONTROL_PLANE_REPLICA\|controlPlaneId` returns **ZERO hits**. There is no partition **detector**, so there is no partition **event** to record. Nothing to instrument. |

### 3.3 ★ The ambiguity, which the finding reads as a machine problem and is really a wording problem

The admission decisions themselves **exist, fire, and are already serialized across replicas**:

- `server/src/services/worker-admission-rate-limit.ts:138-140` returns `over_cap`, taken as a 429 at
  `server/src/routes/worker-control.ts:412-416`.
- `server/src/services/org-concurrency.ts:222-224` takes `pg_advisory_xact_lock` over the
  organization id — *that lock is what makes admission cross-replica-serialized* — and denies at
  `:247-249`.

So the register has **two readings** of the word "cross-replica", and they have opposite verdicts:

- **STRONG reading** — *the record must name WHICH replica decided.* Undeliverable: no replica
  identity exists to name.
- **WEAK reading** — *admission is cross-replica-serialized, and the admission decisions are
  audited.* **Deliverable**, and it is already ordinary work: the `over_cap` deny is Group C
  (`sendWorkerOperationProtocolError` carries no db handle or tenant — `worker-protocol-http.ts:83-93`)
  and the capacity deny is Group B (a `throw` inside the tenant transaction, so an in-transaction
  write rolls back with it).

`E0-F013` reads it strong and calls the whole clause "unsatisfiable as written". That is defensible,
but it is **a reading, not a measurement**, and the register does not disambiguate. Under the weak
reading, `DE-27`'s admission conjunct is **not** a Decision 1 item at all — it is already inside
Groups B and C.

### 3.4 Options

**(a) AMEND.** Exact replacement text:

> `"audit": "cross-replica admission and partition events are audited. ★ AMENDED <date> by founder ruling (E0-F013 Decision 1). The clause is SPLIT. (1) 'cross-replica admission events': the WEAK reading is adopted and is what this clause now asserts -- that each admission REFUSAL is durably recorded (server/src/services/worker-admission-rate-limit.ts:138-140 over_cap, and server/src/services/org-concurrency.ts:247-249 capacity), and that admission is serialized across replicas by pg_advisory_xact_lock at org-concurrency.ts:222-224 and FOR UPDATE ... SKIP LOCKED at packages/db/src/repositories/tenant/job-control.ts:1983. It does NOT assert that a record names WHICH replica decided: the system has no replica identity (a whole-tree sweep for replicaId|replica_id|AOA_CONTROL_PLANE_REPLICA|controlPlaneId returns zero hits) and this clause no longer implies one. STILL ABSENT: neither refusal writes a row today; this is Group B (in-transaction throw) and Group C (sendWorkerOperationProtocolError carries no db handle or tenant) work, NOT a delivered control. (2) 'partition events': DROPPED as vacuous. There is no partition detector, so no partition event exists to audit. ★ WHAT IS LOST: a forensic reader cannot attribute an admission decision to a replica, and cannot learn from this log that a replica was ever partitioned. Double-admission is prevented by the database (job_attempts_placement_atomic_check and the conditional offerLease UPDATE), not detected by this record."`

- **What is lost, and who is harmed.** Two distinct losses. (i) *Attribution:* an operator debugging
  a double-admission incident cannot tell whether one replica or two produced a decision. (ii)
  *Partition visibility:* nobody is told a replica went partitioned — the system will simply behave
  correctly-by-construction (admission authority is re-derived per request from the shared database,
  never held) and say nothing. The harmed party is **the operator during an incident**, not a
  tenant; there is no tenant-visible exposure, because the integrity property is a database
  invariant.
- **★ THE HONEST RISK IN THIS AMENDMENT.** It narrows a **High** control to something the current
  single-writer architecture satisfies. If the programme ever *does* run multiple control-plane
  replicas with divergent local state, this amended clause will not notice. It must therefore be
  read together with `DE-27`'s `revocation` clause, which the register already records as
  **NOT-DELIVERED-AS-NAMED** ("there is no leader lease, fencing token or membership authority a
  replica could lose") — the two together, not this one alone, are what say the multi-replica story
  is by-construction rather than by-control.

**(b) CHARTER.** A replica identity (config-injected id, a heartbeat/membership table, a partition
detector) plus the Group B/C recorders. Tickets: `FND-005` exists on disk but **its entire
contribution to this crossing is a policy paragraph** — no admission code, no migration, no
two-replica test; `REL-002` has **zero files**. The ticket that actually built every enforcement
control here, `DEP-009`, is **not named by this row**. So chartering means writing `FND-005`'s
missing body, not extending it. **Does the programme intend to build it?** There is no evidence it
does: no ticket names replica identity, and the D1 merge-train two-replica campaign passes today
without one.

**(c) THIRD PATH — split, and move the admission conjunct out of Decision 1.** Amend conjunct 2b
(partition) as dropped-vacuous *now*, adopt the weak reading for 2a *now*, and let 2a's actual
delivery ride the Group B and Group C mechanism work already planned. Nothing new is chartered and
nothing is quietly narrowed to satisfiable-by-doing-nothing — because 2a stays **absent** after the
amendment.

### 3.5 ★ RECOMMENDATION — **(c)**

It is the only option that is honest about *both* conjuncts: the partition conjunct is dropped
because it names a non-existent detector, and the admission conjunct is **kept as an open
obligation** rather than either dropped or fantasised into a replica-identity project. Critically,
(c) leaves `DE-27` `partial` and in the cohort *after* the ruling.

**★ THE STRONGEST ARGUMENT AGAINST (c).** *"Cross-replica" was in the clause for a reason, and the
weak reading reads it out of existence.* The threat this row names is `Multi-replica coordination
hazard` / `two control-plane replicas double-admit the same work`. A reader of the amended clause
learns that admissions are audited and could reasonably conclude the multi-replica hazard is
observable. It is not. If the founder finds that too close to a false claim of enforcement, the
correct move is (b) — or at minimum, require the amendment to name the residual hazard in the same
sentence, which the text in §3.4 does.

---

## 4. DE-12 (Critical) — the generation-change conjunct, and the two the finding did not count

> ★★★ **FACT CORRECTION, 2026-09-11 — this section was written at branch point `743c30f08`
> and one of its three conjuncts has moved. THE DECISION REMAINS UNRULED; this is a
> measurement update, not a ruling, and it changes no option and no signature below.**
>
> At the branch point, `services.generation` had **no writer**, so this section judged all
> three conjuncts vacuous. That is now stale for **conjunct 3c**:
>
> - **A writer EXISTS.** `bumpServiceGeneration` (`packages/db/src/repositories/tenant/job-control.ts`)
>   is a compare-and-set on `services.generation`, reached from `rollServiceGenerationWithinTenant`
>   (`server/src/services/service-generation-rollout.ts`) via
>   `POST /organizations/:organizationId/companies/:companyId/services/:serviceId/generation`. So a
>   generation **can** change, and `update(services)` for generation is no longer zero-hit.
> - **3c is DELIVERED.** An actual roll now writes a durable `service.generation_roll` `activity_log`
>   row inside the roll's own tenant transaction (`recordServiceGenerationRollActivity`,
>   `server/src/services/service-control-audit.ts`; the SERVICE-layer path SVC-007b uses for create
>   and desired-state), exercised RED-first by `service-generation-rollout.integration.test.ts` R-T11.
>   So **"generation changes are audited" is no longer vacuous — it is met.**
> - **3a (partition) and 3b (drain) are UNCHANGED and still vacuous** — no replica identity / no
>   partition detector; no service-drain producer (E9-F008). **They are the DE-12 amend targets now,
>   not all three.** DE-12 stays `partial`.
>
> ★ **This correction edits the ANALYSIS below (§4.2's 3c row, §4.4's recommendation) and the §0/§7
> summary cells only.** The Options in §4.3 and the Decision block in §8 still literally read
> "all three conjuncts" — that is the proposed amendment TEXT a founder would enact, and re-drafting
> it (to drop only 3a + 3b, and to note 3c delivered) belongs to whoever RULES this decision, not to
> this fact-correction. See the DE-12 `deliveryEvidence` in the register for the delivered-3c note.

### 4.1 The clause, verbatim

> `"audit": "partition, drain, and generation changes are audited"`

### 4.2 ★ Conjuncts — the clause is a THREE-way conjunction and E0-F013 queues ONE of the three

| # | Conjunct | Verdict | Why, measured at tip |
|---|---|---|---|
| 3a | **"partition … audited"** | **UNDELIVERABLE — vacuous.** ★ Not queued by `E0-F013`. | Same measurement as `DE-27` 2b: no replica identity, no partition detector, whole-tree zero hits. |
| 3b | **"drain … audited"** | **UNDELIVERABLE — vacuous.** ★ Not queued by `E0-F013`. | There is no service drain. The register's own evidence says it: *"There is no reconciler file, no instance fence, no drain."* |
| 3c | **"generation changes are audited"** | ★ **DELIVERED at HEAD (2026-09-11).** ~~UNDELIVERABLE — vacuous.~~ The one queued. | **At branch point `743c30f08`:** `services.generation` had **no writer** — `update(services)` returned zero hits whole-tree, so no generation ever changed and no change event existed. **At HEAD:** `bumpServiceGeneration` (`packages/db/src/repositories/tenant/job-control.ts`) writes the column, reached from `rollServiceGenerationWithinTenant` (`server/src/services/service-generation-rollout.ts`) via `POST .../services/:serviceId/generation`, and an actual roll writes a durable `service.generation_roll` `activity_log` row (`recordServiceGenerationRollActivity`, `server/src/services/service-control-audit.ts`). **A generation can change, and the change is audited.** |

**★ This is the conjunct-level correction this paper owes.** `E0-F013` files "DE-12's change half"
as one of five. At the branch point, measured, it was **three of three** — the whole audit clause
was vacuous, and calling it a "half" understated it by two conjuncts. ★ **Corrected 2026-09-11:**
conjunct **3c is now DELIVERED** (see the banner at the head of §4), so the remaining vacuous
conjuncts are **two, not three** — 3a (partition) and 3b (drain). An amendment must now drop those
two and record 3c as met, leaving DE-12 `partial`; it must **not** drop all three, which was the
branch-point recommendation.

### 4.3 Options

> ★★★ SUPERSEDED IN PART BY THE 2026-09-11 RULING. The Option (a) replacement text below still reads "ALL THREE CONJUNCTS ARE DROPPED AS VACUOUS" with the measurement "services.generation has no writer … so no generation ever changes." That is STALE-FALSE at HEAD: conjunct 3c is DELIVERED (bumpServiceGeneration + recordServiceGenerationRollActivity, R-T11). The ENACTED register amendment drops only 3a+3b and RECORDS 3c delivered. Do not enact the text below verbatim; it is kept for provenance.

**(a) AMEND.** Exact replacement text:

> `"audit": "partition, drain, and generation changes are audited. ★ AMENDED <date> by founder ruling (E0-F013 Decision 1). ALL THREE CONJUNCTS ARE DROPPED AS VACUOUS, and the clause now asserts NOTHING pending the controls it depends on. Measured whole-tree at tip: (1) 'partition' -- no replica identity and no partition detector exist (replicaId|replica_id|AOA_CONTROL_PLANE_REPLICA|controlPlaneId returns zero hits), so no partition event exists; (2) 'drain' -- there is no service reconciler, no instance fence and no drain, so no drain event exists; (3) 'generation changes' -- services.generation has NO WRITER anywhere in the tree (update(services) returns zero hits; the column is notNull().default(1) at packages/db/src/schema/services.ts:26 and is read only as a WHERE predicate at packages/db/src/repositories/tenant/job-control.ts:1675), so no generation ever changes. ★ THIS IS AN AUDIT CLAUSE WITH NOTHING TO AUDIT, NOT AN AUDIT GAP: the three components this row's control names -- 'desired-state reconciler, generation, active fence' -- are themselves unbuilt (E0-F011). This clause becomes deliverable only when SVC-002/SVC-003/SVC-005 build them, and NONE OF THE THREE IS BUILT: SVC-003 and SVC-005 have ZERO FILES ON DISK, and SVC-002 has design + terrain only (SVC-002-design.md, 604 lines, Status 'designed, NOT implemented' with three open questions unsettled; SVC-002-terrain.md, 350 lines; no result file). ★ AND SVC-002'S DESIGN WOULD NOT CLOSE THIS CLAUSE EVEN IF IMPLEMENTED EXACTLY AS WRITTEN, BY ITS OWN SCOPE-OUTS: it hands the instance fence to SVC-003 (SVC-002-design.md:481-485, :435, :438-439) and the generation rollout, pause and drain to SVC-005 (:489-492), and its only use of generation is a FOR UPDATE interlock AGAINST a bump SVC-005 performs (:123, :187). Its own words at :490-491: 'SVC-002 reads generation under a row lock and never bumps it; services.generation still has no writer after this ticket.' Do not read the drop as coverage, and do not read SVC-002's design as the writer arriving."`

- **What is lost, and who is harmed.** **Nothing that exists today.** A vacuous conjunct protects
  nobody; dropping it removes a *false* assertion, not a real guarantee. The genuine risk is the
  opposite one: a reader skimming the amended row could take "dropped as vacuous" for "handled".
  The replacement text answers that in its own last sentence, and `DE-12` must stay `partial` with
  its `E0-F011` reference intact.

**(b) CHARTER.** Build the desired-state reconciler, the instance fence and the drain — i.e. build
`SVC-002`, `SVC-003` and `SVC-005`.

**★★★ THE CENSUS, RE-RUN — because the first draft inherited it and it was stale.** The first draft
said these three had *"zero files between them"* and that `DE-12` was *"the only crossing in the
register with no on-disk owner ticket at all"*. **That is DE-12's own `deliveryEvidence`,
reproduced.** It was true at `360d0b0ed`; it is **false at this paper's branch point.** Re-measured
here with `git ls-tree -r --name-only 743c30f08 | grep -i 'svc-'` — the whole tree, not the ticket
directory alone:

| Ticket | Files at `743c30f08` | Lines |
|---|---|---|
| `SVC-001` | `SVC-001-design.md`, `SVC-001-result.md`, `SVC-001-terrain.md` | 292 / 227 / 241 |
| ★ **`SVC-002`** | ★ **`SVC-002-design.md`, `SVC-002-terrain.md`** | ★ **604 / 350** |
| `SVC-003` | **none** | — |
| `SVC-004` | **none** | — |
| `SVC-005` | **none** | — |
| `SVC-006`, `SVC-007` | **none** | — |
| `SVC-008` / `-008a` / `-008b` | `SVC-008-design.md`, `SVC-008a-design.md`, `SVC-008b-result.md` (+5 test files under `packages/`) | 785 / 951 / 248 |

So: **`SVC-003` and `SVC-005` have zero files — `SVC-002` has 954 lines of design and terrain**, it
landed in `08746b160` (PR #388) nine hours after the register measured it absent, and it is
`Status: designed, NOT implemented` with **three open questions (§10) stated and unsettled** and no
result file. `REL-002` and the D4 lane are **still** unwritten (re-verified: no `REL-002` file exists
anywhere in the tree). `SVC-001-terrain.md:216-218` does say `DE-12` is *"owned by SVC-002/003/005 —
SVC-001 owns no control there"*, which is a fair scope-out — but **"the only authored `SVC` ticket"
is now false**, and it was the phrase doing the work.

**★ Does the programme intend to build it? THE ANSWER CHANGES, AND IT SPLITS THREE WAYS — and the
new evidence is STRONGER for this option's rejection than the empty census was.**

- **The reconciler (the subject of conjunct 3b's "drain" and the row's `control`): YES, intended —
  designed, not built.** A 604-line design exists and it is serious. `SVC-002-design.md:123` and
  `:187` design a `SELECT … FOR UPDATE` interlock precisely so *"a concurrent SVC-005 generation
  bump cannot land between the read and the insert"* — i.e. it plans around **exactly** the
  mechanism this clause names. **This is evidence the other way and it is recorded as such.**
- **The generation writer (conjunct 3c): NO — and now on the record, in the design's own words.**
  `SVC-002-design.md:489-491` scopes generation rollout, pause and drain **out**, to `SVC-005`:
  *"SVC-002 reads `generation` under a row lock and never bumps it; **`services.generation` still
  has no writer after this ticket.**"* The one authored owner ticket states that **shipping it in
  full leaves conjunct 3c exactly as vacuous as it is today**, and hands the writer to a ticket with
  zero files.
- **The instance fence (the row's third named component) and the partition detector (conjunct 3a):
  NO evidence of intent.** The fence is scoped out to `SVC-003` (`:481-485`, `:435`, `:438-439`),
  which has zero files; no `SVC` ticket mentions a partition detector at all.

**On the evidence: partly yes, and not for the parts this clause needs.** That is a weaker "no" than
the first draft's, and a better-evidenced one.

**(c) THIRD PATH — none worth naming.** There is no conjunct here to split off and close; splitting
requires at least one deliverable side, and all three are vacuous.

### 4.4 ★ RECOMMENDATION — **(a), covering the two conjuncts still vacuous (3a + 3b)**

> ★ **CORRECTED 2026-09-11.** As written at branch point this recommendation was "**(a), covering
> all three conjuncts, not one**" — drop all three. Conjunct **3c is now DELIVERED** (§4 banner),
> so the recommendation is now: amend **(a)** to drop only **3a (partition)** and **3b (drain)** as
> vacuous, **record 3c as met**, keep the row `partial`, keep `E0-F011` as its owner. The reasoning
> below still holds for 3a and 3b; where it says "all three", read "3a and 3b". The decision
> **remains UNRULED** and the §4.3 option text / §8 signature block are unchanged — re-drafting the
> proposed amendment to this scope is the ruling founder's, not this correction's.

`DE-12` remains a clear case for **(a)** on its two still-vacuous conjuncts. Drop 3a and 3b, record
3c as delivered, keep the row `partial`, keep `E0-F011` as its owner for the unbuilt control the
remaining two conjuncts depend on, and make the amendment say in terms that partition detection and
service drain are unbuilt so those two audit conjuncts have no subject.

**★★★ DOES THIS RECOMMENDATION SURVIVE THE CORRECTED CENSUS? YES — AND HERE IS WHY IT SURVIVES
WITHOUT IT.** The correction is stated first and the conclusion is re-derived from scratch, because
patching a number and leaving the conclusion it supported standing is the move this paper exists to
refuse.

**The recommendation never rested on the census, and it must not be read as having done so.** (a)
rests on **vacuity**, and vacuity is a measurement of the **source tree**, not of the ticket
directory. Re-run independently at `743c30f08`, each on its own:

- `update(services)` → **zero hits** whole-tree, tests included. `insert(services)` → exactly two
  (`packages/db/src/repositories/tenant/index.ts`, one adversarial test). So **no generation ever
  changes.** ★ **STALE AT HEAD (2026-09-11):** `bumpServiceGeneration` now writes `services.generation`
  from `rollServiceGenerationWithinTenant`, so a generation **does** change and conjunct 3c is
  delivered — this bullet is the branch-point measurement, kept for provenance, not the current one.
- No service-reconciler source file exists under `server/` or `packages/`
  (`packages/adapter-manager/src/reconcile-reaper.ts` is the orphan-**sandbox** reaper, a different
  mechanism on a different boundary). *(3b: drain still has no producer — unchanged at HEAD.)*
- `replicaId|replica_id|AOA_CONTROL_PLANE_REPLICA|controlPlaneId` → **zero hits.** *(3a: partition
  still has no detector — unchanged at HEAD.)*

**A design document is not a writer** — but a shipped roll path **is one**. 954 lines of `SVC-002`
changed none of those numbers, and at branch point all three conjuncts asserted events that could
not occur. ★ **Corrected 2026-09-11:** the generation writer arrived after this section was written
(not from `SVC-002`, which still scopes it out, but from the roll path in
`service-generation-rollout.ts`), so **3c's event now occurs and is audited**; only **3a and 3b**
still assert events that cannot occur. The amendment (a) justifies is therefore scoped to those two.

**What the census DID support was the rejection of option (b)** — *"does the programme intend to
build it?"* — and **on the corrected evidence (b) is rejected more firmly, not less.** The first
draft rejected (b) because nobody had started. The measured reason is better: **the one owner ticket
that HAS started scopes the generation writer OUT in writing** — *"`services.generation` still has no
writer after this ticket"* (`SVC-002-design.md:490-491`) — and hands it, with the fence and the
drain, to `SVC-003` and `SVC-005`, which have zero files. Chartering (b) to save this clause would
therefore mean chartering the two tickets nobody has begun, **not** funding the one that exists.

**What DOES change is the amendment's tense, and it is changed in §4.3's text.** With a live design
on disk, the drop must not read as permanent: the replacement text now says the three components are
unbuilt **and** that `SVC-002`'s design would not close the clause even if shipped as written. That
is a sharper claim than "zero files", and it is the one a future reader needs.

**★ THE STRONGEST ARGUMENT AGAINST (a).** *A Critical crossing whose entire audit clause is dropped
is a Critical crossing that now asserts less than a Low one — and the honest response to "the
control is unbuilt" is to build it, not to edit the register down to match.* If `DE-12`'s
`failureMode` (`two service instances act as active simultaneously`) is genuinely Critical, the
register's job is to keep saying so loudly until someone funds `SVC-002`. Against that: the row's
`deliveryStatus` and `deliveryEvidence` already say all of this at length, and it is the *clause*
field that the register's own note defines as "a charter, not a report" — so the amendment moves
the charter to match the intent while `deliveryEvidence` keeps the alarm. **This argument is strong
enough that the founder should consider a variant of (a) that drops the conjuncts but ALSO
re-raises `E0-F011`'s visibility** — the loss here is not in the register, it is in `SVC-003` and
`SVC-005` having zero files while the one designed owner ticket, `SVC-002`, explicitly leaves
`services.generation` writerless. ★ **The corrected census strengthens this objection rather than
weakening it:** there is now a live, serious design to attach an escalation to, so "raise
`E0-F011`'s visibility" is no longer a gesture at an empty directory — it is a request to fund
`SVC-003`/`SVC-005` behind a reconciler someone has already thought through.

---

## 5. DE-20 (Critical) — the rollback conjunct, and the conjunct that should not be in this decision

### 5.1 The clause, verbatim

> `"audit": "cutover selection and rollback transitions are audited"`

### 5.2 Conjuncts

| # | Conjunct | Verdict | Why, measured at tip |
|---|---|---|---|
| 4a | **"cutover selection … audited"** | ★ **DELIVERED at HEAD (2026-09-11).** ~~HALF DELIVERED, missing half CLOSABLE TODAY.~~ Not a Decision 1 item. | **At branch point:** a **distributed** selection wrote one `distributed_execution_handoff` heartbeat-run event; a **legacy** selection wrote **nothing** (the non-suppressed path fell straight to `adapter.execute`), so the missing half was a wiring job in `heartbeat.ts`. **At HEAD that wiring is done:** `buildCutoverSelectionEvent` (`server/src/services/cutover-selection-audit.ts`), appended at the single site after `canaryExecutionOwner` is assigned in `heartbeat.ts` (`appendRunEvent(run, seq++, buildCutoverSelectionEvent(canaryExecutionOwner))`), writes a `distributed_execution_selection` heartbeat-run-event row for **BOTH** the distributed and legacy arms. The legacy-selection blindness this cell named is closed. |
| 4b | **"… rollback transitions are audited"** | **UNDELIVERABLE — vacuous.** | Re-measured whole-tree at tip: `createDistributedExecutionDrain` has **zero production callers** — the census returns its declaration (`server/src/services/job-distributed-drain.ts:114`), two test files, and nothing else. Removing an organization from the rollout dial cancels nothing in flight; it only changes what the **next** wake resolves. **There is no rollback transition, so there is no transition event.** |

**★ Conjunct 4a does not belong in Decision 1.** `E0-F013` files "DE-20's rollback half" — correctly
— but a founder ruling that treats `DE-20` as a Decision 1 row risks the selection conjunct being
amended away alongside it. It should be explicitly excluded from the ruling and left as ordinary
work.

**Note on the precedent already set.** `DE-20`'s `revocation` clause was **already amended by
founder ruling on 2026-09-09**, dropping the word "atomically" and narrowing "the rollback lever
cannot be pulled" to "the ORG-WIDE SWEEP has no production caller" (per-job cancellation ships and
is routed: `server/src/routes/job-control.ts:218` → `job-operations.ts:291` → `requestCancellation({graceful:true})`).
**The audit clause was not amended with it.** So the row currently holds an amended `revocation`
clause that concedes there is no org-wide rollback, beside an unamended `audit` clause that asserts
rollback transitions are audited. **The two clauses in the same row contradict each other today.**
That is an argument for ruling on 4b now rather than deferring it.

### 5.3 Options

**(a) AMEND 4b only.** Exact replacement text:

> `"audit": "cutover selection and rollback transitions are audited. ★ AMENDED <date> by founder ruling (E0-F013 Decision 1), consistent with the 2026-09-09 amendment to this row's revocation clause. (1) 'cutover selection': DELIVERED FOR BOTH ARMS (W20-B). buildCutoverSelectionEvent (server/src/services/cutover-selection-audit.ts) is appended once at server/src/services/heartbeat.ts:5388 before shouldSuppressLegacyExecution and is TOTAL over RunExecutionOwner, so it writes a distributed_execution_selection heartbeat_run_event for the DISTRIBUTED arm AND the LEGACY arm. NOT covered by this amendment, which scopes 4b only. (2) 'rollback transitions': DROPPED AS VACUOUS. createDistributedExecutionDrain (server/src/services/job-distributed-drain.ts:114) has ZERO PRODUCTION CALLERS, so no org-wide rollback transition occurs and none can be recorded. This matches the revocation clause's own amendment. ★ WHAT IS LOST: nothing that exists -- there is no rollback to fail to record. WHAT REMAINS TRUE AND MUST NOT BE READ AWAY: an operator removing an organization from the rollout dial gets NO record because NOTHING HAPPENS, not because the recording is missing; in-flight distributed runs continue and must be stopped one at a time via POST /organizations/:organizationId/companies/:companyId/jobs/:jobId/drain. The absent control is owned by E0-F014."`

- **What is lost, and who is harmed.** Nothing real is lost by 4b. The danger is misreading: an
  operator could take the dropped conjunct as "rollback is fine, just unlogged". The replacement
  text says the opposite explicitly and points at `E0-F014`.

**(b) CHARTER.** Wire the org-wide drain sweep to the rollout dial, then audit its transitions.
Tickets: `MIG-002`, `MIG-008` and `REL-003` all have files on disk, **but none closes this** —
`MIG-002-dial-result` records convergence as "unchanged and still absent", `MIG-008-result` defers
the live cutover, and `REL-003-result` names the live rehearsal as an owed operator leg. The ticket
that would own the missing rollback trigger, **`REL-005`, has zero files AND is not among this row's
`ownerTickets`**, so the obligation has no chartered exit at all. **Does the programme intend to
build it?** `E0-F014` is open and owns the dead drain; there is a real argument that the *control*
(not the audit) should be built. But that is `E0-F014`'s decision, not this one.

**(c) THIRD PATH — move 4b behind `E0-F014`, as `DE-21`'s board half went to Decision 3.** Do not
amend the audit clause at all; instead record that 4b is **blocked on `E0-F014`** and will be ruled
when `E0-F014` rules on whether the drain gets a caller. Cost: the row keeps a contradiction between
its amended `revocation` clause and its unamended `audit` clause for however long that takes.

### 5.4 ★ RECOMMENDATION — **(a), scoped to 4b only, with 4a named as excluded**

> ★ **FACT CORRECTION 2026-09-11 (decision UNRULED).** This recommendation's scope — **4b only,
> 4a excluded** — is unchanged and reinforced. At branch point 4a was "half delivered, missing half
> closable today"; **at HEAD the missing half is closed** (`cutover-selection-audit.ts`
> `buildCutoverSelectionEvent`, wired in `heartbeat.ts` for both arms — see §5.2). So 4a is now not
> merely *excluded from* this decision but *delivered*, which removes any temptation to sweep it
> into a 4b amendment. The proposed amendment text in §5.3 and the §8 signature block are unchanged;
> re-drafting them to note 4a delivered is the ruling founder's.

The 2026-09-09 `revocation` amendment already made this call for the control; leaving the audit
clause asserting the opposite in the same row is the kind of internal contradiction a register
cannot carry. Amending 4b costs nothing real and removes the contradiction today.

**★ THE STRONGEST ARGUMENT AGAINST (a).** *This is amendment-by-attrition.* `DE-20`'s `revocation`
clause was narrowed in September; now its `audit` clause is narrowed to match the narrowed
revocation; the next reader sees a `Critical` cutover row that asserts almost nothing and has never
once been exercised in a deployment (the register's own note: *"this crossing's enforcement has
never once been exercised in a deployment — the rollout source has zero deployment hits, so the
suppression return at heartbeat.ts:5451 is proven only in CI"*). Each step is locally justified and
the sequence is a Critical control dissolving. **(c) is the answer to that objection**: it keeps the
contradiction visible until someone rules on the control itself. The founder should choose (a) only
if willing to accept that `DE-20` is now, in substance, a *documented* single-owner invariant rather
than a *reversible* cutover.

---

## 6. DE-11 (High) and DE-17 (Critical) — the two whose blockers do not hold

### 6.1 DE-11 — ★ the premise is stale

**Clause, verbatim:**

> `"audit": "sensitive-artifact access and retention are audited"`

**`E0-F013`'s stated reason for blocking:** *"the sensitive-artifact access and retention controls
are themselves absent (`E8-F011`). Nothing decides, so there is nothing to record."*

**Measured at tip, that is not true of either conjunct.**

| # | Conjunct | Verdict | The decision that exists |
|---|---|---|---|
| 5a | **"sensitive-artifact access … audited"** | **ABSENT, but DECISIONS EXIST and some already record.** | Access is gated and **denies** in `server/src/services/artifact-transfer-grant.ts` — upload key must be under this org's attempt prefix (`:180-184`, `deny("foreign_object_prefix")`); download requires a committed row for this tenant (`:295` `findCommitted` → `:300` `deny("artifact_not_committed")`, with the key compare at `:302` and the download prefix guard at `:290-292`) — and at `packages/db/src/repositories/tenant/job-control.ts:2750` `wrong_prefix` / `:2751` `tenant_mismatch`. ★ **Refusals at that surface ALREADY write `security.denied.artifact_transfer_grant` rows**: `recordSecurityDenial(input.appDb, { crossing: "DE-06", surface: ARTIFACT_TRANSFER_GRANT_DENIAL_SURFACE, … })` at `artifact-transfer-grant.ts:354-357`, the slug declared at `server/src/services/artifact-denial-audit.ts:67`, wired by DE-06's Unit C. What is missing is the **successful** access record — which is precisely `DE-06`'s open "object put/get" conjunct, i.e. **already-scheduled work, not a decision.** |
| 5b | **"… retention are audited"** | ★★ **ABSENT, AND DELIVERABLE TODAY, CHEAPLY.** | `resolveStoredRetention` (`server/src/services/artifact-retention-authority.ts:49`) is a **live control-plane retention decision**, called at `server/src/services/artifact-commit.ts:253`, that overrides a worker's declared class. It returns `declarationIgnored: boolean`, and `artifact-commit.ts:257` branches on it. **The code's own comment at `:259-260` says: "This is a LOG LINE, not an audit record — DE-11 claims retention is audited and nothing audits it; this ticket does not pretend to close that."** That is a **deferral**, not an impossibility. |

★ **BOTH CONJUNCTS NOW HAVE A LIVE WRITER (2026-09-10), AND DE-11 STILL DOES NOT CLOSE — so this
section's recommendation is UNCHANGED and is merely no longer waiting on other people's work.**
**5b** was wired by W20-B (`recordRetentionDecision`, `server/src/services/artifact-retention-audit.ts`);
the "LOG LINE, not an audit record" comment this row quotes is gone. **5a** was wired by the
object-access unit, exactly as this row predicted — it *was* `DE-06`'s put/get conjunct, and it was
scheduled work rather than a decision. A successful download grant now writes a
`security.object_access.artifact_download_grant` row carrying `details.kind` and
`details.sensitivity`, **read from the committed `job_artifacts` row**, so the record says WHICH
KIND became reachable rather than only that a transfer happened. ★ **WHAT STILL HOLDS DE-11 OPEN IS
A GROUND THIS PAPER DID NOT MEASURE:** nothing in production uploads `browser_cookie_state` or
`browser_storage_state` (BRW-003 unbuilt), so neither record has ever been about a
credential-bearing kind — both proving suites provoke one BY HAND and pin it as test-provoked.
That is a **coverage** gap, not a decision, and it does not restore DE-11 to the six: this paper's
verdict that DE-11's stated blocker is stale stands, and is now demonstrated rather than argued.
Two further measurements, stated so a later reader does not re-derive them: on the **upload** arm
`kind`/`sensitivity` are `null`, because the artifact does not exist yet and the frozen grant
request carries neither field (both are first declared in the COMMIT manifest) — a true answer, not
a missing one; and `sensitivity` is **not a discriminator at all in v1**
(`artifactSensitivitySchema` is `z.literal("restricted")` and `RESTRICTED_ARTIFACT_KINDS ===
ARTIFACT_KINDS`), so `kind` is the only field separating a credential-bearing artifact from a log.

### ★★★ CITATION NOTE — 5a's file:lines were INHERITED, and two of them were stale

**The method promise in §1 was broken here.** 5a's citation list read, in the first draft,
*"`artifact-transfer-grant.ts:113` (upload key must be under this org's attempt prefix) and
`:201-202` (download requires a committed row for this tenant), and at `job-control.ts:2750`
`wrong_prefix` / `:2751` `tenant_mismatch`"* — **which is `DE-11`'s `deliveryEvidence`, verbatim:
same lines, same parentheticals, same order.** Re-verified at source at `743c30f08`:

| Cited | What that line actually is at `743c30f08` | Verdict |
|---|---|---|
| `artifact-transfer-grant.ts:113` | `outcome: "rejected",` — a field inside the **generic `rejected()` helper closure** (`:105-117`) that all six refusal branches return through. Not a denial site, and not about prefixes. | ★ **STALE.** The upload-prefix denial **moved** to `:180-184`. |
| `artifact-transfer-grant.ts:201-202` | `ceilingBytes: maxArtifactBytes,` and `}),` — the tail of the **`declared_size_over_ceiling`** denial (`:196-203`), a BRW-003d-5 size refusal. | ★ **STALE.** Nothing to do with downloads. The download's committed-row check is `:295`/`:300`. |
| `job-control.ts:2750` / `:2751` | `throw new ArtifactCommitRejection("wrong_prefix")` / `("tenant_mismatch")`. | ✔ **EXACT.** |

**The substance of 5a is unaffected** — access *is* gated, it *does* deny, and refusals *do* write
`security.denied.*` rows; every one of those claims is re-verified above at corrected lines. What
was wrong was the **evidence**, and on this programme's own standing rule that is not a small thing:
**an inherited citation reads as measured because it is precise.**

★ **This is the second occurrence of one defect on this PR.** Codex caught the first — the paper
reproduced the register's `owned-op-gate.ts:154-156` under §6.2's conjunct 6b, where it does not
belong (§6.2 records it). **The same defect then went undetected a second time, here, in the section
this paper calls its most valuable.** Both are recorded at the promise they break, in §1.1.

★ **Conjunct 5b is the control that proves the diagnosis.** 5b did **not** inherit: it re-measured,
and found the register's own citation for the "LOG LINE, not an audit record" comment —
`artifact-commit.ts:172-173` — had **moved to `:259-260`**. The conjunct that re-ran its measurement
is right; the conjunct that inherited is the one that was wrong.

**★ WHY 5b IS THE MOST VALUABLE THING IN THIS PAPER.** The record point sits inside a closure that
**already has everything the write needs**: `input.appDb` (the same handle `recordSecurityDenial` is
called with at `artifact-commit.ts:374`), `ctx.companyId` (the **locked lease's** company, not the
manifest's self-asserted one — `:186-187`; `:188` is where the `deny` helper begins), the artifact
id, the kind, the declared class and the derived class. `recordSecurityDenial` is **already imported
in this file** (`:46`). This is roughly
the same shape and size as the `DE-19` closure, in a file that has already been wired twice.

**Two caveats stated rather than implied, because exoneration needs more evidence than conviction:**

1. **`declarationIgnored` is not a security denial.** The authority's own doc comment says so:
   *"a worker declaring a SHORTER class than derived is not an attack, but it is the same bug
   class."* So this record belongs in the retention-audit namespace, not necessarily under
   `security.denied.*` — a wiring unit must decide that, and the reserved-namespace guard
   (`assertUnreservedActivityNamespace`) will make it decide deliberately.
2. **Coverage caveat.** Nothing in production uploads `browser_cookie_state` / `browser_storage_state`
   today, because `BRW-003` is unbuilt. The decision point at `:253` fires for **every** artifact
   kind, so the record would be real and live — but it would not *yet* see the specific sensitive
   kinds `DE-11`'s boundary names. **That is a coverage gap, not an impossibility**, and it must be
   written down by whoever wires it.

**Options.**
**(a) AMEND** — not recommended. There is no honest narrowing available: the controls are not
absent, so an amendment would have to say something false or say nothing.
**(b) CHARTER** — one small ticket. 5b is a few lines at `artifact-commit.ts:257` plus a
provocation test; 5a is `DE-06`'s existing put/get obligation and needs no new charter. Depends on
nothing. Owner: the same wave that owns `DE-06`'s remaining half. `BRW-003`'s retention slice
`BRW-003c` is design-only today, and `REL-001` has zero files, so the ticket must be new.
**(c) THIRD PATH** — split: charter 5b now, and let 5a ride `DE-06`.

**★ RECOMMENDATION — (c), and REMOVE DE-11 FROM DECISION 1 ENTIRELY.** It is not an undeliverable
clause; it is unscheduled work with a live decision point and a ready record sink.

**★ THE STRONGEST ARGUMENT AGAINST.** *`DE-11`'s boundary is "Browser-session workload ↔ sensitive
artifacts", and the browser workload does not exist.* Wiring a retention-audit record on the generic
artifact path produces rows about `screenshot` and code artifacts and **never once** about a
`browser_cookie_state` — so the crossing could be marked as having a wired audit while the actual
sensitive path remains unbuilt and unobserved. That is a real risk and it is this programme's own
failure class. **The mitigation is not to skip the wiring; it is to forbid the `deliveryStatus`
move** — `DE-11` must stay `partial` until `BRW-003` ships and the record is provoked on a genuinely
sensitive kind. Whoever wires 5b must write that constraint into the row.

### 6.2 DE-17 — ★ the freeze is not the blocker

**Clause, verbatim:**

> `"audit": "post-fence cleanup and denied escalations are audited"`

**Conjuncts:**

| # | Conjunct | Verdict |
|---|---|---|
| 6a | **"post-fence cleanup … audited"** | **ABSENT.** No record of a cleanup action is written anywhere; `packages/adapter-manager/src/server.ts`'s only metric counts reaper sweeps, not gate outcomes. |
| 6b | **"… denied escalations are audited"** | **ABSENT.** Re-measured whole-tree at tip: every single reference to `CleanupAuthorityDeniedError` is a **throw site, a class declaration, a barrel re-export, or a conformance/test assertion**. **Nothing catches it.** |

**`E0-F013`'s stated blocker:** the two packages *"run off the control plane and hold no
control-plane DB handle, so a durable row needs a wire hop — and `packages/worker-protocol` is
v1-FROZEN behind a hash-pinned cross-version conformance test. Its own ticket, with its own freeze
decision."*

**The DB-handle half is confirmed.** Whole-tree: `packages/adapter-manager/src` has **zero** imports
of `@armyofagents/db` or `drizzle`; `packages/worker-daemon/src/index.ts:5` states the constraint is
**statically enforced**. A durable row genuinely cannot be written in-process.

**★ "The freeze blocks the wire hop" does not hold — two candidate channels exist. ★★ BUT NEITHER
REACHES DE-17'S BOUNDARY, and that is the correction this section carries.**

The two candidates are set out first, because the refutation is only legible against them.

1. **The frozen envelope ships a bounded extension container built for exactly this.**
   `packages/worker-protocol/src/extensions.ts` defines `{namespace, schemaVersion, critical, value}`
   with locked limits, and **`extensions` is a field on the worker EVENT schema**
   (`packages/worker-protocol/src/events.ts:347`, refined at `:405`). V1 recognises **no** critical
   namespaces, so a `critical: false` extension is ignored by a frozen v1 consumer **by design** —
   which is what makes it additive under the freeze rather than a breach of it. The daemon's own
   emitter already takes it: `EventSequencer.#emit(eventType, payload, extensions = [])`
   (`packages/worker-daemon/src/supervisor/events.ts:138`), and the daemon already **reads**
   extensions off inbound envelopes (`lease/staged-input.ts:98`, `lease/control-commands.ts:112`).
   The precedent for a governed refusal riding the wire is in the frozen vocabulary already:
   **`network_denied`** (`events.ts:371`) is exactly that shape.
2. **The adapter-manager already has an authenticated HTTP channel to the control plane.**
   `server/src/app.ts:525` mounts `adapterManagerControlRoutes` with the comment *"adapter-manager
   PULLs to classify orphan sandboxes"*, and `server/src/routes/adapter-manager-control-auth.ts`
   exists as its dedicated auth module. A denial at `packages/adapter-manager/src/owned-op-gate.ts:154-156`
   can be reported over a channel that is **already built, already authenticated, and not governed
   by `worker-protocol` at all.**

★ **The counter-evidence about `E7-F011`, stated because it is the obvious objection and it does
NOT apply.** `E7-F011` records that `CLI-008` Unit B's channel *"has no route on the
networked/container lane"* — but measured, that finding is about a **provider operation**
(`stage_files`) missing from the frozen **operation vocabulary** (`capabilities.ts:142-153`), which
is a different mechanism from the **extensions container on a worker event**. It does not transfer.

### ★★ THE REFUTATION — BOTH CHANNELS FAIL, AND THE FAILURES ARE INDEPENDENT

*Raised as P1 by Codex on PR #407 against this section's first draft, verified at source, and
carried here rather than footnoted.*

**Channel 1 fails on INGESTION, not on the envelope.** The envelope can carry the extension; the
path that would make it durable rejects it first. Worker events land through the fenced ingest
service `server/src/services/job-events.ts`, whose own header states the pipeline: it *"hand[s] the
batch to the guarded `acceptEvent` mutator, which gates on the ACTIVE fence FIRST (throws
`stale_fence` / `attempt_terminal`)"*. At the mutator, `acceptEvent`
(`packages/db/src/repositories/tenant/job-control.ts:2588`) runs
`const { lease, attempt } = await guardActiveFence(input);` at **`:2592`** — **before any append**,
under the closed governed-mutator invariant that *"[e]very method below gates on `guardActiveFence`
BEFORE touching (or reading) a governed row"* (`:2585-2587`).

**★ AND DE-17'S SCENARIO IS POST-FENCE BY DEFINITION.** The row's boundary is *"Provider manager ↔
expired/replaced resource"* and its `failureMode` is *"cleanup is blocked **after fence loss**"*.
An event carrying post-fence cleanup evidence therefore arrives holding exactly the fence
`guardActiveFence` exists to reject, and is refused with **no durable write**. So the extension
container is a real carrier for events on a **live** fence and is structurally unable to carry the
defining case. A unit that wired it would ship a recorder that is green in every test with an active
fence and silent on every occasion DE-17 names — **this programme's own "a check that nothing
runs."**

**Channel 2 fails on TYPING, not on reachability.** The adapter-manager's CP channel exists and
works; the *denial available on it is the wrong denial*. `execute` — the escalation the clause cares
about — is dispatched through **the same** `gateOwnedOp` as `cancel`/`kill`/`destroy`
(`packages/adapter-manager/src/server.ts:153-155` beside `:157-165`; all eight ops sit in one
`GATE_REQUIRED_OPS` set at `:89-98`). And the denial at `owned-op-gate.ts:154-156` is a **field-wise
label/generation mismatch** throwing `ResourceNotAvailableError` — an **ownership** refusal, thrown
identically for an effect op and a cleanup op, and deliberately collapsed with not-found so there is
no existence oracle. `OwnedLabelsCapability` is `{v, audience, ownedLabels, expiresAt, sig}` with
**no operation or scope field**, so nothing at that gate can distinguish *"a cleanup-authority
holder attempted an effect op"* (conjunct 6b's escalation) from *"a caller asked about a resource it
does not own."* Auditing it yields a **generic authorization log**, not a denied-escalation record.

★ **AND THIS CORRECTS A CITATION THIS PAPER INHERITED.** `owned-op-gate.ts:154-156` is the line the
**register itself** cites under DE-17. It is a fair citation for the *ownership* compare at the
wire — but this paper first reproduced it in support of conjunct **6b** ("denied escalations"),
which it does not support. That is precisely the inheritance §1 forbids, committed in the document
that forbids it.

★★ **CORRECTION BANNER — RECONCILED TO E0-F013 DECISION 1.6 (RULED 2026-09-11, UN-BUNDLED).** The
freeze-refutation this section carries STANDS (the v1 protocol freeze is not the blocker), and the
two-channel refutation below (channel 1 fence-guarded on ingest, channel 2 wrong-typed at the wire)
STANDS for those two channels. **★★ RE-CORRECTED 2026-09-11 (Codex P1, verified at source) — the un-bundle draft's conclusion in this paragraph was ITSELF WRONG.** An earlier draft claimed a CP-side drain EXISTS and therefore 6a was deliverable now. That conflated TWO different drains: `drainWorkerDenial` → `recordSecurityDenial` (migration `0274`) carries DENIALS (proof-replay / auth-fence refusals, DE-03/DE-06), NOT cleanup outcomes. The post-fence cleanup this clause audits — `CleanupAuthority.converge` (`packages/worker-daemon/src/supervisor/cleanup-authority.ts`) — runs OFF-PLANE in the worker daemon and reports its outcome to NO control-plane sink (it returns a local `CleanupStatus` plus a `cleanup_outcome` metric). So a CP-side drain FOR CLEANUP OUTCOMES is genuinely MISSING, and the original "cannot discharge / did not measure a route to" conclusion was RIGHT for the cleanup-outcome carrier. **Therefore 6a is NOT deliverable now:** it ALSO needs an unbuilt worker→CP carrier for the cleanup outcome — SIMPLER than 6b (report the outcome, no authority-typing) and sequenceable first once that carrier exists, but not wireable at an existing point today. **6b (denied escalations)** likewise remains hard-blocked, and is DEFERRED
with **two routes** (`E0-F014` authority-typing OR an unbuilt worker self-report carrier) — not a
strict one-way `E0-F014` prerequisite. Under this ruling, the "What is genuinely missing" paragraph,
option **(c)**, the **★ RECOMMENDATION — (c)**, the **(b)** "the audit conjunct cannot be chartered
ahead of the authorization one" reasoning, and the closing "**blocked for two different and harder
reasons**" are all SUPERSEDED **for 6a** (they continue to describe 6b's blockers correctly). The
original reasoning is preserved below as the trail that produced the ruling.

**What is genuinely missing, then, restated after the refutation:** a **catch point** (nothing
catches `CleanupAuthorityDeniedError` today), **an authority-typed carrier that is not fence-guarded**
— neither of which exists — and a **CP-side drain**. The first is code; **the second is a design
obligation this paper cannot discharge and did not measure a route to.**

**Options, rewritten after the refutation.**

**(a) AMEND** — narrow to "denied escalations are recorded in the worker's local log". Cost: a
**Critical** cleanup-authority crossing would assert only a process-local line that dies with the
process, on a boundary whose entire premise is that the worker is **less trusted**. A record the
untrusted side keeps about itself is not an audit record. **Reject.**

**(b) CHARTER — and this is now the substantive option, but it is bigger than "a catch point and a
drain".** It requires, in order: (i) a **catch point** for `CleanupAuthorityDeniedError`; (ii) an
**authority-typed** denial — which means giving `OwnedLabelsCapability` an operation/scope field, so
the gate can tell an escalation from a wrong-owner miss. **That is `DE-17`'s `authorization` clause,
not its `audit` clause** — the register already records it as absent and *unrepresentable*, and
`E0-F014` owns it. So the audit conjunct **cannot be chartered ahead of the authorization one**; and
(iii) a carrier that is **not fence-guarded**, because the worker-event ingest path rejects
post-fence batches before any append. `DE-17`'s four ownerTickets (`WRK-004`, `DEP-008`, `CLI-004`,
`REL-004`) all have files on disk, but **`REL-004` names no `DE-17` post-fence-cleanup test**, so the
exit criterion must be written in the same charter.

**(c) THIRD PATH — move the whole clause behind `E0-F014`, as `DE-21`'s board half went to
Decision 3.** Do not amend and do not charter the audit conjunct independently. Record that both
conjuncts are blocked on `DE-17`'s **`authorization`** clause (an authority-typed capability) and on
a non-fence-guarded carrier, and rule when `E0-F014` rules. Cost: `DE-17` stays `partial` with an
`audit` clause it does not satisfy — which is exactly what `partial` is defined to mean.

**★ RECOMMENDATION — (c).** ★★ **This is a change from this paper's first draft, which recommended a
split by channel; the split is withdrawn on measurement.** (c) is the only option that neither
narrows a Critical control to something the current architecture happens to satisfy, nor charters an
audit record ahead of the authorization typing that record depends on. The dependency runs one way:
**you cannot record "a denied escalation" until the system can tell an escalation from a wrong-owner
miss.**

**★ THE STRONGEST ARGUMENT AGAINST (c).** *Deferring behind another open finding is how a Critical
clause goes quiet for a year.* `E0-F014` is open, unscheduled, and now carries three obligations
(the dead drain, the dead deadline, and — under (c) — DE-17's capability typing); adding a fourth
dependent to an unfunded finding is chartering by implication. The honest counter-move if the
founder finds that unacceptable is **(b) with the sequencing written into the ticket** — fix the
capability typing first, then the carrier, then the record — accepting that this is a multi-ticket
epic and not an audit-wiring job.

**★ Record with whichever is chosen, because it is what this section actually established:** the
*stated* blocker — the v1 protocol freeze — **does not hold**. `extensions[]` is on the worker-event
schema and V1 recognises no critical namespaces, so a `critical:false` extension is additive under
the freeze. **`DE-17` is blocked for two different and harder reasons: the ingest path is
fence-guarded on exactly the post-fence case the row names, and the wire capability cannot express
the escalation the clause asks to record.** The freeze should not be cited as the blocker again.

---

## 7. ★ THE ARITHMETIC — verified independently, and E0-F013's own number is off by one

**The seventeen, verified.** The class is *crossings whose `audit` clause asserts that denials are
recorded*. Two findings carry it:

- **`E0-F010`, eight** (its own text, `findings.md:271`): `DE-01`, `DE-03`, `DE-04`, `DE-06`,
  `DE-11`, `DE-12`, `DE-13`, `DE-14`.
- **`E0-F013`, nine** (its table, `findings.md:504` ff.): `DE-15`, `DE-16`, `DE-17`, `DE-18`,
  `DE-19`, `DE-20`, `DE-21`, `DE-27`, `DE-29`.

8 + 9 = **17**. ✔ No crossing appears in both.

**Closed: one.** `DE-19` (2026-09-08), scoped to `memory.get`. `DE-06` and `DE-21` each received a
*fraction* of a conjunction in Unit C (2026-09-09) and **neither closed**. **Open: sixteen.**

★ **AMENDED 2026-09-10, AFTER THIS PAPER WAS MERGED — CLOSED: THREE, OPEN: FOURTEEN.** Two
crossings closed that day, in two separate units, and the amendment is stated once at its final
figure rather than twice at two intermediate ones. `DE-06`'s audit clause is now whole: the
object-access unit delivered the *"object put/get"* conjunct — the one §6.1's row 5a names as
*"already-scheduled work, not a decision"*. `DE-14`'s clause — *"the startup safety-assertion
outcome is logged"* — is SINGLE-CONJUNCT and both directions of the outcome are now logged at the
entrypoint's one startup load, so it closed later the same day. **Both leave `E0-F010`'s cohort,
which drops from eight to SIX**; `E0-F013`'s nine are unchanged. **This changes NO ruling this
paper asks for and no recommendation in it:** neither crossing was one of the six undeliverable
halves, and the ceiling table below already counted **both** among the eleven closable — so the
"closable, ever" ceiling of eleven is untouched and the "more closable" figure drops from ten to
**eight**. `DE-21` is unchanged and still carries a fraction. The count is amended here rather than
left to stand because a decision paper whose central complaint is an over-stated count must not
carry a stale one of its own. **The authoritative class-wide count lives in `E0-F013`'s Status
block** (`docs/replatform/epics/E0-foundation/findings.md`), not here.

★ **FURTHER AMENDED 2026-09-11 BY E0-F013 DECISION 1 — RESOLVED-BY-AMENDMENT: TWO; OPEN: TWELVE.** DE-12 and DE-20's audit clauses were resolved by AMENDMENT (each: one conjunct delivered, the remaining conjunct(s) amended as vacuous), so each leaves its audit-gap cohort (E0-F010 6→5; this-cohort/E0-F013 8→7) while staying `partial` in the register. WHOLE-DELIVERED stays THREE (DE-06/DE-14/DE-19); resolved-by-amendment is a separate category. ★ THE EFFECT ON THE "CLOSABLE EVER" CEILING BELOW TURNED ON WHICH CONVENTION GOVERNS — the ruling itself did not settle that, and it is now SETTLED at the note below. Two conventions were in play: (i) the §7 table and the FACT CHECK below treat DE-12/DE-20 — and, before the ruling, DE-27 — as STILL hard-blocked on the conjuncts now amended-vacuous, because the controls those conjuncts would audit are unbuilt, which leaves the ceiling at eleven-to-thirteen; (ii) the audit-gap-cohort convention just used above — the SAME one under which the ceiling already counts DE-06 and DE-14 as closable though their register rows stay `partial` — treats an amended-honest clause as RESOLVED, and under it DE-12, DE-20 and DE-27 (weak reading) all leave the hard-blocked set, leaving DE-17 as essentially the sole audit clause blocked on an unbuilt mechanism and raising the ceiling toward sixteen (and whether DE-17's 6b is even hard-blocked is itself open — the re-audit found it has a buildable worker-self-report route). ★ CONVENTION SETTLED 2026-09-11 (methodological, not a new founder disposition): convention (ii) governs, because §7 ALREADY applies it — it counts DE-06 and DE-14 among the closable eleven though both register rows stay `partial`, so `partial` is not the ceiling criterion and an amended-honest clause is RESOLVED for ceiling purposes exactly as a whole-delivered one is. The unbuilt underlying controls (DE-12's partition detector / drain producer, DE-20's dead rollback drain) are charged to E0-F011 / E0-F014, NOT to this audit-class ceiling; charging them here too is the double-count convention (i) commits. Under convention (ii) the sole crossing whose audit clause is still blocked on an unbuilt mechanism is DE-17 — its 6b (denied escalations) half, deferred behind E0-F014 authority-typing OR an unbuilt worker self-report carrier — a NEW mechanism, not ordinary audit-write wiring at an existing deny point. 6a is LIKEWISE not ordinary wiring at an existing point: its cleanup-outcome carrier is equally unbuilt (the cleanup runs off-plane and reaches no CP sink), so neither half is closable now — 6a is only SIMPLER (report the outcome, no authority-typing) and sequenceable first once the carrier exists. THE POST-RULING CLOSABLE-EVER CEILING IS THEREFORE SIXTEEN: 17 − 1 (DE-17). Equivalently, the eleven originally enumerated + the five the ruling freed (DE-01, DE-11, DE-12, DE-20, DE-27) = 16. This is the ceiling, a DIFFERENT figure from the open count: five are already resolved (three whole — DE-06/DE-14/DE-19; two amended — DE-12/DE-20), so eleven MORE are closable. Never quote seventeen as achievable. (Conditional upper edge: 17 only if DE-17 closes WHOLE — BOTH 6a (its worker→CP cleanup-outcome carrier is built) AND 6b (resolved via E0-F014 authority-typing, or a worker self-report, or 6b amended to an honest decline). Resolving only ONE half leaves DE-17 open and the ceiling at sixteen — a future disposition, not a co-equal reading.) The undisputed post-ruling facts: the audit-gap cohorts dropped (E0-F010 6→5, E0-F013 8→7), and DE-17 is the only Group-D clause still blocked on an unbuilt mechanism under either convention.

**Now the count E0-F013 states.** Its own words:

> *"of the seventeen, ONE is closed and at most ELEVEN more are closable end to end. Five
> clause-halves are not, and DE-17 is a sixth behind the protocol freeze. Any plan must state
> twelve, not seventeen."*

**Working, from the finding's own Group D:**

| | |
|---|---|
| Total in class | **17** |
| Group D members the finding treats as **not closable** | `DE-01` (read half), `DE-27`, `DE-12`, `DE-20` (rollback half), `DE-11`, `DE-17` = **6** |
| *(`DE-14` is also in Group D but the finding calls it closable — "~5 lines, take it as a freebie" — so it is not in the six)* | |
| Therefore closable, ever | 17 − 6 = **11** |
| Of those, already closed | `DE-19` = **1** |
| Therefore **more** closable | 11 − 1 = **10** |

**★ THE FINDING SAYS "ELEVEN MORE", WHICH GIVES 1 + 11 = 12. THE CORRECT FIGURES ARE TEN MORE AND
ELEVEN TOTAL.** The slip is visible inside the sentence itself: it subtracts **five**
("Five clause-halves are not") and then adds `DE-17` as **a sixth** without re-subtracting.
17 − 5 = 12; 17 − 6 = 11. **Yes — DE-17 makes it eleven.**

Enumerated, so the eleven can be checked one at a time: `DE-03`, `DE-04`, `DE-06` *(closed
2026-09-10)*, `DE-13`, `DE-14` *(closed 2026-09-10)*, `DE-15`, `DE-16`, `DE-18`, `DE-19` *(closed
2026-09-08)*, `DE-21`, `DE-29`. *(The "already closed = 1" and "more closable = 10" rows above are
the 2026-09-08 derivation and are left at their own date; the current figures are three closed and
eight more closable — see the amendment at the head of this section.)*

**★ AND THIS PAPER'S OWN MEASUREMENT MOVES IT AGAIN — which is why no single number is handed over.**
Under §2 and §6.1, **two** of the six are not blocked as filed. **DE-17 is not one of them**: §6.2's
first draft placed it here, and the placement was withdrawn on review (the freeze is not its
blocker, but it has two harder ones).

| Premise | Hard-blocked crossings | Honest ceiling |
|---|---|---|
| `E0-F013`'s Group D as written | `DE-01`, `DE-11`, `DE-12`, `DE-17`, `DE-20`, `DE-27` (6) | **11** |
| This paper's measurement (DE-11 rescheduled; DE-01 deliverable at a declined cost; **DE-17 stays blocked**) | `DE-12`, `DE-17`, `DE-20`, `DE-27` (4) | **13** |
| ~~This paper's first draft (DE-17 also rescheduled)~~ | ~~`DE-12`, `DE-20`, `DE-27` (3)~~ | ~~14~~ — **WITHDRAWN**, see §6.2 |
| ★ Enacted ruling (2026-09-11) under convention (ii) — DE-01/DE-11/DE-12/DE-20/DE-27 freed (amended-honest or ordinary work); DE-17 sole hard-block | `DE-17` (1) | **16** |

**The number a plan states was SETTLED by this ruling (enacted 2026-09-11) and the 2026-09-11
convention reconciliation.** ★ **SETTLED:** under convention (ii) — the one §7 already applies to
DE-06/DE-14 (both `partial`, both counted closable) — the post-ruling **closable-ever ceiling is
SIXTEEN** (17 − DE-17, the sole audit clause still blocked on an unbuilt mechanism). The pre-ruling
band *"eleven under the current dispositions; up to thirteen if Decision 1 reschedules DE-11 and
funds DE-01's read half"* is SUPERSEDED: the ruling **declined** to fund DE-01's read half (an
offline verifier chartered-but-unfunded) yet still freed DE-01/DE-11/DE-12/DE-20/DE-27 under
convention (ii), so all five leave the hard-blocked set. **Never state seventeen.** *(The pre-ruling
arithmetic point — that `E0-F013`'s "twelve" should have read "eleven" — was about the closable count
under the OLD Group-D-as-written premise; it is superseded by the settled ceiling above.)* The
closable-ever ceiling of SIXTEEN is DISTINCT from the open count of TWELVE (5 already resolved: 3
whole + 2 amended; 11 more closable). The dispositions in this table were signed and enacted
2026-09-11.

★ **The withdrawn row is kept struck rather than deleted**, on this programme's own convention: a
paper whose central complaint is an over-stated count must not quietly restate its own.

★ **FACT CHECK 2026-09-11 — the HEAD deliveries above do NOT move these counts, and here is why.**
`DE-12`'s conjunct **3c** and `DE-20`'s conjunct **4a (legacy arm)** were both delivered after this
paper's branch point (§4, §5). Neither moves the "hard-blocked" set: `DE-12` stays hard-blocked on
its still-vacuous **3a + 3b**, and `DE-20` stays hard-blocked on its still-vacuous **4b (rollback)** —
each row was counted here on the strength of the conjunct that is *still* vacuous, not the one now
delivered. So both rows remain in the `(4)`/ceiling-13 measurement unchanged. The deliveries close
sub-conjuncts, not crossings; the ruling this paper requests is unchanged and **UNRULED**. ★ **SUPERSEDED
2026-09-11:** the ruling has since been made, and it AMENDED 3a+3b (DE-12) and 4b (DE-20) as vacuous
and adopted DE-27's weak reading. This FACT CHECK describes only the pre-ruling effect of the 3c/4a
deliveries, which alone did not move the set; under convention (ii) — the convention §7
already applies to DE-06/DE-14 — DE-12, DE-20 and DE-27 all LEAVE the hard-blocked set (audit clauses
amended-honest or reclassified as ordinary Group B/C work), so the post-ruling closable-ever ceiling
is SIXTEEN with DE-17 the sole hard-block. See the settled note at the head of this section.

**One drift noted in passing, changing nothing here.** `E0-F013` records Decision 2's acceptance
condition **(a)** — a production reader of `security.denied.*` — as **OPEN**. At this branch point
the reader **ships**: `activityService.securityDenials` (`server/src/services/activity.ts:308`) behind
`GET /instance/security-denials` (`server/src/routes/activity.ts:112`, gated by
`assertCanManageInstanceSettings`). That is a Decision 2 bookkeeping item, not a Decision 1 one, and
this paper does not amend it.

---

## 8. ★ DECISION BLOCK — six signatures, not one

The six are different shapes and must be signed separately. **Signing a blanket "amend everything"
would narrow two Critical controls that are not actually blocked.**

---

### ▢ **DECISION 1.1 — DE-01 (Critical), `audit`, read-denial conjunct**

**★ RULED 2026-09-11 (founder direction, on the independent re-audit at HEAD `bd21e1abc`):** (c) — amend conjunct 3 to the decline (enacted in the register). The chartered OFFLINE verifier is NOT YET funded in a named wave; until it is, this is (a)-plain — the read-side detection loss is written down, unmitigated. Do not read the offline verifier as coverage.

- ▢ **(a)** Amend to the decline (exact text in §2.4). Read-denial detection is given up.
- ▢ **(b)** Charter a serving-path comparator. *Not recommended by the measurement that unblocked it.*
- ▢ **(c) ★ RECOMMENDED** — Amend as (a), **and** charter a narrow **offline** verifier on the `0268`
  shape as a separate, later ticket.
- ▢ **(a) plain** — take (a) and explicitly decline the verifier, writing the loss down unmitigated.
  *Choose this if (c)'s verifier will not be funded in a named wave.*

**Also record:** conjuncts 1a ("query events") and 1b (write-side `42501`) are **unblocked and
unwritten**, and are **not** covered by this ruling.

---

### ▢ **DECISION 1.2 — DE-27 (High), `audit`**

**★ RULED 2026-09-11 (founder direction, on the independent re-audit at HEAD `bd21e1abc`):** (c) — weak reading of cross-replica admission kept as an open Group B/C obligation; partition dropped vacuous. Stale citation `:1983` corrected by symbol to the SKIP-LOCKED candidate claim `:3527` (and the conditional offerLease UPDATE `:3855-3871`) in the enacted register text.

- ▢ **(a)** Amend both conjuncts (exact text in §3.4).
- ▢ **(b)** Charter replica identity + a partition detector. *`FND-005` has only a policy paragraph;
  `REL-002` has zero files.*
- ▢ **(c) ★ RECOMMENDED** — Adopt the **weak** reading of "cross-replica admission" (so the conjunct
  stays an **open obligation** inside Groups B/C), and **drop** the partition conjunct as vacuous.
  `DE-27` stays `partial` and stays in the cohort.

---

### ▢ **DECISION 1.3 — DE-12 (Critical), `audit`**

**★ RULED 2026-09-11 (founder direction, on the independent re-audit at HEAD `bd21e1abc`):** (a) CORRECTED — drop ONLY 3a (partition) + 3b (drain) as vacuous and RECORD 3c (generation changes) DELIVERED. The §4.3 Option (a) verbatim text and this block's original wording ("drop all three") are STALE-FALSE at HEAD (3c is delivered via `recordServiceGenerationRollActivity`, R-T11) and were NOT enacted; see the enacted register audit clause. 3a+3b are vacuous for the NARROW reason that a partition detector and a reconciler-driven drain producer do not exist (E9-F008) — NOT because the reconciler or fences are unbuilt: SVC-002 (reconciler) and SVC-003a/SVC-005a (fences + generation writer) have shipped. The "SVC-003/SVC-005 zero files" census in §4.3 is a `743c30f08` branch-point artifact, already flagged by the SUPERSEDED banner at the head of §4.3; do not re-import it.

- ▢ **(a) ★ RECOMMENDED** — Amend, dropping **all three** conjuncts as vacuous (exact text in §4.3),
  keeping `partial`, keeping `E0-F011` as owner, and stating in the clause that the *control* is
  unbuilt so the audit clause has no subject.
- ▢ **(a) + escalate** — as (a), **and** raise `E0-F011`/`SVC-003`/`SVC-005`'s visibility, since the
  real loss is that **two of the three ownerTickets have zero files** while the third, `SVC-002`, is
  designed-not-implemented (954 lines) and **scopes the generation writer out in writing**.
- ▢ **(b)** Charter the reconciler / fence / drain (`SVC-002`, `SVC-003`, `SVC-005`). *Chartering to
  save this clause means funding `SVC-003` and `SVC-005`, which have zero files — `SVC-002`'s design
  says `services.generation` still has no writer after it ships (`SVC-002-design.md:490-491`).*

**★ CENSUS CORRECTED, 2026-09-10.** An earlier draft of this decision said *"three ownerTickets with
zero files"*, inherited from `DE-12`'s own `deliveryEvidence`. **`SVC-002` has two files (604 + 350
lines), landed in `08746b160` before this paper's branch point.** Re-measured in §4.3; the
recommendation is unchanged and is re-derived in §4.4 **without** the census, from three
source-tree measurements (`update(services)` zero hits; no reconciler source file; no replica
identity).

**★ Do not amend only the "generation changes" conjunct.** The clause has three and all three are
vacuous.

---

### ▢ **DECISION 1.4 — DE-20 (Critical), `audit`**

**★ RULED 2026-09-11 (founder direction, on the independent re-audit at HEAD `bd21e1abc`):** (a) scoped to 4b only — rollback conjunct dropped vacuous; cutover-selection (4a) is DELIVERED for both arms (W20-B, heartbeat.ts:5388) and left untouched by this amendment.

- ▢ **(a) ★ RECOMMENDED, SCOPED TO 4b ONLY** — Amend the *rollback* conjunct as vacuous (exact text
  in §5.3), explicitly leaving the *cutover selection* conjunct untouched (4a since DELIVERED at HEAD — W20-B, `heartbeat.ts:5388`).
- ▢ **(c)** Do not amend; move 4b **behind `E0-F014`** and rule when `E0-F014` rules on the dead
  drain. *Keeps the row's current internal contradiction visible.*

**Also record:** conjunct 4a's legacy-selection record is DELIVERED at HEAD (`buildCutoverSelectionEvent`,
`heartbeat.ts:5388`, both arms; W20-B 2026-09-10) and was **not** a Decision 1 item.

---

### ▢ **DECISION 1.5 — DE-11 (High), `audit`**

**★ RULED 2026-09-11 (founder direction, on the independent re-audit at HEAD `bd21e1abc`):** REMOVED from Decision 1 — premise stale, rescheduled; held `partial` for a coverage reason (see register deliveryEvidence).

- ▢ **★ RECOMMENDED — REMOVE FROM DECISION 1.** The premise ("nothing decides") is **stale**.
  `resolveStoredRetention` decides at `artifact-commit.ts:253` and `:257`, with `input.appDb` and
  `ctx.companyId` in scope and `recordSecurityDenial` already imported at `:46`. Charter the
  retention record as a small ticket; the access conjunct rides `DE-06`'s put/get half, which was DELIVERED 2026-09-10 (the object-access unit records the grant with kind/sensitivity) — so that half is discharged, gated only by the BRW-003 coverage caveat.
- ▢ **Constraint to attach if chartered:** `DE-11` **must stay `partial`** until `BRW-003` ships and
  the record is provoked on a genuinely sensitive kind — the decision point fires for all kinds, but
  no `browser_cookie_state` exists to be seen today.
- ▢ **(a)** Amend anyway. *No honest narrowing is available; an amendment here would have to assert
  something false.*

---

### ▢ **DECISION 1.6 — DE-17 (Critical), `audit`**

★★ **THIS DECISION CHANGED ON REVIEW. A split by channel was recommended in the first draft and is
WITHDRAWN** — Codex P1 on PR #407, verified at source (§6.2). Neither candidate channel reaches this
row's post-fence boundary.

**★ RULED 2026-09-11 (founder direction, on the independent re-audit at HEAD `bd21e1abc`):** NOT (c)-as-written — UN-BUNDLED, but CORRECTED 2026-09-11 after a Codex P1 (verified at source). 6a is NOT deliverable now: the post-fence cleanup (`CleanupAuthority.converge`) runs OFF-PLANE in the worker daemon with no worker→CP carrier for its outcome, and the existing drain (`drainWorkerDenial` + migration `0274`) carries DENIALS (DE-03/DE-06), NOT cleanup outcomes — so the original "CP-side drain missing [for cleanup outcomes]" was RIGHT, and the un-bundle draft's "FALSE" was itself the error (it conflated the denial drain with a cleanup-outcome drain). 6a needs the unbuilt worker→CP cleanup-outcome carrier; 6b needs EITHER `E0-F014` authority-typing (the adapter-manager then reports the escalation over its OWN CP channel, no worker carrier) OR a worker self-report. Both halves need an unbuilt mechanism, but DIFFERENT ones; 6a is SIMPLER (report the cleanup outcome, no authority-typing) and can be sequenced first. The v1 freeze is not the blocker. DE-17 stays partial and the sole audit clause hard-blocked on an unbuilt mechanism. See enacted register audit clause.

- ▢ **★ RECOMMENDED — (c), MOVE THE WHOLE CLAUSE BEHIND `E0-F014`** (as `DE-21`'s board half went to
  Decision 3). Both conjuncts are blocked on `DE-17`'s **`authorization`** clause — an
  authority-typed capability, without which a "denied escalation" cannot be told from a wrong-owner
  miss — and on a carrier that is not fence-guarded. Rule when `E0-F014` rules. `DE-17` stays
  `partial`.
- ▢ **(b)** Charter as a sequenced multi-ticket epic — capability typing **first**, then the
  carrier, then the record — and fix `REL-004` to name a `DE-17` post-fence-cleanup test in the same
  charter. *Choose this if deferring behind an unfunded `E0-F014` is unacceptable.*
- ▢ **(a)** Amend to "recorded in the worker's local log". *Reject — a process-local line kept by the
  less-trusted side is not an audit record.*

**★ Record with whichever is chosen, because it is measured and it is what a future reader will
otherwise get wrong twice:** the *stated* blocker — the v1 protocol freeze — **does not hold**
(`extensions[]` is on the worker-event schema at `events.ts:347`; V1 recognises no critical
namespaces, so a `critical:false` extension is additive **under** the freeze). **The real blockers
are two, and both are harder:** (1) the fenced worker-event ingest gates on `guardActiveFence`
**before any append** (`job-events.ts` header; `job-control.ts:2592`, in `acceptEvent` at `:2588`,
under the closed-mutator invariant at `:2585-2587`), and DE-17's scenario is
post-fence **by definition**, so that carrier rejects exactly the case the row names; (2)
`OwnedLabelsCapability` has no operation or scope field and `execute` shares `gateOwnedOp` with
`cancel`/`kill`/`destroy` (`server.ts:89-98`, `:153-155`), so the only denial available at the wire
is an ownership mismatch (`owned-op-gate.ts:154-156`, `ResourceNotAvailableError`) and auditing it
yields a generic authorization log. **Do not cite the freeze as the blocker again, and do not read a
wired ownership-denial log as DE-17 closing.**

---

### ▢ **DECISION 1.7 — THE COUNT**

**★ RULED 2026-09-11 (founder direction, on the independent re-audit at HEAD `bd21e1abc`):** RULED -- the ruling fired 1.5 (DE-11 rescheduled), 1.1 (DE-01 read-half DECLINED, not funded), 1.3 (DE-12 amended-resolved), 1.4 (DE-20 amended-resolved), 1.2(c) (DE-27 weak reading = ordinary Group B/C work) and 1.6 (DE-17 un-bundled, then CORRECTED same day after a Codex P1 — 6a is NOT deliverable-now; both halves need an unbuilt mechanism — 6a the worker→CP cleanup-outcome carrier, 6b either E0-F014 authority-typing or a worker self-report; 6a simpler). The undisputed consequence: of E0-F013's SIX Group-D clause-halves, FIVE are now resolved or reclassified as achievable/ordinary work, leaving DE-17 (blocked on the missing post-fence-event carrier) as the ONLY audit clause still blocked on an unbuilt mechanism. ★ CONVENTION SETTLED 2026-09-11 (methodological): convention (ii) governs — the SAME one §7 already applies by counting DE-06/DE-14 among the closable eleven though their crossings stay `partial`. An amended-honest audit clause is resolved for the ceiling; the unbuilt underlying controls are E0-F011/E0-F014's concern, not this ceiling's. So DE-12, DE-20 and DE-27 leave the hard-blocked set, leaving DE-17 (both halves need an unbuilt mechanism — 6a the worker→CP cleanup-outcome carrier, 6b either E0-F014 authority-typing via the adapter-manager's own CP channel or a worker self-report) as the SOLE hard-block. THE CLOSABLE-EVER CEILING IS SIXTEEN (17 − DE-17). The open count is separate and unchanged: 12 open / 5 resolved (3 whole + 2 amended). A plan states SIXTEEN (16 = 17 − DE-17; the ceiling would rise to SEVENTEEN only if DE-17 closes WHOLE — BOTH 6a's cleanup-outcome carrier built AND 6b resolved (carrier + authority-typing, or 6b amended to an honest decline); resolving only one half leaves DE-17 open) and never quotes seventeen as already-achievable.

- ▢ **★ RECOMMENDED** — Record that `E0-F013`'s **"twelve"** is **eleven** under its own groupings
  (working in §7), and that any plan states the number **as a band with its premise attached** —
  *eleven under current dispositions, up to thirteen if 1.5 reschedules DE-11 and 1.1 funds the read
  half* — **never seventeen**. ★ **SUPERSEDED 2026-09-11** by the settled ceiling in the RULED banner
  above: under convention (ii) the closable-ever ceiling is **SIXTEEN** (distinct from the twelve-open
  count); this pre-ruling band is kept only as the reasoning trail.
- ★ **The ceiling read fourteen in this paper's first draft**, on the strength of DE-17 also being
  rescheduled. **That was withdrawn on review** (§6.2, §7), and the struck row is kept visible in
  §7's table: a paper complaining about an over-stated count does not get to quietly restate its own.

---

## 9. What this paper is not

It changes **no** finding status, **no** `deliveryStatus`, **no** ownership, **no** clause text and
**no** gate-clause enrolment. It wires nothing and writes no production code. It exists so Decision 1
can be signed per clause — and so that three of the six are not amended away on a blocker that
measurement does not support.
