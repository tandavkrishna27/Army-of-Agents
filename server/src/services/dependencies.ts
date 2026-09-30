import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issues, taskDependencies } from "@armyofagents/db";
import { logActivity } from "./activity-log.js";
import { enqueueIssueAssigneeWakeup } from "./issue-assignee-wakeup.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { shouldDispatchIssueWakeup } from "../routes/issues-planning-mode-dispatch.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface WakeTask {
  companyId: string;
  agentId: string;
  issueId: string;
  workMode: string | null;
}

/**
 * A dependency in any of these statuses no longer blocks its dependents.
 * Both `done` and `cancelled` are terminal: a cancelled upstream task is
 * resolved (it won't ever complete), so it must release downstream tasks the
 * same way a completed one does. (A-H9)
 */
export const TERMINAL_STATUSES = ["done", "cancelled"];

/**
 * Statuses from which a task may be auto-blocked by a new dependency: every
 * non-terminal status except `blocked` itself. Used both as the in-memory guard
 * and as the conditional `WHERE … status IN (…)` on the auto-block UPDATE so a
 * dependent that was concurrently completed / checked out / already blocked is
 * never (re)blocked. (A-M12)
 */
export const BLOCKABLE_STATUSES = ["backlog", "todo", "in_progress", "in_review"];
const MAX_CHAIN_DEPTH = 50;

/**
 * Normalize the result of a raw `db.execute(sql\`…\`)` into a plain row array.
 * The postgres-js driver returns an array-like `RowList`; the pg/node driver
 * (and the test mock) returns `{ rows }`. Handle both so the FOR UPDATE reads
 * in `addDependencyTx` are driver-agnostic. (A-M12)
 */
function readRows(result: unknown): Array<{ id: string; status: string }> {
  if (Array.isArray(result)) {
    return result as Array<{ id: string; status: string }>;
  }
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Array<{ id: string; status: string }>) : [];
}

export function dependencyService(db: Db) {
  async function fireWakeups(tasks: WakeTask[]) {
    for (const wake of tasks) {
      if (!shouldDispatchIssueWakeup({ workMode: wake.workMode })) continue;
      await enqueueIssueAssigneeWakeup(db, {
        companyId: wake.companyId,
        agentId: wake.agentId,
        issueId: wake.issueId,
        source: "automation",
        reason: "dependency_unblocked",
      });
    }
  }

  /**
   * Core add-dependency logic. Runs every statement on the provided
   * transaction connection `tx` so the dependency-status read, cycle check,
   * edge insert, and auto-block UPDATE are one atomic unit. Returns the
   * inserted edge plus any wakeups produced when the just-added dependency was
   * already terminal (so a freshly-satisfied dependent can be dispatched after
   * the tx commits). (A-M12)
   */
  async function addDependencyTx(
    companyId: string,
    dependentIssueId: string,
    dependencyIssueId: string,
    tx: Tx,
  ): Promise<{ row: typeof taskDependencies.$inferSelect; wakeups: WakeTask[] }> {
    const conn = tx as unknown as Db;

    // No self-dependency
    if (dependentIssueId === dependencyIssueId) {
      throw unprocessable("A task cannot depend on itself");
    }

    // Lock BOTH sides FOR UPDATE so neither row's status can change in the
    // read→write window. Locking the dependency prevents a concurrent
    // completion from sneaking past the terminal check; locking the dependent
    // prevents a concurrent checkout/completion from being clobbered by our
    // auto-block. (A-M12) The verification read is fused into the lock so we
    // never read a stale row.
    //
    // Codex P2: lock BOTH rows in a SINGLE statement ordered by id. Two
    // separate per-row locks (dependent-then-dependency) give no GLOBAL lock
    // order across callers: inverse concurrent adds — addDependency(A→B) and
    // addDependency(B→A) — would acquire the same two locks in opposite orders
    // and can deadlock. Postgres takes row locks in the order the rows are
    // emitted, so `WHERE id IN (…) ORDER BY id FOR UPDATE` makes every caller
    // acquire the two locks in the same id order, breaking the cycle. We then
    // map the returned rows back to dependent vs dependency by id.
    const lockedRows = readRows(
      await conn.execute(
        sql`select id, status from issues where id in (${dependentIssueId}, ${dependencyIssueId}) and company_id = ${companyId} order by id for update`,
      ),
    );
    const dependent = lockedRows.find((r) => r.id === dependentIssueId);
    const dependency = lockedRows.find((r) => r.id === dependencyIssueId);

    if (!dependent) throw notFound("Dependent task not found");
    if (!dependency) throw notFound("Dependency task not found");

    // Circular dependency check — walk upstream from dependencyIssueId
    await assertNoCycle(companyId, dependencyIssueId, dependentIssueId, conn);

    // Insert (unique constraint catches duplicates)
    const [row] = await conn
      .insert(taskDependencies)
      .values({ companyId, dependentIssueId, dependencyIssueId })
      .returning()
      .catch((err: unknown) => {
        if (err instanceof Error && err.message.includes("task_dep_unique_idx")) {
          throw conflict("This dependency already exists");
        }
        throw err;
      });

    let wakeups: WakeTask[] = [];

    if (TERMINAL_STATUSES.includes(dependency.status)) {
      // The dependency is already terminal (done/cancelled). Do NOT block, and
      // re-evaluate the dependent: if this edge was its last unmet dependency it
      // must be released immediately (it would otherwise sit unblockable). This
      // is exactly the block-after-complete race the non-tx code could leave
      // permanently `blocked`. maybeUnblockTx is a no-op unless the dependent is
      // currently `blocked`. (A-M12)
      wakeups = await maybeUnblockTx(companyId, dependentIssueId, conn);
    } else {
      // Dependency is non-terminal → block the dependent, but ONLY while it is
      // still in a blockable status. The conditional WHERE (belt-and-suspenders
      // alongside the FOR UPDATE above) makes the auto-block a no-op if the
      // dependent was concurrently completed/checked out or already blocked, so
      // we never resurrect a finished task into `blocked`. Capture the pre-block
      // status so unblock restores it instead of hard-promoting to `todo`. (A-M10)
      await conn
        .update(issues)
        .set({ status: "blocked", blockedFromStatus: dependent.status, updatedAt: new Date() })
        .where(
          and(
            eq(issues.id, dependentIssueId),
            inArray(issues.status, BLOCKABLE_STATUSES),
          ),
        );
    }

    await logActivity(conn, {
      companyId,
      actorType: "system",
      actorId: "system",
      action: "dependency.added",
      entityType: "issue",
      entityId: dependentIssueId,
      details: { dependencyIssueId },
    });

    return { row, wakeups };
  }

  /**
   * Public API: add a dependency edge and auto-block transactionally.
   * When `outerTx` is provided, runs inside it and the caller is responsible for
   * firing the returned wakeups after commit. Standalone, it wraps the whole
   * existence-read + cycle-check + edge-insert + auto-block in a single
   * transaction (so the dependency status can't change under us) and fires any
   * wakeups after the commit. (A-M12)
   */
  async function addDependency(
    companyId: string,
    dependentIssueId: string,
    dependencyIssueId: string,
    outerTx?: Tx,
  ) {
    if (outerTx) {
      const { row } = await addDependencyTx(companyId, dependentIssueId, dependencyIssueId, outerTx);
      return row;
    }

    const { row, wakeups } = await db.transaction(async (tx) =>
      addDependencyTx(companyId, dependentIssueId, dependencyIssueId, tx),
    );
    await fireWakeups(wakeups);
    return row;
  }

  async function removeDependency(
    companyId: string,
    dependentIssueId: string,
    dependencyIssueId: string,
  ) {
    const [deleted] = await db
      .delete(taskDependencies)
      .where(
        and(
          eq(taskDependencies.companyId, companyId),
          eq(taskDependencies.dependentIssueId, dependentIssueId),
          eq(taskDependencies.dependencyIssueId, dependencyIssueId),
        ),
      )
      .returning();

    if (!deleted) throw notFound("Dependency not found");

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "system",
      action: "dependency.removed",
      entityType: "issue",
      entityId: dependentIssueId,
      details: { dependencyIssueId },
    });

    // Re-evaluate: should the dependent be unblocked?
    const wakeups = await maybeUnblockTx(companyId, dependentIssueId, db);
    await fireWakeups(wakeups);

    return deleted;
  }

  async function getDependencies(companyId: string, issueId: string) {
    return db
      .select({
        id: taskDependencies.id,
        dependencyIssueId: taskDependencies.dependencyIssueId,
        title: issues.title,
        status: issues.status,
        identifier: issues.identifier,
        createdAt: taskDependencies.createdAt,
      })
      .from(taskDependencies)
      .innerJoin(issues, eq(issues.id, taskDependencies.dependencyIssueId))
      .where(
        and(
          eq(taskDependencies.companyId, companyId),
          eq(taskDependencies.dependentIssueId, issueId),
        ),
      );
  }

  async function getDependentsTx(companyId: string, issueId: string, tx: Tx | Db) {
    return (tx as Db)
      .select({
        id: taskDependencies.id,
        dependentIssueId: taskDependencies.dependentIssueId,
        title: issues.title,
        status: issues.status,
        blockedFromStatus: issues.blockedFromStatus,
        identifier: issues.identifier,
        createdAt: taskDependencies.createdAt,
      })
      .from(taskDependencies)
      .innerJoin(issues, eq(issues.id, taskDependencies.dependentIssueId))
      .where(
        and(
          eq(taskDependencies.companyId, companyId),
          eq(taskDependencies.dependencyIssueId, issueId),
        ),
      );
  }

  async function getDependents(companyId: string, issueId: string) {
    return getDependentsTx(companyId, issueId, db);
  }

  /**
   * Core resolution logic — runs all DB ops through the provided tx/db.
   * Returns tasks that need wakeup (to be called after transaction commits).
   */
  async function resolveDependenciesTx(
    companyId: string,
    completedIssueId: string,
    tx: Tx | Db,
  ): Promise<WakeTask[]> {
    const dependents = await getDependentsTx(companyId, completedIssueId, tx);
    const wakeups: WakeTask[] = [];

    for (const dep of dependents) {
      if (dep.status !== "blocked") continue;

      // Check if ALL dependencies of this dependent are now done
      const remaining = await (tx as Db)
        .select({ status: issues.status })
        .from(taskDependencies)
        .innerJoin(issues, eq(issues.id, taskDependencies.dependencyIssueId))
        .where(
          and(
            eq(taskDependencies.companyId, companyId),
            eq(taskDependencies.dependentIssueId, dep.dependentIssueId),
          ),
        );

      const allDone = remaining.every((r) => TERMINAL_STATUSES.includes(r.status));
      if (!allDone) continue;

      // Restore the pre-block status (A-M10): an auto-blocked `backlog` task
      // must return to `backlog`, not be promoted to `todo`. Fall back to
      // `todo` for legacy rows blocked before this column existed.
      const restoredStatus = dep.blockedFromStatus ?? "todo";
      await (tx as Db)
        .update(issues)
        .set({ status: restoredStatus, blockedFromStatus: null, updatedAt: new Date() })
        .where(eq(issues.id, dep.dependentIssueId));

      await logActivity(tx as Db, {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "dependency.unblocked",
        entityType: "issue",
        entityId: dep.dependentIssueId,
        details: { resolvedByIssueId: completedIssueId },
      });

      // Only auto-dispatch tasks restored to an executable status. A task
      // restored to `backlog` is not executable and must not be woken. (A-M10)
      if (restoredStatus === "backlog") continue;

      // Collect agent for wakeup (after tx commits)
      const [task] = await (tx as Db)
        .select({ assigneeAgentId: issues.assigneeAgentId, workMode: issues.workMode })
        .from(issues)
        .where(eq(issues.id, dep.dependentIssueId));

      if (task?.assigneeAgentId) {
        wakeups.push({ companyId, agentId: task.assigneeAgentId, issueId: dep.dependentIssueId, workMode: task.workMode ?? null });
      }
    }

    return wakeups;
  }

  /**
   * Public API: resolves dependencies with optional outer transaction.
   * When outerTx is provided, DB ops run inside it and wakeups are returned (caller handles them after commit).
   * When called standalone, wraps in its own transaction and fires wakeups after.
   */
  async function resolveDependencies(
    companyId: string,
    completedIssueId: string,
    outerTx?: Tx,
  ): Promise<{ tasksToWake: WakeTask[] }> {
    if (outerTx) {
      const tasksToWake = await resolveDependenciesTx(companyId, completedIssueId, outerTx);
      return { tasksToWake };
    }

    const tasksToWake = await db.transaction(async (tx) => {
      return resolveDependenciesTx(companyId, completedIssueId, tx);
    });
    await fireWakeups(tasksToWake);
    return { tasksToWake };
  }

  /**
   * Core maybeUnblock logic — runs through tx/db, returns wakeups.
   */
  async function maybeUnblockTx(
    companyId: string,
    dependentIssueId: string,
    tx: Tx | Db,
  ): Promise<WakeTask[]> {
    const [task] = await (tx as Db)
      .select({ status: issues.status, blockedFromStatus: issues.blockedFromStatus })
      .from(issues)
      .where(and(eq(issues.id, dependentIssueId), eq(issues.companyId, companyId)));

    if (!task || task.status !== "blocked") return [];

    const remaining = await (tx as Db)
      .select({ status: issues.status })
      .from(taskDependencies)
      .innerJoin(issues, eq(issues.id, taskDependencies.dependencyIssueId))
      .where(
        and(
          eq(taskDependencies.companyId, companyId),
          eq(taskDependencies.dependentIssueId, dependentIssueId),
        ),
      );

    // No remaining deps or all terminal (done OR cancelled) → unblock
    if (remaining.length === 0 || remaining.every((r) => TERMINAL_STATUSES.includes(r.status))) {
      // Restore the pre-block status instead of hard-promoting to `todo`. (A-M10)
      const restoredStatus = task.blockedFromStatus ?? "todo";
      await (tx as Db)
        .update(issues)
        .set({ status: restoredStatus, blockedFromStatus: null, updatedAt: new Date() })
        .where(eq(issues.id, dependentIssueId));

      await logActivity(tx as Db, {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "dependency.unblocked",
        entityType: "issue",
        entityId: dependentIssueId,
      });

      // A task restored to `backlog` is not executable → never auto-dispatch. (A-M10)
      if (restoredStatus === "backlog") return [];

      const [unblocked] = await (tx as Db)
        .select({ assigneeAgentId: issues.assigneeAgentId, workMode: issues.workMode })
        .from(issues)
        .where(eq(issues.id, dependentIssueId));

      if (unblocked?.assigneeAgentId) {
        return [{ companyId, agentId: unblocked.assigneeAgentId, issueId: dependentIssueId, workMode: unblocked.workMode ?? null }];
      }
    }

    return [];
  }

  /**
   * A cancelled dependency is terminal — it satisfies (releases) its dependents
   * exactly like a `done` one would. For each dependent we run the same
   * maybeUnblock logic and RETURN the resulting wakeups so the caller can fire
   * heartbeat wakeups after the transaction commits (symmetric with the `done`
   * path through resolveDependencies). Without propagating these wakes, an
   * unblocked dependent would never get dispatched. (A-H9)
   */
  async function handleCancelledDependency(
    companyId: string,
    cancelledIssueId: string,
    outerTx?: Tx,
  ): Promise<WakeTask[]> {
    const tx = outerTx ?? db;
    const dependents = await getDependentsTx(companyId, cancelledIssueId, tx);
    const wakeups: WakeTask[] = [];

    for (const dep of dependents) {
      await logActivity(tx as Db, {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "dependency.cancelled_warning",
        entityType: "issue",
        entityId: dep.dependentIssueId,
        details: {
          cancelledDependencyIssueId: cancelledIssueId,
          message: "A dependency task was cancelled; releasing the dependent (all remaining dependencies terminal).",
        },
      });

      // Release the dependent if all of its remaining dependencies are now
      // terminal (the just-cancelled one plus any already-done ones).
      const unblockWakes = await maybeUnblockTx(companyId, dep.dependentIssueId, tx);
      wakeups.push(...unblockWakes);
    }

    return wakeups;
  }

  // --- Internal helpers ---

  async function assertNoCycle(
    companyId: string,
    startIssueId: string,
    targetIssueId: string,
    conn: Tx | Db = db,
  ) {
    // Walk upstream from startIssueId. If we ever reach targetIssueId, it's a cycle.
    let currentIds = [startIssueId];

    for (let depth = 0; depth < MAX_CHAIN_DEPTH; depth++) {
      if (currentIds.length === 0) return; // no more upstream — no cycle

      const upstream = await (conn as Db)
        .select({ depId: taskDependencies.dependencyIssueId })
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.companyId, companyId),
            inArray(taskDependencies.dependentIssueId, currentIds),
          ),
        );

      const nextIds = upstream.map((r) => r.depId);
      if (nextIds.includes(targetIssueId)) {
        throw unprocessable("Circular dependency detected");
      }

      currentIds = nextIds;
    }

    throw unprocessable("Dependency chain exceeds maximum depth of 50");
  }

  return {
    addDependency,
    removeDependency,
    getDependencies,
    getDependents,
    resolveDependencies,
    handleCancelledDependency,
  };
}
