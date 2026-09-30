# MIG-009 — Result: the distributed-execution drain — rollback-safe teardown

**Status:** SHIPPED (Sprint 6 first unit). **Design Start SHA:** `37b4ff2c2`. **Code:** `65bbb8a3b`
(Steps 1-3) + `5f9de3e7d` (Steps 4-5) + this result-doc commit. **Branch:** `docs/replatform-program`
(`C:\e3`). **Verified at tip `bc2b2fcf4`.**

This ticket made the flag-disable rollback drain **correct when wired** — grain-safe, SQL-backed, and
honest about every status it counts — **without** pretending it is wired to a trigger it does not yet
have. It cuts over **no** execution sink and touches **no** credential path (E10-F001; the drain is
sink-agnostic). `E10-1-drain` stays honestly **`unwired`**.

---

## 0. Step-0 re-verification (all ~25 citations re-read at tip `bc2b2fcf4`)

The design's `path:line` citations were re-verified against source before any code. Everything held;
the three ★-banner precision fixes were confirmed and applied:

- **(a) M-grain reddens only in the REAL bridge lane, not the unit lane.** Confirmed: the unit
  `assertRollbackSafe` is a `vi.fn` no-op that does not throw on an org id, so reverting to a per-org
  `assertRollbackSafe(organizationId)` still lets the unit clean-org drain. M-grain's honest kill is
  the **Step-5 positive control** ("clean org stops draining") against the real budget-cost bridge,
  where an org id resolves no Company→Org edge and **throws** (`resolveCompanyOrganizationId` → `null`
  → `assertAdmissibleMappedOrganization(null)` → `TenantAdmissionDeniedError`). The design's §0.2
  correction is right: the grain bug fails **CLOSED** (a dead cancel-nothing lever), not "fails open".
- **(b) The store's RLS `runInTenant` pattern comes from the bridges, not `canary-preflight-store`.**
  Confirmed: `canary-preflight-store.ts` reads `companies` on the plain `appDb` (no RLS on `companies`;
  `aoa_app` holds SELECT, migrations 0213/0214) and the production canary store is built with `appDb`.
  The `runInTenant(appDb, org, …)` pattern is the bridge's `assertRollbackSafe` (`job-budget-cost-bridge.ts`).
  The store therefore uses `runInTenant` for `listActiveAttempts` and reuses the canary primitive
  (plain-`appDb` read) for `listOrganizationCompanyIds`.
- **(c) Citation drift.** At this tip `TERMINAL_ATTEMPT_STATUSES` is `job-fence.ts:63` (= the design
  body, not the banner's `:60`) and `requestCancellation` starts at
  `packages/db/src/repositories/tenant/job-control.ts:3207`. Cited by symbol, not line, per the binding rule.

**DEFER re-check (§4).** `index.ts` has **zero** references to `createDistributedExecutionDrain` /
`drainAll` / `DistributedExecutionDrain` — no honest teardown site exists at tip → **DEFER stands**.
**E10-F001 re-check.** No sink cutover has landed; the drain is sink-agnostic and unaffected.

`test`-tsconfig note: `server/tsconfig.json` excludes `src/__tests__`, so tests are **not**
type-checked. Step 1's RED was therefore **behavioral** (the sibling-skip + fails-closed cases fail
against the pre-grain drain), not a compile error.

---

## 1. The three unconditional correctness fixes (all landed)

### 1.1 GRAIN — per-Company rollback safety (load-bearing)
`DistributedExecutionDrainDeps` gained a required `listOrganizationCompanyIds(organizationId)` and
`assertRollbackSafe` was re-typed from `(organizationId)` to `(companyId)`. `drainAll` now resolves
**every Company** under the org and asserts rollback-safety **per Company** (two separate guards):
- an **unreadable Company set** fails **CLOSED** (`enumerate_companies_error` skip, never a drain);
- a **pending authoritative-cost receipt on ANY Company** — including a **sibling** of an attempt's own
  Company — refuses the **whole** org (`rollback_pending` skip).

This closes the sibling-Company fail-open (`canary-preflight.ts`'s own hazard) and removes the
interface lie (the org-typed dep with only Company-typed impls that failed closed against the bridges).
`listOrganizationCompanyIds` **reuses the canary-preflight primitive by reference** — no re-implementation,
no divergence.

### 1.2 SQL — the missing `listActiveAttempts` store
New file `server/src/services/job-distributed-drain-store.ts`: a tenant-scoped read over `job_attempts`
under `runInTenant` (RLS as `aoa_app`), `selectDistinct(company_id, job_id)` (dedup by job — a job with
two live attempts is cancelled once), `notInArray(TERMINAL_ATTEMPT_STATUSES)` (the complement of the
terminal set, so a status later added to the check constraint is treated as non-terminal by default —
fail-safe toward draining an unknown live state), **no `FOR UPDATE`** (`requestCancellation` takes its
own per-job lock; holding a lock across the cancel loop would be a fleet-wide long-lived lock). A read —
**no migration**, **no `packages/worker-protocol` change** (FROZEN).

### 1.3 Status coverage
The two counted-but-untested `DRAINED_STATUSES` members (`cancelled` — the real unleased-attempt
direct-finalize terminal cancel; `no_active_lease`) are now asserted to **count**, and `job_terminal` /
`not_found` asserted **not** to count. The unit status test feeds all six `CancellationStatus` members
and asserts exactly four drained — exhaustive over the union.

---

## 2. Mutation sweep — 8 mutants, all killed by DELETION, positive control first

Every guard was mutation-tested by **deletion** (never a rewrite-to-equivalent), each mutant restored
via `git checkout --` (tree verified clean afterward). Positive control (M0) first.

| # | Mutant (a DELETION) | Reddened | Lane |
|---|---|---|---|
| **M0** | delete the drained-count increment (drain counts nothing) | positive control ("clean org drains") + every cancelled-count assertion (5/7 unit) | unit |
| **M-sibling** | `for (…companyIds)` → `companyIds.slice(0, 1)` (check only the first Company) | sibling-skip test + the per-Company-order assertion | unit |
| **M-enum-throw** | delete the Company-enumeration guard (a `listOrganizationCompanyIds` throw no longer skips) | the "FAILS CLOSED" test (drainAll rejects) | unit |
| **M-cancelled** | drop `"cancelled"` — then, separately, `"no_active_lease"` — from `DRAINED_STATUSES` | the status test (count 4→3) | unit |
| **M-notfound** | add `"not_found"` INTO `DRAINED_STATUSES` | the status test (count 4→5) | unit |
| **M-grain** | revert to a single per-org `assertRollbackSafe(organizationId)` | Step-5 **positive control** ("clean org stops draining" — the real bridge throws on the org id) + the terminal-only sweep | embedded-PG |
| **M-SQL** | `listActiveAttempts` returns `[]` | Step 4 (0 rows) + Step-5 positive control (0 cancelled) | embedded-PG |
| **M-terminal** | drop `notInArray(TERMINAL_ATTEMPT_STATUSES)` (select all statuses) | Step 4 (terminal rows leak) + the terminal-only sweep | embedded-PG |

**M-grain reddens via the positive control, never a "drains unsafely" assertion** — that fail-open
framing is false (§0.2). Under M-grain the sibling-skip test still passes (M-grain skips everything),
which is precisely why the honest kill is the positive control. **M4 (promote-branch only) is N/A** —
the DEFER branch has **no** production `drainAll` caller to mutate. That absence is exactly why
`E10-1-drain` stays honestly `unwired`, not a gap in coverage.

A **9th guard** landed from the adversarial review (§7): the `enumerate_error` skip now records the org
in `skippedOrganizations`. It is mutation-proven by its own RED→GREEN cycle — the test was written and
run RED (the push absent = the pre-fix state = the deletion mutant) before the one-line fix.

---

## 3. The `E10-1-drain` promotion decision — DEFER (honest)

`E10-1-drain` **stays `unwired`, count 0**, reason rewritten. The two correctness fixes + status
coverage land **unconditionally** (proven by tests that construct the drain directly / drive the real
store + real bridge). Promoting to `wired` requires an **honest `drainAll` invocation** — a real
operator teardown / kill-switch write path — and **no such trigger fits this ticket**:

- There is no admin/ops teardown surface to host it; that write path is **REL-005** scope (go-book §5
  "Kill switch has no write path").
- The only composable seams (boot, SIGTERM, the convergence sweeper) are the **wrong** triggers — they
  would cancel in-flight distributed work on every routine restart/sweep.
- Composing `createDistributedExecutionDrain` in `index.ts` **without** a `drainAll` trigger would flip
  the caller count to ≥1 and force a **vacuous `wired`** — the exact anti-pattern the register exists to
  catch. So `index.ts` is **not** touched; the count stays 0 and the clause stays honestly `unwired`.

Acceptance accepts **either** outcome, so it cannot go vacuously green: in the DEFER branch the only
green state is `unwired` with count 0; a bare compose would flip the count and the checker would demand
`wired`, which without an M4-proven `drainAll` is a fail. **This ticket takes DEFER.**

---

## 4. Reworked tests (review-concern #1)

The grain fix changed `DrainDeps` (new required `listOrganizationCompanyIds`; `assertRollbackSafe`
re-keyed org→Company), so **all five** pre-existing `job-distributed-drain.test.ts` cases were reworked —
this was **not** just the `cancelled` case. Test 2's skip was re-keyed from an org id to a **sibling**
Company id (the throw is on the second-listed Company, so it distinguishes "check every Company" from
"check only the first"). New cases: the per-Company-order assertion, the fails-closed enumeration case,
and the exhaustive status case. The old injected 4-dep shape is gone. This corrects
`MIG-005-cutover-design.md` §10 R2's claim that "the pre-existing mocks stay valid".

A new embedded-PG suite `job-distributed-drain.integration.test.ts` (`describe.skipIf` on Windows unless
`AOA_RUN_WIN_INTEGRATION=1`) proves the store SQL (exactly the non-terminal attempts, deduped by job)
and the grain end-to-end through the **real** budget-cost bridge (sibling-Company receipt skips the
whole org; clearing it lets the same org drain — the positive control; terminal-only org drains zero as
a clean sweep).

---

## 5. Files

| Action | Path |
|---|---|
| modify | `server/src/services/job-distributed-drain.ts` (per-Company grain; `DrainDeps` change) |
| create | `server/src/services/job-distributed-drain-store.ts` (`listActiveAttempts` SQL + `listOrganizationCompanyIds` reuse) |
| modify | `server/src/__tests__/job-distributed-drain.test.ts` (all five reworked + new cases) |
| create | `server/src/__tests__/job-distributed-drain.integration.test.ts` (embedded-PG grain + SQL proof) |
| modify | `scripts/gate-clause-wiring.json` (`E10-1-drain` reason; stays `unwired`, count 0) |
| modify | `docs/replatform/GO-BOOK.md` (§3.1 row, §4 Sprint 6), `…/E10-.../findings.md` (E10-F001), this result doc |

**No migration. No `packages/worker-protocol` change. No new `AOA_*` switch. `index.ts` not touched.**

---

## 6. Verification

- Unit: `job-distributed-drain.test.ts` — **7/7 pass**.
- Embedded-PG: `AOA_RUN_WIN_INTEGRATION=1 … job-distributed-drain.integration.test.ts` — **5/5 pass**.
- `pnpm --filter @armyofagents/server typecheck` / `lint` / `build` — clean.
- All five registers green: `check-gate-clause-wiring` (E10-1-drain dormant, count 0),
  `check-finding-ownership`, `check-ticket-graph-coverage`, `check-guard-inventory`,
  `check-execution-census`.
- CI: `verify` is the 4-shard matrix (§2.0 RESOLVED); `ci-required` expected PASS.

---

## 7. Adversarial review (of the IMPLEMENTATION)

Three independent subagents reviewed the shipped code (not the design — the design had its own pass):
a **source reviewer** (grain + SQL from source), a **refutation skeptic** ("can the drain still
cancel-nothing or drain-unsafely?"), and a **completeness critic** (do the reworked tests exercise the
new dep shape?). **Verdict: 0 CRITICAL / 0 HIGH. The correctness fixes are implemented correctly, the
claim was NOT REFUTED, and test coverage is complete.**

- **Skeptic — NOT REFUTED.** All five attack angles closed with source evidence: (1) a clean admitted
  org is never skipped (companies came from `WHERE organization_id = org`, so each resolves back to the
  same admitted org — `assertAdmissibleMappedOrganization` never throws for it); (2) a committed charge
  is structurally un-erasable — `requestCancellation` only UPDATEs status, never deletes a `cost_events`
  row or its receipt, and the attempt is UPDATEd to `cancelled` (not deleted), so the receipt→attempt
  cascade FK never fires; (3) no non-terminal attempt is missed and no terminal one included; (4) the
  `runInTenant` read is org-bound and forced-RLS, so it cannot surface the wrong tenant's rows and a
  GUC/role failure throws→skips (fail-closed); (5) the dropped `FOR UPDATE` is safe (races resolve to
  `job_terminal`/`no_active_lease`, both excluded; a new attempt after disable is impossible).
- **Completeness — coverage complete, no gaps.** Every unit test constructs the new dep shape; the
  sibling-skip is keyed on the SECOND-listed Company (distinguishes "check every" from "check first");
  fail-closed enumeration is tested; the status test is exhaustive over all six `CancellationStatus`
  members; the integration positive control is real (traced the real-bridge throw on an org id). One
  non-gap note: the integration sibling test's "which company is first" is heap-order (the canary
  `SELECT` has no `ORDER BY`), so the *deterministic* every-Company discrimination correctly rests on
  the unit sibling test, which orders `[CO_A1, CO_A2]` explicitly and throws on the sibling.
- **Source reviewer — 3 items, all handled** (commit `742172ed2`):
  - **LOW (fixed):** the pre-existing `enumerate_error` skip path recorded the org only in
    `perOrganization`, not `skippedOrganizations` — inconsistent with the two new skip paths, and
    untested. Now pushes to BOTH, with a new unit test (RED→GREEN is the guard's mutation proof).
  - **MEDIUM (documented — a framing clarification, not a bug):** the rollback-pending gate is
    currently **forward-looking**. The live budget-cost bridge writes `authoritative_cost` receipts
    `applied` atomically (`job-budget-cost-bridge.ts:281`), so no durable `pending` window exists in
    production today and `assertRollbackSafe` never throws on the real path. The grain fix's immediate
    production value is eliminating the **org-keyed dead lever** (the pre-fix drain would throw at
    Company→Org resolution and cancel nothing on every run — pinned by the Step-5 positive control);
    today a committed charge is un-erasable by atomicity + non-deleting cancellation regardless. The
    gate becomes load-bearing if a two-phase pending→applied authoritative-cost projection is ever
    introduced. The integration test seeds a `pending` receipt directly to prove the gate's invariant.
    **Both the skeptic and the source reviewer converged on this independently.** A `★` note is now in
    the drain module header so no future reader mistakes "the gate holds the fail-open closed" for the
    actual mechanism (atomicity).
  - **INFORMATIONAL (documented for REL-005):** the drain's `requestCancellation` dep is deliberately
    narrower than the repo's `RequestCancellationInput` (omits `commandId`/`now`). The dep shape is
    intentionally NOT changed; a dep comment now records that the REL-005 wiring adapter must supply a
    STABLE `commandId` derived from the jobId for idempotent re-runs (a per-call random id would queue
    duplicate cancels). This is the one open handoff for the deferred `drainAll` wiring.

No finding invalidated the ticket's premise. The grain fix, the SQL, and the DEFER decision all stand.

---

## 8. What this deliberately does NOT do

1. Does **not** compose or invoke the drain in production — the `drainAll` trigger is REL-005's.
2. Does **not** cut over any execution sink or touch a credential path (E10-F001; the drain is sink-agnostic).
3. Does **not** promote `E10-1-drain` to `wired` — it stays honestly `unwired` (count 0) with an updated reason.
4. Does **not** claim a live rollback rehearsal — the evidence is unit/integration (a staged arm-revert is Wave-4).
5. Does **not** add the `#### MIG-009` graph node (it already exists) or a new go-book prompt.
