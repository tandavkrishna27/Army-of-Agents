# BRW-003d-4 — Ordering and response bounding — RESULT

**Epic:** E8 · **Lane:** B (`C:\e8`) · **Status:** ✅ complete
**Design:** [`BRW-003d-4-design.md`](./BRW-003d-4-design.md) · **Index:** [`BRW-003d-design.md`](./BRW-003d-design.md)
**Start SHA:** `26c846418` (design) · **End SHA:** `2b47a9359`
**Discharges:** "order tied to event sequence"; the **stale-fence** test; **response-side bounding**.

---

## 1. The reframe did most of the work

Three separate HIGH findings in review attacked one assumption — that *"order tied to event
sequence"* meant ordering **artifacts** by an event sequence. It didn't have to.

`getJobDetail` **selected `sequence` and never ordered by it**, and `attempts` and `leases` were
unordered too. Ordering the events read discharges the literal clause and removes everything the
earlier proposal needed: a correlated `MIN()` subquery, a per-attempt collision, an
`asc(sql\`… NULLS LAST\`)` construction that emits invalid SQL, an unindexed join on a table with no
`job_id` index, a new column, and a migration.

`sequence` is **per-attempt**, so the key is `(attemptNumber, sequence)`. The fixture is built so a
sequence-only `ORDER BY` puts 2 before 9 and fails.

## 2. ★ The unbounded read nobody owned

The events select had **no `limit`** — every `job_events` row for a job, on an authenticated
operator route, where a legal upload batch is up to 500 events.

Now bounded, and the truncation is **reported**: an operator reading the last row of a silently
truncated ascending list concludes the job ended there. Reading **descending** with `limit + 1` uses
the extra row purely as the signal and keeps the **most recent** window — the one holding the
terminal — then reverses back to ascending before it leaves.

## 3. The disposition decision IS the stale-fence clause

The artifacts section returns **every disposition with `status` on the wire**. `job_artifacts` holds
multiple live rows per identifier by design, and the record that survives a refused commit is the
`granted` intent row — so `WHERE status = 'committed'` would make *"the record stays discoverable"*
**false by construction**. Duplicates are legible precisely because `status` is on the wire.

This makes the stale-fence test assertable without faking the triply-dormant quarantine leg.

## 4. ★ A capped RESPONSE is not a bounded READ

**O3 survived**, and the gap was in the test rather than the code. Deleting `.limit()` still produced
a capped response, because the service slices afterwards — but **every row would have crossed the
wire from Postgres first.** Asserting response length can never see that.

The property is now *what we ask the database for*: the unit-tier fake records every `.limit(n)` by
table, and a test asserts both reads requested a bound. That killed O3 — and a second mutant I hadn't
written yet, the artifacts `.limit()` removal.

**This is the third time in this epic that the honest version of a bounding claim sat one level below
the obvious one:**

| Slice | Obvious claim | What it actually was |
|---|---|---|
| 003d-1 | "the threshold is too low" | the **shape** of the refusal |
| 003d-2 | "the constant is right" | the **binding** of it |
| 003d-4 | "the response is capped" | the **read** is unbounded |

## 5. The fake accepts `orderBy` and deliberately does not sort

Without it, every test in `job-operations-routes.test.ts` dies on *"orderBy is not a function"*. With
a **sorting** fake, an ordering assertion there would pass against a wrong `ORDER BY`, because the
fixture order would decide the result. So ordering is asserted only in the embedded-Postgres tier,
and the reason is written where the next person will read it.

## 6. Mutation testing — 8 mutants, 8 killed

| Mutant | Result |
|---|---|
| events `ORDER BY` removed | killed — 2 |
| ★ ordered by `sequence` alone (attempts interleave) | killed |
| **events `.limit()` removed** | **survived → bounded-read test added → killed** |
| artifacts `.limit()` removed | killed by the same new test |
| truncation always reported false | killed |
| ★ reads the OLDEST window instead of the newest | killed — 2 |
| `.reverse()` dropped | killed — 2 |
| ★ artifacts filtered to committed only | killed |

## 7. Four schema facts the fixtures had to learn

Each a real constraint, not a test detail: `job_events.lease_id` and `fence_token` are **NOT NULL**;
`event_digest` must match `^[0-9a-f]{64}$`; the unique is on **attempt_id**, not `attempt_number`
(which is what let the two-attempt fixture avoid fabricating a second attempt row against an FK); and
`job_artifacts` has **no `company_id`** column.

## 8. Out of scope, recorded

**No artifact-to-event correlation.** `job_events.sequence` is per-attempt and `job_events` has no
`job_id` index, so a correlated `MIN()` would be both wrong and unindexed. Named rather than
attempted badly.

## 9. Verification

- 4 embedded-Postgres tests + 17 unit-tier tests green
- **12,871 server tests green**; the 6 reds are the known pre-existing set
- typecheck clean
