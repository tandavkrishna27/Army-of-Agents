// server/src/routes/agents-live-runs.ts
//
// Thread chat experience Phase 5 — Task 5.5 (kanban "Live" pill sees crew).
//
// The kanban / Crew Board light a "Live" pill from `liveRunsForCompany` /
// `liveRunsForIssue`. Both ONLY queried `heartbeat_runs` — so a CREW
// (internal_agent) run executing a task was invisible: the card never showed
// live, even while a crew agent worked it. These helpers UNION the crew runs in.
//
// Crew filter (R5): `internal_agent_runs.status = 'running'` AND
// `related_entity_type = 'task'`. The runs table has NO `startedAt` — `createdAt`
// is the elapsed anchor (surfaced as `startedAt` so the UI's elapsed math is
// uniform across both sources). `related_entity_id` is the issue id.
//
// Extracted from the inline route closures so the UNION is unit-testable with a
// mocked db (the repo's "pure function, test directly" pattern) — the routes in
// agents.ts call straight through.

import type { Db } from "@armyofagents/db";
import { agents as agentsTable, heartbeatRuns, internalAgentRuns } from "@armyofagents/db";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";

/** Active heartbeat-run statuses surfaced as "live". */
const LIVE_HEARTBEAT_STATUSES = ["queued", "running"] as const;

/** A crew (internal_agent) live run, shaped to merge with heartbeat live rows. */
export interface CrewLiveRun {
  id: string;
  status: string;
  agentId: string | null;
  agentName: string | null;
  issueId: string | null;
  // R5: internal_agent_runs has no startedAt — createdAt is the elapsed anchor,
  // surfaced under both keys so the UI's elapsed math is source-agnostic.
  startedAt: Date | null;
  createdAt: Date | null;
  // Discriminator so the UI/consumers can tell a crew row from a heartbeat row.
  source: "internal_agent";
}

/**
 * Crew (internal_agent) runs currently executing a TASK for a company.
 * status='running' AND related_entity_type='task' (R5). agentName resolved via
 * a LEFT JOIN to agents (agentId is nullable — onDelete set null).
 */
export async function crewLiveRunsForCompany(db: Db, companyId: string): Promise<CrewLiveRun[]> {
  const rows = await db
    .select({
      id: internalAgentRuns.id,
      status: internalAgentRuns.status,
      agentId: internalAgentRuns.agentId,
      agentName: agentsTable.name,
      issueId: internalAgentRuns.relatedEntityId,
      startedAt: internalAgentRuns.createdAt,
      createdAt: internalAgentRuns.createdAt,
    })
    .from(internalAgentRuns)
    .leftJoin(agentsTable, eq(internalAgentRuns.agentId, agentsTable.id))
    .where(
      and(
        eq(internalAgentRuns.companyId, companyId),
        eq(internalAgentRuns.status, "running"),
        eq(internalAgentRuns.relatedEntityType, "task"),
      ),
    )
    .orderBy(desc(internalAgentRuns.createdAt));

  return rows.map((r) => ({ ...r, source: "internal_agent" as const }));
}

/**
 * Crew runs executing a SPECIFIC issue (related_entity_id = issueId). Same crew
 * filter as the company helper, scoped to the one task.
 */
export async function crewLiveRunsForIssue(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<CrewLiveRun[]> {
  const rows = await db
    .select({
      id: internalAgentRuns.id,
      status: internalAgentRuns.status,
      agentId: internalAgentRuns.agentId,
      agentName: agentsTable.name,
      issueId: internalAgentRuns.relatedEntityId,
      startedAt: internalAgentRuns.createdAt,
      createdAt: internalAgentRuns.createdAt,
    })
    .from(internalAgentRuns)
    .leftJoin(agentsTable, eq(internalAgentRuns.agentId, agentsTable.id))
    .where(
      and(
        eq(internalAgentRuns.companyId, companyId),
        eq(internalAgentRuns.status, "running"),
        eq(internalAgentRuns.relatedEntityType, "task"),
        eq(internalAgentRuns.relatedEntityId, issueId),
      ),
    )
    .orderBy(desc(internalAgentRuns.createdAt));

  return rows.map((r) => ({ ...r, source: "internal_agent" as const }));
}

/**
 * Heartbeat live-run column set (mirrors the inline route projection). Exposed so
 * the route helper and tests build the same shape. The `issueId` is dug out of
 * the JSON contextSnapshot.
 */
export function heartbeatLiveRunColumns() {
  return {
    id: heartbeatRuns.id,
    status: heartbeatRuns.status,
    invocationSource: heartbeatRuns.invocationSource,
    triggerDetail: heartbeatRuns.triggerDetail,
    startedAt: heartbeatRuns.startedAt,
    finishedAt: heartbeatRuns.finishedAt,
    createdAt: heartbeatRuns.createdAt,
    logStore: heartbeatRuns.logStore,
    logRef: heartbeatRuns.logRef,
    processPid: heartbeatRuns.processPid,
    processStartedAt: heartbeatRuns.processStartedAt,
    lastOutputAt: heartbeatRuns.lastOutputAt,
    agentId: heartbeatRuns.agentId,
    agentName: agentsTable.name,
    adapterType: agentsTable.adapterType,
    issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
  };
}

/**
 * Active heartbeat live runs for a company (queued|running), joined to agents.
 * Equivalent to the pre-Task-5.5 inline query; factored out so the company
 * helper can UNION the crew rows onto it.
 */
export async function heartbeatLiveRunsForCompany(db: Db, companyId: string) {
  return db
    .select(heartbeatLiveRunColumns())
    .from(heartbeatRuns)
    .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_STATUSES]),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt));
}

/** Recent (terminal) heartbeat runs to backfill toward `minCount` (unchanged behaviour). */
export async function recentHeartbeatRunsForCompany(
  db: Db,
  companyId: string,
  excludeIds: string[],
  limit: number,
) {
  return db
    .select(heartbeatLiveRunColumns())
    .from(heartbeatRuns)
    .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        not(inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_STATUSES])),
        ...(excludeIds.length > 0 ? [not(inArray(heartbeatRuns.id, excludeIds))] : []),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(limit);
}

/**
 * Task 5.5: the merged company live-runs list — heartbeat live rows PLUS crew
 * (internal_agent) live rows. The `minCount` backfill (terminal heartbeat rows)
 * is preserved and applies to the heartbeat set only (crew runs are always live,
 * never backfilled). Crew rows are appended after the heartbeat rows.
 */
export async function liveRunsForCompany(
  db: Db,
  companyId: string,
  opts: { minCount?: number } = {},
): Promise<unknown[]> {
  const minCount = opts.minCount ?? 0;
  const [heartbeatLive, crew] = await Promise.all([
    heartbeatLiveRunsForCompany(db, companyId),
    crewLiveRunsForCompany(db, companyId),
  ]);

  let heartbeatRows: unknown[] = heartbeatLive;
  if (minCount > 0 && heartbeatLive.length < minCount) {
    const activeIds = heartbeatLive.map((r) => r.id);
    const recent = await recentHeartbeatRunsForCompany(
      db,
      companyId,
      activeIds,
      minCount - heartbeatLive.length,
    );
    heartbeatRows = [...heartbeatLive, ...recent];
  }

  return [...heartbeatRows, ...crew];
}

/** Task 5.5: merged issue live-runs — heartbeat live rows PLUS crew live rows for one issue. */
export async function liveRunsForIssue(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<unknown[]> {
  const [heartbeatLive, crew] = await Promise.all([
    db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        logStore: heartbeatRuns.logStore,
        logRef: heartbeatRuns.logRef,
        processPid: heartbeatRuns.processPid,
        processStartedAt: heartbeatRuns.processStartedAt,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        adapterType: agentsTable.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_STATUSES]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt)),
    crewLiveRunsForIssue(db, companyId, issueId),
  ]);

  return [...heartbeatLive, ...crew];
}
