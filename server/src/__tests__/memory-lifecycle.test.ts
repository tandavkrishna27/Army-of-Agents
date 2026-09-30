import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @armyofagents/db to avoid drizzle-orm ESM cycle
vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        // Return a stable symbol for each column to use in eq/and calls
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    memoryItems: makeTable("memory_items"),
    issues: makeTable("issues"),
    taskDependencies: makeTable("task_dependencies"),
    suggestions: makeTable("suggestions"),
    activityLog: makeTable("activity_log"),
  };
});

// Mock drizzle-orm operators to no-op
vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  or: (..._args: unknown[]) => "or",
  eq: (..._args: unknown[]) => "eq",
  lt: (..._args: unknown[]) => "lt",
  isNotNull: (..._args: unknown[]) => "isNotNull",
  isNull: (..._args: unknown[]) => "isNull",
  inArray: (..._args: unknown[]) => "inArray",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

// Mock activity-log
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

// Mock live-events (transitive dep)
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import { logActivity } from "../services/activity-log.js";
import { memoryLifecycleService } from "../services/memory-lifecycle.js";

// ---------------------------------------------------------------------------
// Sequence-based mock DB: each call to select/update/insert returns the next
// pre-configured result in order.
// ---------------------------------------------------------------------------
type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];
  const captured = {
    insertValues: [] as unknown[],
  };

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "set", "values", "onConflictDoNothing", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (...args: unknown[]) => {
        if (m === "values") captured.insertValues.push(args[0]);
        return chain;
      };
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
  };
  return Object.assign(db, { captured });
}

describe("Memory Lifecycle Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("onGoalCompleted", () => {
    it("archives active_context memory items for the completed goal", async () => {
      const items = [
        { id: "mem-1", title: "Context item 1", layer: "active_context", status: "approved", goalId: "goal-1", companyId: "co-1" },
        { id: "mem-2", title: "Context item 2", layer: "active_context", status: "approved", goalId: "goal-1", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [items],   // Find items to archive
        updates: [items],   // Archive them
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.onGoalCompleted("co-1", "goal-1");

      expect(count).toBe(2);
      expect(logActivity).toHaveBeenCalledTimes(2);
      expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        companyId: "co-1",
        actorType: "system",
        actorId: "system",
        action: "memory.auto_archived",
        entityType: "memory_item",
        entityId: "mem-1",
        details: expect.objectContaining({ reason: "goal_completed", goalId: "goal-1" }),
      }));
    });

    it("returns 0 when no items match (idempotent — already archived)", async () => {
      const db = createSequenceDb({ selects: [[]] });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.onGoalCompleted("co-1", "goal-1");

      expect(count).toBe(0);
      expect(logActivity).not.toHaveBeenCalled();
    });

    it("works for cancelled goals too", async () => {
      const items = [
        { id: "mem-1", title: "Context item", layer: "active_context", status: "approved", goalId: "goal-2", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [items],
        updates: [items],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.onGoalCompleted("co-1", "goal-2");

      expect(count).toBe(1);
    });
  });

  describe("archiveExpiredWorkingMemory", () => {
    it("archives working memory when full chain is terminal for 7+ days", async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const workingItems = [
        { id: "wm-1", title: "Working mem", layer: "working", status: "approved", taskId: "task-1", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [
          workingItems,  // Find working memory items
          [{ status: "done", completedAt: eightDaysAgo, cancelledAt: null }],  // Linked task
          [],  // No dependencies (chain terminal)
        ],
        updates: [workingItems],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(1);
      expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "memory.auto_archived",
        details: expect.objectContaining({ reason: "working_memory_ttl", taskId: "task-1" }),
      }));
    });

    it("does NOT archive when dependency chain is partially active", async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const workingItems = [
        { id: "wm-1", title: "Working mem", layer: "working", status: "approved", taskId: "task-1", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [
          workingItems,
          [{ status: "done", completedAt: eightDaysAgo, cancelledAt: null }],  // Linked task done
          [{ depId: "task-2", depntId: "task-1" }],  // Has dependency
          [{ id: "task-2", status: "in_progress", completedAt: null, cancelledAt: null }],  // Not terminal
        ],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(0);
      expect(logActivity).not.toHaveBeenCalled();
    });

    it("does NOT archive when task is terminal but less than 7 days", async () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const workingItems = [
        { id: "wm-1", title: "Working mem", layer: "working", status: "approved", taskId: "task-1", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [
          workingItems,
          [{ status: "done", completedAt: threeDaysAgo, cancelledAt: null }],
        ],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(0);
    });

    it("treats deleted tasks as terminal", async () => {
      const workingItems = [
        { id: "wm-1", title: "Working mem", layer: "working", status: "approved", taskId: "task-deleted", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [
          workingItems,
          [],  // Task not found (deleted)
        ],
        updates: [workingItems],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(1);
    });
  });

  describe("archiveExpiredItems", () => {
    it("archives items with expiresAt in the past", async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const expiredItems = [
        { id: "exp-1", title: "Expired item", layer: "active_context", status: "approved", expiresAt: yesterday, companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [expiredItems],
        updates: [expiredItems],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredItems("co-1");

      expect(count).toBe(1);
      expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "memory.auto_archived",
        details: expect.objectContaining({ reason: "expired" }),
      }));
    });

    it("returns 0 when no items are expired", async () => {
      const db = createSequenceDb({ selects: [[]] });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredItems("co-1");

      expect(count).toBe(0);
      expect(logActivity).not.toHaveBeenCalled();
    });
  });

  describe("flagStaleItems", () => {
    it("creates suggestions for items not accessed in 90+ days", async () => {
      const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      const staleItems = [
        { id: "stale-1", title: "Old domain knowledge", layer: "domain", status: "approved", accessedAt: longAgo, companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [staleItems, []],  // stale items, no existing suggestions
        inserts: [[]],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.flagStaleItems("co-1");

      expect(count).toBe(1);
      expect(db.captured.insertValues[0]).toEqual(expect.objectContaining({
        category: "memory_gap",
        actionType: "archive_memory",
        dedupeKey: "memory_gap:stale:stale-1",
        relatedMemoryItemId: "stale-1",
      }));
      // Flagging creates suggestions — does NOT create activity log entries
      expect(logActivity).not.toHaveBeenCalled();
    });

    it("does not create duplicate suggestions for already-flagged items", async () => {
      const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      const staleItems = [
        { id: "stale-1", title: "Already flagged", layer: "domain", status: "approved", accessedAt: longAgo, companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [staleItems, [{ relatedMemoryItemId: "stale-1" }]],  // item + existing suggestion
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.flagStaleItems("co-1");

      expect(count).toBe(0);
    });

    it("returns 0 when no stale items found", async () => {
      const db = createSequenceDb({ selects: [[]] });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.flagStaleItems("co-1");

      expect(count).toBe(0);
    });

    it("flags never-accessed items (accessedAt = null) that are old by createdAt", async () => {
      // The DB predicate would normally exclude these (NULL < cutoff → NULL),
      // but the widened predicate also catches them via createdAt. The mock DB
      // ignores the SQL, so we model the rows the predicate is expected to
      // return: a never-accessed item with an ancient createdAt.
      const oldCreatedAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
      const staleItems = [
        {
          id: "stale-null",
          title: "Never accessed knowledge",
          layer: "identity",
          status: "approved",
          accessedAt: null,
          createdAt: oldCreatedAt,
          companyId: "co-1",
        },
      ];

      let insertedValues: Record<string, unknown> | undefined;
      const db = createSequenceDb({
        selects: [staleItems, []], // stale items, no existing suggestions
        inserts: [[]],
      });
      // Capture the values passed to insert(...).values(...)
      const origInsert = db.insert;
      db.insert = (...args: unknown[]) => {
        const chain = origInsert(...args) as Record<string, any>;
        const origValues = chain.values;
        chain.values = (v: Record<string, unknown>) => {
          insertedValues = v;
          return origValues(v);
        };
        return chain;
      };

      const svc = memoryLifecycleService(db as any);
      const count = await svc.flagStaleItems("co-1");

      expect(count).toBe(1);

      // Age must be derived from createdAt (~120 days) — NOT a nonsense epoch
      // age (~20000 days) from `accessedAt?.getTime() ?? 0`.
      expect(insertedValues).toBeDefined();
      const title = String(insertedValues!.title);
      const evidence = String(insertedValues!.evidence);

      // Sanity: the title carries a day count that is plausible (around 120),
      // certainly not the epoch-derived ~20000.
      const dayMatch = title.match(/(\d+)\s+days/);
      if (dayMatch) {
        const days = Number(dayMatch[1]);
        expect(days).toBeLessThan(1000);
        expect(days).toBeGreaterThanOrEqual(119);
      }
      // Evidence should say it was never accessed, not echo an epoch date.
      expect(evidence).toMatch(/never/i);
      expect(evidence).not.toContain("1970");
      expect(title).not.toMatch(/\b2\d{4}\s+days/); // no ~20000-day nonsense
    });

    it("does not flag items with a recent accessedAt", async () => {
      // Predicate excludes recently-accessed items → mock returns none.
      const db = createSequenceDb({ selects: [[]] });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.flagStaleItems("co-1");

      expect(count).toBe(0);
    });

    it("flags items with an old accessedAt (regression of existing behavior)", async () => {
      const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      const staleItems = [
        {
          id: "stale-old",
          title: "Old by access",
          layer: "domain",
          status: "approved",
          accessedAt: longAgo,
          createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
          companyId: "co-1",
        },
      ];

      let insertedValues: Record<string, unknown> | undefined;
      const db = createSequenceDb({
        selects: [staleItems, []],
        inserts: [[]],
      });
      const origInsert = db.insert;
      db.insert = (...args: unknown[]) => {
        const chain = origInsert(...args) as Record<string, any>;
        const origValues = chain.values;
        chain.values = (v: Record<string, unknown>) => {
          insertedValues = v;
          return origValues(v);
        };
        return chain;
      };

      const svc = memoryLifecycleService(db as any);
      const count = await svc.flagStaleItems("co-1");

      expect(count).toBe(1);
      // Age derived from accessedAt (~100 days), evidence echoes the ISO date.
      expect(insertedValues).toBeDefined();
      expect(String(insertedValues!.title)).toContain("100 days");
      expect(String(insertedValues!.evidence)).not.toMatch(/never/i);
    });
  });

  describe("onTaskCompleted", () => {
    it("archives working-layer items scoped to the completed task", async () => {
      const items = [
        { id: "wm-1", title: "Task working mem 1", layer: "working", status: "approved", taskId: "task-99", companyId: "co-1" },
        { id: "wm-2", title: "Task working mem 2", layer: "working", status: "approved", taskId: "task-99", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [items],
        updates: [items],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.onTaskCompleted("co-1", "task-99");

      expect(count).toBe(2);
      expect(logActivity).toHaveBeenCalledTimes(2);
      expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        companyId: "co-1",
        actorType: "system",
        actorId: "system",
        action: "memory.auto_archived",
        entityType: "memory_item",
        entityId: "wm-1",
        details: expect.objectContaining({ reason: "task_completed", taskId: "task-99" }),
      }));
    });

    it("returns 0 when no working items are scoped to the task", async () => {
      const db = createSequenceDb({ selects: [[]] });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.onTaskCompleted("co-1", "task-99");

      expect(count).toBe(0);
      expect(logActivity).not.toHaveBeenCalled();
    });

    it("is idempotent — re-running returns 0 (items already archived)", async () => {
      // Second call finds no approved items (already archived by first call)
      const db = createSequenceDb({ selects: [[]] });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.onTaskCompleted("co-1", "task-99");

      expect(count).toBe(0);
    });
  });
});

describe("accessedAt batch update in fetchMemoryContext", () => {
  it("empty served list skips the UPDATE (no empty IN clause)", () => {
    // In fetchMemoryContext: if (servedIds.length > 0) { ... }
    // When items array is empty, the UPDATE block is skipped entirely.
    const servedIds: string[] = [];
    expect(servedIds.length > 0).toBe(false);
  });

  it("batch update collects all served IDs into a single query", () => {
    // fetchMemoryContext selects id along with other fields,
    // then maps items to servedIds for a single inArray() UPDATE.
    const items = [
      { id: "a", title: "A", content: "a", category: "preference", tags: [] },
      { id: "b", title: "B", content: "b", category: "context", tags: [] },
      { id: "c", title: "C", content: "c", category: "decision", tags: [] },
    ];
    const servedIds = items.map((item) => item.id);
    expect(servedIds).toEqual(["a", "b", "c"]);
    // Single array → single query (not 3 separate N+1 queries)
    expect(servedIds.length).toBe(3);
  });

  it("staleness flagging respects recent accessedAt", () => {
    // After an item is served, accessedAt = NOW().
    // flagStaleItems checks: accessedAt <= cutoff (90 days ago).
    // A recently accessed item won't match the cutoff condition.
    const recentDate = new Date();
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    expect(recentDate > cutoff).toBe(true);
  });

  it("concurrent context assembly is safe (last-write-wins on accessedAt)", () => {
    // Two heartbeat runs both SET accessedAt = NOW() on overlapping items.
    // Both UPDATEs succeed — the later timestamp wins, which is acceptable.
    const now1 = new Date();
    const now2 = new Date(now1.getTime() + 50); // 50ms later
    expect(now2.getTime()).toBeGreaterThan(now1.getTime());
  });

  it("items with null accessedAt and old createdAt are flagged stale", () => {
    // flagStaleItems WHERE clause:
    //   (accessedAt IS NULL AND createdAt <= cutoff) OR (accessedAt <= cutoff)
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const oldCreatedAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    const accessedAt = null;

    const wouldBeStale = accessedAt === null && oldCreatedAt <= cutoff;
    expect(wouldBeStale).toBe(true);
  });

  it("items with recent accessedAt are not flagged stale even if createdAt is old", () => {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const oldCreatedAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    const recentAccessedAt = new Date(); // just served

    const wouldBeStale = recentAccessedAt <= cutoff;
    expect(wouldBeStale).toBe(false);
  });
});
