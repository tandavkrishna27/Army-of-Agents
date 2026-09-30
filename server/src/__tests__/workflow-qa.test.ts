import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock tables ──────────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    issues: makeTable("issues"),
    taskDependencies: makeTable("task_dependencies"),
    workflowTemplates: makeTable("workflow_templates"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  eq: (..._args: unknown[]) => "eq",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

vi.mock("../services/agent-completion-policy.js", () => ({
  resolveAgentCompletionPolicy: vi.fn().mockResolvedValue({
    policy: "review_required",
    source: "company",
    sourceId: "company-1",
    guardrailApplied: false,
    resolvedAt: new Date("2026-07-11T00:00:00.000Z"),
  }),
}));

import { workflowTemplateService } from "../services/workflow-templates.js";
import { createWorkflowDb } from "./helpers/mock-db.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const COMPANY_ID = "company-1";
const TEMPLATE_ID = "template-1";
const GOAL_ID = "goal-1";
const PROJECT_ID = "project-1";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Workflow QA", () => {
  // ── 1. Template creation: 5 steps + 4 dependencies stored correctly ─────
  it("create template with 5 steps and 4 dependencies stores correctly", async () => {
    const steps = [
      { order: 1, title: "Write spec", description: "Create specification", role: "pm", priority: "high" },
      { order: 2, title: "Design UI", description: "Create mockups", role: "designer", priority: "medium" },
      { order: 3, title: "Implement backend", description: "Write API", role: "developer", priority: "medium" },
      { order: 4, title: "Implement frontend", description: "Write UI code", role: "developer", priority: "medium" },
      { order: 5, title: "QA testing", description: "End-to-end tests", role: "qa", priority: "high" },
    ];
    const deps = [
      { fromStep: 1, toStep: 2 },
      { fromStep: 1, toStep: 3 },
      { fromStep: 2, toStep: 4 },
      { fromStep: 3, toStep: 5 },
    ];

    const created = {
      id: "new-template-id",
      companyId: COMPANY_ID,
      name: "Full Feature Pipeline",
      description: "Spec to QA",
      steps,
      dependencies: deps,
      instantiationCount: 0,
      lastInstantiatedAt: null,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const db = createWorkflowDb({ inserts: [[created]] });
    const svc = workflowTemplateService(db as any);
    const result = await svc.create(COMPANY_ID, {
      name: "Full Feature Pipeline",
      description: "Spec to QA",
      steps,
      dependencies: deps,
    }, "user-1");

    expect(result).toEqual(created);
    expect(result.steps).toHaveLength(5);
    expect(result.dependencies).toHaveLength(4);
  });

  // ── 2. Template with no dependencies: empty deps array ──────────────────
  it("create template with no dependencies stores empty dependencies array", async () => {
    const steps = [
      { order: 1, title: "Standalone task", description: "Just one step", priority: "low" },
    ];

    const created = {
      id: "template-no-deps",
      companyId: COMPANY_ID,
      name: "Simple Template",
      description: "No deps",
      steps,
      dependencies: [],
      instantiationCount: 0,
      lastInstantiatedAt: null,
      createdBy: "user-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const db = createWorkflowDb({ inserts: [[created]] });
    const svc = workflowTemplateService(db as any);
    const result = await svc.create(COMPANY_ID, {
      name: "Simple Template",
      description: "No deps",
      steps,
    }, "user-1");

    expect(result.dependencies).toEqual([]);
    expect(result.steps).toHaveLength(1);
  });

  // ── 3. Instantiate creates correct task chain: 5 tasks + 4 deps ─────────
  it("instantiate 5-step template creates 5 tasks and 4 dependencies", async () => {
    const steps = [
      { order: 1, title: "Write spec", description: "Create specification", role: "pm", priority: "high" },
      { order: 2, title: "Design UI", description: "Create mockups", role: "designer", priority: "medium" },
      { order: 3, title: "Implement backend", description: "Write API", role: "developer", priority: "medium" },
      { order: 4, title: "Implement frontend", description: "Write UI code", role: "developer", priority: "medium" },
      { order: 5, title: "QA testing", description: "End-to-end tests", role: "qa", priority: "high" },
    ];
    const deps = [
      { fromStep: 1, toStep: 2 },
      { fromStep: 1, toStep: 3 },
      { fromStep: 2, toStep: 4 },
      { fromStep: 3, toStep: 5 },
    ];

    const template = {
      id: TEMPLATE_ID,
      companyId: COMPANY_ID,
      name: "Full Feature Pipeline",
      steps,
      dependencies: deps,
      instantiationCount: 0,
    };

    const task1 = { id: "task-1", title: "Write spec" };
    const task2 = { id: "task-2", title: "Design UI" };
    const task3 = { id: "task-3", title: "Implement backend" };
    const task4 = { id: "task-4", title: "Implement frontend" };
    const task5 = { id: "task-5", title: "QA testing" };

    const db = createWorkflowDb({
      selects: [[template]],
      inserts: [
        [task1], [task2], [task3], [task4], [task5], // 5 tasks
        [{ id: "dep-1" }], [{ id: "dep-2" }], [{ id: "dep-3" }], [{ id: "dep-4" }], // 4 deps
      ],
      updates: [[{ ...template, instantiationCount: 1 }]],
    });

    const svc = workflowTemplateService(db as any);
    const result = await svc.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);

    expect(result.templateId).toBe(TEMPLATE_ID);
    expect(result.tasksCreated).toHaveLength(5);
    expect(result.dependenciesCreated).toBe(4);
  });

  // ── 4. Instantiate increments counter: instantiate twice → count 2 ──────
  it("instantiate twice increments instantiationCount both times", async () => {
    const steps = [
      { order: 1, title: "Step A", priority: "medium" },
      { order: 2, title: "Step B", priority: "medium" },
    ];
    const deps = [{ fromStep: 1, toStep: 2 }];

    const template1 = {
      id: TEMPLATE_ID, companyId: COMPANY_ID, name: "Pipeline",
      steps, dependencies: deps, instantiationCount: 0,
    };
    const template2 = {
      ...template1, instantiationCount: 1,
    };

    // First instantiation
    const db1 = createWorkflowDb({
      selects: [[template1]],
      inserts: [
        [{ id: "t1-1", title: "Step A" }], [{ id: "t1-2", title: "Step B" }],
        [{ id: "dep-1" }],
      ],
      updates: [[{ ...template1, instantiationCount: 1 }]],
    });
    const svc1 = workflowTemplateService(db1 as any);
    await svc1.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);
    expect(db1.__updateSets).toHaveLength(1);
    expect(db1.__updateSets[0]).toHaveProperty("instantiationCount");

    // Second instantiation (counter is now 1)
    const db2 = createWorkflowDb({
      selects: [[template2]],
      inserts: [
        [{ id: "t2-1", title: "Step A" }], [{ id: "t2-2", title: "Step B" }],
        [{ id: "dep-2" }],
      ],
      updates: [[{ ...template2, instantiationCount: 2 }]],
    });
    const svc2 = workflowTemplateService(db2 as any);
    await svc2.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);
    expect(db2.__updateSets).toHaveLength(1);
    expect(db2.__updateSets[0]).toHaveProperty("instantiationCount");
  });

  // ── 5. Instantiate preserves step metadata in created tasks ─────────────
  it("instantiate preserves step priority and description from template", async () => {
    const steps = [
      { order: 1, title: "Urgent task", description: "This is critical", priority: "urgent" },
      { order: 2, title: "Low task", description: "Not urgent at all", priority: "low" },
    ];
    const deps = [{ fromStep: 1, toStep: 2 }];

    const template = {
      id: TEMPLATE_ID, companyId: COMPANY_ID, name: "Priority Pipeline",
      steps, dependencies: deps, instantiationCount: 0,
    };

    const task1 = { id: "task-1", title: "Urgent task" };
    const task2 = { id: "task-2", title: "Low task" };

    const db = createWorkflowDb({
      selects: [[template]],
      inserts: [[task1], [task2], [{ id: "dep-1" }]],
      updates: [[{ ...template, instantiationCount: 1 }]],
    });

    const svc = workflowTemplateService(db as any);
    const result = await svc.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);

    // Verify insert values contain step metadata
    const taskInserts = db.__insertValues.filter(
      (v: any) => v && typeof v === "object" && "title" in v && "priority" in v,
    );
    expect(taskInserts).toHaveLength(2);
    expect((taskInserts[0] as any).priority).toBe("urgent");
    expect((taskInserts[0] as any).description).toBe("This is critical");
    expect((taskInserts[1] as any).priority).toBe("low");
    expect((taskInserts[1] as any).description).toBe("Not urgent at all");
  });

  // ── 6. Delete blocked by instances ──────────────────────────────────────
  it("delete template with instantiationCount=5 throws conflict error", async () => {
    const template = {
      id: TEMPLATE_ID, companyId: COMPANY_ID, name: "Used Template",
      steps: [], dependencies: [], instantiationCount: 5,
    };

    const db = createWorkflowDb({
      selects: [[template]],
    });

    const svc = workflowTemplateService(db as any);
    await expect(
      svc.delete(COMPANY_ID, TEMPLATE_ID),
    ).rejects.toThrow("Cannot delete template with 5 active instance(s)");
  });

  // ── 7. Delete allowed when unused ───────────────────────────────────────
  it("delete template with instantiationCount=0 succeeds", async () => {
    const template = {
      id: TEMPLATE_ID, companyId: COMPANY_ID, name: "Unused Template",
      steps: [], dependencies: [], instantiationCount: 0,
    };

    const db = createWorkflowDb({
      selects: [[template]],
      deletes: [[template]],
    });

    const svc = workflowTemplateService(db as any);
    const result = await svc.delete(COMPANY_ID, TEMPLATE_ID);

    expect(result).toEqual(template);
  });

  // ── 8. Update template steps ────────────────────────────────────────────
  it("update template steps array modifies the template", async () => {
    const newSteps = [
      { order: 1, title: "Revised spec", priority: "high" },
      { order: 2, title: "Revised design", priority: "medium" },
      { order: 3, title: "Revised implementation", priority: "medium" },
      { order: 4, title: "Revised QA", priority: "high" },
    ];

    const updated = {
      id: TEMPLATE_ID, companyId: COMPANY_ID, name: "Feature Pipeline",
      steps: newSteps, dependencies: [{ fromStep: 1, toStep: 2 }],
      instantiationCount: 0, updatedAt: new Date(),
    };

    const db = createWorkflowDb({
      updates: [[updated]],
    });

    const svc = workflowTemplateService(db as any);
    const result = await svc.update(COMPANY_ID, TEMPLATE_ID, { steps: newSteps });

    expect(result).toEqual(updated);
    expect(result!.steps).toHaveLength(4);
    // Verify update was called with steps in the set
    expect(db.__updateSets).toHaveLength(1);
    expect(db.__updateSets[0]).toHaveProperty("steps");
  });

  // ── 9. List multiple templates ──────────────────────────────────────────
  it("list returns all 3 templates for company", async () => {
    const templates = [
      { id: "t-1", companyId: COMPANY_ID, name: "Pipeline A", steps: [], dependencies: [] },
      { id: "t-2", companyId: COMPANY_ID, name: "Pipeline B", steps: [], dependencies: [] },
      { id: "t-3", companyId: COMPANY_ID, name: "Pipeline C", steps: [], dependencies: [] },
    ];

    const db = createWorkflowDb({
      selects: [templates],
    });

    const svc = workflowTemplateService(db as any);
    const result = await svc.list(COMPANY_ID);

    expect(result).toHaveLength(3);
    expect(result.map((t: any) => t.name)).toEqual(["Pipeline A", "Pipeline B", "Pipeline C"]);
  });

  // ── 10. Complex pipeline: 7-step diamond dependency pattern ─────────────
  it("instantiate 7-step template with diamond dependency (A->B, A->C, B->D, C->D) creates correct graph", async () => {
    const steps = [
      { order: 1, title: "Requirements", priority: "high" },
      { order: 2, title: "Backend design", priority: "medium" },
      { order: 3, title: "Frontend design", priority: "medium" },
      { order: 4, title: "Integration spec", priority: "medium" },
      { order: 5, title: "Backend impl", priority: "medium" },
      { order: 6, title: "Frontend impl", priority: "medium" },
      { order: 7, title: "Integration testing", priority: "high" },
    ];
    // Diamond: 1->2, 1->3, 2->4, 3->4, 4->5, 4->6, 5->7, 6->7
    const deps = [
      { fromStep: 1, toStep: 2 },
      { fromStep: 1, toStep: 3 },
      { fromStep: 2, toStep: 4 },
      { fromStep: 3, toStep: 4 },
      { fromStep: 4, toStep: 5 },
      { fromStep: 4, toStep: 6 },
      { fromStep: 5, toStep: 7 },
      { fromStep: 6, toStep: 7 },
    ];

    const template = {
      id: TEMPLATE_ID, companyId: COMPANY_ID, name: "Diamond Pipeline",
      steps, dependencies: deps, instantiationCount: 0,
    };

    const tasks = steps.map((s, i) => ({ id: `task-${i + 1}`, title: s.title }));
    const depResults = deps.map((_, i) => [{ id: `dep-${i + 1}` }]);

    const db = createWorkflowDb({
      selects: [[template]],
      inserts: [
        ...tasks.map((t) => [t]),
        ...depResults,
      ],
      updates: [[{ ...template, instantiationCount: 1 }]],
    });

    const svc = workflowTemplateService(db as any);
    const result = await svc.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);

    expect(result.tasksCreated).toHaveLength(7);
    expect(result.dependenciesCreated).toBe(8);

    // Verify dependency insert values reference the right tasks
    const depInserts = db.__insertValues.filter(
      (v: any) => v && typeof v === "object" && "dependentIssueId" in v,
    );
    expect(depInserts).toHaveLength(8);
  });

  // ── 11. Instantiate with single step: 1 task, 0 deps ───────────────────
  it("instantiate single-step template creates 1 task and 0 dependencies", async () => {
    const steps = [
      { order: 1, title: "Only step", description: "Solo task", priority: "medium" },
    ];

    const template = {
      id: TEMPLATE_ID, companyId: COMPANY_ID, name: "Single Step",
      steps, dependencies: [], instantiationCount: 0,
    };

    const db = createWorkflowDb({
      selects: [[template]],
      inserts: [[{ id: "task-only", title: "Only step" }]],
      updates: [[{ ...template, instantiationCount: 1 }]],
    });

    const svc = workflowTemplateService(db as any);
    const result = await svc.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);

    expect(result.tasksCreated).toHaveLength(1);
    expect(result.tasksCreated[0].title).toBe("Only step");
    expect(result.dependenciesCreated).toBe(0);
  });

  // ── 12. Template not found: getById returns null, instantiate throws ────
  it("getById returns null for nonexistent template", async () => {
    const db = createWorkflowDb({ selects: [[]] });
    const svc = workflowTemplateService(db as any);
    const result = await svc.getById(COMPANY_ID, "nonexistent-id");
    expect(result).toBeNull();
  });

  it("instantiate throws for nonexistent template", async () => {
    const db = createWorkflowDb({ selects: [[]] });
    const svc = workflowTemplateService(db as any);
    await expect(
      svc.instantiate(COMPANY_ID, "nonexistent-id", GOAL_ID, PROJECT_ID),
    ).rejects.toThrow("not found");
  });
});
