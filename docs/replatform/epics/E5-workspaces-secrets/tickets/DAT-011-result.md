# DAT-011 Result — the orphan sweep now runs

**Status:** LANDED. **Start SHA:** `9b895a57e` ([`DAT-011-design.md`](./DAT-011-design.md)).
**Closes:** [`DAT-009-slice-2-result.md`](./DAT-009-slice-2-result.md) §6 — "nothing calls the
sweeper".

---

## 1. What landed

`createSweepTrigger` (debounced, per-organization, best-effort) wired into `artifact-commit`
on **both** outcomes, and threaded from the composition root at `worker-control.ts:112`.

**The chain now has production callers end to end** — verified by grep, excluding definitions
and tests:

| Symbol | Production caller |
|---|---|
| `createSweepTrigger` | `routes/worker-control.ts` |
| `runArtifactOrphanSweep` | `routes/worker-control.ts` |
| `findSweepCandidates` | `routes/worker-control.ts` |
| `markSwept` | `routes/worker-control.ts` |

Before this ticket all four were reachable only from their own tests.

## 2. Acceptance

| Clause | State |
|---|---|
| A `stale_fence` refusal triggers a sweep for that org | ✅ |
| A successful commit triggers one too | ✅ |
| ★ A throwing sweep NEVER reaches the caller | ✅ mutant M4 |
| ★ Debounced per ORGANIZATION, not globally | ✅ mutant M2 |
| ★ A FAILED sweep does not consume the debounce slot | ✅ mutant M3′ |
| Debounce holds and releases | ✅ mutants M1, M5, M6 |
| `isSweepEligible` unchanged | ✅ by absence — the trigger passes `now`, nothing else |

**Mutation: 6 mutants, 6 killed.** 11 unit tests. 68 tests across the seven artifact suites,
including the commit integration suite run for real. `tsc` clean. db suite 297 pass.

Full server suite run **before** pushing: 4 files / 6 tests fail, all in the pre-existing
Windows-local set previously attributed by stashing.

## ★ 3. Two properties that are the design, not decoration

**The trigger decides WHEN TO LOOK, never WHAT IS ELIGIBLE.** A `stale_fence` refusal does not
collect its own object: the grant stays redeemable until `expiresAt`, so a retry could still
re-PUT to that key. `isSweepEligible` remains the single authority, strictly-after-expiry, and
this ticket does not touch it. Keeping the two separate is what stops a trigger from quietly
widening a deletion rule.

**A failed sweep must not consume the debounce slot.** The slot is stamped only on success —
otherwise one transient storage error silences sweeping for that organization for a whole
interval, *invisibly*, because the sweep is best-effort by design. Mutant M3′ exists for
exactly that.

## 4. The pattern this deliberately copies

`createArtifactCommitService` already had `metrics?: JobControlMetrics` — *"defaults to the
no-op surface … best-effort and never alters the commit path"*. `sweepTrigger` follows it
exactly: same optionality, same no-op default, same contract. Copying an established seam beat
inventing one, and it means the commit path has one consistent story about side channels.

## ★ 5. The residual, unchanged and still stated

An organization whose **last** artifact activity produced an orphan keeps it until that
organization commits again. There is no timer and no enumeration, so nothing else will look.

Bounded to one org's most recent orphan, and strictly better than today where nothing is ever
collected. Triggering on **successful** commits too — not only refusals — is what keeps it to
"the last orphan" rather than "every orphan after the last refusal".

If that ever becomes unacceptable the honest fix is an **audited operator-scoped maintenance
surface**, explicitly outside the tenant boundary — **not** a quiet cross-tenant reader added
for housekeeping.

## ★ 6. NOW PROVEN END TO END — and the lane found a defect this ticket had shipped

**`tests/d1/e6f-14-orphan-sweep.test.mjs` is green** against real PostgreSQL and real
MinIO-over-TLS (D1 campaign: 41 tests, 41 pass, **0 skipped**). It exercises the whole path:
mint → intent recorded → PUT → object exists → stale fence → commit denied → **the object is
deleted from the store** → the intent row is `swept`.

**It took four runs, and run 3 found a PRODUCTION DEFECT in this ticket.**

A stale fence is refused by `resolveWorkerFenceContext`, **not** by `commitArtifactVersion`:
`lockLeaseAckContext` looks the lease up BY the presented fence token, so a superseded fence
finds no row and throws `JobLeasingError("stale_fence")` — which never reached the catch where
this ticket originally placed the trigger.

**So the sweep never fired on a stale-fence refusal** — the exact event it was designed
around. It fired only on successful commits, the design's *secondary* trigger.

★ **What this says about §1's verification.** That section proudly listed four symbols with a
production caller, grep-verified. That check was true and insufficient: **it cannot tell you
the caller is unreachable on the path you claimed.** No unit test could either — the control
flow only diverges against a real lease in a real database.

## 7. Still not done

- **`orphanDisposition` is unused on this path.** A refused commit could mark its intent as a
  confirmed orphan, letting a future sweep distinguish "commit refused" from "never heard
  from". Not needed for correctness; not slipped into a trigger ticket.
