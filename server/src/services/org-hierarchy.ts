import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, companyMemberships, userRoles } from "@armyofagents/db";
import { notFound, unprocessable } from "../errors.js";

/**
 * Maximum depth for chain walking in cycle detection.
 * Prevents infinite loops on corrupted data.
 */
const MAX_CHAIN_DEPTH = 50;

export type EntityType = "agent" | "user";

/**
 * Shared org-hierarchy helpers used by both agentService and teamService.
 */
export function orgHierarchyService(db: Db) {
  /**
   * Walk the mixed agent/user parent chain starting from newParentId
   * and throw if we encounter entityId (which would create a cycle).
   *
   * - null parent → root node, no cycle possible
   * - self-reference → immediate rejection
   * - depth ≥ 50 → stop walking (no throw, prevents infinite loop on corrupt data)
   */
  async function assertNoCycle(
    companyId: string,
    entityId: string,
    entityType: EntityType,
    newParentId: string | null,
    newParentType: EntityType | null,
  ): Promise<void> {
    if (!newParentId || !newParentType) return;

    if (entityId === newParentId && entityType === newParentType) {
      throw unprocessable("Cannot set an entity as its own parent");
    }

    let currentId: string | null = newParentId;
    let currentType: EntityType | null = newParentType;
    let depth = 0;

    while (currentId && currentType && depth < MAX_CHAIN_DEPTH) {
      if (currentId === entityId && currentType === entityType) {
        throw unprocessable(
          `Cannot set parent: would create a circular reporting chain (depth ${depth})`,
        );
      }

      if (currentType === "agent") {
        const rows = await db
          .select({ parentType: agents.parentType, parentId: agents.parentId })
          .from(agents)
          .where(eq(agents.id, currentId))
          .limit(1);
        const row = rows[0];
        if (!row || !row.parentId) break;
        currentType = row.parentType as EntityType | null;
        currentId = row.parentId as string | null;
      } else {
        const rows = await db
          .select({
            parentType: companyMemberships.parentType,
            parentId: companyMemberships.parentId,
          })
          .from(companyMemberships)
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, currentId),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row || !row.parentId) break;
        currentType = row.parentType as EntityType | null;
        currentId = row.parentId as string | null;
      }

      depth++;
    }
  }

  /**
   * Validate that parentId refers to a valid, active entity in the same company.
   *
   * - agent parent: must exist in same company, not terminated
   * - user parent:  must have an active company_memberships row
   */
  async function ensureParent(
    companyId: string,
    parentType: EntityType,
    parentId: string,
  ): Promise<void> {
    if (parentType === "agent") {
      const rows = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, parentId), eq(agents.companyId, companyId)))
        .limit(1);
      if (!rows[0]) throw notFound("Parent agent not found in this company");
      if (rows[0].status === "terminated") {
        throw unprocessable("Cannot report to a terminated agent");
      }
    } else {
      const rows = await db
        .select({ principalId: companyMemberships.principalId })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, parentId),
            eq(companyMemberships.status, "active"),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        throw unprocessable(
          "Parent user not found or not active in this company",
        );
      }
    }
  }

  /**
   * Re-parent all children of a removed entity up to the removed entity's own
   * parent (fallback: the company founder). Preserves human-at-top instead of
   * nulling pointers to root.
   */
  async function reparentChildren(
    companyId: string,
    entityId: string,
    entityType: EntityType,
    txOrDb: Db = db,
  ): Promise<void> {
    // The removed entity's own parent.
    let newParentType: EntityType | null = null;
    let newParentId: string | null = null;
    if (entityType === "agent") {
      const row = await txOrDb
        .select({ parentType: agents.parentType, parentId: agents.parentId })
        .from(agents).where(eq(agents.id, entityId)).limit(1).then((r) => r[0]);
      newParentType = (row?.parentType as EntityType | null) ?? null;
      newParentId = (row?.parentId as string | null) ?? null;
    } else {
      const row = await txOrDb
        .select({ parentType: companyMemberships.parentType, parentId: companyMemberships.parentId })
        .from(companyMemberships)
        .where(and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, entityId),
        ))
        .limit(1).then((r) => r[0]);
      newParentType = (row?.parentType as EntityType | null) ?? null;
      newParentId = (row?.parentId as string | null) ?? null;
    }
    // Fallback to founder so children never become rootless agents.
    if (!newParentId) {
      const founderId = await getFounderUserId(companyId);
      if (founderId) { newParentType = "user"; newParentId = founderId; }
    }

    // Re-parent child AGENTS (reportsTo follows only for agent parents).
    const agentSet = entityType === "agent"
      ? { parentType: newParentType, parentId: newParentId, reportsTo: newParentType === "agent" ? newParentId : null, updatedAt: new Date() }
      : { parentType: newParentType, parentId: newParentId, updatedAt: new Date() };
    await txOrDb.update(agents).set(agentSet as never)
      .where(and(eq(agents.parentType, entityType), eq(agents.parentId, entityId)));

    // Re-parent child USERS (memberships).
    await txOrDb.update(companyMemberships)
      .set({ parentType: newParentType, parentId: newParentId, updatedAt: new Date() })
      .where(and(eq(companyMemberships.parentType, entityType), eq(companyMemberships.parentId, entityId)));
  }

  /** Founder user_role, else the owner-role company_membership principal (always exists). */
  async function getFounderUserId(companyId: string): Promise<string | null> {
    const founder = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.companyId, companyId), eq(userRoles.role, "founder")))
      .limit(1)
      .then((r) => r[0]?.userId ?? null);
    if (founder) return founder;
    return await db
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.membershipRole, "owner"),
        eq(companyMemberships.status, "active"),
      ))
      .limit(1)
      .then((r) => r[0]?.principalId ?? null);
  }

  /** Walk parentType/parentId from (startType,startId) to the first human ancestor; null if none / depth-capped. */
  async function getFirstHumanAncestor(
    companyId: string,
    startType: EntityType,
    startId: string,
  ): Promise<string | null> {
    let currentType: EntityType | null = startType;
    let currentId: string | null = startId;
    let depth = 0;
    while (currentType && currentId && depth < MAX_CHAIN_DEPTH) {
      if (currentType === "user") return currentId;
      const row = await db
        .select({ parentType: agents.parentType, parentId: agents.parentId })
        .from(agents).where(eq(agents.id, currentId)).limit(1).then((r) => r[0]);
      if (!row || !row.parentId) return null;
      currentType = row.parentType as EntityType | null;
      currentId = row.parentId as string | null;
      depth++;
    }
    return null;
  }

  return { assertNoCycle, ensureParent, reparentChildren, getFounderUserId, getFirstHumanAncestor };
}
