# DSK-001 Lane D — design

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Start SHA:** the commit that lands this file, before any Lane D code
**Covers:** design D17 (the device listing) and invariants I16, I18

---

## 1. What Lane D is

An owner-scoped device listing: the org's own `kind='desktop'` execution targets joined to
their enrolled `workers`, as a **redacted server-side projection**.

**It is not a protocol shape.** The frozen wire cannot carry this: `secretHandleRefSchema`
is `.strict()` with exactly three fields and is byte-gated in CI (F26). So this is REST
over the org's own rows inside `runInTenant`, following the `PROVIDER_PROJECTION_KEYS` /
`projectionLeakKeys` precedent (`packages/sandbox-provider-contract/src/port.ts:70-100`).

I19 — "no type reachable from `DeviceLocalCredentialBroker` or `DeviceLocalHandoff` has a
value-bearing field" — **already shipped in Lane B** (the frozen handoff key allowlist and
the broker port's structural tests). Lane D does not revisit it.

---

## 2. Decisions

### D-D1 — owner scoping is a FILTER, never a disclosure

F31 observes that the redacted `WorkerSummary` allowlist
(`server/src/services/job-operations.ts:111-123`) drops `ownerUserId` "so it cannot serve
an owner-scoped view". That is easy to misread as *the new view must emit the owner*. It
must not — I16 lists `ownerUserId` among the columns whose canary bytes may never appear
in the response.

The resolution is that an owner-scoped view needs `owner_user_id` as a **query input**,
not as an output field. `WorkerSummary` cannot serve the view because by the time you hold
one, the column is already gone — so you cannot filter on it. Building the query **from
the org's own targets outward** lets the scoping happen in SQL and the column never reach
the response. That is also exactly why D17 says constructing the join that way is safe
where a generic worker join is not.

### D-D2 — the projection, and what it deliberately omits

```
deviceId           the worker id — a stable opaque handle for this enrolled device
targetSlug         the human-recognisable name of the target the device is enrolled to
label              the device's own label
status             enrolled | revoked …
deviceGeneration   so a re-enrolment is VISIBLE rather than silent
enrolledAt         when it was enrolled
lastSeenAt         liveness
```

Seven fields, chosen so an operator can answer "which of my machines are enrolled, are
they alive, and has any of them been re-enrolled behind my back" — and nothing else.

Omitted deliberately, each for a reason rather than by not-thinking-of-it:

| Omitted | Why |
|---|---|
| `ownerUserId` | D-D1 — scoping input, not output |
| `executionTargetId` | **F31's actual lesson.** `WORKER_SUMMARY_COLUMNS` had to drop this; re-adding it here would reintroduce the join key a caller could pivot on. `targetSlug` carries the human meaning without the identifier. |
| `targetAuthorityKey` | encodes `owner:<org>:<user>` — it *is* `ownerUserId` in another spelling |
| `workerTokenHash`, `devicePublicKey`, `deviceThumbprint` | credential material or derived from it |
| `config`, `capabilities`, `registeredProfile`, `profileSnapshot`, `providerConstraintProfile` | free-form JSON; an allowlist that admits an arbitrary blob is not an allowlist |
| `organizationId` | the caller already scoped by it; echoing it back adds nothing and widens the surface |

### D-D3 — I16's exhaustiveness is enforced against the TABLE, so a future column defaults hidden

The weak version of this test asserts "these seven keys are present". That passes forever
while the schema grows underneath it.

The version that holds: enumerate the **drizzle table's own columns** at runtime and assert
every one is classified — either in the projection allowlist or in an explicit
`DELIBERATELY_OMITTED` list with the reason. Adding a column to `workers` or
`execution_targets` then **fails the test until someone classifies it**, which is what "a
future column defaults hidden" actually requires.

Paired with the canary half: seed distinctive bytes into every omitted column and assert
none appear anywhere in the serialized response. Neither half is sufficient alone — the
canary catches a leak through a field nobody listed, the exhaustiveness catches a column
nobody thought about.

### D-D4 — I18 imports BOTH redactors rather than copying their lists

The two guards genuinely disagree, and the meta-test is only meaningful if it uses the
real ones:

- `FORBIDDEN_WIRE_KEYS` is an **exact** match on the normalized key
  (`wire-safety.ts:18-37`).
- The daemon logger's `SENSITIVE_SUBSTRINGS` is a **substring containment** check
  (`worker-daemon/src/logging/logger.ts:37-49`).

So `credentialHandleId` passes the wire (it is not exactly `credential`) yet is
`[redacted]` in logs. A copied word-list would drift from whichever guard it was copied
from — the same failure Lane B hit when a test asserted the *wire* normalizer on a record
that never touches the wire.

`SENSITIVE_SUBSTRINGS` is not exported, so the logger side is asserted **behaviourally**:
build a real `createWorkerLogger` with an injected destination, log an object keyed by the
projection fields, and assert none is redacted. That is stronger than a word-list anyway —
it cannot drift from the redactor it is claiming to satisfy.

### D-D5 — mounted INSIDE the flag-gated router, and dynamically imported

D17 requires the mount be inside `if (opts.distributedExecutionEnabled)` so DSK-00 clause
(a) holds **by construction** rather than by a guard — the opposite of F27, which Lane C
had to fix precisely because the mount sat outside.

It also follows the block's existing `await import(...)` idiom, so a flag-off startup never
loads the module graph at all. Lane C's clause-2 structural test already asserts that
`workerControlRoutes` is mounted only inside that block and exactly once; the same
assertion extends to this router.

---

## 3. Landing order

| # | Increment | Notes |
|---|---|---|
| **D1** | the projection + `deviceListingLeakKeys`, pure and unit-tested (I16 exhaustiveness + I18 both-redactors) | no route yet; pure, fully provable in the required lane |
| **D2** | the route, mounted inside the flag-gated block, with the canary test | behaviour addition, flag-gated |

D1 first because the allowlist is the security artifact; the route is delivery. That order
also means the exhaustiveness test exists before there is a response to leak through.

## 4. Out of scope, stated

- No UI. D17 is a server-side projection; rendering it is DSK-003's installer story.
- No mutation endpoints — no revoke, rename, or re-enrol. A listing is a read.
- `I19` shipped in Lane B and is not revisited here.
