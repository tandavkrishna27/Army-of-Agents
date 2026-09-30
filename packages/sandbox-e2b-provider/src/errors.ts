// -----------------------------------------------------------------------------
// Denial classes the E2B driver + its invoke-adapter throw (CLI-001/D1).
//
// The authority denials are the EXACT worker-daemon classes (re-exported here for
// one import site): `EffectAuthorityWithdrawnError`, `CleanupAuthorityDeniedError`
// (with `.attemptedOperation`), `ResourceNotAvailableError`, `SandboxNotFoundError`,
// and `UnsupportedProviderOperation` (with `.operation`). Reusing the real classes
// (not shape-mirrors) means a real adapter conforms to the DEP-008 suite's
// duck-typed `name`+discriminant assertions against production identities.
//
// `SandboxEgressDeniedError` is the ONE denial worker-daemon has no class for
// (its egress denial is an EVENT payload carrying a `NetworkDenialClass`, not a
// thrown error). It is defined here, provider-neutral, carrying the frozen
// destination class as `destinationClass` — matched by-name in the isolation suite.
// -----------------------------------------------------------------------------

export {
  EffectAuthorityWithdrawnError,
  CleanupAuthorityDeniedError,
  ResourceNotAvailableError,
  SandboxNotFoundError,
  UnsupportedProviderOperation,
  // SVC-008a — a launch that could not be acknowledged, and a record whose lifecycle
  // state could not be classified. Same reuse rule as above: these are the worker-daemon
  // classes, not shape-mirrors, so `instanceof` works across the seam — which for
  // `SandboxRecordIndeterminateError` is load-bearing rather than tidy: `CleanupAuthority`
  // must RECOGNIZE it to keep an unreadable record from disarming the forced destroy.
  ProcessLaunchNotAcknowledged,
  SandboxRecordIndeterminateError,
} from "@armyofagents/worker-daemon";

/**
 * Provider-neutral egress denial. Thrown when an active-fence egress attempt is
 * refused; `destinationClass` carries the frozen network-denial class
 * (`metadata` / `private` / `control_plane` / `not_allowlisted`) as an opaque
 * label — no new NETWORK_DENIAL vocabulary is minted. Matched duck-typed
 * (`name` + `destinationClass`) by `runSandboxIsolationConformance` §2.6.
 */
export class SandboxEgressDeniedError extends Error {
  readonly destinationClass: string;
  constructor(destinationClass: string) {
    super(`egress denied: ${destinationClass}`);
    this.name = "SandboxEgressDeniedError";
    this.destinationClass = destinationClass;
  }
}
