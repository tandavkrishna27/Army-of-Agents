// -----------------------------------------------------------------------------
// FakeSandboxProvider — the deterministic, fixture-driven, invocation-inspectable
// fake, addressed by opaque `providerId`.
//
// It implements the provider-neutral driver PORT (a structural mirror of
// `@armyofagents/sandbox-provider-contract`'s `SandboxProviderDriver`; the fake
// never imports the contract, keeping its runtime deps to worker-protocol + zod +
// Node built-ins) over the frozen `PROVIDER_OPERATIONS` vocabulary — no invented
// op. A single `invokeAt(checkpoint, op, args)` records `{providerId, op,
// argsDigest, checkpoint, faultInjected, seq, ts}` to the append-only ledger and
// then performs the op; the plain port `invoke(op, args)` delegates at each op's
// default checkpoint. `reconcile_cleanup` clears live resources → `list`/`inspect`
// then report ZERO (the E6F-02 invariant); `reset` restores zero invocations AND
// zero live resources.
// -----------------------------------------------------------------------------

import {
  CORE_PROVIDER_OPERATIONS,
  OPTIONAL_PROVIDER_OPERATIONS,
  PROVIDER_OPERATIONS,
  type ProviderOperation,
} from "@armyofagents/worker-protocol";

import { sha256Hex, stableStringify } from "./hash.js";
import {
  InvocationLedger,
  type FakeClockOptions,
  type InvocationLedgerEntry,
} from "./invocation-ledger.js";
import {
  LIFECYCLE_CHECKPOINTS,
  derivePlan,
  emitFixtureEvents,
  isLifecycleCheckpoint,
  validateFixture,
  type FailureInjection,
  type LifecycleCheckpoint,
  type RunPlan,
  type ValidatedFixture,
} from "./fixture-runtime.js";

// --- Port mirror (structural match to the contract package) ------------------

export interface ProviderResourceRef {
  readonly providerId: string;
  readonly resourceId: string;
}
export interface ProviderPageRequest {
  readonly cursor?: string | null;
  readonly limit?: number;
}
export interface ProviderOpArgs {
  readonly providerId: string;
  readonly resourceId?: string;
  readonly idempotencyKey?: string;
  readonly deadlineMs?: number;
  readonly page?: ProviderPageRequest;
  readonly params?: Readonly<Record<string, unknown>>;
}
export interface ProviderResourceProjection {
  readonly providerId: string;
  readonly resourceId: string;
  readonly state: string;
  readonly checkpoint: string;
}
export interface ProviderListResult {
  readonly resources: readonly ProviderResourceProjection[];
  readonly nextCursor: string | null;
}
export interface ProviderCleanupResult {
  readonly cleanupStatus: "success" | "failed";
}
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

/** Duck-typed, cross-package UnsupportedProviderOperation (the fake cannot import
 * the contract's class; the contract's negotiation check matches on
 * `name`+`operation`). The emitted field is `operation`, aligned with
 * worker-daemon's authoritative `UnsupportedProviderOperation`. */
export class UnsupportedProviderOperation extends Error {
  readonly operation: ProviderOperation;
  constructor(operation: ProviderOperation) {
    super(`provider operation not supported: ${operation}`);
    this.name = "UnsupportedProviderOperation";
    this.operation = operation;
  }
}

export interface SandboxProviderDriver {
  readonly providerId: string;
  supportedOperations(): readonly ProviderOperation[];
  invoke(op: ProviderOperation, args: ProviderOpArgs): Promise<ProviderOpResult>;
}

/** The fake's driver additionally exposes `invokeAt` so the replay engine can
 * record the explicit lifecycle checkpoint (and fault flag) for each op. */
export interface FakeSandboxDriver extends SandboxProviderDriver {
  invokeAt(
    checkpoint: LifecycleCheckpoint,
    op: ProviderOperation,
    args: ProviderOpArgs,
    opts?: { faultInjected?: boolean },
  ): Promise<ProviderOpResult>;
}

// --- Internal provider state -------------------------------------------------

interface LiveResource {
  resourceId: string;
  state: string;
  checkpoint: string;
}

interface ProviderState {
  resources: Map<string, LiveResource>;
  idempotency: Map<string, string>;
  counter: number;
}

interface ScriptState {
  fixture: ValidatedFixture;
  plan: RunPlan;
  failureInjection: FailureInjection | null;
}

const OP_DEFAULT_CHECKPOINT: Record<ProviderOperation, LifecycleCheckpoint> = {
  create: "create",
  execute: "execute",
  cancel: "cancel",
  kill: "crash",
  destroy: "destroy",
  list: "destroy",
  inspect: "event",
  reconcile_cleanup: "destroy",
  checkpoint: "checkpoint",
  restore: "checkpoint",
  health: "event",
};

const PROVIDER_OPERATION_SET: ReadonlySet<string> = new Set(PROVIDER_OPERATIONS);
const OPTIONAL_OPERATION_SET: ReadonlySet<string> = new Set(OPTIONAL_PROVIDER_OPERATIONS);

export interface ScriptInput {
  readonly providerId: string;
  readonly fixture: ValidatedFixture;
  readonly failureInjection?: FailureInjection | null;
  readonly includeAllCheckpoints?: boolean;
}

export interface ReplayResult {
  readonly providerId: string;
  readonly fixtureId: string;
  readonly terminalState: string;
  readonly faultInjected: boolean;
  readonly effect: string | null;
  readonly emittedEvents: ReadonlyArray<Record<string, unknown>>;
  readonly invocations: readonly InvocationLedgerEntry[];
}

export interface FakeSandboxProviderOptions extends FakeClockOptions {}

export class FakeSandboxProvider {
  private readonly ledger: InvocationLedger;
  private readonly providers = new Map<string, ProviderState>();
  private readonly scripts = new Map<string, ScriptState>();

  constructor(options: FakeSandboxProviderOptions = {}) {
    this.ledger = new InvocationLedger(options);
  }

  /** A driver bound to `providerId`. `optionalOps` (default: all three) controls
   * which optional operations this driver advertises — used to exercise the
   * contract's optional-op negotiation on both branches. */
  makeDriver(
    providerId: string,
    config: { optionalOps?: readonly ProviderOperation[] } = {},
  ): FakeSandboxDriver {
    const optionalOps = new Set<string>(
      (config.optionalOps ?? OPTIONAL_PROVIDER_OPERATIONS).map(String),
    );
    const supported = (): readonly ProviderOperation[] => [
      ...CORE_PROVIDER_OPERATIONS,
      ...OPTIONAL_PROVIDER_OPERATIONS.filter((op) => optionalOps.has(op)),
    ];
    const invokeAt = (
      checkpoint: LifecycleCheckpoint,
      op: ProviderOperation,
      args: ProviderOpArgs,
      opts: { faultInjected?: boolean } = {},
    ): Promise<ProviderOpResult> =>
      this.invokeAtInternal(providerId, checkpoint, op, args, {
        faultInjected: opts.faultInjected ?? false,
        optionalOps,
      });
    return {
      providerId,
      supportedOperations: supported,
      invoke: (op, args) => invokeAt(OP_DEFAULT_CHECKPOINT[op], op, args),
      invokeAt,
    };
  }

  private state(providerId: string): ProviderState {
    let s = this.providers.get(providerId);
    if (!s) {
      s = { resources: new Map(), idempotency: new Map(), counter: 0 };
      this.providers.set(providerId, s);
    }
    return s;
  }

  private async invokeAtInternal(
    providerId: string,
    checkpoint: LifecycleCheckpoint,
    op: ProviderOperation,
    args: ProviderOpArgs,
    opts: { faultInjected: boolean; optionalOps: ReadonlySet<string> },
  ): Promise<ProviderOpResult> {
    if (!PROVIDER_OPERATION_SET.has(op)) {
      throw new Error(`unknown provider operation: ${String(op)}`);
    }
    const argsDigest = sha256Hex(
      stableStringify({
        op,
        providerId: args.providerId,
        resourceId: args.resourceId,
        idempotencyKey: args.idempotencyKey,
        deadlineMs: args.deadlineMs,
        page: args.page,
        params: args.params,
      }),
    );
    this.ledger.append({ providerId, op, argsDigest, checkpoint, faultInjected: opts.faultInjected });

    if (OPTIONAL_OPERATION_SET.has(op) && !opts.optionalOps.has(op)) {
      throw new UnsupportedProviderOperation(op);
    }

    const state = this.state(providerId);
    switch (op) {
      case "create":
        return this.doCreate(providerId, state, args);
      case "execute": {
        const timedOut = args.deadlineMs === 0;
        this.touch(state, args.resourceId, "executed", checkpoint);
        return { kind: "executed", terminalState: timedOut ? "expired" : "succeeded", faultInjected: opts.faultInjected, timedOut };
      }
      case "cancel":
      case "kill":
        this.touch(state, args.resourceId, op, checkpoint);
        return { kind: "acknowledged", op, faultInjected: opts.faultInjected };
      case "destroy":
        if (args.resourceId !== undefined) state.resources.delete(args.resourceId);
        return { kind: "acknowledged", op, faultInjected: opts.faultInjected };
      case "list":
        return { kind: "list", list: this.projectList(providerId, state, args.page) };
      case "inspect": {
        const resource = args.resourceId !== undefined ? state.resources.get(args.resourceId) : undefined;
        return { kind: "inspect", projection: resource ? this.project(providerId, resource) : null };
      }
      case "reconcile_cleanup":
        state.resources.clear();
        return { kind: "cleanup", cleanup: { cleanupStatus: "success" } };
      case "checkpoint":
        return { kind: "checkpoint", checkpointId: this.checkpointId(providerId, args) };
      case "restore":
        return { kind: "restore", checkpointId: this.checkpointId(providerId, args) };
      case "health":
        return { kind: "health", healthy: true };
      default: {
        const exhaustive: never = op;
        throw new Error(`unhandled provider operation: ${String(exhaustive)}`);
      }
    }
  }

  private doCreate(providerId: string, state: ProviderState, args: ProviderOpArgs): ProviderOpResult {
    if (args.idempotencyKey !== undefined) {
      const existing = state.idempotency.get(args.idempotencyKey);
      if (existing !== undefined) {
        return { kind: "created", resource: { providerId, resourceId: existing }, deduplicated: true };
      }
    }
    state.counter += 1;
    const resourceId = `${providerId}-res-${state.counter}`;
    state.resources.set(resourceId, { resourceId, state: "created", checkpoint: "create" });
    if (args.idempotencyKey !== undefined) state.idempotency.set(args.idempotencyKey, resourceId);
    return { kind: "created", resource: { providerId, resourceId }, deduplicated: false };
  }

  private touch(state: ProviderState, resourceId: string | undefined, opState: string, checkpoint: string): void {
    if (resourceId === undefined) return;
    const resource = state.resources.get(resourceId);
    if (resource) {
      resource.state = opState;
      resource.checkpoint = checkpoint;
    }
  }

  private project(providerId: string, resource: LiveResource): ProviderResourceProjection {
    // Only provider-neutral keys — never a tenant/E2B field (E6F-05).
    return { providerId, resourceId: resource.resourceId, state: resource.state, checkpoint: resource.checkpoint };
  }

  private projectList(providerId: string, state: ProviderState, page?: ProviderPageRequest): ProviderListResult {
    const all = [...state.resources.values()]
      .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0))
      .map((r) => this.project(providerId, r));
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
  }

  private checkpointId(providerId: string, args: ProviderOpArgs): string {
    return `chk-${sha256Hex(stableStringify({ providerId, resourceId: args.resourceId })).slice(0, 24)}`;
  }

  /** Validate + store a scripted run for `providerId`. Fail-closed: the fixture is
   * validated (structure + per-event digest) before any plan is compiled. */
  async script(input: {
    providerId: string;
    fixtureId?: string;
    fixture?: unknown;
    fixturesDir?: string;
    loadFixture?: (fixtureId: string) => Promise<unknown>;
    failureInjection?: FailureInjection | null;
    includeAllCheckpoints?: boolean;
  }): Promise<ValidatedFixture> {
    let raw: unknown;
    if (input.fixture !== undefined) {
      raw = input.fixture;
    } else if (input.fixtureId !== undefined && input.loadFixture !== undefined) {
      raw = await input.loadFixture(input.fixtureId);
    } else {
      throw new Error("script requires either an inline `fixture` or a `fixtureId` + `loadFixture`");
    }
    const fixture = await validateFixture(raw);

    let injection: FailureInjection | null = null;
    if (input.failureInjection != null) {
      if (!isLifecycleCheckpoint(input.failureInjection.point)) {
        throw new Error(`failureInjection.point must be a lifecycle checkpoint, got ${String(input.failureInjection.point)}`);
      }
      if (typeof input.failureInjection.effect !== "string" || input.failureInjection.effect.length === 0) {
        throw new Error("failureInjection.effect must be a non-empty string");
      }
      injection = { point: input.failureInjection.point, effect: input.failureInjection.effect };
    }

    const plan = derivePlan(fixture, input.includeAllCheckpoints ?? false);
    this.scripts.set(input.providerId, { fixture, plan, failureInjection: injection });
    return fixture;
  }

  /** Execute the scripted run for `providerId` deterministically. */
  async replay(providerId: string): Promise<ReplayResult> {
    const script = this.scripts.get(providerId);
    if (!script) throw new Error(`no script loaded for provider ${providerId}`);
    const driver = this.makeDriver(providerId);
    const injection = script.failureInjection;
    const emittedEvents: Array<Record<string, unknown>> = [];
    let resourceId: string | undefined;
    let faultInjected = false;
    let effect: string | null = null;

    const runStep = async (step: RunPlan["forward"][number]): Promise<boolean> => {
      const isFaultHere = injection !== null && injection.point === step.checkpoint && !faultInjected;
      const args: ProviderOpArgs = {
        providerId,
        resourceId: step.op === "create" ? undefined : resourceId,
        idempotencyKey: step.op === "create" ? `${providerId}:${script.fixture.id}` : undefined,
        deadlineMs: step.checkpoint === "hang" ? 0 : undefined,
      };
      const result = await driver.invokeAt(step.checkpoint, step.op as ProviderOperation, args, { faultInjected: isFaultHere });
      if (result.kind === "created") resourceId = result.resource.resourceId;
      if (step.checkpoint === "event") emittedEvents.push(...emitFixtureEvents(script.fixture));
      if (isFaultHere) {
        faultInjected = true;
        effect = injection.effect;
        return true; // signal fault fired
      }
      return false;
    };

    for (const step of script.plan.forward) {
      const faulted = await runStep(step);
      if (faulted) break; // short-circuit forward steps; teardown still runs
    }
    for (const step of script.plan.teardown) {
      await runStep(step);
    }

    return {
      providerId,
      fixtureId: script.fixture.id,
      terminalState: script.fixture.expected.terminalState,
      faultInjected,
      effect,
      emittedEvents,
      invocations: this.ledger.list(providerId),
    };
  }

  /** The append-only invocation ledger (all providers, or one). */
  invocations(providerId?: string): InvocationLedgerEntry[] {
    return this.ledger.list(providerId);
  }

  /** Count of live resources (all providers, or one) — zero after reconcile/reset. */
  liveResourceCount(providerId?: string): number {
    if (providerId !== undefined) return this.providers.get(providerId)?.resources.size ?? 0;
    let total = 0;
    for (const s of this.providers.values()) total += s.resources.size;
    return total;
  }

  /** Restore zero invocations and zero live resources across all providers. */
  reset(): void {
    this.ledger.reset();
    this.providers.clear();
    this.scripts.clear();
  }
}

export { LIFECYCLE_CHECKPOINTS };
export type { LifecycleCheckpoint, FailureInjection };

export function createFakeSandboxProvider(options: FakeSandboxProviderOptions = {}): FakeSandboxProvider {
  return new FakeSandboxProvider(options);
}
