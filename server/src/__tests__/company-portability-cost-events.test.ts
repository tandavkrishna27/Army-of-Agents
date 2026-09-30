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
  };
});

// ── IDs ──────────────────────────────────────────────────────────────────────

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";
const SRC_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TGT_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SRC_PROJECT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SRC_ISSUE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

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

const sourceAgents = [
  {
    id: SRC_AGENT_ID,
    name: "Builder Agent",
    status: "active",
    role: "agent",
    title: null,
    icon: null,
    capabilities: null,
    reportsTo: null,
    parentType: null,
    parentId: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
    budgetMonthlyCents: 0,
    metadata: null,
  },
];

const targetAgents = [
  {
    id: TGT_AGENT_ID,
    name: "Builder Agent",
    adapterConfig: {},
  },
];

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    backfillHumanAtTop: vi.fn(async () => undefined),
    list: vi.fn(async (companyId: string) => {
      if (companyId === SRC_CO_ID) return sourceAgents;
      if (companyId === TGT_CO_ID) return targetAgents;
      return [];
    }),
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

const sourceProjects = [
  {
    id: SRC_PROJECT_ID,
    name: "Marketing",
    type: "department",
    description: null,
    parentId: null,
    status: null,
    color: null,
    targetDate: null,
    leadAgentId: null,
    functionType: null,
    executionWorkspacePolicy: null,
    archivedAt: null,
  },
];

vi.mock("../services/projects.js", () => ({
  projectService: () => ({
    list: vi.fn(async (companyId: string) =>
      companyId === SRC_CO_ID ? sourceProjects : [],
    ),
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

const sourceIssues = [
  {
    id: SRC_ISSUE_ID,
    title: "Investigate alpha",
    identifier: "MKT-1",
    description: null,
    status: "todo",
    priority: "medium",
    projectId: SRC_PROJECT_ID,
    assigneeAgentId: SRC_AGENT_ID,
    billingCode: null,
    dueDate: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceSettings: null,
    labels: [],
  },
];

vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    list: vi.fn(async (companyId: string) =>
      companyId === SRC_CO_ID ? sourceIssues : [],
    ),
    create: vi.fn(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "new-issue",
      title: input.title,
    })),
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
  const captured: {
    inserts: MockRow[];
    insertTables: string[];
    updates: MockRow[];
    updateTables: string[];
    updateWheres: unknown[];
    selectWheres: unknown[];
  } = { inserts: [], insertTables: [], updates: [], updateTables: [], updateWheres: [], selectWheres: [] };

  function extractTableName(tbl: unknown): string {
    if (tbl && typeof tbl === "object") {
      const underscore = (tbl as Record<string, unknown>)._;
      if (underscore && typeof underscore === "object") {
        const maybeName = (underscore as Record<string, unknown>).name;
        if (typeof maybeName === "string") return maybeName;
      }
    }
    return "unknown";
  }

  function makeSelectChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "orderBy", "limit", "leftJoin", "innerJoin", "groupBy"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.where = (cond: unknown) => {
      captured.selectWheres.push(cond);
      return chain;
    };
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeInsertChain(tableName: string, getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    chain.values = (v: MockRow | MockRow[]) => {
      if (Array.isArray(v)) {
        for (const row of v) {
          captured.inserts.push(row);
          captured.insertTables.push(tableName);
        }
      } else {
        captured.inserts.push(v);
        captured.insertTables.push(tableName);
      }
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

  function makeUpdateChain(tableName: string, getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    chain.set = (v: MockRow) => {
      captured.updates.push(v);
      captured.updateTables.push(tableName);
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

  return {
    db: {
      select: (_fields?: unknown) =>
        makeSelectChain(() => config.selects?.[selectIdx++] ?? []),
      insert: (table: unknown) =>
        makeInsertChain(extractTableName(table), () => config.inserts?.[insertIdx++] ?? []),
      update: (table: unknown) =>
        makeUpdateChain(extractTableName(table), () => config.updates?.[updateIdx++] ?? []),
    },
    captured,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const costEventRow = {
  id: "ce-1",
  companyId: SRC_CO_ID,
  agentId: SRC_AGENT_ID,
  issueId: SRC_ISSUE_ID,
  projectId: SRC_PROJECT_ID,
  goalId: null,
  heartbeatRunId: "hbr-ephemeral-1",
  billingCode: "BC-100",
  provider: "anthropic",
  biller: "anthropic",
  billingType: "api",
  model: "claude-opus-4-7",
  inputTokens: 1000,
  cachedInputTokens: 200,
  outputTokens: 500,
  costCents: 42,
  occurredAt: new Date("2026-03-15T12:00:00Z"),
  createdAt: new Date("2026-03-15T12:00:01Z"),
};

function baseManifest(overrides: Partial<CompanyPortabilityManifest> = {}): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-04-21T00:00:00.000Z",
    source: null,
    includes: {
      company: true,
      agents: false,
      projects: false,
      issues: false,
      skills: false,
      routines: false,
      envInputs: false,
      internalAgentConfig: false,
      budgetPolicies: false,
      costEvents: true,
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

// ── Export tests ─────────────────────────────────────────────────────────────

describe("company-portability cost events — export", () => {
  it("DEFAULT_INCLUDE.costEvents is false (opt-in)", async () => {
    const { db } = createSequenceDb({ selects: [] });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false },
    });

    expect(result.manifest.costEvents).toBeUndefined();
  });

  it("export with include.costEvents=true serializes all events", async () => {
    const { db } = createSequenceDb({
      selects: [[costEventRow]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, internalAgentConfig: false, costEvents: true },
    });

    expect(result.manifest.costEvents).toBeDefined();
    expect(result.manifest.costEvents!.length).toBe(1);
    const ev = result.manifest.costEvents![0]!;
    expect(ev).toMatchObject({
      agentSlug: "builder-agent",
      issueSlug: "mkt-1",
      projectSlug: "marketing",
      goalSlug: null,
      occurredAt: "2026-03-15T12:00:00.000Z",
      provider: "anthropic",
      model: "claude-opus-4-7",
      biller: "anthropic",
      billingType: "api",
      billingCode: "BC-100",
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
      costCents: 42,
    });
    expect(ev.slug).toBeTruthy();
  });

  it("export strips heartbeatRunId + PK/FK/timestamp from manifest", async () => {
    const { db } = createSequenceDb({
      selects: [[costEventRow]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, costEvents: true, internalAgentConfig: false },
    });

    const ev = result.manifest.costEvents![0]! as unknown as Record<string, unknown>;
    expect(ev.id).toBeUndefined();
    expect(ev.companyId).toBeUndefined();
    expect(ev.agentId).toBeUndefined();
    expect(ev.issueId).toBeUndefined();
    expect(ev.projectId).toBeUndefined();
    expect(ev.goalId).toBeUndefined();
    expect(ev.heartbeatRunId).toBeUndefined();
    expect(ev.createdAt).toBeUndefined();
  });

  it("export null-safe when event has no agent/issue/project FKs", async () => {
    const orphan = {
      ...costEventRow,
      issueId: null,
      projectId: null,
      // agentId still required (NOT NULL), but unresolved id → null slug
      agentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    };
    const { db } = createSequenceDb({
      selects: [[orphan]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, costEvents: true, internalAgentConfig: false },
    });

    const ev = result.manifest.costEvents![0]!;
    expect(ev.agentSlug).toBeNull();
    expect(ev.issueSlug).toBeNull();
    expect(ev.projectSlug).toBeNull();
    expect(ev.goalSlug).toBeNull();
  });

  it("export with date range filter passes gte/lte to query", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[costEventRow]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    await svc.exportBundle(SRC_CO_ID, {
      include: {
        agents: true,
        internalAgentConfig: false,
        costEvents: { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" },
      },
    });

    // date-range branch composes an `and` with gte + lte clauses
    const stringified = JSON.stringify(captured.selectWheres);
    expect(stringified).toContain("gte");
    expect(stringified).toContain("lte");
  });

  it("export emits large_volume warning when >10K events", async () => {
    const manyRows: MockRow[] = [];
    for (let i = 0; i < 10001; i++) {
      manyRows.push({ ...costEventRow, id: `ce-${i}` });
    }
    const { db } = createSequenceDb({ selects: [manyRows] });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, internalAgentConfig: false, costEvents: true },
    });

    expect(result.manifest.costEvents!.length).toBe(10001);
    expect(result.warnings.some((w) =>
      typeof w === "string" && w.toLowerCase().includes("cost event"),
    )).toBe(true);
  });

  it("previewExport surfaces costEvents count", async () => {
    const { db } = createSequenceDb({
      selects: [[costEventRow, { ...costEventRow, id: "ce-2" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const preview = await svc.previewExport(SRC_CO_ID, {
      include: { agents: true, internalAgentConfig: false, costEvents: true },
    });

    expect(preview.counts.costEvents).toBe(2);
  });
});

// ── Import tests ─────────────────────────────────────────────────────────────

describe("company-portability cost events — import", () => {
  it("import inserts event bound to target companyId with resolved agentId", async () => {
    const { db, captured } = createSequenceDb({
      inserts: [[{ id: "new-ce" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      costEvents: [
        {
          slug: "ce-test-1",
          agentSlug: "builder-agent",
          issueSlug: null,
          projectSlug: null,
          goalSlug: null,
          occurredAt: "2026-03-15T12:00:00.000Z",
          provider: "anthropic",
          model: "claude-opus-4-7",
          biller: "anthropic",
          billingType: "api",
          billingCode: null,
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 200,
          costCents: 42,
          metadata: null,
        },
      ],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, costEvents: true },
      },
      "importer-1",
    );

    const ceInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "cost_events",
    );
    expect(ceInserts.length).toBe(1);
    const inserted = ceInserts[0]!;
    expect(inserted).toMatchObject({
      companyId: TGT_CO_ID,
      agentId: TGT_AGENT_ID,
      provider: "anthropic",
      model: "claude-opus-4-7",
      biller: "anthropic",
      billingType: "api",
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      costCents: 42,
    });
    expect(inserted.issueId).toBeNull();
    expect(inserted.projectId).toBeNull();
    expect(inserted.goalId).toBeNull();
    expect(inserted.heartbeatRunId).toBeNull();
  });

  it("import warns + skips when agentSlug not resolvable (agentId is NOT NULL)", async () => {
    const { db, captured } = createSequenceDb({});
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      costEvents: [
        {
          slug: "ce-test-ghost",
          agentSlug: "ghost-agent",
          issueSlug: null,
          projectSlug: null,
          goalSlug: null,
          occurredAt: "2026-03-15T12:00:00.000Z",
          provider: "anthropic",
          model: "claude-opus-4-7",
          biller: null,
          billingType: null,
          billingCode: null,
          inputTokens: 100,
          outputTokens: 50,
          costCents: 5,
          metadata: null,
        },
      ],
    });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, costEvents: true },
      },
      "importer-1",
    );

    const ceInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "cost_events",
    );
    expect(ceInserts.length).toBe(0);
    expect(result.warnings.some((w) =>
      w.kind === "link_failed" && typeof w.message === "string" && w.message.toLowerCase().includes("cost event"),
    )).toBe(true);
  });

  it("import silently nulls goalSlug (goals not in bundle)", async () => {
    const { db, captured } = createSequenceDb({
      inserts: [[{ id: "new-ce" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      costEvents: [
        {
          slug: "ce-test-goal",
          agentSlug: "builder-agent",
          issueSlug: null,
          projectSlug: null,
          goalSlug: "some-goal",
          occurredAt: "2026-03-15T12:00:00.000Z",
          provider: "anthropic",
          model: "claude-opus-4-7",
          biller: null,
          billingType: null,
          billingCode: null,
          inputTokens: 100,
          outputTokens: 50,
          costCents: 5,
          metadata: null,
        },
      ],
    });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, costEvents: true },
      },
      "importer-1",
    );

    const ceInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "cost_events",
    );
    expect(ceInserts.length).toBe(1);
    expect(ceInserts[0]!.goalId).toBeNull();
    // No link_failed warning for goalSlug — silent null
    expect(result.warnings.some((w) =>
      w.kind === "link_failed" && typeof w.message === "string" && w.message.toLowerCase().includes("goal"),
    )).toBe(false);
  });

  it("import emits large_volume warning when bundle has >10K events", async () => {
    const manyEvents = [];
    for (let i = 0; i < 10001; i++) {
      manyEvents.push({
        slug: `ce-${i}`,
        agentSlug: "builder-agent",
        issueSlug: null,
        projectSlug: null,
        goalSlug: null,
        occurredAt: "2026-03-15T12:00:00.000Z",
        provider: "anthropic",
        model: "claude-opus-4-7",
        biller: null,
        billingType: null,
        billingCode: null,
        inputTokens: 1,
        outputTokens: 1,
        costCents: 1,
        metadata: null,
      });
    }
    const { db } = createSequenceDb({
      inserts: [[{ id: "new-ce" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({ costEvents: manyEvents });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, costEvents: true },
      },
      "importer-1",
    );

    expect(result.warnings.some((w) => w.kind === "large_volume")).toBe(true);
  });

  it("costEvents section is not warned as unknown_section", async () => {
    const { db } = createSequenceDb({
      inserts: [[{ id: "new-ce" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      costEvents: [
        {
          slug: "ce-known-1",
          agentSlug: "builder-agent",
          issueSlug: null,
          projectSlug: null,
          goalSlug: null,
          occurredAt: "2026-03-15T12:00:00.000Z",
          provider: "anthropic",
          model: "claude-opus-4-7",
          biller: null,
          billingType: null,
          billingCode: null,
          inputTokens: 10,
          outputTokens: 5,
          costCents: 1,
          metadata: null,
        },
      ],
    });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, costEvents: true },
      },
      "importer-1",
    );

    const unknownWarnings = result.warnings.filter(
      (w) => w.kind === "unknown_section" && w.section === "costEvents",
    );
    expect(unknownWarnings).toEqual([]);
  });

  it("import with no costEvents in bundle is a no-op (older export)", async () => {
    const { db, captured } = createSequenceDb({});
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest();
    delete (manifest as Partial<CompanyPortabilityManifest>).costEvents;

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, costEvents: true },
      },
      "importer-1",
    );

    const ceInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "cost_events",
    );
    expect(ceInserts.length).toBe(0);
  });

  it("import batches inserts (1000-row batch size)", async () => {
    const manyEvents = [];
    for (let i = 0; i < 2500; i++) {
      manyEvents.push({
        slug: `ce-${i}`,
        agentSlug: "builder-agent",
        issueSlug: null,
        projectSlug: null,
        goalSlug: null,
        occurredAt: "2026-03-15T12:00:00.000Z",
        provider: "anthropic",
        model: "claude-opus-4-7",
        biller: null,
        billingType: null,
        billingCode: null,
        inputTokens: 1,
        outputTokens: 1,
        costCents: 1,
        metadata: null,
      });
    }
    const { db, captured } = createSequenceDb({
      inserts: [[], [], []],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({ costEvents: manyEvents });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, costEvents: true },
      },
      "importer-1",
    );

    // 2500 events → 3 batches (1000 + 1000 + 500)
    const ceInsertCount = captured.insertTables.filter((t) => t === "cost_events").length;
    expect(ceInsertCount).toBe(2500);
  });
});
