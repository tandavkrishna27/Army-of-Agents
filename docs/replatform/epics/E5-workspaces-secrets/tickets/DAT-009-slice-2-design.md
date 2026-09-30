# DAT-009 slice 2 — Design: close the fence window without a frozen change

**Status:** DESIGN. **Start SHA:** the commit that adds this file.
**Terrain:** [`DAT-009-terrain.md`](./DAT-009-terrain.md) §4.
**Decision:** [`DECISION-byte-egress-and-provider-topology.md`](../../../DECISION-byte-egress-and-provider-topology.md) §4.3.

Slice 1 is **held** behind the E4-D02 STOP (REVISION 1 of the decision record). Slice 2 is
unaffected: it is entirely server-side and needs no provider operation.

---

## 1. The window, restated with the numbers

The fence is checked **only at mint** (`artifact-transfer-grant.ts:86`, `lockActiveFence`), and the
issued grant carries no fence material (`artifacts.ts:409-428`, `.strict()`). Nothing re-checks
between mint and commit; **no grant-revocation concept exists anywhere in the repo**. Lease renewal
would *notice* a dead fence (`job-fencing.ts:183+`) but is not on the upload path and cannot revoke
a signed URL — noticing is not guarding.

**Effective TTL is always 300 seconds.** `artifact-transfer-grant.ts:47` is
`Math.max(30, input.grantTtlSeconds ?? 300)` — floor 30, default 300, **no upper clamp** — and
**no caller passes the parameter** (`worker-control.ts:111` constructs the service without it). The
knob is dead configuration.

## ★ 2. Three facts that make "just add a sweeper" impossible today

**2.1 — The mint records NOTHING durable.** `artifact-transfer-grant.ts` never calls
`recordOperationReceipt` (contrast the renewal path, `job-fencing.ts:157-176`), and
`authorizeArtifactCommit` — the only writer of a non-`committed` `job_artifacts` row
(`job-control.ts:2537-2545`) — is never called on the grant path. **The control plane has no record
that a given object key was ever granted.**

**2.2 — The storage port cannot LIST.** `StorageProvider` is
put/get/head/delete/`presignPut?`/`presignGet?` (`storage/types.ts:56-68`). There is no list
operation and zero `ListObjects` call sites.

So a sweeper today has **neither a database record of what to look for nor a way to enumerate the
bucket**. That is why this design does not start with a sweeper.

**2.3 — There is no GC of anything.** `deleteObject` has exactly two call sites, both task
attachments (`routes/issues.ts:1713,2528`). No S3 lifecycle configuration exists. **Committed
artifacts are never collected either** — the orphan question is a special case of a total absence.

## ★ 3. A live security gap this uncovered, larger than the orphan

`server/src/services/browser-artifact-retention.ts:37-42` declares:

> `CREDENTIAL_BEARING_ARTIFACT_KINDS = ["browser_cookie_state", "browser_storage_state"]` —
> *"Artifacts whose bytes ARE a usable credential. Anything longer than `ephemeral` leaves a live
> session credential on disk after the session that minted it has ended."*

The retention class is required on every manifest (`artifacts.ts:305`) and persisted to
`job_artifacts.retention`. **Nothing reads it back to act.** `job_artifacts.expires_at` shipped in
migration `0248` with **no reader and no writer**.

So the system explicitly classifies certain bytes as live credentials needing the shortest life, and
has no mechanism to honour that classification. **This is true today, independent of DAT-009** — it
is simply unreachable because nothing uploads. DAT-009 makes it reachable.

**Scoped out of this slice, deliberately** (§8): enforcing retention for *committed* artifacts is a
larger ticket. This slice must not silently become it. But the mechanism below is chosen so that
ticket can reuse it rather than build a second one.

## 4. The design — intent records, not bucket scanning

**4.1 — Clamp the TTL where it is actually decided.** `Math.min(MAX_GRANT_TTL_SECONDS, Math.max(30, …))`
in the service. Non-frozen; bounds the window immediately.

The frozen schema *would* accept a 7-day ordinary upload grant: `addOrdinaryGrantIssues`
(`artifacts.ts:396-407`) asserts only `expiresAt > issuedAt`, while quarantine is capped at
`QUARANTINE_MAX_TTL_MS = 5 * 60 * 1000` in **two** places (`artifacts.ts:541,567` and
`quarantine-grant.ts:37`). **That asymmetry is real and undocumented.** Mirroring it into the frozen
schema is the *right* hardening and is an E4-D02 STOP, so it is **recorded as a follow-up, not taken
here**. The service clamp gets the safety now.

**4.2 — Record the grant as an intent at mint.** Write the durable row the mint currently omits:
object key, artifact id, job/attempt, the fence it was minted under, and `expiresAt`. This is what
`job_artifacts.expires_at` was shipped for.

**This is the piece that makes everything else possible.** An orphan becomes discoverable **by its
own record**, so nothing needs to enumerate the bucket and the storage port stays unchanged.

**4.3 — Sweep by record, using the `deleteObject` that already exists.** For each intent whose
`expiresAt` has passed and which never committed: delete the object, clear the record. No new
storage capability, no scanning.

## ★ 5. The trap this design must not fall into

**A sweeper that deletes an in-flight upload is worse than the orphan it removes.**

The only signal available is age — there is no "upload in progress" marker, and S3 gives no
visibility into a PUT that has not completed. So the sweep boundary must be **strictly after the
grant can no longer be redeemed**: `expiresAt` has passed, therefore the presigned URL is dead,
therefore no honest upload can still land. A sweep keyed on anything earlier than `expiresAt` — a
lease ending, an attempt being superseded — can race a legitimate in-flight PUT.

That is also why §4.1 comes first: a shorter TTL makes the safe sweep boundary arrive sooner.

## 6. What this deliberately does NOT do

- **Does not revoke grants.** No revocation concept exists, and a presigned URL cannot be recalled
  without rotating the signing credential. The TTL *is* the revocation mechanism; §4.1 shortens it.
- **Does not enforce `maxBytes` at write time.** Worth stating because the terrain found it is
  advisory and dropped: `s3-provider.ts:114-142` builds `PutObjectCommand` with no `ContentLength`
  and no content-length-range condition, so **a presigned PUT admits an unbounded write for its
  whole TTL**; only commit checks the 5 GiB ceiling, post-hoc (`artifact-commit.ts:71,121`). An
  orphan can therefore be arbitrarily large. Closing that needs a signed policy condition — its own
  ticket, named in §8.
- **Does not enforce retention for committed artifacts** (§3).

## 7. Tests

| Area | Test |
|---|---|
| TTL clamp | a service constructed with an absurd TTL is clamped; the floor of 30 still holds |
| Intent recorded | minting a grant writes a durable record with the fence and `expiresAt` |
| Commit clears it | a successful commit leaves no sweepable record |
| ★ Orphan swept | fence lost mid-flight, PUT lands, commit refuses `stale_fence`, sweep removes it |
| ★ In-flight NOT swept | an intent whose `expiresAt` has **not** passed is never swept — the §5 trap, pinned |
| Anti-vacuity | a sweep run that examined zero records reports it rather than "OK" |
| Fail-closed | `local_disk` (no `presignPut`) still fails closed at mint, unchanged |

## 8. Follow-ups this slice names rather than absorbs

1. **Frozen TTL ceiling for ordinary grants**, mirroring quarantine (§4.1) — E4-D02 STOP.
2. **Retention enforcement for committed artifacts**, especially `CREDENTIAL_BEARING_ARTIFACT_KINDS`
   (§3) — a live gap today, and the reason the mechanism here is record-driven so it can be reused.
3. **`maxBytes` enforced at write** via a signed content-length-range condition (§6).
