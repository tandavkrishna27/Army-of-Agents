import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

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
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { findActiveServerAdapterMock, agentServiceListMock, resolveAdapterConfigMock } = vi.hoisted(() => ({
  findActiveServerAdapterMock: vi.fn(),
  agentServiceListMock: vi.fn(),
  resolveAdapterConfigMock: vi.fn(),
}));

vi.mock("../adapters/registry.js", () => ({
  findActiveServerAdapter: findActiveServerAdapterMock,
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    list: agentServiceListMock,
    getById: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/projects.js", () => ({
  projectService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveAdapterConfigForRuntime: resolveAdapterConfigMock,
  }),
}));

vi.mock("@armyofagents/shared", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    normalizeAgentUrlKey: (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "-"),
  };
});

// ── Import unit under test ──────────────────────────────────────────────────

import { companySkillService } from "../services/company-skills.js";

const fakeDb = {} as any;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Record<string, any> = {}) {
  return {
    id: "agent-1",
    companyId: "co-1",
    name: "Claude Agent",
    adapterType: "claude_local",
    adapterConfig: {},
    skillKeys: ["company/co-1/writing"],
    ...overrides,
  };
}

function makeSnapshot(state: string, key = "company/co-1/writing") {
  return {
    adapterType: "claude_local",
    supported: true,
    mode: "ephemeral",
    desiredSkills: [key],
    entries: [
      {
        key,
        runtimeName: "writing",
        desired: true,
        managed: true,
        state,
      },
    ],
    warnings: [],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("companySkillService.usage dispatcher", () => {
  beforeEach(() => {
    findActiveServerAdapterMock.mockReset();
    agentServiceListMock.mockReset();
    resolveAdapterConfigMock.mockReset();
    resolveAdapterConfigMock.mockImplementation(
      async (_companyId: string, _adapterType: string, cfg: Record<string, unknown>) => ({
        ...cfg,
        __resolved: true,
      }),
    );
  });

  it("calls adapter.listSkills with resolved runtime config and maps snapshot state", async () => {
    agentServiceListMock.mockResolvedValue([makeAgent()]);
    const listSkills = vi.fn().mockResolvedValue(makeSnapshot("configured"));
    findActiveServerAdapterMock.mockReturnValue({
      type: "claude_local",
      listSkills,
    });

    const svc = companySkillService(fakeDb);
    const result = await svc.usage("co-1", "company/co-1/writing");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "agent-1",
      adapterType: "claude_local",
      desired: true,
      actualState: "configured",
    });
    // Task 8: the agent's real adapter type is threaded through so the
    // company-level provider key for THAT adapter can be applied as a fallback.
    expect(resolveAdapterConfigMock).toHaveBeenCalledWith(
      "co-1",
      "claude_local",
      {},
      expect.objectContaining({
        actorId: "company-skills",
        actorType: "system",
        consumerId: "agent-1",
        consumerType: "agent",
      }),
    );
    expect(listSkills).toHaveBeenCalledWith({
      agentId: "agent-1",
      companyId: "co-1",
      adapterType: "claude_local",
      config: { __resolved: true },
    });
  });

  it("returns 'missing' when snapshot has no entry for the key but is supported", async () => {
    agentServiceListMock.mockResolvedValue([makeAgent()]);
    const listSkills = vi.fn().mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [],
      warnings: [],
    });
    findActiveServerAdapterMock.mockReturnValue({ type: "claude_local", listSkills });

    const svc = companySkillService(fakeDb);
    const result = await svc.usage("co-1", "company/co-1/writing");

    expect(result[0]?.actualState).toBe("missing");
  });

  it("returns 'unsupported' when adapter has no listSkills", async () => {
    agentServiceListMock.mockResolvedValue([makeAgent({ adapterType: "openclaw" })]);
    findActiveServerAdapterMock.mockReturnValue({ type: "openclaw" }); // no listSkills

    const svc = companySkillService(fakeDb);
    const result = await svc.usage("co-1", "company/co-1/writing");

    expect(result[0]?.actualState).toBe("unsupported");
    expect(resolveAdapterConfigMock).not.toHaveBeenCalled();
  });

  it("returns 'unsupported' when adapter is not registered", async () => {
    agentServiceListMock.mockResolvedValue([makeAgent({ adapterType: "mystery" })]);
    findActiveServerAdapterMock.mockReturnValue(null);

    const svc = companySkillService(fakeDb);
    const result = await svc.usage("co-1", "company/co-1/writing");

    expect(result[0]?.actualState).toBe("unsupported");
  });

  it("falls back to 'unknown' (not crash) when adapter.listSkills throws", async () => {
    agentServiceListMock.mockResolvedValue([makeAgent()]);
    const listSkills = vi.fn().mockRejectedValue(new Error("boom"));
    findActiveServerAdapterMock.mockReturnValue({ type: "claude_local", listSkills });

    const svc = companySkillService(fakeDb);
    const result = await svc.usage("co-1", "company/co-1/writing");

    expect(result).toHaveLength(1);
    expect(result[0]?.actualState).toBe("unknown");
  });

  it("filters to agents that have the skill in their skillKeys", async () => {
    agentServiceListMock.mockResolvedValue([
      makeAgent({ id: "has-skill", skillKeys: ["company/co-1/writing"] }),
      makeAgent({ id: "no-skill", skillKeys: ["company/co-1/other"] }),
      makeAgent({ id: "no-keys", skillKeys: [] }),
    ]);
    const listSkills = vi.fn().mockResolvedValue(makeSnapshot("configured"));
    findActiveServerAdapterMock.mockReturnValue({ type: "claude_local", listSkills });

    const svc = companySkillService(fakeDb);
    const result = await svc.usage("co-1", "company/co-1/writing");

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("has-skill");
    expect(listSkills).toHaveBeenCalledTimes(1);
  });

  it("handles mixed-adapter agent list (openclaw unsupported + claude configured)", async () => {
    agentServiceListMock.mockResolvedValue([
      makeAgent({ id: "agent-claude", adapterType: "claude_local" }),
      makeAgent({ id: "agent-openclaw", adapterType: "openclaw" }),
    ]);
    const listSkills = vi.fn().mockResolvedValue(makeSnapshot("configured"));
    findActiveServerAdapterMock.mockImplementation((type: string) => {
      if (type === "claude_local") return { type, listSkills };
      if (type === "openclaw") return { type }; // no listSkills
      return null;
    });

    const svc = companySkillService(fakeDb);
    const result = await svc.usage("co-1", "company/co-1/writing");

    expect(result).toHaveLength(2);
    const claude = result.find((r) => r.id === "agent-claude");
    const openclaw = result.find((r) => r.id === "agent-openclaw");
    expect(claude?.actualState).toBe("configured");
    expect(openclaw?.actualState).toBe("unsupported");
  });
});
