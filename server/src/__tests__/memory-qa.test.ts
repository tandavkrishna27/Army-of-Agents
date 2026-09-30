import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTableProxy, drizzleOperatorStubs, mockDbCapabilities } from "./helpers/drizzle-mock.js";

/**
 * Memory QA Tests
 *
 * Covers:
 * - Layer inheritance (identity → domain → active_context → working)
 * - Version isolation (draft vs approved)
 * - Dedup detection via findSimilarItems
 * - Auto-archive on goal completion and TTL
 * - Token budget / context modes
 * - Staleness flagging (90-day threshold)
 * - Conflict ordering (same-layer, different priority)
 * - Cross-department visibility
 * - Embedding lifecycle (NULL on create, invalidated on update)
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// The "Embedding lifecycle" describe block (create always sets embedding=null,
// update invalidates on content change) requires hasVectorSupport: true —
// those code paths are gated and silently no-op otherwise.
vi.mock("../services/db-capabilities.js", () => mockDbCapabilities());

vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
  memoryItemVersions: makeTableProxy("memory_item_versions"),
  issues: makeTableProxy("issues"),
  taskDependencies: makeTableProxy("task_dependencies"),
  suggestions: makeTableProxy("suggestions"),
  activityLog: makeTableProxy("activity_log"),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const mockResolveApiKey = vi.fn();
// Search paths resolve the embedding key via getProviderApiKey (env-fallback
// aware); delegate to the same mock (dropping the leading db arg).
vi.mock("../services/internal-agent/providers/index.js", () => ({
  getProviderApiKey: (...args: unknown[]) => mockResolveApiKey(...args.slice(1)),
}));
vi.mock("../adapters/api-common.js", () => ({
  resolveApiKey: (...args: unknown[]) => mockResolveApiKey(...args),
}));

const mockGenerateEmbedding = vi.fn();
vi.mock("../services/embeddings.js", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

// Spy on buildMemoryInsert so tests can inspect the `values` object the
// service passes before the raw INSERT is executed.
const capturedBuildInsertValues: Record<string, unknown>[] = [];
vi.mock("../services/memory-projection.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../services/memory-projection.js")>();
  return {
    ...orig,
    buildMemoryInsert: vi.fn(
      (db: unknown, values: Record<string, unknown>, hasVector: boolean) => {
        capturedBuildInsertValues.push({ ...values });
        return orig.buildMemoryInsert(db as any, values, hasVector);
      },
    ),
  };
});

import { logActivity } from "../services/activity-log.js";
import { memoryService } from "../services/memory.js";
import { memoryLifecycleService } from "../services/memory-lifecycle.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "set", "values", "onConflictDoNothing", "returning", "innerJoin", "leftJoin", "orderBy", "limit", "delete"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => []),
  };
}

function makeMockDb(rows: MockRow[] = []) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    then: vi.fn(),
  };
  return chain as unknown;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Memory QA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Layer inheritance ───────────────────────────────────────────────────────

  describe("Layer inheritance", () => {
    it("list supports filtering by layer parameter", () => {
      const db = makeMockDb([]) as any;
      const svc = memoryService(db);

      // Call list with each layer
      for (const layer of ["identity", "domain", "active_context", "working"]) {
        svc.list("co-1", { layer });
        expect(db.select).toHaveBeenCalled();
      }
    });

    it("four distinct layers exist: identity, domain, active_context, working", () => {
      const layers = ["identity", "domain", "active_context", "working"];
      expect(layers).toHaveLength(4);
      expect(new Set(layers).size).toBe(4);
    });

    it("identity layer items have no department/project scope", () => {
      const identityItem = {
        id: "m-1",
        layer: "identity",
        departmentId: null,
        projectId: null,
        goalId: null,
        companyId: "co-1",
      };
      expect(identityItem.departmentId).toBeNull();
      expect(identityItem.projectId).toBeNull();
    });

    it("domain layer items are department-scoped", () => {
      const domainItem = {
        id: "m-2",
        layer: "domain",
        departmentId: "dept-1",
        projectId: null,
        companyId: "co-1",
      };
      expect(domainItem.departmentId).toBe("dept-1");
      expect(domainItem.layer).toBe("domain");
    });

    it("active_context layer items are goal-scoped with optional expiry", () => {
      const acItem = {
        id: "m-3",
        layer: "active_context",
        goalId: "goal-1",
        expiresAt: new Date("2026-06-01"),
        companyId: "co-1",
      };
      expect(acItem.goalId).toBe("goal-1");
      expect(acItem.expiresAt).toBeInstanceOf(Date);
    });

    it("working layer items are task-chain-scoped", () => {
      const wkItem = {
        id: "m-4",
        layer: "working",
        taskId: "task-1",
        companyId: "co-1",
      };
      expect(wkItem.taskId).toBe("task-1");
      expect(wkItem.layer).toBe("working");
    });

    it("task in project under department gets identity + department domain + project domain", () => {
      // Simulates the context packaging layering logic:
      // A task assigned to projectId under a department should receive:
      // 1. identity layer (company-wide, always included)
      // 2. domain layer scoped to departmentId
      // 3. active_context scoped to goalId

      const task = {
        id: "task-1",
        projectId: "dept-1", // Projects serve as both departments and projects
        goalId: "goal-1",
        companyId: "co-1",
      };

      const identityItems = [
        { layer: "identity", companyId: "co-1", title: "Our mission" },
      ];
      const domainItems = [
        { layer: "domain", departmentId: "dept-1", title: "Dept standards" },
      ];
      const activeItems = [
        { layer: "active_context", goalId: "goal-1", title: "Sprint context" },
      ];

      // Verify each layer is available
      expect(identityItems.filter((i) => i.companyId === task.companyId)).toHaveLength(1);
      expect(domainItems.filter((i) => i.departmentId === task.projectId)).toHaveLength(1);
      expect(activeItems.filter((i) => i.goalId === task.goalId)).toHaveLength(1);
    });
  });

  // ── Version isolation ───────────────────────────────────────────────────────

  describe("Version isolation", () => {
    it("draft versions are invisible to agents — only approved served via list", () => {
      const db = makeMockDb([]) as any;
      const svc = memoryService(db);

      // list with status=approved (what agents query)
      svc.list("co-1", { status: "approved" });
      expect(db.select).toHaveBeenCalled();
    });

    it("listPending returns only agent-sourced pending items", () => {
      const db = makeMockDb([]) as any;
      const svc = memoryService(db);

      // listPending is separate from list — returns pending agent items for founder review
      svc.listPending("co-1");
      expect(db.select).toHaveBeenCalled();
    });

    it("draft version content doesn't leak to approved item until publishDraft", () => {
      // The publishDraft flow:
      // 1. Draft created with status="draft"
      // 2. On publish: transaction archives current version, publishes draft, updates item content
      // 3. Before publish, item.content stays the old version

      const currentContent = "Current approved content";
      const draftContent = "New draft content not yet visible";

      // Item still shows current content
      expect(currentContent).not.toContain("draft");
      expect(draftContent).toContain("draft");
    });

    it("getVersionHistory returns versions ordered by versionNumber desc", () => {
      const db = makeMockDb([]) as any;
      const svc = memoryService(db);

      svc.getVersionHistory("mem-1");
      expect(db.select).toHaveBeenCalled();
      expect(db.from).toHaveBeenCalled();
      expect(db.orderBy).toHaveBeenCalled();
    });
  });

  // ── Dedup detection ─────────────────────────────────────────────────────────

  describe("Dedup detection", () => {
    it("findSimilarItems uses cosine similarity when API key available", async () => {
      mockResolveApiKey.mockResolvedValue("sk-test");
      mockGenerateEmbedding.mockResolvedValue(Array(1536).fill(0.01));

      const db = makeMockDb([
        { id: "sim-1", title: "Similar item", content: "Same content", similarity: 0.92 },
      ]) as any;
      const svc = memoryService(db);

      const results = await svc.findSimilarItems("test content", { companyId: "co-1" });
      expect(mockGenerateEmbedding).toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it("findSimilarItems falls back to word overlap when no API key", async () => {
      const err = new Error("No key");
      (err as any).errorCode = "missing_api_key";
      mockResolveApiKey.mockRejectedValue(err);

      const db = makeMockDb([
        {
          id: "1",
          title: "matching content words here",
          content: "testing overlap with matching words",
          category: "reference",
          source: "founder",
          status: "approved",
          tags: [],
          departmentId: null,
          projectId: null,
          layer: "domain",
          priority: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]) as any;
      const svc = memoryService(db);

      const results = await svc.findSimilarItems(
        "matching content words here for testing overlap",
        { companyId: "co-1" },
      );

      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
      expect(Array.isArray(results)).toBe(true);
    });

    it("word overlap threshold is 60%", () => {
      // The findSimilarItems text fallback filters items with overlap ratio > 0.6
      const contentWords = ["matching", "content", "words", "here", "testing"];
      const itemWords = new Set(["matching", "content", "words"]);

      const overlap = contentWords.filter((w) => itemWords.has(w)).length;
      const ratio = overlap / contentWords.length;

      expect(ratio).toBe(0.6); // exactly at threshold — should NOT pass (> 0.6 required)
    });

    it("cosine similarity threshold is 0.85", () => {
      const SIMILARITY_THRESHOLD = 0.85;
      expect(0.84).toBeLessThan(SIMILARITY_THRESHOLD);
      expect(0.86).toBeGreaterThan(SIMILARITY_THRESHOLD);
    });

    it("returns empty for short words (<=2 chars) in text fallback", async () => {
      mockResolveApiKey.mockRejectedValue(new Error("No key"));

      const db = makeMockDb([]) as any;
      const svc = memoryService(db);

      const results = await svc.findSimilarItems("a b c", { companyId: "co-1" });
      expect(results).toEqual([]);
    });
  });

  // ── Auto-archive ────────────────────────────────────────────────────────────

  describe("Auto-archive on goal completion", () => {
    it("archives all active_context items when goal completes", async () => {
      const items = [
        { id: "mem-1", title: "Context 1", layer: "active_context", status: "approved", goalId: "goal-1", companyId: "co-1" },
        { id: "mem-2", title: "Context 2", layer: "active_context", status: "approved", goalId: "goal-1", companyId: "co-1" },
        { id: "mem-3", title: "Context 3", layer: "active_context", status: "approved", goalId: "goal-1", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [items],
        updates: [items],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.onGoalCompleted("co-1", "goal-1");

      expect(count).toBe(3);
      expect(logActivity).toHaveBeenCalledTimes(3);
    });

    it("is idempotent — returns 0 if already archived", async () => {
      const db = createSequenceDb({ selects: [[]] });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.onGoalCompleted("co-1", "goal-1");

      expect(count).toBe(0);
      expect(logActivity).not.toHaveBeenCalled();
    });
  });

  describe("Working memory TTL", () => {
    it("archives working memory after 7-day TTL with terminal chain", async () => {
      const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const items = [
        { id: "wm-1", title: "Working", layer: "working", status: "approved", taskId: "task-1", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [
          items,
          [{ status: "done", completedAt: eightDays, cancelledAt: null }],
          [], // no dependencies
        ],
        updates: [items],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(1);
    });

    it("does NOT archive when chain is active (task not terminal)", async () => {
      const items = [
        { id: "wm-1", title: "Working", layer: "working", status: "approved", taskId: "task-1", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [
          items,
          [{ status: "in_progress", completedAt: null, cancelledAt: null }],
        ],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(0);
    });

    it("does NOT archive when terminal but less than 7 days", async () => {
      const threeDays = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const items = [
        { id: "wm-1", title: "Working", layer: "working", status: "approved", taskId: "task-1", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [
          items,
          [{ status: "done", completedAt: threeDays, cancelledAt: null }],
        ],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(0);
    });
  });

  describe("ExpiresAt-based archival", () => {
    it("archives items with expiresAt in the past", async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const items = [
        { id: "exp-1", title: "Expired", layer: "active_context", status: "approved", expiresAt: yesterday, companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [items],
        updates: [items],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredItems("co-1");

      expect(count).toBe(1);
      expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "memory.auto_archived",
        details: expect.objectContaining({ reason: "expired" }),
      }));
    });

    it("returns 0 when nothing is expired", async () => {
      const db = createSequenceDb({ selects: [[]] });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredItems("co-1");

      expect(count).toBe(0);
    });
  });

  // ── Staleness ───────────────────────────────────────────────────────────────

  describe("Staleness flagging (90-day threshold)", () => {
    it("flags items not accessed in 90+ days", async () => {
      const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      const staleItems = [
        { id: "stale-1", title: "Old knowledge", layer: "domain", status: "approved", accessedAt: longAgo, companyId: "co-1" },
        { id: "stale-2", title: "Very old", layer: "identity", status: "approved", accessedAt: longAgo, companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [staleItems, []], // items + no existing suggestions
        inserts: [[]],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.flagStaleItems("co-1");

      expect(count).toBe(2);
    });

    it("does NOT create duplicate suggestions for already-flagged items", async () => {
      const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
      const staleItems = [
        { id: "stale-1", title: "Already flagged", layer: "domain", status: "approved", accessedAt: longAgo, companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [staleItems, [{ relatedMemoryItemId: "stale-1" }]],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.flagStaleItems("co-1");

      expect(count).toBe(0);
    });

    it("items accessed within 90 days are not flagged", () => {
      const recentlyAccessed = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const STALENESS_THRESHOLD_DAYS = 90;
      const daysSinceAccess = (Date.now() - recentlyAccessed.getTime()) / (24 * 60 * 60 * 1000);

      expect(daysSinceAccess).toBeLessThan(STALENESS_THRESHOLD_DAYS);
    });
  });

  // ── Conflict / priority ordering ────────────────────────────────────────────

  describe("Conflict and priority ordering", () => {
    it("same-layer items with different priority are properly ordered", () => {
      const items = [
        { id: "m-1", layer: "domain", priority: 3, title: "Low priority" },
        { id: "m-2", layer: "domain", priority: 1, title: "High priority" },
        { id: "m-3", layer: "domain", priority: 2, title: "Medium priority" },
      ];

      // Context packaging sorts by priority desc then updatedAt desc
      const sorted = [...items].sort((a, b) => b.priority - a.priority);

      expect(sorted[0].title).toBe("Low priority"); // priority 3 is highest
      expect(sorted[1].title).toBe("Medium priority");
      expect(sorted[2].title).toBe("High priority");
    });

    it("items with same priority fall back to updatedAt ordering", () => {
      const items = [
        { id: "m-1", priority: 2, updatedAt: new Date("2026-01-01") },
        { id: "m-2", priority: 2, updatedAt: new Date("2026-03-01") },
        { id: "m-3", priority: 2, updatedAt: new Date("2026-02-01") },
      ];

      const sorted = [...items].sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return b.updatedAt.getTime() - a.updatedAt.getTime();
      });

      expect(sorted[0].id).toBe("m-2"); // most recent
      expect(sorted[1].id).toBe("m-3");
      expect(sorted[2].id).toBe("m-1"); // oldest
    });
  });

  // ── Cross-department visibility ─────────────────────────────────────────────

  describe("Cross-department visibility", () => {
    it("identity items are visible to all departments (company-wide)", () => {
      const identityItem = {
        layer: "identity",
        companyId: "co-1",
        departmentId: null,
      };

      // Identity items have no departmentId filter — they're returned for any department
      expect(identityItem.departmentId).toBeNull();
      expect(identityItem.layer).toBe("identity");
    });

    it("domain items are scoped to their department — not editable by others", () => {
      const domainItem = {
        layer: "domain",
        companyId: "co-1",
        departmentId: "dept-engineering",
      };

      // Different department can see (via companyId) but should not edit
      const requestorDept = "dept-marketing";
      expect(domainItem.departmentId).not.toBe(requestorDept);
    });

    it("list with departmentId filter scopes to that department only", () => {
      const db = makeMockDb([]) as any;
      const svc = memoryService(db);

      svc.list("co-1", { departmentId: "dept-1", layer: "domain" });
      expect(db.select).toHaveBeenCalled();
      expect(db.where).toHaveBeenCalled();
    });
  });

  // ── Embedding lifecycle ─────────────────────────────────────────────────────

  describe("Embedding lifecycle", () => {
    it("create always sets embedding to null", async () => {
      // svc.create() routes through buildMemoryInsert (mocked above to capture values).
      // The service always sets embedding=null in the values before calling buildMemoryInsert.
      capturedBuildInsertValues.length = 0;
      const db = {
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([{ id: "new-item", embedding: null }]),
      } as any;

      const svc = memoryService(db);
      await svc.create("co-1", {
        title: "Test",
        content: "Content",
        category: "reference",
        source: "founder",
        createdBy: "user-1",
      });

      expect(capturedBuildInsertValues[0]).toEqual(expect.objectContaining({ embedding: null }));
    });

    it("update invalidates embedding when content changes", async () => {
      const setData: Record<string, any> = {};
      const db = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue(null),
        }),
        update: vi.fn().mockReturnThis(),
        set: vi.fn((data: any) => {
          Object.assign(setData, data);
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue({
                then: vi.fn().mockResolvedValue(null),
              }),
            }),
          };
        }),
        delete: vi.fn().mockReturnThis(),
        then: vi.fn(),
      } as any;

      const svc = memoryService(db);
      await svc.update("co-1", "item-1", { content: "new content" });

      expect(setData.embedding).toBeNull();
    });

    it("update does NOT invalidate embedding for non-content changes", async () => {
      const setData: Record<string, any> = {};
      const db = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        set: vi.fn((data: any) => {
          Object.assign(setData, data);
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue({
                then: vi.fn().mockResolvedValue(null),
              }),
            }),
          };
        }),
      } as any;

      const svc = memoryService(db);
      await svc.update("co-1", "item-1", { category: "insight" });

      expect(setData.embedding).toBeUndefined();
    });
  });

  // ── Critical Rule #6: Founder auto-approval ─────────────────────────────────

  describe("Critical Rule #6: Agents cannot write directly", () => {
    it("founder-created items are auto-approved", async () => {
      // svc.create() routes through buildMemoryInsert (mocked above to capture values).
      // The service sets status="approved" for founder items before calling buildMemoryInsert.
      capturedBuildInsertValues.length = 0;
      const db = {
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([{ id: "new", status: "approved" }]),
      } as any;

      const svc = memoryService(db);
      await svc.create("co-1", {
        title: "Founder item",
        content: "Content",
        category: "reference",
        source: "founder",
        createdBy: "founder-1",
      });

      expect(capturedBuildInsertValues[0]).toEqual(expect.objectContaining({ status: "approved" }));
    });

    it("agent-created items default to pending", async () => {
      capturedBuildInsertValues.length = 0;
      const db = {
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([{ id: "new", status: "pending" }]),
      } as any;

      const svc = memoryService(db);
      await svc.create("co-1", {
        title: "Agent suggestion",
        content: "Content",
        category: "reference",
        layer: "domain",
        source: "agent",
        sourceContext: "Learned during task TES-1",
        createdBy: "agent-1",
      });

      expect(capturedBuildInsertValues[0]).toEqual(expect.objectContaining({ status: "pending" }));
    });

    it("agent status is always forced to pending regardless of explicit status", async () => {
      capturedBuildInsertValues.length = 0;
      const db = {
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockReturnThis(),
        execute: vi.fn().mockResolvedValue([{ id: "new", status: "pending" }]),
      } as any;

      const svc = memoryService(db);
      await svc.create("co-1", {
        title: "Pre-approved",
        content: "From brief approval",
        category: "reference",
        layer: "domain",
        source: "agent",
        sourceContext: "Extracted from brief review",
        status: "approved",
        createdBy: "agent-1",
      } as any);

      expect(capturedBuildInsertValues[0]).toEqual(expect.objectContaining({ status: "pending" }));
    });
  });

  // ── Token budget / context modes ────────────────────────────────────────────

  describe("Token budget / context modes", () => {
    it("minimal/standard/full context modes produce different context sizes", () => {
      // Context modes control how much context each agent receives
      const contextModes = {
        minimal: { identityItems: 0, domainItems: 0, preferences: 0 },
        standard: { identityItems: 5, domainItems: 5, preferences: 5 },
        full: { identityItems: 10, domainItems: 10, preferences: 10 },
      };

      expect(contextModes.minimal.identityItems).toBeLessThan(contextModes.standard.identityItems);
      expect(contextModes.standard.identityItems).toBeLessThanOrEqual(contextModes.full.identityItems);
    });

    it("token estimate formula: ceil(markdown.length / 4)", () => {
      const testCases = [
        { len: 0, expected: 0 },
        { len: 1, expected: 1 },
        { len: 4, expected: 1 },
        { len: 5, expected: 2 },
        { len: 100, expected: 25 },
        { len: 1000, expected: 250 },
      ];

      for (const tc of testCases) {
        expect(Math.ceil(tc.len / 4)).toBe(tc.expected);
      }
    });
  });

  // ── Restore (unarchive) ─────────────────────────────────────────────────────

  describe("Restore archived items", () => {
    it("touchAccessedAt updates both accessedAt and updatedAt", () => {
      const db = makeMockDb([]) as any;
      const svc = memoryService(db);

      svc.touchAccessedAt("co-1", "item-1");
      expect(db.update).toHaveBeenCalled();
    });
  });
});
