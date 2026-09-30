/**
 * C14 — Cross-company skill isolation tests.
 *
 * The existing company-skills.test.ts uses a mock DB whose where() ignores its
 * argument, so the companyId filter is never verified.  This file uses a
 * filtering mock that inspects the WHERE argument and only returns rows whose
 * companyId matches — proving the WHERE clause is actually applied.
 */

import { describe, expect, it, vi } from "vitest";

// ── Mock drizzle-orm BEFORE importing the service ────────────────────────────
// eq() returns a trackable object so the filtering mock can extract _val.
// asc/and return simple stubs; they are not inspected by the filter.
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ _op: "eq", _col: col, _val: val })),
  and: vi.fn((...args: unknown[]) => ({ _op: "and", _args: args })),
  asc: vi.fn((_col: unknown) => ({ _op: "asc" })),
  desc: vi.fn((_col: unknown) => ({ _op: "desc" })),
  gt: vi.fn((_col: unknown, val: unknown) => ({ _op: "gt", _val: val })),
  gte: vi.fn((_col: unknown, val: unknown) => ({ _op: "gte", _val: val })),
  lt: vi.fn((_col: unknown, val: unknown) => ({ _op: "lt", _val: val })),
  lte: vi.fn((_col: unknown, val: unknown) => ({ _op: "lte", _val: val })),
  ne: vi.fn((_col: unknown, val: unknown) => ({ _op: "ne", _val: val })),
  inArray: vi.fn((_col: unknown, vals: unknown) => ({ _op: "inArray", _vals: vals })),
  isNull: vi.fn((_col: unknown) => ({ _op: "isNull" })),
  isNotNull: vi.fn((_col: unknown) => ({ _op: "isNotNull" })),
  or: vi.fn((...args: unknown[]) => ({ _op: "or", _args: args })),
  not: vi.fn((arg: unknown) => ({ _op: "not", _arg: arg })),
  sql: vi.fn(() => ({ _op: "sql" })),
}));

// ── Mock @armyofagents/db with Proxy-based table stubs ───────────────────────
vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === Symbol.toPrimitive || prop === "toString"
            ? () => String(prop)
            : { _col: String(prop) },
      },
    );
  return {
    companySkills: makeTable(),
    agents: makeTable(),
  };
});

// ── Mock service dependencies ─────────────────────────────────────────────────
vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    getById: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
  }),
}));
vi.mock("../services/projects.js", () => ({
  projectService: () => ({}),
}));
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({}),
}));

import { companySkillService } from "../services/company-skills.js";

// ── Test data ─────────────────────────────────────────────────────────────────

type SkillRow = {
  id: string;
  companyId: string;
  key: string;
  slug: string;
  name: string;
  description: string;
  markdown: string;
  sourceType: string;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: string;
  compatibility: string;
  fileInventory: unknown[];
  metadata: null;
  customized: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function makeRow(companyId: string, key: string, name: string): SkillRow {
  const now = new Date("2026-05-22T00:00:00Z");
  return {
    id: `${companyId}-${key}`,
    companyId,
    key,
    slug: key,
    name,
    description: `${name} description`,
    markdown: `# ${name}`,
    sourceType: "local_path",
    sourceLocator: "/nonexistent/path",
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [],
    metadata: null,
    customized: false,
    createdAt: now,
    updatedAt: now,
  };
}

const allRows: SkillRow[] = [
  makeRow("company-a", "skill:a", "Skill A"),
  makeRow("company-b", "skill:b", "Skill B"),
  makeRow("company-b", "skill:b2", "Skill B2"),
];

// ── Filtering mock DB ─────────────────────────────────────────────────────────
//
// Extracts companyId from the eq() stub object ({ _op: "eq", _val: "<id>" })
// passed to .where(), then filters allRows to only those matching that id.
//
// The same mock handles both call shapes produced by listFull():
//   • pruneMissingLocalPathSkills: .select().from().where()  (no orderBy, awaited directly)
//   • listFull:                    .select().from().where().orderBy()
//
// Both return (or resolve to) filtered rows.

function extractCompanyIdFromCondition(condition: unknown): string | null {
  if (condition && typeof condition === "object") {
    const cond = condition as Record<string, unknown>;
    // Direct eq() stub: { _op: "eq", _col: <col>, _val: "<companyId>" }
    if (cond._op === "eq" && typeof cond._val === "string") {
      // Only match the companyId column, not other eq() calls (e.g. eq(key, ...))
      const col = cond._col as { _col?: string } | undefined;
      if (col?._col === "companyId") {
        return cond._val;
      }
    }
    // and() stub: { _op: "and", _args: [...] } — scan children
    if (cond._op === "and" && Array.isArray(cond._args)) {
      for (const arg of cond._args) {
        const found = extractCompanyIdFromCondition(arg);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

function makeFilteringDb(rows: SkillRow[]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          const companyId = extractCompanyIdFromCondition(condition);
          if (companyId === null) {
            throw new Error(
              "makeFilteringDb: could not extract companyId from WHERE condition — extractor may need updating",
            );
          }
          const filtered = rows.filter((r) => r.companyId === companyId);

          return {
            // For pruneMissingLocalPathSkills (awaited directly)
            then: (resolve: (v: SkillRow[]) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(filtered).then(resolve, reject),
            // For listFull (chained with orderBy)
            orderBy: vi.fn().mockResolvedValue(filtered),
          };
        }),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn() })),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("companySkillService — cross-company isolation (C14)", () => {
  it("company-a request does NOT return company-b skills", async () => {
    const service = companySkillService(makeFilteringDb(allRows) as any);

    const result = await service.list("company-a");
    const keys = result.map((s: any) => s.key);

    expect(result).toHaveLength(1);
    expect(keys).toContain("skill:a");
    expect(keys).not.toContain("skill:b");
    expect(keys).not.toContain("skill:b2");
  });

  it("company-b request does NOT return company-a skills", async () => {
    const service = companySkillService(makeFilteringDb(allRows) as any);

    const result = await service.list("company-b");
    const keys = result.map((s: any) => s.key);

    expect(result).toHaveLength(2);
    expect(keys).toContain("skill:b");
    expect(keys).toContain("skill:b2");
    expect(keys).not.toContain("skill:a");
  });

  it("unknown company returns empty list, not all skills", async () => {
    const service = companySkillService(makeFilteringDb(allRows) as any);

    const result = await service.list("company-unknown");
    expect(result).toHaveLength(0);
  });
});
