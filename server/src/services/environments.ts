import { eq, and, desc, isNotNull, inArray, notInArray, lt, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companies, environmentLeases, environments, executionTargets } from "@armyofagents/db";
import type {
  CreateEnvironmentInput,
  EnvironmentLeaseCleanupStatus,
  EnvironmentLeasePolicy,
  EnvironmentLeaseStatus,
  UpdateEnvironmentInput,
} from "@armyofagents/shared";
import { unprocessable } from "../errors.js";

export type EnvironmentService = ReturnType<typeof environmentService>;

const EXECUTION_TARGET_UNAVAILABLE = "Execution target is unavailable for this company";

// Providers that are NOT external sandbox VMs (local host + single-box docker
// transports). The warm per-company cap only counts external provider sandboxes
// (e2b etc.) — these never accumulate the way a paused snapshot does.
const NON_SANDBOX_LEASE_PROVIDERS = ["local", "sandbox-docker", "docker", "local-docker", "gvisor"];

/**
 * A company may pin a system/shared target or a target owned by its own
 * Organization. Missing tenant context fails closed.
 */
export function mayCompanyPinExecutionTarget(
  companyOrganizationId: string | null,
  targetOrganizationId: string | null,
): boolean {
  return targetOrganizationId === null || (
    companyOrganizationId !== null && companyOrganizationId === targetOrganizationId
  );
}

export function environmentService(db: Db) {
  async function assertExecutionTargetAvailableToCompany(
    companyId: string,
    executionTargetId: string | null | undefined,
  ): Promise<void> {
    // `null` explicitly clears a pin and `undefined` leaves an update unchanged.
    if (executionTargetId == null) return;

    // Production create/update calls this service with the transaction handle
    // supplied by routes/environments.ts. KEY SHARE keeps both ownership rows
    // stable until the environment FK write commits without blocking unrelated
    // reads or non-key updates.
    const [company] = await db
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId))
      .for("key share");
    const [target] = await db
      .select({ organizationId: executionTargets.organizationId })
      .from(executionTargets)
      .where(eq(executionTargets.id, executionTargetId))
      .for("key share");

    if (
      !company ||
      !target ||
      !mayCompanyPinExecutionTarget(company.organizationId, target.organizationId)
    ) {
      // Deliberately identical for missing and foreign targets so this mutation
      // cannot be used to enumerate another Organization's fleet inventory.
      throw unprocessable(EXECUTION_TARGET_UNAVAILABLE);
    }
  }

  return {
    list: async (companyId: string) => {
      return db.select().from(environments).where(eq(environments.companyId, companyId));
    },

    get: async (companyId: string, id: string) => {
      const rows = await db
        .select()
        .from(environments)
        .where(and(eq(environments.id, id), eq(environments.companyId, companyId)));
      return rows[0] ?? null;
    },

    create: async (companyId: string, input: CreateEnvironmentInput) => {
      await assertExecutionTargetAvailableToCompany(companyId, input.executionTargetId);
      const [env] = await db
        .insert(environments)
        .values({ companyId, ...input })
        .returning();
      return env ?? null;
    },

    update: async (companyId: string, id: string, input: UpdateEnvironmentInput) => {
      await assertExecutionTargetAvailableToCompany(companyId, input.executionTargetId);
      const rows = await db
        .update(environments)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(environments.id, id), eq(environments.companyId, companyId)))
        .returning();
      return rows[0] ?? null;
    },

    delete: async (companyId: string, id: string) => {
      const [deleted] = await db
        .delete(environments)
        .where(and(eq(environments.id, id), eq(environments.companyId, companyId)))
        .returning();
      return deleted ?? null;
    },

    acquireLease: async (input: {
      companyId: string;
      environmentId: string;
      executionWorkspaceId?: string | null;
      issueId?: string | null;
      heartbeatRunId?: string | null;
      // Warm-reuse (U7.5): the org agent this lease is held warm for. Set only
      // on `reuse_by_agent` leases; ephemeral callers omit it → NULL (so
      // `findResumablePausedLease`, keyed on agentId, can never match an
      // ephemeral lease). Byte-identical to today for every ephemeral caller.
      agentId?: string | null;
      // Warm-reuse (W7.5c): the Commander conversation this lease is held warm
      // for. Commander has no agent row, so it keys its warm lease on the
      // conversation. Set only on Commander `reuse_by_agent` leases; org/crew/
      // ephemeral callers omit it → NULL (so `findResumableCommanderPausedLease`
      // can never match a non-Commander lease).
      commanderConversationId?: string | null;
      leasePolicy?: EnvironmentLeasePolicy;
      provider?: string | null;
      providerLeaseId?: string | null;
      expiresAt?: Date | null;
      metadata?: Record<string, unknown> | null;
    }) => {
      const [environment] = await db
        .select()
        .from(environments)
        .where(and(eq(environments.id, input.environmentId), eq(environments.companyId, input.companyId)));
      if (!environment) {
        throw new Error("Environment not found for company");
      }

      const now = new Date();
      const [lease] = await db
        .insert(environmentLeases)
        .values({
          companyId: input.companyId,
          environmentId: input.environmentId,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          issueId: input.issueId ?? null,
          heartbeatRunId: input.heartbeatRunId ?? null,
          agentId: input.agentId ?? null,
          commanderConversationId: input.commanderConversationId ?? null,
          status: "active",
          leasePolicy: input.leasePolicy ?? "ephemeral",
          provider: input.provider ?? null,
          providerLeaseId: input.providerLeaseId ?? null,
          acquiredAt: now,
          lastUsedAt: now,
          expiresAt: input.expiresAt ?? null,
          releasedAt: null,
          failureReason: null,
          cleanupStatus: null,
          metadata: input.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!lease) {
        throw new Error("Failed to acquire environment lease");
      }
      return lease;
    },

    releaseLease: async (
      id: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed" | "retained"> = "released",
      options?: {
        failureReason?: string;
        cleanupStatus?: EnvironmentLeaseCleanupStatus;
      },
    ) => {
      const now = new Date();
      const [lease] = await db
        .update(environmentLeases)
        .set({
          status,
          releasedAt: status === "retained" ? null : now,
          lastUsedAt: now,
          updatedAt: now,
          ...(options?.failureReason !== undefined ? { failureReason: options.failureReason } : {}),
          ...(options?.cleanupStatus !== undefined ? { cleanupStatus: options.cleanupStatus } : {}),
        })
        .where(eq(environmentLeases.id, id))
        .returning();
      return lease ?? null;
    },

    listActiveLeasesForRun: async (heartbeatRunId: string) => {
      return db
        .select()
        .from(environmentLeases)
        .where(and(eq(environmentLeases.heartbeatRunId, heartbeatRunId), eq(environmentLeases.status, "active")));
    },

    releaseLeasesForRun: async (
      heartbeatRunId: string,
      status: Extract<EnvironmentLeaseStatus, "released" | "expired" | "failed"> = "released",
    ) => {
      const now = new Date();
      const leases = await db
        .update(environmentLeases)
        .set({
          status,
          releasedAt: now,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(and(eq(environmentLeases.heartbeatRunId, heartbeatRunId), eq(environmentLeases.status, "active")))
        .returning();
      return leases;
    },

    // ── Warm reuse (U7.5) ────────────────────────────────────────────────
    // Find this agent's newest resumable paused lease for a given environment.
    // Only `paused` rows with a non-null providerLeaseId are candidates — a
    // paused snapshot must have a provider sandbox id to reconnect to.
    findResumablePausedLease: async (input: {
      companyId: string;
      agentId: string;
      environmentId: string;
    }) => {
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.companyId, input.companyId),
            eq(environmentLeases.agentId, input.agentId),
            eq(environmentLeases.environmentId, input.environmentId),
            eq(environmentLeases.status, "paused"),
            isNotNull(environmentLeases.providerLeaseId),
          ),
        )
        .orderBy(desc(environmentLeases.pausedAt))
        .limit(1);
      return rows[0] ?? null;
    },

    // Warm reuse (W7.5c) — Commander's conversation-keyed analogue of
    // findResumablePausedLease. Only `paused` rows with a non-null
    // providerLeaseId are resumable candidates.
    findResumableCommanderPausedLease: async (input: {
      companyId: string;
      conversationId: string;
      environmentId: string;
    }) => {
      const rows = await db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.companyId, input.companyId),
            eq(environmentLeases.commanderConversationId, input.conversationId),
            eq(environmentLeases.environmentId, input.environmentId),
            eq(environmentLeases.status, "paused"),
            isNotNull(environmentLeases.providerLeaseId),
          ),
        )
        .orderBy(desc(environmentLeases.pausedAt))
        .limit(1);
      return rows[0] ?? null;
    },

    // Flip a paused lease back to active for a new run. The `AND status='paused'`
    // guard is a concurrency latch: if two runs race to resume the same paused
    // lease, exactly one UPDATE matches (returns the row); the loser gets no row
    // back and its caller falls through to create-fresh — never two runs on one
    // sandbox.
    reactivatePausedLease: async (
      id: string,
      input: {
        heartbeatRunId?: string | null;
        issueId?: string | null;
        executionWorkspaceId?: string | null;
      },
    ) => {
      const now = new Date();
      const [lease] = await db
        .update(environmentLeases)
        .set({
          status: "active",
          pausedAt: null,
          heartbeatRunId: input.heartbeatRunId ?? null,
          issueId: input.issueId ?? null,
          executionWorkspaceId: input.executionWorkspaceId ?? null,
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(and(eq(environmentLeases.id, id), eq(environmentLeases.status, "paused")))
        .returning();
      return lease ?? null;
    },

    // Retire a paused lease (paused → expired) with a status-guarded compare-
    // and-swap. This is the DESTROY-side latch that mirrors reactivatePausedLease
    // (resume-side, paused → active): the `AND status='paused'` guard means a
    // reaper/cap-evictor and a concurrent resume can never both win the same row.
    // If a resume flipped the lease to `active` between the reaper's scan and the
    // kill, this UPDATE matches 0 rows → returns null → the caller MUST skip the
    // provider force-kill (the sandbox is now live). Exactly one of {resume,
    // destroy} wins. Claim BEFORE any provider kill.
    expireLeaseIfPaused: async (
      id: string,
      options?: { cleanupStatus?: EnvironmentLeaseCleanupStatus },
    ) => {
      const now = new Date();
      const [lease] = await db
        .update(environmentLeases)
        .set({
          status: "expired",
          releasedAt: now,
          lastUsedAt: now,
          updatedAt: now,
          ...(options?.cleanupStatus !== undefined ? { cleanupStatus: options.cleanupStatus } : {}),
        })
        .where(and(eq(environmentLeases.id, id), eq(environmentLeases.status, "paused")))
        .returning();
      return lease ?? null;
    },

    // Pause (E2B snapshot) a reuse_by_agent lease at run end instead of killing
    // it. `releasedAt` stays NULL so the warm lookup + idle reaper (both keyed
    // off status) can still find it.
    markLeasePaused: async (
      id: string,
      options?: { cleanupStatus?: EnvironmentLeaseCleanupStatus },
    ) => {
      const now = new Date();
      const [lease] = await db
        .update(environmentLeases)
        .set({
          status: "paused",
          pausedAt: now,
          releasedAt: null,
          lastUsedAt: now,
          updatedAt: now,
          ...(options?.cleanupStatus !== undefined ? { cleanupStatus: options.cleanupStatus } : {}),
        })
        .where(eq(environmentLeases.id, id))
        .returning();
      return lease ?? null;
    },

    // Live+paused EXTERNAL provider sandboxes for a company, oldest-paused first
    // (`pausedAt asc nulls last` puts active leases — pausedAt NULL — last). Used
    // by the per-company warm cap and evict-oldest-paused (U7.6).
    listLiveAndPausedProviderLeasesForCompany: async (companyId: string) => {
      return db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.companyId, companyId),
            inArray(environmentLeases.status, ["active", "paused"]),
            isNotNull(environmentLeases.provider),
            notInArray(environmentLeases.provider, NON_SANDBOX_LEASE_PROVIDERS),
          ),
        )
        .orderBy(sql`${environmentLeases.pausedAt} asc nulls last`);
    },

    // Idle reaper (U7.6) scan: paused external-provider sandboxes whose pausedAt
    // is older than the cutoff. Non-null providerLeaseId only — a paused row
    // must have a sandbox to destroy. Uses the pausedReaperIdx (status,pausedAt).
    listPausedLeasesOlderThan: async (cutoff: Date) => {
      return db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.status, "paused"),
            lt(environmentLeases.pausedAt, cutoff),
            isNotNull(environmentLeases.providerLeaseId),
            notInArray(environmentLeases.provider, NON_SANDBOX_LEASE_PROVIDERS),
          ),
        )
        .orderBy(desc(environmentLeases.pausedAt));
    },
  };
}
