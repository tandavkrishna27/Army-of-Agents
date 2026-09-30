import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agents,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  authUsers,
  companyMemberships,
  userRoles,
  projects,
} from "@armyofagents/db";
import { isUuidLike, normalizeAgentUrlKey } from "@armyofagents/shared";
import type { UnifiedOrgNode } from "@armyofagents/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import {
  deduplicateAgentName,
  findAgentShortnameCollision,
  hasAgentShortnameCollision,
} from "./agent-shortnames.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";
import { orgHierarchyService, type EntityType } from "./org-hierarchy.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Enforce: CXO-tier agents can only report to a human user or sit at the
 * org root. They MUST NOT report to another agent.
 *
 * Why: CXO is the apex tier in the agent hierarchy. The "Chief of Staff"
 * derivation in the org-tree UI assumes the topmost CXO is the founder's
 * primary delegate; allowing CXOs to be parented under arbitrary agents
 * inverts the hierarchy and produces a confusing org chart. Mid-tier
 * leaders use `lead` (which has no parent constraint).
 *
 * Throws `unprocessable` (422) when violated.
 *
 * Exported so it can be unit-tested directly without DB mocking.
 */
export function assertCxoParentConstraint(
  role: string | null | undefined,
  parentType: string | null | undefined,
): void {
  if (role === "cxo" && parentType === "agent") {
    throw unprocessable(
      "CXO agents can only report to a human user or sit at the root of the " +
      "org. Reassign their parent to a user (or null) before promoting to " +
      "CXO, or downgrade to `lead` if they should report to another agent.",
    );
  }
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "reportsTo",
  "parentType",
  "parentId",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "budgetMonthlyCents",
  "metadata",
] as const;

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
  /**
   * Optimistic-concurrency token (the agent row's `updatedAt`, as an ISO
   * string). When present, the write is an atomic conditional UPDATE guarded
   * against `agents.updatedAt`; a mismatch (row changed underneath, while it
   * still exists) throws `conflict()` (409). When absent, last-write-wins.
   */
  expectedUpdatedAt?: string;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildConfigSnapshot(
  row: Pick<typeof agents.$inferSelect, ConfigRevisionField>,
): AgentConfigSnapshot {
  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? sanitizeRecord(row.adapterConfig as Record<string, unknown>)
      : {};
  const runtimeConfig =
    typeof row.runtimeConfig === "object" && row.runtimeConfig !== null && !Array.isArray(row.runtimeConfig)
      ? sanitizeRecord(row.runtimeConfig as Record<string, unknown>)
      : {};
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? sanitizeRecord(row.metadata as Record<string, unknown>)
      : row.metadata ?? null;
  return {
    name: row.name,
    role: row.role,
    title: row.title,
    reportsTo: row.reportsTo,
    parentType: row.parentType ?? null,
    parentId: row.parentId ?? null,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    adapterConfig,
    runtimeConfig,
    budgetMonthlyCents: row.budgetMonthlyCents,
    metadata,
  };
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  const patch: Partial<typeof agents.$inferInsert> = {
    name: snapshot.name,
    role: snapshot.role,
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    adapterType: snapshot.adapterType,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };

  if ("parentType" in snapshot) {
    patch.parentType =
      typeof snapshot.parentType === "string" || snapshot.parentType === null ? snapshot.parentType : null;
  }
  if ("parentId" in snapshot) {
    patch.parentId =
      typeof snapshot.parentId === "string" || snapshot.parentId === null ? snapshot.parentId : null;
  }

  return patch;
}

export {
  deduplicateAgentName,
  findAgentShortnameCollision,
  hasAgentShortnameCollision,
} from "./agent-shortnames.js";

const USER_ROLE_PRIORITY: Record<string, number> = { founder: 3, team_lead: 2, team_member: 1 };

function isValidParentType(value: unknown): value is "agent" | "user" {
  return value === "agent" || value === "user";
}

export function agentService(db: Db) {
  const orgHierarchy = orgHierarchyService(db);

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentRow(row: typeof agents.$inferSelect) {
    return withUrlKey({
      ...row,
      permissions: normalizeAgentPermissions(row.permissions, row.role),
    });
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? normalizeAgentRow(row) : null;
  }

  async function assertCompanyShortnameAvailable(
    companyId: string,
    candidateName: string,
    options?: AgentShortnameCollisionOptions,
  ) {
    const candidateShortname = normalizeAgentUrlKey(candidateName);
    if (!candidateShortname) return;

    const existingAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        kind: agents.kind,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const collision = findAgentShortnameCollision(candidateName, existingAgents, options);
    if (collision) {
      // Org and AoA-crew agents share one shortname namespace (so @shortname
      // references stay unambiguous). The crew agents live under the AoA Team
      // tab and are NOT shown in the Agents tab, so a bare "already in use"
      // error reads as a phantom conflict. Name the conflict explicitly.
      if (collision.kind === "aoa") {
        throw conflict(
          `The name "${candidateName}" is already used by a built-in AoA crew agent ` +
            `("${collision.name}", shown under the AoA Team tab). Choose a different name.`,
        );
      }
      throw conflict(
        `The name "${candidateName}" is already used by another agent ("${collision.name}") ` +
          `in this company. Choose a different name.`,
      );
    }
  }

  async function updateAgent(
    id: string,
    data: Partial<typeof agents.$inferInsert>,
    options?: UpdateAgentOptions,
  ) {
    const existing = await getById(id);
    if (!existing) return null;

    if (existing.status === "terminated" && data.status && data.status !== "terminated") {
      throw conflict("Terminated agents cannot be resumed");
    }
    if (
      existing.status === "pending_approval" &&
      data.status &&
      data.status !== "pending_approval" &&
      data.status !== "terminated"
    ) {
      throw conflict("Pending approval agents cannot be activated directly");
    }

    // D7: Bidirectional sync — parentType/parentId ↔ reportsTo
    if (data.parentType !== undefined || data.parentId !== undefined) {
      const newParentType = (data.parentType ?? null) as EntityType | null;
      const newParentId = data.parentId ?? null;
      if (newParentType && newParentId) {
        await orgHierarchy.ensureParent(existing.companyId, newParentType, newParentId);
        await orgHierarchy.assertNoCycle(existing.companyId, id, "agent", newParentId, newParentType);
      }
      data.parentType = newParentType;
      data.parentId = newParentId;
      data.reportsTo = (newParentType === "agent" ? newParentId : null) as string | null;
    } else if (data.reportsTo !== undefined) {
      if (data.reportsTo) {
        await orgHierarchy.ensureParent(existing.companyId, "agent", data.reportsTo);
        await orgHierarchy.assertNoCycle(existing.companyId, id, "agent", data.reportsTo, "agent");
      }
      data.parentType = data.reportsTo ? "agent" : null;
      data.parentId = data.reportsTo ?? null;
    }

    // CXO parent constraint: must hold against the EFFECTIVE post-patch
    // state. Either the role or the parent could be changing in this PATCH;
    // we evaluate the merged result so that promoting `lead → cxo` while the
    // agent still has an agent-typed parent fails cleanly.
    {
      const effectiveRole = (data.role ?? existing.role) as string;
      const effectiveParentType =
        data.parentType !== undefined ? (data.parentType as string | null) : existing.parentType;
      assertCxoParentConstraint(effectiveRole, effectiveParentType);
    }

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.companyId, data.name, { excludeAgentId: id });
      }
    }

    const normalizedPatch = { ...data } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role);
    }

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);
    const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(existing) : null;

    // Normalize the client token to a ms-precision ISO string and bind it as
    // text, casting in-SQL to timestamptz. Interpolating a raw JS `Date` into the
    // sql`` fragment leaves Drizzle with no column type to encode against, so
    // node-postgres serializes it as a `Date.toString()` ("Fri Jun 26 2026 …")
    // that Postgres rejects (ERR_INVALID_ARG_TYPE). An ISO string + an explicit
    // ::timestamptz cast is unambiguous and driver-safe.
    const expectedIso =
      options?.expectedUpdatedAt != null ? new Date(options.expectedUpdatedAt).toISOString() : null;
    const guard =
      expectedIso != null
        ? and(
            eq(agents.id, id),
            // Millisecond-precision compare. `agents.updatedAt` is stored at
            // Postgres microsecond resolution (defaultNow() on never-updated rows);
            // the client token is a ms-precision ISO string. A naked
            // `eq(agents.updatedAt, …)` would never match a freshly-created
            // row → spurious 409 + retry loop. date_trunc both sides to ms.
            sql`date_trunc('milliseconds', ${agents.updatedAt}) = date_trunc('milliseconds', ${expectedIso}::timestamptz)`,
          )
        : eq(agents.id, id);

    const updated = await db
      .update(agents)
      .set({ ...normalizedPatch, updatedAt: new Date() })
      .where(guard)
      .returning()
      .then((rows) => rows[0] ?? null);

    // Optimistic-concurrency: a token was supplied but the guarded write matched
    // no row. Distinguish "row changed underneath" (409) from "row gone" (404):
    // re-read by id. A pre-read compare would be TOCTOU — the guard above is the
    // atomic check; this re-read only classifies the miss. (Precedent: issues.ts
    // `checkout`.)
    if (!updated && expectedIso != null) {
      const current = await getById(id);
      if (current) {
        throw conflict(
          "This agent was changed by someone else. Reload and re-apply your change.",
          { currentUpdatedAt: current.updatedAt.toISOString() },
        );
      }
      return null; // row vanished concurrently → caller/route maps to 404
    }
    const normalizedUpdated = updated ? normalizeAgentRow(updated) : null;

    if (normalizedUpdated && shouldRecordRevision && beforeConfig) {
      const afterConfig = buildConfigSnapshot(normalizedUpdated);
      const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
      if (changedKeys.length > 0) {
        await db.insert(agentConfigRevisions).values({
          companyId: normalizedUpdated.companyId,
          agentId: normalizedUpdated.id,
          createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
          createdByUserId: options?.recordRevision?.createdByUserId ?? null,
          source: options?.recordRevision?.source ?? "patch",
          rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
          changedKeys,
          beforeConfig: beforeConfig as unknown as Record<string, unknown>,
          afterConfig: afterConfig as unknown as Record<string, unknown>,
        });
      }
    }

    return normalizedUpdated;
  }

  async function backfillParentFields(): Promise<number> {
    const rows = await db
      .select({ id: agents.id, reportsTo: agents.reportsTo })
      .from(agents)
      .where(and(isNotNull(agents.reportsTo), isNull(agents.parentType)));

    if (rows.length === 0) return 0;

    let count = 0;
    for (const row of rows) {
      await db
        .update(agents)
        .set({
          parentType: "agent",
          parentId: row.reportsTo,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, row.id));
      count++;
    }
    return count;
  }

  // W6: backfill pre-rule rootless org agents to the founder (human-at-top).
  // Org agents created before the human-at-top rule may sit at the org root with
  // no parent. Re-parent each (non-terminated, org-kind, rootless) agent to the
  // company's founder so the chain always tops at a human. Remove after
  // confirming all data migrated.
  async function backfillHumanAtTop(companyId: string): Promise<number> {
    const founderId = await orgHierarchy.getFounderUserId(companyId);
    if (!founderId) return 0;
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(
        eq(agents.companyId, companyId),
        eq(agents.kind, "org"),
        ne(agents.status, "terminated"),
        isNull(agents.parentId),
      ));
    let count = 0;
    for (const row of rows) {
      await db.update(agents)
        .set({ parentType: "user", parentId: founderId, updatedAt: new Date() })
        .where(eq(agents.id, row.id));
      count++;
    }
    return count;
  }

  return {
    backfillParentFields,
    backfillHumanAtTop,

    list: async (companyId: string, options?: { includeTerminated?: boolean; kind?: "org" | "aoa" }) => {
      // Centralized org-agent accessor: platform agents (Commander team,
      // kind='platform') are excluded from user-facing enumeration. Backfill
      // default is 'org', so this is a no-op for all pre-existing data.
      const conditions = [
        eq(agents.companyId, companyId),
        eq(agents.kind, options?.kind ?? "org"),
      ];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const rows = await db.select().from(agents).where(and(...conditions));
      return rows.map(normalizeAgentRow);
    },

    getById,

    create: async (companyId: string, data: Omit<typeof agents.$inferInsert, "companyId">) => {
      // D7: Resolve parent fields from either parentType/parentId or reportsTo
      const parentType = (data.parentType ?? (data.reportsTo ? "agent" : null)) as EntityType | null;
      const parentId = data.parentId ?? data.reportsTo ?? null;

      // W6: human-at-top. An ORG agent with no parent auto-parents to the founder so
      // the chain always tops at a human. `kind` defaults to "org" at the DB but is
      // usually ABSENT from `data` (mirror list()'s `options?.kind ?? "org"`): only the
      // explicit non-org kinds (aoa crew, platform) are exempt.
      let resolvedParentType = parentType;
      let resolvedParentId = parentId;
      if (data.kind !== "aoa" && data.kind !== "platform" && !resolvedParentId) {
        const founderId = await orgHierarchy.getFounderUserId(companyId);
        if (!founderId) {
          throw unprocessable("Cannot create an org agent: no human founder exists for this company");
        }
        resolvedParentType = "user";
        resolvedParentId = founderId;
      }
      const resolvedReportsTo = resolvedParentType === "agent" ? resolvedParentId : null;

      // CXO parent constraint: CXOs cannot report to another agent.
      assertCxoParentConstraint(data.role, resolvedParentType);

      if (resolvedParentType && resolvedParentId) {
        await orgHierarchy.ensureParent(companyId, resolvedParentType, resolvedParentId);
        // Bug fix: assertNoCycle was missing from create() — add cycle detection
        // Note: for a new agent (no id yet), cycles are not possible since no
        // other node can point to it. But we validate the parent chain is not broken.
      }

      await assertCompanyShortnameAvailable(companyId, data.name);

      const role = data.role ?? "general";
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, role);
      const created = await db
        .insert(agents)
        .values({
          ...data,
          companyId,
          role,
          permissions: normalizedPermissions,
          parentType: resolvedParentType,
          parentId: resolvedParentId,
          reportsTo: resolvedReportsTo as string | null,
        })
        .returning()
        .then((rows) => rows[0]);

      return normalizeAgentRow(created);
    },

    update: updateAgent,

    pause: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot pause terminated agent");

      const updated = await db
        .update(agents)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    resume: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status === "terminated") throw conflict("Cannot resume terminated agent");
      if (existing.status === "pending_approval") {
        throw conflict("Pending approval agents cannot be resumed");
      }

      const updated = await db
        .update(agents)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated ? normalizeAgentRow(updated) : null;
    },

    terminate: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      await db.transaction(async (tx) => {
        // D4: Re-parent children (agents + users) before terminating
        await orgHierarchy.reparentChildren(existing.companyId, id, "agent", tx as unknown as Db);

        await tx
          .update(agents)
          .set({ status: "terminated", updatedAt: new Date() })
          .where(eq(agents.id, id));

        await tx
          .update(agentApiKeys)
          .set({ revokedAt: new Date() })
          .where(eq(agentApiKeys.agentId, id));
      });

      return getById(id);
    },

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      return db.transaction(async (tx) => {
        // Cross-type re-parenting: agents + users (replaces reportsTo-only orphaning)
        await orgHierarchy.reparentChildren(existing.companyId, id, "agent", tx as unknown as Db);
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
    },

    activatePendingApproval: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;
      if (existing.status !== "pending_approval") return existing;

      const updated = await db
        .update(agents)
        .set({ status: "idle", updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    updatePermissions: async (id: string, permissions: { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions(permissions, existing.role),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (id: string, name: string) => {
      const existing = await getById(id);
      if (!existing) throw notFound("Agent not found");
      if (existing.status === "pending_approval") {
        throw conflict("Cannot create keys for pending approval agents");
      }
      if (existing.status === "terminated") {
        throw conflict("Cannot create keys for terminated agents");
      }

      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db
        .insert(agentApiKeys)
        .values({
          agentId: id,
          companyId: existing.companyId,
          name,
          keyHash,
        })
        .returning()
        .then((rows) => rows[0]);

      return {
        id: created.id,
        name: created.name,
        token,
        createdAt: created.createdAt,
      };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id)),

    revokeKey: async (keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(agentApiKeys.id, keyId))
        .returning();
      return rows[0] ?? null;
    },

    getKeyById: async (keyId: string) => {
      const rows = await db
        .select({
          id: agentApiKeys.id,
          agentId: agentApiKeys.agentId,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.id, keyId))
        .limit(1);
      return rows[0] ?? null;
    },

    orgForCompany: async (companyId: string): Promise<UnifiedOrgNode[]> => {
      // Two parallel queries: agents + users
      const [agentRows, userRows] = await Promise.all([
        db
          .select()
          .from(agents)
          // Org chart excludes platform (Commander-team) agents.
          .where(and(eq(agents.companyId, companyId), eq(agents.kind, "org"), ne(agents.status, "terminated"))),
        db
          .select({
            userId: companyMemberships.principalId,
            email: authUsers.email,
            displayName: authUsers.displayName,
            avatarUrl: authUsers.avatarUrl,
            name: authUsers.name,
            parentType: companyMemberships.parentType,
            parentId: companyMemberships.parentId,
            role: userRoles.role,
            departmentId: userRoles.projectId,
            departmentName: projects.name,
          })
          .from(companyMemberships)
          .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
          .leftJoin(
            userRoles,
            and(eq(userRoles.companyId, companyId), eq(userRoles.userId, companyMemberships.principalId)),
          )
          .leftJoin(projects, eq(userRoles.projectId, projects.id))
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
            ),
          ),
      ]);

      // Deduplicate users by highest role (a user may have multiple user_roles rows)
      const userMap = new Map<
        string,
        {
          userId: string;
          email: string;
          displayName: string | null;
          avatarUrl: string | null;
          name: string;
          parentType: string | null;
          parentId: string | null;
          role: string | null;
          departmentId: string | null;
          departmentName: string | null;
        }
      >();
      for (const row of userRows) {
        const existing = userMap.get(row.userId);
        if (!existing || (USER_ROLE_PRIORITY[row.role ?? ""] ?? 0) > (USER_ROLE_PRIORITY[existing.role ?? ""] ?? 0)) {
          userMap.set(row.userId, row);
        }
      }

      // Build a parentKey → children map for the unified tree
      // Key format: "agent:<id>" or "user:<id>" or "root" for nodes without a parent
      type NodeEntry = { node: UnifiedOrgNode; parentKey: string };
      const entries: NodeEntry[] = [];
      const nodeById = new Map<string, UnifiedOrgNode>();

      // Convert agents to unified nodes
      for (const row of agentRows) {
        // Determine parent: prefer parentType/parentId, fallback to reportsTo
        let parentKey = "root";
        if (row.parentType && row.parentId) {
          parentKey = `${row.parentType}:${row.parentId}`;
        } else if (row.reportsTo) {
          parentKey = `agent:${row.reportsTo}`;
        }

        const node: UnifiedOrgNode = {
          id: row.id,
          name: row.name,
          role: row.role,
          status: row.status,
          nodeType: "agent",
          adapterType: row.adapterType,
          icon: row.icon ?? undefined,
          // Surface parentType so the org-tree UI can compute the apex
          // CXO (Chief of Staff) without a second fetch. Possible values:
          // "agent" | "user" | null.
          parentType: (row.parentType ?? null) as "agent" | "user" | null,
          children: [],
        };
        entries.push({ node, parentKey });
        nodeById.set(`agent:${row.id}`, node);
      }

      // Convert users to unified nodes
      for (const [userId, row] of userMap) {
        let parentKey = "root";
        if (row.parentType && row.parentId) {
          parentKey = `${row.parentType}:${row.parentId}`;
        }

        const node: UnifiedOrgNode = {
          id: userId,
          name: row.displayName ?? row.name,
          role: row.role ?? "team_member",
          status: "active",
          nodeType: "user",
          email: row.email,
          userRole: (row.role as UnifiedOrgNode["userRole"]) ?? "team_member",
          departmentName: row.departmentName ?? undefined,
          avatarUrl: row.avatarUrl ?? undefined,
          children: [],
        };
        entries.push({ node, parentKey });
        nodeById.set(`user:${userId}`, node);
      }

      // Assemble tree: attach children to parents
      const roots: UnifiedOrgNode[] = [];
      for (const { node, parentKey } of entries) {
        if (parentKey === "root") {
          roots.push(node);
        } else {
          const parent = nodeById.get(parentKey);
          if (parent) {
            parent.children.push(node);
          } else {
            // Parent not found (terminated/missing) → promote to root
            roots.push(node);
          }
        }
      }

      return roots;
    },

    getChainOfCommand: async (agentId: string, companyId?: string) => {
      const chain: { id: string; name: string; role: string; title: string | null; nodeType: "agent" | "user" }[] =
        [];
      const visited = new Set<string>([`agent:${agentId}`]);
      const start = await getById(agentId);
      if (!start) return chain;

      // Determine first parent: prefer parentType/parentId, fallback to reportsTo
      const startParentType = start.parentType === "agent" || start.parentType === "user" ? start.parentType : null;
      let currentType: "agent" | "user" = startParentType ?? "agent";
      let currentId: string | null = start.parentId ?? start.reportsTo ?? null;

      while (currentId && chain.length < 50) {
        const visitKey = `${currentType}:${currentId}`;
        if (visited.has(visitKey)) break;
        visited.add(visitKey);

        if (currentType === "agent") {
          const mgr = await getById(currentId);
          if (!mgr) break;
          chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: mgr.title ?? null, nodeType: "agent" });
          // Walk up: prefer parentType/parentId, fallback to reportsTo
          if (isValidParentType(mgr.parentType) && mgr.parentId) {
            currentType = mgr.parentType;
            currentId = mgr.parentId;
          } else {
            currentType = "agent";
            currentId = mgr.reportsTo ?? null;
          }
        } else {
          // User node — look up via company_memberships
          if (!companyId) break;
          const rows = await db
            .select({
              principalId: companyMemberships.principalId,
              parentType: companyMemberships.parentType,
              parentId: companyMemberships.parentId,
              displayName: authUsers.displayName,
              name: authUsers.name,
            })
            .from(companyMemberships)
            .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
            .where(
              and(
                eq(companyMemberships.companyId, companyId),
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.principalId, currentId),
                eq(companyMemberships.status, "active"),
              ),
            )
            .limit(1);
          const user = rows[0];
          if (!user) break;

          // Get user's highest role for display
          const roleRows = await db
            .select({ role: userRoles.role })
            .from(userRoles)
            .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, currentId)));
          let bestRole = "team_member";
          for (const r of roleRows) {
            if ((USER_ROLE_PRIORITY[r.role] ?? 0) > (USER_ROLE_PRIORITY[bestRole] ?? 0)) bestRole = r.role;
          }

          chain.push({
            id: user.principalId,
            name: user.displayName ?? user.name,
            role: bestRole,
            title: null,
            nodeType: "user",
          });

          // Walk up
          if (isValidParentType(user.parentType) && user.parentId) {
            currentType = user.parentType;
            currentId = user.parentId;
          } else {
            currentId = null;
          }
        }
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      // Platform (Commander-team) agents are not resolvable via user-facing URL keys.
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.kind, "org")));
      const matches = rows
        .map(normalizeAgentRow)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
  };
}
