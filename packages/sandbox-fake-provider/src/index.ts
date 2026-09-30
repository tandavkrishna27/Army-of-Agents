// Public surface of the deterministic fixture-driven fake sandbox provider.
// Explicit re-exports only (no `export *`).

export {
  FakeSandboxProvider,
  createFakeSandboxProvider,
  UnsupportedProviderOperation,
  LIFECYCLE_CHECKPOINTS,
} from "./fake-driver.js";
export type {
  FakeSandboxProviderOptions,
  FakeSandboxDriver,
  SandboxProviderDriver,
  ProviderOpArgs,
  ProviderPageRequest,
  ProviderResourceRef,
  ProviderResourceProjection,
  ProviderListResult,
  ProviderCleanupResult,
  ProviderOpResult,
  ScriptInput,
  ReplayResult,
  LifecycleCheckpoint,
  FailureInjection,
} from "./fake-driver.js";

export {
  createControlServer,
  startControlServer,
  loadFixtureFromDir,
  defaultGoldenFixturesDir,
} from "./control-server.js";
export type { ControlServerOptions, StartedControlServer } from "./control-server.js";

export {
  validateFixture,
  emitFixtureEvents,
  derivePlan,
  isLifecycleCheckpoint,
  FixtureValidationError,
} from "./fixture-runtime.js";
export type { ValidatedFixture, RunStep, RunPlan } from "./fixture-runtime.js";

export { InvocationLedger } from "./invocation-ledger.js";
export type { InvocationLedgerEntry, FakeClockOptions } from "./invocation-ledger.js";

export { sha256Hex } from "./hash.js";

// DEP-008 — the HOSTILE reference driver (a distinct SandboxProviderDriver) and its
// mirrored authority errors. Used by the sibling package's isolation conformance
// suite; also passes the DEP-000 happy-path suite as a regression guard.
export {
  HostileSandboxProvider,
  createHostileSandboxProvider,
  HOSTILE_MAX_DESTROY_ATTEMPTS,
  EffectAuthorityWithdrawnError,
  CleanupAuthorityDeniedError,
  ResourceNotAvailableError,
  SandboxEgressDeniedError,
} from "./hostile-driver.js";
