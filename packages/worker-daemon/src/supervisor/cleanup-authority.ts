/**
 * `CleanupAuthority` — the DISTINCT, monotonic, redacted teardown authority
 * (WRK-004). This is the security core of the ticket.
 *
 * It is bound to provider resource/ownership labels, a target generation, the
 * job/attempt/lease/observed fence, a deadline, and a monotonically-increasing
 * epoch. Once effect authority is withdrawn (lease loss/replacement/expiry) it is
 * the ONLY authority that may act, and it may ONLY:
 *   (a) list / inspect MATCHING resources through a MANAGEMENT-ONLY REDACTED
 *       projection — never command, env, logs, secrets, workspace/customer bytes,
 *       or object grants; or
 *   (b) cancel / kill / destroy / reconcile_cleanup.
 * It can NEVER create/execute/resume/checkpoint (or health, an effect-side live
 * op), reveal a non-matching resource, or open egress — every such attempt is
 * DENIED.
 *
 * Three hard invariants, enforced here:
 *   1. Effect denial: `create`/`execute`/`resume`/`checkpoint`/`health`/`openEgress`
 *      exist ONLY to throw {@link CleanupAuthorityDeniedError} — cleanup can never
 *      perform an effectful op.
 *   2. No existence oracle: a cross-resource or wrong-target-generation label is
 *      denied with the SAME {@link ResourceNotAvailableError} as a truly-absent
 *      resource — a caller cannot distinguish "exists but not yours" from "gone".
 *   3. Monotonic epoch: past the cleanup deadline the escalation ladder advances
 *      cancel → kill → destroy and never regresses; the epoch only increases and
 *      never resurrects effect authority.
 *
 * Runtime imports: relative `provider.ts` (+ its `effect-authority.ts` fence type)
 * only — the E4-D01 boundary.
 */

import type { EffectFence } from "./effect-authority.js";
import {
  hashResourceLabels,
  labelsEqual,
  SandboxNotFoundError,
  SandboxRecordIndeterminateError,
  type CleanupResult,
  type CleanupStatus,
  type ProviderOpContext,
  type RedactedResourceProjection,
  type ResourceLabels,
  type SandboxProvider,
  type StopResult,
} from "./provider.js";

/** The escalation ladder. Ordered, non-regressing. */
export const CLEANUP_STAGES = ["none", "cancel", "kill", "destroy"] as const;
export type CleanupStage = (typeof CLEANUP_STAGES)[number];

/** Denial raised for EVERY effectful op attempted under cleanup authority. */
export class CleanupAuthorityDeniedError extends Error {
  readonly attemptedOperation: string;
  constructor(attemptedOperation: string) {
    super(`cleanup authority may never ${attemptedOperation}`);
    this.name = "CleanupAuthorityDeniedError";
    this.attemptedOperation = attemptedOperation;
  }
}

/**
 * Raised for BOTH a truly-absent resource AND a resource whose labels/target
 * generation do not match — a UNIFORM denial, so cleanup can never be used as an
 * existence oracle. The message is fixed (it must not encode which case occurred).
 */
export class ResourceNotAvailableError extends Error {
  constructor() {
    super("resource not available");
    this.name = "ResourceNotAvailableError";
  }
}

export interface CleanupAuthorityConfig {
  readonly provider: SandboxProvider;
  /** The EXACT labels of the resource(s) this authority may act on. */
  readonly resourceLabels: ResourceLabels;
  /** The device generation the authority is fenced to (mismatch ⇒ denied). */
  readonly targetGeneration: number;
  readonly fence: EffectFence;
  /** ms-epoch after which escalation is mandatory (`isExpired`). */
  readonly deadline: number;
  /** Monotonic base epoch; the authority's epoch only ever increases from here. */
  readonly epoch: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  readonly now?: () => number;
}

export class CleanupAuthority {
  readonly #provider: SandboxProvider;
  readonly #resourceLabels: ResourceLabels;
  readonly #targetGeneration: number;
  readonly #fence: EffectFence;
  readonly #deadline: number;
  readonly #now: () => number;
  #epoch: number;
  #stage: CleanupStage = "none";

  constructor(config: CleanupAuthorityConfig) {
    this.#provider = config.provider;
    this.#resourceLabels = config.resourceLabels;
    this.#targetGeneration = config.targetGeneration;
    this.#fence = config.fence;
    this.#deadline = config.deadline;
    this.#epoch = config.epoch;
    this.#now = config.now ?? (() => Date.now());
  }

  get fence(): EffectFence {
    return this.#fence;
  }
  get resourceLabelsHash(): string {
    return hashResourceLabels(this.#resourceLabels);
  }
  cleanupEpoch(): number {
    return this.#epoch;
  }
  escalationStage(): CleanupStage {
    return this.#stage;
  }
  isExpired(now: number = this.#now()): boolean {
    return now >= this.#deadline;
  }

  // ---------------------------------------------------------------------------
  // Invariant #1 — effectful ops are ALWAYS denied under cleanup authority.
  // These exist so a denial is an EXPLICIT, testable throw (not a missing method).
  // ---------------------------------------------------------------------------
  create(): never {
    throw new CleanupAuthorityDeniedError("create");
  }
  execute(): never {
    throw new CleanupAuthorityDeniedError("execute");
  }
  resume(): never {
    throw new CleanupAuthorityDeniedError("resume");
  }
  checkpoint(): never {
    throw new CleanupAuthorityDeniedError("checkpoint");
  }
  health(): never {
    throw new CleanupAuthorityDeniedError("health");
  }
  openEgress(): never {
    throw new CleanupAuthorityDeniedError("open egress");
  }

  // ---------------------------------------------------------------------------
  // Invariant #2 — ownership check with NO existence oracle.
  // ---------------------------------------------------------------------------

  /** Resolve the FULL provider detail for a sandbox ONLY if it matches this
   * authority's bound labels + target generation; otherwise throw the uniform
   * {@link ResourceNotAvailableError}. The full detail NEVER leaves this method —
   * callers receive only a redacted projection. */
  async #requireOwned(sandboxId: string, ctx: ProviderOpContext) {
    let detail;
    try {
      detail = await this.#provider.inspect(sandboxId, ctx);
    } catch (err) {
      if (err instanceof SandboxNotFoundError) throw new ResourceNotAvailableError();
      throw err;
    }
    if (!labelsEqual(detail.resourceLabels, this.#resourceLabels) || detail.generation !== this.#targetGeneration) {
      // A non-matching label/generation is denied IDENTICALLY to not-found.
      throw new ResourceNotAvailableError();
    }
    return detail;
  }

  #redact(detail: {
    sandboxId: string;
    resourceLabels: ResourceLabels;
    generation: number;
    state: RedactedResourceProjection["state"];
    providerOpId: string;
  }): RedactedResourceProjection {
    return {
      sandboxId: detail.sandboxId,
      resourceLabelsHash: hashResourceLabels(detail.resourceLabels),
      generation: detail.generation,
      state: detail.state,
      providerOpId: detail.providerOpId,
    };
  }

  // ---------------------------------------------------------------------------
  // Allowed reads — management-only redacted projection.
  // ---------------------------------------------------------------------------

  /** List ONLY this authority's own matched resources, redacted. */
  async list(ctx: ProviderOpContext): Promise<readonly RedactedResourceProjection[]> {
    const result = await this.#provider.list(
      {
        ownershipSelector: {
          organizationId: this.#resourceLabels.organizationId,
          targetId: this.#resourceLabels.targetId,
          workerId: this.#resourceLabels.workerId,
        },
        pageSize: 100,
      },
      ctx,
    );
    return result.resources
      .filter((r) => labelsEqual(r.resourceLabels, this.#resourceLabels) && r.generation === this.#targetGeneration)
      .map((r) => this.#redact({ ...r, providerOpId: result.providerOpId }));
  }

  /** Inspect ONLY through the redacted management projection — never the command,
   * env, logs, secrets, workspace/customer bytes, or object grants. */
  async inspect(sandboxId: string, ctx: ProviderOpContext): Promise<RedactedResourceProjection> {
    const detail = await this.#requireOwned(sandboxId, ctx);
    return this.#redact(detail);
  }

  // ---------------------------------------------------------------------------
  // Allowed teardown ops — ownership-checked.
  // ---------------------------------------------------------------------------

  async cancel(sandboxId: string, ctx: ProviderOpContext): Promise<StopResult> {
    await this.#requireOwned(sandboxId, ctx);
    return this.#provider.cancel(sandboxId, ctx);
  }
  async kill(sandboxId: string, ctx: ProviderOpContext): Promise<StopResult> {
    await this.#requireOwned(sandboxId, ctx);
    return this.#provider.kill(sandboxId, ctx);
  }
  async destroy(sandboxId: string, ctx: ProviderOpContext): Promise<CleanupResult> {
    await this.#requireOwned(sandboxId, ctx);
    return this.#provider.destroy(sandboxId, ctx);
  }
  async reconcileCleanup(sandboxId: string, ctx: ProviderOpContext): Promise<CleanupResult> {
    await this.#requireOwned(sandboxId, ctx);
    return this.#provider.reconcileCleanup(sandboxId, ctx);
  }

  // ---------------------------------------------------------------------------
  // Invariant #3 — monotonic escalation ladder.
  // ---------------------------------------------------------------------------

  /** Advance one rung on the ladder (none→cancel→kill→destroy). Non-regressing:
   * at `destroy` it is a converged no-op. Every genuine advance bumps the epoch. */
  escalate(): CleanupStage {
    const index = CLEANUP_STAGES.indexOf(this.#stage);
    if (index >= CLEANUP_STAGES.length - 1) return this.#stage; // converged at destroy
    this.#stage = CLEANUP_STAGES[index + 1];
    this.#epoch += 1;
    return this.#stage;
  }

  /**
   * Drive the full cancel → kill → destroy convergence for the given owned
   * sandboxes. A compliant `cancel` (outcome `stopped`) skips `kill`; an ignored
   * cancel escalates to `kill`; an ignored kill escalates to a forced `destroy`.
   * A forced `destroy` is ALWAYS run last to reclaim the resource, retried
   * idempotently (with fresh op contexts) up to `maxDestroyAttempts`. Never
   * resurrects effect authority; returns the aggregate cleanup status.
   */
  async converge(
    sandboxIds: readonly string[],
    makeCtx: () => ProviderOpContext,
    maxDestroyAttempts = 3,
  ): Promise<CleanupStatus> {
    let aggregate: CleanupStatus = "success";
    for (const sandboxId of sandboxIds) {
      const status = await this.#convergeOne(sandboxId, makeCtx, maxDestroyAttempts);
      if (status === "failed") aggregate = "failed";
    }
    return aggregate;
  }

  async #convergeOne(
    sandboxId: string,
    makeCtx: () => ProviderOpContext,
    maxDestroyAttempts: number,
  ): Promise<CleanupStatus> {
    // Graceful cancel first.
    if (CLEANUP_STAGES.indexOf(this.#stage) < CLEANUP_STAGES.indexOf("cancel")) this.escalate();
    let cancel: StopResult;
    try {
      cancel = await this.cancel(sandboxId, makeCtx());
    } catch (err) {
      if (err instanceof ResourceNotAvailableError) return "success"; // already gone — nothing to converge
      // ★ ONE RUNG IS NOT THE CLASS. See `#indeterminate` below: `#requireOwned` gates ALL
      // THREE teardown ops, and a record is re-read at each, so the condition can first
      // appear at ANY rung. Handling it only here was the shape of the leak.
      if (this.#indeterminate(err)) return "failed";
      throw err;
    }
    if (cancel.outcome === "ignored") {
      // Escalate to kill.
      if (CLEANUP_STAGES.indexOf(this.#stage) < CLEANUP_STAGES.indexOf("kill")) this.escalate();
      let kill: StopResult;
      try {
        kill = await this.kill(sandboxId, makeCtx());
      } catch (err) {
        if (err instanceof ResourceNotAvailableError) return "success"; // vanished mid-converge
        // ★★★ THE SECOND RUNG. A record readable at `cancel` and UNREADABLE here threw past
        // `converge()` entirely — see `#indeterminate`.
        if (this.#indeterminate(err)) return "failed";
        throw err;
      }
      if (kill.outcome === "ignored") {
        // Both ignored — the forced destroy below stops the tree.
        if (CLEANUP_STAGES.indexOf(this.#stage) < CLEANUP_STAGES.indexOf("destroy")) this.escalate();
      }
    }
    // Reclaim: forced destroy, retried idempotently with FRESH op contexts.
    let status: CleanupStatus = "failed";
    for (let attempt = 0; attempt < maxDestroyAttempts; attempt += 1) {
      let result: CleanupResult;
      try {
        result = await this.destroy(sandboxId, makeCtx());
      } catch (err) {
        if (err instanceof ResourceNotAvailableError) return "success"; // vanished mid-converge
        // ★★★ THE THIRD RUNG, and the most expensive one to have missed: this is the
        // UNCONDITIONAL reclaim, so a throw escaping here is the leak in its purest form.
        // Retrying the loop would be worse than pointless — the ownership gate refuses on a
        // READ, and re-reading the same unclassifiable record just re-throws — so this
        // reports "failed" and leaves the resource to the next pass, like the rungs above.
        if (this.#indeterminate(err)) return "failed";
        throw err;
      }
      if (result.cleanupStatus === "success") {
        status = "success";
        break;
      }
    }
    return status;
  }

  /**
   * ★★★ SVC-008a — AN UNREADABLE RECORD MUST NOT DISARM THE REAPER, AND MUST NOT AUTHORIZE
   * A BLIND TEARDOWN EITHER. The single ruling, applied at EVERY rung.
   *
   * `#requireOwned` gates cancel, kill AND destroy on `inspect`, and `inspect` THROWS on a
   * record whose lifecycle state it cannot classify (rather than laundering it into an
   * affirmative state — the E7-F034 class). A provider record is re-read at every rung, so
   * the condition can first appear at any of them: a record that classified at `cancel` and
   * became unclassifiable at `kill` or `destroy` is the ordinary case, not an exotic one.
   *
   * Left to propagate, that throw escapes `converge()` before the UNCONDITIONAL forced
   * `destroy`, leaking a paid resource: strictly worse than the defect being repaired, which
   * leaked nothing. Worse still, `supervisor.ts` consumes the terminal `run.cleanedUp` latch
   * BEFORE calling `converge`, so the rejection also suppresses the retry — the sandbox
   * survives until an external reaper finds it. And swallowing it as `"success"` would be
   * worse than both: a converged claim over a resource nothing observed.
   *
   * So: report `"failed"`. The resource stays discoverable and RETRYABLE, the caller gets no
   * false convergence, and no teardown is performed against a record whose ownership could
   * not be established. That is the same non-destructive `indeterminate -> leave it to the
   * reaper` disposition `startup-reconcile` already models for an unreachable lease probe.
   *
   * ★ MATCHED BY NAME, NOT BY `instanceof`. `SandboxRecordIndeterminateError` crosses a
   * package boundary (`sandbox-e2b-provider` imports the class from this package's public
   * entry point), and a duplicated module instance under a different resolution would make
   * `instanceof` silently false — a fail-OPEN miss that reinstates the leak with every test
   * still green. The name is the stable identity across that boundary; the `instanceof` is
   * kept as the fast path so a subclass still matches.
   */
  #indeterminate(err: unknown): boolean {
    if (err instanceof SandboxRecordIndeterminateError) return true;
    return err instanceof Error && err.name === "SandboxRecordIndeterminateError";
  }
}
