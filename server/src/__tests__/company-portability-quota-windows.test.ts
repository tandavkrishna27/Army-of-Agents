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
import type {
  CompanyPortabilityQuotaWindowManifestEntry,
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

const quotaRow = {
  id: "qw-1",
  companyId: SRC_CO_ID,
  provider: "anthropic",
  model: "claude-opus-4-7",
  windowKind: "5h",
  label: "5-hour rolling",
  limitValue: 300000,
  usedValue: 50000,
  usedPercent: 16,
  valueLabel: null,
  resetAt: new Date("2026-04-21T14:00:00Z"),
  lastUpdatedAt: new Date("2026-04-21T10:00:00Z"),
  createdAt: new Date("2026-04-20T10:00:00Z"),
};

const quotaRowB = {
  id: "qw-2",
  companyId: SRC_CO_ID,
  provider: "openai",
  model: null,
  windowKind: "24h",
  label: null,
  limitValue: null,
  usedValue: null,
  usedPercent: null,
  valueLabel: "within limits",
  resetAt: null,
  lastUpdatedAt: new Date("2026-04-21T09:30:00Z"),
  createdAt: new Date("2026-04-20T09:30:00Z"),
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
      financeEvents: false,
      quotaWindows: true,
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

function makeQuotaEntry(overrides: Partial<CompanyPortabilityQuotaWindowManifestEntry> = {}): CompanyPortabilityQuotaWindowManifestEntry {
  return {
    slug: "qw-default",
    provider: "anthropic",
    model: "claude-opus-4-7",
    windowKind: "5h",
    label: "5-hour rolling",
    limitValue: 300000,
    usedValue: 50000,
    usedPercent: 16,
    valueLabel: null,
    resetAt: "2026-04-21T14:00:00.000Z",
    lastUpdatedAt: "2026-04-21T10:00:00.000Z",
    metadata: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Export tests ─────────────────────────────────────────────────────────────

describe("company-portability quota windows — export", () => {
  it("DEFAULT_INCLUDE.quotaWindows is false (opt-in)", async () => {
    const { db } = createSequenceDb({ selects: [] });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false },
    });

    expect(result.manifest.quotaWindows).toBeUndefined();
  });

  it("export with include.quotaWindows=true serializes all snapshots", async () => {
    const { db } = createSequenceDb({
      selects: [[quotaRow, quotaRowB]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, quotaWindows: true },
    });

    expect(result.manifest.quotaWindows).toBeDefined();
    expect(result.manifest.quotaWindows!.length).toBe(2);

    const first = result.manifest.quotaWindows![0]!;
    expect(first).toMatchObject({
      provider: "anthropic",
      model: "claude-opus-4-7",
      windowKind: "5h",
      label: "5-hour rolling",
      limitValue: 300000,
      usedValue: 50000,
      usedPercent: 16,
      valueLabel: null,
      resetAt: "2026-04-21T14:00:00.000Z",
      lastUpdatedAt: "2026-04-21T10:00:00.000Z",
    });
    expect(first.slug).toBeTruthy();

    const second = result.manifest.quotaWindows![1]!;
    expect(second).toMatchObject({
      provider: "openai",
      model: null,
      windowKind: "24h",
      valueLabel: "within limits",
      limitValue: null,
      usedValue: null,
      resetAt: null,
    });
  });

  it("export strips PK/FK/createdAt from manifest", async () => {
    const { db } = createSequenceDb({
      selects: [[quotaRow]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const result = await svc.exportBundle(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, quotaWindows: true },
    });

    const qw = result.manifest.quotaWindows![0]! as unknown as Record<string, unknown>;
    expect(qw.id).toBeUndefined();
    expect(qw.companyId).toBeUndefined();
    expect(qw.createdAt).toBeUndefined();
  });

  it("previewExport surfaces quotaWindows count", async () => {
    const { db } = createSequenceDb({
      selects: [[quotaRow, quotaRowB]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const preview = await svc.previewExport(SRC_CO_ID, {
      include: { agents: false, internalAgentConfig: false, quotaWindows: true },
    });

    expect(preview.counts.quotaWindows).toBe(2);
  });
});

// ── Import tests ─────────────────────────────────────────────────────────────

describe("company-portability quota windows — import", () => {
  it("import inserts snapshots bound to target companyId", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[]], // no existing rows — pure insert path
      inserts: [[{ id: "new-qw" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      quotaWindows: [makeQuotaEntry()],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, quotaWindows: true },
      },
      "importer-1",
    );

    const qwInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "provider_quota_windows",
    );
    expect(qwInserts.length).toBe(1);
    expect(qwInserts[0]).toMatchObject({
      companyId: TGT_CO_ID,
      provider: "anthropic",
      model: "claude-opus-4-7",
      windowKind: "5h",
      limitValue: 300000,
      usedValue: 50000,
    });
  });

  it("import preserves lastUpdatedAt from bundle (not import time)", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[]],
      inserts: [[{ id: "new-qw" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      quotaWindows: [makeQuotaEntry({ lastUpdatedAt: "2026-04-21T10:00:00.000Z" })],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, quotaWindows: true },
      },
      "importer-1",
    );

    const qwInsert = captured.inserts.find(
      (_row, idx) => captured.insertTables[idx] === "provider_quota_windows",
    );
    expect(qwInsert).toBeTruthy();
    const lastUpdatedAt = qwInsert!.lastUpdatedAt;
    expect(lastUpdatedAt).toBeInstanceOf(Date);
    expect((lastUpdatedAt as Date).toISOString()).toBe("2026-04-21T10:00:00.000Z");
  });

  it("import upserts on (provider, model, windowKind) — existing row is updated, not duplicated", async () => {
    // First select returns existing row; no insert; update instead.
    const { db, captured } = createSequenceDb({
      selects: [[{ id: "existing-qw-id" }]],
      updates: [[]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      quotaWindows: [makeQuotaEntry({ usedValue: 99999 })],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, quotaWindows: true },
      },
      "importer-1",
    );

    const qwInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "provider_quota_windows",
    );
    expect(qwInserts.length).toBe(0);

    const qwUpdates = captured.updates.filter(
      (_row, idx) => captured.updateTables[idx] === "provider_quota_windows",
    );
    expect(qwUpdates.length).toBe(1);
    expect(qwUpdates[0]).toMatchObject({ usedValue: 99999 });
  });

  it("import appends staleness warning on successful quota windows import", async () => {
    const { db } = createSequenceDb({
      selects: [[]],
      inserts: [[{ id: "new-qw" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      quotaWindows: [makeQuotaEntry()],
    });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, quotaWindows: true },
      },
      "importer-1",
    );

    expect(result.warnings.some((w) =>
      typeof w.message === "string" && /point-in-time|refresh|stale/i.test(w.message),
    )).toBe(true);
  });

  it("import with no quotaWindows in bundle is a no-op (older export)", async () => {
    const { db, captured } = createSequenceDb({});
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest();
    delete (manifest as Partial<CompanyPortabilityManifest>).quotaWindows;

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, quotaWindows: true },
      },
      "importer-1",
    );

    const qwInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "provider_quota_windows",
    );
    expect(qwInserts.length).toBe(0);
  });

  it("quotaWindows section is not warned as unknown_section", async () => {
    const { db } = createSequenceDb({
      selects: [[]],
      inserts: [[{ id: "new-qw" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({ quotaWindows: [makeQuotaEntry()] });

    const result = await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, quotaWindows: true },
      },
      "importer-1",
    );

    const unknownWarnings = result.warnings.filter(
      (w) => w.kind === "unknown_section" && w.section === "quotaWindows",
    );
    expect(unknownWarnings).toEqual([]);
  });

  it("import handles null-rich snapshots (valueLabel-only providers)", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[]],
      inserts: [[{ id: "new-qw" }]],
    });
    const svc = companyPortabilityService(db as unknown as never);

    const manifest = baseManifest({
      quotaWindows: [makeQuotaEntry({
        slug: "openai-any-24h",
        provider: "openai",
        model: null,
        windowKind: "24h",
        limitValue: null,
        usedValue: null,
        usedPercent: null,
        valueLabel: "within limits",
        resetAt: null,
      })],
    });

    await svc.importBundle(
      {
        source: { type: "inline", manifest, files: { "COMPANY.md": "---\nkind: company\nname: Source Co\n---\n" } },
        target: { mode: "existing_company", companyId: TGT_CO_ID },
        include: { agents: false, internalAgentConfig: false, quotaWindows: true },
      },
      "importer-1",
    );

    const qwInserts = captured.inserts.filter(
      (_row, idx) => captured.insertTables[idx] === "provider_quota_windows",
    );
    expect(qwInserts.length).toBe(1);
    expect(qwInserts[0]).toMatchObject({
      provider: "openai",
      model: null,
      windowKind: "24h",
      limitValue: null,
      usedValue: null,
      valueLabel: "within limits",
      resetAt: null,
    });
  });
});
