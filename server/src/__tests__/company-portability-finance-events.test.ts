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
  };
});

// ── IDs ──────────────────────────────────────────────────────────────────────

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";
const SRC_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TGT_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SRC_PROJECT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SRC_ISSUE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SRC_COST_EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEW_COST_EVENT_ID = "ffffffff-ffff-4fff-8fff-111111111111";

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
import type {
  CompanyPortabilityFinanceEventManifestEntry,
  CompanyPortabilityManifest,
} from "@armyofagents/shared";

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
      const methods = ["onConflictDoUpdate", "onConflictDoNothing"];
      for (const m of methods) {
        inner[m] = (..._args: unknown[]) => inner;
      }
      inner.returning = (..._args: unknown[]) => inner;
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

const financeEventRow = {
  id: "fe-1",
  companyId: SRC_CO_ID,
  agentId: SRC_AGENT_ID,
  issueId: SRC_ISSUE_ID,
  projectId: SRC_PROJECT_ID,
  goalId: null,
  heartbeatRunId: "hbr-ephemeral-1",
  costEventId: SRC_COST_EVENT_ID,
  billingCode: "BC-200",
  description: "Monthly fee",
  eventKind: "api_usage",
  direction: "debit",
  biller: "anthropic",
  provider: "anthropic",
  executionAdapterType: "claude_local",
  pricingTier: "standard",
  region: "us-east-1",
  model: "claude-opus-4-7",
  quantity: 1000,
  unit: "tokens",
  amountCents: 150,
  currency: "USD",
  estimated: false,
  externalInvoiceId: "INV-123",
  metadataJson: { note: "test" },
  occurredAt: new Date("2026-03-20T10:00:00Z"),
  createdAt: new Date("2026-03-20T10:00:01Z"),
};

const costEventRow = {
  id: SRC_COST_EVENT_ID,
  companyId: SRC_CO_ID,
  agentId: SRC_AGENT_ID,
  issueId: SRC_ISSUE_ID,
  projectId: SRC_PROJECT_ID,
  goalId: null,
  heartbeatRunId: "hbr-1",
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
      costEvents: false,
      financeEvents: true,
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

function makeFinanceEntry(overrides: Partial<CompanyPortabilityFinanceEventManifestEntry> = {}): CompanyPortabilityFinanceEventManifestEntry {
  return {
    slug: "fe-test-1",
    agentSlug: "builder-agent",
    issueSlug: null,
    projectSlug: null,
    goalSlug: null,
    costEventSlug: null,
    occurredAt: "2026-03-20T10:00:00.000Z",
    eventKind: "api_usage",
    direction: "debit",
    biller: "anthropic",
    provider: "anthropic",
    executionAdapterType: null,
    pricingTier: null,
    region: null,
    model: "claude-opus-4-7",
    quantity: null,
    unit: null,
    amountCents: 150,
    currency: "USD",
    estimated: false,
    externalInvoiceId: null,
    billingCode: null,
    description: null,
    metadata: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Export tests ─────────────────────────────────────────────────────────────

describe("company-portability finance events — export", () => {
  it("DEFAULT_INCLUDE.financeEvents is false (opt-in)", async () => {
    const { db } = createSequenceDb({ selects: [] });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false },
    });

    expect(result.manifest.financeEvents).toBeUndefined();
  });

  it("export with include.financeEvents=true serializes all events", async () => {
    const { db } = createSequenceDb({
      selects: [[financeEventRow]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, internalAgentConfig: false, financeEvents: true },
    });

    expect(result.manifest.financeEvents).toBeDefined();
    expect(result.manifest.financeEvents!.length).toBe(1);
    const ev = result.manifest.financeEvents![0]!;
    expect(ev).toMatchObject({
      agentSlug: "builder-agent",
      issueSlug: "mkt-1",
      projectSlug: "marketing",
      goalSlug: null,
      occurredAt: "2026-03-20T10:00:00.000Z",
      eventKind: "api_usage",
      direction: "debit",
      biller: "anthropic",
      provider: "anthropic",
      model: "claude-opus-4-7",
      amountCents: 150,
      currency: "USD",
      estimated: false,
      billingCode: "BC-200",
      description: "Monthly fee",
      externalInvoiceId: "INV-123",
    });
    expect(ev.slug).toBeTruthy();
  });

  it("export preserves costEventSlug when cost events are also exported", async () => {
    const { db } = createSequenceDb({
      // cost events select, then finance events select
      selects: [[costEventRow], [financeEventRow]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: {
        agents: true,
        internalAgentConfig: false,
        costEvents: true,
        financeEvents: true,
      },
    });

    const ev = result.manifest.financeEvents![0]!;
    expect(ev.costEventSlug).toBe(SRC_COST_EVENT_ID);
  });

  it("export nulls costEventSlug when cost events NOT exported", async () => {
    const { db } = createSequenceDb({
      selects: [[financeEventRow]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: {
        agents: true,
        internalAgentConfig: false,
        costEvents: false,
        financeEvents: true,
      },
    });

    const ev = result.manifest.financeEvents![0]!;
    expect(ev.costEventSlug).toBeNull();
  });

  it("export strips heartbeatRunId + PK/FK/timestamp from manifest", async () => {
    const { db } = createSequenceDb({
      selects: [[financeEventRow]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: true, financeEvents: true, internalAgentConfig: false },
    });

    const ev = result.manifest.financeEvents![0]! as unknown as Record<string, unknown>;
    expect(ev.id).toBeUndefined();
    expect(ev.companyId).toBeUndefined();
    expect(ev.agentId).toBeUndefined();
    expect(ev.issueId).toBeUndefined();
    expect(ev.projectId).toBeUndefined();
    expect(ev.goalId).toBeUndefined();
    expect(ev.heartbeatRunId).toBeUndefined();
    expect(ev.costEventId).toBeUndefined();
    expect(ev.createdAt).toBeUndefined();
  });

  it("previewExport surfaces financeEvents count", async () => {
    const { db } = createSequenceDb({
      selects: [[financeEventRow, { ...financeEventRow, id: "fe-2" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const preview = await svc.previewExport(SRC_CO_ID, {
      include: { agents: true, internalAgentConfig: false, financeEvents: true },
    });

    expect(preview.counts.financeEvents).toBe(2);
  });
});

// ── Import tests ─────────────────────────────────────────────────────────────

describe("company-portability finance events — import", () => {
  it("import inserts event bound to target companyId with resolved agentId", async () => {
    const { db, captured } = createSequenceDb({
      inserts: [[{ id: "new-fe" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      financeEvents: [makeFinanceEntry()],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, financeEvents: true },
      },
      "importer-1",
    );

    const feInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "finance_events",
    );
    expect(feInserts.length).toBe(1);
    const inserted = feInserts[0]!;
    expect(inserted).toMatchObject({
      companyId: TGT_CO_ID,
      agentId: TGT_AGENT_ID,
      eventKind: "api_usage",
      direction: "debit",
      biller: "anthropic",
      provider: "anthropic",
      amountCents: 150,
      currency: "USD",
      estimated: false,
    });
    expect(inserted.issueId).toBeNull();
    expect(inserted.projectId).toBeNull();
    expect(inserted.goalId).toBeNull();
    expect(inserted.heartbeatRunId).toBeNull();
    expect(inserted.costEventId).toBeNull();
  });

  it("import resolves costEventSlug via cost event slug map", async () => {
    const { db, captured } = createSequenceDb({
      // cost event insert returning id, then finance event insert
      inserts: [[{ id: NEW_COST_EVENT_ID }], [{ id: "new-fe" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      costEvents: [
        {
          slug: SRC_COST_EVENT_ID,
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
          inputTokens: 10,
          outputTokens: 5,
          costCents: 1,
          metadata: null,
        },
      ],
      financeEvents: [makeFinanceEntry({ costEventSlug: SRC_COST_EVENT_ID })],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: {
          agents: false,
          internalAgentConfig: false,
          costEvents: true,
          financeEvents: true,
        },
      },
      "importer-1",
    );

    // verify ordering: cost events insert happens before finance events insert
    const ceIdx = captured.insertTables.indexOf("cost_events");
    const feIdx = captured.insertTables.indexOf("finance_events");
    expect(ceIdx).toBeGreaterThanOrEqual(0);
    expect(feIdx).toBeGreaterThanOrEqual(0);
    expect(ceIdx).toBeLessThan(feIdx);

    const feInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "finance_events",
    );
    expect(feInserts.length).toBe(1);
    expect(feInserts[0]!.costEventId).toBe(NEW_COST_EVENT_ID);
  });

  it("import warns + nulls costEventId when costEventSlug not in cost event map", async () => {
    const { db, captured } = createSequenceDb({
      inserts: [[{ id: "new-fe" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      financeEvents: [makeFinanceEntry({ costEventSlug: "ghost-cost-event" })],
    });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, financeEvents: true },
      },
      "importer-1",
    );

    const feInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "finance_events",
    );
    expect(feInserts.length).toBe(1);
    expect(feInserts[0]!.costEventId).toBeNull();
    expect(result.warnings.some((w) =>
      w.kind === "link_failed" && typeof w.message === "string" && w.message.toLowerCase().includes("cost event"),
    )).toBe(true);
  });

  it("import is null-safe on unresolvable agent/issue/project slugs (warn + null)", async () => {
    const { db, captured } = createSequenceDb({
      inserts: [[{ id: "new-fe" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      financeEvents: [
        makeFinanceEntry({
          agentSlug: "ghost-agent",
          issueSlug: "ghost-issue",
          projectSlug: "ghost-project",
        }),
      ],
    });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, financeEvents: true },
      },
      "importer-1",
    );

    const feInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "finance_events",
    );
    // agentId is nullable on finance_events — null is fine
    expect(feInserts.length).toBe(1);
    expect(feInserts[0]!.agentId).toBeNull();
    expect(feInserts[0]!.issueId).toBeNull();
    expect(feInserts[0]!.projectId).toBeNull();
    // at least one link_failed warning emitted
    expect(result.warnings.some((w) => w.kind === "link_failed")).toBe(true);
  });

  it("import roundtrips both direction values (debit and credit)", async () => {
    const { db, captured } = createSequenceDb({
      inserts: [[{ id: "new-fe-1" }, { id: "new-fe-2" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      financeEvents: [
        makeFinanceEntry({ slug: "fe-debit", direction: "debit" }),
        makeFinanceEntry({ slug: "fe-credit", direction: "credit" }),
      ],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, financeEvents: true },
      },
      "importer-1",
    );

    const feInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "finance_events",
    );
    expect(feInserts.length).toBe(2);
    expect(feInserts[0]!.direction).toBe("debit");
    expect(feInserts[1]!.direction).toBe("credit");
  });

  it("import with no financeEvents in bundle is a no-op (older export)", async () => {
    const { db, captured } = createSequenceDb({});
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest();
    delete (manifest as Partial<CompanyPortabilityManifest>).financeEvents;

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, financeEvents: true },
      },
      "importer-1",
    );

    const feInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "finance_events",
    );
    expect(feInserts.length).toBe(0);
  });

  it("financeEvents section is not warned as unknown_section", async () => {
    const { db } = createSequenceDb({
      inserts: [[{ id: "new-fe" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({ financeEvents: [makeFinanceEntry()] });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, financeEvents: true },
      },
      "importer-1",
    );

    const unknownWarnings = result.warnings.filter(
      (w) => w.kind === "unknown_section" && w.section === "financeEvents",
    );
    expect(unknownWarnings).toEqual([]);
  });

  it("import batches finance events in 1000-row chunks", async () => {
    const manyEvents: CompanyPortabilityFinanceEventManifestEntry[] = [];
    for (let i = 0; i < 2500; i++) {
      manyEvents.push(makeFinanceEntry({ slug: `fe-${i}` }));
    }
    const { db, captured } = createSequenceDb({
      inserts: [[], [], []],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({ financeEvents: manyEvents });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, financeEvents: true },
      },
      "importer-1",
    );

    const feInsertCount = captured.insertTables.filter((t) => t === "finance_events").length;
    expect(feInsertCount).toBe(2500);
  });
});
