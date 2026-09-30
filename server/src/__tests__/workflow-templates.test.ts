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
    companies: makeTable("companies"),
    projects: makeTable("projects"),
    taskDependencies: makeTable("task_dependencies"),
    workflowTemplates: makeTable("workflow_templates"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  eq: (..._args: unknown[]) => "eq",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

import { workflowTemplateService } from "../services/workflow-templates.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  let deleteIdx = 0;
  const insertValues: unknown[] = [];
  const updateSets: unknown[] = [];
  const operationOrder: string[] = [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "groupBy", "orderBy", "limit", "for", "values", "set", "returning"]) {
      chain[method] = (...args: unknown[]) => {
        if (method === "values") insertValues.push(args[0]);
        if (method === "set") updateSets.push(args[0]);
        return chain;
      };
    }
    chain.then = (resolve: (value: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => {
      operationOrder.push("select");
      return makeChain(() => config.selects?.[selectIdx++] ?? []);
    },
    insert: (..._args: unknown[]) => makeChain(() => config.inserts?.[insertIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => config.updates?.[updateIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => config.deletes?.[deleteIdx++] ?? []),
    execute: async (..._args: unknown[]) => {
      operationOrder.push("execute");
      return [];
    },
    transaction: async (callback: (tx: any) => unknown) => callback(db),
    __insertValues: insertValues,
    __updateSets: updateSets,
    __operationOrder: operationOrder,
  };

  return db;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const COMPANY_ID = "company-1";
const TEMPLATE_ID = "template-1";
const GOAL_ID = "goal-1";
const PROJECT_ID = "project-1";

const sampleSteps = [
  { order: 1, title: "Write spec", description: "Create specification", role: "pm", priority: "high" },
  { order: 2, title: "Design", description: "Create design", role: "designer", priority: "medium" },
  { order: 3, title: "Implement", description: "Write code", role: "developer", priority: "medium" },
];

const sampleDeps = [
  { fromStep: 1, toStep: 2 },
  { fromStep: 2, toStep: 3 },
];

const sampleTemplate = {
  id: TEMPLATE_ID,
  companyId: COMPANY_ID,
  name: "Feature Pipeline",
  workspaceMode: "department_default",
  description: "Spec → Design → Code",
  steps: sampleSteps,
  dependencies: sampleDeps,
  instantiationCount: 0,
  lastInstantiatedAt: null,
  createdBy: "user-1",
  createdAt: new Date(),
  updatedAt: new Date(),
  agentCompletionPolicyOverride: null,
};

const companyPolicy = { policyDefault: "review_required", reviewGuardrail: false };
const projectPolicy = { id: PROJECT_ID, type: "project", policyDefault: null };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("workflowTemplateService", () => {
  describe("list", () => {
    it("returns templates for company", async () => {
      const db = createSequenceDb({
        selects: [[sampleTemplate]],
      });
      const svc = workflowTemplateService(db as any);
      const result = await svc.list(COMPANY_ID);
      expect(result).toEqual([sampleTemplate]);
    });
  });

  describe("getById", () => {
    it("returns template when found", async () => {
      const db = createSequenceDb({
        selects: [[sampleTemplate]],
      });
      const svc = workflowTemplateService(db as any);
      const result = await svc.getById(COMPANY_ID, TEMPLATE_ID);
      expect(result).toEqual(sampleTemplate);
    });

    it("returns null when not found", async () => {
      const db = createSequenceDb({ selects: [[]] });
      const svc = workflowTemplateService(db as any);
      const result = await svc.getById(COMPANY_ID, "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("create", () => {
    it("persists workspace and completion policy overrides", async () => {
      const created = {
        ...sampleTemplate,
        id: "new-id",
        workspaceMode: "shared",
        agentCompletionPolicyOverride: "agent_can_complete",
      };
      const db = createSequenceDb({
        inserts: [[created]],
      });
      const svc = workflowTemplateService(db as any);
      const result = await svc.create(COMPANY_ID, {
        name: "Feature Pipeline",
        description: "Spec → Design → Code",
        workspaceMode: "shared",
        steps: sampleSteps,
        dependencies: sampleDeps,
        agentCompletionPolicyOverride: "agent_can_complete",
      }, "user-1");
      expect(result).toEqual(created);
      expect(db.__insertValues[0]).toMatchObject({
        workspaceMode: "shared",
        agentCompletionPolicyOverride: "agent_can_complete",
      });
    });
  });

  describe("update", () => {
    it("updates template fields and supports clearing the completion override", async () => {
      const updated = {
        ...sampleTemplate,
        name: "Updated Pipeline",
        workspaceMode: "isolated",
        agentCompletionPolicyOverride: null,
      };
      const db = createSequenceDb({
        updates: [[updated]],
      });
      const svc = workflowTemplateService(db as any);
      const result = await svc.update(COMPANY_ID, TEMPLATE_ID, {
        name: "Updated Pipeline",
        workspaceMode: "isolated",
        agentCompletionPolicyOverride: null,
      });
      expect(result).toEqual(updated);
      expect(db.__updateSets[0]).toMatchObject({
        workspaceMode: "isolated",
        agentCompletionPolicyOverride: null,
      });
    });

    it("returns null when template not found", async () => {
      const db = createSequenceDb({ updates: [[]] });
      const svc = workflowTemplateService(db as any);
      const result = await svc.update(COMPANY_ID, "nonexistent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("delete", () => {
    it("deletes template when instantiationCount is 0", async () => {
      const db = createSequenceDb({
        // 1. select to check instantiationCount
        selects: [[{ ...sampleTemplate, instantiationCount: 0 }]],
        // 2. delete
        deletes: [[sampleTemplate]],
      });
      const svc = workflowTemplateService(db as any);
      const result = await svc.delete(COMPANY_ID, TEMPLATE_ID);
      expect(result).toEqual(sampleTemplate);
    });

    it("throws conflict when template has active instances", async () => {
      const db = createSequenceDb({
        selects: [[{ ...sampleTemplate, instantiationCount: 3 }]],
      });
      const svc = workflowTemplateService(db as any);
      await expect(
        svc.delete(COMPANY_ID, TEMPLATE_ID),
      ).rejects.toThrow("Cannot delete template with 3 active instance(s)");
    });

    it("returns null when template not found", async () => {
      const db = createSequenceDb({ selects: [[]] });
      const svc = workflowTemplateService(db as any);
      const result = await svc.delete(COMPANY_ID, "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("instantiate", () => {
    it("creates correct number of tasks from steps", async () => {
      const task1 = { id: "task-1", title: "Write spec" };
      const task2 = { id: "task-2", title: "Design" };
      const task3 = { id: "task-3", title: "Implement" };

      const db = createSequenceDb({
        // 1. select template
        selects: [[sampleTemplate], [companyPolicy], [projectPolicy]],
        // inserts: task1, task2, task3, dep1, dep2
        inserts: [
          [task1], [task2], [task3],
          [{ id: "dep-1" }], [{ id: "dep-2" }],
        ],
        // update: increment instantiationCount
        updates: [[{ ...sampleTemplate, instantiationCount: 1 }]],
      });

      const svc = workflowTemplateService(db as any);
      const result = await svc.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);

      expect(result.templateId).toBe(TEMPLATE_ID);
      expect(result.tasksCreated).toHaveLength(3);
      expect(result.dependenciesCreated).toBe(2);
    });

    it("creates dependencies between the correct tasks", async () => {
      const task1 = { id: "task-1", title: "Write spec" };
      const task2 = { id: "task-2", title: "Design" };
      const task3 = { id: "task-3", title: "Implement" };

      const db = createSequenceDb({
        selects: [[sampleTemplate], [companyPolicy], [projectPolicy]],
        inserts: [[task1], [task2], [task3], [{ id: "dep-1" }], [{ id: "dep-2" }]],
        updates: [[{ ...sampleTemplate, instantiationCount: 1 }]],
      });

      const svc = workflowTemplateService(db as any);
      const result = await svc.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);

      // Verify insert values contain the dependency relationships
      const depInserts = db.__insertValues.filter(
        (v: any) => v && typeof v === "object" && "dependentIssueId" in v,
      );
      expect(depInserts).toHaveLength(2);
    });

    it("snapshots a persisted template completion override onto every task", async () => {
      const task = { id: "task-1", title: "Write spec" };
      const template = {
        ...sampleTemplate,
        steps: [sampleSteps[0]],
        dependencies: [],
        agentCompletionPolicyOverride: "agent_can_complete",
      };
      const db = createSequenceDb({
        selects: [[template], [companyPolicy], [projectPolicy]],
        inserts: [[task]],
        updates: [[{ ...template, instantiationCount: 1 }]],
      });

      const svc = workflowTemplateService(db as any);
      await svc.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);

      expect(db.__insertValues[0]).toMatchObject({
        agentCompletionPolicy: "agent_can_complete",
        agentCompletionPolicySource: "workflow_template",
        agentCompletionPolicySourceId: TEMPLATE_ID,
      });
      expect(db.__operationOrder.slice(0, 3)).toEqual(["execute", "execute", "select"]);
    });

    it("increments instantiationCount via update", async () => {
      const task1 = { id: "task-1", title: "Write spec" };
      const task2 = { id: "task-2", title: "Design" };
      const task3 = { id: "task-3", title: "Implement" };

      const db = createSequenceDb({
        selects: [[sampleTemplate], [companyPolicy], [projectPolicy]],
        inserts: [[task1], [task2], [task3], [{ id: "dep-1" }], [{ id: "dep-2" }]],
        updates: [[{ ...sampleTemplate, instantiationCount: 1 }]],
      });

      const svc = workflowTemplateService(db as any);
      await svc.instantiate(COMPANY_ID, TEMPLATE_ID, GOAL_ID, PROJECT_ID);

      // Verify update was called with instantiationCount, lastInstantiatedAt, updatedAt
      expect(db.__updateSets).toHaveLength(1);
      const setArg = db.__updateSets[0] as Record<string, unknown>;
      expect(setArg).toHaveProperty("instantiationCount");
      expect(setArg).toHaveProperty("lastInstantiatedAt");
      expect(setArg).toHaveProperty("updatedAt");
    });

    it("throws when template not found", async () => {
      const db = createSequenceDb({ selects: [[]] });
      const svc = workflowTemplateService(db as any);
      await expect(
        svc.instantiate(COMPANY_ID, "nonexistent", GOAL_ID, PROJECT_ID),
      ).rejects.toThrow("not found");
    });
  });
});
