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
  };
});

// ── IDs ──────────────────────────────────────────────────────────────────────

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";
const SRC_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TGT_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

// Default: source company has one agent "Builder Agent"; target company has
// same agent name so slug alignment lets agent-scoped policies link through.
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
  const captured: {
    inserts: MockRow[];
    insertTables: string[];
    updates: MockRow[];
    updateTables: string[];
    updateWheres: unknown[];
  } = { inserts: [], insertTables: [], updates: [], updateTables: [], updateWheres: [] };

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
    const methods = ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin", "groupBy"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
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

const companyScopedPolicyRow = {
  id: "pol-co-1",
  companyId: SRC_CO_ID,
  scopeType: "company",
  scopeId: SRC_CO_ID,
  metric: "cost_cents",
  windowKind: "calendar_month_utc",
  amountCents: 500_000,
  warnPercent: 80,
  hardStopEnabled: true,
  notifyEnabled: true,
  isActive: true,
  createdByUserId: "founder-1",
  updatedByUserId: "founder-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-04-01T00:00:00Z"),
};

const agentScopedPolicyRow = {
  id: "pol-ag-1",
  companyId: SRC_CO_ID,
  scopeType: "agent",
  scopeId: SRC_AGENT_ID,
  metric: "cost_cents",
  windowKind: "calendar_month_utc",
  amountCents: 50_000,
  warnPercent: 75,
  hardStopEnabled: false,
  notifyEnabled: true,
  isActive: true,
  createdByUserId: "founder-1",
  updatedByUserId: "founder-1",
  createdAt: new Date("2026-02-01T00:00:00Z"),
  updatedAt: new Date("2026-04-10T00:00:00Z"),
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
      budgetPolicies: true,
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

describe("company-portability budget policies — export", () => {
  it("DEFAULT_INCLUDE.budgetPolicies is false (opt-in)", async () => {
    const { db } = createSequenceDb({ selects: [] });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false },
    });

    expect(result.manifest.budgetPolicies).toBeUndefined();
  });

  it("export with include.budgetPolicies=true serializes company-scoped policies", async () => {
    const { db } = createSequenceDb({
      selects: [
        // budget policies fetch
        [companyScopedPolicyRow],
      ],
    });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
    });

    expect(result.manifest.budgetPolicies).toBeDefined();
    expect(result.manifest.budgetPolicies!.length).toBe(1);
    const policy = result.manifest.budgetPolicies![0]!;
    expect(policy).toMatchObject({
      scopeType: "company",
      metric: "cost_cents",
      windowKind: "calendar_month_utc",
      amountCents: 500_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    expect(policy.scopeAgentSlug ?? null).toBeNull();
    expect(policy.slug).toContain("company");
  });

  it("export agent-scoped policies include scopeAgentSlug via agent slug map", async () => {
    const { db } = createSequenceDb({
      selects: [
        // budget policies fetch
        [agentScopedPolicyRow],
      ],
    });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, internalAgentConfig: false, budgetPolicies: true },
    });

    expect(result.manifest.budgetPolicies).toBeDefined();
    const policy = result.manifest.budgetPolicies![0]!;
    expect(policy.scopeType).toBe("agent");
    expect(policy.scopeAgentSlug).toBe("builder-agent");
    expect(policy.slug).toContain("builder-agent");
  });

  it("export warns + skips agent-scoped policy when agent not in source agents", async () => {
    const orphanRow = { ...agentScopedPolicyRow, scopeId: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
    const { db } = createSequenceDb({
      selects: [[orphanRow]],
    });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, internalAgentConfig: false, budgetPolicies: true },
    });

    expect(result.manifest.budgetPolicies).toBeDefined();
    expect(result.manifest.budgetPolicies!.length).toBe(0);
    expect(result.warnings.some((w) =>
      typeof w === "string" ? w.toLowerCase().includes("budget policy") : false,
    )).toBe(true);
  });

  it("export excludes PK / FK / timestamp / audit columns from manifest", async () => {
    const { db } = createSequenceDb({
      selects: [[companyScopedPolicyRow]],
    });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
    });

    const policy = result.manifest.budgetPolicies![0]! as unknown as Record<string, unknown>;
    expect(policy.id).toBeUndefined();
    expect(policy.companyId).toBeUndefined();
    expect(policy.scopeId).toBeUndefined();
    expect(policy.createdAt).toBeUndefined();
    expect(policy.updatedAt).toBeUndefined();
    expect(policy.createdByUserId).toBeUndefined();
    expect(policy.updatedByUserId).toBeUndefined();
  });

  it("previewExport surfaces budgetPolicies count", async () => {
    const { db } = createSequenceDb({
      selects: [[companyScopedPolicyRow, agentScopedPolicyRow]],
    });
    const svc = companyPortabilityService(db as any);

    const preview = await svc.previewExport(SRC_CO_ID, {
      include: { agents: true, internalAgentConfig: false, budgetPolicies: true },
    });

    expect(preview.counts.budgetPolicies).toBe(2);
  });
});

// ── Import tests ─────────────────────────────────────────────────────────────

describe("company-portability budget policies — import", () => {
  it("import inserts company-scoped policy bound to target companyId", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        // existing policies lookup (collision check) — none
        [],
      ],
      inserts: [[{ id: "new-pol" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      budgetPolicies: [
        {
          slug: "company-cost_cents-calendar_month_utc",
          scopeType: "company",
          scopeAgentSlug: null,
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
          amountCents: 500_000,
          warnPercent: 80,
          hardStopEnabled: true,
          notifyEnabled: true,
          isActive: true,
          metadata: null,
        },
      ],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
      },
      "importer-1",
    );

    const budgetInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "budget_policies",
    );
    expect(budgetInserts.length).toBe(1);
    const inserted = budgetInserts[0]!;
    expect(inserted).toMatchObject({
      companyId: TGT_CO_ID,
      scopeType: "company",
      scopeId: TGT_CO_ID,
      metric: "cost_cents",
      windowKind: "calendar_month_utc",
      amountCents: 500_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
  });

  it("import resolves scopeAgentSlug via agent slug map for agent-scoped policy", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        // existing policies lookup — none
        [],
      ],
      inserts: [[{ id: "new-pol" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      includes: {
        company: true,
        agents: false,
        projects: false,
        issues: false,
        skills: false,
        routines: false,
        envInputs: false,
        internalAgentConfig: false,
        budgetPolicies: true,
      },
      budgetPolicies: [
        {
          slug: "agent-builder-agent-cost_cents-calendar_month_utc",
          scopeType: "agent",
          scopeAgentSlug: "builder-agent",
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
          amountCents: 50_000,
          warnPercent: 75,
          hardStopEnabled: false,
          notifyEnabled: true,
          isActive: true,
          metadata: null,
        },
      ],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
      },
      "importer-1",
    );

    const budgetInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "budget_policies",
    );
    expect(budgetInserts.length).toBe(1);
    expect(budgetInserts[0]).toMatchObject({
      companyId: TGT_CO_ID,
      scopeType: "agent",
      scopeId: TGT_AGENT_ID,
      metric: "cost_cents",
      amountCents: 50_000,
      warnPercent: 75,
      hardStopEnabled: false,
    });
  });

  it("import warns + skips when scopeAgentSlug not resolvable", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      budgetPolicies: [
        {
          slug: "agent-ghost-agent-cost_cents-calendar_month_utc",
          scopeType: "agent",
          scopeAgentSlug: "ghost-agent",
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
          amountCents: 10_000,
          warnPercent: 80,
          hardStopEnabled: false,
          notifyEnabled: true,
          isActive: true,
          metadata: null,
        },
      ],
    });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
      },
      "importer-1",
    );

    const budgetInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "budget_policies",
    );
    expect(budgetInserts.length).toBe(0);
    expect(result.warnings.some((w) =>
      w.kind === "link_failed" && typeof w.message === "string" && w.message.toLowerCase().includes("budget policy"),
    )).toBe(true);
  });

  it("import with collision strategy 'skip' preserves existing policy (default)", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        // existing policy collision
        [{
          id: "existing-pol",
          companyId: TGT_CO_ID,
          scopeType: "company",
          scopeId: TGT_CO_ID,
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
        }],
      ],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      budgetPolicies: [
        {
          slug: "company-cost_cents-calendar_month_utc",
          scopeType: "company",
          scopeAgentSlug: null,
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
          amountCents: 900_000,
          warnPercent: 90,
          hardStopEnabled: true,
          notifyEnabled: true,
          isActive: true,
          metadata: null,
        },
      ],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
        collisionStrategy: "skip",
      },
      "importer-1",
    );

    const budgetInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "budget_policies",
    );
    const budgetUpdates = captured.updates.filter(
      (_row, idx) => captured.updateTables[idx] === "budget_policies",
    );
    expect(budgetInserts.length).toBe(0);
    expect(budgetUpdates.length).toBe(0);
  });

  it("import with collision strategy 'replace' overwrites existing policy", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        // existing policy collision
        [{
          id: "existing-pol",
          companyId: TGT_CO_ID,
          scopeType: "company",
          scopeId: TGT_CO_ID,
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
        }],
      ],
      updates: [[{ id: "existing-pol" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      budgetPolicies: [
        {
          slug: "company-cost_cents-calendar_month_utc",
          scopeType: "company",
          scopeAgentSlug: null,
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
          amountCents: 900_000,
          warnPercent: 90,
          hardStopEnabled: true,
          notifyEnabled: true,
          isActive: true,
          metadata: null,
        },
      ],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
        collisionStrategy: "replace",
      },
      "importer-1",
    );

    const budgetUpdates = captured.updates.filter(
      (_row, idx) => captured.updateTables[idx] === "budget_policies",
    );
    expect(budgetUpdates.length).toBe(1);
    expect(budgetUpdates[0]).toMatchObject({
      amountCents: 900_000,
      warnPercent: 90,
    });
  });

  it("import sets updatedByUserId to the importing user (audit field)", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[]],
      inserts: [[{ id: "new-pol" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      budgetPolicies: [
        {
          slug: "company-cost_cents-calendar_month_utc",
          scopeType: "company",
          scopeAgentSlug: null,
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
          amountCents: 100_000,
          warnPercent: 80,
          hardStopEnabled: true,
          notifyEnabled: true,
          isActive: true,
          metadata: null,
        },
      ],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
      },
      "importer-1",
    );

    const budgetInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "budget_policies",
    );
    expect(budgetInserts[0]).toMatchObject({
      createdByUserId: "importer-1",
      updatedByUserId: "importer-1",
    });
  });

  it("budgetPolicies section is not warned as unknown_section", async () => {
    const { db } = createSequenceDb({
      selects: [[]],
      inserts: [[{ id: "new-pol" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      budgetPolicies: [
        {
          slug: "company-cost_cents-calendar_month_utc",
          scopeType: "company",
          scopeAgentSlug: null,
          metric: "cost_cents",
          windowKind: "calendar_month_utc",
          amountCents: 100_000,
          warnPercent: 80,
          hardStopEnabled: true,
          notifyEnabled: true,
          isActive: true,
          metadata: null,
        },
      ],
    });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
      },
      "importer-1",
    );

    const unknownWarnings = result.warnings.filter(
      (w) => w.kind === "unknown_section" && w.section === "budgetPolicies",
    );
    expect(unknownWarnings).toEqual([]);
  });

  it("import with no budgetPolicies in bundle is a no-op (older export)", async () => {
    const { db, captured } = createSequenceDb({});
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest();
    delete (manifest as Partial<CompanyPortabilityManifest>).budgetPolicies;

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, budgetPolicies: true },
      },
      "importer-1",
    );

    const budgetInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "budget_policies",
    );
    const budgetUpdates = captured.updates.filter(
      (_row, idx) => captured.updateTables[idx] === "budget_policies",
    );
    expect(budgetInserts.length).toBe(0);
    expect(budgetUpdates.length).toBe(0);
  });
});
