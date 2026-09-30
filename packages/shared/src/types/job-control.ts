export type SubmitJobSource =
  | {
      kind: "task_run";
      runId: string;
      issueId: string;
      assigneeAgentId: string;
    }
  | {
      kind: "commander_turn";
      internalAgentRunId: string;
      conversationId: string;
    }
  | {
      kind: "crew_run";
      crewRunId: string;
    }
  | {
      kind: "one_shot";
      operationId: string;
      operationKind: "extraction" | "compaction" | "readiness_probe";
    }
  | {
      kind: "browser_request";
      browserRequestId: string;
      parentJobId: string | null;
    }
  | {
      kind: "service_reconcile";
      serviceId: string;
      generation: number;
      reconciliationId: string;
    };

/** External, authenticated source intent. Server-owned delivery fields are absent by design. */
export interface SubmitJobCommand {
  idempotencyKey: string;
  source: SubmitJobSource;
  input: Record<string, unknown>;
}

export interface SubmitJobResponse {
  jobId: string;
  attemptId: string;
  status: "queued";
  replayed: boolean;
}

export type JobPlacementMode = "active" | "shadow" | "legacy";
export type JobPlacementOwner =
  | "legacy"
  | "managed_cloud"
  | "organization_dedicated"
  | "owner_desktop";
export type JobPlacementDisposition = "selected" | "legacy" | "queued" | "failed";

/** Immutable, server-owned JOB-009 result persisted before JOB-003 may lease. */
export interface JobPlacementDecision {
  disposition: JobPlacementDisposition;
  owner: JobPlacementOwner | null;
  targetId: string | null;
  targetClass: Exclude<JobPlacementOwner, "legacy"> | null;
  targetScope: "platform" | "organization" | "owner" | null;
  targetGeneration: number | null;
  profileHash: string | null;
  providerConstraintHash: string | null;
  fallbackDisposition: "not_applicable" | "primary" | "ordered_explicit" | "forbidden";
  reasonCode: string;
  mode: JobPlacementMode;
  leaseEligible: boolean;
  inputDigest: string;
  policyDigest: string;
}

// ---------------------------------------------------------------------------
// JOB-008 — REDACTED operator read envelopes.
//
// These are the ONLY job/attempt/lease/event/worker shapes an authorized tenant
// operator may read. They are redacted BY CONSTRUCTION: the server never selects the
// cross-tenant id sinks (`job_attempts.placement_target_id`, `leases.target_id`,
// `workers.execution_target_id`), the capability/token sinks (`leases.fence`,
// `job_events.fence_token`, `workers.*_token_hash`), or any intent/policy/payload
// column. A field that is absent here is absent from the wire. Do NOT widen without a
// successor decision — every added field must be re-checked against the redaction map.
// ---------------------------------------------------------------------------

/** Redacted job aggregate row (drops input/intent/policy/command/idempotency). */
export interface JobSummary {
  id: string;
  status: string;
  workloadType: string;
  priority: number;
  availableAt: string;
  maxAttempts: number;
  deadLetterReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Redacted attempt row: placement CLASS/SCOPE/reason only — never the target id or digests. */
export interface AttemptSummary {
  id: string;
  attemptNumber: number;
  status: string;
  placementDisposition: string | null;
  placementOwner: string | null;
  placementTargetClass: string | null;
  placementTargetScope: string | null;
  placementReasonCode: string | null;
  placementMode: string | null;
  placementFallbackDisposition: string | null;
  placementLeaseEligible: boolean | null;
  capacityClaimState: string;
  capacityWorkloadType: string | null;
  placementDecidedAt: string | null;
  backoffUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Redacted lease row: drops the fence capability token + cross-tenant target/worker/authority ids. */
export interface LeaseSummary {
  id: string;
  attemptId: string | null;
  attemptNumber: number | null;
  status: string;
  ackDeadline: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  releasedAt: string | null;
  targetGeneration: number | null;
  createdAt: string;
}

/** Redacted event row: metadata + digest only — never the jsonb payload or fence token. */
export interface EventSummary {
  id: string;
  attemptId: string;
  attemptNumber: number;
  sequence: number;
  eventType: string;
  eventDigest: string;
  occurredAt: string;
  createdAt: string;
}

/** Redacted worker row: drops device keys, profile snapshot, and cross-tenant execution target id. */
export interface WorkerSummary {
  id: string;
  scope: string;
  status: string;
  label: string;
  lastSeenAt: string | null;
  deviceGeneration: number;
  enrolledAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Composed job detail: the redacted job + its attempts, leases, and event metadata. */
/** BRW-003d-4 — one artifact row as an operator sees it. Every disposition is
 * returned (granted / committed / quarantined / expired), which is why `status`
 * is on the wire: the row that survives a refused commit is the `granted` intent
 * row, and hiding it would make "the record stays discoverable" false. */
export interface JobArtifactSummary {
  id: string;
  attempt: number | null;
  identifier: string;
  kind: string | null;
  status: string | null;
  applyStatus: string | null;
  versionNumber: number | null;
  sizeBytes: number | null;
  sha256: string | null;
  committedAt: string | Date | null;
  expiresAt: string | Date | null;
  createdAt: string | Date;
}

export interface JobDetail {
  job: JobSummary;
  attempts: AttemptSummary[];
  leases: LeaseSummary[];
  events: EventSummary[];
  /** True when the events list was capped. Reported so truncation is never silent. */
  eventsTruncated: boolean;
  artifacts: JobArtifactSummary[];
  artifactsTruncated: boolean;
}

/** Result of an operator drain (job-level graceful cancellation) request. */
export interface JobDrainResult {
  status: string;
  command: { commandId: string; commandSeq: number } | null;
}

/** Result of an operator worker-revocation request. */
export interface WorkerRevokeResult {
  revoked: boolean;
  reason?: "not_found" | "already_disabled";
  revokedGeneration?: number;
}
