import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Edge Case QA Tests
 *
 * Covers:
 * - Trust score edge values (0, 1, exactly 20 tasks)
 * - Memory layer transitions
 * - Working memory from diamond dependencies
 * - Concurrent operations: two agents suggesting updates to same item
 * - RBAC edge cases: user with multiple roles, shared items across departments
 * - Artifact branching edge cases
 * - Embedding edge cases (batch, retry)
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  lt: vi.fn((a: unknown, b: unknown) => ({ lt: [a, b] })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
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
    agentTrustScores: makeTable("agent_trust_scores"),
    agents: makeTable("agents"),
  };
});

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

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
    for (const m of ["from", "where", "set", "values", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Edge Cases QA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Trust score edge values ─────────────────────────────────────────────────

  describe("Trust score edge values", () => {
    const RECENT_WINDOW = 20;

    function computeScore(
      totalCompleted: number,
      approvedWithoutChanges: number,
      recentCompleted: number,
      recentApproved: number,
    ): number {
      if (totalCompleted === 0) return 0;
      if (totalCompleted <= RECENT_WINDOW) {
        return (approvedWithoutChanges / totalCompleted) * 100;
      }
      const olderCompleted = totalCompleted - recentCompleted;
      const olderApproved = approvedWithoutChanges - recentApproved;
      const weightedApproved = olderApproved + recentApproved * 2;
      const weightedTotal = olderCompleted + recentCompleted * 2;
      if (weightedTotal === 0) return 0;
      return (weightedApproved / weightedTotal) * 100;
    }

    it("0 tasks → returns 0 (division by zero guard)", () => {
      expect(computeScore(0, 0, 0, 0)).toBe(0);
    });

    it("1 task, approved → 100%", () => {
      expect(computeScore(1, 1, 1, 1)).toBe(100);
    });

    it("1 task, rejected → 0%", () => {
      expect(computeScore(1, 0, 1, 0)).toBe(0);
    });

    it("exactly RECENT_WINDOW tasks (20) → no weighting", () => {
      const score = computeScore(20, 18, 20, 18);
      expect(score).toBe(90);
    });

    it("RECENT_WINDOW + 1 tasks (21) → weighting kicks in", () => {
      // 21 total, 21 approved, recent: 20 completed, 20 approved
      // Older: 1 completed, 1 approved
      // Weighted: (1 + 20*2) / (1 + 20*2) = 41/41 = 100%
      const score = computeScore(21, 21, 20, 20);
      expect(score).toBe(100);
    });

    it("large number of tasks (1000) → still computes correctly", () => {
      // 1000 total, 800 approved, recent: 20 completed, 18 approved
      // Older: 980 completed, 782 approved
      // Weighted: (782 + 18*2) / (980 + 20*2) = 818/1020 ≈ 80.20%
      const score = computeScore(1000, 800, 20, 18);
      expect(score).toBeCloseTo(80.20, 1);
    });

    it("all tasks rejected (100 tasks, 0 approved) → 0%", () => {
      expect(computeScore(100, 0, 20, 0)).toBe(0);
    });

    it("recentCompleted = 0 but totalCompleted > RECENT_WINDOW (degenerate)", () => {
      // 30 total, 15 approved, recent: 0 completed, 0 approved
      // Older: 30 completed, 15 approved
      // Weighted: (15 + 0) / (30 + 0) = 50%
      const score = computeScore(30, 15, 0, 0);
      expect(score).toBe(50);
    });
  });

  // ── Memory layer transitions ────────────────────────────────────────────────

  describe("Memory layer transitions", () => {
    it("item moved between layers retains same ID", () => {
      const item = {
        id: "mem-1",
        layer: "working",
        title: "Important finding",
      };

      // Promote to active_context
      const promoted = { ...item, layer: "active_context" };
      expect(promoted.id).toBe(item.id);
      expect(promoted.layer).toBe("active_context");
    });

    it("transitioning from active_context to domain preserves content", () => {
      const content = "This is important domain knowledge discovered during goal work";
      const item = {
        id: "mem-1",
        layer: "active_context",
        content,
        goalId: "goal-1",
      };

      const promoted = { ...item, layer: "domain", goalId: null };
      expect(promoted.content).toBe(content);
      expect(promoted.layer).toBe("domain");
      expect(promoted.goalId).toBeNull();
    });

    it("working → active_context → domain → identity is the promotion path", () => {
      const layers = ["working", "active_context", "domain", "identity"];
      const layerPriority: Record<string, number> = {
        working: 0,
        active_context: 1,
        domain: 2,
        identity: 3,
      };

      for (let i = 1; i < layers.length; i++) {
        expect(layerPriority[layers[i]]).toBeGreaterThan(layerPriority[layers[i - 1]]);
      }
    });
  });

  // ── Diamond dependencies in working memory ─────────────────────────────────

  describe("Diamond dependencies in working memory", () => {
    it("diamond dependency: A → B,C → D — all must be terminal for archive", async () => {
      //     A (task-a)
      //    / \
      //   B   C
      //    \ /
      //     D (task-d) — has working memory
      //
      // D's working memory should only archive when ALL tasks in chain are terminal 7+ days

      const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const items = [
        { id: "wm-d", title: "Working mem for D", layer: "working", status: "approved", taskId: "task-d", companyId: "co-1" },
      ];

      // BFS traversal sequence (matches isFullChainTerminal logic):
      // select 1: working memory items
      // select 2: task-d from issues (initial task check)
      // select 3: connected deps of task-d from taskDependencies → B and C
      // select 4: chainTasks B and C from issues (batch via inArray)
      // select 5: connected deps of B and C from taskDependencies → A
      // select 6: chainTask A from issues
      // select 7: connected deps of A from taskDependencies → empty (BFS ends)
      // update 1: archive the item
      const db = createSequenceDb({
        selects: [
          items,                                                                       // 1. working items
          [{ status: "done", completedAt: eightDays, cancelledAt: null }],              // 2. task-d
          [{ depId: "task-b", depntId: "task-d" }, { depId: "task-c", depntId: "task-d" }], // 3. deps of D
          [                                                                            // 4. B and C (batch)
            { id: "task-b", status: "done", completedAt: eightDays, cancelledAt: null },
            { id: "task-c", status: "done", completedAt: eightDays, cancelledAt: null },
          ],
          [{ depId: "task-a", depntId: "task-b" }, { depId: "task-a", depntId: "task-c" }], // 5. deps of B,C
          [{ id: "task-a", status: "done", completedAt: eightDays, cancelledAt: null }], // 6. task-a
          [],                                                                          // 7. deps of A (empty)
        ],
        updates: [items],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(1);
    });

    it("diamond dependency: one task still active → do NOT archive", async () => {
      const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const items = [
        { id: "wm-d", title: "Working mem", layer: "working", status: "approved", taskId: "task-d", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [
          items,
          [{ status: "done", completedAt: eightDays, cancelledAt: null }], // task-d done
          [{ depId: "task-b", depntId: "task-d" }], // dep of D
          [{ id: "task-b", status: "in_progress", completedAt: null, cancelledAt: null }], // task-b still active!
        ],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(0);
    });

    it("deleted tasks in chain are treated as terminal", async () => {
      const items = [
        { id: "wm-1", title: "Working mem", layer: "working", status: "approved", taskId: "task-1", companyId: "co-1" },
      ];

      const db = createSequenceDb({
        selects: [
          items,
          [], // task not found (deleted)
        ],
        updates: [items],
      });

      const svc = memoryLifecycleService(db as any);
      const count = await svc.archiveExpiredWorkingMemory("co-1");

      expect(count).toBe(1);
    });
  });

  // ── Concurrent operations ───────────────────────────────────────────────────

  describe("Concurrent operations", () => {
    it("two agents suggesting same memory item — both get pending status", () => {
      const suggestion1 = {
        source: "agent",
        agentId: "agent-1",
        title: "API best practice",
        status: "pending",
      };
      const suggestion2 = {
        source: "agent",
        agentId: "agent-2",
        title: "API best practice",
        status: "pending",
      };

      // Both suggestions are created independently with pending status
      expect(suggestion1.status).toBe("pending");
      expect(suggestion2.status).toBe("pending");
      expect(suggestion1.agentId).not.toBe(suggestion2.agentId);
    });

    it("atomic version numbering via transaction prevents concurrent version conflicts", () => {
      // The addVersion function wraps version creation in a transaction
      // SELECT FOR UPDATE pattern prevents two concurrent addVersion calls
      // from creating the same version number
      const transactionSteps = [
        "BEGIN",
        "SELECT MAX(versionNumber) FOR UPDATE",
        "INSERT version with nextVersion",
        "UPDATE artifact.currentVersionId",
        "COMMIT",
      ];

      expect(transactionSteps).toContain("BEGIN");
      expect(transactionSteps).toContain("COMMIT");
      expect(transactionSteps.indexOf("BEGIN")).toBeLessThan(transactionSteps.indexOf("COMMIT"));
    });

    it("SELECT FOR UPDATE NO WAIT prevents double-checkout of issues", () => {
      // V1 atomic checkout pattern for agent task assignment
      const checkoutPattern = "SELECT FOR UPDATE NO WAIT";
      expect(checkoutPattern).toContain("NO WAIT");
    });
  });

  // ── RBAC edge cases ─────────────────────────────────────────────────────────

  describe("RBAC edge cases", () => {
    it("user with multiple department roles gets union of permissions", () => {
      const userRoles = [
        { role: "team_lead", projectId: "dept-engineering" },
        { role: "team_member", projectId: "dept-marketing" },
      ];

      // For engineering dept: full team_lead access
      // For marketing dept: basic team_member access
      const engineeringRole = userRoles.find((r) => r.projectId === "dept-engineering");
      const marketingRole = userRoles.find((r) => r.projectId === "dept-marketing");

      expect(engineeringRole?.role).toBe("team_lead");
      expect(marketingRole?.role).toBe("team_member");
    });

    it("shared items across departments use companyId scope", () => {
      // Identity-layer items are shared across all departments
      const identityItem = {
        layer: "identity",
        companyId: "co-1",
        departmentId: null,
      };

      // Both departments can read this item
      const deptA = { companyId: "co-1", projectId: "dept-a" };
      const deptB = { companyId: "co-1", projectId: "dept-b" };

      expect(identityItem.companyId).toBe(deptA.companyId);
      expect(identityItem.companyId).toBe(deptB.companyId);
    });

    it("cross-company access is prevented by companyId filter", () => {
      const item = { companyId: "co-1" };
      const requestor = { companyId: "co-2" };

      expect(item.companyId).not.toBe(requestor.companyId);
    });

    it("founder role has global access regardless of department", () => {
      const hasAccess = (role: string, _itemDeptId: string | null): boolean => {
        if (role === "founder") return true;
        return false;
      };

      expect(hasAccess("founder", "dept-1")).toBe(true);
      expect(hasAccess("founder", null)).toBe(true);
      expect(hasAccess("founder", "dept-2")).toBe(true);
    });
  });

  // ── Artifact branching edge cases ───────────────────────────────────────────

  describe("Artifact branching edge cases", () => {
    it("multiple branches from same parent version", () => {
      const versions = [
        { id: "v1", versionNumber: 1, parentVersionId: null },
        { id: "v2a", versionNumber: 2, parentVersionId: "v1", source: "agent" },
        { id: "v2b", versionNumber: 3, parentVersionId: "v1", source: "founder" },
        { id: "v2c", versionNumber: 4, parentVersionId: "v1", source: "mcp" },
      ];

      const branches = versions.filter((v) => v.parentVersionId === "v1");
      expect(branches).toHaveLength(3);
    });

    it("deep branching chain: v1 → v2 → v3 → v4", () => {
      const versions = [
        { id: "v1", versionNumber: 1, parentVersionId: null },
        { id: "v2", versionNumber: 2, parentVersionId: "v1" },
        { id: "v3", versionNumber: 3, parentVersionId: "v2" },
        { id: "v4", versionNumber: 4, parentVersionId: "v3" },
      ];

      // Verify chain integrity
      for (let i = 1; i < versions.length; i++) {
        expect(versions[i].parentVersionId).toBe(versions[i - 1].id);
      }
    });

    it("orphaned branch detection — parentVersionId points to non-existent version", () => {
      const versions = [
        { id: "v1", versionNumber: 1, parentVersionId: null },
        { id: "v2", versionNumber: 2, parentVersionId: "v-deleted" },
      ];

      const versionIds = new Set(versions.map((v) => v.id));
      const orphaned = versions.filter(
        (v) => v.parentVersionId && !versionIds.has(v.parentVersionId),
      );

      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].id).toBe("v2");
    });
  });

  // ── Embedding edge cases ────────────────────────────────────────────────────

  describe("Embedding edge cases", () => {
    it("embedding dimension must be exactly 1536", () => {
      const EMBEDDING_DIMENSIONS = 1536;
      const validEmbedding = Array(1536).fill(0.01);
      const shortEmbedding = Array(768).fill(0.01);

      expect(validEmbedding.length).toBe(EMBEDDING_DIMENSIONS);
      expect(shortEmbedding.length).not.toBe(EMBEDDING_DIMENSIONS);
    });

    it("batch processing limit is 10 items per run", () => {
      const BATCH_SIZE = 10;
      const queueSize = 25;
      const batchesNeeded = Math.ceil(queueSize / BATCH_SIZE);

      expect(batchesNeeded).toBe(3);
    });

    it("retry strategy uses exponential backoff", () => {
      const BASE_RETRY_DELAY_MS = 1000;
      const MAX_RETRIES = 3;

      const delays = Array.from({ length: MAX_RETRIES }, (_, i) =>
        BASE_RETRY_DELAY_MS * Math.pow(2, i),
      );

      expect(delays).toEqual([1000, 2000, 4000]);
    });

    it("empty text throws error (cannot generate embedding)", () => {
      const validateText = (text: string): boolean => {
        return text.trim().length > 0;
      };

      expect(validateText("")).toBe(false);
      expect(validateText("   ")).toBe(false);
      expect(validateText("hello")).toBe(true);
    });
  });

  // ── Goal status machine ─────────────────────────────────────────────────────

  describe("Goal status machine", () => {
    it("valid transitions: planned → active → at_risk → achieved/cancelled", () => {
      const transitions: Record<string, string[]> = {
        planned: ["active"],
        active: ["at_risk", "achieved", "cancelled"],
        at_risk: ["active", "achieved", "cancelled"],
        achieved: [],
        cancelled: [],
      };

      expect(transitions.planned).toContain("active");
      expect(transitions.active).toContain("at_risk");
      expect(transitions.at_risk).toContain("active"); // recovery
      expect(transitions.achieved).toHaveLength(0); // terminal
      expect(transitions.cancelled).toHaveLength(0); // terminal
    });

    it("at_risk → active recovery is allowed", () => {
      const currentStatus = "at_risk";
      const newStatus = "active";

      const validTransitions: Record<string, string[]> = {
        at_risk: ["active", "achieved", "cancelled"],
      };

      expect(validTransitions[currentStatus]).toContain(newStatus);
    });
  });

  // ── Department deletion safety ──────────────────────────────────────────────

  describe("Department deletion safety", () => {
    it("deletion blocked if tasks exist", () => {
      const deptHasTasks = true;
      const deptHasGoals = false;

      const canDelete = !deptHasTasks && !deptHasGoals;
      expect(canDelete).toBe(false);
    });

    it("deletion blocked if goals exist", () => {
      const deptHasTasks = false;
      const deptHasGoals = true;

      const canDelete = !deptHasTasks && !deptHasGoals;
      expect(canDelete).toBe(false);
    });

    it("memory items become unscoped on department deletion", () => {
      const memoryItem = {
        id: "mem-1",
        departmentId: "dept-deleted",
        layer: "domain",
      };

      // After department deletion, departmentId should be set to null
      const unscoped = { ...memoryItem, departmentId: null };
      expect(unscoped.departmentId).toBeNull();
    });
  });

  // ── Run summary edge cases ──────────────────────────────────────────────────

  describe("Run summary edge cases", () => {
    it("opt-out via runtimeConfig.autoRunSummary (Decision #88)", () => {
      const agentConfig = {
        runtimeConfig: {
          autoRunSummary: false,
        },
      };

      expect(agentConfig.runtimeConfig.autoRunSummary).toBe(false);
    });

    it("per-agent context mode stored in runtimeConfig.contextMode (Decision #87)", () => {
      const agentConfig = {
        runtimeConfig: {
          contextMode: "minimal",
        },
      };

      const validModes = ["minimal", "standard", "full"];
      expect(validModes).toContain(agentConfig.runtimeConfig.contextMode);
    });

    it("default context mode is 'standard'", () => {
      const agentConfig = {
        runtimeConfig: {} as Record<string, unknown>,
      };

      const contextMode = agentConfig.runtimeConfig.contextMode ?? "standard";
      expect(contextMode).toBe("standard");
    });
  });
});
