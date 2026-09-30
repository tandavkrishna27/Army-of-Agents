import { beforeEach, describe, expect, it, vi } from "vitest";

// ── drizzle-orm mock ─────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((value: any) => ({ desc: value })),
  asc: vi.fn((value: any) => ({ asc: value })),
  lt: vi.fn((a: any, b: any) => ({ lt: [a, b] })),
  lte: vi.fn((a: any, b: any) => ({ lte: [a, b] })),
  gte: vi.fn((a: any, b: any) => ({ gte: [a, b] })),
  gt: vi.fn((a: any, b: any) => ({ gt: [a, b] })),
  ne: vi.fn((a: any, b: any) => ({ ne: [a, b] })),
  isNull: vi.fn((a: any) => ({ isNull: a })),
  isNotNull: vi.fn((a: any) => ({ isNotNull: a })),
  inArray: vi.fn((a: any, b: any) => ({ inArray: [a, b] })),
  notInArray: vi.fn((a: any, b: any) => ({ notInArray: [a, b] })),
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({
      sql: strings,
      values,
      as: vi.fn().mockReturnValue("aliased"),
    })),
    { raw: vi.fn((input: any) => input) },
  ),
  count: vi.fn(() => "count_col"),
}));

// ── DB table stubs ───────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => ({
  issues: {
    id: "issue_id",
    companyId: "issue_company_id",
    status: "issue_status",
    updatedAt: "issue_updated_at",
    assigneeAgentId: "issue_assignee_agent_id",
    projectId: "issue_project_id",
  },
  taskDependencies: {
    id: "dep_id",
    companyId: "dep_company_id",
    dependentIssueId: "dep_dependent_issue_id",
    dependencyIssueId: "dep_dependency_issue_id",
  },
  agents: {
    id: "agent_id",
    companyId: "agent_company_id",
    name: "agent_name",
  },
  internalAgentConfig: {
    id: "config_id",
    companyId: "config_company_id",
    budgetMonthlyCents: "config_budget_monthly_cents",
    spentMonthlyCents: "config_spent_monthly_cents",
    notificationPreference: "config_notification_preference",
  },
  internalAgentRuns: {
    id: "run_id",
    companyId: "run_company_id",
    triggerType: "run_trigger_type",
    triggerSource: "run_trigger_source",
    status: "run_status",
    createdAt: "run_created_at",
    completedAt: "run_completed_at",
  },
  internalAgentReminders: {
    id: "reminder_id",
    companyId: "reminder_company_id",
    userId: "reminder_user_id",
    status: "reminder_status",
    triggerAt: "reminder_trigger_at",
    firedRunId: "reminder_fired_run_id",
  },
  memoryFeedbackPatterns: {
    id: "mfp_id",
    companyId: "mfp_company_id",
    status: "mfp_status",
    occurrenceCount: "mfp_occurrence_count",
    patternType: "mfp_pattern_type",
  },
  activityLog: {
    id: "activity_id",
    companyId: "activity_company_id",
    createdAt: "activity_created_at",
    action: "activity_action",
    details: "activity_details",
  },
  notifications: {
    id: "notification_id",
  },
  // hubItems aliases the notifications table; proactive checks + reminders now
  // route through hubItemsService(db).emit which references these columns/tables.
  hubItems: {
    id: "hub_id",
    status: "hub_status",
    sourceUniqueKey: "hub_source_unique_key",
  },
  hubItemUserState: {},
  hubAudit: {},
  approvals: {},
  heartbeatRuns: {},
}));

// ── Sequence-based mock DB ───────────────────────────────────────────────────
function makeSelectChain(queue: any[]) {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    having: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (rows: any[]) => any) =>
      Promise.resolve(fn(queue.shift() ?? [])),
    ),
  };
}

function makeInsertChain(queue: any[]) {
  return {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(() =>
      Promise.resolve(queue.shift() ?? [{ id: "new-run-id" }]),
    ),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
  };
}

function makeUpdateChain() {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn(() => Promise.resolve([{ id: "updated" }])),
  };
}

function makeDb(
  selectQueue: any[],
  insertQueue: any[] = [],
) {
  return {
    // `select` and `selectDistinct` share the same FIFO queue so result-set
    // ordering is independent of which API a query uses (blockedTaskScan now
    // uses `selectDistinct` — A-M14).
    select: vi.fn(() => makeSelectChain(selectQueue)),
    selectDistinct: vi.fn(() => makeSelectChain(selectQueue)),
    insert: vi.fn(() => makeInsertChain(insertQueue)),
    update: vi.fn(() => makeUpdateChain()),
  };
}

import {
  blockedTaskScan,
  budgetThresholdAlert,
  staleWorkDetection,
  dependencyChainGaps,
  memoryConflictScan,
  workloadImbalance,
  morningDigest,
  checkReminders,
} from "../services/internal-agent/proactive.js";

describe("proactive checks", () => {
  // ── blockedTaskScan ──────────────────────────────────────────────────────
  describe("blockedTaskScan", () => {
    it("finds tasks that are in_progress with unresolved blocking dependencies", async () => {
      const blockedTasks = [
        { id: "task-1", title: "Blocked task", status: "in_progress" },
        { id: "task-2", title: "Another blocked", status: "in_progress" },
      ];

      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }], // getNotificationPreference
          blockedTasks, // select blocked tasks
        ],
        [
          [{ id: "run-1" }], // insert run record
          [{ id: "notif-1" }], // insert notification
        ],
      );

      const result = await blockedTaskScan(db as any, "company-1", "user-1");

      expect(result.findings).toHaveLength(2);
      expect(result.runCreated).toBe(true);
    });

    it("returns empty findings when no blocked tasks exist", async () => {
      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }], // getNotificationPreference
          [], // no blocked tasks
        ],
        [
          [{ id: "run-1" }], // run record still created
        ],
      );

      const result = await blockedTaskScan(db as any, "company-1", "user-1");

      expect(result.findings).toHaveLength(0);
      expect(result.runCreated).toBe(true);
    });

    it("skips notification when preference is silent", async () => {
      const blockedTasks = [
        { id: "task-1", title: "Blocked", status: "in_progress" },
      ];

      const db = makeDb(
        [
          [{ notificationPreference: "silent" }], // silent preference
          blockedTasks,
        ],
        [
          [{ id: "run-1" }],
        ],
      );

      const result = await blockedTaskScan(db as any, "company-1", "user-1");

      expect(result.findings).toHaveLength(1);
      // Notification insert should NOT have been called (only 1 insert for run)
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  // ── budgetThresholdAlert ─────────────────────────────────────────────────
  describe("budgetThresholdAlert", () => {
    it("triggers alert when spend reaches 80% of budget", async () => {
      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }], // getNotificationPreference
          // config with budget (second select for budgetThresholdAlert itself)
          [{ budgetMonthlyCents: 10000, spentMonthlyCents: 8500 }],
        ],
        [
          [{ id: "run-1" }], // run record
          [{ id: "notif-1" }], // notification
        ],
      );

      const result = await budgetThresholdAlert(db as any, "company-1", "user-1");

      expect(result.triggered).toBe(true);
      expect(result.percentUsed).toBeGreaterThanOrEqual(80);
    });

    it("does not trigger when spend is below 80%", async () => {
      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          [{ budgetMonthlyCents: 10000, spentMonthlyCents: 5000 }],
        ],
        [
          [{ id: "run-1" }],
        ],
      );

      const result = await budgetThresholdAlert(db as any, "company-1", "user-1");

      expect(result.triggered).toBe(false);
      expect(result.percentUsed).toBeLessThan(80);
    });

    it("does not trigger when budget is unlimited (null)", async () => {
      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          [{ budgetMonthlyCents: null, spentMonthlyCents: 50000 }],
        ],
        [
          [{ id: "run-1" }],
        ],
      );

      const result = await budgetThresholdAlert(db as any, "company-1", "user-1");

      expect(result.triggered).toBe(false);
    });
  });

  // ── staleWorkDetection ───────────────────────────────────────────────────
  describe("staleWorkDetection", () => {
    it("finds tasks in_progress with no activity for 3+ days", async () => {
      const staleTasks = [
        { id: "task-1", title: "Stale task", updatedAt: new Date("2026-03-20") },
      ];

      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          staleTasks, // stale tasks found
        ],
        [
          [{ id: "run-1" }],
          [{ id: "notif-1" }],
        ],
      );

      const result = await staleWorkDetection(db as any, "company-1", "user-1");

      expect(result.findings).toHaveLength(1);
      expect(result.runCreated).toBe(true);
    });
  });

  // ── dependencyChainGaps ──────────────────────────────────────────────────
  describe("dependencyChainGaps", () => {
    it("flags a still-blocked dependent whose only dependency is cancelled (release failed to fire)", async () => {
      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          // All dependencies for company
          [
            { dependentId: "task-1", dependencyId: "task-2" },
            { dependentId: "task-3", dependencyId: "task-4" },
          ],
          // Issue statuses: task-1 still blocked, task-2 cancelled (terminal);
          // task-3 blocked, task-4 in_progress (normal blocking → not a gap)
          [
            { id: "task-1", status: "blocked" },
            { id: "task-2", status: "cancelled" },
            { id: "task-3", status: "blocked" },
            { id: "task-4", status: "in_progress" },
          ],
        ],
        [
          [{ id: "run-1" }],
          [{ id: "notif-1" }],
        ],
      );

      const result = await dependencyChainGaps(db as any, "company-1", "user-1");

      // Only task-1 is a gap: blocked with all deps terminal. task-3 is
      // correctly blocked by a non-terminal dep.
      expect(result.findings).toHaveLength(1);
      expect(result.runCreated).toBe(true);
    });

    it("does NOT flag a cancelled dependency once its dependent has been released (A-H9)", async () => {
      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          [{ dependentId: "task-1", dependencyId: "task-2" }],
          // task-2 cancelled, but task-1 was released → now todo, not blocked
          [
            { id: "task-1", status: "todo" },
            { id: "task-2", status: "cancelled" },
          ],
        ],
        [
          [{ id: "run-1" }],
        ],
      );

      const result = await dependencyChainGaps(db as any, "company-1", "user-1");

      // Cancelled = satisfied (A-H9), released dependent is not blocked → no gap
      expect(result.findings).toHaveLength(0);
    });

    it("returns empty when no dependencies exist", async () => {
      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          [], // no deps
        ],
        [
          [{ id: "run-1" }],
        ],
      );

      const result = await dependencyChainGaps(db as any, "company-1", "user-1");

      expect(result.findings).toHaveLength(0);
    });
  });

  // ── memoryConflictScan ───────────────────────────────────────────────────
  describe("memoryConflictScan", () => {
    it("finds memory feedback patterns with 3+ occurrences", async () => {
      const conflicts = [
        { id: "p-1", patternType: "tone_correction", occurrenceCount: 5, status: "detected" },
      ];

      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          conflicts,
        ],
        [
          [{ id: "run-1" }],
          [{ id: "notif-1" }],
        ],
      );

      const result = await memoryConflictScan(db as any, "company-1", "user-1");

      expect(result.findings).toHaveLength(1);
      expect(result.runCreated).toBe(true);
    });

    it("returns empty when no conflict patterns exist", async () => {
      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          [],
        ],
        [
          [{ id: "run-1" }],
        ],
      );

      const result = await memoryConflictScan(db as any, "company-1", "user-1");

      expect(result.findings).toHaveLength(0);
    });
  });

  // ── workloadImbalance ────────────────────────────────────────────────────
  describe("workloadImbalance", () => {
    it("detects agents with >3x average task count", async () => {
      // Agent-1 has 10 tasks, Agent-2 has 2, Agent-3 has 1 → avg ~4.3, Agent-1 is >3x avg? No.
      // Better: Agent-1 has 10 tasks, Agent-2 has 1 → avg 5.5, Agent-1 not >3x.
      // Agent-1 has 20 tasks, Agent-2 has 1 → avg 10.5, Agent-1 is ~1.9x. Not enough.
      // Need: Agent-1 has 10 tasks, Agent-2 has 1, Agent-3 has 1 → avg ~4, 10 > 4*3=12? No.
      // Agent-1 has 15, Agent-2 has 1, Agent-3 has 1 → avg ~5.67, 15 > 17? No.
      // Agent-1 has 30, Agent-2 has 1, Agent-3 has 1 → avg ~10.67, 30 > 32? No.
      // Simpler: Agent-1 has 10, Agent-2 has 1 → avg 5.5, 10 > 16.5? No. Need more agents.
      // Agent-1 has 10, all others have 1 each (5 agents) → total 14, avg 2.8, 10 > 8.4? Yes!
      const tasks = [
        ...Array.from({ length: 10 }, () => ({ assigneeAgentId: "agent-1" })),
        { assigneeAgentId: "agent-2" },
        { assigneeAgentId: "agent-3" },
        { assigneeAgentId: "agent-4" },
        { assigneeAgentId: "agent-5" },
      ];

      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          tasks,
        ],
        [
          [{ id: "run-1" }],
          [{ id: "notif-1" }],
        ],
      );

      const result = await workloadImbalance(db as any, "company-1", "user-1");

      // avg = 14/5 = 2.8, agent-1 has 10 > 2.8*3 = 8.4 → imbalanced
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toEqual(["agent-1", 10]);
    });

    it("returns empty when workload is balanced", async () => {
      const tasks = [
        { assigneeAgentId: "agent-1" },
        { assigneeAgentId: "agent-1" },
        { assigneeAgentId: "agent-2" },
        { assigneeAgentId: "agent-2" },
      ];

      const db = makeDb(
        [
          [{ notificationPreference: "realtime" }],
          tasks,
        ],
        [
          [{ id: "run-1" }],
        ],
      );

      const result = await workloadImbalance(db as any, "company-1", "user-1");

      expect(result.findings).toHaveLength(0);
    });
  });

  // ── morningDigest ────────────────────────────────────────────────────────
  describe("morningDigest", () => {
    it("generates summary from activity log", async () => {
      const db = makeDb(
        [
          // overnight activity from activityLog
          [
            { action: "task.completed", details: { title: "Deploy API" } },
            { action: "task.created", details: { title: "New feature" } },
          ],
          // in_progress tasks
          [{ id: "t-1", title: "Active task" }],
          // pending reminders
          [{ id: "r-1", content: "Follow up" }],
        ],
        [
          [{ id: "run-1" }], // run record
        ],
      );

      const result = await morningDigest(db as any, "company-1", "user-1");

      expect(result.digest).toBeDefined();
      expect(result.digest.overnightActivity).toHaveLength(2);
      expect(result.digest.activeTasks).toHaveLength(1);
      expect(result.digest.pendingReminders).toHaveLength(1);
      expect(result.runCreated).toBe(true);
    });
  });

  // ── checkReminders ───────────────────────────────────────────────────────
  describe("checkReminders", () => {
    it("fires due reminders and creates notifications", async () => {
      const dueReminders = [
        {
          id: "rem-1",
          userId: "user-1",
          content: "Follow up on project",
          triggerAt: new Date("2026-03-25"),
        },
      ];

      const db = makeDb(
        [
          dueReminders, // due reminders
        ],
        [
          [{ id: "run-1" }], // run record
          [{ id: "notif-1" }], // notification
        ],
      );

      const result = await checkReminders(db as any, "company-1");

      expect(result.firedCount).toBe(1);
      expect(result.runCreated).toBe(true);
    });

    it("returns 0 fired when no reminders are due", async () => {
      const db = makeDb(
        [
          [], // no due reminders
        ],
        [
          [{ id: "run-1" }],
        ],
      );

      const result = await checkReminders(db as any, "company-1");

      expect(result.firedCount).toBe(0);
    });
  });
});
