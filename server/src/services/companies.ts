import { and, asc, eq, count, inArray, isNull, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { Db } from "@armyofagents/db";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";
import { memoryFoldersService, seedCompanyRootFolder } from "./memory-folders.js";
import { ensureInternalAgentConfig } from "./internal-agent/aoa-agents/ensure-internal-agent-config.js";
import {
  ensureInfrastructureAgents,
  isCrewMarketplaceManaged,
} from "./internal-agent/aoa-agents/crew-seeding.js";
import { provisionCompanyCrew } from "./crew-provisioning.js";
import { logger } from "../middleware/logger.js";
import {
  companies,
  agents,
  agentApiKeys,
  agentConfigRevisions,
  agentProjects,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueReadStates,
  assets,
  projects,
  projectGoals,
  projectWorkspaces,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  costEvents,
  financeEvents,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  companySkills,
  documents,
  documentRevisions,
  feedbackExports,
  feedbackVotes,
  joinRequests,
  invites,
  notifications,
  principalPermissionGrants,
  companyMemberships,
  mcpApiKeys,
  mcpClientConnections,
  providerAssignments,
  providerConnections,
  runtimeProviderKeys,
  workspaceOperations,
  workspaceRuntimeServices,
  userRoles,
} from "@armyofagents/db";
import { notCrewAssigned } from "./issue-crew-scope.js";
// Type-only (mirrors Fix 5's `import type { organizationAccessService }`): lets
// `createWithOperator` accept a `buildAccess` factory typed against the access
// service WITHOUT a runtime companies↔access import cycle.
import type { accessService } from "./access.js";
import { conflict } from "../errors.js";

type CompanyStatsEntry = {
  agentCount: number;
  issueCount: number;
  pendingApprovalCount: number;
  unreadNotificationCount: number;
};

export interface CreateCompanyOptions {
  /**
   * Attribution for the crew's marketplace install operation
   * (`marketplace_install_operations.requested_by_user_id` — free text, no FK).
   * Optional: the bootstrap falls back to a synthetic system actor.
   */
  requestedByUserId?: string | null;
}

export function companyService(db: Db) {
  const ISSUE_PREFIX_FALLBACK = "CMP";

  function deriveIssuePrefixBase(name: string) {
    const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
    return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
  }

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return "A".repeat(attempt - 1);
  }

  function isIssuePrefixConflict(error: unknown) {
    let current: unknown = error;
    const seen = new Set<unknown>();

    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      const candidate = current as {
        cause?: unknown;
        code?: unknown;
        constraint?: unknown;
        constraint_name?: unknown;
      };
      const constraint = typeof candidate.constraint === "string"
        ? candidate.constraint
        : typeof candidate.constraint_name === "string"
          ? candidate.constraint_name
          : undefined;

      if (candidate.code === "23505" && constraint === "companies_issue_prefix_idx") {
        return true;
      }

      current = candidate.cause;
    }

    return false;
  }

  function isCreationRequestConflict(error: unknown) {
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      const candidate = current as {
        cause?: unknown;
        code?: unknown;
        constraint?: unknown;
        constraint_name?: unknown;
      };
      const constraint = typeof candidate.constraint === "string"
        ? candidate.constraint
        : typeof candidate.constraint_name === "string"
          ? candidate.constraint_name
          : undefined;
      if (
        candidate.code === "23505" &&
        constraint === "companies_organization_creation_request_uq"
      ) {
        return true;
      }
      current = candidate.cause;
    }
    return false;
  }

  function sameJson(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(left ?? {}, right ?? {});
  }

  function companyCreationPayloadMatches(
    existing: typeof companies.$inferSelect,
    data: Omit<typeof companies.$inferInsert, "organizationId"> & { organizationId?: string },
    organizationId: string,
  ): boolean {
    return (
      existing.organizationId === organizationId &&
      existing.name === data.name &&
      existing.description === (data.description ?? null) &&
      existing.status === (data.status ?? "active") &&
      existing.budgetMonthlyCents === (data.budgetMonthlyCents ?? 0) &&
      existing.requireBoardApprovalForNewAgents ===
        (data.requireBoardApprovalForNewAgents ?? true) &&
      existing.agentCompletionPolicyDefault ===
        (data.agentCompletionPolicyDefault ?? "review_required") &&
      existing.agentCompletionReviewGuardrail ===
        (data.agentCompletionReviewGuardrail ?? false) &&
      existing.humanQuestionSlaHours === (data.humanQuestionSlaHours ?? 24) &&
      existing.rootFolder === (data.rootFolder ?? null) &&
      existing.brandColor === (data.brandColor ?? null) &&
      sameJson(existing.commanderAdapterConfig, data.commanderAdapterConfig) &&
      sameJson(existing.crewAdapterConfig, data.crewAdapterConfig)
    );
  }

  async function resolveCompanyCreationReplay(
    handle: Db,
    data: Omit<typeof companies.$inferInsert, "organizationId"> & { organizationId?: string },
  ) {
    if (!data.creationRequestId) return null;
    const organizationId = data.organizationId ?? DEFAULT_ORGANIZATION_ID;
    const existing = await handle
      .select()
      .from(companies)
      .where(
        and(
          eq(companies.organizationId, organizationId),
          eq(companies.creationRequestId, data.creationRequestId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    if (!companyCreationPayloadMatches(existing, data, organizationId)) {
      throw conflict("Company creation request was already used with different details");
    }
    return existing;
  }

  async function resolveCompanyFoundingOperator(handle: Db, companyId: string): Promise<string> {
    const founder = await handle
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.companyId, companyId),
          eq(userRoles.role, "founder"),
        ),
      )
      .orderBy(asc(userRoles.createdAt), asc(userRoles.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!founder) {
      throw new Error(`Company creation replay cannot resolve founding operator for ${companyId}`);
    }
    return founder.userId;
  }

  // Group A (P3 extraction) — the OPERATOR-INDEPENDENT company seeders. These
  // run best-effort AFTER the company row is committed, on BOTH the operator-free
  // `create` path and the atomic `createWithOperator` path, so the two paths seed
  // identically without duplicating the logic. Group B (profile materialization,
  // native skills, the QA-BUG-007 Commander re-run) is OPERATOR-DEPENDENT and
  // stays in the route — it is intentionally NOT run here.
  //
  // Takes only `companyId` + `requestedByUserId`: no operator is needed for any
  // of these steps.
  async function seedNewCompanyBestEffort(
    companyId: string,
    requestedByUserId: string | null,
  ): Promise<void> {
    await seedCompanyRootFolder(memoryFoldersService(db), {
      companyId,
    }).catch((err: unknown) => {
      logger.warn({ err, companyId }, "memory company-root folder seeding failed");
    });
    // Decision #100 — the Commander Team comes with every company.
    // Eagerly seed (1) the default internal_agent_config row and (2) the
    // Commander kind='aoa' agent linked into that config. (1) MUST precede
    // (2) — ensureCommanderAgent's internal_agent_config UPDATE no-ops
    // without an existing config row. Both are idempotent and seeded
    // non-fatally — exactly mirroring the root-folder seed above — so a
    // seed failure never breaks company create.
    //
    // Phase 1 (Task C1 + Phase D batch 2): the Discussion Extraction
    // ("Scribe") agent is no longer seeded at company create. The
    // autonomous extraction drain is gated OFF (AOA_SCRIBE_AUTONOMOUS_
    // DRAIN_ENABLED) — extraction now runs as tool calls from Memory
    // Keeper (phase=done sweep) and Adjutant (optional, mid-discussion).
    // `ensureExtractionAgent` is preserved in the codebase for rollback
    // safety and so the dispatcher's lazy ensure on the legacy autonomous
    // path keeps working when the env flag is re-enabled; it is no longer
    // wired into bootstrap.
    //
    // T3.5: skip CREW provisioning entirely if the marketplace already
    // governs this company's crew. A brand-new company that gets a
    // marketplace install immediately after creation must not have those
    // agents overwritten by the legacy seeders.
    //
    // T2.3 note on why this gate SURVIVED rather than being deleted as
    // "unreachable": it is what pins the read-before-write ordering below,
    // and `aoa-bootstrap-wiring.test.ts` (`stampsOriginOnSeed`) is the
    // regression guard for the silent failure that ordering prevents.
    // It also correctly short-circuits the concurrent-create case, where a
    // sibling create already installed the marketplace crew.
    //
    // Read the gate BEFORE seeding anything. The predicate matches any
    // kind='aoa' row with a non-`@legacy` templateOrigin, and the seeders
    // below insert kind='aoa' rows — reading after writing would be a
    // read-your-own-writes hazard the moment anyone stamps an origin at
    // insert time (today nothing does; see crew-seeding.ts). The failure
    // mode is silent: the company would see its own fresh Commander,
    // conclude "marketplace-managed", and skip its entire crew.
    //
    // isCrewMarketplaceManaged fails open to `false` on a DB error, so a
    // transient blip degrades to the legacy seeders rather than leaving the
    // company crewless — the same semantics the inline copy of this query
    // used to provide.
    const crewIsMarketplaceManaged = await isCrewMarketplaceManaged(db, companyId);

    // P8d / Phase 4B: internal_agent_config + Commander are seeded
    // UNCONDITIONALLY — Commander is not marketplace-owned, and a company
    // without a config row has no autonomy/provider/model dial at all.
    // Steward belongs to the gated CREW roster. Config MUST precede
    // ensureInfrastructureAgents: ensureCommanderAgent's
    // internal_agent_config UPDATE no-ops without an existing config row.
    await ensureInternalAgentConfig(db, companyId).catch((err: unknown) => {
      logger.warn({ err, companyId }, "internal_agent_config seeding failed");
    });
    // P3: now that this runs POST-commit, wrap it best-effort. It was the ONLY
    // un-wrapped seeder here — while inline in the pre-commit try, an unexpected
    // throw would have surfaced as a create failure (and, in createWithOperator,
    // been mistaken for a non-conflict error). ensureInfrastructureAgents already
    // swallows per-step failures internally (runEnsureSteps), so this is
    // belt-and-suspenders that also fully de-risks the move post-commit.
    await ensureInfrastructureAgents(db, companyId).catch((err: unknown) => {
      logger.warn({ err, companyId }, "infrastructure agents (Commander) seeding failed");
    });

    // T2.3 (P8/P8c): install `team:aoa-curated/default-crew` from the
    // marketplace so this company is born UPDATEABLE. Legacy-seeded rows
    // are stamped `…@legacy` and `crew-updater.ts` skips those forever.
    //
    // provisionCompanyCrew never throws and degrades to the legacy seeders
    // (with a log naming the crew members the fallback cannot provide), so
    // a marketplace outage cannot break onboarding.
    if (!crewIsMarketplaceManaged) {
      await provisionCompanyCrew(db, companyId, {
        requestedByUserId: requestedByUserId ?? null,
      });
    }
  }

  async function createCompanyWithUniquePrefix(
    data: Omit<typeof companies.$inferInsert, "organizationId"> & { organizationId?: string },
    opts: CreateCompanyOptions = {},
  ) {
    const base = deriveIssuePrefixBase(data.name);
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      try {
        const rows = await db
          .insert(companies)
          .values({
            ...data,
            // Self-hosted single-tenant + company-portability import land in the
            // sentinel Organization unless a real org context is supplied.
            organizationId: data.organizationId ?? DEFAULT_ORGANIZATION_ID,
            issuePrefix: candidate,
          })
          .returning();
        const company = rows[0];
        await seedNewCompanyBestEffort(company.id, opts.requestedByUserId ?? null);
        return company;
      } catch (error) {
        if (!isIssuePrefixConflict(error)) throw error;
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  // P3 — atomic company + founder-membership create (mirrors Fix 5's
  // `createSelfServeOrganization`). The company insert AND the operator write
  // (`ensureRealOperator`: authUsers + company owner membership + founder role +
  // org owner membership) run inside ONE `db.transaction`, so a transient fault
  // between them can NEVER leave an orphan company with no membership for anyone
  // (unrecoverable in cloud_auth).
  //
  // PREFIX RETRY: the issue-prefix de-dup loop lives OUTSIDE the transaction —
  // each attempt is a fresh transaction with exactly ONE company insert +
  // operator write. A 23505 prefix conflict aborts (and rolls back) only that
  // attempt's transaction and is caught outside it; the next attempt retries
  // with a new candidate prefix in a brand-new transaction. Any OTHER error
  // re-throws (the tx rolls back → no orphan). Retrying INSIDE a single
  // transaction is impossible: a 23505 aborts the whole PG tx.
  //
  // `buildAccess` is a factory bound to the TRANSACTION handle so all of
  // ensureRealOperator's writes (and its `companies.organizationId` read) join
  // the same tx. It is a PARAMETER (not a direct `accessService` call) to avoid
  // a companies↔access runtime import cycle.
  //
  // Group A (operator-independent seeders) runs best-effort AFTER the committed
  // tx — never inside it, so a non-critical seed failure cannot roll back a
  // committed company. Group B (operator-dependent) stays with the caller.
  async function createWithOperator<TActivity = never>(
    data: Omit<typeof companies.$inferInsert, "organizationId"> & { organizationId?: string },
    opts: CreateCompanyOptions,
    ownerUserId: string | null | undefined,
    buildAccess: (handle: Db) => Pick<ReturnType<typeof accessService>, "ensureRealOperator">,
    recordActivity?: (
      handle: Db,
      company: typeof companies.$inferSelect,
      operatorId: string,
    ) => Promise<TActivity>,
  ): Promise<{
    company: typeof companies.$inferSelect;
    operatorId: string;
    created: boolean;
    committedActivity: TActivity | null;
  }> {
    const initialReplay = await resolveCompanyCreationReplay(db, data);
    if (initialReplay) {
      // A prior request may have committed immediately before the process died
      // in the best-effort bootstrap phase. Reconcile the idempotent Group-A
      // resources on every replay so response-loss recovery also repairs a
      // partially bootstrapped company.
      const operatorId = await resolveCompanyFoundingOperator(db, initialReplay.id);
      await seedNewCompanyBestEffort(initialReplay.id, opts.requestedByUserId ?? null);
      return {
        company: initialReplay,
        operatorId,
        created: false,
        committedActivity: null,
      };
    }
    const base = deriveIssuePrefixBase(data.name);
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      try {
        const result = await db.transaction(async (tx) => {
          if (data.creationRequestId) {
            // Serialize the Organization-scoped request key. Another
            // Organization may legitimately use the same random UUID because
            // the durable key is the composite (organizationId, requestId).
            await tx.execute(
              sql`SELECT pg_advisory_xact_lock(hashtext('aoa:company-create'), hashtext(${`${data.organizationId ?? DEFAULT_ORGANIZATION_ID}:${data.creationRequestId}`}))`,
            );
            const replay = await resolveCompanyCreationReplay(tx as unknown as Db, data);
            if (replay) {
              const operatorId = await resolveCompanyFoundingOperator(
                tx as unknown as Db,
                replay.id,
              );
              return {
                company: replay,
                operatorId,
                created: false as const,
                committedActivity: null,
              };
            }
          }
          const rows = await tx
            .insert(companies)
            .values({
              ...data,
              organizationId: data.organizationId ?? DEFAULT_ORGANIZATION_ID,
              issuePrefix: candidate,
            })
            .returning();
          const inserted = rows[0];
          const opId = await buildAccess(tx as unknown as Db).ensureRealOperator(
            inserted.id,
            ownerUserId,
          );
          const activity = recordActivity
            ? await recordActivity(tx as unknown as Db, inserted, opId)
            : null;
          return {
            company: inserted,
            operatorId: opId,
            created: true as const,
            committedActivity: activity,
          };
        });
        // These ensure-style seeders are idempotent and intentionally run for
        // both a new commit and an advisory-lock replay.
        await seedNewCompanyBestEffort(result.company.id, opts.requestedByUserId ?? null);
        return result;
      } catch (error) {
        if (data.creationRequestId && isCreationRequestConflict(error)) {
          const replay = await resolveCompanyCreationReplay(db, data);
          if (replay) {
            const operatorId = await resolveCompanyFoundingOperator(db, replay.id);
            await seedNewCompanyBestEffort(replay.id, opts.requestedByUserId ?? null);
            return {
              company: replay,
              operatorId,
              created: false,
              committedActivity: null,
            };
          }
        }
        if (!isIssuePrefixConflict(error)) throw error;
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique issue prefix");
  }

  return {
    list: (allowedCompanyIds: string[] | "unscoped") => {
      // Fix 4: push the actor's allowed-company set into SQL instead of scanning
      // every tenant's companies and filtering in JS. The param is REQUIRED and
      // discriminated so "unscoped" (all tenants) can only ever be reached by an
      // explicit, visible choice — a caller can no longer leak every tenant by
      // omitting the argument (that is now a TypeScript error). "unscoped" →
      // unfiltered (self-hosted operator view, unchanged); empty → a `false`
      // predicate (explicit degrade-to-none, never return-all). drizzle also
      // lowers inArray(id, []) to `false`, but this keeps it version-independent.
      if (allowedCompanyIds === "unscoped") {
        return db.select().from(companies);
      }
      return db
        .select()
        .from(companies)
        .where(
          allowedCompanyIds.length === 0
            ? sql`false`
            : inArray(companies.id, allowedCompanyIds),
        );
    },

    getById: (id: string) =>
      db
        .select()
        .from(companies)
        .where(eq(companies.id, id))
        .then((rows) => rows[0] ?? null),

    create: async (
      data: Omit<typeof companies.$inferInsert, "organizationId"> & { organizationId?: string },
      opts: CreateCompanyOptions = {},
    ) => createCompanyWithUniquePrefix(data, opts),

    createWithOperator,

    update: (id: string, data: Partial<typeof companies.$inferInsert>) => {
      // Tenant-key immutability (Codex ①): organizationId is assigned once at
      // create and must NEVER be rewritten by an update — a cross-tenant reparent
      // is a tenant-isolation breach. The update validator already omits it
      // (validators/company.ts); this strip is the defense-in-depth at the service
      // seam for any direct/non-route caller. No legitimate caller passes
      // organizationId here (company-portability import update passes only
      // name/description/brandColor/requireBoardApprovalForNewAgents).
      const {
        organizationId: _omitOrganizationId,
        creationRequestId: _omitCreationRequestId,
        ...mutable
      } = data;
      return db
        .update(companies)
        .set({ ...mutable, updatedAt: new Date() })
        .where(eq(companies.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    archive: (id: string) =>
      db
        .update(companies)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(companies.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // All work creation locks the company before child rows. Take the same
        // parent lock before the explicit child deletes to avoid lock cycles.
        await tx.execute(sql`select id from ${companies} where ${companies.id} = ${id} for update`);
        // Delete from child tables in dependency order.
        //
        // Schema-level FK cascades (migration 0066) make the explicit deletes
        // here belt-and-suspenders rather than load-bearing — but the order is
        // preserved so dependency relationships remain documented and so that
        // any future regression in the cascade rules surfaces here, not in a
        // 500 from /api/companies/:id.
        // === Workspace runtime (depends on executionWorkspaces, agents) ===
        await tx.delete(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.companyId, id));
        await tx.delete(workspaceOperations).where(eq(workspaceOperations.companyId, id));
        // === Heartbeat surface (depends on agents, runs) ===
        await tx.delete(heartbeatRunWatchdogDecisions).where(eq(heartbeatRunWatchdogDecisions.companyId, id));
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id));
        // === Agent runtime ===
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.companyId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, id));
        // === Issue dependents ===
        await tx.delete(issueAttachments).where(eq(issueAttachments.companyId, id));
        await tx.delete(issueDocuments).where(eq(issueDocuments.companyId, id));
        await tx.delete(issueApprovals).where(eq(issueApprovals.companyId, id));
        await tx.delete(issueComments).where(eq(issueComments.companyId, id));
        // === Cost / finance ===
        await tx.delete(financeEvents).where(eq(financeEvents.companyId, id));
        await tx.delete(costEvents).where(eq(costEvents.companyId, id));
        // === Approvals ===
        await tx.delete(approvalComments).where(eq(approvalComments.companyId, id));
        await tx.delete(approvals).where(eq(approvals.companyId, id));
        // === Memberships, secrets, invites ===
        // Two tables hold ON DELETE restrict FKs into company_secrets:
        // provider_connections.secret_ref (migration 0190) and
        // runtime_provider_keys.secret_id. A connection minted from a backfilled
        // legacy key, or a stored runtime provider key, therefore PINS its secret.
        // Unlike the belt-and-suspenders cascade deletes above, these are
        // load-bearing: without them the companySecrets delete below hits the
        // RESTRICT FK and aborts the whole transaction. Clear both referrers
        // BEFORE companySecrets — provider_assignments first (its connection_id →
        // provider_connections cascades, but explicit-and-ordered mirrors this
        // teardown), then the connections and the runtime keys.
        await tx.delete(providerAssignments).where(eq(providerAssignments.companyId, id));
        await tx.delete(providerConnections).where(eq(providerConnections.companyId, id));
        await tx.delete(runtimeProviderKeys).where(eq(runtimeProviderKeys.companyId, id));
        await tx.delete(companySecrets).where(eq(companySecrets.companyId, id));
        await tx.delete(joinRequests).where(eq(joinRequests.companyId, id));
        await tx.delete(invites).where(eq(invites.companyId, id));
        await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, id));
        await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, id));
        await tx.delete(mcpClientConnections).where(eq(mcpClientConnections.companyId, id));
        await tx.delete(mcpApiKeys).where(eq(mcpApiKeys.companyId, id));
        // === Feedback ===
        await tx.delete(feedbackExports).where(eq(feedbackExports.companyId, id));
        await tx.delete(feedbackVotes).where(eq(feedbackVotes.companyId, id));
        // === Documents & artifacts ===
        await tx.delete(documentRevisions).where(eq(documentRevisions.companyId, id));
        await tx.delete(documents).where(eq(documents.companyId, id));
        await tx.delete(assets).where(eq(assets.companyId, id));
        await tx.delete(issueReadStates).where(eq(issueReadStates.companyId, id));
        // === Workspace surface (depends on heartbeatRuns, projects) ===
        await tx.delete(executionWorkspaces).where(eq(executionWorkspaces.companyId, id));
        await tx.delete(projectWorkspaces).where(eq(projectWorkspaces.companyId, id));
        await tx.delete(agentProjects).where(eq(agentProjects.companyId, id));
        // === Issue surface ===
        await tx.delete(issues).where(eq(issues.companyId, id));
        // === Goals, projects (parents in dependency order) ===
        await tx.delete(projectGoals).where(eq(projectGoals.companyId, id));
        await tx.delete(goals).where(eq(goals.companyId, id));
        await tx.delete(projects).where(eq(projects.companyId, id));
        // === Agent config + skills ===
        await tx.delete(agentConfigRevisions).where(eq(agentConfigRevisions.companyId, id));
        await tx.delete(companySkills).where(eq(companySkills.companyId, id));
        // === Top-level: agents, activity log ===
        await tx.delete(agents).where(eq(agents.companyId, id));
        await tx.delete(activityLog).where(eq(activityLog.companyId, id));
        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      }),

    stats: (allowedCompanyIds: string[] | "unscoped") => {
      // Fix 4: empty allow-set → return none WITHOUT four instance-wide GROUP BY
      // scans (explicit degrade-to-none; mirrors the list() guard). The param is
      // REQUIRED and discriminated so "unscoped" (all tenants) can only be reached
      // by an explicit choice, never by omission (now a TypeScript error).
      if (allowedCompanyIds !== "unscoped" && allowedCompanyIds.length === 0) {
        return Promise.resolve<Record<string, CompanyStatsEntry>>({});
      }
      // "unscoped" allow-set → unscoped (self-hosted operator view, unchanged).
      // A non-empty allow-set is AND-ed into each aggregation as an inArray on
      // the table's company_id, pushing the tenant filter into SQL. The
      // `=== "unscoped"` ternary (not a derived boolean) narrows allowedCompanyIds
      // to string[] in the scoped branch so inArray typechecks; the base branch
      // returns the predicate UNCHANGED so the correlated-crew SQL stays byte-
      // identical to today (crew-scope-counts.test.ts).
      return Promise.all([
        db
          .select({ companyId: agents.companyId, count: count() })
          .from(agents)
          // Per-company agent counts exclude platform (Commander-team) agents.
          .where(
            allowedCompanyIds === "unscoped"
              ? eq(agents.kind, "org")
              : and(eq(agents.kind, "org"), inArray(agents.companyId, allowedCompanyIds)),
          )
          .groupBy(agents.companyId),
        db
          .select({ companyId: issues.companyId, count: count() })
          .from(issues)
          // Per-company issue (active-tasks) counts exclude crew-agent tasks, so
          // the lobby card mirrors the agent count's org-only intent. This is a
          // CROSS-COMPANY batch (groupBy company_id, no fixed company), so the
          // crew predicate is the CORRELATED form (no arg → agents.company_id =
          // issues.company_id). Crew tasks live only on the Crew Board.
          .where(
            allowedCompanyIds === "unscoped"
              ? notCrewAssigned()
              : and(notCrewAssigned(), inArray(issues.companyId, allowedCompanyIds)),
          )
          .groupBy(issues.companyId),
        db
          .select({ companyId: approvals.companyId, count: count() })
          .from(approvals)
          .where(
            allowedCompanyIds === "unscoped"
              ? eq(approvals.status, "pending")
              : and(eq(approvals.status, "pending"), inArray(approvals.companyId, allowedCompanyIds)),
          )
          .groupBy(approvals.companyId),
        db
          .select({ companyId: notifications.companyId, count: count() })
          .from(notifications)
          .where(
            allowedCompanyIds === "unscoped"
              ? isNull(notifications.readAt)
              : and(isNull(notifications.readAt), inArray(notifications.companyId, allowedCompanyIds)),
          )
          .groupBy(notifications.companyId),
      ]).then(([agentRows, issueRows, approvalRows, notificationRows]) => {
        const result: Record<string, CompanyStatsEntry> = {};
        function ensure(companyId: string) {
          if (!result[companyId]) {
            result[companyId] = {
              agentCount: 0,
              issueCount: 0,
              pendingApprovalCount: 0,
              unreadNotificationCount: 0,
            };
          }
          return result[companyId];
        }
        for (const row of agentRows) {
          ensure(row.companyId).agentCount = row.count;
        }
        for (const row of issueRows) {
          ensure(row.companyId).issueCount = row.count;
        }
        for (const row of approvalRows) {
          ensure(row.companyId).pendingApprovalCount = row.count;
        }
        for (const row of notificationRows) {
          ensure(row.companyId).unreadNotificationCount = row.count;
        }
        return result;
      });
    },
  };
}
