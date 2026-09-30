# DAT-009 slice 1 — Design: the provider-side export capability

**Status:** DESIGN. **Start SHA:** the commit that adds this file.
**Unblocked by:** [`DECISION-byte-egress-and-provider-topology.md`](../../../DECISION-byte-egress-and-provider-topology.md)
REVISION 2 — the E4-D02 STOP does not apply.
**Unblocks:** DAT-009 slice 3 (the worker-side consumer) and Lane B's BRW-003.

---

## 1. Scope, corrected by REVISION 2

Slice 1 was originally "the contract capability + fake-provider implementation + conformance
suite". **That scope was wrong**, and the reason matters:

`packages/sandbox-provider-contract`'s `SandboxProviderDriver` is a single `invoke(op, args)`
keyed by the **frozen** `ProviderOperation` union, and its header states it is defined over that
vocabulary and *"invents no operation"*. **A new operation cannot be added there without a
frozen change** — which REVISION 2 established is unnecessary and should not be made.

So slice 1 lands on **`packages/worker-daemon`'s `SandboxProvider`**, the per-operation method
surface, which is **not frozen**. The contract package is untouched. (Reconciling the two ports
is a pre-existing open item, E6-F008; this ticket does not touch it either.)

## 2. Two operations, because the frozen grant request forces it

`artifactTransferGrantRequestV1Schema` requires **both** `expectedSha256` and `maxBytes`, so the
worker must know the digest and size *before* it can mint a grant — and only the provider can see
inside the sandbox.

```ts
digestArtifact(sandboxId, path, ctx): Promise<{ sha256: string; sizeBytes: number }>
exportArtifact(sandboxId, path, grant, ctx): Promise<{ objectKey: string }>
```

**`digestArtifact` returns METADATA ONLY — never content.** That is what keeps the port's
no-bytes property true: the digest step describes the file, the export step moves it
provider → S3, and neither hands bytes to the daemon.

**`exportArtifact` returns a REFERENCE**, not bytes.

## ★ 3. Advertisement: a local mode, plus the frozen capability — two different layers

`advertisedOperations` is `ReadonlySet<ProviderOperation>` — the **frozen** union — so these
operations cannot appear there. That is fine, because two separate questions are being answered:

| Question | Answered by |
|---|---|
| *Can THIS provider export?* (local, per-implementation) | `artifactExportMode: "none" \| "grant_upload"` |
| *Should placement route this job HERE?* (server-side, per-target) | the frozen `artifact.direct_upload` capability in `capabilityCeiling` |

The mode field **copies the established seam exactly**: `checkpointMode` and `healthMode` already
sit on this port for precisely this purpose — an optional capability declared by a mode, with the
methods present on every implementer and gated on the declaration. `CHECKPOINT_MODES` /
`HEALTH_MODES` are frozen, so `ArtifactExportMode` is defined **locally** in worker-daemon and
deliberately does **not** enter the frozen `registeredTargetProfileV1Schema`.

## 4. The grant is a bearer secret, and the port already knows it

`InspectResult` already carries `objectGrants: readonly string[]` among its **sensitive** fields
(`command`/`env`/`logs`/`workspaceBytes`/`objectGrants`/`secrets`), and
`RedactedResourceProjection` — the only shape cleanup authority ever returns — excludes it.

So the classification exists and is enforced. This ticket **honours it rather than re-litigating
it**: a grant handed to `exportArtifact` is the same class of value, and must never reach a
redacted projection, a log line, or an error message.

## 5. Failure behaviour

A provider whose `artifactExportMode` is `"none"` throws `UnsupportedProviderOperation` from both
methods — the same decline path the existing optional trio uses. The methods are **present on
every implementer**; only support is optional. That is what makes "mandatory means no absent
path" hold here as it does for checkpoint/restore/health.

## 6. Tests

| Area | Test |
|---|---|
| ★ `digestArtifact` returns metadata ONLY | the result shape carries no content field |
| Digest and size are the file's actual values | fixture bytes → known sha256 + length |
| ★ `exportArtifact` returns a REFERENCE, not bytes | result shape carries no body |
| ★ `mode: "none"` declines both, via `UnsupportedProviderOperation` | not a silent no-op, and not a fabricated success |
| The grant never appears in a redacted projection | inspect-after-export carries no grant |
| An unknown path fails rather than fabricating a digest | the WRK-009 lesson: a fabricated success is byte-identical to a real one |

## 7. Out of scope

- **`packages/sandbox-provider-contract`** (§1) — it is bound to the frozen vocabulary.
- **The worker-side consumer** — slice 3: digest → mint grant → export → commit.
- **Advertisement DATA** — adding `artifact.direct_upload` to real targets' `capabilityCeiling`
  and to browser jobs' `requiredCapabilities`. That is configuration, not code, and it is item 3
  of the decision's ordered list.
- **A real E2B implementation.** `packages/sandbox-e2b-provider` already has
  `transport.readFile`; wiring it is a separate, provider-specific piece.
