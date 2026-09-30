// server/src/services/job-shadow-comparator.ts
//
// CLI-005 (D2) — the effect-free shadow comparator.
// MIG-005/006/007 (D2/D3) — generalized to every execution source, and taught the
// difference between "agreed" and "never checked".
//
// When an execution resolves to `shadow`, this service RECORDS the legacy run's
// resolved routing / provenance / policy and, where the caller can supply an
// INDEPENDENTLY DERIVED value, diffs the two — with NO durable submission. By
// construction it:
//
//   * writes NO `jobs` / `job_attempts` row (it is handed no Db/tx — it cannot),
//   * drives NO checkout, claims NO capacity, holds NO lease,
//   * emits NO `cost_events` / `activity_log` / run-summary,
//   * NEVER throws into the legacy run (every compute + sink write is wrapped).
//
// Its only output is a comparison record on an injected observable sink (in prod: the
// `job_trace_log` pino spine + count-only metrics).
//
// ── WHY THE IDENTITY MAPPING IS GONE ────────────────────────────────────────────
// This module used to default `deriveDistributedIntent` to an IDENTITY function that
// copied the snapshot, and then diffed the snapshot against that copy. Every field
// therefore compared equal to itself: `match` was `true` for 100% of runs, forever,
// and the production composition never supplied a replacement. Measured at MIG terrain
// time: 2,000 randomized snapshots across all six fields, 0 divergences. A divergence
// rate whose numerator cannot increment is not weak evidence — it is false evidence,
// and gate clause 2 opens on exactly that number.
//
// The rule that replaces it: **an uncompared field is recorded as uncompared, never as
// matching.** A field is compared only when the caller supplies an independently
// derived value for it; `comparedFields` is the denominator, and a record in which
// nothing could be compared is `not_compared`, never `agree`.
//
// The caller supplies the independent value because the caller is where a `Db` legitimately
// lives (design D4). Keeping the handle OUT of this module is what makes effect-freeness
// structural rather than promised.

import type { SubmitJobSource } from "@armyofagents/shared";
import { submitJobSourceIdentity, submitJobSourceWorkloadType } from "@armyofagents/shared";
import { batchWorkloadV1Schema, type BatchWorkloadV1 } from "@armyofagents/worker-protocol";

/**
 * A snapshot of the legacy run's ACTUAL resolved execution intent, captured at a sink's
 * seam AFTER routing/provenance/policy resolution. The comparator treats it as read-only
 * data; it never re-resolves anything against the database.
 */
export interface LegacyRunExecutionSnapshot {
  readonly organizationId: string;
  readonly companyId: string;
  /**
   * The execution source, carrying its OWN identity fields. Not a task triple:
   * `commander_turn` / `crew_run` / `one_shot` have no run or issue, and the FROZEN
   * worker-protocol variants are `.strict()`, so fabricating one is refused at the
   * schema boundary.
   */
  readonly source: SubmitJobSource;
  /** The distributed workload type this execution maps to. */
  readonly workloadType: string;
  readonly routing: { readonly executionTargetType: string };
  readonly provenance: {
    readonly executionPrincipalKind: string;
    readonly credentialKind: string | null;
  };
  readonly policy: {
    readonly model: string | null;
    readonly budgetPolicyId: string | null;
    readonly effectiveCompletionPolicy: string;
  };
  /**
   * O7 characterization of the batch workload the run would submit. Faithful,
   * worker-executable synthesis is refined at MIG-002; shadow only needs a diff-stable
   * mapping, validated against the frozen `batchWorkloadV1Schema`.
   */
  readonly workloadCharacterization: {
    readonly command: string;
    readonly args: string[];
    readonly maxRuntimeSeconds: number;
    readonly stdinArtifactId: string | null;
  };
}

/**
 * The fields a shadow pass is capable of comparing. This list is the DENOMINATOR of
 * the divergence rate reported to the Wave-3/4 gate; every field is either compared
 * against an independently derived value or explicitly recorded as uncompared.
 */
export const SHADOW_COMPARABLE_FIELDS = [
  // Always compared: the comparator derives this one itself, purely, from the source —
  // see `workloadType` below. It is the only field that never needs a caller.
  "workloadType",
  // Compared only when the caller supplies an independently derived value.
  "routing.executionTargetType",
  "provenance.executionPrincipalKind",
  "provenance.credentialKind",
  "policy.model",
  "policy.budgetPolicyId",
  "policy.effectiveCompletionPolicy",
] as const;
export type ShadowComparableField = (typeof SHADOW_COMPARABLE_FIELDS)[number];

/**
 * The six fields that require a caller-supplied independent value. Separated from
 * `workloadType` so a test can assert that none of THESE is ever counted as agreement
 * without one — the property the identity-mapping defect violated.
 */
export const SHADOW_CALLER_DERIVED_FIELDS = SHADOW_COMPARABLE_FIELDS.filter(
  (f) => f !== "workloadType",
);

/**
 * An INDEPENDENTLY DERIVED projection of the distributed intent. Deliberately partial:
 * only fields with a genuine second authority are supplied, and everything absent is
 * reported as uncompared rather than silently counted as agreement.
 *
 * A supplied `null` is a VALUE, not an absence — `credentialKind` and `budgetPolicyId`
 * are legitimately null in production, and conflating the two would drop them out of
 * the denominator.
 */
export interface DistributedIntentProjection {
  readonly routing?: { readonly executionTargetType?: string };
  readonly provenance?: {
    readonly executionPrincipalKind?: string;
    readonly credentialKind?: string | null;
  };
  readonly policy?: {
    readonly model?: string | null;
    readonly budgetPolicyId?: string | null;
    readonly effectiveCompletionPolicy?: string;
  };
}

/**
 * `agree` — at least one field was compared and none diverged.
 * `diverge` — at least one compared field differed.
 * `not_compared` — nothing had an independent value to compare against. NOT agreement.
 */
export type ShadowComparisonVerdict = "agree" | "diverge" | "not_compared";

export interface ShadowComparisonResult {
  readonly organizationId: string;
  readonly companyId: string;
  readonly sourceKind: SubmitJobSource["kind"];
  /** The source's discriminant identity — runId, internalAgentRunId, crewRunId, … */
  readonly sourceId: string;
  readonly mode: "shadow";
  readonly match: ShadowComparisonVerdict;
  /** Fields an independent value was supplied for. The gate's denominator. */
  readonly comparedFields: string[];
  /** Fields captured but NOT checked. Never counted as agreement. */
  readonly uncomparedFields: string[];
  /** Always a subset of `comparedFields`. */
  readonly mismatchedFields: string[];
  readonly wouldBeSource: SubmitJobSource;
  readonly wouldBeWorkload: BatchWorkloadV1 | null;
  readonly workloadValid: boolean;
  /** Structurally false for shadow (leaseEligible = mode === "active"). */
  readonly placementLeaseEligible: boolean;
  readonly placementReasonCode: string;
  /** Read-only admissibility probe result, if the caller supplied one; else null. */
  readonly admissible: boolean | null;
  /**
   * WHY the probe answered as it did, and WHICH authorities actually ran.
   *
   * Without these the record can say "would have been refused" and not say why, which
   * makes gate clause 2's "every divergence explained" unmeetable from the evidence —
   * and makes the per-sink signal asymmetry (one_shot has no source authority)
   * invisible in aggregate. Building the evidence table is what exposed that they were
   * being computed and then dropped.
   */
  readonly admissibilityReason: string | null;
  readonly admissibilityAuthorities: string[];
  /** True iff the best-effort compute threw (the failure is recorded, never propagated). */
  readonly errored: boolean;
}

export interface ShadowComparisonSink {
  record(result: ShadowComparisonResult): void;
}

/**
 * Walk the six comparable fields once, partitioning them into compared / uncompared and
 * collecting mismatches. `undefined` means "no independent value supplied"; `null` is a
 * supplied value and IS compared.
 */
function compareFields(
  snapshot: LegacyRunExecutionSnapshot,
  intent: DistributedIntentProjection,
): { compared: string[]; uncompared: string[]; mismatched: string[] } {
  // Absence is `undefined`; a supplied `null` is a VALUE and IS compared. Reading the
  // optional property straight through gets both right — `null !== undefined`. An earlier
  // draft tested key PRESENCE with `in` plus `?? null`, which additionally coerced an
  // explicitly-`undefined` key into a compared `null` and could invent a divergence.
  const pairs: ReadonlyArray<
    readonly [ShadowComparableField, string | null, string | null | undefined]
  > = [
    [
      // The one field with a second authority that needs no caller: what workload class
      // a REAL submission would compute from this source. A seam that declares the wrong
      // class (e.g. "batch" for a browser_request) diverges here.
      "workloadType",
      snapshot.workloadType,
      submitJobSourceWorkloadType(snapshot.source),
    ],
    [
      "routing.executionTargetType",
      snapshot.routing.executionTargetType,
      intent.routing?.executionTargetType,
    ],
    [
      "provenance.executionPrincipalKind",
      snapshot.provenance.executionPrincipalKind,
      intent.provenance?.executionPrincipalKind,
    ],
    ["provenance.credentialKind", snapshot.provenance.credentialKind, intent.provenance?.credentialKind],
    ["policy.model", snapshot.policy.model, intent.policy?.model],
    ["policy.budgetPolicyId", snapshot.policy.budgetPolicyId, intent.policy?.budgetPolicyId],
    [
      "policy.effectiveCompletionPolicy",
      snapshot.policy.effectiveCompletionPolicy,
      intent.policy?.effectiveCompletionPolicy,
    ],
  ];

  const compared: string[] = [];
  const uncompared: string[] = [];
  const mismatched: string[] = [];
  for (const [field, actual, derived] of pairs) {
    if (derived === undefined) {
      uncompared.push(field);
      continue;
    }
    compared.push(field);
    if (actual !== derived) mismatched.push(field);
  }
  return { compared, uncompared, mismatched };
}

export interface JobShadowComparator {
  compare(
    snapshot: LegacyRunExecutionSnapshot,
    options?: {
      admissible?: boolean | null;
      /** Why, and by which authorities — carried into the record so a refusal is
       *  explainable from the evidence rather than only from a re-run. */
      admissibilityReason?: string | null;
      admissibilityAuthorities?: readonly string[];
      /** The independently derived distributed intent, if the caller has one. */
      intent?: DistributedIntentProjection;
    },
  ): ShadowComparisonResult;
}

export function createJobShadowComparator(deps: {
  sink: ShadowComparisonSink;
}): JobShadowComparator {
  return {
    compare(snapshot, options = {}) {
      // OUTER GUARD. The inner try covers the field comparison, but the record's own
      // construction reads `snapshot.source` (for `sourceKind` / `sourceId`), and a
      // malformed source would throw straight into the legacy run — breaking this
      // module's first promise. Three new seams hand-build a source, so this is the
      // difference between a bad snapshot degrading an observability record and a bad
      // snapshot failing a live Commander turn.
      let result: ShadowComparisonResult;
      try {
        result = buildComparison(snapshot, options);
      } catch {
        result = erroredComparison(snapshot, options);
      }
      try {
        deps.sink.record(result);
      } catch {
        // The sink is observability only; a sink failure never fails the run.
      }
      return result;
    },
  };
}

/** The record produced when the comparison could not be built at all. Claims nothing. */
function erroredComparison(
  snapshot: LegacyRunExecutionSnapshot | undefined,
  options: {
    admissible?: boolean | null;
    admissibilityReason?: string | null;
    admissibilityAuthorities?: readonly string[];
  },
): ShadowComparisonResult {
  return {
    organizationId: typeof snapshot?.organizationId === "string" ? snapshot.organizationId : "",
    companyId: typeof snapshot?.companyId === "string" ? snapshot.companyId : "",
    sourceKind: (snapshot?.source?.kind ?? "task_run") as SubmitJobSource["kind"],
    sourceId: "",
    mode: "shadow",
    match: "not_compared",
    comparedFields: [],
    uncomparedFields: [...SHADOW_COMPARABLE_FIELDS],
    mismatchedFields: [],
    wouldBeSource: snapshot?.source as SubmitJobSource,
    wouldBeWorkload: null,
    workloadValid: false,
    placementLeaseEligible: false,
    placementReasonCode: "shadow_selected",
    admissible: options.admissible ?? null,
    admissibilityReason: options.admissibilityReason ?? null,
    admissibilityAuthorities: [...(options.admissibilityAuthorities ?? [])],
    errored: true,
  };
}

function buildComparison(
  snapshot: LegacyRunExecutionSnapshot,
  options: {
    admissible?: boolean | null;
    admissibilityReason?: string | null;
    admissibilityAuthorities?: readonly string[];
    intent?: DistributedIntentProjection;
  },
): ShadowComparisonResult {
  const parsedWorkload = batchWorkloadV1Schema.safeParse({
    command: snapshot.workloadCharacterization.command,
    args: snapshot.workloadCharacterization.args,
    stdinArtifactId: snapshot.workloadCharacterization.stdinArtifactId,
    maxRuntimeSeconds: snapshot.workloadCharacterization.maxRuntimeSeconds,
  });

  const { compared, uncompared, mismatched } = compareFields(snapshot, options.intent ?? {});
  const match: ShadowComparisonVerdict =
    mismatched.length > 0 ? "diverge" : compared.length > 0 ? "agree" : "not_compared";

  return {
    organizationId: snapshot.organizationId,
    companyId: snapshot.companyId,
    sourceKind: snapshot.source.kind,
    sourceId: submitJobSourceIdentity(snapshot.source),
    mode: "shadow",
    match,
    comparedFields: compared,
    uncomparedFields: uncompared,
    mismatchedFields: mismatched,
    wouldBeSource: snapshot.source,
    wouldBeWorkload: parsedWorkload.success ? parsedWorkload.data : null,
    workloadValid: parsedWorkload.success,
    // Shadow placement is non-leasable by construction (see module header).
    placementLeaseEligible: false,
    placementReasonCode: "shadow_selected",
    admissible: options.admissible ?? null,
    admissibilityReason: options.admissibilityReason ?? null,
    admissibilityAuthorities: [...(options.admissibilityAuthorities ?? [])],
    errored: false,
  };
}
