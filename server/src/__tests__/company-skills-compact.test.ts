import { describe, expect, it, vi } from "vitest";

// ── Mocks must be hoisted before any service import ──────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  asc: vi.fn((x: any) => x),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  companySkills: new Proxy({}, { get: (_t, k) => `companySkills.${String(k)}` }),
  agents: new Proxy({}, { get: (_t, k) => `agents.${String(k)}` }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../adapters/registry.js", () => ({
  findActiveServerAdapter: vi.fn(),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({}),
}));

vi.mock("@armyofagents/shared", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    normalizeAgentUrlKey: (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
  };
});

const agentGetByIdMock = vi.hoisted(() => vi.fn());
const agentListMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    getById: agentGetByIdMock,
    list: agentListMock,
    update: vi.fn(),
  }),
}));

import { companySkillService } from "../services/company-skills.js";

// ── DB factory helpers ────────────────────────────────────────────────────────

function makeSkillRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-19T00:00:00Z");
  return {
    id: "skill-row-1",
    companyId: "co-1",
    key: "brainstorming",
    slug: "brainstorming",
    name: "Brainstorming",
    description: "Before building new features",
    markdown: "# Brainstorming\nUse this skill before building.",
    sourceType: "catalog",
    sourceLocator: null,
    sourceRef: "1.0.0",
    trustLevel: "sandboxed",
    compatibility: "compatible",
    fileInventory: [],
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Build a minimal mock DB. The `orderBy` at the tail of `listFull`'s chain:
 *   db.select().from(...).where(...).orderBy(...)
 * must resolve to `rows`.
 *
 * `pruneMissingLocalPathSkills` (called by ensureSkillInventoryCurrent) also
 * calls `db.select().from(...).where(...)` — that intermediate `.where()`
 * resolves to an object that has `.orderBy` AND is itself thenable with [].
 */
function makeDb(skillRows: any[]) {
  const whereResult = {
    orderBy: vi.fn().mockResolvedValue(skillRows),
    then: (resolve: (v: any[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => whereResult),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn() })),
  } as any;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("companySkillService.listCompactSkillEntries", () => {
  it("returns [] when agent is not found", async () => {
    agentGetByIdMock.mockResolvedValue(null);
    const svc = companySkillService(makeDb([]));
    const result = await svc.listCompactSkillEntries("co-1", "no-such-agent");
    expect(result).toEqual([]);
  });

  it("returns [] when agent.skillKeys is empty", async () => {
    agentGetByIdMock.mockResolvedValue({
      id: "agent-1",
      companyId: "co-1",
      skillKeys: [],
    });
    const svc = companySkillService(makeDb([]));
    const result = await svc.listCompactSkillEntries("co-1", "agent-1");
    expect(result).toEqual([]);
  });

  it("returns compact entries when agent.skillKeys match skills in DB", async () => {
    agentGetByIdMock.mockResolvedValue({
      id: "agent-1",
      companyId: "co-1",
      skillKeys: ["brainstorming"],
    });
    const row = makeSkillRow({ key: "brainstorming", triggerPhrases: ["new feature"] });
    const svc = companySkillService(makeDb([row]));
    const result = await svc.listCompactSkillEntries("co-1", "agent-1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      key: "brainstorming",
      name: "Brainstorming",
      description: "Before building new features",
    });
  });

  it("returns only matched skills when some skillKeys have no matching DB row", async () => {
    agentGetByIdMock.mockResolvedValue({
      id: "agent-1",
      companyId: "co-1",
      skillKeys: ["brainstorming", "nonexistent-skill"],
    });
    const row = makeSkillRow({ key: "brainstorming" });
    const svc = companySkillService(makeDb([row]));
    const result = await svc.listCompactSkillEntries("co-1", "agent-1");
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe("brainstorming");
  });

  it("falls back to skill name as description when skill.description is null", async () => {
    agentGetByIdMock.mockResolvedValue({
      id: "agent-1",
      companyId: "co-1",
      skillKeys: ["brainstorming"],
    });
    const row = makeSkillRow({ key: "brainstorming", name: "Brainstorming", description: null });
    const svc = companySkillService(makeDb([row]));
    const result = await svc.listCompactSkillEntries("co-1", "agent-1");
    expect(result).toHaveLength(1);
    expect(result[0]?.description).toBe("Brainstorming");
  });
});
