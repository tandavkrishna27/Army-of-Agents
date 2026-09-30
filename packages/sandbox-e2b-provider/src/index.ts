// Public surface of the E2B sandbox provider (CLI-001). Explicit re-exports only.

export { E2bSandboxProvider, DEFAULT_ADVERTISED_OPTIONAL_OPS } from "./e2b-provider.js";
export type { E2bSandboxProviderOptions } from "./e2b-provider.js";

// The E6-F008 bridge: any per-op SandboxProvider → the neutral invoke-driver.
export { perOpToInvokeDriver } from "./per-op-adapter.js";
export type { PerOpToInvokeDriverOptions } from "./per-op-adapter.js";

// The injectable transport seam + its error vocabulary.
export type {
  E2bTransport,
  E2bCreateRequest,
  E2bRunCommandRequest,
  E2bListRequest,
  E2bCommandResult,
  E2bSignalResult,
  E2bListPage,
  E2bSandboxRecord,
  E2bRecordState,
  E2bStagedFile,
  // SVC-008a — the transport-scope process-supervision seam.
  E2bProcessSupervisionMode,
  E2bProcessHandle,
  E2bProcessObservation,
  E2bProcessStartResult,
  E2bProcessSignalResult,
  E2bStartProcessRequest,
} from "./transport.js";
export {
  E2bTransportNotFoundError,
  E2bTransportTransientError,
  E2bTransportEgressBlockedError,
  E2bProcessLaunchNotAcknowledgedError,
} from "./transport.js";

// The deterministic, key-less mock transport (no-key core proof).
export { MockE2bTransport, createMockE2bTransport } from "./mock-transport.js";
export type { MockE2bTransportOptions } from "./mock-transport.js";

// The `e2b` SDK binding (keyed real-E2B lane only).
export { RealE2bTransport, createRealE2bTransport } from "./real-transport.js";
export type { RealE2bTransportOptions } from "./real-transport.js";

// Denials the driver + adapter throw (worker-daemon classes re-exported + the
// package-local egress denial).
export {
  EffectAuthorityWithdrawnError,
  CleanupAuthorityDeniedError,
  ResourceNotAvailableError,
  SandboxNotFoundError,
  UnsupportedProviderOperation,
  SandboxEgressDeniedError,
  // SVC-008a — an unacknowledged launch, and an unclassifiable sandbox record.
  ProcessLaunchNotAcknowledged,
  SandboxRecordIndeterminateError,
} from "./errors.js";

// The reserved fault/canary directive key names. Exported so a cross-package conformance
// suite can drive the mock's fault levers by the SHARED constant rather than by
// hand-copied string literals — this module is deliberately "the ONE place the reserved
// key names live ... so they can never silently drift", and a suite that re-typed them
// would be the drift.
export { DIRECTIVE_KEYS, METADATA_KEYS } from "./directives.js";

// The capability-matrix disposition fixture (D5).
export { CLI_001_CAPABILITY_MATRIX } from "./capability-matrix.js";
export type {
  CapabilityMatrix,
  OperationDisposition,
  IsolationCaseDisposition,
  VerifiedBy,
} from "./capability-matrix.js";
