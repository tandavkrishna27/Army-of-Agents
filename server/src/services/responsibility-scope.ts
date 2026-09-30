import { and, eq, ne } from "drizzle-orm";
import {
  agents,
  authUsers,
  companyMemberships,
  type Db,
} from "@armyofagents/db";

export type ResponsibilityEntityType = "user" | "agent";

export interface ResponsibilityEntity {
  type: ResponsibilityEntityType;
  id: string;
  label: string;
  parentType: ResponsibilityEntityType | null;
  parentId: string | null;
}

export interface ResponsibilityScope {
  userIds: string[];
  agentIds: string[];
  labels: Record<string, string>;
  truncated: boolean;
}

const MAX_HIERARCHY_DEPTH = 64;

function entityKey(type: ResponsibilityEntityType, id: string) {
  return `${type}:${id}`;
}

function validEntityType(value: string | null): ResponsibilityEntityType | null {
  return value === "user" || value === "agent" ? value : null;
}

export function buildResponsibilityScope(
  rootUserId: string,
  entities: ResponsibilityEntity[],
  maxDepth = MAX_HIERARCHY_DEPTH,
): ResponsibilityScope {
  const children = new Map<string, ResponsibilityEntity[]>();
  const labels: Record<string, string> = {};

  for (const entity of entities) {
    labels[entityKey(entity.type, entity.id)] = entity.label;
    if (!entity.parentType || !entity.parentId) continue;
    const parentKey = entityKey(entity.parentType, entity.parentId);
    const bucket = children.get(parentKey) ?? [];
    bucket.push(entity);
    children.set(parentKey, bucket);
  }

  const rootKey = entityKey("user", rootUserId);
  const visited = new Set<string>([rootKey]);
  const userIds = new Set<string>();
  const agentIds = new Set<string>();
  const queue: Array<{ key: string; depth: number }> = [{ key: rootKey, depth: 0 }];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const directChildren = children.get(current.key) ?? [];
    if (current.depth >= maxDepth && directChildren.length > 0) {
      truncated = true;
      continue;
    }

    for (const child of directChildren) {
      const key = entityKey(child.type, child.id);
      if (visited.has(key)) continue;
      visited.add(key);
      if (child.type === "user") userIds.add(child.id);
      else agentIds.add(child.id);
      queue.push({ key, depth: current.depth + 1 });
    }
  }

  return {
    userIds: [...userIds].sort(),
    agentIds: [...agentIds].sort(),
    labels,
    truncated,
  };
}

export async function loadResponsibilityScope(
  db: Db,
  companyId: string,
  rootUserId: string,
): Promise<ResponsibilityScope> {
  const [humanRows, agentRows] = await Promise.all([
    db
      .select({
        id: companyMemberships.principalId,
        displayName: authUsers.displayName,
        email: authUsers.email,
        parentType: companyMemberships.parentType,
        parentId: companyMemberships.parentId,
      })
      .from(companyMemberships)
      .leftJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      ),
    db
      .select({
        id: agents.id,
        name: agents.name,
        parentType: agents.parentType,
        parentId: agents.parentId,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated"))),
  ]);

  const entities: ResponsibilityEntity[] = [
    ...humanRows.map((row) => ({
      type: "user" as const,
      id: row.id,
      label: row.displayName?.trim() || row.email?.trim() || row.id,
      parentType: validEntityType(row.parentType),
      parentId: row.parentId ?? null,
    })),
    ...agentRows.map((row) => {
      const parentType = validEntityType(row.parentType) ?? (row.reportsTo ? "agent" : null);
      return {
        type: "agent" as const,
        id: row.id,
        label: row.name,
        parentType,
        parentId: row.parentId ?? row.reportsTo ?? null,
      };
    }),
  ];

  return buildResponsibilityScope(rootUserId, entities);
}

export function responsibilityLabel(
  scope: ResponsibilityScope,
  type: ResponsibilityEntityType,
  id: string,
) {
  return scope.labels[entityKey(type, id)] ?? id;
}
