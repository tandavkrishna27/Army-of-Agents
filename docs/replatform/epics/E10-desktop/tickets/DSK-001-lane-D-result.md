# DSK-001 Lane D — result

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Start SHA:** `00e5ab05a` (the Lane D design, committed before any code)
**Lane D tip:** `573322155` — PR gate green, including `ci-required`
**Covers:** design D17, invariants I16 and I18

**This closes DSK-001.** Lanes A, B, C and D are all landed and CI-green.

---

## 1. What shipped

| # | Increment | Evidence |
|---|---|---|
| D1 | the redacted projection + `desktopDeviceLeakKeys` (I16, I18) | 5/5 mutants |
| D2 | `GET /organizations/:orgId/desktop-devices`, mounted inside the flag block | 4/4 |

47 tests across the Lane C/D suites, `tsc` clean, the desktop-surface gate green on 115
route files (it now scans the new route too).

## 2. The reading that shaped it

F31 says the redacted `WorkerSummary` allowlist drops `ownerUserId` "so it cannot serve an
owner-scoped view". That reads like an instruction to emit the owner. It is the opposite:
the view needs `owner_user_id` as a **query input**, and `WorkerSummary` cannot serve it
because by the time you hold one the column is already gone — so you cannot filter on it.

Owner scoping is therefore a **filter, never a disclosure**. Building from the org's own
targets outward puts the scoping in SQL and keeps the column out of the response, which is
exactly why D17 calls that construction safe where a generic worker join is not.

`executionTargetId` is omitted for the same finding's actual lesson: `WORKER_SUMMARY_COLUMNS`
had to drop it, and re-adding it hands back the join key a caller could pivot on.
`targetSlug` carries the human meaning without the identifier.

## 3. Deviation from D17, recorded rather than taken quietly

The design says the query runs "inside `runInTenant`". **It is not implementable as
written.** `runInTenant` opens as the non-owner `aoa_app` role, whose grant on
`execution_targets` is COLUMN-level and covers only `id`, `organization_id`,
`owner_user_id`, `scope`, `target_authority_key`, `status`, `device_generation`,
`capabilities` (`APP_ENROLLMENT_TARGET_SELECT_COLUMNS`). Neither `kind` nor `slug` is
readable there — so the `kind = 'desktop'` filter the design specifies could not run, and
`targetSlug` could not be emitted.

It uses the owner pool with SQL scoping, exactly like the sibling `listExecutionTargets`,
whose own comment defends the pattern: "the no-system/cross-org guarantee is the WHERE
clause, not a JS post-filter". Every other route in this area already reads that way, so a
second access pattern for one listing would be the inconsistency, not the safety.

**The follow-up if RLS defence-in-depth is wanted:** add `slug` and `kind` to
`APP_ENROLLMENT_TARGET_SELECT_COLUMNS` — both non-sensitive — and move the query. That is
a security-manifest change with its own surfaces, so it is a deliberate follow-up rather
than something slipped into a listing.

## 4. Why the tests are shaped the way they are

- **I16's exhaustiveness runs against the TABLE, not the response.** The weak version
  ("the response has these seven keys") passes forever while the schema grows underneath
  it. This enumerates the drizzle columns of both tables and requires every one to be
  classified — allowlisted, or in `DELIBERATELY_OMITTED_COLUMNS` with a written reason. A
  new column fails the build until someone decides about it, which is what "a future
  column defaults hidden" actually requires.
- **Paired with the canary half**, because neither is sufficient: the canary catches a
  leak through a field nobody listed, the exhaustiveness catches a column nobody thought
  about. The canary is checked against the **serialized** response, so a nested object
  smuggling a value through an allowlisted key is caught too.
- **The projection is built by NAMING each field**, never by spreading and deleting. A
  spread-then-omit implementation inherits every future column by default — the shape that
  produced F31 in the first place.
- **I18 uses both REAL redactors.** They genuinely disagree: `FORBIDDEN_WIRE_KEYS` is an
  exact match on a normalized key, the daemon logger's `SENSITIVE_SUBSTRINGS` is substring
  containment, so `credentialHandleId` passes the wire and is `[redacted]` in logs.

### The boundary that forced a better test

`@armyofagents/worker-daemon` is **not** a server dependency, and adding it to reach one
array would be an architectural regression — the daemon is a separately deployable leaf.
So its list is read **from source** with its exact normalization reproduced: a cross-package
pin rather than a copy, the same shape as Lane B's rejection-reason mirror.

That is the stronger test anyway. A copied word list drifts from the guard it claims to
satisfy — precisely the failure Lane B hit, where a test asserted the *wire* normalizer on
a record that never touches the wire.

## 5. Mutation found a gap, and it was mine

V2 (return raw rows instead of projecting) and V3 (drop the `kind='desktop'` filter) both
**survived** the first pass. Two causes, both worth recording:

1. I ran that battery against `tsc --noEmit` rather than a test command. A typechecker
   cannot catch a behaviour change — the harness was answering a different question than
   the one I asked.
2. Underneath that, **`listDesktopDevices` had no test at all.** A service function
   shipped with zero coverage is exactly what a green suite hides.

Four tests added — null-org short-circuit, projection routing, targets-first join, and a
source-asserted check that both predicates are present. V2, V3 and a new V4 (drop the org
filter) now all die.

## 6. Out of scope, stated

- **No UI.** D17 is a server-side projection; rendering is DSK-003's installer story.
- **No mutation endpoints** — no revoke, rename, or re-enrol. A listing is a read, and
  adding a write to the first flag-gated surface would widen it before anything has
  exercised the read.
- **I19** shipped in Lane B (the frozen handoff key allowlist and the broker port's
  structural tests) and was not revisited.
