import { createHash, randomBytes } from "node:crypto";
import {
  configurePlatformTargetAuthorityLockTimeout,
  operatorJobLeasingRepository,
  type Db,
  type Job,
  type JobAttempt,
  type LeaseWorkerAuthority,
  type TenantRepositories,
} from "@armyofagents/db";
import {
  jobEnvelopeV1Schema,
  canonicalizeJsonV1,
  leaseAckOperationRequestV1Schema,
  leaseAckOperationResponseV1Schema,
  leaseOfferV1Schema,
  pollRequestV1Schema,
  pollResponseV1Schema,
  principalV1Schema,
  workerHelloV1Schema,
  type ExecutionSourceV1,
  type JobCapabilityRequirementsV1,
  type JobEnvelopeV1,
  type LeaseAckOperationRequestV1,
  type LeaseAckOperationResponseV1,
  type PollRequestV1,
  type PollResponseV1,
  type PrincipalV1,
  type WorkerCapacity,
  type WorkerHelloV1,
} from "@armyofagents/worker-protocol";
import { runInTenant } from "../db/tenant-context.js";
import {
  toSecretHandleRefs,
  type CandidateSecretHandleRef,
} from "./execution-secret-handle-envelope.js";
import {
  stagedInputExtension,
  stagedInputPointersFromRows,
  type StagedInputPointer,
} from "./job-input-staging.js";
import type { JobReadyScheduler } from "./job-ready-scheduler.js";
import { NOOP_JOB_CONTROL_METRICS, type JobControlMetrics } from "./job-control-metrics.js";
import {
  EXECUTION_TARGET_KINDS,
  normalizePlacementRegistryTarget,
  type NormalizedPlacementRegistryTarget,
} from "./execution-target-resolver.js";
import { evaluateKillSwitches } from "./execution-kill-switches.js";
import { createKillSwitchPolicyReader } from "./execution-kill-switch-policy.js";
import { normalizeSubmittedJobPlacementFacts } from "./job-placement.js";
import {
  buildLeaseStaticContextInput,
  evaluateStaticLeaseEligibility,
  LEASE_STATIC_ELIGIBILITY_VERSION,
  leaseStaticContextHash,
} from "./job-lease-eligibility.js";
import type { VerifiedWorkerOperation } from "../middleware/worker-operation-proof.js";
import {
  createWorkerDenialSink,
  pollAuthorityDenialIntent,
  ackAuthorityDenialIntent,
  drainWorkerDenial,
  workerProofReplayIntent,
  type WorkerDenialIntent,
} from "./worker-denial-audit.js";

export type { VerifiedWorkerOperation } from "../middleware/worker-operation-proof.js";


/**
 * REL-004 clause 3a — how long a drained worker waits before polling again.
 *
 * NON-NULL on purpose. The frozen protocol makes `retryAfterMs` nullable on a drain, and the
 * worker daemon reads the two cases differently: `null` is a terminal drain that exits the poll
 * loop, a value is a reversible pause. A kill switch must be un-throwable without restarting
 * every worker, so it always sends a value. The daemon clamps it into its own backoff bounds.
 */
export const KILL_SWITCH_DRAIN_RETRY_AFTER_MS = 30_000;

export class JobLeasingError extends Error {
  constructor(public readonly code:
    | "malformed"
    | "unauthorized"
    | "target_revoked"
    | "stale_fence"
    | "attempt_terminal"
    | "internal_unavailable") {
    super(`Job leasing ${code}`);
    this.name = "JobLeasingError";
  }
}

function normalizeOperatorDatabaseErrors(operatorDb: Db | undefined): Db | undefined {
  if (!operatorDb) return undefined;
  return {
    transaction: async (callback: (tx: Db) => Promise<unknown>) => {
      try {
        return await operatorDb.transaction(callback as never);
      } catch (error) {
        if (error instanceof JobLeasingError) throw error;
        throw new JobLeasingError("internal_unavailable");
      }
    },
  } as unknown as Db;
}

function semanticAckDigest(
  auth: VerifiedWorkerOperation,
  request: LeaseAckOperationRequestV1,
): string {
  return createHash("sha256").update(canonicalizeJsonV1({
    audience: request.audience,
    workerId: auth.workerId,
    targetId: auth.targetId,
    targetGeneration: auth.targetGeneration,
    profileHash: auth.profileHash,
    body: request.body,
  })).digest("hex");
}

function principal(kind: string, id: string): PrincipalV1 {
  const principalType = kind === "agent"
    ? "agent"
    : kind === "system"
      ? "system"
      : kind === "service" || kind === "service_instance"
        ? "service"
        : "user";
  return principalV1Schema.parse({ principalType, principalId: id });
}

function source(job: Job): ExecutionSourceV1 | null {
  const intent = job.sourceIntent as Record<string, unknown>;
  const requestedBy = principal(job.requesterPrincipalKind, job.requesterPrincipalId);
  const defaultExecutor = principal(job.executorPrincipalKind, job.executorPrincipalId);
  const kind = intent.kind;
  const candidate = kind === "task_run"
    ? {
        kind,
        runId: intent.runId,
        issueId: intent.issueId,
        assigneeAgentId: intent.assigneeAgentId,
        requestedBy,
        executionPrincipal: { principalType: "agent", principalId: job.executorPrincipalId },
      }
    : kind === "commander_turn"
      ? {
          kind,
          internalAgentRunId: intent.internalAgentRunId,
          conversationId: intent.conversationId,
          requestedBy,
          executionPrincipal: defaultExecutor,
        }
      : kind === "crew_run"
        ? { kind, crewRunId: intent.crewRunId, requestedBy, executionPrincipal: defaultExecutor }
        : kind === "one_shot"
          ? {
              kind,
              operationId: intent.operationId,
              operationKind: intent.operationKind,
              requestedBy,
              executionPrincipal: defaultExecutor,
            }
          : kind === "browser_request"
            ? {
                kind,
                browserRequestId: intent.browserRequestId,
                parentJobId: intent.parentJobId,
                requestedBy,
                executionPrincipal: defaultExecutor,
              }
            : kind === "service_reconcile"
              ? {
                  kind,
                  serviceId: intent.serviceId,
                  generation: intent.generation,
                  reconciliationId: intent.reconciliationId,
                  requestedBy,
                  executionPrincipal: defaultExecutor,
                }
              : null;
  if (!candidate) return null;
  // The final JobEnvelope parse below is the authoritative strict source parse.
  return candidate as ExecutionSourceV1;
}

function minCapacity(left: WorkerCapacity, right: WorkerCapacity): WorkerCapacity {
  return {
    batchSlots: Math.min(left.batchSlots, right.batchSlots),
    browserSessionSlots: Math.min(left.browserSessionSlots, right.browserSessionSlots),
    serviceSlots: Math.min(left.serviceSlots, right.serviceSlots),
    freeCpuMillis: Math.min(left.freeCpuMillis, right.freeCpuMillis),
    freeMemoryMiB: Math.min(left.freeMemoryMiB, right.freeMemoryMiB),
    freeDiskMiB: Math.min(left.freeDiskMiB, right.freeDiskMiB),
  };
}

function inferredCredentialBinding(target: NormalizedPlacementRegistryTarget) {
  if (target.targetClass === "owner_desktop") {
    return {
      credentialId: "stored-owner-authority",
      credentialKind: "personal_subscription" as const,
      executionTargetSlug: target.targetSlug,
      pinnedTargetId: target.targetId,
    };
  }
  return {
    credentialId: "stored-organization-authority",
    credentialKind: "company_api_key" as const,
    executionTargetSlug: null,
    pinnedTargetId: target.targetId,
  };
}

function normalizedRequirements(job: Job, target: NormalizedPlacementRegistryTarget) {
  const normalized = normalizeSubmittedJobPlacementFacts({
    sourceKind: job.sourceKind as never,
    inputHash: job.inputHash,
    policyHash: job.policyHash,
    requirements: job.requirements,
    placementRequest: job.placementRequest,
    rollout: { enabled: true, mode: "active", reason: "stored_placement" },
    credentialBinding: inferredCredentialBinding(target),
    resolvedTarget: target,
  });
  return normalized.success && normalized.active ? normalized : null;
}

function normalizedProviderDemand(target: NormalizedPlacementRegistryTarget) {
  const provider = target.providerConstraintProfile;
  const supported: ReadonlySet<string> = new Set(provider.supportedOperations);
  const operations = ["create", "execute"].filter((operation) => supported.has(operation));
  return {
    maxRuntimeSeconds: Math.min(600, provider.maxContinuousRuntimeSeconds),
    maxIdleSeconds: Math.min(60, provider.maxIdleSeconds),
    resources: {
      cpuMillis: Math.min(1000, provider.resourceCeiling.cpuMillis),
      memoryMiB: Math.min(1024, provider.resourceCeiling.memoryMiB),
      pids: Math.min(128, provider.resourceCeiling.pids),
      diskMiB: Math.min(1024, provider.resourceCeiling.diskMiB),
    },
    concurrentOperations: Math.min(1, provider.maxConcurrentOperations),
    operations,
    localityTags: provider.localityTags.slice(0, 1),
  };
}

function authorityCurrent(input: {
  auth: VerifiedWorkerOperation;
  authority: LeaseWorkerAuthority;
  request: PollRequestV1;
  databaseNow: Date;
  maxHeartbeatAgeMs: number;
  platformPhysicalHeartbeatAt?: Date | null;
}): boolean {
  const { auth, authority, request } = input;
  const worker = authority.worker;
  const target = authority.target;
  const oldestHeartbeat = target.scope === "platform"
    ? input.platformPhysicalHeartbeatAt?.getTime() ?? null
    : !worker.lastSeenAt || !target.lastSeenAt
      ? null
      : Math.min(worker.lastSeenAt.getTime(), target.lastSeenAt.getTime());
  return worker.id === auth.workerId
    && worker.executionTargetId === auth.targetId
    && worker.organizationId === auth.organizationId
    && worker.scope !== "platform"
    && worker.deviceGeneration === auth.targetGeneration
    && worker.deviceThumbprint === auth.deviceThumbprint
    && worker.devicePublicKey === auth.publicKey
    && worker.profileHash === auth.profileHash
    && worker.revokedAt === null
    && (worker.status === "enrolled" || worker.status === "active")
    && authority.ownerMembershipActive
    && target.id === auth.targetId
    && target.status === "active"
    && target.deviceGeneration === auth.targetGeneration
    && request.workerId === auth.workerId
    && request.targetId === auth.targetId
    && request.deviceGeneration === auth.targetGeneration
    && oldestHeartbeat !== null
    && input.databaseNow.getTime() - oldestHeartbeat <= input.maxHeartbeatAgeMs;
}

/**
 * Classify WHY a poll's `authorityCurrent` returned false and build the deny-path
 * intent, deriving the CROSSING from the actual failed conjunct(s) (Codex P2 x4 on
 * PR #448; DE-04 arm added 2026-09-13). `authorityCurrent` is a 19-conjunct
 * composite; DE-18's audit clause is narrowly "placement decisions and generation
 * changes are audited", and an AUTHORITATIVE worker/target `device_generation`
 * cutoff at worker admission is exactly that ⇒ `poll_generation_superseded`,
 * DE-18. Every OTHER authority-currency failure — stale heartbeat,
 * owner-membership loss, worker status/credential drift, target disabled,
 * request/payload identity mismatch — is NOT a generation change; it files under
 * DE-04's worker-authority-currency arm (register amendment 2026-09-13, the
 * follow-on PR #448 documented) ⇒ `poll_authority_stale`, DE-04. Only the
 * AUTHORITATIVE DB-row generations count for DE-18: `request_generation_drift` is
 * the caller's own payload claim (a current worker could forge it), so it never
 * triggers DE-18 — it rides the DE-04 row's `details.failed` instead. The two
 * POST-authority data-integrity refusals (unreadable current target / unparseable
 * stored hello) stay outside this classifier and remain unrecorded — they are not
 * an authority-currency failure and serve no crossing's audit clause.
 *
 * PURE (no IO, no repository selection, no mutation) and mirrors the predicate in
 * `authorityCurrent` exactly — registered in `job-leasing-contract.test.ts`'s
 * reviewed-protected-call allowlist for that reason, alongside `authorityCurrent`.
 * Always computed, only USED on the reject branch; a `null` return drains no row.
 */
export function pollAuthorityCurrencyIntent(
  auth: VerifiedWorkerOperation,
  authority: LeaseWorkerAuthority,
  request: PollRequestV1,
  databaseNow: Date,
  maxHeartbeatAgeMs: number,
  platformPhysicalHeartbeatAt?: Date | null,
): WorkerDenialIntent | null {
  const worker = authority.worker;
  const target = authority.target;
  const oldestHeartbeat = target.scope === "platform"
    ? platformPhysicalHeartbeatAt?.getTime() ?? null
    : !worker.lastSeenAt || !target.lastSeenAt
      ? null
      : Math.min(worker.lastSeenAt.getTime(), target.lastSeenAt.getTime());
  const failed: string[] = [];
  if (worker.id !== auth.workerId) failed.push("worker_id_mismatch");
  if (worker.executionTargetId !== auth.targetId) failed.push("worker_target_mismatch");
  if (worker.organizationId !== auth.organizationId) failed.push("worker_org_mismatch");
  if (worker.scope === "platform") failed.push("worker_scope_platform");
  if (worker.deviceGeneration !== auth.targetGeneration) failed.push("worker_generation_drift");
  if (worker.deviceThumbprint !== auth.deviceThumbprint) failed.push("worker_thumbprint_mismatch");
  if (worker.devicePublicKey !== auth.publicKey) failed.push("worker_pubkey_mismatch");
  if (worker.profileHash !== auth.profileHash) failed.push("worker_profile_mismatch");
  if (worker.revokedAt !== null) failed.push("worker_revoked");
  if (!(worker.status === "enrolled" || worker.status === "active")) failed.push("worker_status_invalid");
  if (!authority.ownerMembershipActive) failed.push("owner_membership_lost");
  if (target.id !== auth.targetId) failed.push("target_id_mismatch");
  if (target.status !== "active") failed.push("target_inactive");
  if (target.deviceGeneration !== auth.targetGeneration) failed.push("target_generation_drift");
  if (request.workerId !== auth.workerId) failed.push("request_worker_mismatch");
  if (request.targetId !== auth.targetId) failed.push("request_target_mismatch");
  if (request.deviceGeneration !== auth.targetGeneration) failed.push("request_generation_drift");
  if (oldestHeartbeat === null || databaseNow.getTime() - oldestHeartbeat > maxHeartbeatAgeMs) {
    failed.push("heartbeat_stale");
  }
  // Nothing failed ⇒ nothing to classify ⇒ no row (the classifier is always
  // computed; only the reject branch drains it).
  if (failed.length === 0) return null;
  // Only the AUTHORITATIVE DB-row generations are DE-18's cutoff —
  // `request_generation_drift` is the caller's own forgeable payload claim and
  // never mints a DE-18 event.
  const GENERATION_CONJUNCTS = new Set([
    "worker_generation_drift", "target_generation_drift",
  ]);
  const generation = failed.some((f) => GENERATION_CONJUNCTS.has(f));
  if (generation) return pollAuthorityDenialIntent("poll_generation_superseded", "DE-18", auth, failed);
  // ★ Every NON-generation authority-currency failure (stale heartbeat, owner
  // membership loss, worker status/credential drift, disabled target,
  // request-identity mismatch) now files under DE-04's worker-authority-currency
  // arm (register amendment 2026-09-13 — the follow-on PR #448 documented).
  return pollAuthorityDenialIntent("poll_authority_stale", "DE-04", auth, failed);
}

export function ackAuthorityCurrent(input: {
  auth: VerifiedWorkerOperation;
  authority: LeaseWorkerAuthority;
  workerId: string;
  databaseNow: Date;
  maxHeartbeatAgeMs: number;
  platformPhysicalHeartbeatAt?: Date | null;
}): boolean {
  const { auth, authority } = input;
  const worker = authority.worker;
  const target = authority.target;
  const oldestHeartbeat = target.scope === "platform"
    ? input.platformPhysicalHeartbeatAt?.getTime() ?? null
    : !worker.lastSeenAt || !target.lastSeenAt
      ? null
      : Math.min(worker.lastSeenAt.getTime(), target.lastSeenAt.getTime());
  return input.workerId === auth.workerId
    && worker.id === auth.workerId
    && worker.executionTargetId === auth.targetId
    && worker.organizationId === auth.organizationId
    && worker.scope !== "platform"
    && worker.deviceGeneration === auth.targetGeneration
    && worker.deviceThumbprint === auth.deviceThumbprint
    && worker.devicePublicKey === auth.publicKey
    && worker.profileHash === auth.profileHash
    && worker.revokedAt === null
    && (worker.status === "enrolled" || worker.status === "active")
    && authority.ownerMembershipActive
    && target.id === auth.targetId
    && target.status === "active"
    && target.deviceGeneration === auth.targetGeneration
    && oldestHeartbeat !== null
    && input.databaseNow.getTime() - oldestHeartbeat <= input.maxHeartbeatAgeMs;
}

/**
 * The audit classifier for `ackAuthorityCurrent`'s reject — the ACK analogue of
 * {@link pollAuthorityCurrencyIntent}. It mirrors `ackAuthorityCurrent`'s predicate EXACTLY,
 * collecting the failed conjunct(s) into `details.failed` and deriving the audit crossing from
 * them rather than from the composite boolean: an AUTHORITATIVE worker/target generation cutoff is
 * DE-18's "generation changes … at worker admission" (`ack_generation_superseded`), and every other
 * authority-currency failure (stale heartbeat, owner-membership loss, worker status/credential
 * drift, disabled target, request-identity mismatch) is DE-04's worker-authority-currency arm
 * (`ack_authority_stale`). PURE (no IO, no repository selection, no mutation); always computed,
 * only USED on the reject branch — a `null` return drains no row. Kept beside `ackAuthorityCurrent`
 * so a future edit to that predicate is visibly next to the classifier that must track it.
 */
export function ackAuthorityCurrencyIntent(input: {
  auth: VerifiedWorkerOperation;
  authority: LeaseWorkerAuthority;
  workerId: string;
  databaseNow: Date;
  maxHeartbeatAgeMs: number;
  platformPhysicalHeartbeatAt?: Date | null;
}): WorkerDenialIntent | null {
  const { auth, authority } = input;
  const worker = authority.worker;
  const target = authority.target;
  const oldestHeartbeat = target.scope === "platform"
    ? input.platformPhysicalHeartbeatAt?.getTime() ?? null
    : !worker.lastSeenAt || !target.lastSeenAt
      ? null
      : Math.min(worker.lastSeenAt.getTime(), target.lastSeenAt.getTime());
  const failed: string[] = [];
  if (input.workerId !== auth.workerId) failed.push("request_worker_mismatch");
  if (worker.id !== auth.workerId) failed.push("worker_id_mismatch");
  if (worker.executionTargetId !== auth.targetId) failed.push("worker_target_mismatch");
  if (worker.organizationId !== auth.organizationId) failed.push("worker_org_mismatch");
  if (worker.scope === "platform") failed.push("worker_scope_platform");
  if (worker.deviceGeneration !== auth.targetGeneration) failed.push("worker_generation_drift");
  if (worker.deviceThumbprint !== auth.deviceThumbprint) failed.push("worker_thumbprint_mismatch");
  if (worker.devicePublicKey !== auth.publicKey) failed.push("worker_pubkey_mismatch");
  if (worker.profileHash !== auth.profileHash) failed.push("worker_profile_mismatch");
  if (worker.revokedAt !== null) failed.push("worker_revoked");
  if (!(worker.status === "enrolled" || worker.status === "active")) failed.push("worker_status_invalid");
  if (!authority.ownerMembershipActive) failed.push("owner_membership_lost");
  if (target.id !== auth.targetId) failed.push("target_id_mismatch");
  if (target.status !== "active") failed.push("target_inactive");
  if (target.deviceGeneration !== auth.targetGeneration) failed.push("target_generation_drift");
  if (oldestHeartbeat === null || input.databaseNow.getTime() - oldestHeartbeat > input.maxHeartbeatAgeMs) {
    failed.push("heartbeat_stale");
  }
  if (failed.length === 0) return null;
  // Only the AUTHORITATIVE DB-row generations are DE-18's cutoff (matching the poll classifier).
  const GENERATION_CONJUNCTS = new Set(["worker_generation_drift", "target_generation_drift"]);
  const generation = failed.some((f) => GENERATION_CONJUNCTS.has(f));
  if (generation) return ackAuthorityDenialIntent("ack_generation_superseded", "DE-18", auth, failed);
  return ackAuthorityDenialIntent("ack_authority_stale", "DE-04", auth, failed);
}

function ackPlacementCurrent(
  attempt: JobAttempt,
  authority: LeaseWorkerAuthority,
  target: NormalizedPlacementRegistryTarget,
): boolean {
  return attempt.status === "offered"
    && attempt.placementDisposition === "selected"
    && attempt.placementMode === "active"
    && attempt.placementLeaseEligible === true
    && attempt.placementOwner === target.targetClass
    && attempt.placementTargetId === target.targetId
    && attempt.placementTargetClass === target.targetClass
    && attempt.placementTargetScope === target.targetScope
    && attempt.placementTargetGeneration === target.targetGeneration
    && attempt.placementProfileHash === target.profileHash
    && attempt.placementProviderConstraintHash === target.providerConstraintHash
    && authority.worker.targetAuthorityKey === authority.target.targetAuthorityKey;
}

function buildJobEnvelope(input: {
  job: Job;
  attempt: JobAttempt;
  target: NormalizedPlacementRegistryTarget;
  requirements: JobCapabilityRequirementsV1;
  resourceLimits: { cpuMillis: number; memoryMiB: number; pids: number; diskMiB: number };
  databaseNow: Date;
  leaseExpiresAt: Date;
  /** DAT-008 — the job's ACTIVE execution-secret handles, already shaped for the
   * frozen wire but NOT yet validated. The `safeParse` below is the authority: a
   * malformed handle yields a null envelope and therefore no lease, which is the
   * fail-closed direction (a lease whose sandbox has no credential is the outcome
   * nothing downstream can recover from). */
  secretHandles: readonly CandidateSecretHandleRef[];
  /**
   * CLI-008 Unit B — this attempt's control-plane-staged input files, rebuilt from the
   * durable `job_artifacts` rows by the caller. Empty for every run that staged nothing,
   * which is every run until Units C and D supply content — and the envelope is then
   * byte-identical to before this field existed (`extensions: []`).
   */
  stagedInput: readonly StagedInputPointer[];
}): JobEnvelopeV1 | null {
  const executionSource = source(input.job);
  if (!executionSource) return null;
  const deadline = new Date(Math.max(
    input.job.createdAt.getTime() + 1,
    input.databaseNow.getTime() + Math.max(1, Number((input.job.input as Record<string, unknown>).maxRuntimeSeconds ?? 600)) * 1_000,
    input.leaseExpiresAt.getTime() + 1,
  ));
  const candidate = {
    protocolVersion: 1,
    jobId: input.job.id,
    attempt: input.attempt.attemptNumber,
    organizationId: input.job.organizationId,
    companyId: input.job.companyId,
    source: executionSource,
    createdAt: input.job.createdAt.toISOString(),
    notBefore: input.job.availableAt.toISOString(),
    deadline: deadline.toISOString(),
    inputHash: input.job.inputHash,
    policyHash: input.requirements.policyHash,
    placement: {
      policyId: typeof (input.job.placementRequest as Record<string, unknown>).policyId === "string"
        ? String((input.job.placementRequest as Record<string, unknown>).policyId)
        : "job-placement",
      version: Number((input.job.placementRequest as Record<string, unknown>).policyVersion ?? 1),
      digest: input.attempt.placementPolicyDigest,
      targetRequirements: input.requirements.targetRequirements,
    },
    adapter: { type: "aoa_job_control", version: "1", configArtifactId: null },
    requiredCapabilities: input.requirements.capabilities,
    workspace: null,
    secretHandles: input.secretHandles,
    resourceLimits: input.resourceLimits,
    networkPolicy: {
      policyId: "job-default-deny",
      version: 1,
      digest: input.attempt.placementPolicyDigest,
    },
    offlinePolicy: "cancel",
    // ★ The staged-input POINTER, never bytes. Task 1 measured the inline `extensions[]`
    // payload ceiling at 48,960 bytes and put the payload in object storage; what still has
    // to cross is which artifact to fetch and what it must hash to, and `extensions` is the
    // container the frozen protocol designates for exactly that additive data. The extension
    // is `critical: false`, so a worker that does not understand the namespace ignores it and
    // stages nothing rather than rejecting the offer. No staged files ⇒ `[]`, byte-identical
    // to every envelope built before this existed.
    extensions: input.stagedInput.length > 0 ? [stagedInputExtension(input.stagedInput)] : [],
    workloadType: input.job.workloadType,
    workload: input.job.input,
  };
  const parsed = jobEnvelopeV1Schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function createJobLeasingService(input: {
  appDb: Db;
  operatorDb?: Db;
  scheduler?: JobReadyScheduler;
  ackTimeoutMs?: number;
  leaseDurationMs?: number;
  maxHeartbeatAgeMs?: number;
  metrics?: JobControlMetrics;
}) {
  input.operatorDb = normalizeOperatorDatabaseErrors(input.operatorDb);
  const ackTimeoutMs = Math.max(1000, input.ackTimeoutMs ?? 15000);
  const leaseDurationMs = Math.max(ackTimeoutMs + 1000, input.leaseDurationMs ?? 300000);
  const maxHeartbeatAgeMs = Math.max(1000, input.maxHeartbeatAgeMs ?? 300000);
  const metrics = input.metrics ?? NOOP_JOB_CONTROL_METRICS;
  // REL-004 clause 3a — the kill-switch policy reader is constructed HERE, from the same
  // `appDb` the authority chain runs on, and is deliberately NOT a service option.
  //
  // The JOB-003 contract guard `service:no-context-or-guard-injection` refuses an injected
  // guard, and it is right to: a reader supplied by the caller is a reader a caller can
  // substitute, and substituting one that always reports "no policy" turns the stop button off
  // for the whole fleet with no trace. Building it internally makes that unrepresentable, and
  // removes the matching hole where a composition root simply forgets to pass one.
  const killSwitches = createKillSwitchPolicyReader({ appDb: input.appDb });

  class HeadRestartConflict extends Error {}
  const isHeadRestartConflict = (error: unknown): error is HeadRestartConflict =>
    error instanceof HeadRestartConflict;
  // ★ DE-18, NOT WIRED HERE AND WHY: this helper's two `target_revoked` throws
  // (platform-scope mismatch, platform physical-authority recheck) are shared by
  // the poll AND ack paths, and the frozen JOB-003 contract pins its exact call
  // expression at both call sites (`job-leasing-contract.test.ts` — the guard-call
  // shape checks and the ack-flow `exactAckReturnDominance`), so neither a sink
  // parameter nor a wrapping capture is admissible without a contract amendment.
  // ★ 2026-09-14 Option-B ruling (docs/replatform/DECISION-REQUEST-job003-ack-drain.md):
  // these two throws are NOT blocked by the ack drain — their blocker is the
  // pinned helper/call shape, and they are attributed to
  // DEFERRED-DECISION: guardPlatformAuthority denial sink (a named, owner-visible
  // future decision, not accepted-as-gap). The
  // organization-scope arms in the poll BODY are wired; these platform arms are
  // named rather than silently skipped.
  const guardPlatformAuthority = async (
    guardRepos: TenantRepositories,
    guardAuth: VerifiedWorkerOperation,
    locked: LeaseWorkerAuthority,
  ) => {
    if (locked.target.scope === "organization" || locked.target.scope === "owner") {
      return { currentTarget: locked.target, physicalAuthorityWorker: null };
    }
    if (locked.target.scope !== "platform") throw new JobLeasingError("target_revoked");
    return input.operatorDb!.transaction(async (operatorTx) => {
      await configurePlatformTargetAuthorityLockTimeout(operatorTx as unknown as Db);
      const physical = await operatorJobLeasingRepository(operatorTx as unknown as Db)
        .lockPlatformPhysicalAuthority(guardAuth.targetId, "share");
      await guardRepos.jobControl.acquirePlatformTargetAuthorityShared(guardAuth.targetId);
      const current = await guardRepos.jobControl.recheckPlatformTargetAuthority({
        targetId: guardAuth.targetId,
        targetAuthorityKey: "platform",
        targetGeneration: guardAuth.targetGeneration,
      });
      const platformNow = await guardRepos.jobControl.currentDatabaseTime();
      if (!physical ||
          !current ||
          physical.target.scope !== "platform" ||
          physical.worker.scope !== "platform" ||
          current.scope !== "platform" ||
          physical.target.status !== "active" ||
          !(physical.worker.status === "enrolled" || physical.worker.status === "active") ||
          current.status !== "active" ||
          physical.worker.revokedAt !== null ||
          physical.target.id !== guardAuth.targetId ||
          current.id !== guardAuth.targetId ||
          physical.worker.executionTargetId !== physical.target.id ||
          physical.worker.targetAuthorityKey !== physical.target.targetAuthorityKey ||
          current.targetAuthorityKey !== physical.target.targetAuthorityKey ||
          locked.worker.executionTargetId !== current.id ||
          locked.worker.targetAuthorityKey !== current.targetAuthorityKey ||
          locked.worker.deviceGeneration !== guardAuth.targetGeneration ||
          physical.target.deviceGeneration !== guardAuth.targetGeneration ||
          physical.worker.deviceGeneration !== guardAuth.targetGeneration ||
          current.deviceGeneration !== guardAuth.targetGeneration ||
          physical.worker.devicePublicKey !== guardAuth.publicKey ||
          physical.worker.deviceThumbprint !== guardAuth.deviceThumbprint ||
          !physical.target.registeredProfileHash ||
          physical.target.registeredProfileHash !== current.registeredProfileHash ||
          !physical.worker.profileHash ||
          locked.worker.profileHash !== guardAuth.profileHash ||
          !physical.target.lastSeenAt ||
          !physical.worker.lastSeenAt ||
          platformNow.getTime() - physical.target.lastSeenAt.getTime() > maxHeartbeatAgeMs ||
          platformNow.getTime() - physical.worker.lastSeenAt.getTime() > maxHeartbeatAgeMs) {
        throw new JobLeasingError("target_revoked");
      }
      return { currentTarget: current, physicalAuthorityWorker: physical.worker };
    });
  };
  const deriveAdmissibleWorkloadTypes = (
    capacity: WorkerCapacity,
    live: { total: number; batch: number; browserSession: number; service: number },
    provider: NormalizedPlacementRegistryTarget["providerConstraintProfile"],
    demand: { resources: { cpuMillis: number; memoryMiB: number; diskMiB: number } },
  ) => {
    if (live.total >= provider.maxConcurrentOperations ||
        capacity.freeCpuMillis > provider.resourceCeiling.cpuMillis ||
        capacity.freeMemoryMiB > provider.resourceCeiling.memoryMiB ||
        capacity.freeDiskMiB > provider.resourceCeiling.diskMiB ||
        capacity.freeCpuMillis < demand.resources.cpuMillis ||
        capacity.freeMemoryMiB < demand.resources.memoryMiB ||
        capacity.freeDiskMiB < demand.resources.diskMiB) return [];
    const workloadTypes: string[] = [];
    if (capacity.batchSlots > live.batch) workloadTypes.push("batch");
    if (capacity.browserSessionSlots > live.browserSession) workloadTypes.push("browser_session");
    if (capacity.serviceSlots > live.service) workloadTypes.push("service");
    return workloadTypes;
  };

  return {
    async poll(pollInput: {
      auth: VerifiedWorkerOperation;
      request: PollRequestV1;
    }): Promise<PollResponseV1> {
      const parsedRequestResult = pollRequestV1Schema.safeParse(pollInput.request);
      if (!parsedRequestResult.success) throw new JobLeasingError("malformed");
      const parsedRequest = parsedRequestResult.data;
      const proofContext = {
        organizationId: pollInput.auth.organizationId,
        deviceThumbprint: pollInput.auth.deviceThumbprint,
        proofId: pollInput.auth.proofId,
        issuedAt: pollInput.auth.proofIssuedAt,
        expiresAt: pollInput.auth.sessionExpiresAt,
      };
      const touchContext = {
        workerId: pollInput.auth.workerId,
        targetId: pollInput.auth.targetId,
        targetGeneration: pollInput.auth.targetGeneration,
      };
      const readySignaled = input.scheduler?.consume(
        pollInput.auth.organizationId,
        pollInput.auth.targetId,
      ) ?? false;
      // REL-004 clause 3a — read the policy ONCE per poll, BEFORE the lease transaction opens,
      // so the frozen JOB-003 authority chain gains no repository selection. Reading it once
      // also means a switch thrown mid-restart cannot flip the verdict between retry attempts.
      const killSwitchDocument = await killSwitches.read();
      // ★ DE-03, replay-rejection conjunct — the replay refusal below THROWS out of
      // `runInTenant`, so its record is collected as an INTENT and drained on the pool
      // handle in the loop's `finally`, once the transaction has unwound.
      const proofDenial = createWorkerDenialSink();
      // Built HERE, OUTSIDE the frozen JOB-003 authority chain, and only ASSIGNED
      // inside it. The intent is a pure function of the already-verified session
      // artefact, so hoisting it changes nothing semantically — but constructing it
      // inside the tenant body would pass a protected authority symbol to a
      // non-approved call, which `job-leasing-contract.test.ts` refuses as
      // `binding:protected-value-escape`. That guard is right: it exists so no new
      // consumer of the authority chain appears inside the transaction without
      // review. An earlier revision of this change tripped it and CI caught it.
      const replayDenialIntent = workerProofReplayIntent(pollInput.auth);
      // ★ Poll admission-arm: every authorityCurrent refusal is audited, with the
      // crossing derived per-conjunct by `pollAuthorityCurrencyIntent` below —
      // authoritative generation cutoff ⇒ DE-18; any other authority-currency
      // failure ⇒ DE-04's worker-authority-currency arm (register amendment
      // 2026-09-13). The two POST-AUTHORITY data-integrity refusals (unreadable
      // current target / unparseable stored hello) are still NOT recorded: not an
      // authority-currency failure, no crossing's audit clause to serve (Codex
      // P2 x4 on PR #448). They throw the coarse `target_revoked` with no row.
      for (let restartAttempt = 0; restartAttempt < 3; restartAttempt += 1) {
        // A retry iteration (restartAttempt > 0) means the previous head claim rolled back; count it
        // here so the head-conflict catch below stays the exact classifier/exhaustion/continue triple.
        if (restartAttempt > 0) metrics.headRestart();
        try {
          return await runInTenant(input.appDb, pollInput.auth.organizationId, async (repos) => {
            const cleanupNow = await repos.jobControl.currentDatabaseTime();
            await repos.workerEnrollment.cleanupExpiredProofs(cleanupNow, 100);
            const databaseNow = await repos.jobControl.currentDatabaseTime();
            const proofRecorded = await repos.workerEnrollment.recordProof(proofContext);
            const lockedAuthority = await repos.jobControl.lockWorkerLeaseAuthority({
              workerId: pollInput.auth.workerId,
              targetId: pollInput.auth.targetId,
            });
            if (!lockedAuthority || !proofRecorded) {
              // ★ DE-03 covers the REPLAY disjunct only. A missing authority with a
              // FRESH proof is a different refusal at the same line and is NOT one of
              // the crossing’s nine `recordProof` sites, so it is left unrecorded
              // rather than filed under a reason it did not fire.
              if (!proofRecorded) proofDenial.intent = replayDenialIntent;
              throw new JobLeasingError("unauthorized");
            }
            const guardedAuthority = await guardPlatformAuthority(repos, pollInput.auth, lockedAuthority);
            const platformPhysicalHeartbeatAt = guardedAuthority.physicalAuthorityWorker &&
                guardedAuthority.currentTarget.lastSeenAt &&
                guardedAuthority.physicalAuthorityWorker.lastSeenAt
              ? new Date(Math.min(
                  guardedAuthority.currentTarget.lastSeenAt.getTime(),
                  guardedAuthority.physicalAuthorityWorker.lastSeenAt.getTime(),
                ))
              : null;
            // ★ Classify the authority-currency failure BEFORE the frozen
            // `const currentAuthority = authorityCurrent(...)` binding, so the
            // reject `if` remains the single-throw statement the JOB-003 contract
            // (`builder:trusted-common-authority-current`) pins as the NEXT
            // statement after that binding — a statement between them reds it.
            // `pollAuthorityCurrencyIntent` is a PURE classifier (registered in the
            // contract's reviewed-call allowlist beside `authorityCurrent`); it
            // derives the reason + crossing from the ACTUAL failed conjunct so a
            // stale-heartbeat / membership / credential failure is NOT filed under
            // DE-18's generation-replacement crossing (Codex P2 on PR #448). Its
            // result is bound to a non-protected local, so assigning it in the
            // throw's comma expression carries no protected symbol on the RHS
            // (`binding:protected-value-escape`). It runs on every poll (cheap,
            // pure) and is only USED on the failure branch.
            // ★ Pass `platformPhysicalHeartbeatAt` too (Codex P2 on PR #448): for a
            // shared-platform target the classifier must age liveness against the
            // SAME physical heartbeat `authorityCurrent` uses, or it would compute a
            // null heartbeat and spuriously add `heartbeat_stale` to a platform
            // target rejected for another reason.
            const pollAuthorityFailureIntent = pollAuthorityCurrencyIntent(
              pollInput.auth, lockedAuthority, parsedRequest, databaseNow, maxHeartbeatAgeMs,
              platformPhysicalHeartbeatAt,
            );
            const currentAuthority = authorityCurrent({
              auth: pollInput.auth,
              authority: lockedAuthority,
              request: parsedRequest,
              databaseNow,
              maxHeartbeatAgeMs,
              platformPhysicalHeartbeatAt,
            });
            if (!currentAuthority) {
              throw (proofDenial.intent = pollAuthorityFailureIntent, new JobLeasingError("target_revoked"));
            }
            // Touch liveness only AFTER the target lock + authority revalidation (F033). A poll that
            // loses the target row to an overlapping revoke throws above and never reaches here, so
            // the worker's last_seen_at stays untouched; only a poll that keeps authority advances
            // it. The row/generation was just revalidated, so the update cannot fail-close here.
            await repos.jobControl.touchWorkerLeaseProfile(touchContext);
            const normalizedCurrentTarget = await normalizePlacementRegistryTarget(
              guardedAuthority.currentTarget,
            );
            // Not recorded: a post-authority data-integrity refusal serves no
            // crossing's audit clause (see the poll-arm note above).
            if (!normalizedCurrentTarget) throw new JobLeasingError("target_revoked");
            const parsedStoredHello = workerHelloV1Schema.safeParse(
              lockedAuthority.worker.profileSnapshot,
            );
            if (!parsedStoredHello.success) throw new JobLeasingError("target_revoked");
            const effectiveCapacity = minCapacity(
              parsedStoredHello.data.capacity,
              parsedRequest.capacity,
            );
            const providerDemand = normalizedProviderDemand(normalizedCurrentTarget);
            const liveCapacity = await repos.jobControl.snapshotLiveLeaseCapacity({
              workerId: pollInput.auth.workerId,
              targetId: normalizedCurrentTarget.targetId,
            });
            const admissibleWorkloadTypes = deriveAdmissibleWorkloadTypes(
              effectiveCapacity,
              liveCapacity,
              normalizedCurrentTarget.providerConstraintProfile,
              providerDemand,
            );
            const staticContextInput = buildLeaseStaticContextInput({
              organizationId: lockedAuthority.worker.organizationId!,
              parsedWorkerHello: parsedStoredHello.data,
              logicalWorker: lockedAuthority.worker as never,
              currentTarget: normalizedCurrentTarget as never,
              physicalAuthorityWorker: guardedAuthority.physicalAuthorityWorker as never,
            });
            const staticContextHash = leaseStaticContextHash(staticContextInput);
            type LeaseCandidate = Awaited<ReturnType<
              TenantRepositories["jobControl"]["lockEligibleLeaseCandidates"]
            >>["candidates"][number];
            const tryOffer = async (
              candidate: LeaseCandidate,
              normalized: { requirements: JobCapabilityRequirementsV1 },
            ): Promise<PollResponseV1 | null> => {
          const ackDeadline = new Date(databaseNow.getTime() + ackTimeoutMs);
          const expiresAt = new Date(databaseNow.getTime() + leaseDurationMs);
          // DAT-008 — read the job's ACTIVE handles inside the SAME tenant tx that
          // is about to offer the lease, so a handle revoked concurrently cannot be
          // advertised by an envelope built from a stale read.
          const storedHandles = await repos.jobControl.listActiveExecutionSecretHandles({
            organizationId: candidate.job.organizationId,
            jobId: candidate.job.id,
          });
          // CLI-008 Unit B — the staged-input pointers come from the DURABLE rows, in this
          // transaction, not from anything the staging call returned: the stage happened in a
          // different transaction, minutes earlier, possibly in a different process. A
          // pointer only the staging process could produce would be no pointer at all.
          const stagedInputRows = await repos.jobArtifacts.listForJob(candidate.job.id);
          const jobEnvelope = buildJobEnvelope({
            job: candidate.job,
            attempt: candidate.attempt,
            target: normalizedCurrentTarget,
            requirements: normalized.requirements,
            resourceLimits: providerDemand.resources,
            databaseNow,
            leaseExpiresAt: expiresAt,
            secretHandles: toSecretHandleRefs(storedHandles),
            stagedInput: stagedInputPointersFromRows(stagedInputRows, candidate.attempt.attemptNumber),
          });
          if (!jobEnvelope) throw new JobLeasingError("internal_unavailable");
          const fence = randomBytes(32).toString("base64url");
          const lease = await repos.jobControl.offerLease({
            attemptId: candidate.attempt.id,
            organizationId: candidate.job.organizationId,
            companyId: candidate.job.companyId,
            jobId: candidate.job.id,
            attemptNumber: candidate.attempt.attemptNumber,
            workerId: pollInput.auth.workerId,
            targetId: normalizedCurrentTarget.targetId,
            targetAuthorityKey: lockedAuthority.worker.targetAuthorityKey,
            targetGeneration: normalizedCurrentTarget.targetGeneration,
            profileHash: pollInput.auth.profileHash,
            providerConstraintHash: normalizedCurrentTarget.providerConstraintHash,
            fence,
            ackDeadline,
            expiresAt,
            createdAt: databaseNow,
          });
          if (!lease) return null;
          const offer = leaseOfferV1Schema.parse({
            protocolVersion: 1,
            workerId: pollInput.auth.workerId,
            leaseId: lease.id,
            fenceToken: fence,
            ackDeadline: ackDeadline.toISOString(),
            expiresAt: expiresAt.toISOString(),
            job: jobEnvelope,
            extensions: [],
          });
          return pollResponseV1Schema.parse({
            protocolVersion: 1,
            correlationId: parsedRequest.correlationId,
            serverTime: databaseNow.toISOString(),
            outcome: "offer",
            body: offer,
          });
        };

            const { candidates, certificateMetrics } =
              await repos.jobControl.lockEligibleLeaseCandidates({
                admissibleWorkloadTypes,
                eligibilityVersion: LEASE_STATIC_ELIGIBILITY_VERSION,
                limit: 256,
                staticContextHash,
                targetAuthorityKey: guardedAuthority.currentTarget.targetAuthorityKey,
                targetClass: normalizedCurrentTarget.targetClass,
                targetGeneration: normalizedCurrentTarget.targetGeneration,
                targetId: normalizedCurrentTarget.targetId,
                placementOwner: normalizedCurrentTarget.targetClass,
                targetProfileHash: normalizedCurrentTarget.profileHash,
                targetProviderConstraintHash: normalizedCurrentTarget.providerConstraintHash,
                targetScope: normalizedCurrentTarget.targetScope,
                workerId: pollInput.auth.workerId,
              });
            // Certificate scan facts come only from the claim SQL, never from candidates.length.
            metrics.certificateScan(certificateMetrics);
            // REL-004 clause 3a — a killed provider answers `drain`, so NEW leases stop while
            // in-flight work finishes (`ack` and `renew` deliberately carry no kill check).
            //
            // Evaluated HERE, and the position is load-bearing in three ways:
            //
            //   AFTER the canonical authority chain (locked authority -> revalidated target ->
            //   liveness touch -> static context -> candidate selection). The JOB-003 contract
            //   guard `candidate:canonical-chain-dominates-return` forbids ANY return from this
            //   transaction before that chain has run, so every poll outcome is provably derived
            //   from the validated context. An earlier return would have been cheaper for a
            //   killed provider by exactly one already-indexed query, and would have cost that
            //   invariant. The invariant wins.
            //
            //   AFTER the liveness touch, because a paused worker is ALIVE. Skipping the touch
            //   would make a drained fleet look dead to every heartbeat-age guard, and the
            //   workers would then fail authority revalidation once the switch was lifted.
            //
            //   BEFORE the eligibility loop: that loop writes `static_requirements_mismatch`
            //   negative certificates, and a kill switch is not a requirements mismatch. Routing
            //   it there would corrupt the eligibility certificates JOB-* depends on.
            //
            // This call adds NO repository selection to the frozen chain — the policy document
            // was read once, before the transaction opened.
            const killVerdict = evaluateKillSwitches({
              document: killSwitchDocument,
              provider: guardedAuthority.currentTarget.kind,
              // Structurally UNKNOWN, on every call, forever. No control-plane surface carries
              // the sandbox template: the E2B alias is pinned worker-side in
              // packages/sandbox-e2b-provider, and the frozen hello / provider-constraint /
              // registered-target schemas have no field for it. `null` would be a lie that
              // silently no-ops every template switch; `undefined` makes the gap loud.
              template: undefined,
              knownProviders: EXECUTION_TARGET_KINDS,
            });
            if (killVerdict.killed) {
              return pollResponseV1Schema.parse({
                protocolVersion: 1,
                correlationId: parsedRequest.correlationId,
                serverTime: databaseNow.toISOString(),
                outcome: "drain",
                retryAfterMs: KILL_SWITCH_DRAIN_RETRY_AFTER_MS,
                reason: killVerdict.reason,
              });
            }
            const staticNegativeCertificates: Array<{
              candidate: LeaseCandidate;
              reasonCode: "static_requirements_mismatch";
              staticContextHash: string;
            }> = [];
            for (const candidate of candidates) {
              const normalized = normalizedRequirements(candidate.job, normalizedCurrentTarget);
              if (!normalized) throw new JobLeasingError("internal_unavailable");
              const evaluation = evaluateStaticLeaseEligibility({
                target: normalizedCurrentTarget.registeredProfile,
                verifiedProviderConstraints: normalizedCurrentTarget.providerConstraintProfile,
                worker: parsedStoredHello.data,
                requirements: normalized.requirements,
              });
              if (!evaluation.eligible) {
                if (evaluation.reasonCode !== "static_requirements_mismatch") {
                  throw new JobLeasingError("internal_unavailable");
                }
                staticNegativeCertificates.push({
                  candidate,
                  reasonCode: evaluation.reasonCode,
                  staticContextHash,
                });
                continue;
              }
              if (staticNegativeCertificates.length > 0) {
                const upserted = await repos.jobControl
                  .upsertLeaseRejectionCertificates(staticNegativeCertificates);
                metrics.certificateUpsert({ count: upserted });
              }
              // JOB-007 note: live org-capacity enforcement at the offer is DEFERRED. The
              // shared capacity authority (org-concurrency.ts admitAttemptCapacity/release,
              // proven directly in job-quotas.integration) cannot run inside this frozen
              // poll authority chain — the JOB-003 contract requires exactly one repository
              // selection with no injected guard, and a capacity count is a second select.
              // Wiring it live needs a separate seam / a poll-contract revision. See
              // docs/replatform/epics/E3-job-control/tickets/JOB-007-result.md.
              const offered = await tryOffer(candidate, normalized);
              if (!offered) throw new HeadRestartConflict();
              return offered;
            }
            if (staticNegativeCertificates.length > 0) {
              const upserted = await repos.jobControl
                .upsertLeaseRejectionCertificates(staticNegativeCertificates);
              metrics.certificateUpsert({ count: upserted });
            }
            return pollResponseV1Schema.parse({
              protocolVersion: 1,
              correlationId: parsedRequest.correlationId,
              serverTime: databaseNow.toISOString(),
              outcome: "no_work",
              retryAfterMs: readySignaled ? 100 : 750,
            });
          });
        } catch (error) {
          if (!isHeadRestartConflict(error)) throw error;
          if (restartAttempt >= 2) throw new JobLeasingError("internal_unavailable");
          continue;
        } finally {
          // ★ DE-03 — the drain point, and WHY IT IS HERE AND NOT IN THE CATCH.
          // The catch above is a FROZEN shape: `job-leasing-contract.test.ts`
          // ("maps one attempt-local typed static context ... with no laundering or
          // injection") requires it to be EXACTLY the classifier / exhaustion /
          // continue triple, with the classifier's `then` a bare re-throw of the
          // caught error. Putting the drain inside it turned that assertion red —
          // an earlier revision of this change did exactly that and CI caught it.
          // A `finally` leaves the triple untouched, still runs on the POOL handle
          // after the tenant transaction has unwound, and still runs BEFORE the
          // caller sees the error. It also runs on the success and head-restart
          // paths, where the sink is empty and the drain is a no-op.
          await drainWorkerDenial(input.appDb, proofDenial, {
            control: "server/src/services/job-leasing.ts:poll",
            workerId: pollInput.auth.workerId,
            operation: "lease_poll",
          });
        }
      }
      throw new JobLeasingError("internal_unavailable");
    },

    async ack(ackInput: {
      auth: VerifiedWorkerOperation;
      request: LeaseAckOperationRequestV1;
    }): Promise<LeaseAckOperationResponseV1> {
      const parsedRequest = leaseAckOperationRequestV1Schema.safeParse(ackInput.request);
      if (!parsedRequest.success) throw new JobLeasingError("malformed");
      const request = parsedRequest.data;
      const digest = semanticAckDigest(ackInput.auth, request);
      // ★ DE-03 — THIS SITE IS NOT WIRED, AND THE REASON IS A FROZEN CONTRACT, NOT
      // AN OVERSIGHT. The `recordProof` refusal INSIDE THIS `ack` METHOD — cited by
      // SYMBOL AND WITH NO LINE NUMBER AT ALL, because this comment carried
      // `job-leasing.ts:816` until 2026-09-10, by which time the call had drifted
      // well past it, and the commit that corrected it moved the call again by the
      // length of this very paragraph. A number here cannot survive its own edit —
      // is one of the crossing's seven organization-attested sites, and it is the
      // ONE this unit could not record. The refusal THROWS out of `runInTenant`, so the row must
      // be drained on the pool handle after the transaction unwinds — and every
      // drain point is closed here:
      //   * inside the callback → a nested pool borrow while the tenant transaction
      //     still holds a connection (the documented self-deadlock), and rolled back
      //     with the transaction anyway;
      //   * `.finally(…)` on the call → `job-leasing-contract.test.ts`'s
      //     `exactAckReturnDominance` requires a return whose parent IS this method
      //     body and whose expression unwraps to the `runInTenant` call itself.
      //     `unwrap` strips `await`, parens, `as` and `!` — never a `.finally`;
      //   * a `try`/`finally` around the return → that same check fails, because the
      //     return's parent becomes the try block.
      // The poll path above takes the one shape the contract does allow (a `finally`
      // on the retry `try`, which leaves the classifier/exhaustion/continue triple
      // untouched); the ack path has no retry `try` to hang one on. Wiring it needs
      // an AMENDMENT to the frozen JOB-003 ack-flow contract, which is a decision
      // this unit does not take. The arm in
      // `de-03-worker-replay-denial-audit.integration.test.ts` PINS that this site
      // records nothing, asserting the throw FIRST so the pin cannot pass by vacuity.
      // ★ 2026-09-10 — ALL OF THE ABOVE WAS RE-MEASURED, NOT INHERITED, and the
      // amendment is now a filed decision request rather than an open question:
      // `docs/replatform/DECISION-REQUEST-job-003-ack-drain-amendment.md`. Adding a
      // `.finally(…)` here does red the contract (`builder:trusted-service-authority-guard`,
      // 1 of 20). But the OBVIOUS amendment — teaching `exactAckReturnDominance` to
      // accept the drain shape — is MEASURABLY UNSAFE: `collectAckEffects` walks the
      // `runInTenant` CALLBACK's body, so a protected ack effect placed inside the
      // `.finally` callback leaves the contract fully GREEN. A safe amendment must
      // also sweep the drain callback. Do not take the one-line version.
      // ★ 2026-09-14 — RULED, Option B (docs/replatform/DECISION-REQUEST-job003-ack-drain.md):
      // the hardened amendment is ADOPTED and this drain point is UNBLOCKED; the
      // build (contract widening + wiring) has not shipped yet, so this site still
      // records nothing until that unit lands.
      return runInTenant(input.appDb, ackInput.auth.organizationId, async (repos) => {
        const databaseNow = await repos.jobControl.currentDatabaseTime();
        await repos.workerEnrollment.cleanupExpiredProofs(databaseNow, 100);
        await repos.jobControl.cleanupExpiredOperationReceipts(databaseNow, 100);
        const proofRecorded = await repos.workerEnrollment.recordProof({
          organizationId: ackInput.auth.organizationId,
          deviceThumbprint: ackInput.auth.deviceThumbprint,
          proofId: ackInput.auth.proofId,
          issuedAt: ackInput.auth.proofIssuedAt,
          expiresAt: ackInput.auth.sessionExpiresAt,
        });
        // ★ DE-03 — unrecorded; see the note above this `runInTenant` call.
        if (!proofRecorded) throw new JobLeasingError("unauthorized");

        const authority = await repos.jobControl.lockWorkerLeaseAuthority({
          workerId: ackInput.auth.workerId,
          targetId: ackInput.auth.targetId,
        });
        const guardedAuthority = authority
          ? await guardPlatformAuthority(repos, ackInput.auth, authority)
          : null;
        const platformPhysicalHeartbeatAt = guardedAuthority?.physicalAuthorityWorker &&
            guardedAuthority.currentTarget.lastSeenAt &&
            guardedAuthority.physicalAuthorityWorker.lastSeenAt
          ? new Date(Math.min(
              guardedAuthority.currentTarget.lastSeenAt.getTime(),
              guardedAuthority.physicalAuthorityWorker.lastSeenAt.getTime(),
            ))
          : null;
        const authorityNow = await repos.jobControl.currentDatabaseTime();
        if (!authority || !ackAuthorityCurrent({
          auth: ackInput.auth,
          authority,
          workerId: request.body.workerId,
          databaseNow: authorityNow,
          maxHeartbeatAgeMs,
          platformPhysicalHeartbeatAt,
        })) throw new JobLeasingError(authority ? "target_revoked" : "unauthorized");

        const target = guardedAuthority
          ? await normalizePlacementRegistryTarget(guardedAuthority.currentTarget)
          : null;
        if (!target || target.status !== "active") throw new JobLeasingError("target_revoked");
        if (!await repos.jobControl.touchWorkerLeaseProfile({
          workerId: ackInput.auth.workerId,
          targetId: ackInput.auth.targetId,
          targetGeneration: ackInput.auth.targetGeneration,
        })) throw new JobLeasingError("target_revoked");
        const prior = await repos.jobControl.findOperationReceipt({
          organizationId: ackInput.auth.organizationId,
          workerId: ackInput.auth.workerId,
          targetId: ackInput.auth.targetId,
          targetGeneration: ackInput.auth.targetGeneration,
          profileHash: ackInput.auth.profileHash,
          operation: "lease_ack",
          idempotencyKey: request.idempotencyKey,
        });
        if (prior) {
          if (prior.semanticDigest !== digest) throw new JobLeasingError("malformed");
          return leaseAckOperationResponseV1Schema.parse({
            protocolVersion: 1,
            correlationId: request.correlationId,
            serverTime: authorityNow.toISOString(),
            outcome: "acknowledged",
            ...prior.outcome,
          });
        }

        const context = await repos.jobControl.lockLeaseAckContext({
          organizationId: ackInput.auth.organizationId,
          workerId: ackInput.auth.workerId,
          targetId: ackInput.auth.targetId,
          targetGeneration: ackInput.auth.targetGeneration,
          profileHash: ackInput.auth.profileHash,
          leaseId: request.body.leaseId,
          jobId: request.body.jobId,
          attemptNumber: request.body.attempt,
          fence: request.body.fenceToken,
        });
        if (!context) throw new JobLeasingError("stale_fence");
        if (context.lease.status !== "offered" || context.attempt.status !== "offered") {
          throw new JobLeasingError("attempt_terminal");
        }
        if (!ackPlacementCurrent(context.attempt, authority, target)
          || context.lease.organizationId !== ackInput.auth.organizationId
          || context.lease.workerId !== ackInput.auth.workerId
          || context.lease.targetId !== target.targetId
          || context.lease.targetAuthorityKey !== authority.worker.targetAuthorityKey
          || context.lease.targetGeneration !== target.targetGeneration
          || context.lease.profileHash !== ackInput.auth.profileHash
          || context.lease.providerConstraintHash !== target.providerConstraintHash
          || !context.lease.companyId
          || !context.lease.jobId
          || !context.lease.attemptNumber
          || !context.lease.expiresAt) {
          throw new JobLeasingError("stale_fence");
        }

        const outcome = {
          leaseId: context.lease.id,
          expiresAt: context.lease.expiresAt.toISOString(),
        };
        const activated = await repos.jobControl.activateLeaseAck({
          organizationId: ackInput.auth.organizationId,
          companyId: context.lease.companyId,
          jobId: context.lease.jobId,
          attemptId: context.lease.attemptId,
          attemptNumber: context.lease.attemptNumber,
          leaseId: context.lease.id,
          workerId: ackInput.auth.workerId,
          targetId: target.targetId,
          targetAuthorityKey: authority.worker.targetAuthorityKey,
          targetGeneration: target.targetGeneration,
          profileHash: ackInput.auth.profileHash,
          providerConstraintHash: target.providerConstraintHash,
          placementProfileHash: target.profileHash,
          fence: request.body.fenceToken,
          idempotencyKey: request.idempotencyKey,
          semanticDigest: digest,
          receiptExpiresAt: context.lease.expiresAt,
          outcome,
        });
        if (!activated) throw new JobLeasingError("stale_fence");
        return leaseAckOperationResponseV1Schema.parse({
          protocolVersion: 1,
          correlationId: request.correlationId,
          serverTime: authorityNow.toISOString(),
          outcome: "acknowledged",
          ...outcome,
        });
      });
    },
  };
}
