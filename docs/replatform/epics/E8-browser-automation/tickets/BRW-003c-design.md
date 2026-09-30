# BRW-003c — Retention enforcement — DESIGN

**Epic:** E8 · **Lane:** B · **Start SHA:** the commit that adds this file
**Index:** [`BRW-003-design.md`](./BRW-003-design.md)
**Discharges:** Acceptance "retention policy is explicit"; Test "retention".

---

## ★ BLOCKERS — both hard, both recorded as blockers rather than notes

1. **Lane A's `isSweepEligible` edit MUST land first.** `expired` is neither `committed` nor
   `quarantined`, so an expired row falls past `artifact-orphan-sweep.ts:62-63` to `no_object_key`,
   and `sweepRefusalIsActionable("no_object_key")` returns **`true`** (`:56-57`, whose own comment
   says such rows *"can NEVER become eligible, so they accumulate silently unless someone is told"*).
   Shipping this first makes **every successful expiry a permanent actionable alarm** — an alarm
   generator wearing retention's name.
   **Coordinated, not forked:** two definitions of "sweep eligible" is the drift class, and a forked
   predicate is how they silently diverge.
2. **003a must be merged with all its mutation tests killed.** This ticket writes the `'expired'`
   status that 003a's split exists to survive.

---

## 1. The live gap — and it is in a file this lane wrote

`server/src/services/browser-artifact-retention.ts:37-42` declares
`CREDENTIAL_BEARING_ARTIFACT_KINDS = ["browser_cookie_state","browser_storage_state"]` with the
comment: *"Artifacts whose bytes ARE a usable credential. Anything longer than `ephemeral` leaves a
live session credential on disk after the session that minted it has ended."*

**Nothing reads it.** `browserArtifactRetention` has **zero production callers**;
`job_artifacts.expiresAt` has **zero readers and zero writers**. The system classifies certain bytes
as live credentials needing the shortest life, and has no mechanism to honour that classification.

Lane A found the same gap independently (DAT-009 slice 2 §3) and deliberately scoped it out, naming
it follow-up #2 — *"the reason the mechanism here is record-driven so it can be reused."*

## 2. Reuse Lane A's mechanism — do not build a second sweeper

Two sweepers over the same objects is a **correctness hazard**, not just duplication. Lane A's shape:
intent record at mint, sweep by record, the existing `deleteObject`, and **no bucket enumeration** —
which matters, because `StorageProvider` has no list operation at all (`storage/types.ts:56-68`).

## 3. Order: delete bytes, THEN tombstone

The reverse loses the object key and orphans the bytes permanently — a tombstone-first crash leaves
no record of what to delete. Delete-first is **convergent**: re-running a partially-completed expiry
re-attempts a delete that has already happened.

**To verify at implementation, not assume:** whether S3 `DeleteObjectCommand` on a missing key
succeeds. `s3-provider.ts:221-229` does not special-case a 404, and the convergence argument depends
on it. Flagged by the adversarial review as unverified by anyone, including the reviewer.

## 4. Placement — NOT the `createJobControlSweeper` path

`listAdmittedOrganizationIds` (`server/src/index.ts:582-596`) pages at **32** (`:588`) and filters
`eq(organizations.status, "active")` (`:596`). **A suspended tenant's live session credentials would
never be swept.** That is a security consequence, not a throughput one, and it disqualifies the
otherwise-obvious host.

## 4a. The expired partial unique lands HERE (plan-eng-review D2)

`job_artifacts_committed_identity_uidx` is `WHERE status = 'committed'`
(`schema/job_artifacts.ts:92-94`), so the moment this ticket writes `'expired'` the row drops out of
it and the identity becomes re-insertable. `job_artifacts_expired_identity_uidx` — same columns,
`WHERE status = 'expired'` — carries the identity forward.

**Two DISJOINT partial uniques, not one widened index.** A single index spanning both statuses would
forbid the legitimate `committed → expired` transition of the same identity.

It lands here rather than in 003a because **here the test can actually fail**: insert two expired
rows for one identity and the second is rejected. In 003a, where nothing writes `'expired'`, the
only available assertion is *does the index exist* — schema paperwork, not proof.

Drizzle-only (`pnpm db:generate`); C14 hand-append limited to idempotency guards. **Migration number
re-checked at commit, not at design** — Lane A takes numbers concurrently.

## 5. Credential-bearing kinds get the shortest life

`ephemeral` must be **a number in one place**, not a word in a comment. Where a credential-bearing
artifact is submitted with a longer class, the choice is **refuse at commit** versus **downgrade
silently** — refuse, because a silent downgrade is a policy decision made invisibly, and Rule #7
immutability means the manifest cannot be edited after the fact.

## 6. Tests — each with its red state

| Test | Assertion | Red state |
|---|---|---|
| bytes deleted | the object is **gone from storage**, not merely a column set | zero production callers; `expiresAt` has zero writers |
| tombstone survives | the row remains, identity carried by the `expired` partial unique | the index does not exist |
| ★ expired uniqueness | two expired rows for ONE identity — the second is **rejected** | no expired index; and in 003a this test was unconstructible |
| credential-bearing | shortest class enforced; a longer class refused at commit | the classification is inert |
| suspended tenant | a suspended org's credentials **are** swept | the obvious placement would skip them |
| convergence | re-running a half-completed expiry converges | — |
| anti-vacuity | a sweep that examined zero records **reports it** rather than "OK" | mirrors Lane A's own anti-vacuity test |

**The retention test asserts bytes deleted.** A test that asserts a column was set would pass against
a system that deletes nothing — the exact vacuity this ticket exists to close.
