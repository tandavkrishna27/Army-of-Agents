import { and, asc, eq, gt, gte, isNotNull, or } from "drizzle-orm";
import { routineTriggers, routines, type Db } from "@armyofagents/db";
import {
  universeAttentionResponseSchema,
  type UniverseAttentionEntry,
  type UniverseAttentionResponse,
  type UserRole,
} from "@armyofagents/shared";
import { hubItemsService } from "./hub-items.js";
import { unprocessable } from "../errors.js";

const CATEGORY_LIMIT = 16;
const READY_TYPES = new Set(["run_complete", "routine_outcome"]);
const PRIORITY: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

type HubQuery = ReturnType<typeof hubItemsService>["query"];
type HubResult = Awaited<ReturnType<HubQuery>>;
type ScheduledRoutine = {
  routineId: string;
  triggerId: string;
  title: string;
  nextRunAt: Date;
  updatedAt: Date;
};

export interface UniverseAttentionProjectionDeps {
  queryHub?: HubQuery;
  queryRoutines?: (
    companyId: string,
    now: Date,
    limit: number,
    cursor: { nextRunAt: Date; triggerId: string } | null,
  ) => Promise<ScheduledRoutine[]>;
  now?: () => Date;
}

type ProjectionCursor = {
  needsYou: string | null;
  ready: string | null;
  comingUp: { nextRunAt: string; triggerId: string } | null;
};

function decodeProjectionCursor(value?: string): ProjectionCursor {
  if (!value) return { needsYou: null, ready: null, comingUp: null };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ProjectionCursor>;
    const comingUp = parsed.comingUp;
    if ((parsed.needsYou != null && typeof parsed.needsYou !== "string")
      || (parsed.ready != null && typeof parsed.ready !== "string")
      || (comingUp != null && (typeof comingUp.nextRunAt !== "string" || typeof comingUp.triggerId !== "string"))) {
      throw new Error("invalid cursor");
    }
    if (comingUp && Number.isNaN(new Date(comingUp.nextRunAt).getTime())) throw new Error("invalid date");
    return { needsYou: parsed.needsYou ?? null, ready: parsed.ready ?? null, comingUp: comingUp ?? null };
  } catch {
    throw unprocessable("Invalid Universe attention cursor");
  }
}

function sourceRef(sourceType: string | null, sourceId: string | null) {
  const id = sourceId || "unknown";
  if (sourceType === "issue") return { kind: "task" as const, id };
  if (sourceType === "approval") return { kind: "approval" as const, id };
  if (sourceType === "work_question") return { kind: "work_question" as const, id };
  if (sourceType === "runtime_decision") return { kind: "runtime_decision" as const, id };
  if (sourceType === "routine" || sourceType === "routine_run") return { kind: "routine" as const, id };
  return { kind: "hub" as const, id };
}

function hubEntry(item: HubResult["items"][number]): UniverseAttentionEntry {
  const sourceId = item.sourceId || item.id;
  return {
    id: item.id,
    kind: "hub",
    sourceId,
    title: item.title.slice(0, 500),
    summary: item.summary?.slice(0, 4_000) ?? null,
    version: Math.max(0, item.version),
    sourceRef: sourceRef(item.sourceType, sourceId),
    stale: false,
  };
}

function sortHub(items: HubResult["items"]): HubResult["items"] {
  return [...items].sort((left, right) =>
    (PRIORITY[left.priority] ?? 2) - (PRIORITY[right.priority] ?? 2)
    || right.createdAt.getTime() - left.createdAt.getTime()
    || right.id.localeCompare(left.id));
}

export function universeAttentionProjectionService(db: Db, deps: UniverseAttentionProjectionDeps = {}) {
  const queryHub = deps.queryHub ?? hubItemsService(db).query;
  const queryRoutines = deps.queryRoutines ?? (async (companyId, now, limit, cursor) => {
    const rows = await db.select({
      routineId: routines.id,
      triggerId: routineTriggers.id,
      title: routines.title,
      nextRunAt: routineTriggers.nextRunAt,
      updatedAt: routineTriggers.updatedAt,
    }).from(routineTriggers)
      .innerJoin(routines, eq(routines.id, routineTriggers.routineId))
      .where(and(
        eq(routineTriggers.companyId, companyId),
        eq(routineTriggers.enabled, true),
        eq(routines.status, "active"),
        isNotNull(routineTriggers.nextRunAt),
        gte(routineTriggers.nextRunAt, now),
        cursor ? or(
          gt(routineTriggers.nextRunAt, cursor.nextRunAt),
          and(eq(routineTriggers.nextRunAt, cursor.nextRunAt), gt(routineTriggers.id, cursor.triggerId)),
        ) : undefined,
      ))
      .orderBy(asc(routineTriggers.nextRunAt), asc(routineTriggers.id))
      .limit(limit);
    return rows.filter((row): row is ScheduledRoutine => row.nextRunAt !== null);
  });

  async function get(input: { companyId: string; actorUserId: string; role: UserRole; cursor?: string }): Promise<UniverseAttentionResponse> {
    const now = deps.now?.() ?? new Date();
    const cursor = decodeProjectionCursor(input.cursor);
    const [waiting, notifications, scheduled] = await Promise.all([
      queryHub(input.companyId, { actorUserId: input.actorUserId, role: input.role, lane: "waiting_on_you", cursor: cursor.needsYou ?? undefined, limit: CATEGORY_LIMIT }),
      queryHub(input.companyId, { actorUserId: input.actorUserId, role: input.role, lane: "notifications", cursor: cursor.ready ?? undefined, limit: 50 }),
      queryRoutines(input.companyId, now, CATEGORY_LIMIT + 1, cursor.comingUp ? { nextRunAt: new Date(cursor.comingUp.nextRunAt), triggerId: cursor.comingUp.triggerId } : null),
    ]);

    const needsYou = sortHub(waiting.items).slice(0, CATEGORY_LIMIT).map(hubEntry);
    const readyRows = notifications.items.filter((item) => READY_TYPES.has(item.semanticType ?? ""));
    const ready = sortHub(readyRows).slice(0, CATEGORY_LIMIT).map(hubEntry);
    const comingUpRows = scheduled.slice(0, CATEGORY_LIMIT);
    const comingUp = comingUpRows.map((row): UniverseAttentionEntry => ({
      id: `routine:${row.routineId}:${row.triggerId}`,
      kind: "routine",
      sourceId: row.routineId,
      title: row.title.slice(0, 500),
      summary: `Scheduled ${row.nextRunAt.toISOString()}`,
      version: Math.max(0, row.updatedAt.getTime()),
      sourceRef: { kind: "routine", id: row.routineId },
      stale: false,
    }));

    const cursors = {
      needsYou: waiting.nextCursor,
      ready: notifications.nextCursor,
      comingUp: scheduled.length > CATEGORY_LIMIT && comingUpRows.length > 0
        ? { nextRunAt: comingUpRows.at(-1)!.nextRunAt.toISOString(), triggerId: comingUpRows.at(-1)!.triggerId }
        : null,
    };
    const nextCursor = Object.values(cursors).some(Boolean)
      ? Buffer.from(JSON.stringify(cursors), "utf8").toString("base64url")
      : null;
    return universeAttentionResponseSchema.parse({ asOf: now.toISOString(), needsYou, ready, comingUp, nextCursor });
  }

  return { get };
}
