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
          // ★ `createdAt` is DELIBERATELY NOT STAMPED HERE. The column default is `now()`,
          // so the value comes from the DATABASE clock. MIG-010 Unit 2.4 compares
          // `environment_leases.created_at` against a reconciliation pass's DB-clock snapshot
          // instant to narrow the canary gate's lease inventory; a value stamped from the
          // application clock makes that a CROSS-CLOCK comparison, which is the two-clock bug
          // design section 3.3 exists to close. Any skew between the app host and the database
          // would decide whether a lease is inside or outside the watermark.
          //
          // `acquiredAt` / `lastUsedAt` / `updatedAt` keep the application clock on purpose:
          // none of them participates in the watermark comparison, they are read by the warm
          // reuse and reaper paths that already reason in application time, and moving them
          // would be an unrelated behaviour change in this unit.
          //
          // `environments-lease-created-at-db-clock.integration.test.ts` reds if this line
          // comes back.
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

    /**
     * REL-004 Lane D (D2) — paused leases of ONE provider, older than a cutoff.
     *
     * Provider-scoped on purpose. `listPausedLeasesOlderThan` applies a single cutoff to the
     * whole result set, so expressing "this killed provider now, everything else at the idle
     * TTL" through it is impossible: it would zero-grace every paused external-provider lease on
     * the instance the moment any switch existed, including one naming a provider that has no
     * legacy lease at all.
     */
    listPausedLeasesForProvider: async (provider: string, cutoff: Date) => {
      return db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.status, "paused"),
            eq(environmentLeases.provider, provider),
            lt(environmentLeases.pausedAt, cutoff),
            isNotNull(environmentLeases.providerLeaseId),
            notInArray(environmentLeases.provider, NON_SANDBOX_LEASE_PROVIDERS),
          ),
        )
        .orderBy(desc(environmentLeases.pausedAt));
    },

    /**
     * REL-004 Lane D (§5) — paused e2b snapshots that CARRY a recorded key generation.
     *
     * Its own query rather than a filter over `listPausedLeasesForProvider`, for two reasons: the
     * `metadata->>'keyGeneration' IS NOT NULL` predicate belongs in SQL rather than scanning every
     * paused lease into memory, and keeping the two scans distinct makes the reclaim arm and the
     * superseded arm separately observable — in logs and in tests.
     *
     * Untagged rows are excluded here, not skipped later: absence of a generation is "acquired
     * before this tag existed", never "superseded". Reading it the other way would reap every
     * pre-existing warm snapshot on the first deploy.
     */
    listPausedLeasesWithKeyGeneration: async (cutoff: Date) => {
      return db
        .select()
        .from(environmentLeases)
        .where(
          and(
            eq(environmentLeases.status, "paused"),
            eq(environmentLeases.provider, "e2b"),
            lt(environmentLeases.pausedAt, cutoff),
            isNotNull(environmentLeases.providerLeaseId),
            sql`${environmentLeases.metadata}->>'keyGeneration' IS NOT NULL`,
          ),
        )
        .orderBy(desc(environmentLeases.pausedAt));
    },

    /**
     * REL-004 Lane D (D3) — STRANDED leases: terminal in the database, but still holding an
     * unreleased provider handle. The row says "done", the VM says "running", and it bills.
     *
     * Two producers, both verified:
     *   - MIG-008's `casClaimPaused` flips paused -> expired with `cleanup_status='pending'` and
     *     deliberately does not kill;
     *   - the reaper's own CAS (`expireLeaseIfPaused(id)` with no cleanupStatus) followed by a
     *     process death, which leaves `expired` with the field UNCHANGED.
     *
     * `IS DISTINCT FROM 'success'` rather than `= 'pending'` so both are covered, plus the
     * `cleanup_status='failed'` shapes where the provider reported a failed teardown. `status IN
     * ('expired','failed')` because the exception path in environment-runtime sets `failed`, not
     * `expired`. Bounded, because an unbounded sweep over a growing terminal table is its own
     * hazard.
     */
    listTerminalUncleanedLeases: async (limit = 200) => {
      return db
        .select()
        .from(environmentLeases)
        .where(
          and(
            inArray(environmentLeases.status, ["expired", "failed"]),
            // UNATTEMPTED only. `'failed'` means a teardown was already tried and did not
            // confirm; re-listing it would retry a doomed kill every five minutes forever, and
            // `'success'` is done. Claiming moves a row OUT of this set, which is what makes the
            // claim a real compare-and-swap — see `claimTerminalUncleaned`.
            sql`(${environmentLeases.cleanupStatus} IS NULL OR ${environmentLeases.cleanupStatus} = 'pending')`,
            isNotNull(environmentLeases.providerLeaseId),
            notInArray(environmentLeases.provider, NON_SANDBOX_LEASE_PROVIDERS),
          ),
        )
        .orderBy(desc(environmentLeases.updatedAt))
        .limit(limit);
    },

    /**
     * REL-004 Lane D (D3) — the claim latch for a stranded lease, and its RETRY BOUND.
     *
     * The paused reaper claims with `expireLeaseIfPaused` (a `WHERE status='paused'` CAS), which
     * by construction can never match a terminal row — widening the reaper's SELECT without this
     * primitive would have been inert. This is the terminal-row equivalent.
     *
     * Claiming moves `cleanup_status` to 'failed' BEFORE the kill, and the kill promotes it to
     * the real outcome. That is deliberate on both counts: it is the compare-and-swap that stops
     * two concurrent sweeps double-killing one sandbox, AND it is the retry bound — a kill that
     * never succeeds is attempted once, not every five minutes forever.
     */
    claimTerminalUncleaned: async (id: string) => {
      const [lease] = await db
        .update(environmentLeases)
        .set({ cleanupStatus: "failed", updatedAt: new Date() })
        .where(
          and(
            eq(environmentLeases.id, id),
            inArray(environmentLeases.status, ["expired", "failed"]),
            // The CAS predicate MUST exclude the state the claim WRITES, or it is not a CAS at
            // all: with `IS DISTINCT FROM 'success'` a second concurrent claimer matched the
            // already-claimed row and both killed the same sandbox. Caught by the barrier race in
            // `warm-sandbox-reaper-race.integration.test.ts` — and NOT by the naive race beside
            // it, which passed even with this predicate stripped entirely.
            sql`(${environmentLeases.cleanupStatus} IS NULL OR ${environmentLeases.cleanupStatus} = 'pending')`,
            isNotNull(environmentLeases.providerLeaseId),
          ),
        )
        .returning();
      return lease ?? null;
    },
  };
}
