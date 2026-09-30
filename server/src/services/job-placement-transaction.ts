import {
  EXECUTION_SOURCE_KINDS,
  workerHelloV1Schema,
  type ExecutionSourceKind,
} from "@armyofagents/worker-protocol";
import {
  listPlatformPlacementCandidateSnapshots,
  type JobAttempt,
  type PlacementCandidateSnapshot,
} from "@armyofagents/db";
import { runInTenant } from "../db/tenant-context.js";
import {
  decideJobPlacement,
  canonicalPlacementAuthorityDigest,
  normalizeSubmittedJobPlacementFacts,
  type JobPlacementDecision,
  type JobPlacementAuthorityResolver,
  type PlaceJobAttemptInput,
  type PlacementCandidate,
} from "./job-placement.js";
import {
  chooseExecutionTargetRow,
  normalizePlacementRegistryTarget,
  sortExecutionTargetRowsForPlacement,
  type ExecutionTargetRow,
} from "./execution-target-resolver.js";
import {
  mintExecutionSecretHandleForPlacement,
  mintRunJwtHandleForPlacement,
} from "./execution-secret-handle-mint-runner.js";
import {
  isActionableMintRefusal,
  type ExecutionSecretMintRefusal,
} from "./execution-secret-handle-mint.js";
import { mintCredentialKindFor } from "./canary-mint-authority.js";
import { logger } from "../middleware/logger.js";

const SOURCE_KINDS = new Set<string>(EXECUTION_SOURCE_KINDS);

export class JobPlacementError extends Error {
  constructor(public readonly code: "placement_not_found" | "placement_already_decided") {
    super(code);
    this.name = "JobPlacementError";
  }
}

function oldestSeen(target: Date | null, worker: Date | null): Date | null {
  if (!target || !worker) return null;
  return target.getTime() <= worker.getTime() ? target : worker;
}

async function candidateFromSnapshot(
  snapshot: PlacementCandidateSnapshot,
  organizationId: string,
): Promise<PlacementCandidate | null> {
  const registry = await normalizePlacementRegistryTarget(snapshot.target);
  const hello = workerHelloV1Schema.safeParse(snapshot.worker.profileSnapshot);
  if (!registry || !hello.success || !snapshot.worker.profileHash) return null;
  if (snapshot.worker.id !== String(hello.data.workerId) ||
      snapshot.worker.executionTargetId !== registry.targetId ||
      snapshot.worker.targetAuthorityKey !== snapshot.target.targetAuthorityKey ||
      snapshot.worker.deviceGeneration !== registry.targetGeneration) return null;

  if (registry.targetScope === "platform") {
    if (snapshot.target.organizationId !== null || snapshot.worker.organizationId !== null ||
        snapshot.worker.scope !== "platform") return null;
  } else {
    if (snapshot.target.organizationId !== organizationId ||
        snapshot.worker.organizationId !== organizationId ||
        snapshot.worker.scope !== registry.targetScope) return null;
  }

  const currentOperations = snapshot.target.capabilities.currentOperations;
  if (currentOperations !== undefined &&
      (!Number.isInteger(currentOperations) || Number(currentOperations) < 0)) return null;
  return {
    registry: {
      ...registry,
      lastSeenAt: oldestSeen(registry.lastSeenAt, snapshot.worker.lastSeenAt),
    },
    worker: hello.data,
    workerProfileHash: snapshot.worker.profileHash,
    workerStatus: snapshot.worker.status,
    ownerMembershipActive: snapshot.ownerMembershipActive,
    currentOperations: Number(currentOperations ?? 0),
  };
}

function decisionFromAttempt(attempt: JobAttempt): JobPlacementDecision | null {
  if (!attempt.placementDecidedAt || !attempt.placementDisposition || !attempt.placementMode ||
      attempt.placementLeaseEligible === null || !attempt.placementInputDigest ||
      !attempt.placementPolicyDigest || !attempt.placementFallbackDisposition ||
      !attempt.placementReasonCode) return null;
  return {
    disposition: attempt.placementDisposition as JobPlacementDecision["disposition"],
    owner: attempt.placementOwner as JobPlacementDecision["owner"],
    targetId: attempt.placementTargetId,
    targetClass: attempt.placementTargetClass as JobPlacementDecision["targetClass"],
    targetScope: attempt.placementTargetScope as JobPlacementDecision["targetScope"],
    targetGeneration: attempt.placementTargetGeneration,
    profileHash: attempt.placementProfileHash,
    providerConstraintHash: attempt.placementProviderConstraintHash,
    fallbackDisposition: attempt.placementFallbackDisposition as JobPlacementDecision["fallbackDisposition"],
    reasonCode: attempt.placementReasonCode,
    mode: attempt.placementMode as JobPlacementDecision["mode"],
    leaseEligible: attempt.placementLeaseEligible,
    inputDigest: attempt.placementInputDigest,
    policyDigest: attempt.placementPolicyDigest,
  };
}

/** Called only through the lazy public wrapper in job-placement.ts. */
export async function placeJobAttemptTransaction(
  input: PlaceJobAttemptInput,
  resolveAuthority: JobPlacementAuthorityResolver,
): Promise<JobPlacementDecision> {
  return runInTenant(input.appDb, input.organizationId, async (repos) => {
    const context = await repos.jobControl.lockPlacementContext({
      organizationId: input.organizationId,
      companyId: input.companyId,
      jobId: input.jobId,
      attemptId: input.attemptId,
    });
    if (!context) throw new JobPlacementError("placement_not_found");

    const sourceKind = SOURCE_KINDS.has(context.job.sourceKind)
      ? context.job.sourceKind as ExecutionSourceKind
      : "task_run";
    const authority = await resolveAuthority({
      organizationId: input.organizationId,
      companyId: input.companyId,
      jobId: input.jobId,
      sourceKind,
      workloadType: context.job.workloadType,
    });
    const tenantSnapshots = authority.rollout.enabled
      ? await repos.jobControl.listPlacementCandidateSnapshots()
      : [];

    const decideAndPersist = async (platformSnapshots: PlacementCandidateSnapshot[]) => {
      const snapshots = [...tenantSnapshots, ...platformSnapshots];
      const candidates = (await Promise.all(
        snapshots
          .map((snapshot) => candidateFromSnapshot(snapshot, input.organizationId)),
      )).filter((candidate): candidate is PlacementCandidate => candidate !== null);

      let routedRow: ExecutionTargetRow | null = null;
      let routingError: string | null = null;
      let routingTemporarilyUnavailable = false;
      const resolverTargets = sortExecutionTargetRowsForPlacement(
        snapshots.map((snapshot) => snapshot.target as ExecutionTargetRow),
      );
      const placementRequest = context.job.placementRequest as Record<string, unknown> | null;
      const requestedTarget = placementRequest && typeof placementRequest.requestedTarget === "string"
        ? placementRequest.requestedTarget
        : null;
      if (authority.rollout.enabled) {
        try {
          routedRow = chooseExecutionTargetRow({
            credentialKind: authority.credentialBinding.credentialKind,
            pinnedTargetId: requestedTarget ?? authority.credentialBinding.pinnedTargetId,
            executionTargetSlug: authority.credentialBinding.executionTargetSlug,
            targets: resolverTargets,
          });
        } catch {
          // Resolver error text can contain target identifiers. Persist only the
          // closed reason; request callers never receive registry diagnostics.
          routingError = "execution_target_resolution_failed";
          const explicitTargetId = requestedTarget ?? authority.credentialBinding.pinnedTargetId;
          const scopedTargets = resolverTargets;
          const unavailableTarget = explicitTargetId
            ? scopedTargets.find((target) => target.id === explicitTargetId) ?? null
            : authority.credentialBinding.credentialKind === "personal_subscription" &&
                authority.credentialBinding.executionTargetSlug
              ? scopedTargets.find((target) => target.slug === authority.credentialBinding.executionTargetSlug &&
                  (target.kind === "dedicated_worker" || target.kind === "local_host")) ?? null
              : null;
          const credentialCompatible = unavailableTarget !== null &&
            (authority.credentialBinding.credentialKind !== "personal_subscription" ||
              (Boolean(authority.credentialBinding.executionTargetSlug) &&
               unavailableTarget.slug === authority.credentialBinding.executionTargetSlug &&
               (unavailableTarget.kind === "dedicated_worker" || unavailableTarget.kind === "local_host")));
          routingTemporarilyUnavailable = credentialCompatible && unavailableTarget.status !== "active";
          routedRow = routingTemporarilyUnavailable ? unavailableTarget : null;
        }
      }
      const resolvedTarget = routedRow ? await normalizePlacementRegistryTarget(routedRow) : null;
      const normalized = normalizeSubmittedJobPlacementFacts({
            sourceKind,
            inputHash: context.job.inputHash,
            policyHash: context.job.policyHash,
            requirements: context.job.requirements,
            placementRequest: context.job.placementRequest,
            rollout: authority.rollout,
            credentialBinding: authority.credentialBinding,
            resolvedTarget,
          });
      const authorityFacts: Record<string, unknown> = normalized?.success
        ? normalized.authorityFacts
        : {
            sourceKind,
            inputHash: context.job.inputHash,
            policyHash: context.job.policyHash,
            submittedRequirements: context.job.requirements,
            submittedPlacementRequest: context.job.placementRequest,
            rollout: authority.rollout,
            credentialBinding: authority.credentialBinding,
            resolvedTarget: resolvedTarget ? {
              targetId: resolvedTarget.targetId,
              targetSlug: resolvedTarget.targetSlug,
              targetClass: resolvedTarget.targetClass,
              targetScope: resolvedTarget.targetScope,
              targetGeneration: resolvedTarget.targetGeneration,
              profileHash: resolvedTarget.profileHash,
              providerConstraintHash: resolvedTarget.providerConstraintHash,
            } : null,
            normalizationReason: normalized?.reason ?? null,
            routingError,
          };
      const authorityDigest = canonicalPlacementAuthorityDigest(authorityFacts);
      const existing = decisionFromAttempt(context.attempt);
      if (existing) {
        if (existing.inputDigest !== authorityDigest || existing.policyDigest !== authorityDigest) {
          throw new JobPlacementError("placement_already_decided");
        }
        return existing;
      }

      const registeredGeneration = routedRow?.registeredProfile &&
        typeof routedRow.registeredProfile.deviceGeneration === "number"
        ? routedRow.registeredProfile.deviceGeneration
        : null;
      const temporarilyUnavailable = normalized.success === false &&
        normalized.reason === "unmapped_execution_target" && routedRow !== null &&
        (routedRow.status !== "active" || registeredGeneration !== routedRow.deviceGeneration);
      const routingDenied = routingError !== null && !routingTemporarilyUnavailable;
      const decision: JobPlacementDecision = routingDenied
        ? {
            disposition: "failed",
            owner: null,
            targetId: null,
            targetClass: null,
            targetScope: null,
            targetGeneration: null,
            profileHash: null,
            providerConstraintHash: null,
            fallbackDisposition: "forbidden",
            reasonCode: "execution_target_resolution_failed",
            mode: authority.rollout.mode === "shadow" ? "shadow" : "active",
            leaseEligible: false,
            inputDigest: authorityDigest,
            policyDigest: authorityDigest,
          }
        : temporarilyUnavailable
        ? {
            disposition: requestedTarget ? "failed" : "queued",
            owner: null,
            targetId: null,
            targetClass: null,
            targetScope: null,
            targetGeneration: null,
            profileHash: null,
            providerConstraintHash: null,
            fallbackDisposition: "forbidden",
            reasonCode: "required_target_unavailable",
            mode: authority.rollout.mode === "shadow" ? "shadow" : "active",
            leaseEligible: false,
            inputDigest: authorityDigest,
            policyDigest: authorityDigest,
          }
        : decideJobPlacement({
        sourceKind,
        rollout: !normalized.success && !authority.rollout.enabled
          ? { enabled: true, mode: "active", reason: "invalid_placement_input" }
          : authority.rollout,
        requirements: normalized.success && normalized.active ? normalized.requirements : ({} as never),
        providerDemand: normalized.success && normalized.active ? normalized.providerDemand : ({} as never),
        credentialOwnerPrincipalId: normalized.success && normalized.active ? normalized.credentialOwnerId : null,
        now: input.now,
        maxHeartbeatAgeMs: input.maxHeartbeatAgeMs,
        inputDigest: authorityDigest,
        policyDigest: authorityDigest,
        candidates,
        resolvedTargetId: resolvedTarget?.targetId ?? null,
        targetIdentityPolicy: normalized.success && normalized.active ? normalized.targetIdentityPolicy : null,
          });
      const stored = await repos.jobControl.persistPlacementDecision({
        organizationId: input.organizationId,
        companyId: input.companyId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        placementDisposition: decision.disposition,
        placementOwner: decision.owner,
        placementTargetId: decision.targetId,
        placementTargetClass: decision.targetClass,
        placementTargetScope: decision.targetScope,
        placementTargetGeneration: decision.targetGeneration,
        placementProfileHash: decision.profileHash,
        placementProviderConstraintHash: decision.providerConstraintHash,
        placementFallbackDisposition: decision.fallbackDisposition,
        placementReasonCode: decision.reasonCode,
        placementMode: decision.mode,
        placementLeaseEligible: decision.leaseEligible,
        placementOwnerPrincipalId: decision.owner === "owner_desktop"
          ? candidates.find((candidate) => candidate.registry.targetId === decision.targetId)
              ?.registry.registeredProfile.ownerPrincipalId ?? null
          : null,
        placementInputDigest: decision.inputDigest,
        placementPolicyDigest: decision.policyDigest,
        placementDecidedAt: input.now,
      });
      if (!stored && decision.disposition === "selected" && decision.owner === "owner_desktop") {
        const ownerUnavailable: JobPlacementDecision = {
          disposition: requestedTarget ? "failed" : "queued",
          owner: null,
          targetId: null,
          targetClass: null,
          targetScope: null,
          targetGeneration: null,
          profileHash: null,
          providerConstraintHash: null,
          fallbackDisposition: "forbidden",
          reasonCode: "required_target_unavailable",
          mode: decision.mode,
          leaseEligible: false,
          inputDigest: decision.inputDigest,
          policyDigest: decision.policyDigest,
        };
        const fallbackStored = await repos.jobControl.persistPlacementDecision({
          organizationId: input.organizationId,
          companyId: input.companyId,
          jobId: input.jobId,
          attemptId: input.attemptId,
          placementDisposition: ownerUnavailable.disposition,
          placementOwner: ownerUnavailable.owner,
          placementTargetId: ownerUnavailable.targetId,
          placementTargetClass: ownerUnavailable.targetClass,
          placementTargetScope: ownerUnavailable.targetScope,
          placementTargetGeneration: ownerUnavailable.targetGeneration,
          placementProfileHash: ownerUnavailable.profileHash,
          placementProviderConstraintHash: ownerUnavailable.providerConstraintHash,
          placementFallbackDisposition: ownerUnavailable.fallbackDisposition,
          placementReasonCode: ownerUnavailable.reasonCode,
          placementMode: ownerUnavailable.mode,
          placementLeaseEligible: ownerUnavailable.leaseEligible,
          placementOwnerPrincipalId: null,
          placementInputDigest: ownerUnavailable.inputDigest,
          placementPolicyDigest: ownerUnavailable.policyDigest,
          placementDecidedAt: input.now,
        });
        if (!fallbackStored) throw new JobPlacementError("placement_already_decided");
        return decisionFromAttempt(fallbackStored)!;
      }
      if (!stored) throw new JobPlacementError("placement_already_decided");

      // DAT-008 — mint the execution-secret handle under the SAME lock that just
      // decided the placement, because the handle pins the placed target generation.
      // Gated on a live, lease-eligible ACTIVE selection: a shadow or unplaced
      // decision must stay effect-free, and nothing will ever lease it to redeem the
      // handle anyway.
      //
      // Best-effort by construction: a refusal is the NORMAL outcome for most jobs
      // (self-hosted, non-agent executor, adapter outside the v1 scope), and a
      // failure must not fail placement — that would take the LEGACY path down with
      // it, since placement is shared. The job simply leases with no handle and the
      // sandbox has no key, which is the pre-DAT-008 behaviour.
      if (stored.placementDisposition === "selected"
        && stored.placementMode === "active"
        && stored.placementLeaseEligible === true) {
        try {
          const mint = await mintExecutionSecretHandleForPlacement(repos.jobControl, {
            organizationId: input.organizationId,
            companyId: input.companyId,
            jobId: input.jobId,
            executorPrincipalKind: context.job.executorPrincipalKind,
            executorPrincipalId: context.job.executorPrincipalId,
            placementOwner: decision.owner,
            // The SECOND, independently-derived owner authority (deferral #3): normally
            // the job's own credential-binding resolution, not the routed target's
            // profile that produced `decision.owner`. CLI-007 (E7-F001): a canary rides
            // its preflight-ESTABLISHED Company authority (`input.mintCredentialAuthority`,
            // "company_api_key") instead of the binding's null credentialKind, so the mint can
            // issue a Company `provider_key` handle — WITHOUT that authority ever touching the
            // digest (it is read here, after the decision is persisted) or the binding
            // (unchanged, so replay stays byte-stable). Still independent of Authority A
            // (`decision.owner`), so `ownerAuthoritiesAgree` stays a real cross-check.
            credentialKind: mintCredentialKindFor(
              input.mintCredentialAuthority,
              authority.credentialBinding.credentialKind,
            ),
            targetGeneration: decision.targetGeneration,
          });
          // The refusal reason is the whole point of computing one. Discarding it made
          // a blocked agent silently stay on the legacy executor with no signal
          // anywhere — a partial migration nobody notices. Only the ACTIONABLE reasons
          // are reported: the rest are the normal answer for most jobs and would emit a
          // line per job per placement.
          if (!mint.minted && isActionableMintRefusal(mint.reason as ExecutionSecretMintRefusal)) {
            logger.warn({
              action: "job.execution_secret_mint.refused",
              reasonCode: mint.reason,
              organizationId: input.organizationId,
              companyId: input.companyId,
              jobId: input.jobId,
            }, "execution-secret handle not minted; job stays on the legacy executor");
          }
        } catch {
          // Never a disclosing log: a mint FAILURE (as opposed to a refusal) must not
          // narrate credential topology into the placement path.
        }
        // DAT-007 / CLI-008 — the SECOND handle: the run_jwt (AOA_API_KEY) tool-surface
        // bearer, minted under the SAME lock and pinned to the SAME placed generation.
        // `toolSurfaceAuthorized` is false until Unit C S4, so mintRunJwtHandleForPlacement
        // short-circuits and mints nothing today. Best-effort in its OWN try, exactly like
        // the provider-key mint above: a failure (or the normal refusal) must never fail
        // placement or take the shared legacy path down with it.
        try {
          await mintRunJwtHandleForPlacement(repos.jobControl, {
            organizationId: input.organizationId,
            companyId: input.companyId,
            jobId: input.jobId,
            executorPrincipalKind: context.job.executorPrincipalKind,
            executorPrincipalId: context.job.executorPrincipalId,
            targetGeneration: decision.targetGeneration,
            toolSurfaceAuthorized: input.toolSurfaceAuthorized ?? false,
          });
        } catch {
          // Best-effort: a run_jwt mint failure must never fail placement.
        }
      }

      return decisionFromAttempt(stored)!;
    };

    // Flag-off is tenant-local legacy bookkeeping and must not depend on or
    // contact the distributed operator pool at all.
    if (!authority.rollout.enabled) return decideAndPersist([]);

    // Hold the bounded platform registry snapshot stable until the tenant
    // decision is persisted. This operator callback accepts no job identifiers
    // or payload and FORCE RLS exposes only null-Organization target/worker rows.
    return input.operatorDb.transaction(async (operatorTx) => {
      const platformSnapshots = await listPlatformPlacementCandidateSnapshots(operatorTx);
      return decideAndPersist(platformSnapshots);
    });
  });
}
