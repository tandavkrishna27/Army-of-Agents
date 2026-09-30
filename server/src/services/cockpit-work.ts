import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { issues, type Db } from "@armyofagents/db";
import type {
  CockpitActiveWork,
  CockpitAwaitingReview,
  CockpitTaskBucket,
  CockpitTaskBucketResponse,
  CockpitTaskResponsibility,
  CockpitWorkTaskItem,
} from "@armyofagents/shared";
import {
  loadResponsibilityScope,
  responsibilityLabel,
  type ResponsibilityScope,
} from "./responsibility-scope.js";

const ACTIVE_EXCLUDED_STATUSES = ["done", "cancelled", "in_review"];
const DEFAULT_LIMITS: Record<CockpitTaskBucket, number> = {
  mine: 5,
  managed: 3,
  awaiting_review: 5,
};

interface WorkTaskRow {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeUserId: string | null;
  assigneeAgentId: string | null;
  responsibleUserId: string | null;
  reviewerUserId: string | null;
  dueDate: Date | null;
  updatedAt: Date;
  attentionRank: number;
  urgencyRank: number;
  priorityRank: number;
}

interface WorkCursor {
  attentionRank: number;
  urgencyRank: number;
  priorityRank: number;
  updatedAt: string;
  id: string;
}

function encodeCursor(row: WorkTaskRow) {
  const value: WorkCursor = {
    attentionRank: Number(row.attentionRank),
    urgencyRank: Number(row.urgencyRank),
    priorityRank: Number(row.priorityRank),
    updatedAt: row.updatedAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCockpitTaskCursor(cursor: string): WorkCursor | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<WorkCursor>;
    if (
      typeof value.attentionRank !== "number" ||
      typeof value.urgencyRank !== "number" ||
      typeof value.priorityRank !== "number" ||
      typeof value.updatedAt !== "string" ||
      Number.isNaN(new Date(value.updatedAt).getTime()) ||
      typeof value.id !== "string" ||
      value.id.length === 0
    ) return null;
    return value as WorkCursor;
  } catch {
    return null;
  }
}

export function classifyCockpitTask(
  row: Pick<WorkTaskRow, "status" | "assigneeUserId" | "assigneeAgentId" | "responsibleUserId" | "reviewerUserId">,
  userId: string,
  scope: Pick<ResponsibilityScope, "userIds" | "agentIds">,
): CockpitTaskBucket | null {
  const mine = row.assigneeUserId === userId || row.responsibleUserId === userId;
  const managed =
    (!mine && Boolean(row.assigneeUserId && scope.userIds.includes(row.assigneeUserId))) ||
    (!mine && Boolean(row.assigneeAgentId && scope.agentIds.includes(row.assigneeAgentId)));

  if (row.status === "in_review") {
    return row.reviewerUserId === userId || mine || managed ? "awaiting_review" : null;
  }
  if (row.status === "done" || row.status === "cancelled") return null;
  if (mine) return "mine";
  if (managed) return "managed";
  return null;
}

function managedPredicate(scope: ResponsibilityScope): SQL {
  const predicates: SQL[] = [];
  if (scope.userIds.length > 0) {
    predicates.push(inArray(issues.assigneeUserId, scope.userIds));
  }
  if (scope.agentIds.length > 0) {
    predicates.push(inArray(issues.assigneeAgentId, scope.agentIds));
  }
  if (predicates.length === 0) return sql`false`;
  return predicates.length === 1 ? predicates[0]! : or(...predicates)!;
}

function minePredicate(userId: string): SQL {
  return sql`(
    COALESCE(${issues.assigneeUserId} = ${userId}, false)
    OR COALESCE(${issues.responsibleUserId} = ${userId}, false)
  )`;
}

function bucketPredicate(
  bucket: CockpitTaskBucket,
  userId: string,
  scope: ResponsibilityScope,
): SQL {
  const mine = minePredicate(userId);
  const managed = managedPredicate(scope);
  const companyVisible = isNull(issues.hiddenAt);

  if (bucket === "mine") {
    return and(
      companyVisible,
      not(inArray(issues.status, ACTIVE_EXCLUDED_STATUSES)),
      mine,
    )!;
  }

  if (bucket === "managed") {
    return and(
      companyVisible,
      not(inArray(issues.status, ACTIVE_EXCLUDED_STATUSES)),
      managed,
      not(mine),
    )!;
  }

  return and(
    companyVisible,
    eq(issues.status, "in_review"),
    or(eq(issues.reviewerUserId, userId), mine, managed),
  )!;
}

const priorityOrder = sql<number>`CASE ${issues.priority}
  WHEN 'critical' THEN 0
  WHEN 'high' THEN 1
  WHEN 'medium' THEN 2
  WHEN 'low' THEN 3
  ELSE 4
END`;

const urgencyOrder = sql<number>`CASE
  WHEN ${issues.status} = 'blocked' THEN 0
  WHEN ${issues.dueDate} IS NOT NULL AND ${issues.dueDate} < NOW() THEN 1
  WHEN ${issues.dueDate} IS NOT NULL AND ${issues.dueDate} < date_trunc('day', NOW()) + interval '1 day' THEN 2
  ELSE 3
END`;

function attentionOrder(bucket: CockpitTaskBucket, userId: string) {
  // A bare `0` becomes `ORDER BY 0`, which PostgreSQL parses as an invalid
  // positional reference. Keep the constant rank as a real SQL expression.
  if (bucket !== "awaiting_review") {
    return sql<number>`CASE WHEN ${issues.id} IS NOT NULL THEN 0 ELSE 0 END`;
  }
  return sql<number>`CASE WHEN ${issues.reviewerUserId} = ${userId} THEN 0 ELSE 1 END`;
}

const taskSelection = {
  id: issues.id,
  identifier: issues.identifier,
  title: issues.title,
  status: issues.status,
  priority: issues.priority,
  assigneeUserId: issues.assigneeUserId,
  assigneeAgentId: issues.assigneeAgentId,
  responsibleUserId: issues.responsibleUserId,
  reviewerUserId: issues.reviewerUserId,
  dueDate: issues.dueDate,
  updatedAt: issues.updatedAt,
  urgencyRank: urgencyOrder,
  priorityRank: priorityOrder,
};

function taskResponsibility(
  bucket: CockpitTaskBucket,
  row: WorkTaskRow,
  userId: string,
  scope: ResponsibilityScope,
): CockpitTaskResponsibility {
  if (bucket === "awaiting_review" && row.reviewerUserId === userId) {
    return {
      reason: "your_review",
      entityType: "user",
      entityId: userId,
      label: "Your review",
    };
  }

  if (bucket === "mine") {
    if (row.assigneeUserId === userId) {
      return {
        reason: "assigned_to_you",
        entityType: "user",
        entityId: userId,
        label: "Assigned to you",
      };
    }
    return {
      reason: "you_are_responsible",
      entityType: "user",
      entityId: userId,
      label: "You are responsible",
    };
  }

  if (row.assigneeUserId && scope.userIds.includes(row.assigneeUserId)) {
    return {
      reason: bucket === "awaiting_review" ? "team_review" : "managed_human",
      entityType: "user",
      entityId: row.assigneeUserId,
      label: bucket === "awaiting_review"
        ? "Team review"
        : `Managed: ${responsibilityLabel(scope, "user", row.assigneeUserId)}`,
    };
  }

  if (row.assigneeAgentId && scope.agentIds.includes(row.assigneeAgentId)) {
    return {
      reason: bucket === "awaiting_review" ? "team_review" : "managed_agent",
      entityType: "agent",
      entityId: row.assigneeAgentId,
      label: bucket === "awaiting_review"
        ? "Team review"
        : `Managed: ${responsibilityLabel(scope, "agent", row.assigneeAgentId)}`,
    };
  }

  return {
    reason: bucket === "awaiting_review" ? "team_review" : "you_are_responsible",
    entityType: "user",
    entityId: userId,
    label: bucket === "awaiting_review" ? "Team review" : "You are responsible",
  };
}

function toTaskItem(
  bucket: CockpitTaskBucket,
  row: WorkTaskRow,
  userId: string,
  scope: ResponsibilityScope,
): CockpitWorkTaskItem {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeUserId: row.assigneeUserId,
    assigneeAgentId: row.assigneeAgentId,
    responsibleUserId: row.responsibleUserId,
    reviewerUserId: row.reviewerUserId,
    dueDate: row.dueDate?.toISOString() ?? null,
    responsibility: taskResponsibility(bucket, row, userId, scope),
  };
}

async function queryBucket(
  db: Db,
  companyId: string,
  userId: string,
  scope: ResponsibilityScope,
  bucket: CockpitTaskBucket,
  limit = DEFAULT_LIMITS[bucket],
  cursor?: string,
): Promise<CockpitTaskBucketResponse> {
  const baseWhere = and(
    eq(issues.companyId, companyId),
    bucketPredicate(bucket, userId, scope),
  )!;
  const parsedCursor = cursor ? decodeCockpitTaskCursor(cursor) : null;
  const attention = attentionOrder(bucket, userId);
  const cursorWhere = parsedCursor
    ? sql`(
        ${attention} > ${parsedCursor.attentionRank}
        OR (${attention} = ${parsedCursor.attentionRank} AND ${urgencyOrder} > ${parsedCursor.urgencyRank})
        OR (${attention} = ${parsedCursor.attentionRank} AND ${urgencyOrder} = ${parsedCursor.urgencyRank}
          AND ${priorityOrder} > ${parsedCursor.priorityRank})
        OR (${attention} = ${parsedCursor.attentionRank} AND ${urgencyOrder} = ${parsedCursor.urgencyRank}
          AND ${priorityOrder} = ${parsedCursor.priorityRank}
          AND ${issues.updatedAt} < ${new Date(parsedCursor.updatedAt)})
        OR (${attention} = ${parsedCursor.attentionRank} AND ${urgencyOrder} = ${parsedCursor.urgencyRank}
          AND ${priorityOrder} = ${parsedCursor.priorityRank}
          AND ${issues.updatedAt} = ${new Date(parsedCursor.updatedAt)} AND ${issues.id} > ${parsedCursor.id})
      )`
    : undefined;
  const where = cursorWhere ? and(baseWhere, cursorWhere)! : baseWhere;

  const [rows, totalRows] = await Promise.all([
    db
      .select({ ...taskSelection, attentionRank: attention })
      .from(issues)
      .where(where)
      .orderBy(asc(attention), asc(urgencyOrder), asc(priorityOrder), desc(issues.updatedAt), asc(issues.id))
      .limit(limit + 1),
    db.select({ total: count() }).from(issues).where(baseWhere),
  ]);

  const typedRows = rows as WorkTaskRow[];
  const hasMore = typedRows.length > limit;
  const visibleRows = hasMore ? typedRows.slice(0, limit) : typedRows;

  return {
    items: visibleRows.map((row) => toTaskItem(bucket, row, userId, scope)),
    total: Number(totalRows[0]?.total ?? 0),
    nextCursor: hasMore && visibleRows.length > 0 ? encodeCursor(visibleRows[visibleRows.length - 1]!) : null,
  };
}

export function cockpitWorkService(db: Db) {
  return {
    async loadScope(companyId: string, userId: string) {
      return loadResponsibilityScope(db, companyId, userId);
    },

    async summary(
      companyId: string,
      userId: string,
      scope?: ResponsibilityScope,
    ): Promise<{ activeWork: CockpitActiveWork; awaitingReview: CockpitAwaitingReview }> {
      const resolvedScope = scope ?? await loadResponsibilityScope(db, companyId, userId);
      const [mine, managed, awaitingReview] = await Promise.all([
        queryBucket(db, companyId, userId, resolvedScope, "mine"),
        queryBucket(db, companyId, userId, resolvedScope, "managed"),
        queryBucket(db, companyId, userId, resolvedScope, "awaiting_review"),
      ]);

      return {
        activeWork: { mine, managed },
        awaitingReview: { items: awaitingReview.items, total: awaitingReview.total },
      };
    },

    async listBucket(
      companyId: string,
      userId: string,
      bucket: CockpitTaskBucket,
      limit?: number,
      cursor?: string,
      scope?: ResponsibilityScope,
    ) {
      const resolvedScope = scope ?? await loadResponsibilityScope(db, companyId, userId);
      return queryBucket(db, companyId, userId, resolvedScope, bucket, limit, cursor);
    },
  };
}
