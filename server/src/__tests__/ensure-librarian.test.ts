import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must precede imports that transitively import drizzle) ────────────
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
}));

vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy(
      {},
      { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) },
    );
  return {
    agents: t("agents"),
    aoaAgentTriggers: t("aoaAgentTriggers"),
    internalAgentConfig: t("internalAgentConfig"),
  };
});

// Spy seedCrewAgent so we can assert it gets the right spec without invoking
// the helper's full drizzle plumbing.
const seedCrewAgentMock = vi.fn().mockResolvedValue("librarian-1");
vi.mock("../services/internal-agent/aoa-agents/seed-crew-agent.js", () => ({
  seedCrewAgent: (...args: unknown[]) => seedCrewAgentMock(...args),
}));

import { ensureLibrarian, LIBRARIAN_TOOL_ALLOWLIST } from "../services/internal-agent/aoa-agents/ensure-librarian.js";

describe("ensureLibrarian (WS6)", () => {
  beforeEach(() => {
    seedCrewAgentMock.mockClear();
  });

  it("delegates to seedCrewAgent with the Librarian spec", async () => {
    await ensureLibrarian({} as any, "company-1");

    expect(seedCrewAgentMock).toHaveBeenCalledTimes(1);
    const [, companyId, spec] = seedCrewAgentMock.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    expect(spec).toMatchObject({
      name: "Librarian",
      role: "general",
      instructionBundleRole: "librarian",
    });
  });

  it("returns the seeded agent id", async () => {
    const id = await ensureLibrarian({} as any, "c1");
    expect(id).toBe("librarian-1");
  });

  it("Librarian's allowlist is memory-only: write_memory + find_similar_memory, no thread/task/artifact tools", async () => {
    await ensureLibrarian({} as any, "c1");
    const spec = seedCrewAgentMock.mock.calls[0]![2] as { toolAllowlist: string[] };

    expect(spec.toolAllowlist).toContain("write_memory");
    expect(spec.toolAllowlist).toContain("find_similar_memory");
    expect(LIBRARIAN_TOOL_ALLOWLIST).toEqual(spec.toolAllowlist);

    // Never touches threads/tasks/artifacts — memory-only surface.
    expect(spec.toolAllowlist).not.toContain("post_entry");
    expect(spec.toolAllowlist).not.toContain("create_task");
    expect(spec.toolAllowlist).not.toContain("get_task");
    expect(spec.toolAllowlist).not.toContain("create_artifact");
    // Critical: never a self-approving write path.
    expect(spec.toolAllowlist).not.toContain("suggest_memory");
    expect(spec.toolAllowlist).not.toContain("update_memory");
  });

  it("fires on the 'event' trigger kind with role+eventName config (not mention/sweep)", async () => {
    await ensureLibrarian({} as any, "c1");
    const spec = seedCrewAgentMock.mock.calls[0]![2] as {
      triggers: Array<{ kind: string; config: Record<string, unknown> }>;
    };

    expect(spec.triggers).toHaveLength(1);
    expect(spec.triggers[0]).toEqual({
      kind: "event",
      config: { role: "librarian", eventName: "braindump.submitted" },
    });
  });
});
