# Worker protocol v1 conformance corpus

This directory holds the checked-in, byte-frozen conformance corpus for the
`@armyofagents/worker-protocol` wire contract (Epic E1 / PRT-006). It is the
context-free **syntax** corpus: every vector is validated only against the four
V1 schemas below, with no company/tenant/policy state.

## Files

| File | Purpose |
|---|---|
| `conformance.json` | `contractVersion` + the named accept/reject vectors, each `{ name, schema, valid, preserveKeys?, input }`. |
| `manifest.sha256` | The SHA-256 of every contract input, one `<hex>  <file>` line, LF-only. The manifest never hashes itself. |
| `README.md` | This document. |

## Schemas

Each case's `schema` selects one validator:

- `job` → `jobEnvelopeV1Schema`
- `lease_offer` → `leaseOfferV1Schema`
- `event_batch` → `workerEventBatchV1Schema`
- `target_worker_pair` → `registeredTargetProfileV1Schema` + `workerHelloV1Schema` +
  `jobCapabilityRequirementsSchema` + `verifyAndBrandProviderConstraintProfileV1`
  + `workerSatisfiesRequirements` (the negotiation intersection).

`src/contract.test.ts` asserts `safeParse().success === valid` for each case and,
for accepted objects, that every `preserveKeys` field survives parsing unchanged.

## Scope boundary

This corpus proves **context-free syntax** only. It deliberately does **not**
carry a false sentinel-rejection vector: the syntax schema accepts any well-formed
Organization UUID because it cannot know whether an ID is reserved, mapped, or
authorized. Reserved/unmapped-tenant admission and requester-authority mismatch are
**policy** conformance owned by TEN-006 and JOB-001 / JOB-010, before job creation.
Transport, control, and error contracts plus the complete-v1 frozen baseline and
the future-compatibility (cross-version) harness are owned by PRT-007.

## Evolution rules

- **Additive-only within v1.** New optional fields and new enum members are allowed
  only when they cannot change the accept/reject decision for an existing vector.
- **Unknown enum values are rejected** (fail closed). Consumers must never coerce or
  silently drop an unknown discriminant, capability, operation, or status.
- **Bytes are frozen.** Any change to `conformance.json` requires regenerating the
  manifest with `pnpm gen:worker-protocol-contract` and re-running the byte checks
  (`node scripts/update-worker-protocol-contract-manifest.mjs --check`) on both
  Linux and Windows. The bytes are LF-only, UTF-8, no BOM, with a final newline.
- **Protocol Custodian approval is required** for any change to these bytes, because
  every downstream implementation validates against this exact corpus.
