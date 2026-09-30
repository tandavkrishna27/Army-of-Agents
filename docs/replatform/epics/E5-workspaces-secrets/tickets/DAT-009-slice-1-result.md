# DAT-009 slice 1 Result — the provider-side export capability

**Status:** LANDED. **Start SHA:** `8f345d9fa` ([`DAT-009-slice-1-design.md`](./DAT-009-slice-1-design.md)).
**Unblocks:** slice 3 (the worker-side consumer) and Lane B's BRW-003.

---

## 1. What landed

`SandboxProvider` gains `digestArtifact`, `exportArtifact`, and an `artifactExportMode`
declaring support — all in `packages/worker-daemon`, which is **not frozen**.

**`git diff packages/worker-protocol/src` is EMPTY.** That is the whole point of REVISION 2:
the capability is advertised through the frozen `artifact.direct_upload` that already exists, so
no frozen change, no custodian STOP, no D0-T04 corpus.

| Guard | Result |
|---|---|
| `check-worker-daemon-boundary` (E4-D01) | PASS — only `worker-protocol` + `pino` + node builtins |
| `check-frozen-worker-protocol-consumer` | PASS |
| `check-sandbox-e2b-provider-boundary` | PASS |
| worker-daemon suite | 119 files / **677 tests** |
| sandbox-e2b-provider suite | 39 tests |
| server typecheck (the barrel changed) | clean |

**Mutation: 7 mutants, 7 killed.**

## ★ 2. The mutant that matters

**M1 — a digest fabricated for a path that does not exist.** That is the WRK-009 defect exactly:
a fabricated result is byte-identical to a real one on every downstream gate, so nothing could
tell. Here it would mint a grant against a hash and size for bytes that never existed, and commit
would refuse far away from the cause. Killed.

M5 (content leaking into the digest result) and M6 (retaining the whole grant instead of the
object key) are the other two worth naming — they are the two ways this capability could quietly
reverse the decision it implements.

## 3. Three design points, each copying an existing seam

**Advertisement is two layers, deliberately not collapsed.** `advertisedOperations` is typed to
the FROZEN `ProviderOperation` union, so these operations cannot appear there — and do not need
to. *"Can THIS provider export?"* is answered locally by `artifactExportMode`; *"should placement
route here?"* is answered server-side by the frozen `artifact.direct_upload` capability.
`checkpointMode`/`healthMode` already sit on this port for exactly the first purpose.

**`UnsupportedProviderOperation` was widened**, additively, to a local `DeclinableOperation`
union. The frozen `ProviderOperation` could not express a decline for a non-frozen operation —
the frozen vocabulary constraining a place I had not anticipated. Every existing caller still
typechecks.

**The grant is a bearer capability and the port already knew it.** `InspectResult` carries
`objectGrants` among its sensitive fields and `RedactedResourceProjection` excludes it. Honoured,
not re-litigated: a test asserts the double retains only the object key, never the signed URL.

## 4. E2B declines honestly

`E2bSandboxProvider` declares `artifactExportMode = "none"` and throws from both methods. Its
transport already has `readFile`, so a real implementation is a small provider-specific piece —
but it is explicitly out of scope here, and **declaring support it does not have would be the
fabrication defect again**.

## 5. Not done

- **No real E2B implementation** (§4).
- **`packages/sandbox-provider-contract` untouched** — its driver is keyed by the frozen
  operation union, so a conformance case for these two cannot live there without the frozen
  change REVISION 2 established is unnecessary. Reconciling the two ports remains E6-F008.
- **Advertisement DATA** — adding `artifact.direct_upload` to real targets' `capabilityCeiling`
  and to browser jobs' `requiredCapabilities`. Configuration, and item 3 of the decision's list.
