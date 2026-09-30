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
  };
});

// ── Service mocks ─────────────────────────────────────────────────────────────

const SRC_CO_ID = "11111111-1111-4111-8111-111111111111";
const TGT_CO_ID = "22222222-2222-4222-8222-222222222222";

const companyStore: Record<string, { id: string; name: string; description: string | null; brandColor: string | null; requireBoardApprovalForNewAgents: boolean }> = {
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
  const captured: { inserts: MockRow[]; updates: MockRow[]; updateWheres: unknown[] } = {
    inserts: [],
    updates: [],
    updateWheres: [],
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

  return {
    db: {
      select: (_fields?: unknown) =>
        makeSelectChain(() => config.selects?.[selectIdx++] ?? []),
      insert: (_table: unknown) =>
        makeInsertChain(() => config.inserts?.[insertIdx++] ?? []),
      update: (_table: unknown) =>
        makeUpdateChain(() => config.updates?.[updateIdx++] ?? []),
    },
    captured,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const sampleConfigRow = {
  id: "cfg-1",
  companyId: SRC_CO_ID,
  executionMode: "api",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  cliTool: null,
  // D18: deliberately DIFFERENT from crewAutonomyLevel so an export that
  // serialized the wrong column would be visible in the assertions below.
  autonomyLevel: 0,
  crewAutonomyLevel: 2,
  enabledCapabilities: [
    "discussion_processing",
    "proactive_suggestions",
    "organizational_queries",
  ],
  notificationPreference: "realtime",
  contextTokenBudget: 8000,
  budgetMonthlyCents: 5000,
  spentMonthlyCents: 1234,
  proactiveIntervalMinutes: 240,
  lastProactiveRunAt: new Date("2026-04-20T12:00:00Z"),
  metadata: { note: "founder-tuned" },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-04-20T12:00:00Z"),
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
      internalAgentConfig: true,
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

describe("company-portability internal agent config — export", () => {
  it("exportBundle with include.internalAgentConfig=true serializes the config row", async () => {
    const { db } = createSequenceDb({ selects: [[sampleConfigRow]] });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: true },
    });

    expect(result.manifest.internalAgentConfig).toBeDefined();
    expect(result.manifest.internalAgentConfig).toMatchObject({
      executionMode: "api",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      // D18: both dials are exported, each from its own column. `toMatchObject`
      // would let a missing/crossed field slide, so both are named explicitly.
      autonomyLevel: 0,
      crewAutonomyLevel: 2,
      notificationPreference: "realtime",
      contextTokenBudget: 8000,
      budgetMonthlyCents: 5000,
      proactiveIntervalMinutes: 240,
    });
    expect(result.manifest.internalAgentConfig?.enabledCapabilities).toEqual([
      "discussion_processing",
      "proactive_suggestions",
      "organizational_queries",
    ]);
  });

  it("serialization excludes PK/FK/timestamp and runtime state fields", async () => {
    const { db } = createSequenceDb({ selects: [[sampleConfigRow]] });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: true },
    });

    const cfg = result.manifest.internalAgentConfig as Record<string, unknown>;
    expect(cfg.id).toBeUndefined();
    expect(cfg.companyId).toBeUndefined();
    expect(cfg.createdAt).toBeUndefined();
    expect(cfg.updatedAt).toBeUndefined();
    expect(cfg.spentMonthlyCents).toBeUndefined();
    expect(cfg.lastProactiveRunAt).toBeUndefined();
  });

  it("exportBundle with include.internalAgentConfig=false omits section", async () => {
    // No select calls expected for config since it's excluded
    const { db } = createSequenceDb({ selects: [] });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false },
    });

    expect(result.manifest.internalAgentConfig).toBeUndefined();
  });

  it("exportBundle omits section when no config row exists for company", async () => {
    const { db } = createSequenceDb({ selects: [[]] });
    const svc = companyPortabilityService(db as any);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: true },
    });

    expect(result.manifest.internalAgentConfig).toBeUndefined();
  });

  it("previewExport counts internalAgentConfig as 0 or 1", async () => {
    const { db } = createSequenceDb({ selects: [[sampleConfigRow]] });
    const svc = companyPortabilityService(db as any);

    const preview = await svc.previewExport(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: true },
    });

    expect(preview.counts.internalAgentConfig).toBe(1);
  });
});

describe("company-portability internal agent config — import", () => {
  it("import creates internalAgentConfig for target company when none exists", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        // existingConfig lookup — empty (target has no config)
        [],
      ],
      inserts: [[{ id: "new-cfg" }]],
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
        internalAgentConfig: true,
      },
      internalAgentConfig: {
        executionMode: "api",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        cliTool: null,
        autonomyLevel: 0,
        enabledCapabilities: ["discussion_processing"],
        notificationPreference: "realtime",
        contextTokenBudget: 8000,
        budgetMonthlyCents: 5000,
        proactiveIntervalMinutes: 240,
        metadata: { note: "portable" },
      },
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: true },
      },
      "user-1",
    );

    expect(captured.inserts.length).toBeGreaterThanOrEqual(1);
    const inserted = captured.inserts.find(
      (row) => (row as { executionMode?: string }).executionMode === "api",
    );
    expect(inserted).toBeDefined();
    expect(inserted).toMatchObject({
      companyId: TGT_CO_ID,
      executionMode: "api",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      autonomyLevel: 0,
      // D18: a pre-split bundle carries no `crewAutonomyLevel`, so the importer
      // falls back to the shared value — reproducing exactly the crew behaviour
      // the bundle was exported with.
      crewAutonomyLevel: 0,
      notificationPreference: "realtime",
      contextTokenBudget: 8000,
      budgetMonthlyCents: 5000,
      proactiveIntervalMinutes: 240,
    });
  });

  it("import updates internalAgentConfig when target already has one (upsert)", async () => {
    const { db, captured } = createSequenceDb({
      selects: [
        // existingConfig lookup — returns existing row (service mocks absorb all non-db calls)
        [{ id: "existing-cfg", companyId: TGT_CO_ID }],
      ],
      updates: [[{ id: "existing-cfg" }]],
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
        internalAgentConfig: true,
      },
      internalAgentConfig: {
        executionMode: "cli",
        provider: null,
        model: null,
        cliTool: "claude_cli",
        autonomyLevel: 1,
        enabledCapabilities: ["system_actions", "memory_management"],
        notificationPreference: "digest",
        contextTokenBudget: 12000,
        budgetMonthlyCents: null,
        proactiveIntervalMinutes: 60,
        metadata: {},
      },
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: true },
      },
      "user-1",
    );

    expect(captured.updates.length).toBeGreaterThanOrEqual(1);
    const updated = captured.updates.find(
      (row) => (row as { executionMode?: string }).executionMode === "cli",
    );
    expect(updated).toBeDefined();
    expect(updated).toMatchObject({
      executionMode: "cli",
      cliTool: "claude_cli",
      autonomyLevel: 1,
      // D18: pre-split bundle (no crewAutonomyLevel) → `?? autonomyLevel`.
      crewAutonomyLevel: 1,
      notificationPreference: "digest",
      contextTokenBudget: 12000,
      budgetMonthlyCents: null,
      proactiveIntervalMinutes: 60,
    });
    // Upsert must NOT insert when existing row present
    expect(captured.inserts.length).toBe(0);
  });

  // D18 discriminator — nullish (??) vs falsy (||). A POST-split bundle that
  // deliberately says "crew = Manual(0)" while Commander sits at 1 is the ONLY
  // shape that distinguishes the two operators: `cfg.crewAutonomyLevel ?? cfg.autonomyLevel`
  // writes 0, whereas `||` would swallow the 0 and write 1 — silently promoting
  // a founder's Manual crew to Assist on every import. The string-match guard in
  // d18-autonomy-dial-split.test.ts pins the source; this pins the behaviour.
  it("import honours an explicit crewAutonomyLevel of 0 (nullish fallback, not falsy)", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[{ id: "existing-cfg", companyId: TGT_CO_ID }]],
      updates: [[{ id: "existing-cfg" }]],
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
        internalAgentConfig: true,
      },
      internalAgentConfig: {
        executionMode: "cli",
        provider: null,
        model: null,
        cliTool: "claude_cli",
        autonomyLevel: 1,
        crewAutonomyLevel: 0,
        enabledCapabilities: ["system_actions"],
        notificationPreference: "digest",
        contextTokenBudget: 12000,
        budgetMonthlyCents: null,
        proactiveIntervalMinutes: 60,
        metadata: {},
      },
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: true },
      },
      "user-1",
    );

    const updated = captured.updates.find(
      (row) => (row as { executionMode?: string }).executionMode === "cli",
    );
    expect(updated).toBeDefined();
    expect((updated as { crewAutonomyLevel?: number }).crewAutonomyLevel).toBe(0);
    // ...and the two dials stayed independent through the round trip.
    expect((updated as { autonomyLevel?: number }).autonomyLevel).toBe(1);
  });

  it("import with no internalAgentConfig in bundle is a no-op (older export)", async () => {
    const { db, captured } = createSequenceDb({});
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest();
    // Remove internalAgentConfig from bundle
    delete (manifest as Partial<CompanyPortabilityManifest>).internalAgentConfig;

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: true },
      },
      "user-1",
    );

    expect(captured.inserts.length).toBe(0);
    expect(captured.updates.length).toBe(0);
    // No warnings about missing internal agent config — it's optional
    expect(result.warnings.some((w) => w.message?.toLowerCase().includes("internal agent"))).toBe(false);
  });

  it("internalAgentConfig section is not warned as unknown_section", async () => {
    const { db } = createSequenceDb({
      selects: [[]],
      inserts: [[{ id: "new-cfg" }]],
    });
    const svc = companyPortabilityService(db as any);

    const manifest = baseManifest({
      internalAgentConfig: {
        executionMode: "api",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        cliTool: null,
        autonomyLevel: 0,
        enabledCapabilities: [],
        notificationPreference: "realtime",
        contextTokenBudget: 8000,
        budgetMonthlyCents: null,
        proactiveIntervalMinutes: 240,
        metadata: null,
      },
    });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: true },
      },
      "user-1",
    );

    const unknownWarnings = result.warnings.filter(
      (w) => w.kind === "unknown_section" && w.section === "internalAgentConfig",
    );
    expect(unknownWarnings).toEqual([]);
  });
});
