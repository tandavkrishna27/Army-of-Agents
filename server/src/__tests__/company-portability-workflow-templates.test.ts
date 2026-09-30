import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB / drizzle stubs ────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
  lte: vi.fn((a: unknown, b: unknown) => ({ lte: [a, b] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
  isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  sql: new Proxy(() => ({ sql: true }), {
    get: () => () => ({ sql: true }),
    apply: () => ({ sql: true }),
  }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
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
    internalAgentConfig: makeTable("internal_agent_config"),
    budgetPolicies: makeTable("budget_policies"),
    costEvents: makeTable("cost_events"),
    financeEvents: makeTable("finance_events"),
    providerQuotaWindows: makeTable("provider_quota_windows"),
    workflowTemplates: makeTable("workflow_templates"),
  };
});

// ── IDs ──────────────────────────────────────────────────────────────────────

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";

// ── Service mocks ─────────────────────────────────────────────────────────────

const companyStore: Record<string, {
  id: string;
  name: string;
  description: string | null;
  brandColor: string | null;
  requireBoardApprovalForNewAgents: boolean;
}> = {
  [SRC_CO_ID]: { id: SRC_CO_ID, name: "Source Co", description: null, brandColor: null, requireBoardApprovalForNewAgents: true },
  [TGT_CO_ID]: { id: TGT_CO_ID, name: "Target Co", description: null, brandColor: null, requireBoardApprovalForNewAgents: true },
};

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => companyStore[id] ?? null),
    create: vi.fn(async (input: { name: string }) => ({ id: "new-co", name: input.name })),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      id,
      name: (patch.name as string) ?? companyStore[id]?.name ?? "Co",
    })),
  }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    backfillHumanAtTop: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    ensureMembership: vi.fn(async () => undefined),
    ensureRealOperator: vi.fn(async () => "operator-user-id"),
  }),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => ({
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    list: vi.fn(async () => []),
    create: vi.fn(),
  }),
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => ({
    listFull: vi.fn(async () => []),
    upsertImportedSkills: vi.fn(async () => []),
  }),
}));

vi.mock("../services/routines.js", () => ({
  routineService: () => ({
    listForExport: vi.fn(async () => []),
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    createTrigger: vi.fn(),
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";

// ── Mock DB helpers ──────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  updates?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const captured: { inserts: MockRow[]; updates: MockRow[]; updateWheres: unknown[]; deletes: unknown[] } = {
    inserts: [],
    updates: [],
    updateWheres: [],
    deletes: [],
  };

  function makeSelectChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin", "groupBy"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeInsertChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    chain.values = (v: MockRow | MockRow[]) => {
      if (Array.isArray(v)) captured.inserts.push(...v);
      else captured.inserts.push(v);
      const inner: Record<string, unknown> = {};
      const methods = ["returning", "onConflictDoUpdate", "onConflictDoNothing"];
      for (const m of methods) {
        inner[m] = (..._args: unknown[]) => inner;
      }
      inner.then = (resolve: (v: MockRow[]) => unknown) =>
        Promise.resolve(getResult()).then(resolve);
      return inner;
    };
    return chain;
  }

  function makeUpdateChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    chain.set = (v: MockRow) => {
      captured.updates.push(v);
      return chain;
    };
    chain.where = (cond: unknown) => {
      captured.updateWheres.push(cond);
      return chain;
    };
    chain.returning = (..._args: unknown[]) => chain;
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeDeleteChain() {
    const chain: Record<string, unknown> = {};
    chain.where = (cond: unknown) => {
      captured.deletes.push(cond);
      const inner: Record<string, unknown> = {};
      inner.then = (resolve: (v: MockRow[]) => unknown) =>
        Promise.resolve([]).then(resolve);
      return inner;
    };
    return chain;
  }

  return {
    db: {
      select: (_fields?: unknown) =>
        makeSelectChain(() => config.selects?.[selectIdx++] ?? []),
      insert: (_table: unknown) =>
        makeInsertChain(() => config.inserts?.[insertIdx++] ?? []),
      update: (_table: unknown) =>
        makeUpdateChain(() => config.updates?.[updateIdx++] ?? []),
      delete: (_table: unknown) => makeDeleteChain(),
    },
    captured,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const sampleTemplateRow1 = {
  id: "wt-1",
  companyId: SRC_CO_ID,
  name: "Ship Feature",
  description: "Plan → build → test → release",
  workspaceMode: "per_task",
  agentCompletionPolicyOverride: "agent_can_complete",
  steps: [
    { order: 1, title: "Spec", role: "pm", suggestedAssigneeType: "human" },
    { order: 2, title: "Build", role: "engineer", suggestedAssigneeType: "agent" },
    { order: 3, title: "QA", role: "qa", suggestedAssigneeType: "agent" },
  ],
  dependencies: [
    { fromStep: 1, toStep: 2 },
    { fromStep: 2, toStep: 3 },
  ],
  instantiationCount: 42,
  lastInstantiatedAt: new Date("2026-04-20T12:00:00Z"),
  createdBy: "user-original",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-04-20T12:00:00Z"),
};

const sampleTemplateRow2 = {
  id: "wt-2",
  companyId: SRC_CO_ID,
  name: "My Flow!",
  description: null,
  workspaceMode: "department_default",
  steps: [{ order: 1, title: "One", role: "agent" }],
  dependencies: [],
  instantiationCount: 0,
  lastInstantiatedAt: null,
  createdBy: "internal_agent",
  createdAt: new Date("2026-02-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
};

function baseManifest(overrides: Partial<CompanyPortabilityManifest> = {}): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-04-22T00:00:00.000Z",
    source: null,
    includes: {
      company: true,
      agents: false,
      projects: false,
      issues: false,
      skills: false,
      routines: false,
      envInputs: false,
      workflowTemplates: true,
    },
    company: {
      path: "COMPANY.md",
      name: "Source Co",
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
    },
    agents: [],
    requiredSecrets: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("company-portability workflow templates — export", () => {
  it("exportBundle with include.workflowTemplates=true serializes all templates", async () => {
    const { db } = createSequenceDb({
      selects: [[sampleTemplateRow1, sampleTemplateRow2]],
    });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
    });

    expect(result.manifest.workflowTemplates).toBeDefined();
    expect(result.manifest.workflowTemplates).toHaveLength(2);
    expect(result.manifest.workflowTemplates?.[0]).toMatchObject({
      name: "Ship Feature",
      description: "Plan → build → test → release",
      workspaceMode: "per_task",
      agentCompletionPolicyOverride: "agent_can_complete",
    });
  });

  it("export is OFF by default (opt-in, matches other AoA-only entities)", async () => {
    const { db } = createSequenceDb({ selects: [] });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false },
    });

    expect(result.manifest.workflowTemplates).toBeUndefined();
  });

  it("slug synthesis: 'My Flow!' → 'my-flow'", async () => {
    const { db } = createSequenceDb({
      selects: [[sampleTemplateRow2]],
    });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
    });

    expect(result.manifest.workflowTemplates?.[0].slug).toBe("my-flow");
  });

  it("export strips runtime state (instantiationCount, lastInstantiatedAt, createdBy, id, companyId, timestamps)", async () => {
    const { db } = createSequenceDb({
      selects: [[sampleTemplateRow1]],
    });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
    });

    const tpl = result.manifest.workflowTemplates?.[0] as Record<string, unknown>;
    expect(tpl.id).toBeUndefined();
    expect(tpl.companyId).toBeUndefined();
    expect(tpl.createdAt).toBeUndefined();
    expect(tpl.updatedAt).toBeUndefined();
    expect(tpl.instantiationCount).toBeUndefined();
    expect(tpl.lastInstantiatedAt).toBeUndefined();
    expect(tpl.createdBy).toBeUndefined();
  });

  it("steps JSON + dependencies JSON roundtrip verbatim", async () => {
    const { db } = createSequenceDb({
      selects: [[sampleTemplateRow1]],
    });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
    });

    expect(result.manifest.workflowTemplates?.[0].steps).toEqual(sampleTemplateRow1.steps);
    expect(result.manifest.workflowTemplates?.[0].dependencies).toEqual(sampleTemplateRow1.dependencies);
  });

  it("previewExport counts workflowTemplates", async () => {
    const { db } = createSequenceDb({
      selects: [[sampleTemplateRow1, sampleTemplateRow2]],
    });
    const svc = companyPortabilityService(db as any);

    const preview = await svc.previewExport(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
    });

    expect(preview.counts.workflowTemplates).toBe(2);
  });
});

describe("company-portability workflow templates — import", () => {
  it("import creates templates in target company (no collisions)", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        // existing templates in target company — empty
        [],
      ],
      inserts: [[{ id: "new-wt-1" }], [{ id: "new-wt-2" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "Plan → build → test → release",
          workspaceMode: "per_task",
          agentCompletionPolicyOverride: "review_required",
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
      ],
    });

    await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
      },
      "importer-user-1",
    );

    const inserted = captured.inserts.find(
      (row) => (row as { name?: string }).name === "Ship Feature",
    );
    expect(inserted).toBeDefined();
    expect(inserted).toMatchObject({
      companyId: TGT_CO_ID,
      name: "Ship Feature",
      description: "Plan → build → test → release",
      workspaceMode: "per_task",
      agentCompletionPolicyOverride: "review_required",
      instantiationCount: 0,
      lastInstantiatedAt: null,
      createdBy: "importer-user-1",
    });
  });

  it("does not require task assignment permission when a new template inherits policy", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[], []],
      inserts: [[{ id: "new-wt" }]],
    });
    const svc = companyPortabilityService(db as any);
    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: null,
          workspaceMode: "per_task",
          agentCompletionPolicyOverride: null,
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
      ],
    });

    let authorizationContext: { requiresTaskAssignmentPermission: boolean } | null = null;
    await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
      },
      "importer-user-1",
      async (context) => {
        authorizationContext = context;
      },
    );

    expect(authorizationContext?.requiresTaskAssignmentPermission).toBe(false);
    expect(captured.inserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Ship Feature",
        agentCompletionPolicyOverride: null,
      }),
    ]));
  });

  it("freezes a skipped workflow template so a later deletion cannot authorize an insert", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        // Preview authorization collision plan.
        [{ id: "existing-wt", companyId: TGT_CO_ID, name: "Ship Feature" }],
        // The row is deleted after authorization but before import execution.
        [],
      ],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "New version",
          workspaceMode: "per_task",
          agentCompletionPolicyOverride: "agent_can_complete",
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
      ],
    });

    let authorizationContext: { requiresTaskAssignmentPermission: boolean } | null = null;
    await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
        collisionStrategy: "skip",
      },
      "importer-user-1",
      async (context) => {
        authorizationContext = context;
      },
    );

    expect(authorizationContext?.requiresTaskAssignmentPermission).toBe(false);
    expect(captured.inserts.length).toBe(0);
    expect(captured.updates.length).toBe(0);
  });

  it("import collision with 'rename' strategy inserts with uniquified name", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        [{ id: "existing-wt", companyId: TGT_CO_ID, name: "Ship Feature" }],
      ],
      inserts: [[{ id: "new-wt" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "Renamed version",
          workspaceMode: "per_task",
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
      ],
    });

    await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
        collisionStrategy: "rename",
      },
      "importer-user-1",
    );

    const inserted = captured.inserts.find(
      (row) => typeof (row as { name?: string }).name === "string"
        && (row as { name: string }).name.startsWith("Ship Feature"),
    );
    expect(inserted).toBeDefined();
    expect((inserted as { name: string }).name).not.toBe("Ship Feature");
  });

  it("import collision with 'replace' strategy updates existing template", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        [{ id: "existing-wt", companyId: TGT_CO_ID, name: "Ship Feature" }],
        [{ id: "existing-wt", companyId: TGT_CO_ID, name: "Ship Feature" }],
      ],
      updates: [[{ id: "existing-wt" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "Replacement content",
          workspaceMode: "per_task",
          steps: [{ order: 1, title: "New spec" }],
          dependencies: [],
        },
      ],
    });

    await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
        collisionStrategy: "replace",
      },
      "importer-user-1",
    );

    expect(captured.updates.length).toBeGreaterThanOrEqual(1);
    const updated = captured.updates.find(
      (row) => (row as { description?: string }).description === "Replacement content",
    );
    expect(updated).toBeDefined();
    expect(updated).not.toHaveProperty("agentCompletionPolicyOverride");
    expect(captured.inserts.length).toBe(0);
  });

  it("requires task assignment permission when replace clears a template override", async () => {
    const existingTemplate = {
      id: "existing-wt",
      companyId: TGT_CO_ID,
      name: "Ship Feature",
      agentCompletionPolicyOverride: "agent_can_complete",
    };
    const { db, captured } = createSequenceDb({
      selects: [[existingTemplate], [existingTemplate]],
      updates: [[{ id: "existing-wt" }]],
    });
    const svc = companyPortabilityService(db as any);
    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "Use company policy",
          workspaceMode: "per_task",
          agentCompletionPolicyOverride: null,
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
      ],
    });

    let authorizationContext: { requiresTaskAssignmentPermission: boolean } | null = null;
    await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
        collisionStrategy: "replace",
      },
      "importer-user-1",
      async (context) => {
        authorizationContext = context;
      },
    );

    expect(authorizationContext?.requiresTaskAssignmentPermission).toBe(true);
    expect(captured.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentCompletionPolicyOverride: null }),
    ]));
  });

  it("checks every duplicate template entry before authorizing a replacement", async () => {
    const existingTemplate = {
      id: "existing-wt",
      companyId: TGT_CO_ID,
      name: "Ship Feature",
      agentCompletionPolicyOverride: "agent_can_complete",
    };
    const { db, captured } = createSequenceDb({
      selects: [[existingTemplate], [existingTemplate]],
      updates: [[{ id: "existing-wt" }], [{ id: "existing-wt" }]],
    });
    const svc = companyPortabilityService(db as any);
    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "First entry",
          workspaceMode: "per_task",
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "Second entry",
          workspaceMode: "per_task",
          agentCompletionPolicyOverride: null,
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
      ],
    });

    let authorizationContext: { requiresTaskAssignmentPermission: boolean } | null = null;
    await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
        collisionStrategy: "replace",
      },
      "importer-user-1",
      async (context) => {
        authorizationContext = context;
      },
    );

    expect(authorizationContext?.requiresTaskAssignmentPermission).toBe(true);
    expect(captured.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentCompletionPolicyOverride: null }),
    ]));
  });

  it("does not replace a template that appears after import authorization", async () => {
    const lateTemplate = {
      id: "late-wt",
      companyId: TGT_CO_ID,
      name: "Ship Feature",
      agentCompletionPolicyOverride: "agent_can_complete",
    };
    const { db, captured } = createSequenceDb({
      selects: [[], [lateTemplate]],
    });
    const svc = companyPortabilityService(db as any);
    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "Use company policy",
          workspaceMode: "per_task",
          agentCompletionPolicyOverride: null,
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
      ],
    });

    let authorizationContext: { requiresTaskAssignmentPermission: boolean } | null = null;
    const result = await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
        collisionStrategy: "replace",
      },
      "importer-user-1",
      async (context) => {
        authorizationContext = context;
      },
    );

    expect(authorizationContext?.requiresTaskAssignmentPermission).toBe(false);
    expect(captured.updates).toHaveLength(0);
    expect(captured.inserts).toHaveLength(0);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "skipped_update",
        section: "workflowTemplates",
      }),
    ]));
  });

  it("does not replace a different template that takes over an authorized slug", async () => {
    const authorizedTemplate = {
      id: "authorized-wt",
      companyId: TGT_CO_ID,
      name: "Ship Feature",
      agentCompletionPolicyOverride: "agent_can_complete",
    };
    const replacementTemplate = {
      id: "replacement-wt",
      companyId: TGT_CO_ID,
      name: "Ship Feature",
      agentCompletionPolicyOverride: "review_required",
    };
    const { db, captured } = createSequenceDb({
      selects: [[authorizedTemplate], [replacementTemplate]],
    });
    const svc = companyPortabilityService(db as any);
    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "Use company policy",
          workspaceMode: "per_task",
          agentCompletionPolicyOverride: null,
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
      ],
    });

    let authorizationContext: { requiresTaskAssignmentPermission: boolean } | null = null;
    const result = await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
        collisionStrategy: "replace",
      },
      "importer-user-1",
      async (context) => {
        authorizationContext = context;
      },
    );

    expect(authorizationContext?.requiresTaskAssignmentPermission).toBe(true);
    expect(captured.updates).toHaveLength(0);
    expect(captured.inserts).toHaveLength(0);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "skipped_update",
        section: "workflowTemplates",
      }),
    ]));
  });

  it("accepts any pre-authorized template when existing names share a slug", async () => {
    const firstTemplate = {
      id: "first-wt",
      companyId: TGT_CO_ID,
      name: "Ship Feature",
    };
    const secondTemplate = {
      id: "second-wt",
      companyId: TGT_CO_ID,
      name: "Ship Feature",
    };
    const { db, captured } = createSequenceDb({
      selects: [
        [firstTemplate, secondTemplate],
        [secondTemplate, firstTemplate],
      ],
      updates: [[firstTemplate]],
    });
    const svc = companyPortabilityService(db as any);
    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "ship-feature",
          name: "Ship Feature",
          description: "Replacement content",
          workspaceMode: "per_task",
          steps: [{ order: 1, title: "Spec" }],
          dependencies: [],
        },
      ],
    });

    await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
        collisionStrategy: "replace",
      },
      "importer-user-1",
    );

    expect(captured.updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: "Replacement content" }),
    ]));
    expect(captured.inserts).toHaveLength(0);
  });

  it("workflowTemplates section is not warned as unknown_section", async () => {
    const { db } = createSequenceDb({
      selects: [[]],
      inserts: [[{ id: "new-wt" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      workflowTemplates: [
        {
          slug: "tiny",
          name: "Tiny",
          description: null,
          workspaceMode: "department_default",
          steps: [{ order: 1, title: "Go" }],
          dependencies: [],
        },
      ],
    });

    const result = await svc.importBundle(
      {
        source: {
          type: "inline",
          manifest,
          files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" },
        },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, workflowTemplates: true },
      },
      "importer-user-1",
    );

    const unknownWarnings = result.warnings.filter(
      (w) => w.kind === "unknown_section" && w.section === "workflowTemplates",
    );
    expect(unknownWarnings).toEqual([]);
  });
});
