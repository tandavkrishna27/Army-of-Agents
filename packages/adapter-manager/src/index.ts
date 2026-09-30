// Public surface of the adapter-manager package (DEP-012 Slice 1 · Units A + B1 + B2).
// The out-of-process networked host of the per-op `SandboxProvider`.

export { createProviderServer } from "./server.js";
export type { CreateProviderServerOptions } from "./server.js";

export { CapabilityVerificationError, verifyOwnedLabelsCapability } from "./capability-verify.js";
export { gateList, gateOwnedOp, redactProjection, verifyOrUniform } from "./owned-op-gate.js";
export type { OwnedOpGateDeps } from "./owned-op-gate.js";

// DEP-012 Slice 3 · Wave β1 — the create-gate + the durable ledger + the AM-local locks.
export { gateCreate } from "./create-gate.js";
export type { CreateGateDeps } from "./create-gate.js";
export { IdempotencyLedger, IdempotencyLedgerError } from "./idempotency-ledger.js";
export type { IdempotencyLedgerOptions, LedgerRecord, LedgerFs } from "./idempotency-ledger.js";
export { KeyedMutex } from "./keyed-mutex.js";
