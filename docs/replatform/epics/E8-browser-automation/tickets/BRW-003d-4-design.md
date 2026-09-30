# BRW-003d-4 — Ordering and response bounding — DESIGN

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Start SHA:** the commit that adds this file
**Index:** [`BRW-003d-design.md`](./BRW-003d-design.md)
**Discharges:** BRW-003 "order tied to event sequence"; the **stale-fence** test; and
**response-side bounding**, which the completeness pass found was owned by nobody.

---

## §1 The reframe this slice rests on

Three separate HIGH findings attacked one assumption: that "order tied to event sequence" means
ordering *artifacts* by an event sequence. It does not have to. `getJobDetail`
(`job-operations.ts`) **selects `sequence` and never orders by it** — and `attempts` and `leases` are
unordered too.

So the literal clause has a literal, live, server-side discharge: order the events read. That removes
the correlated subquery, the per-attempt collision, a `NULLS LAST` construction that emits invalid
SQL, an unindexed join, a new column and a migration — all of which the earlier proposal needed.

**`sequence` is PER-ATTEMPT** (`job_events.ts`, unique on `(org, attempt, sequence)`), so the order
is `(attemptNumber, sequence)`. Ordering by `sequence` alone would interleave two attempts of the
same job into nonsense.

## §2 ★ Response bounding — found by nobody, and the worse half

The events select has **no `limit`**. It returns *every* `job_events` row for a job on an
authenticated operator route, and a legal batch is up to 500 events
(`workerEventBatchV1Schema`). Adding an unbounded artifacts section beside it would double the
problem.

**Bound it, and make the truncation VISIBLE.** A silently truncated list is worse than a long one: an
operator reading the last event of a truncated ascending list concludes the job ended there.

Mechanism: order **descending**, take `limit + 1`, use the extra row purely as the truncation signal,
drop it, then reverse into ascending order. One query, no `COUNT`, and the operator keeps the
**most recent** window — which for debugging is the one that matters, because it contains the
terminal.

## §3 ★ The disposition decision (from the index) is also the stale-fence clause

`job_artifacts` holds **multiple live rows per identifier by design** — `granted`, `committed`,
`quarantined` (and `expired` when 003c lands) each have their own partial unique, so they coexist.

**The artifacts read returns ALL dispositions and puts `status` on the wire.**

- **Not** `WHERE status = 'committed'`. That would make the stale-fence clause — *"commit refuses;
  the record stays discoverable"* — **false by construction**, because the record that survives a
  refused commit **is** the `granted` intent row. A committed-only read deletes the evidence the
  clause exists to preserve.
- Duplicates per identifier are intentional and legible *because* `status` is on the wire: an
  operator reads `artifact X: granted → committed` as one lifecycle, not two artifacts.
- Ordered `(attempt, identifier, status)` and bounded by the same rule as events.

This makes the stale-fence test assertable without faking the triply-dormant quarantine leg: insert a
`granted` row, do not commit, and assert it is **still discoverable**.

## §4 What is NOT included, and why

- **No new column, no migration.** The gap was a reader, not a schema.
- **No artifact-to-event correlation.** `job_events.sequence` is per-attempt and `job_events` has no
  `job_id` index, so a correlated `MIN()` would be both wrong and unindexed. Recorded as out of scope
  rather than attempted badly.

## §5 Tests — each with its red state

| Case | Assertion | Red today |
|---|---|---|
| events ordered | `(attemptNumber, sequence)` ascending, on a deliberately shuffled fixture | no `orderBy` at all |
| ★ two attempts | attempt 2 seq 1 sorts **after** attempt 1 seq 9 | ordering by `sequence` alone interleaves them |
| events bounded | more rows than the cap ⇒ capped | no `limit` |
| ★ truncation visible | the caller can tell it was truncated | nothing signals it |
| most-recent window | truncation drops the OLDEST, keeps the terminal | — |
| artifacts present | a section exists at all | `JobDetail` has four members |
| ★ stale-fence | a `granted` row with no commit is still discoverable | a committed-only read would hide it |
| dispositions labelled | `status` is on the wire | — |
| artifacts bounded | same cap rule | — |
| tenant scoping | the read stays org+job scoped | — |
