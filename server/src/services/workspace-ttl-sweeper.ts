import { and, eq, isNotNull, isNull, lt, ne } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { executionWorkspaces, projects } from "@armyofagents/db";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { logger } from "../middleware/logger.js";

export interface WorkspaceTtlSweepResult {
  scanned: number;
  marked: number;
  blocked: number;
  skipped: number;
}

/**
 * Default fallback TTL applied to *thread*-scoped workspaces whose project has
 * no explicit `ttlDays` policy. Thread workspaces are short-lived by nature —
 * once the thread advances past discuss/scope, the workspace is idle — so a
 * sane default prevents accumulation in projects whose founders never
 * configured a workspace TTL.
 */
export const DEFAULT_THREAD_WORKSPACE_TTL_DAYS = 7;

export async function sweepExpiredWorkspaces(db: Db): Promise<WorkspaceTtlSweepResult> {
  const experimental = await instanceSettingsService(db).getExperimental();
  if (!experimental.enableWorkspaceTtlSweeper) {
    return { scanned: 0, marked: 0, blocked: 0, skipped: 0 };
  }

  const svc = executionWorkspaceService(db);
  const projectRows = await db
    .select({
      id: projects.id,
      executionWorkspacePolicy: projects.executionWorkspacePolicy,
    })
    .from(projects);

  let scanned = 0;
  let marked = 0;
  let blocked = 0;
  let skipped = 0;

  for (const row of projectRows) {
    const policy = parseProjectExecutionWorkspacePolicy(row.executionWorkspacePolicy);
    const ttlDays = policy?.ttlDays;
    if (!ttlDays || ttlDays <= 0) {
      skipped++;
      continue;
    }

    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

    const candidates = await db
      .select({
        id: executionWorkspaces.id,
        cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
      })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.projectId, row.id),
          ne(executionWorkspaces.status, "archived"),
          lt(executionWorkspaces.lastUsedAt, cutoff),
        ),
      );

    for (const ws of candidates) {
      scanned++;

      if (ws.cleanupEligibleAt) {
        // already stamped by a previous sweep; don't re-mark
        skipped++;
        continue;
      }

      let readinessState: string | null = null;
      try {
        const readiness = await svc.getCloseReadiness(ws.id);
        readinessState = readiness?.state ?? null;
      } catch (err) {
        logger.warn(
          { err, workspaceId: ws.id },
          "TTL sweeper readiness check failed — treating as blocked",
        );
        blocked++;
        continue;
      }

      if (!readinessState || readinessState === "blocked") {
        blocked++;
        continue;
      }

      await db
        .update(executionWorkspaces)
        .set({
          cleanupEligibleAt: new Date(),
          cleanupReason: `ttl_sweep:${ttlDays}d`,
          updatedAt: new Date(),
        })
        .where(eq(executionWorkspaces.id, ws.id));

      marked++;
    }
  }

  // ── Fallback pass: thread-scoped workspaces in projects with no ttlDays ────
  //
  // The per-project loop above only runs the candidate query for projects with
  // an explicit ttlDays policy. Thread workspaces in projects without a TTL
  // policy would otherwise accumulate forever, so we apply a default TTL
  // (`DEFAULT_THREAD_WORKSPACE_TTL_DAYS`) here.
  //
  // We don't bother filtering out projects that *do* have a ttlDays — the
  // existing per-project loop already marks those workspaces, and the
  // `cleanupEligibleAt IS NULL` check below naturally skips anything the
  // first pass touched. The double-pass is benign and saves us a set/subquery.
  const fallbackCutoff = new Date(
    Date.now() - DEFAULT_THREAD_WORKSPACE_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const fallbackCandidates = await db
    .select({
      id: executionWorkspaces.id,
      cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
    })
    .from(executionWorkspaces)
    .where(
      and(
        // Only thread-scoped workspaces in the fallback pass — issue-scoped
        // workspaces are handled exclusively by the per-project loop.
        isNotNull(executionWorkspaces.threadId),
        ne(executionWorkspaces.status, "archived"),
        lt(executionWorkspaces.lastUsedAt, fallbackCutoff),
      ),
    );

  for (const ws of fallbackCandidates) {
    scanned++;

    if (ws.cleanupEligibleAt) {
      // already stamped (either by the per-project loop above, or by an
      // earlier sweep, or by the on-archive hook); don't re-mark
      skipped++;
      continue;
    }

    let readinessState: string | null = null;
    try {
      const readiness = await svc.getCloseReadiness(ws.id);
      readinessState = readiness?.state ?? null;
    } catch (err) {
      logger.warn(
        { err, workspaceId: ws.id },
        "TTL sweeper readiness check failed (fallback) — treating as blocked",
      );
      blocked++;
      continue;
    }

    if (!readinessState || readinessState === "blocked") {
      blocked++;
      continue;
    }

    await db
      .update(executionWorkspaces)
      .set({
        cleanupEligibleAt: new Date(),
        cleanupReason: `thread_workspace_default:${DEFAULT_THREAD_WORKSPACE_TTL_DAYS}d`,
        updatedAt: new Date(),
      })
      .where(eq(executionWorkspaces.id, ws.id));

    marked++;
  }

  logger.info({ scanned, marked, blocked, skipped }, "Workspace TTL sweep complete");
  return { scanned, marked, blocked, skipped };
}

/**
 * Mark all thread-scoped workspaces for a thread eligible for cleanup,
 * regardless of TTL. Called by the discussion-archive flow (and the merge
 * flow, which archives the source thread). Idempotent — already-marked
 * workspaces are skipped via the `cleanupEligibleAt IS NULL` filter.
 *
 * Returns the count of workspaces newly marked. Note: active workspaces
 * whose close-readiness is currently `blocked` are still marked here. The
 * actual close happens later in the cleanup worker, which re-checks
 * readiness at execution time — so marking-while-blocked is safe.
 */
export async function markThreadWorkspacesForCleanup(
  db: Db,
  threadId: string,
): Promise<{ marked: number }> {
  const now = new Date();
  const result = await db
    .update(executionWorkspaces)
    .set({
      cleanupEligibleAt: now,
      cleanupReason: "thread_archived",
      updatedAt: now,
    })
    .where(
      and(
        eq(executionWorkspaces.threadId, threadId),
        ne(executionWorkspaces.status, "archived"),
        isNull(executionWorkspaces.cleanupEligibleAt),
      ),
    )
    .returning({ id: executionWorkspaces.id });

  return { marked: result.length };
}

export function scheduleTtlSweeper(db: Db, intervalMs = 6 * 60 * 60 * 1000): NodeJS.Timeout {
  return setInterval(() => {
    void sweepExpiredWorkspaces(db).catch((err) => {
      logger.error({ err }, "Workspace TTL sweep failed");
    });
  }, intervalMs);
}
