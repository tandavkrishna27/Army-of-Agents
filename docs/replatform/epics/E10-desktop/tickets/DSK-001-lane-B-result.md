# DSK-001 Lane B — result

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Start SHA:** `58be1fb8b` (the Lane B design, committed before any code)
**Lane B tip:** `4c506f733` — PR gate green, including `ci-required`
**Live D1:** the 2-replica distributed topology passed on `dc4b57f6f`; the only commit
after it changes one integration test file and no production code.
**Covers:** design D10, D11, D12 — as amended by `DSK-001-lane-B-design.md`

---

## 1. What shipped

| # | Increment | Evidence |
|---|---|---|
| B1 | the rejection vocabulary became a **gate**: an array with the union derived from it, a coverage check in the policy lane, and a cross-file pin parsing the array out of the TypeScript source | 6/6 mutants |
| B2 | `DeviceLocalHandoff` widened (`companyId`, `handleId`, `boundTargetGeneration`, **`destination`**) + a **frozen key allowlist** replacing a one-name denylist | 4/4 |
| B3 | `DeviceLocalCredentialBroker` + `failClosedDeviceLocalBroker` — an activation is a reference, never bytes | 5/5 |
| B4 | `provider_credentials` `aoa_app` grant (migration 0259), landed **alone** | 5/5 |
| B5 | integration fixtures reseeded; the C-8 test de-vacuumed | CI |
| B6 | the coordinated gate: `ref_id` shape, `state='verified'`, the owner triple | 10/10 |

**Totals:** 6 admit / 21 reject vectors, 17 corpus tests, 65 unit tests in the touched
suites, `tsc` clean in both packages, all three derivations in agreement.

## 2. What Lane B is NOT

Stated in the design up front and repeated here so it cannot be mistaken later:
`device_local` still has **no production consumer**. Its only one — the fence-aware
egress proxy — correctly *denies* it, and that proxy itself has zero production callers.
Lane B is an authorization and typing foundation; the device-side consumer is **DSK-002**.

## 3. Where the design was wrong, and how we found out

| | Finding | How |
|---|---|---|
| **C-1** | **F17 is refuted — D11 was already built.** `issueTenantCode` does assert active org membership, one call deep in `findActiveTarget`, green since 2026-08-10 — ten days before the design claiming the gap. | adversarial terrain read. My own first read reached the same wrong conclusion by reading the **caller** and stopping. |
| **D-B3** | The grant is **table-level**, not column-level. I asserted `has_table_privilege` sees a column grant. It does not — `execution_targets` proves it, carrying column grants with an `aoa_app: []` matrix entry. | reading the matrix while implementing B4 |
| **D-B4** | The third leg binds the credential to its **device**, not to a target owner. Owner equality says nothing about *which* machine holds the value and can never hold for an organization-scoped target. | implementing B6 |
| **§4** | The grant is **seven** surfaces, not five. `rls-tenant.ts` *reconstructs* migrations 0213/0214 from the live grant map, so one entry retroactively rewrote two applied, immutable migrations. **0214 had no exclusion list at all.** | a byte-identity test, instantly |

The D-B4 correction paid for itself twice: it removed a query from the fenced
transaction (no `execution_targets` read, so OQ-4's column-projection trap never
arises), and `secret-broker.integration.test.ts` needed no edit because B5's seeding
already satisfied it.

## 4. Verification

- **Fail-first throughout.** The most useful instance was structural: declaring B6's six
  new reasons made B1's coverage gate demand six vectors that did not exist yet. The gate
  built in B1 directed the work in B6.
- **Mutation-tested: 30 mutants across the six increments, 30 killed** — after **two**
  survived and each found something real:
  - **B4/D3** — removing the `keyStoreMode` gate left the suite green, which exposed that
    `resolveCustody` returned `ok` for `mounted_secret` with stores injected. Plan row 2
    had never shipped. Fixed and mutation-proven; the now-redundant inner check is
    documented as a survivor rather than dressed up.
  - **B6/R2** — un-anchoring the UUID regex left everything green, because the slug vector
    contained no UUID and so could not tell anchored from unanchored. Not cosmetic: an
    unanchored match passes a malformed `ref_id` into `eq(uuid_column, …)`, which Postgres
    rejects with a **type error** rather than a clean refusal. A vector whose `ref_id`
    merely *contains* a UUID now kills it.
- **C-3 confirmed in practice.** Making `deviceCredential` required errored in exactly one
  place — `packages/db/.../job-control.ts:2726`. The authz test's explicitly-typed
  `SecretResolveAuthzInput` literals did **not** error, because `server/tsconfig.json`
  excludes `src/__tests__` and vitest erases types. An optional field would have forced
  nothing anywhere.
- **Live distributed proof.** `docker/d1/campaign.env` bumped, because neither
  `packages/db` nor `server/src` is on the D1 lane's push path filter.

## 5. Honest notes

- **B5 took three CI rounds**, and two of my diagnoses were wrong before the third was
  right. The C-8 test was vacuous, but not for the reason the terrain map gave (membership)
  nor the one I assumed next (owner binding): a test helper defaulting
  `cols.destination ?? "…"` silently overrode an explicit `null`, so the handle carried a
  network destination and was refused by rule 4. `??` cannot express "provided as null".
  The `resolve_count` assertion is what forced the real answer — without it the test would
  have kept passing for whichever reason happened to apply.
- **Two integration tests changed meaning under B6 and had to be repaired rather than
  left green.** Both would otherwise have gone on asserting the right outcome for the
  wrong reason: the egress device_local handle now executes as a user against a seeded
  credential on its own target, and the membership test was given a credential its own
  user owns.
- **Neither integration suite runs on Windows** (embedded-PG) and neither is typechecked,
  so the Linux `verify` lane is their only authority. That is why B4 and B5 were landed
  alone; every failure in them was isolated and had an unambiguous cause.
- **CI was billing-blocked for ~6 hours mid-lane.** Every job failed in 2 seconds with
  zero steps, including a docs-only commit — which is what ruled out the code. The tell is
  `gh api …/check-runs/<id>/annotations` when the job log is empty.

## 6. Deferred, with reasons

| Deferred | Why |
|---|---|
| A real `DeviceLocalCredentialBroker` implementation | DSK-002. Lane B ships the port and the fail-closed default. |
| `expiresAt <= lease deadline` enforcement | No lease deadline reaches this layer; threading it would widen two more types for a port nothing consumes. Safe meanwhile **because the fail-closed broker throws** — no activation can be minted, so no unbounded activation can exist. |
| Making `device_local` reach a consumer | DSK-002. The egress proxy's `malformed` denial is correct and stays. |
| The owner-scoped device listing | Lane D (D17), resolving the C-9 lane conflict. |
| `D11` | Already built (C-1). Recorded, not rebuilt. |

## 7. Still open for the operator

- The TEST-ONLY addition to the frozen `packages/worker-protocol/src/capabilities.test.ts`
  still needs a ruling: all three frozen gates pass and it is contractually inert, but the
  package is frozen.
- macOS hardware for D4/OQ-3. The design names macOS as the single most likely place it is
  factually wrong, and DSK-003 plans an installer against it.
- Code-signing certificates (Apple Developer ID + Windows) for DSK-003.
