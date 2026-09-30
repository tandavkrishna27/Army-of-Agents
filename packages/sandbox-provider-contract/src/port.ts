// -----------------------------------------------------------------------------
// Provider-neutral sandbox provider-driver PORT (DEP-000-internal).
//
// This is a DEP-000-internal, provider-neutral driver contract defined OVER the
// frozen E1 `PROVIDER_OPERATIONS` vocabulary; it invents no operation. It is
// opaque/provider-neutral, addressed by an opaque `providerId`, carrying NO E2B
// or tenant fields (CAV-002). A driver is exercised through a SINGLE
// `invoke(op, args)` method keyed by the frozen `ProviderOperation` union, so the
// operation surface is EXACTLY the eight mandatory + three optional registered
// operations. Structural typing lets a conforming double satisfy it WITHOUT
// importing this module (the fake does exactly that, keeping its runtime
// dependency set to `@armyofagents/worker-protocol` + `zod` + Node built-ins).
//
// SETTLED (DEP-010, Sprint 2, decision D2 — finding E6-F008 RESOLVED). This is NOT
// worker-daemon's authoritative `SandboxProvider`, and it is deliberately not meant
// to be. worker-daemon's `SandboxProvider`
// (`packages/worker-daemon/src/supervisor/provider.ts`) is a PER-OPERATION method
// surface (`create`/`execute`/`cancel`/`kill`/`destroy`/`list`/`inspect`/
// `reconcileCleanup` + optional `checkpoint`/`restore`/`health`, each its own method
// taking real supervisor context) and is THE authoritative provider port of record
// (D1). This `SandboxProviderDriver` is a DIFFERENT shape — a single
// provider-neutral `invoke(op, args)` dispatcher — DEMOTED to a conformance-harness
// surface: the two conformance suites (`runSandboxProviderContract`,
// `runSandboxIsolationConformance`) drive it, and nothing in production speaks it.
// The two are bridged in ONE direction only — authoritative per-op → harness driver
// — through the shipped `perOpToInvokeDriver` adapter
// (`packages/sandbox-e2b-provider/src/per-op-adapter.ts`); there is no driver → per-op
// adapter, by design (a fabricating provider must never sit one import from a
// production path). Nothing here imports worker-daemon.
// -----------------------------------------------------------------------------

import {
  CORE_PROVIDER_OPERATIONS,
  OPTIONAL_PROVIDER_OPERATIONS,
  PROVIDER_OPERATIONS,
  type ProviderOperation,
} from "@armyofagents/worker-protocol";

export { CORE_PROVIDER_OPERATIONS, OPTIONAL_PROVIDER_OPERATIONS, PROVIDER_OPERATIONS };
export type { ProviderOperation };

/** An opaque, provider-neutral handle to a live sandbox resource. NO tenant/E2B
 * fields (no organizationId/companyId/region/template/credentials) ever appear. */
export interface ProviderResourceRef {
  readonly providerId: string;
  readonly resourceId: string;
}

/** Deadline/idempotency/pagination controls carried on a driver invocation. */
export interface ProviderPageRequest {
  readonly cursor?: string | null;
  readonly limit?: number;
}

/**
 * The provider-neutral, opaque argument bag for a driver invocation. Only
 * provider-neutral fields: an idempotency key (create replay), an optional
 * deadline (hang modelling), a target `resourceId`, pagination, and an opaque
 * `params` map the harness treats as a black box. NO tenant identifiers.
 */
export interface ProviderOpArgs {
  readonly providerId: string;
  readonly resourceId?: string;
  readonly idempotencyKey?: string;
  readonly deadlineMs?: number;
  readonly page?: ProviderPageRequest;
  readonly params?: Readonly<Record<string, unknown>>;
}

/** The ONLY keys a redacted list/inspect projection may carry. Anything else is a
 * leak (E6F-05 no-tenant-disclosure); the contract asserts the projection's key
 * set is a subset of this allowlist. */
export const PROVIDER_PROJECTION_KEYS = [
  "providerId",
  "resourceId",
  "state",
  "checkpoint",
] as const;

/** A redacted, provider-neutral projection of a live resource returned by
 * `list`/`inspect`. `state` and `checkpoint` are opaque provider-neutral labels. */
export interface ProviderResourceProjection {
  readonly providerId: string;
  readonly resourceId: string;
  readonly state: string;
  readonly checkpoint: string;
}

/** The frozen allowlist as a set, for O(1) membership. */
const PROJECTION_KEY_SET: ReadonlySet<string> = new Set(PROVIDER_PROJECTION_KEYS);

/**
 * Return the keys of `projection` that are NOT in the provider-neutral allowlist
 * (`PROVIDER_PROJECTION_KEYS`) — every such key is a tenant/E2B disclosure
 * (E6F-05 no-tenant-leak). This is the SINGLE shared allowlist gate both the
 * happy-path contract suite AND the DEP-008 hostile isolation suite use, so no
 * forked copy can silently drift (DEP-008 D1). `Object.keys` sees the real runtime
 * key-set, so a sabotaged driver that widens the projection with an extra field is
 * caught even though the static `ProviderResourceProjection` type has none.
 */
export function projectionLeakKeys(projection: ProviderResourceProjection): string[] {
  return Object.keys(projection).filter((key) => !PROJECTION_KEY_SET.has(key));
}

export interface ProviderListResult {
  readonly resources: readonly ProviderResourceProjection[];
  readonly nextCursor: string | null;
}

/** `reconcile_cleanup` returns a STATUS and never throws (mirror of the WRK-004
 * cleanup contract): a cleanup that fails is reported, not raised. */
export interface ProviderCleanupResult {
  readonly cleanupStatus: "success" | "failed";
}

/** The discriminated result of a driver invocation. `deduplicated` marks an
 * idempotency-key replay of `create`; `faultInjected` marks a scripted fault. */
export type ProviderOpResult =
  | { readonly kind: "created"; readonly resource: ProviderResourceRef; readonly deduplicated: boolean }
  | { readonly kind: "executed"; readonly terminalState: string; readonly faultInjected: boolean; readonly timedOut: boolean }
  | { readonly kind: "acknowledged"; readonly op: "cancel" | "kill" | "destroy"; readonly faultInjected: boolean }
  | { readonly kind: "list"; readonly list: ProviderListResult }
  | { readonly kind: "inspect"; readonly projection: ProviderResourceProjection | null }
  | { readonly kind: "cleanup"; readonly cleanup: ProviderCleanupResult }
  | { readonly kind: "checkpoint"; readonly checkpointId: string }
  | { readonly kind: "restore"; readonly checkpointId: string }
  | { readonly kind: "health"; readonly healthy: boolean };

/** Raised when an OPTIONAL provider operation is invoked on a provider that does
 * not advertise it (negotiation contract). Core operations never raise this. The
 * field is `operation` — aligned with worker-daemon's authoritative
 * `UnsupportedProviderOperation` (`.operation`), not the legacy `.op`. */
export class UnsupportedProviderOperation extends Error {
  readonly operation: ProviderOperation;
  constructor(operation: ProviderOperation) {
    super(`provider operation not supported: ${operation}`);
    this.name = "UnsupportedProviderOperation";
    this.operation = operation;
  }
}

/**
 * The provider-driver port. `supportedOperations()` must include every core
 * operation and may include optional ones; `invoke` dispatches by the frozen
 * operation name and raises `UnsupportedProviderOperation` for an unadvertised
 * optional operation. Any value outside `PROVIDER_OPERATIONS` is a programming
 * error the provider rejects.
 */
export interface SandboxProviderDriver {
  readonly providerId: string;
  supportedOperations(): readonly ProviderOperation[];
  invoke(op: ProviderOperation, args: ProviderOpArgs): Promise<ProviderOpResult>;
}

/** A factory the conformance suite calls to obtain a FRESH driver (clean state)
 * for each independent check. */
export type SandboxProviderDriverFactory = () => SandboxProviderDriver | Promise<SandboxProviderDriver>;
