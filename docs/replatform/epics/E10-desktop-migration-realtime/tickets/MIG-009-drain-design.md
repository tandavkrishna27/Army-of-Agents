> ★★★ **REVIEW-VERIFIED (2026-08-27) — sound, execute as written, with three Step-0 precision fixes.**
> A confirmation reviewer verified the SQL shape (composite FK `job_attempts_org_job_fk` makes
> `selectDistinct(company_id, job_id)` dedup-by-job; dropping `FOR UPDATE` is safe because
> `requestCancellation` takes its own per-job lock), the mutation table (non-vacuous), and the
> `E10-1-drain` DEFER (no clean `drainAll` caller exists in scope; the write path is REL-005; acceptance
> can't go vacuously green on either branch). It also confirmed the §0.2 correction: the grain bug fails
> **CLOSED** (throws at tenant-admission before the receipt query — a dead lever), not open as the MIG-005
> §4 analysis claimed. **Three fixes for the executor (Step 0 already mandates re-verifying ~25 citations):**
> (1) **M-grain reddens only in Step 5 (the real budget-cost bridge), NOT the unit lane** — Step 1's `vi.fn`
> no-op `assertRollbackSafe` won't throw on an org id, so do not rely on the unit suite to kill M-grain;
> (2) the §3.2 "mirrors `canary-preflight-store.ts` including `runInTenant`" attribution is loose — that
> store reads on the plain owner `db`; the `runInTenant` RLS pattern comes from the **bridges'**
> `assertRollbackSafe` (`job-budget-cost-bridge.ts:326`); (3) citation drift: `TERMINAL_ATTEMPT_STATUSES`
> is `job-fence.ts:60`, `requestCancellation` spans `job-control.ts:3207-3312`.

---

# MIG-009 — Design: the distributed-execution drain — rollback-safe teardown

**Ticket node:** `docs/replatform/program-design.md` (`#### MIG-009` — a **later wiring step**
adds the node and the go-book copy-paste prompt; this ticket writes only the design file, per the
sprint brief. Until the node lands, `check-ticket-graph-coverage.mjs` would redden on this file —
so the node commit and this design commit are a pair, and the node is NOT this document's to add).
**Epic:** E10 (Desktop, Migration, Realtime). **Sprint:** 6 — the **one immediately-landable,
sink-agnostic** item. Finding **E10-F001** established that *no* Sprint-6 sink can cut over today
(shared, unbuilt prerequisites), and named this drain fix as "the one genuinely unblocked, landable
Sprint 6 item … Ship it independently."
**Predecessors (shipped):** `MIG-005-006-007-shadow-*` (the shadow observers that produce the only
distributed attempts a drain sees today — the org-heartbeat canary), `MIG-002-dial-*` /
`MIG-002-convergence-*` (the per-sink dial + the convergence sweeper this drain sits beside),
`CLI-006-*` / `CLI-007-*` (the canary preflight + credential mint), `DAT-008-slice-5-*` (the
worker-side redemption). The drain analysis itself is extracted, reviewer-verified, from
`MIG-005-cutover-design.md` §4 (that design's Commander-cutover framing was refuted by a 3-reviewer
pass; its §4 drain analysis survived as the record — this ticket is where it lands).
**Terrain reference:** `qa/2026-08-27-breadth-terrain-audit.md` (Sprint 6 section).
**Size:** S–M. **Verified at tip `2f7345293`.** Every `path:line` in §0 was read at this tip. **§0
MUST be re-verified at execution time** — line numbers drift, and this file cites ~25 of them.

**This ticket does NOT cut over any execution sink (E10-F001), and needs NO credential path.** It is
pure rollback / teardown correctness: the drain cancels distributed attempts of *any* sink, and the
only sink producing them today is the org-heartbeat canary. No `commander_turn` / `crew_run` /
`one_shot` routing, no mint, no `provider_connection`. Anyone reading this as a cutover has misread it.

---

## ★ 0. Verified state at tip, and one correction to the extracted analysis

Read at tip `2f7345293`. **Re-verify before writing code** — the house has been bitten by stale
line citations, and a `git checkout` mid-mutation eats uncommitted edits (commit first).

### 0.1 The drain is zero-caller, wrong-grained, missing its SQL, and half-untested

| Fact | Evidence at tip |
|---|---|
| `createDistributedExecutionDrain` has **zero production callers** | `gate-clause-wiring.json` → `E10-1-drain` = `unwired`, symbol `createDistributedExecutionDrain`; grep across `server/src`+`packages`+`cli` finds only `__tests__/job-distributed-drain.test.ts` constructing it. `index.ts` never names it. |
| The drain iterates **per Organization** and asserts rollback-safety with an **org id** | `job-distributed-drain.ts:118` `await deps.assertRollbackSafe(organizationId)`; dep type `job-distributed-drain.ts:50` `assertRollbackSafe(organizationId: string)` |
| Every concrete `assertRollbackSafe` is **per-Company** (`companyId`) | `job-budget-cost-bridge.ts:108,321`; `job-audit-bridge.ts:116,275`; `job-output-bridge.ts:177,439` — all `assertRollbackSafe(companyId: string): Promise<void>`. The mismatch **typechecks** (both are `(string)=>Promise<void>`). |
| An Organization holds **many** Companies | `canary-preflight-store.ts:41-47` — `SELECT id FROM companies WHERE organization_id = $1` returns a set |
| `listActiveAttempts` is an **interface member with NO SQL impl** | `job-distributed-drain.ts:40` (dep type) and `:137` (call site) — no production implementation anywhere; the tests hand it a `vi.fn` |
| `DRAINED_STATUSES` counts `"cancelled"` and `"no_active_lease"` — **both untested** | set declared `job-distributed-drain.ts:75-80` (`"cancelled"` :78, `"no_active_lease"` :79). The unit suite exercises only `queued` + `already_requested` (and `not_found` on the negative side); see `job-distributed-drain.test.ts` |
| The attempt return shape `requestCancellation` consumes | `job-distributed-drain.ts:26-30` `{organizationId, companyId, jobId}`; consumed at the cancel call `:145-151`. `requestCancellation` is keyed by **jobId** (not attemptId) and resolves the live attempt/lease itself — `job-control.ts:3236-3304` |

MIG-002 deferred all of this: *"The drain is still unwired, and further away than it looks"*
(`MIG-002-convergence-result.md` §6 limit 3). GATE clause 3 carries it as a Wave-4 blocker:
*"'wire the drain' is not a one-line fix"* (`GATE-clause-3-rollback-result.md` §6 limit 2). The
go-book schedules the fix in Sprint 6 (§4, "Also here: … fix `createDistributedExecutionDrain`").

### 0.2 ★ CORRECTION — the grain bug fails **CLOSED**, not "fails open". The extracted §4 analysis is WRONG on the mechanism.

`MIG-005-cutover-design.md` §0.5 / §3.2(1) / §4 (E1) / §7 (M5) all state the grain mismatch
*"asks a Company-keyed store about an id that is not a Company — it **matches no receipts and fails
open**, draining an org whose Company has a pending authoritative-cost receipt."* **Traced against
the real bridge code, that is false — and the consequence is inverted.**

The concrete `assertRollbackSafe(companyId)` begins by resolving the Company→Org edge, **before** any
receipt query:

- `job-budget-cost-bridge.ts:325` → `resolveAdmissibleOrganization(companyId)` (`:162-166`) →
  `resolveCompanyOrganizationId(appDb, companyId)` = `SELECT organization_id FROM companies WHERE id =
  $companyId` (`org-concurrency.ts:73-79`).
- Handed an **Organization** id where a Company id is expected, that `SELECT` matches **no row** (an
  org id is never a company id) and returns `null` (`org-concurrency.ts:78`).
- `assertAdmissibleMappedOrganization(null)` **throws** `TenantAdmissionDeniedError`
  (`tenant-admission.ts:110-115`, "null/blank Organization → unmapped → denied"). The receipt-count
  query (`job-budget-cost-bridge.ts:326-336`) is **never reached** — so "matches no receipts" never
  happens; the function throws at admission resolution first. (The audit and output bridges share the
  same shape: `job-audit-bridge.ts:275` and `job-output-bridge.ts:439` both resolve Company→Org
  first.)
- Back in the drain, that throw is caught by the rollback-safety try/catch
  (`job-distributed-drain.ts:117-128`) and the whole org is recorded `rollback_pending` and
  **SKIPPED**.

**Net: a drain wired to any real bridge as-is would refuse EVERY org and cancel NOTHING — a dead
rollback lever, fail-CLOSED — not a lever that "drains unsafely."** That is still a serious bug (an
operator pulls the teardown lever and silently nothing drains), but it is a different bug than the
one the extracted analysis names, and the mutation/acceptance framing must reflect the real behavior
(§7 M-grain, §8). Two further consequences of the correction, so no one re-derives the wrong shape:

1. **"Org grain = fail-open" is wrong in the other direction too.** A hypothetical purpose-built
   `assertRollbackSafe(organizationId)` querying `job_projection_receipts WHERE organization_id = $org
   AND status = 'pending'` would be *safe* — receipts carry `organization_id`. So the org grain is not
   inherently unsafe; the real defect is the **interface lie** (an org-typed dep with only
   company-typed impls), which fails closed against the bridges and inert against a naive rewrite.
2. **The genuine fail-OPEN in this area is the SIBLING-COMPANY one**, which the fix must still close:
   checking only *one* Company (say the first attempt's) instead of *all* Companies under the Org
   would miss a pending receipt on a sibling Company and drain the org unsafely. This is exactly the
   fail-open `canary-preflight.ts:20-26` names (*"Checking only the run's Company would let an
   Organization be canaried while a sibling Company's legacy leases stay unreconciled — a fail-open"*).
   The per-Company **enumeration** fix (§3.1) closes it; §7's real fail-open mutation is M-sibling, not
   M-grain.

### 0.3 The existing unit tests inject the OLD dep shape — they break the moment the grain is fixed

`job-distributed-drain.test.ts` constructs the drain with exactly
`{listAdmittedOrganizationIds, listActiveAttempts, requestCancellation, assertRollbackSafe}` and keys
`assertRollbackSafe` on the **organization** id (test 2: `if (organizationId === ORG_A) throw …`,
`:58-60`). The grain fix (§3.1) adds a required `listOrganizationCompanyIds` dep and re-types
`assertRollbackSafe` to per-**Company**, so **all five existing tests fail to compile / fail their
assertions** until reworked — a new required member is missing from every dep object, and test 2's
throw is keyed on the wrong id class. This is review-concern #1: `MIG-005-cutover-design.md` §10 R2's
claim that *"the pre-existing `job-distributed-drain.test.ts` mocks stay valid (they inject the
deps)"* is **wrong** — the injected shape is precisely what changes. §5 and §10 R2 below state this.

### 0.4 The composition site, and how the wiring checker reads a promotion

- The distributed-execution block in `index.ts` is gated on `config.distributedExecutionEnabled &&
  distributedExecutionDatabases` (`index.ts:613`, `:1121`). Flag-off allocates **no `aoa_app` pool**
  (`distributedExecutionDatabases` is `undefined`), so anything composed there has nothing to open —
  the same structural reason the convergence sweeper is safe (`MIG-002-convergence-result.md` §5).
- `listAdmittedOrganizationIds` is built once inside that block (`index.ts:582-611`) and **shared**
  with `createJobControlSweeper` (`index.ts:1242-1245`). A drain composed here would reuse it, exactly
  as the drain's own header intends (`job-distributed-drain.ts:6-7`).
- `check-gate-clause-wiring.mjs` counts **non-test, non-comment, non-import production references** to
  the clause symbol (`countProductionCallers`, `:66-90`). For `E10-1-drain` that symbol is
  `createDistributedExecutionDrain`; the count is **0** today. The rule the checker enforces
  (`evaluateGateClauseWiring`): `unwired` **with a caller** → `unwired_but_now_has_caller` (forces
  promotion); `wired` **with 0 callers** → `claimed_wired_but_no_caller` (fail). **Caller count is
  necessary but NOT sufficient** — the checker's own docblock says so (`:56-64`): a mere
  `createDistributedExecutionDrain(...)` reference at boot would flip the count to ≥1 **whether or not
  anything ever calls `drainAll`**. That gap is the whole of §4.

### 0.5 The `"cancelled"` status is a genuine drained outcome, not a strand (Step-0 question, answered)

`MIG-005-cutover-design.md` §3.2(3) left "is `cancelled` a drained outcome or a strand?" for Step 0.
The code answers it: `requestCancellation` returns `status:"cancelled"` on the path where there is
**no fenced worker** (an unleased attempt) and it finalizes the attempt+job **directly** and
terminally (`job-control.ts:3247-3281`, `return { status: "cancelled", … }` at `:3280`). That is a
real terminal cancellation, not a strand — counting it as drained is correct. `"no_active_lease"` is
likewise a benign "nothing live to fence" outcome. So E3 (§6) pins both as **counted**, and confirms
`job_terminal` is **not** counted (like the already-tested `not_found`). This is the definitive answer
to re-confirm, not re-open, at execution (Step 0).

---

## 1. The fact this ticket exists to change

| Fact | Evidence | This ticket |
|---|---|---|
| The rollback drain is zero-caller, wrong-grained (interface lie), and has no SQL | §0.1 | **fixes the two correctness defects unconditionally** — per-Company rollback-safety grain (§3.1) and the real `listActiveAttempts` SQL (§3.2) |
| Two `DRAINED_STATUSES` members are counted-as-success with no test | §0.1, §0.5 | **covers `cancelled` + `no_active_lease` (and the `job_terminal` negative)** so no status "passes because it evaluated nothing" (§3.3) |
| Fixing the grain changes `DrainDeps`, breaking the existing unit tests | §0.3 | **reworks `job-distributed-drain.test.ts`** to the new dep shape (review-concern #1; §5, §10 R2) |
| `E10-1-drain` promotion needs a real `drainAll` invocation, not mere composition | §0.4 | **decides the promotion HONESTLY** — defer to REL-005 (§4); the correctness fixes land regardless |
| No sink can cut over; no credential path is involved | E10-F001; §0 banner | **cannot and does not change** — stated as a non-goal (§9) |

**Net:** MIG-009 makes the rollback lever *correct when wired* — grain-safe, SQL-backed, and honest
about every status it counts — without pretending it is wired to a trigger it does not yet have.

## 2. The shape of the fix, and what is rejected

**One sentence.** Fix the drain's rollback-safety grain to per-Company (enumerate the Org's Companies,
assert each), implement the missing `listActiveAttempts` SQL, cover the untested drain statuses, and
decide the `E10-1-drain` promotion on whether an honest `drainAll` trigger fits — it does not, so it
defers to REL-005 while the two correctness fixes land unconditionally.

**Rejected — compose `createDistributedExecutionDrain` in `index.ts` to satisfy the caller-count
checker, without a real `drainAll` trigger.** This is the programme's central anti-pattern: caller
count is necessary but not sufficient (`check-gate-clause-wiring.mjs:56-64`), and a constructed-but-
never-invoked drain is a **vacuous green** — "a check that nothing runs is not a check". The register
exists to make exactly this impossible in spirit even where the mechanical count cannot see it. If we
cannot prove `drainAll` is *reached* (§7 M4), we do **not** compose it in production (§4).

**Rejected — keep the org-grain `assertRollbackSafe` and "just fix the receipt query to be
org-scoped".** That would re-derive a second notion of rollback-safety parallel to the three bridges,
the precise divergence hazard `canary-preflight-store.ts:9-14` warns against. The bridges own the
"is a receipt pending for this Company" authority; the drain must **reuse** it per-Company, not fork it.

**Rejected — a bulk `UPDATE … SET status='cancelled'` teardown.** The drain deliberately cancels
one-by-one through the **fence-revoking** `requestCancellation` (`job-distributed-drain.ts:8-10`) so a
late worker result for a revoked fence is rejected `stale_fence` by the guarded mutators. A bulk update
would erase the fence contract and strand in-flight workers. Unchanged here.

**Rejected — implement `listActiveAttempts` with `FOR UPDATE SKIP LOCKED` "to mirror the reaper".**
`MIG-005-cutover-design.md` §3.2(2) suggested this; it is safe but wrong-shaped here. The reaper locks
*and mutates* in one pass; the drain **enumerates, then cancels in a separate short transaction per
job** (`requestCancellation` takes its own `FOR UPDATE` on job+lease, `job-control.ts:3236-3241`).
Holding `FOR UPDATE` across the whole cancel loop would be a long-lived lock over the fleet. So
`listActiveAttempts` is a **plain tenant-scoped read** (§3.2); the concurrency safety lives in
`requestCancellation` + its idempotency, and a row that turns terminal between read and cancel returns
`job_terminal`/`not_found` (excluded from `DRAINED_STATUSES`) — handled, not raced.

## 3. Architecture

### 3.1 Grain: per-Company rollback-safety (the load-bearing fix)

Change `DistributedExecutionDrainDeps` so the drain resolves **every Company under the Organization**
and asserts rollback-safety **per Company** — reusing the exact primitive `canary-preflight-store.ts`
already ships, and the exact per-Company `assertRollbackSafe` the bridges already implement.

```
DistributedExecutionDrainDeps (changed):
-  assertRollbackSafe(organizationId: string): Promise<void>        // REMOVED — the interface lie
+  listOrganizationCompanyIds(organizationId: string): Promise<readonly string[]>   // reuse canary-preflight-store.ts:41-47
+  assertRollbackSafe(companyId: string): Promise<void>             // the bridges' real per-Company gate

drainAll(), per org, replacing job-distributed-drain.ts:115-128:
  const companyIds = await deps.listOrganizationCompanyIds(organizationId)   // read-only
  try { for (const companyId of companyIds) await deps.assertRollbackSafe(companyId) }
  catch { skip org as "rollback_pending"; continue }                          // ANY pending receipt on ANY Company skips the whole org
```

- **Why this is correct where the org grain is not:** a Company-keyed store is never handed an org id
  (§0.2), and a pending receipt on a *sibling* Company still skips the org (§0.2(2)). It mirrors
  `canary-preflight.ts:128-190`'s own "enumerate the Org's Companies, require each to pass" shape —
  the sibling-Company fail-open is closed the same way the preflight closes it.
- **Enumeration failure fails closed.** If `listOrganizationCompanyIds` throws, treat it like the
  assert throwing — skip the org (a `rollback_pending`/`enumerate_error` skip), never drain an org
  whose Company set we could not read. An Org that resolves to **zero** Companies has no attempts to
  drain anyway (attempts are Company-scoped), so an empty set drains nothing and records a clean
  no-op — not an error.
- **No new authority.** The drain composes the *bridges'* `assertRollbackSafe` (any one is sufficient
  for the `authoritative_cost` receipt; the budget-cost bridge is the canonical one — its receipt is
  the charge a drain must never erase, `job-budget-cost-bridge.ts:36-37`). Reuse, not a fork.

### 3.2 The missing `listActiveAttempts` SQL

Implement it as a drizzle store, kept out of the pure drain module — the same split
`canary-preflight-store.ts` uses so the pure module's fail-first tests never load drizzle (Test
Patterns rule). A tenant-scoped read over `job_attempts`:

```
// server/src/services/job-distributed-drain-store.ts  (new; mirrors canary-preflight-store.ts)
listActiveAttempts(organizationId): Promise<DistributedExecutionActiveAttempt[]>
  = runInTenant(appDb, organizationId, (_repos, tx) =>
      tx.selectDistinct({ organizationId: jobAttempts.organizationId,
                          companyId: jobAttempts.companyId,
                          jobId: jobAttempts.jobId })
        .from(jobAttempts)
        .where(and(eq(jobAttempts.organizationId, organizationId),
                   notInArray(jobAttempts.status, [...TERMINAL_ATTEMPT_STATUSES]))))
```

- **Non-terminal = the complement of `TERMINAL_ATTEMPT_STATUSES`** (`job-fence.ts:63` =
  `succeeded|failed|cancelled|expired`), i.e. `pending|offered|leased|running|cancel_requested` — the
  same live set the cancel path itself keys on (`job-control.ts:3303`). Using `notInArray(TERMINAL…)`
  (rather than an inline positive list) means a future status added to the check constraint
  (`job_attempts.ts:83-86`) is treated as non-terminal by default — fail-safe toward *draining* an
  unknown live state rather than leaving it stranded.
- **`selectDistinct` on `(company_id, job_id)`** — `requestCancellation` is keyed by `jobId` and
  idempotent (`job-control.ts:3306-3312`); deduping by job prevents a second call returning
  `already_requested` (which is in `DRAINED_STATUSES`) and **double-counting** one job as two drains.
  (A job carrying two simultaneously non-terminal attempts should not occur, but the drain must count
  honestly regardless.)
- **Tenant-scoped via `runInTenant`** so the read runs under RLS as the non-owner `aoa_app` role —
  the same context the bridges' `assertRollbackSafe` uses. Plain read, **no `FOR UPDATE`** (§2).
- **Frozen contract untouched.** `job_attempts` is an existing table; this is a read, not a schema
  change — **no migration**, and no `packages/worker-protocol` change (that package is FROZEN).

The return shape is exactly `DistributedExecutionActiveAttempt` (`job-distributed-drain.ts:26-30`),
which `requestCancellation` already consumes — so the store fills the interface instead of lying about
it. `attemptId` is deliberately absent: `requestCancellation` resolves the live attempt from `jobId`
itself (`job-control.ts:3236-3304`), resolving MIG-002's "the row carries no attemptId" note.

### 3.3 Cover the untested drain statuses

`DRAINED_STATUSES` (`job-distributed-drain.ts:75-80`) counts `queued`, `already_requested`,
`cancelled`, `no_active_lease`; the unit suite exercises only the first two. Add cases so:

- a `requestCancellation` → `"cancelled"` outcome **counts** as drained (§0.5 — the unleased-attempt
  direct-finalize path, a real terminal cancel),
- a `"no_active_lease"` outcome **counts**,
- a `"job_terminal"` outcome does **NOT** count (mirrors the already-tested `not_found`).

This closes the "guard that passed because it evaluated nothing" class for every member of the set.

## 4. ★ The `E10-1-drain` promotion decision — HONEST (review-concern #2)

**Decision: DEFER the promotion to REL-005. `E10-1-drain` STAYS `unwired`.** The two correctness
fixes (§3.1 grain, §3.2 SQL) and the status coverage (§3.3) land **unconditionally** and are proven by
tests that construct the drain directly. But promoting the clause to `wired` requires an *honest*
`drainAll` invocation — a real production caller that reaches `drainAll` (§7 M4) — and no such trigger
fits inside this ticket:

1. **There is no admin/ops teardown surface to host it.** The drain's own header describes the trigger
   as a "teardown/admin trigger" (`job-distributed-drain.ts:16-18`), and the go-book parks that write
   path in REL-005 explicitly: *"Kill switch has no write path … throwing it means hand-executed SQL …
   REL-005 scope"* (§5 debt table), echoed in the `E11-5-provider-kill-switch` wiring reason
   (`gate-clause-wiring.json`). Building an operator-invocable teardown op is REL-005's job, not a
   correctness ticket's.
2. **The only composable seams are the wrong triggers.** Attaching `drainAll` to boot, to graceful
   shutdown (SIGTERM), or to the convergence sweeper would cancel in-flight distributed work on every
   *routine* restart/sweep — the opposite of a teardown lever, and a data-loss hazard. A drain must
   fire on *deliberate rollback*, which is precisely the operator write path REL-005 owns.
3. **Composing without invoking would be a vacuous green.** A bare `createDistributedExecutionDrain(...)`
   in `index.ts` flips the caller count to ≥1 and the mechanical checker would *demand* `wired`
   (`unwired_but_now_has_caller`) — but nothing would call `drainAll`. That is the exact defect §2
   rejects. So this ticket does **not** add that reference; the count stays 0 and the clause stays
   honestly `unwired`.

**What lands on the register:** `E10-1-drain` `reason` is updated to state that the grain and SQL
defects are **fixed and proven at embedded-PG**, the drain is **correct when wired**, and the
remaining work is a single `drainAll` **invocation** owed to **REL-005** (the kill-switch/teardown
write path). The `status` stays `unwired`; the checker stays green because the count is 0 and a reason
is present. This is `MIG-005-cutover-design.md` §10 R3's own stated fallback, taken as the decision.

**Acceptance is written to accept EITHER outcome (§8) so it cannot go vacuously green.** If a future
reader disagrees and a clean, M4-provable trigger *does* fit at execution (Step 0 re-checks
`index.ts`), the promote branch is available: compose behind the flag, expose a real teardown
invocation, prove `drainAll` is reached (E4/M4), flip to `wired`. This ticket, at tip, takes DEFER.

## 5. Files

| Action | Path | Why |
|---|---|---|
| modify | `server/src/services/job-distributed-drain.ts` | per-Company grain: add `listOrganizationCompanyIds` to `DrainDeps`, re-type `assertRollbackSafe(companyId)`, replace the per-org assert loop (`:115-128`) with per-Company enumeration (§3.1). No interface lie. |
| create | `server/src/services/job-distributed-drain-store.ts` | the drizzle `listActiveAttempts` SQL + a re-export of `listOrganizationCompanyIds` (reuse `canary-preflight-store.ts:41-47`), kept out of the pure module (§3.2) |
| modify | `server/src/__tests__/job-distributed-drain.test.ts` | **review-concern #1 — reworked beyond the `cancelled` case.** Every dep object gains `listOrganizationCompanyIds`; test 2's skip is re-keyed from an org id to a **Company** id under the org; add the `cancelled` / `no_active_lease` / `job_terminal` cases (§3.3). The old injected shape is gone. |
| create | `server/src/__tests__/job-distributed-drain.integration.test.ts` | embedded-PG proof of the grain fix (E1) + real `listActiveAttempts` rows (E2), through the real store (§6). Windows: `AOA_RUN_WIN_INTEGRATION=1` prefix — not optional. |
| modify | `scripts/gate-clause-wiring.json` | `E10-1-drain` **stays `unwired`**; `reason` updated to "grain + SQL fixed & proven; `drainAll` trigger owed to REL-005" (§4). No `status` flip, no `expectedReferences`. |

**No migration** (`listActiveAttempts` is a read). **No `packages/worker-protocol` change** (FROZEN;
the drain + store are server-side). **No new `AOA_*` switch.** `index.ts` is **not** modified (§4 —
composing the drain without a `drainAll` trigger is the rejected vacuous green).

## 6. Fail-first TDD steps — one action each, RED before GREEN

Every step: write the failing test → **run it, watch it fail for the stated reason** → minimal
implementation → run it, watch it pass → commit. *A RED that does not fail for the reason written down
proved nothing; stop and find out why.* The embedded-PG suite is
`describe.skipIf(win32 && AOA_RUN_WIN_INTEGRATION !== "1")` — **the prefix is not optional**, or Steps
4–5 report skipped-as-green and sign off against a run that evaluated nothing.

**Step 0 — re-verify §0 at tip.** Re-read every cited line; re-confirm the grain trace (§0.2), the
`job-distributed-drain.test.ts` dep shape (§0.3), the `TERMINAL_ATTEMPT_STATUSES` set and
`job_attempts` check constraint (§3.2), and re-confirm — not re-open — the `cancelled` semantics
(§0.5). Re-check `index.ts` for any honest teardown site that would flip §4 from DEFER to promote; if
none (expected), DEFER stands. If E10-F001's premise has moved (a sink cutover has since landed), the
drain is still sink-agnostic and unaffected — proceed.

**Step 1 — the grain fix, POSITIVE CONTROL first (unit).** Rework `job-distributed-drain.test.ts` to
the new dep shape. First prove the drain still *drains* a clean org: `listOrganizationCompanyIds`
returns the Companies whose attempts `listActiveAttempts` yields, `assertRollbackSafe` is a no-op →
the clean org's attempts cancel and count. RED: the new required `listOrganizationCompanyIds` is
absent from `DrainDeps` (compile) / the loop still calls `assertRollbackSafe(organizationId)`. GREEN:
§3.1. This is the positive control — if a clean org cannot drain, every "skip" assertion below is
vacuous.

**Step 2 — the per-Company skip (unit).** An org with two Companies, `assertRollbackSafe` throws for
**Company B only** → the whole org is skipped `rollback_pending`, cancels nothing; and a *different*
org with all-clean Companies still drains. Anti-vacuity: the skip must be triggered by the sibling
Company, not the first — or M-sibling and M-grain collapse.

**Step 3 — the untested statuses (unit).** `requestCancellation` returning `cancelled` and
`no_active_lease` each **count**; `job_terminal` does **not** (§3.3). RED before GREEN on the set
membership.

**Step 4 — `listActiveAttempts` SQL, RED at embedded-PG.** Seed (via the tenant repos) non-terminal +
terminal attempts across **two Companies under one org**; drive the *real* store. RED: with the store
unimplemented the enumerator returns `[]` and the drain cancels nothing. GREEN: the §3.2 SQL. Assert it
returns exactly the non-terminal rows, deduped by job, shaped `{organizationId, companyId, jobId}`.

**Step 5 — grain + SQL end-to-end (embedded-PG, E1/E2).** One org, two Companies, one holding a
pending `authoritative_cost` receipt (through the real budget-cost bridge's `assertRollbackSafe`): the
drain skips the whole org and cancels nothing; positive control — clear the receipt and the same org
drains its non-terminal attempts; terminal-only org drains zero and reports a clean sweep (not an
error). This is the real rollback-path evidence GATE clause 3's in-flight strand needs
(`GATE-clause-3-rollback-result.md` §6 limit 2) — unit/integration, **not** a live arm-and-revert
rehearsal (that is the Wave-4 cutover rehearsal, §9).

**Step 6 — the mutation sweep (§7), positive control first.**

**Step 7 — docs + register.** Update `E10-1-drain`'s `reason` (stay `unwired`, §4). Result doc. If Step
0 flipped §4 to promote, this is where the `index.ts` compose + `drainAll` trigger + the register flip
land, with M4 proving the caller is reached — otherwise the register is untouched but for the reason.

```bash
pnpm --filter @armyofagents/server test:run -- src/__tests__/job-distributed-drain.test.ts
AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server test:run -- src/__tests__/job-distributed-drain.integration.test.ts
pnpm --filter @armyofagents/server typecheck && pnpm --filter @armyofagents/server build
node scripts/check-gate-clause-wiring.mjs && node scripts/check-finding-ownership.mjs && node scripts/check-guard-inventory.mjs
```

## 7. Mutation table — DELETE each guard, positive control FIRST

Rules (all from real incidents): **positive control first** (break the function outright; if the suite
still passes it exercises nothing); **DELETE a guard, never rewrite it to an equivalent** (`return
false && x` measures nothing); **a surviving mutant is a question, not a verdict** (prove equivalence
by deleting both the guard and its backstop and showing the suite then fails).

| # | Mutant (a DELETION) | Must redden | Why it is not equivalent |
|---|---|---|---|
| M0 | positive control — `drainAll` cancels nothing (short-circuit the per-attempt cancel) | Step 1 clean-org drains | if a clean org cannot drain, every skip/grain test below is vacuous |
| M-grain | revert §3.1 to a single per-org `assertRollbackSafe(organizationId)` call | Step 1 / Step 5 **positive control** (clean org drains) | against the real bridge the org id fails Company→Org resolution and **throws** (§0.2) → every org is skipped → the **clean org stops draining**. NB: this reddens via the positive control, **not** via a "drains unsafely" assertion — that fail-open framing is false (§0.2); do not write the kill that way |
| M-sibling | enumerate only the first Company instead of all `listOrganizationCompanyIds` | Step 2 | the genuine fail-open (§0.2(2)): a pending receipt on a **sibling** Company is missed and the org drains unsafely — mirrors `canary-preflight.ts:20-26` |
| M-enum-throw | swallow a `listOrganizationCompanyIds` throw and drain the org anyway | Step 2 variant | enumeration failure must fail **closed** (skip), never drain an org whose Company set is unknown |
| M-SQL | `listActiveAttempts` returns `[]` | Step 4 | proves the SQL is load-bearing, not a still-empty interface (the §0.1 lie) |
| M-terminal | drop `notInArray(TERMINAL_ATTEMPT_STATUSES)` from the SQL (select all statuses) | Step 4 | proves terminal attempts are excluded — otherwise the drain "cancels" already-terminal work and mis-counts |
| M-cancelled | drop `"cancelled"` (and separately `"no_active_lease"`) from `DRAINED_STATUSES` | Step 3 | pins the two counted-but-untested statuses (§0.5) |
| M-notfound | add `"not_found"`/`"job_terminal"` **into** `DRAINED_STATUSES` | Step 3 negative | proves excluded outcomes stay excluded (a terminal/absent job is not a drain) |
| M4 | *(promote branch only)* no-op the composed `drainAll` caller in `index.ts` | E4 | proves `E10-1-drain`'s promotion is a real caller **reaching** `drainAll`, not a caller-count fiction. **Absent in the DEFER branch** — there is no production caller to mutate, which is exactly why the clause stays `unwired` |

## 8. Acceptance mapping — every clause → a test that can turn RED; a real caller counted

| Acceptance clause | Test that can redden | Caller / counter check |
|---|---|---|
| A clean org drains its non-terminal attempts | Step 1 + M0 | the drain's per-attempt cancel is the real caller of `requestCancellation` |
| An org with a pending receipt on **any** Company is skipped whole | Step 2 + Step 5 (E1) + M-sibling | the fixed `assertRollbackSafe` is called **per Company** (§3.1); M-grain proves the org-grain revert breaks the clean-org control, M-sibling proves the sibling fail-open is closed |
| `listActiveAttempts` returns exactly the non-terminal attempts for an org, deduped by job | Step 4 (E2) + M-SQL + M-terminal | the real store is called by `drainAll` |
| `cancelled` + `no_active_lease` count; `job_terminal`/`not_found` do not | Step 3 + M-cancelled + M-notfound | — |
| Enumeration failure fails closed | Step 2 variant + M-enum-throw | — |
| **`E10-1-drain` is honest on the register — EITHER `wired` on an M4-proven `drainAll` caller, OR `unwired` with a reason naming the shipped fixes + the REL-005-owed trigger** | `check-gate-clause-wiring.mjs` green; in the DEFER branch the caller count for `createDistributedExecutionDrain` is **0** (asserted by `--counts`), so `unwired` is the *only* green state; in the promote branch M4 forces the caller to reach `drainAll` | **this ticket takes DEFER (§4): count = 0, status `unwired`, reason updated.** The clause cannot go vacuously green — a bare compose would flip the count to ≥1 and the checker would demand `wired`, which without an M4-proven `drainAll` is a fail |

**No clause here is satisfiable by a function nothing calls.** The grain and SQL clauses have callers
inside the drain's own suite; the register clause is satisfied by the checker reading a **count of 0**
in the DEFER branch (honest dormancy) — never by a caveat in a `reason` field, which the checker does
not read.

## 9. Non-goals, named with owners

| Not delivered | Owner | Why |
|---|---|---|
| A production `drainAll` **trigger** (admin teardown op / kill-switch write path) | **REL-005** | §4 — no honest trigger fits here; the operator write path is REL-005 scope (go-book §5 "Kill switch has no write path"). The drain is *correct when wired*; the trigger is owed |
| Any execution-sink cutover (`commander_turn` / `crew_run` / `one_shot` going active) | the shared-prerequisite tickets + per-sink successors (E10-F001) | E10-F001 — no sink is buildable today; the drain is sink-agnostic and independent of all of it |
| A credential / mint / `provider_connection` path | n/a | the drain cancels attempts; it never *creates* one, so it needs no credential (§0 banner) |
| A **runtime toggle** that drains without a restart | documented follow-up | `job-distributed-drain.ts:16-18` — disable stays env+restart-driven; a hot toggle is out of scope |
| A **live** arm-roll-back-confirm rehearsal | Wave-4 cutover rehearsal | `GATE-clause-3-rollback-result.md` §6 limit 4 — §5's evidence is unit/integration, not a staged revert |
| The `#### MIG-009` graph node + the go-book Sprint-6 prompt | a later wiring step (per the sprint brief) | this ticket writes only the design file |
| Promoting the E3 parity bridges (`jobApprovalBridge` / `jobBudgetCostBridge` / `jobOutputBridge` / `jobAuditBridge`) or the E3-18 revocation fanout | their own successors (see `MIG-005-cutover-design.md` §3.3, §0.6) | zero-caller on any legacy path; promoting them here would be false wiring — orthogonal to the drain |

## 10. Risks

**R1 — the grain fix touches a Wave-3/CLI-005 service.** `job-distributed-drain.ts` is E3/CLI-005
infrastructure. The change is additive (per-Company enumeration) and the org-heartbeat canary is its
only live producer, so the blast radius is the rollback path alone — and the drain has **zero
production callers**, so nothing in a shipped boot changes at all. Mutations M-grain/M-sibling pin the
fix.

**R2 — the existing unit tests break, by design (review-concern #1).** The grain change alters
`DrainDeps` (adds `listOrganizationCompanyIds`, re-types `assertRollbackSafe` to per-Company), so
`job-distributed-drain.test.ts`'s injected dep shape is **invalid** and every one of its five cases
needs rework — a new required member on each dep object and test 2's skip re-keyed from an org id to a
Company id (§0.3, §5). **This corrects `MIG-005-cutover-design.md` §10 R2's claim that "the pre-existing
mocks stay valid".** The rework is scoped in Step 1–3, not an afterthought; treat a test that still
compiles against the old shape as a sign the grain was not actually changed.

**R3 — the DEFER decision is mistaken for "the drain doesn't work".** It works when wired — the fixes
are proven at embedded-PG (§5). What is deferred is the *trigger*, not the correctness. The register
`reason` and the result doc must say this in one line so no one re-scopes REL-005's write path onto a
"broken drain" premise.

**R4 — the `cancelled` semantics.** Getting this wrong wires a drain that reports a clean sweep while
stranding work — the exact failure the lever exists to prevent. §0.5 answers it from the code
(`job-control.ts:3247-3281`); Step 0 re-confirms, Step 3 pins it either way.

**R5 — a later reader adds the vacuous compose.** If someone composes `createDistributedExecutionDrain`
in `index.ts` "to promote the clause" without a `drainAll` trigger, the caller count flips to ≥1 and
`check-gate-clause-wiring.mjs` demands `wired` — which, with no M4-proven `drainAll`, is a fail they
must then either back out or complete honestly (the promote branch, §4/§8). The checker turns the
temptation into a forcing function, which is the intent.

## 11. Rollback, and what this deliberately does not do

**Rollback of MIG-009 itself.** The drain remains **zero-caller in production** (DEFER, §4), so
reverting this ticket removes only test-proven correctness — strictly safer than the current state,
in which the drain is an interface lie that would fail closed (cancel nothing) if naively wired. No
migration to reverse (`listActiveAttempts` is a read). The register returns to the prior `E10-1-drain`
`reason`. No `packages/worker-protocol` change to unwind (FROZEN).

**What this design deliberately does not do:**

1. It does **not** compose or invoke the drain in production — the trigger is REL-005's (§4, §9).
2. It does **not** cut over any execution sink or touch a credential path (E10-F001; §0 banner, §9).
3. It does **not** promote `E10-1-drain` to `wired` — it stays honestly `unwired` with an updated
   reason (§4).
4. It does **not** claim a live rollback rehearsal — the evidence is unit/integration (§5, §9).
5. It does **not** add the `#### MIG-009` graph node or the go-book prompt (a later step; §9).
6. It does **not** repeat `MIG-005-cutover-design.md` §4's "fails open" mechanism or §10 R2's
   "mocks stay valid" claim — both are corrected here against the code (§0.2, §0.3, §10 R2).

**Open items for Step 0** (the house re-verify rule): re-confirm the grain trace and the bridge
resolution order (§0.2); re-confirm the `job-distributed-drain.test.ts` dep shape before reworking it
(§0.3); re-confirm — not re-open — the `cancelled` status semantics (§0.5); and a final check of
`index.ts` for any honest `drainAll` teardown site that would flip §4 from DEFER to promote (none
expected at tip).
