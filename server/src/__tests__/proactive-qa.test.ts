import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProactiveDb } from "./helpers/mock-db.js";

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Proactive Agent QA", () => {
  // ── 1. Morning digest: full digest with activity, tasks, reminders ───────
  it("morning digest: 5 overnight activities + 3 active tasks + 2 pending reminders produces full digest", async () => {
    const overnightActivity = [
      { action: "task.completed", details: { title: "Deploy API" } },
      { action: "task.created", details: { title: "New feature" } },
      { action: "agent.run_completed", details: { agentId: "a-1" } },
      { action: "task.status_changed", details: { from: "todo", to: "in_progress" } },
      { action: "debrief.processed", details: { briefId: "b-1" } },
    ];
    const activeTasks = [
      { id: "t-1", title: "Active task 1", status: "in_progress" },
      { id: "t-2", title: "Active task 2", status: "in_progress" },
      { id: "t-3", title: "Active task 3", status: "in_progress" },
    ];
    const pendingReminders = [
      { id: "r-1", content: "Follow up on project" },
      { id: "r-2", content: "Review proposal" },
    ];

    const db = createProactiveDb(
      [
        overnightActivity, // overnight activity from activityLog
        activeTasks,       // in_progress tasks
        pendingReminders,  // pending reminders
      ],
      [
        [{ id: "run-1" }], // run record
      ],
    );

    const result = await morningDigest(db as any, "company-1", "user-1");

    expect(result.digest).toBeDefined();
    expect(result.digest.overnightActivity).toHaveLength(5);
    expect(result.digest.activeTasks).toHaveLength(3);
    expect(result.digest.pendingReminders).toHaveLength(2);
    expect(result.runCreated).toBe(true);
    // Verify all 3 selects + 1 insert (run record) happened
    expect(db.select).toHaveBeenCalledTimes(3);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  // ── 2. Morning digest with empty state ──────────────────────────────────
  it("morning digest with empty state: no activity still returns valid digest with empty arrays", async () => {
    const db = createProactiveDb(
      [
        [], // no overnight activity
        [], // no active tasks
        [], // no pending reminders
      ],
      [
        [{ id: "run-1" }], // run record
      ],
    );

    const result = await morningDigest(db as any, "company-1", "user-1");

    expect(result.digest).toBeDefined();
    expect(result.digest.overnightActivity).toHaveLength(0);
    expect(result.digest.activeTasks).toHaveLength(0);
    expect(result.digest.pendingReminders).toHaveLength(0);
    expect(result.runCreated).toBe(true);
  });

  // ── 3. blockedTaskScan finds 3 blocked tasks, notifications created ─────
  it("blockedTaskScan finds 3 blocked tasks and creates notification", async () => {
    const blockedTasks = [
      { id: "task-1", title: "Blocked task A", status: "in_progress" },
      { id: "task-2", title: "Blocked task B", status: "in_progress" },
      { id: "task-3", title: "Blocked task C", status: "in_progress" },
    ];

    const db = createProactiveDb(
      [
        [{ notificationPreference: "realtime" }], // getNotificationPreference
        blockedTasks,                              // select blocked tasks
      ],
      [
        [{ id: "run-1" }],  // insert run record
        [{ id: "notif-1" }], // insert notification
      ],
    );

    const result = await blockedTaskScan(db as any, "company-1", "user-1");

    expect(result.findings).toHaveLength(3);
    expect(result.runCreated).toBe(true);
    // 1 run record insert + 1 notification insert
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  // ── 4. Budget alert cascading: both budget and stale checks create runs ──
  it("budget alert at 85% + stale work found: both create independent run records", async () => {
    // Budget check
    const budgetDb = createProactiveDb(
      [
        [{ notificationPreference: "realtime" }], // getNotificationPreference
        [{ budgetMonthlyCents: 10000, spentMonthlyCents: 8500 }], // config at 85%
      ],
      [
        [{ id: "budget-run-1" }], // run record
        [{ id: "budget-notif-1" }], // notification
      ],
    );

    const budgetResult = await budgetThresholdAlert(budgetDb as any, "company-1", "user-1");

    expect(budgetResult.triggered).toBe(true);
    expect(budgetResult.percentUsed).toBe(85);
    expect(budgetResult.runCreated).toBe(true);
    expect(budgetDb.insert).toHaveBeenCalledTimes(2);

    // Stale work check (independently)
    const staleTasks = [
      { id: "task-1", title: "Stale A", updatedAt: new Date("2026-03-10") },
      { id: "task-2", title: "Stale B", updatedAt: new Date("2026-03-12") },
    ];

    const staleDb = createProactiveDb(
      [
        [{ notificationPreference: "realtime" }],
        staleTasks,
      ],
      [
        [{ id: "stale-run-1" }],
        [{ id: "stale-notif-1" }],
      ],
    );

    const staleResult = await staleWorkDetection(staleDb as any, "company-1", "user-1");

    expect(staleResult.findings).toHaveLength(2);
    expect(staleResult.runCreated).toBe(true);
    expect(staleDb.insert).toHaveBeenCalledTimes(2);
  });

  // ── 5. Multiple proactive checks in sequence: all 8 create run records ──
  it("all 8 proactive checks in sequence each create their own run record", async () => {
    // blockedTaskScan
    const db1 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "run-blocked" }]],
    );
    const r1 = await blockedTaskScan(db1 as any, "co-1", "u-1");
    expect(r1.runCreated).toBe(true);

    // budgetThresholdAlert
    const db2 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], [{ budgetMonthlyCents: 10000, spentMonthlyCents: 2000 }]],
      [[{ id: "run-budget" }]],
    );
    const r2 = await budgetThresholdAlert(db2 as any, "co-1", "u-1");
    expect(r2.runCreated).toBe(true);

    // staleWorkDetection
    const db3 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "run-stale" }]],
    );
    const r3 = await staleWorkDetection(db3 as any, "co-1", "u-1");
    expect(r3.runCreated).toBe(true);

    // dependencyChainGaps
    const db4 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "run-deps" }]],
    );
    const r4 = await dependencyChainGaps(db4 as any, "co-1", "u-1");
    expect(r4.runCreated).toBe(true);

    // memoryConflictScan
    const db5 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "run-memory" }]],
    );
    const r5 = await memoryConflictScan(db5 as any, "co-1", "u-1");
    expect(r5.runCreated).toBe(true);

    // workloadImbalance
    const db6 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "run-workload" }]],
    );
    const r6 = await workloadImbalance(db6 as any, "co-1", "u-1");
    expect(r6.runCreated).toBe(true);

    // morningDigest
    const db7 = createProactiveDb(
      [[], [], []],
      [[{ id: "run-digest" }]],
    );
    const r7 = await morningDigest(db7 as any, "co-1", "u-1");
    expect(r7.runCreated).toBe(true);

    // checkReminders
    const db8 = createProactiveDb(
      [[]],
      [[{ id: "run-reminders" }]],
    );
    const r8 = await checkReminders(db8 as any, "co-1");
    expect(r8.runCreated).toBe(true);
  });

  // ── 6. Reminder batch: 5 due reminders fire simultaneously ──────────────
  it("5 due reminders fire simultaneously with firedCount=5 and 5 notifications", async () => {
    const dueReminders = [
      { id: "rem-1", userId: "user-1", content: "Follow up on project", triggerAt: new Date("2026-03-25") },
      { id: "rem-2", userId: "user-1", content: "Review proposal", triggerAt: new Date("2026-03-25") },
      { id: "rem-3", userId: "user-2", content: "Check budget", triggerAt: new Date("2026-03-25") },
      { id: "rem-4", userId: "user-1", content: "Deploy staging", triggerAt: new Date("2026-03-25") },
      { id: "rem-5", userId: "user-2", content: "Send report", triggerAt: new Date("2026-03-25") },
    ];

    const db = createProactiveDb(
      [
        dueReminders, // due reminders query
      ],
      [
        [{ id: "run-1" }],    // run record
        [{ id: "notif-1" }],  // notification for rem-1
        [{ id: "notif-2" }],  // notification for rem-2
        [{ id: "notif-3" }],  // notification for rem-3
        [{ id: "notif-4" }],  // notification for rem-4
        [{ id: "notif-5" }],  // notification for rem-5
      ],
    );

    const result = await checkReminders(db as any, "company-1");

    expect(result.firedCount).toBe(5);
    expect(result.runCreated).toBe(true);
    // 1 run record + 5 notifications = 6 inserts
    expect(db.insert).toHaveBeenCalledTimes(6);
    // 5 reminder updates (mark as fired)
    expect(db.update).toHaveBeenCalledTimes(5);
  });

  // ── 7. Silent mode suppresses notifications ─────────────────────────────
  it("silent mode: runs still created but no notification inserts", async () => {
    const blockedTasks = [
      { id: "task-1", title: "Blocked", status: "in_progress" },
      { id: "task-2", title: "Blocked 2", status: "in_progress" },
    ];

    const db = createProactiveDb(
      [
        [{ notificationPreference: "silent" }], // silent preference
        blockedTasks,
      ],
      [
        [{ id: "run-1" }], // run record only (no notification)
      ],
    );

    const result = await blockedTaskScan(db as any, "company-1", "user-1");

    expect(result.findings).toHaveLength(2);
    expect(result.runCreated).toBe(true);
    // Only 1 insert for the run record, no notification
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  // ── 8. Workload imbalance with many agents ──────────────────────────────
  it("workload imbalance: 10 agents, one with 50 tasks, rest with 2 each is detected", async () => {
    // Agent-overloaded has 50 tasks, agents 2-10 have 2 each = 50 + 18 = 68 total, 10 agents
    // avg = 68 / 10 = 6.8, threshold = 6.8 * 3 = 20.4, agent-overloaded has 50 > 20.4 = detected
    const tasks = [
      ...Array.from({ length: 50 }, () => ({ assigneeAgentId: "agent-overloaded" })),
      ...Array.from({ length: 2 }, () => ({ assigneeAgentId: "agent-2" })),
      ...Array.from({ length: 2 }, () => ({ assigneeAgentId: "agent-3" })),
      ...Array.from({ length: 2 }, () => ({ assigneeAgentId: "agent-4" })),
      ...Array.from({ length: 2 }, () => ({ assigneeAgentId: "agent-5" })),
      ...Array.from({ length: 2 }, () => ({ assigneeAgentId: "agent-6" })),
      ...Array.from({ length: 2 }, () => ({ assigneeAgentId: "agent-7" })),
      ...Array.from({ length: 2 }, () => ({ assigneeAgentId: "agent-8" })),
      ...Array.from({ length: 2 }, () => ({ assigneeAgentId: "agent-9" })),
      ...Array.from({ length: 2 }, () => ({ assigneeAgentId: "agent-10" })),
    ];

    const db = createProactiveDb(
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

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toEqual(["agent-overloaded", 50]);
    expect(result.runCreated).toBe(true);
  });

  // ── 9. Memory conflict: 5 patterns with >=3 occurrences all flagged ─────
  it("memory conflict scan: 5 patterns with >=3 occurrences are all flagged", async () => {
    const conflicts = [
      { id: "p-1", patternType: "tone_correction", occurrenceCount: 3, status: "detected" },
      { id: "p-2", patternType: "format_change", occurrenceCount: 5, status: "detected" },
      { id: "p-3", patternType: "content_addition", occurrenceCount: 4, status: "detected" },
      { id: "p-4", patternType: "terminology_change", occurrenceCount: 7, status: "detected" },
      { id: "p-5", patternType: "tone_correction", occurrenceCount: 10, status: "detected" },
    ];

    const db = createProactiveDb(
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

    expect(result.findings).toHaveLength(5);
    expect(result.runCreated).toBe(true);
    // All 5 patterns returned
    expect(result.findings.map((f: any) => f.id)).toEqual(["p-1", "p-2", "p-3", "p-4", "p-5"]);
  });

  // ── 10. Dependency chain gap: cancelled task with STILL-blocked dependents ──
  // A-H9: a cancelled dependency now releases its dependents. The residual gap
  // is a dependent that is STILL `blocked` even though its (only) dependency is
  // terminal — the auto-release should have fired but the task is stuck.
  it("dependency chain gap: still-blocked dependents of a cancelled task are all flagged", async () => {
    // task-cancelled is depended on by task-1, task-2, task-3 — all still blocked
    const allDeps = [
      { dependentId: "task-1", dependencyId: "task-cancelled" },
      { dependentId: "task-2", dependencyId: "task-cancelled" },
      { dependentId: "task-3", dependencyId: "task-cancelled" },
    ];
    // New query shape: statuses of every task in a dependency edge.
    const issueStatuses = [
      { id: "task-1", status: "blocked" },
      { id: "task-2", status: "blocked" },
      { id: "task-3", status: "blocked" },
      { id: "task-cancelled", status: "cancelled" },
    ];

    const db = createProactiveDb(
      [
        [{ notificationPreference: "realtime" }],
        allDeps,        // all dependencies for company
        issueStatuses,  // statuses for every involved task
      ],
      [
        [{ id: "run-1" }],
        [{ id: "notif-1" }],
      ],
    );

    const result = await dependencyChainGaps(db as any, "company-1", "user-1");

    expect(result.findings).toHaveLength(3);
    expect(result.runCreated).toBe(true);
    // All 3 dependents are stuck blocked behind the terminal (cancelled) task
    for (const gap of result.findings as any[]) {
      expect(gap.dependencyId).toBe("task-cancelled");
    }
  });

  // ── 10b. A-H9: released dependents of a cancelled task are NOT gaps ─────────
  it("dependency chain gap: released dependents of a cancelled task produce no gaps", async () => {
    const allDeps = [
      { dependentId: "task-1", dependencyId: "task-cancelled" },
      { dependentId: "task-2", dependencyId: "task-cancelled" },
    ];
    // Dependents were released (todo), cancelled dep is satisfied → no gap.
    const issueStatuses = [
      { id: "task-1", status: "todo" },
      { id: "task-2", status: "in_progress" },
      { id: "task-cancelled", status: "cancelled" },
    ];

    const db = createProactiveDb(
      [
        [{ notificationPreference: "realtime" }],
        allDeps,
        issueStatuses,
      ],
      [
        [{ id: "run-1" }],
      ],
    );

    const result = await dependencyChainGaps(db as any, "company-1", "user-1");

    expect(result.findings).toHaveLength(0);
    expect(result.runCreated).toBe(true);
  });

  // ── 11. Stale work: 5 tasks stale for 7+ days all flagged ──────────────
  it("stale work detection: 5 tasks stale for 7+ days are all flagged", async () => {
    const staleTasks = [
      { id: "task-1", title: "Stale A", updatedAt: new Date("2026-03-10"), status: "in_progress" },
      { id: "task-2", title: "Stale B", updatedAt: new Date("2026-03-08"), status: "in_progress" },
      { id: "task-3", title: "Stale C", updatedAt: new Date("2026-03-05"), status: "in_progress" },
      { id: "task-4", title: "Stale D", updatedAt: new Date("2026-03-01"), status: "in_progress" },
      { id: "task-5", title: "Stale E", updatedAt: new Date("2026-02-28"), status: "in_progress" },
    ];

    const db = createProactiveDb(
      [
        [{ notificationPreference: "realtime" }],
        staleTasks,
      ],
      [
        [{ id: "run-1" }],
        [{ id: "notif-1" }],
      ],
    );

    const result = await staleWorkDetection(db as any, "company-1", "user-1");

    expect(result.findings).toHaveLength(5);
    expect(result.runCreated).toBe(true);
    expect(db.insert).toHaveBeenCalledTimes(2); // run + notification
  });

  // ── 12. Empty company: all checks return empty/no findings ──────────────
  it("empty company: all checks return empty findings or no-trigger with no errors", async () => {
    // blockedTaskScan — empty
    const db1 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "r1" }]],
    );
    const r1 = await blockedTaskScan(db1 as any, "empty-co", "u-1");
    expect(r1.findings).toHaveLength(0);
    expect(r1.runCreated).toBe(true);

    // budgetThresholdAlert — no config
    const db2 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "r2" }]],
    );
    const r2 = await budgetThresholdAlert(db2 as any, "empty-co", "u-1");
    expect(r2.triggered).toBe(false);
    expect(r2.percentUsed).toBe(0);
    expect(r2.runCreated).toBe(true);

    // staleWorkDetection — empty
    const db3 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "r3" }]],
    );
    const r3 = await staleWorkDetection(db3 as any, "empty-co", "u-1");
    expect(r3.findings).toHaveLength(0);
    expect(r3.runCreated).toBe(true);

    // dependencyChainGaps — no deps
    const db4 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "r4" }]],
    );
    const r4 = await dependencyChainGaps(db4 as any, "empty-co", "u-1");
    expect(r4.findings).toHaveLength(0);
    expect(r4.runCreated).toBe(true);

    // memoryConflictScan — empty
    const db5 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "r5" }]],
    );
    const r5 = await memoryConflictScan(db5 as any, "empty-co", "u-1");
    expect(r5.findings).toHaveLength(0);
    expect(r5.runCreated).toBe(true);

    // workloadImbalance — no tasks
    const db6 = createProactiveDb(
      [[{ notificationPreference: "realtime" }], []],
      [[{ id: "r6" }]],
    );
    const r6 = await workloadImbalance(db6 as any, "empty-co", "u-1");
    expect(r6.findings).toHaveLength(0);
    expect(r6.runCreated).toBe(true);

    // morningDigest — empty
    const db7 = createProactiveDb(
      [[], [], []],
      [[{ id: "r7" }]],
    );
    const r7 = await morningDigest(db7 as any, "empty-co", "u-1");
    expect(r7.digest.overnightActivity).toHaveLength(0);
    expect(r7.digest.activeTasks).toHaveLength(0);
    expect(r7.digest.pendingReminders).toHaveLength(0);
    expect(r7.runCreated).toBe(true);

    // checkReminders — none due
    const db8 = createProactiveDb(
      [[]],
      [[{ id: "r8" }]],
    );
    const r8 = await checkReminders(db8 as any, "empty-co");
    expect(r8.firedCount).toBe(0);
    expect(r8.runCreated).toBe(true);
  });
});
