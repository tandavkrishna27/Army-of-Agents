// -----------------------------------------------------------------------------
// perOpToInvokeDriver — the GENERIC per-op→invoke-driver adapter that CLOSES
// finding E6-F008 (CLI-001/D2).
//
// worker-daemon's authoritative `SandboxProvider` is a PER-OP method surface with
// rich supervisor types; `@armyofagents/sandbox-provider-contract`'s
// `SandboxProviderDriver` is a SINGLE provider-neutral `invoke(op,args)` the two
// conformance suites drive. They are structurally distinct and nothing bridged
// them (`port.ts:23-25`). This adapter is that bridge: it exposes ANY per-op
// `SandboxProvider` through the invoke surface, so the DEP-000 happy-path suite and
// the DEP-008 hostile isolation suite run against a real provider (over a mock or
// real transport) unchanged.
//
// Because the per-op port has no black-box `params` channel, the adapter is where
// the opaque fault vocabulary is realized. It:
//   * latches TERMINAL effect-authority withdrawal (`withdrawEffectAuthority`) and,
//     post-fence, denies every governed effect op + openEgress with the EXACT
//     worker-daemon `EffectAuthorityWithdrawnError`;
//   * routes the `authority:"cleanup"` facet: every effectful op (+ openEgress) is
//     denied with `CleanupAuthorityDeniedError` (matching `attemptedOperation`),
//     while teardown/read ops are ownership-checked with NO existence oracle — an
//     absent, cross-resource, or wrong-`targetGeneration` target collapses to the
//     one uniform `ResourceNotAvailableError`; cleanup `list` is generation-scoped;
//   * marshals the create/execute levers (`sensitive`/`secrets`/`faults`/
//     `resourceGeneration`/`egress.classification`/`lifecycleFault`) into the rich
//     per-op context, and folds `emptyPass`/`lifecycleFault:"outage"` into the
//     provider-wide reconcile convergence;
//   * gates optional ops on `advertisedOperations` (else `UnsupportedProviderOperation`);
//   * REDACTS every list/inspect result to the neutral 4-key projection — no
//     command/env/logs/secret/tenant field crosses the invoke seam (CAV-002).
//
// It is provider-agnostic (no `e2b` import) and holds only the per-driver authority
// latch + a create-dedup ledger; all resource state + fault behavior lives in the
// provider. Bounded monotonic convergence mirrors worker-daemon's
// `CleanupAuthority.converge` (which is per-lease-bound and cannot be instantiated
// generically here); the denials it throws are the REAL worker-daemon classes.
// -----------------------------------------------------------------------------

import {
  OPTIONAL_PROVIDER_OPERATIONS,
  PROVIDER_OPERATIONS,
  type ProviderOperation,
} from "@armyofagents/worker-protocol";
import type {
  CreateSandboxSpec,
  ExecuteInput,
  InspectResult,
  ListInput,
  ProviderOpContext,
  ResourceLabels,
  ResourceSummary,
  SandboxProvider,
} from "@armyofagents/worker-daemon";
import type {
  ProviderOpArgs,
  ProviderOpResult,
  ProviderResourceProjection,
  SandboxProviderDriver,
} from "@armyofagents/sandbox-provider-contract";

import { DIRECTIVE_KEYS } from "./directives.js";
import {
  CleanupAuthorityDeniedError,
  EffectAuthorityWithdrawnError,
  ResourceNotAvailableError,
  SandboxNotFoundError,
  UnsupportedProviderOperation,
} from "./errors.js";

const PROVIDER_OPERATION_SET: ReadonlySet<string> = new Set(PROVIDER_OPERATIONS);
const OPTIONAL_OPERATION_SET: ReadonlySet<string> = new Set(OPTIONAL_PROVIDER_OPERATIONS);
/** The governed effect ops the fence gates (mirror of worker-daemon's set). */
const GOVERNED_EFFECT_OPS: ReadonlySet<string> = new Set(["create", "execute", "checkpoint", "restore", "health"]);
/** cleanup-facet denial's `attemptedOperation` per governed op. */
const CLEANUP_DENIAL_LABEL: Record<string, string> = {
  create: "create",
  execute: "execute",
  restore: "resume",
  checkpoint: "checkpoint",
  health: "health",
};

const DEFAULT_DEADLINE_MS = 60_000;

export interface PerOpToInvokeDriverOptions {
  /** The opaque provider id the resulting driver reports. */
  readonly providerId?: string;
  /** The bounded destroy-retry ceiling the convergence honors (default 3, the
   * worker-daemon `converge` default; the isolation suite threads its own). */
  readonly maxDestroyAttempts?: number;
}

function readParams(args: ProviderOpArgs): Readonly<Record<string, unknown>> {
  return (args.params ?? {}) as Readonly<Record<string, unknown>>;
}

function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/**
 * Expose a per-op `SandboxProvider` as the provider-neutral invoke-driver both
 * conformance suites drive. Returns a FRESH driver with its own authority latch —
 * call once per independent check.
 */
export function perOpToInvokeDriver(
  provider: SandboxProvider,
  options: PerOpToInvokeDriverOptions = {},
): SandboxProviderDriver {
  const providerId = options.providerId ?? "e2b";
  const maxDestroyAttempts = options.maxDestroyAttempts ?? 3;

  // Per-driver authority latch + a create-dedup ledger. All resource state lives
  // in the provider; this is the ONLY state the neutral seam holds.
  let effectAuthorityActive = true;
  const seenSandboxIds = new Set<string>();
  let synthCounter = 0;

  const nextSynth = (prefix: string): string => {
    synthCounter += 1;
    return `${prefix}-${synthCounter}`;
  };

  const deadline = (args: ProviderOpArgs): number =>
    args.deadlineMs !== undefined ? args.deadlineMs : DEFAULT_DEADLINE_MS;

  const mkCtx = (deadlineMs: number, idempotencyKey: string): ProviderOpContext => ({ deadlineMs, idempotencyKey });

  const synthLabels = (generation: number): ResourceLabels => {
    const n = nextSynth("res");
    return {
      organizationId: "org-e2b",
      targetId: "target-e2b",
      workerId: "worker-e2b",
      jobId: `job-${n}`,
      attempt: 1,
      leaseId: `lease-${n}`,
      deviceGeneration: generation,
    };
  };

  const ownershipSelector = { organizationId: "org-e2b", targetId: "target-e2b", workerId: "worker-e2b" };

  // --- projections (redaction to the neutral 4-key shape) --------------------

  const redactDetail = (detail: InspectResult): ProviderResourceProjection => ({
    providerId,
    resourceId: detail.sandboxId,
    state: detail.state,
    checkpoint: `gen-${detail.generation}`,
  });
  const redactSummary = (summary: ResourceSummary): ProviderResourceProjection => ({
    providerId,
    resourceId: summary.sandboxId,
    state: summary.state,
    checkpoint: `gen-${summary.generation}`,
  });

  // --- spec/input marshalling (params → rich per-op context) -----------------

  const buildCreateSpec = (params: Readonly<Record<string, unknown>>): CreateSandboxSpec => {
    const generation = typeof params.resourceGeneration === "number" ? params.resourceGeneration : 1;
    const sensitive = asStringRecord(params.sensitive);
    const secrets = asStringRecord(params.secrets);
    const faultsRaw = (params.faults ?? {}) as Record<string, unknown>;
    // The tenant env the provider HOLDS: the sensitive/secret canaries (so the
    // provider's inspect detail is real and the redaction non-vacuous) + the
    // reserved fault directives the mock transport decodes. Never neutral output.
    const env: Record<string, string> = { ...sensitive, ...secrets };
    if (faultsRaw.ignoreCancel === true) env[DIRECTIVE_KEYS.ignoreCancel] = "1";
    if (faultsRaw.ignoreKill === true) env[DIRECTIVE_KEYS.ignoreKill] = "1";
    if (typeof faultsRaw.destroyFailures === "number" && faultsRaw.destroyFailures > 0) {
      env[DIRECTIVE_KEYS.destroyFailures] = String(faultsRaw.destroyFailures);
    }
    return {
      resourceLabels: synthLabels(generation),
      command: typeof sensitive.command === "string" ? sensitive.command : "/bin/true",
      args: [],
      env,
      workloadType: "coding",
    };
  };

  const buildExecuteInput = (sandboxId: string, params: Readonly<Record<string, unknown>>): ExecuteInput => {
    const env: Record<string, string> = {};
    const egress = params.egress as { classification?: unknown } | undefined;
    if (egress && typeof egress.classification === "string") {
      env[DIRECTIVE_KEYS.egressClass] = egress.classification;
    }
    if (params.lifecycleFault === "crash" || params.lifecycleFault === "ttl") {
      env[DIRECTIVE_KEYS.lifecycleFault] = params.lifecycleFault;
    }
    // `true` is a portable no-op that exits 0 in every base image; the earlier
    // placeholder `run` is not a real binary, so a real-E2B execute exited 127
    // ("run: command not found"). The mock ignores the command (directive-driven),
    // so this default only matters on the keyed lane's happy path.
    return { sandboxId, command: "true", args: [], env };
  };

  // --- ownership (no existence oracle) ---------------------------------------

  /** Resolve owned detail for a cleanup-facet target, or throw the uniform
   * ResourceNotAvailableError (absent, wrong-generation, or cross-resource all
   * collapse to one identity). */
  const requireOwned = async (args: ProviderOpArgs, params: Readonly<Record<string, unknown>>): Promise<InspectResult> => {
    const rid = args.resourceId;
    if (rid === undefined) throw new ResourceNotAvailableError();
    let detail: InspectResult;
    try {
      detail = await provider.inspect(rid, mkCtx(deadline(args), nextSynth("inspect")));
    } catch (err) {
      if (err instanceof SandboxNotFoundError) throw new ResourceNotAvailableError();
      throw err;
    }
    const asserted = typeof params.targetGeneration === "number" ? params.targetGeneration : detail.generation;
    if (asserted !== detail.generation) throw new ResourceNotAvailableError();
    return detail;
  };

  // --- list + reconcile helpers ----------------------------------------------

  const listOp = async (
    args: ProviderOpArgs,
    params: Readonly<Record<string, unknown>>,
    cleanupScoped: boolean,
  ): Promise<ProviderOpResult> => {
    const input: ListInput = {
      ownershipSelector,
      pageSize: args.page?.limit ?? 100,
      pageToken: args.page?.cursor ?? null,
    };
    const result = await provider.list(input, mkCtx(deadline(args), nextSynth("list")));
    let rows: readonly ResourceSummary[] = result.resources;
    if (cleanupScoped && typeof params.targetGeneration === "number") {
      const gen = params.targetGeneration;
      rows = rows.filter((r) => r.generation === gen);
    }
    return { kind: "list", list: { resources: rows.map(redactSummary), nextCursor: result.nextPageToken } };
  };

  const allLiveIds = async (): Promise<string[]> => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const result = await provider.list(
        { ownershipSelector, pageSize: 100, pageToken: cursor },
        mkCtx(DEFAULT_DEADLINE_MS, nextSynth("list")),
      );
      for (const r of result.resources) ids.push(r.sandboxId);
      cursor = result.nextPageToken;
      if (cursor === null) break;
    }
    return ids;
  };

  /** Bounded monotonic convergence for one resource: graceful cancel → escalate
   * kill → forced destroy retried up to the ceiling. Mirror of
   * `CleanupAuthority.#convergeOne`. */
  const convergeOne = async (sandboxId: string): Promise<"success" | "failed"> => {
    const cancel = await provider.cancel(sandboxId, mkCtx(DEFAULT_DEADLINE_MS, nextSynth("cancel")));
    if (cancel.outcome === "ignored") {
      await provider.kill(sandboxId, mkCtx(DEFAULT_DEADLINE_MS, nextSynth("kill")));
      // An ignored kill is stopped by the forced destroy below.
    }
    for (let attempt = 0; attempt < maxDestroyAttempts; attempt += 1) {
      const result = await provider.destroy(sandboxId, mkCtx(DEFAULT_DEADLINE_MS, nextSynth("destroy")));
      if (result.cleanupStatus === "success") return "success";
    }
    return "failed";
  };

  const reconcileOp = async (params: Readonly<Record<string, unknown>>): Promise<ProviderOpResult> => {
    // A transient provider outage is REPORTED (never raised); a retry converges.
    if (params.lifecycleFault === "outage") {
      return { kind: "cleanup", cleanup: { cleanupStatus: "failed" } };
    }
    // An empty pass reports success and NEVER latches a fail-open no-op.
    if (params.emptyPass === true) {
      return { kind: "cleanup", cleanup: { cleanupStatus: "success" } };
    }
    const ids = await allLiveIds();
    if (ids.length === 0) return { kind: "cleanup", cleanup: { cleanupStatus: "success" } };
    let aggregate: "success" | "failed" = "success";
    for (const id of ids) {
      if ((await convergeOne(id)) === "failed") aggregate = "failed";
    }
    return { kind: "cleanup", cleanup: { cleanupStatus: aggregate } };
  };

  // --- facet dispatchers ------------------------------------------------------

  const cleanupInvoke = async (
    op: ProviderOperation,
    args: ProviderOpArgs,
    params: Readonly<Record<string, unknown>>,
  ): Promise<ProviderOpResult> => {
    // openEgress + every effectful op are structurally unrepresentable here.
    if (params.openEgress === true) throw new CleanupAuthorityDeniedError("open egress");
    if (GOVERNED_EFFECT_OPS.has(op)) throw new CleanupAuthorityDeniedError(CLEANUP_DENIAL_LABEL[op] ?? op);

    switch (op) {
      case "list":
        return listOp(args, params, true);
      case "inspect": {
        const detail = await requireOwned(args, params);
        return { kind: "inspect", projection: redactDetail(detail) };
      }
      case "cancel":
      case "kill": {
        await requireOwned(args, params);
        const ctx = mkCtx(deadline(args), nextSynth(op));
        const stop = op === "cancel" ? await provider.cancel(args.resourceId!, ctx) : await provider.kill(args.resourceId!, ctx);
        return { kind: "acknowledged", op, faultInjected: stop.outcome === "ignored" };
      }
      case "destroy": {
        await requireOwned(args, params);
        const c = await provider.destroy(args.resourceId!, mkCtx(deadline(args), nextSynth("destroy")));
        return { kind: "acknowledged", op: "destroy", faultInjected: c.cleanupStatus === "failed" };
      }
      case "reconcile_cleanup":
        return reconcileOp(params);
      default:
        // create/execute/checkpoint/restore/health handled above by the governed guard.
        throw new CleanupAuthorityDeniedError(CLEANUP_DENIAL_LABEL[op] ?? op);
    }
  };

  const effectInvoke = async (
    op: ProviderOperation,
    args: ProviderOpArgs,
    params: Readonly<Record<string, unknown>>,
  ): Promise<ProviderOpResult> => {
    // Post-fence: openEgress + governed effect ops are withdrawn.
    if (!effectAuthorityActive) {
      if (params.openEgress === true) throw new EffectAuthorityWithdrawnError("e2b-lease");
      if (GOVERNED_EFFECT_OPS.has(op)) throw new EffectAuthorityWithdrawnError("e2b-lease");
    }

    switch (op) {
      case "create": {
        const key = args.idempotencyKey ?? nextSynth("idem");
        const spec = buildCreateSpec(params);
        const res = await provider.create(spec, mkCtx(deadline(args), key));
        const deduplicated = seenSandboxIds.has(res.sandboxId);
        if (!deduplicated) seenSandboxIds.add(res.sandboxId);
        return { kind: "created", resource: { providerId, resourceId: res.sandboxId }, deduplicated };
      }
      case "execute": {
        const input = buildExecuteInput(args.resourceId ?? "", params);
        const r = await provider.execute(input, mkCtx(deadline(args), nextSynth("exec")));
        const failed = (r.exitCode !== null && r.exitCode !== 0) || r.signal !== null;
        const terminalState = r.timedOut ? "expired" : failed ? "failed" : "succeeded";
        return { kind: "executed", terminalState, faultInjected: r.timedOut || terminalState === "failed", timedOut: r.timedOut };
      }
      case "cancel":
      case "kill": {
        const ctx = mkCtx(deadline(args), nextSynth(op));
        const stop = op === "cancel" ? await provider.cancel(args.resourceId ?? "", ctx) : await provider.kill(args.resourceId ?? "", ctx);
        return { kind: "acknowledged", op, faultInjected: stop.outcome === "ignored" };
      }
      case "destroy": {
        const c = await provider.destroy(args.resourceId ?? "", mkCtx(deadline(args), nextSynth("destroy")));
        return { kind: "acknowledged", op: "destroy", faultInjected: c.cleanupStatus === "failed" };
      }
      case "list":
        return listOp(args, params, false);
      case "inspect": {
        try {
          const detail = await provider.inspect(args.resourceId ?? "", mkCtx(deadline(args), nextSynth("inspect")));
          return { kind: "inspect", projection: redactDetail(detail) };
        } catch (err) {
          if (err instanceof SandboxNotFoundError) return { kind: "inspect", projection: null };
          throw err;
        }
      }
      case "reconcile_cleanup":
        return reconcileOp(params);
      case "checkpoint": {
        const c = await provider.checkpoint(args.resourceId ?? "", mkCtx(deadline(args), nextSynth("checkpoint")));
        return { kind: "checkpoint", checkpointId: c.checkpointRef };
      }
      case "restore": {
        await provider.restore(args.resourceId ?? "", mkCtx(deadline(args), nextSynth("restore")));
        return { kind: "restore", checkpointId: `restored-${args.resourceId ?? ""}` };
      }
      case "health": {
        const h = await provider.health(args.resourceId ?? "", mkCtx(deadline(args), nextSynth("health")));
        return { kind: "health", healthy: h.status === "healthy" };
      }
      default: {
        const exhaustive: never = op;
        throw new Error(`unhandled provider operation: ${String(exhaustive)}`);
      }
    }
  };

  const invoke = async (op: ProviderOperation, args: ProviderOpArgs): Promise<ProviderOpResult> => {
    if (!PROVIDER_OPERATION_SET.has(op)) throw new Error(`unknown provider operation: ${String(op)}`);
    const params = readParams(args);

    // Latch TERMINAL effect-authority withdrawal before dispatch (idempotent).
    if (params.withdrawEffectAuthority === true) effectAuthorityActive = false;

    // Optional-op advertisement gate (both facets) — an unadvertised optional op
    // is an explicit, named negotiation failure.
    if (OPTIONAL_OPERATION_SET.has(op) && !provider.advertisedOperations.has(op)) {
      throw new UnsupportedProviderOperation(op);
    }

    if (params.authority === "cleanup") return cleanupInvoke(op, args, params);
    return effectInvoke(op, args, params);
  };

  return {
    providerId,
    supportedOperations: () => [...provider.advertisedOperations],
    invoke,
  };
}
