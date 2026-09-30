# BRW-003a — Split `findCommitted` — RESULT

**Epic:** E8 · **Lane:** B · **Start SHA:** `1e77db72c` (design) · **Tip:** `310fa9ac3`
**Status:** **COMPLETE — CI-VALIDATED.** `310fa9ac3` is an ancestor of the green run
`e2d9d0cbd` (run conclusion `success`, no failed jobs).
**Design:** [`BRW-003a-design.md`](./BRW-003a-design.md) · **Index:** [`BRW-003-design.md`](./BRW-003-design.md)

---

## 1. What shipped

`findCommitted` filtered `status='committed'` and served two callers that want **opposite**
answers — `artifact-transfer-grant.ts:111` ("did this identity EVER commit?", where expired must
count) and `:149` ("is it still readable?", where it must not). No status value satisfies both.

Now one shared predicate, two names that carry the question. Callers never handle a status set:
the original defect was call sites having to know the predicate meant two different things, and a
status parameter would have relocated that rather than fixed it.

**2 files. No schema, no migration.** The expired partial unique moved to 003c during
plan-eng-review, because there a uniqueness violation is constructible and here the only possible
assertion was *does the index exist*.

## 2. ★ Fail-first taught me something I would otherwise have broken

Of three behavioural tests written **before any implementation**, only **one** went red — the
upload guard, returning `upload_granted` for an already-committed-then-expired identity. The two
download tests were **already green**, because `findCommitted`'s filter already excludes expired.

Had the code come first, I might well have "fixed" the download path too and broken correct
behaviour. The red state also **demonstrates** the re-grant hole rather than arguing it.

## 3. Mutation testing — three killed, one FALSE kill caught

| Mutant | Result |
|---|---|
| immutability query excludes `expired` | **killed** — the re-grant hole reopens |
| download query includes `expired` | **killed** — a grant for deleted bytes |
| collapse to a single `IN` query | **killed by the query-count test alone**, 20 others passing |

The third is the informative one: the mutant is **correctness-equivalent** and differs only in
query strategy, so nothing but the query-count test could see it.

**★ The false kill.** The `IN` mutant was first written without importing `inArray`, making it a
`ReferenceError` rather than a semantic change — **three unrelated tests failed**, which is the
signature. A mutant that fails to compile proves nothing. Redone with the import; then exactly one
test failed. Without that check this ticket would have recorded a green mutation score off a
broken mutant.

## 4. Why two lookups, not `status IN (...)`

`job_artifacts_committed_identity_uidx` is **partial** (`WHERE status = 'committed'`), so an `IN`
predicate **cannot use it** — the planner falls back to the jobId-only index plus a filter, on the
hot path. Sequential lookups keep the common case at one indexed hit, exactly today's cost, and
compose forward when 003c adds the matching partial index.

**Recorded because it is invisible at the call site:** the index leads with `organization_id`,
which the query never filters. **RLS supplies it** (`job_artifacts_tenant_isolation`), so this is
index-served *because* it runs inside a tenant context. Run it outside one and it loses both.

`findEverCommitted` delegates through `this.` specifically so the query-count test can observe it.

## 5. Acceptance

003a discharges **no Outcome clause of its own** — it is the structural precondition for 003c and
its mutation gate for 003b. Stated plainly so the union in
[`BRW-003-design.md`](./BRW-003-design.md) stays checkable.

**Its gate is now satisfied: 003b is unblocked.**

## 6. Also corrected

`job_artifacts.ts:61-62` said `quarantined` is *"a value `findCommitted` never returns"*. After the
split that misleads about `findEverCommitted`, so it now names both and says why quarantine sits
outside each — an orphan never committed in the first place. A stale comment is worse than none.

## 7. Recorded, not guarded — one critical gap

A call outside a tenant context returns `null`, which **both** call sites read as *"never
committed"* — the fail-OPEN reading of a fail-closed mechanism. Structurally hard to reach today
(the repository is only constructed inside `runInTenant`), which is why it is recorded rather than
guarded. The next person to widen the repository's construction surface should see it first.

## 8. Evidence

37 tests green across the two affected suites (21 in `artifact-transfer-commit.integration`,
16 in `job-control-legacy-grants.contract`); typecheck clean on both packages; foundation,
test-inventory, guard-inventory and ticket-graph guards all pass. D1 nonce bumped to
`brw-003a-find-ever-committed` — this changes the upload-grant decision, and the D1 lane is the
only thing exercising a real presigned round-trip.
