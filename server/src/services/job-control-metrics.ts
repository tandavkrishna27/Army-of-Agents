// JOB-003 payload-free job-control telemetry (E3-F032).
//
// A closed, bounded metrics surface for the leasing certificate, scheduler capacity/expiry, and
// outbox launch window. Every event carries only hand-derived numeric counts, saturation flags,
// and the closed scheduler scope union — never tenant payload, identity, or free-form fields.
// The adapter constructs each emitted object explicitly, so an extra caller field can never reach
// the log. Counts are clamped to a non-negative safe integer; the scope is clamped to the union.

export type SchedulerCapacityScope = "organization" | "target" | "global";

// DEP-007 — four additional count-only, id-free metric families for the (previously
// telemetry-silent) provider-lifecycle, egress-deny, secret-read, and artifact-commit
// chokepoints. Every label below is a CLOSED low-cardinality enum or a clampCount
// integer — NEVER a high-cardinality id (org/company/job/attempt/lease/worker/target).
// High-cardinality correlation ids ride the LOGGER spine (job-events.ts + worker-control
// routes), never a metric label. Adding an id field breaks the compile-closed guard in
// job-control-metrics.test.ts (the id-rejection mirror).
export type ProviderLifecycleOperation = "acquire" | "release" | "resume";
export type ProviderLifecycleOutcome = "succeeded" | "failed";
export type EgressDeniedReason =
  | "metadata"
  | "private"
  | "control_plane"
  | "not_allowlisted"
  | "malformed"
  | "stale_fence"
  | "attempt_terminal"
  | "target_revoked";
export type SecretReadOutcome = "resolved" | "device_handoff" | "denied";
export type ArtifactOpOperation = "commit" | "transfer_grant";
export type ArtifactOpOutcome = "committed" | "rejected";

export interface JobControlMetrics {
  certificateScan(value: {
    readonly hitsObserved: number;
    readonly hitsSaturated: boolean;
    readonly missesObserved: number;
    readonly missesSaturated: boolean;
    readonly scanExhausted: boolean;
    readonly cardinalityObserved: number;
    readonly cardinalitySaturated: boolean;
  }): void;
  certificateUpsert(value: { readonly count: number }): void;
  certificateCleanup(value: {
    readonly count: number;
    readonly cardinalityObserved: number;
    readonly cardinalitySaturated: boolean;
  }): void;
  headRestart(): void;
  schedulerCapacityReject(value: { readonly scope: SchedulerCapacityScope }): void;
  schedulerExpiry(value: { readonly count: number }): void;
  schedulerCardinality(value: {
    readonly organizations: number;
    readonly targets: number;
    readonly signals: number;
  }): void;
  outboxTick(value: {
    readonly budgetMs: number;
    readonly elapsedMs: number;
    readonly overshootMs: number;
    readonly organizations: number;
    readonly claimed: number;
    readonly delivered: number;
    readonly cleaned: number;
  }): void;
  providerLifecycle(value: {
    readonly operation: ProviderLifecycleOperation;
    readonly outcome: ProviderLifecycleOutcome;
    readonly count: number;
  }): void;
  egressDenied(value: {
    readonly reason: EgressDeniedReason;
    readonly count: number;
  }): void;
  secretRead(value: {
    readonly outcome: SecretReadOutcome;
    readonly count: number;
  }): void;
  artifactOp(value: {
    readonly operation: ArtifactOpOperation;
    readonly outcome: ArtifactOpOutcome;
    readonly count: number;
  }): void;
}

/** Clamp any observed count to a non-negative floored safe integer; non-finite becomes zero. */
function clampCount(value: number): number {
  return Number.isFinite(value)
    ? Math.min(Math.max(0, Math.floor(value)), Number.MAX_SAFE_INTEGER)
    : 0;
}

/** Clamp an out-of-union scope down to the safe default so telemetry never widens the contract. */
function clampScope(value: SchedulerCapacityScope): SchedulerCapacityScope {
  return value === "organization" || value === "target" || value === "global" ? value : "global";
}

// DEP-007 — each closed-enum clamp folds an out-of-union value to the SAFE (most
// conservative) default so a caller can never widen the metric contract, exactly like
// clampScope. The defaults bias toward the failure/denied end so a misuse under-reports
// success rather than fabricating it.
function clampProviderOperation(value: ProviderLifecycleOperation): ProviderLifecycleOperation {
  return value === "acquire" || value === "release" || value === "resume" ? value : "acquire";
}
function clampProviderOutcome(value: ProviderLifecycleOutcome): ProviderLifecycleOutcome {
  return value === "succeeded" || value === "failed" ? value : "failed";
}
function clampEgressDeniedReason(value: EgressDeniedReason): EgressDeniedReason {
  switch (value) {
    case "metadata":
    case "private":
    case "control_plane":
    case "not_allowlisted":
    case "malformed":
    case "stale_fence":
    case "attempt_terminal":
    case "target_revoked":
      return value;
    default:
      return "malformed";
  }
}
function clampSecretReadOutcome(value: SecretReadOutcome): SecretReadOutcome {
  return value === "resolved" || value === "device_handoff" || value === "denied" ? value : "denied";
}
function clampArtifactOperation(value: ArtifactOpOperation): ArtifactOpOperation {
  return value === "commit" || value === "transfer_grant" ? value : "commit";
}
function clampArtifactOutcome(value: ArtifactOpOutcome): ArtifactOpOutcome {
  return value === "committed" || value === "rejected" ? value : "rejected";
}

/**
 * Frozen no-op metrics: services default to this when telemetry is not composed. Each method
 * allocates nothing and emits nothing.
 */
export const NOOP_JOB_CONTROL_METRICS: JobControlMetrics = Object.freeze({
  certificateScan: () => {},
  certificateUpsert: () => {},
  certificateCleanup: () => {},
  headRestart: () => {},
  schedulerCapacityReject: () => {},
  schedulerExpiry: () => {},
  schedulerCardinality: () => {},
  outboxTick: () => {},
  providerLifecycle: () => {},
  egressDenied: () => {},
  secretRead: () => {},
  artifactOp: () => {},
});

/**
 * Adapter that logs each closed event as one structured record. Telemetry is best-effort: a
 * failing logger is swallowed and never changes control flow.
 */
export function createPinoJobControlMetrics(
  log: { info: (...args: unknown[]) => void },
): JobControlMetrics {
  const emit = (record: Readonly<Record<string, unknown>>): void => {
    try {
      log.info(record);
    } catch {
      // Best-effort telemetry: a failing logger never changes control flow.
    }
  };
  return {
    certificateScan: (value) => emit({
      event: "job_control.certificate_scan",
      hitsObserved: clampCount(value.hitsObserved),
      hitsSaturated: value.hitsSaturated === true,
      missesObserved: clampCount(value.missesObserved),
      missesSaturated: value.missesSaturated === true,
      scanExhausted: value.scanExhausted === true,
      cardinalityObserved: clampCount(value.cardinalityObserved),
      cardinalitySaturated: value.cardinalitySaturated === true,
    }),
    certificateUpsert: (value) => emit({
      event: "job_control.certificate_upsert",
      count: clampCount(value.count),
    }),
    certificateCleanup: (value) => emit({
      event: "job_control.certificate_cleanup",
      count: clampCount(value.count),
      cardinalityObserved: clampCount(value.cardinalityObserved),
      cardinalitySaturated: value.cardinalitySaturated === true,
    }),
    headRestart: () => emit({ event: "job_control.head_restart" }),
    schedulerCapacityReject: (value) => emit({
      event: "job_control.scheduler_capacity_reject",
      scope: clampScope(value.scope),
    }),
    schedulerExpiry: (value) => emit({
      event: "job_control.scheduler_expiry",
      count: clampCount(value.count),
    }),
    schedulerCardinality: (value) => emit({
      event: "job_control.scheduler_cardinality",
      organizations: clampCount(value.organizations),
      targets: clampCount(value.targets),
      signals: clampCount(value.signals),
    }),
    outboxTick: (value) => emit({
      event: "job_control.outbox_tick",
      budgetMs: clampCount(value.budgetMs),
      elapsedMs: clampCount(value.elapsedMs),
      overshootMs: clampCount(value.overshootMs),
      organizations: clampCount(value.organizations),
      claimed: clampCount(value.claimed),
      delivered: clampCount(value.delivered),
      cleaned: clampCount(value.cleaned),
    }),
    providerLifecycle: (value) => emit({
      event: "job_control.provider_lifecycle",
      operation: clampProviderOperation(value.operation),
      outcome: clampProviderOutcome(value.outcome),
      count: clampCount(value.count),
    }),
    egressDenied: (value) => emit({
      event: "job_control.egress_denied",
      reason: clampEgressDeniedReason(value.reason),
      count: clampCount(value.count),
    }),
    secretRead: (value) => emit({
      event: "job_control.secret_read",
      outcome: clampSecretReadOutcome(value.outcome),
      count: clampCount(value.count),
    }),
    artifactOp: (value) => emit({
      event: "job_control.artifact_op",
      operation: clampArtifactOperation(value.operation),
      outcome: clampArtifactOutcome(value.outcome),
      count: clampCount(value.count),
    }),
  };
}
