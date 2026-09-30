# QA - D0 - E1 frozen-consumer checker correction - `127247f54271` - a4

## Record identity

| Field | Value |
|---|---|
| Date (UTC) | `2026-08-10` |
| Scope | Prerequisite P2 fix round 1: frozen-consumer checker correction only |
| Supersedes | a3 only if a distinct reviewer accepts this candidate |
| RED revisions | `eef4db2588505b61ffee0fc864792e3fd8873fa4`, `193cea335cec8cb9b3ed423bdb62bffb9c638a92` |
| Candidate code revision | `127247f54271bc951db04ea50c016cf4d49e0d66` |
| Environment | `operator-directed windows-local`; Git object database available |
| Formal authority | Linux CI under DEC-03 |
| Gate owner | `TBD - distinct reviewer` |
| Result | **`awaiting_review`** |

This is implementer-observed evidence, not an independent gate decision. It does not
mark E1/P2 complete or authorize JOB-001.

## Candidate observations

| Requirement | Observation | Candidate result |
|---|---|---|
| External frozen anchor | Freeze commit `c680534...` has sole parent `b7a842...` and exact fixture tree `e62b3b...`; every current fixture path is compared as raw bytes to that immutable tree. Coordinated bundle/manifest and schema/manifest mutations fail. | `observed_green` |
| Replacement resistance | All verifier Git lookups disable replacement semantics in both CLI and environment; a real replacement-ref attack is rejected, and exact commit object type is required. | `observed_green` |
| Authenticate before execute | Invalid fixture code is never imported. Smoke uses an isolated bounded child, kills an infinite loop at the test timeout, caps output, and reports timeout/failure. | `observed_green` |
| Signing and cleanup | Reproduced inherited `commit.gpgSign=true` passes; commits use `--no-gpg-sign`; setup failure is inside cleanup boundaries and leaves no temp repo. | `observed_green` |
| Prior compatibility | All prior later-consumer manifest/lockfile, CRLF, missing-object, dependency-integrity, clean-clone, and mutation cases remain green. | `observed_green` |
| Focused acceptance | `30/30`; actual source-SHA checker passes; boundary `50/50`, boundary CLI, package smoke, and manifest check pass. | `observed_green` |
| Typecheck/build | Worker-protocol and repository recursive typecheck/build exit `0`. | `observed_green` |
| Repository tests | Worker lane exits `1` only on the documented Windows `cross-version.test.ts:12` collection failure after `16` files / `490` tests pass. Full `pnpm test:run` also reports a full-load 30-second server setup timeout; that server file passes isolated `7/7` in about 8 seconds. Neither nonzero run is represented as a pass. | `observed_with_baseline` |
| Immutable boundary | Protected diff is empty: no frozen fixture, protocol source/schema/bundle, contract, dependency manifest/lockfile, freeze script, or E3 implementation changed. | `observed_green` |

## Review decision placeholder

**Reviewer identity:** `TBD`

**Reviewed revision:** `TBD`

**Decision:** `awaiting_review`

**Residuals:** The source commit predates the fixture, so the checker authenticates
the source commit itself and separately authenticates the fixture to its direct-child
freeze commit. The production smoke timeout is 5 seconds. Linux CI remains DEC-03
authority; distinct review alone may close E1-F008 and prerequisite P2.
