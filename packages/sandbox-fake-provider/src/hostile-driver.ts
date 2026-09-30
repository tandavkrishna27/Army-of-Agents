// -----------------------------------------------------------------------------
// HostileSandboxProvider — the DEP-008 HOSTILE reference driver (DE-17 / DE-26).
//
// A SEPARATE `SandboxProviderDriver` (NOT the benign `FakeSandboxDriver`, which
// vacuously passes every hostile probe: its `reconcile_cleanup` always clears +
// succeeds and its `destroy` always acknowledges — no fence, no governed-effect
// model, nothing sensitive to redact). This driver MODELS, provider-neutrally over
// the frozen invoke-driver port, the hostile isolation/cleanup invariants a managed
// sandbox adapter must pass before tenant canary:
//
//   * effect-authority withdrawal is TERMINAL + idempotent (mirror of
//     worker-daemon `EffectAuthorityWithdrawnError`): post-fence, every governed
//     effect op is denied while the narrow cleanup authority stays usable;
//   * the cleanup-authority facet STRUCTURALLY denies create/execute/resume/
//     checkpoint/health/openEgress (mirror of `CleanupAuthorityDeniedError`);
//   * NO existence oracle — a cross-resource, wrong-generation, or absent cleanup
//     target collapses to ONE `ResourceNotAvailableError` identity (fixed message);
//   * monotonic none→cancel→kill→destroy convergence with a bounded destroy-retry
//     ceiling, leaving zero live resources; an empty pass never fails open;
//   * a resource holds SYNTHETIC sensitive canaries (command/env/logs/secret) +
//     credential/tenant/customer canaries that NEVER cross the redacted projection;
//   * post-fence `openEgress` denied; active-fence egress to a non-allowlisted /
//     metadata / private / control-plane destination refused carrying the class;
//   * bounded TTL / cancel / kill / destroy-failure / crash / outage / leak faults.
//
// It is provider-neutral: opaque `providerId`/`resourceId` only, NO tenant/E2B
// field (CAV-002). Every hostile lever rides the opaque `params` bag the port
// already treats as a black box (DEP-008 D3) — no new op, no frozen edit. With NO
// hostile params on the default effect facet under an active fence it behaves
// exactly like the benign fake, so it ALSO passes the DEP-000 happy-path suite (a
// regression guard). Runtime deps: `@armyofagents/worker-protocol` + Node globals
// (the boundary — it imports NO worker-daemon; the authority errors are MIRRORED
// by shape, not imported).
//
// ── Hostile `params` protocol (all optional) ─────────────────────────────────
//   withdrawEffectAuthority: true   — latch TERMINAL withdrawal of effect authority
//   authority: "cleanup"            — act on the cleanup-authority facet
//   openEgress: true                — request to open egress (a pseudo-op)
//   egress: { classification }      — on execute (effect facet): non-"allow" refuses
//   sensitive: { command,env,logs,secret }        — seed §2.5 canaries on create
//   secrets:   { providerCredential,tenantId,customerByte } — seed §2.7 canaries
//   resourceGeneration: number      — the created resource's generation (default 1)
//   targetGeneration: number        — the caller's asserted generation (cleanup ops)
//   faults: { ignoreCancel, ignoreKill, destroyFailures } — per-resource, on create
//   lifecycleFault: "crash" | "outage" | "ttl"   — bounded fault (execute/reconcile)
//   emptyPass: true                 — reconcile an intentionally-empty pass
// -----------------------------------------------------------------------------

import {
  CORE_PROVIDER_OPERATIONS,
  OPTIONAL_PROVIDER_OPERATIONS,
  PROVIDER_OPERATIONS,
  type ProviderOperation,
} from "@armyofagents/worker-protocol";

import type {
  ProviderCleanupResult,
  ProviderListResult,
  ProviderOpArgs,
  ProviderOpResult,
  ProviderPageRequest,
  ProviderResourceProjection,
  SandboxProviderDriver,
} from "./fake-driver.js";
import { UnsupportedProviderOperation } from "./fake-driver.js";

// --- Mirrored authority errors (by SHAPE, never imported from worker-daemon) --

/** Mirror of worker-daemon `EffectAuthorityWithdrawnError` — thrown by every
 * governed effect op once the effect authority is withdrawn. The message is
 * byte-identical to the production class so a real adapter throwing its OWN
 * cross-package error conforms duck-typed (by `name`), without importing this. */
export class EffectAuthorityWithdrawnError extends Error {
  readonly leaseId: string;
  constructor(leaseId = "hostile-lease") {
    super("effect authority has been withdrawn; only the cleanup authority may act");
    this.name = "EffectAuthorityWithdrawnError";
    this.leaseId = leaseId;
  }
}

/** Mirror of worker-daemon `CleanupAuthorityDeniedError` — thrown for EVERY
 * effectful op attempted on the cleanup-authority facet. */
export class CleanupAuthorityDeniedError extends Error {
  readonly attemptedOperation: string;
  constructor(attemptedOperation: string) {
    super(`cleanup authority may never ${attemptedOperation}`);
    this.name = "CleanupAuthorityDeniedError";
    this.attemptedOperation = attemptedOperation;
  }
}

/** Mirror of worker-daemon `ResourceNotAvailableError` — the UNIFORM denial for a
 * truly-absent AND a non-matching (cross-resource / wrong-generation) cleanup
 * target. The message is FIXED (it must not encode which case occurred), so the
 * cleanup surface can never be used as an existence oracle. */
export class ResourceNotAvailableError extends Error {
  constructor() {
    super("resource not available");
    this.name = "ResourceNotAvailableError";
  }
}

/** Provider-neutral egress denial carrying the frozen destination class (no new
 * NETWORK_DENIAL_CLASS — the class rides through as an opaque injected label). */
export class SandboxEgressDeniedError extends Error {
  readonly destinationClass: string;
  constructor(destinationClass: string) {
    super(`egress denied: ${destinationClass}`);
    this.name = "SandboxEgressDeniedError";
    this.destinationClass = destinationClass;
  }
}

// --- Internal state ----------------------------------------------------------

interface ResourceFaults {
  ignoreCancel: boolean;
  ignoreKill: boolean;
  /** Remaining destroy attempts that FAIL before the resource is reclaimed. */
  destroyFailures: number;
}

interface HostileResource {
  resourceId: string;
  generation: number;
  state: string;
  checkpoint: string;
  faults: ResourceFaults;
  /** Synthetic sensitive detail held ONLY inside the double — proven absent from
   * every projection/result. Never a tenant/E2B field (CAV-002). */
  sensitive: Record<string, string>;
}

const PROVIDER_OPERATION_SET: ReadonlySet<string> = new Set(PROVIDER_OPERATIONS);
const OPTIONAL_OPERATION_SET: ReadonlySet<string> = new Set(OPTIONAL_PROVIDER_OPERATIONS);
const EFFECT_OPS: ReadonlySet<string> = new Set(["create", "execute", "checkpoint", "restore", "health"]);

/** The default retry ceiling the internal convergence honors (mirror of the
 * worker-daemon `converge` default). Bounded — never an unbounded loop. */
export const HOSTILE_MAX_DESTROY_ATTEMPTS = 3;

function readParams(args: ProviderOpArgs): Readonly<Record<string, unknown>> {
  return (args.params ?? {}) as Readonly<Record<string, unknown>>;
}

function asRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/**
 * One hostile driver instance with its OWN state. The isolation suite obtains a
 * FRESH provider (hence fresh state) per check via
 * `() => createHostileSandboxProvider().makeDriver(id)`, mirroring the DEP-000
 * self-check factory shape.
 */
export class HostileSandboxProvider {
  makeDriver(
    providerId: string,
    config: { optionalOps?: readonly ProviderOperation[]; maxDestroyAttempts?: number } = {},
  ): SandboxProviderDriver {
    const optionalOps = new Set<string>((config.optionalOps ?? OPTIONAL_PROVIDER_OPERATIONS).map(String));
    const maxDestroyAttempts = config.maxDestroyAttempts ?? HOSTILE_MAX_DESTROY_ATTEMPTS;

    const resources = new Map<string, HostileResource>();
    const idempotency = new Map<string, string>();
    let counter = 0;
    // Effect authority: active until withdrawn; withdrawal is TERMINAL + idempotent.
    let effectAuthorityActive = true;

    const supported = (): readonly ProviderOperation[] => [
      ...CORE_PROVIDER_OPERATIONS,
      ...OPTIONAL_PROVIDER_OPERATIONS.filter((op) => optionalOps.has(op)),
    ];

    const project = (r: HostileResource): ProviderResourceProjection => ({
      // ONLY the four provider-neutral keys — never a sensitive/tenant field.
      providerId,
      resourceId: r.resourceId,
      state: r.state,
      checkpoint: r.checkpoint,
    });

    const projectList = (page?: ProviderPageRequest, generation?: number): ProviderListResult => {
      const all = [...resources.values()]
        .filter((r) => generation === undefined || r.generation === generation)
        .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0))
        .map(project);
      const limit = page?.limit;
      if (limit === undefined) return { resources: all, nextCursor: null };
      const cursor = page?.cursor ?? null;
      let start = 0;
      if (cursor !== null) {
        const idx = all.findIndex((r) => r.resourceId === cursor);
        start = idx >= 0 ? idx + 1 : all.length;
      }
      const slice = all.slice(start, start + limit);
      const end = start + slice.length;
      const nextCursor = end < all.length && slice.length > 0 ? slice[slice.length - 1].resourceId : null;
      return { resources: slice, nextCursor };
    };

    const doCreate = (args: ProviderOpArgs): ProviderOpResult => {
      const params = readParams(args);
      if (args.idempotencyKey !== undefined) {
        const existing = idempotency.get(args.idempotencyKey);
        if (existing !== undefined) {
          return { kind: "created", resource: { providerId, resourceId: existing }, deduplicated: true };
        }
      }
      counter += 1;
      const resourceId = `${providerId}-res-${counter}`;
      const faultsRaw = (params.faults ?? {}) as Record<string, unknown>;
      const sensitive = { ...asRecord(params.sensitive), ...asRecord(params.secrets) };
      resources.set(resourceId, {
        resourceId,
        generation: typeof params.resourceGeneration === "number" ? params.resourceGeneration : 1,
        state: "created",
        checkpoint: "create",
        faults: {
          ignoreCancel: faultsRaw.ignoreCancel === true,
          ignoreKill: faultsRaw.ignoreKill === true,
          destroyFailures: typeof faultsRaw.destroyFailures === "number" ? faultsRaw.destroyFailures : 0,
        },
        sensitive,
      });
      if (args.idempotencyKey !== undefined) idempotency.set(args.idempotencyKey, resourceId);
      return { kind: "created", resource: { providerId, resourceId }, deduplicated: false };
    };

    /** Resolve a cleanup-facet target under the no-existence-oracle rule: an
     * absent id, a cross-resource id, OR a wrong-generation id all throw the SAME
     * `ResourceNotAvailableError`. */
    const requireOwned = (args: ProviderOpArgs): HostileResource => {
      const params = readParams(args);
      const resource = args.resourceId !== undefined ? resources.get(args.resourceId) : undefined;
      if (!resource) throw new ResourceNotAvailableError();
      const asserted = typeof params.targetGeneration === "number" ? params.targetGeneration : resource.generation;
      if (asserted !== resource.generation) throw new ResourceNotAvailableError();
      return resource;
    };

    /** Internal monotonic convergence over all live resources (mirror of the
     * worker-daemon `CleanupAuthority.converge`): graceful cancel → escalate kill →
     * forced destroy retried up to `maxDestroyAttempts`. Bounded; never regresses;
     * leaves zero live resources on success. Returns the aggregate status. */
    const converge = (): ProviderCleanupResult => {
      let aggregate: ProviderCleanupResult["cleanupStatus"] = "success";
      for (const resource of [...resources.values()]) {
        // cancel (graceful).
        if (!resource.faults.ignoreCancel) {
          resource.state = "cancelled";
        } else {
          // ignored cancel → escalate to kill.
          if (!resource.faults.ignoreKill) {
            resource.state = "killed";
          }
          // ignored kill → the forced destroy below still stops the tree.
        }
        // Forced destroy, retried idempotently up to the ceiling.
        let destroyed = false;
        for (let attempt = 0; attempt < maxDestroyAttempts; attempt += 1) {
          if (resource.faults.destroyFailures > 0) {
            resource.faults.destroyFailures -= 1;
            continue; // this attempt FAILED
          }
          resources.delete(resource.resourceId);
          destroyed = true;
          break;
        }
        if (!destroyed) aggregate = "failed";
      }
      return { cleanupStatus: aggregate };
    };

    const invoke = async (op: ProviderOperation, args: ProviderOpArgs): Promise<ProviderOpResult> => {
      if (!PROVIDER_OPERATION_SET.has(op)) throw new Error(`unknown provider operation: ${String(op)}`);
      const params = readParams(args);

      // Latch terminal effect-authority withdrawal BEFORE dispatch (idempotent).
      if (params.withdrawEffectAuthority === true) effectAuthorityActive = false;

      const cleanupFacet = params.authority === "cleanup";

      // Unadvertised optional op → negotiation error (as the benign fake does).
      if (OPTIONAL_OPERATION_SET.has(op) && !optionalOps.has(op)) {
        throw new UnsupportedProviderOperation(op);
      }

      if (cleanupFacet) {
        // ── Cleanup-authority facet — structurally denies every effectful op. ──
        if (params.openEgress === true) throw new CleanupAuthorityDeniedError("open egress");
        if (EFFECT_OPS.has(op)) throw new CleanupAuthorityDeniedError(op === "restore" ? "resume" : op);
        // Allowed cleanup ops are OWNERSHIP-checked (no existence oracle).
        switch (op) {
          case "list": {
            // Ownership-scoped: when a target generation is asserted, the cleanup
            // authority may only enumerate its OWN matching resources (no list oracle);
            // an unscoped convergence list (§2.4/§2.8, no targetGeneration) stays global.
            const gen = typeof params.targetGeneration === "number" ? params.targetGeneration : undefined;
            return { kind: "list", list: projectList(args.page, gen) };
          }
          case "inspect": {
            const resource = requireOwned(args);
            return { kind: "inspect", projection: project(resource) };
          }
          case "cancel": {
            const resource = requireOwned(args);
            if (resource.faults.ignoreCancel) return { kind: "acknowledged", op, faultInjected: true };
            resource.state = "cancelled";
            return { kind: "acknowledged", op, faultInjected: false };
          }
          case "kill": {
            const resource = requireOwned(args);
            if (resource.faults.ignoreKill) return { kind: "acknowledged", op, faultInjected: true };
            resource.state = "killed";
            return { kind: "acknowledged", op, faultInjected: false };
          }
          case "destroy": {
            const resource = requireOwned(args);
            if (resource.faults.destroyFailures > 0) {
              resource.faults.destroyFailures -= 1;
              return { kind: "acknowledged", op, faultInjected: true };
            }
            resources.delete(resource.resourceId);
            return { kind: "acknowledged", op, faultInjected: false };
          }
          case "reconcile_cleanup": {
            if (params.lifecycleFault === "outage") {
              // Transient provider outage: REPORTED (never raised), resources left
              // intact so a retry converges (bounded — the call still returns).
              return { kind: "cleanup", cleanup: { cleanupStatus: "failed" } };
            }
            if (params.emptyPass === true || resources.size === 0) {
              // Empty pass: report success, but NEVER consume the terminal latch.
              return { kind: "cleanup", cleanup: { cleanupStatus: "success" } };
            }
            // A converge always sweeps live resources; an empty pass above never
            // short-circuits a LATER pass (no fail-open latch).
            return { kind: "cleanup", cleanup: converge() };
          }
          default:
            throw new CleanupAuthorityDeniedError(op);
        }
      }

      // ── Effect-authority facet ──────────────────────────────────────────────
      // Post-fence: openEgress + governed effect ops are denied (withdrawn).
      if (!effectAuthorityActive) {
        if (params.openEgress === true) throw new EffectAuthorityWithdrawnError();
        if (EFFECT_OPS.has(op)) throw new EffectAuthorityWithdrawnError();
      }

      switch (op) {
        case "create":
          return doCreate(args);
        case "execute": {
          // Egress refusal (active fence): a non-"allow" injected classification is
          // refused carrying the exact class — no bypass.
          const egress = params.egress as { classification?: unknown } | undefined;
          if (egress && typeof egress.classification === "string" && egress.classification !== "allow") {
            throw new SandboxEgressDeniedError(egress.classification);
          }
          const fault = params.lifecycleFault;
          const timedOut = args.deadlineMs === 0 || fault === "ttl";
          const crashed = fault === "crash";
          const resource = args.resourceId !== undefined ? resources.get(args.resourceId) : undefined;
          if (resource) resource.state = "executed";
          return {
            kind: "executed",
            terminalState: crashed ? "failed" : timedOut ? "expired" : "succeeded",
            faultInjected: crashed || timedOut,
            timedOut,
          };
        }
        case "cancel":
        case "kill": {
          const resource = args.resourceId !== undefined ? resources.get(args.resourceId) : undefined;
          if (resource) resource.state = op;
          return { kind: "acknowledged", op, faultInjected: false };
        }
        case "destroy":
          if (args.resourceId !== undefined) resources.delete(args.resourceId);
          return { kind: "acknowledged", op, faultInjected: false };
        case "list":
          return { kind: "list", list: projectList(args.page) };
        case "inspect": {
          const resource = args.resourceId !== undefined ? resources.get(args.resourceId) : undefined;
          return { kind: "inspect", projection: resource ? project(resource) : null };
        }
        case "reconcile_cleanup": {
          // Effect-facet reconcile still sweeps (happy-path compatible), honoring a
          // bounded provider-outage fault: a leaked-resource reconcile converges.
          if (params.lifecycleFault === "outage") {
            return { kind: "cleanup", cleanup: { cleanupStatus: "failed" } };
          }
          if (params.emptyPass === true || resources.size === 0) {
            return { kind: "cleanup", cleanup: { cleanupStatus: "success" } };
          }
          return { kind: "cleanup", cleanup: converge() };
        }
        case "checkpoint":
          return { kind: "checkpoint", checkpointId: `chk-${providerId}-${counter}` };
        case "restore":
          return { kind: "restore", checkpointId: `chk-${providerId}-${counter}` };
        case "health":
          return { kind: "health", healthy: true };
        default: {
          const exhaustive: never = op;
          throw new Error(`unhandled provider operation: ${String(exhaustive)}`);
        }
      }
    };

    return { providerId, supportedOperations: supported, invoke };
  }
}

export function createHostileSandboxProvider(): HostileSandboxProvider {
  return new HostileSandboxProvider();
}
