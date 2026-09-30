// Public surface of the provider-neutral sandbox provider-driver contract.
// Explicit re-exports only (no `export *`) so every contract-surface change is
// visible in review.

export {
  CORE_PROVIDER_OPERATIONS,
  OPTIONAL_PROVIDER_OPERATIONS,
  PROVIDER_OPERATIONS,
  PROVIDER_PROJECTION_KEYS,
  UnsupportedProviderOperation,
  projectionLeakKeys,
} from "./port.js";
export type {
  ProviderOperation,
  ProviderResourceRef,
  ProviderPageRequest,
  ProviderOpArgs,
  ProviderResourceProjection,
  ProviderListResult,
  ProviderCleanupResult,
  ProviderOpResult,
  SandboxProviderDriver,
  SandboxProviderDriverFactory,
} from "./port.js";

export { LIFECYCLE_CHECKPOINTS, isLifecycleCheckpoint } from "./checkpoints.js";
export type { LifecycleCheckpoint, FailureInjection } from "./checkpoints.js";

export { GOLDEN_JOURNEY_FIXTURES, loadGoldenFixture } from "./vectors.js";
export type { GoldenJourneyFixtureName } from "./vectors.js";

export { runSandboxProviderContract, assertContractReport, runCheck } from "./contract.js";
export type { ContractCheckResult, ContractReport, ContractOptions, CheckFn } from "./contract.js";

// DEP-008 — the provider-neutral HOSTILE isolation/cleanup conformance suite.
export { runSandboxIsolationConformance, assertIsolationReport } from "./isolation-contract.js";
export type { IsolationOptions } from "./isolation-contract.js";
