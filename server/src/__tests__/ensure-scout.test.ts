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
const seedCrewAgentMock = vi.fn().mockResolvedValue("scout-1");
vi.mock("../services/internal-agent/aoa-agents/seed-crew-agent.js", () => ({
  seedCrewAgent: (...args: unknown[]) => seedCrewAgentMock(...args),
}));

import { ensureScout } from "../services/internal-agent/aoa-agents/ensure-scout.js";

describe("ensureScout (Phase D batch 1 / T2)", () => {
  beforeEach(() => {
    seedCrewAgentMock.mockClear();
  });

  it("delegates to seedCrewAgent with the Scout spec", async () => {
    await ensureScout({} as any, "company-1");

    expect(seedCrewAgentMock).toHaveBeenCalledTimes(1);
    const [, companyId, spec] = seedCrewAgentMock.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    expect(spec).toMatchObject({
      name: "Scout",
      role: "general",
      instructionBundleRole: "scout",
    });
  });

  it("Scout's allowlist covers internal-only research tools (no browse)", async () => {
    await ensureScout({} as any, "c1");
    const spec = seedCrewAgentMock.mock.calls[0]![2] as {
      toolAllowlist: string[];
    };

    expect(spec.toolAllowlist).toContain("find_similar_memory_hnsw");
    expect(spec.toolAllowlist).toContain("find_similar_threads");
    expect(spec.toolAllowlist).toContain("query_threads");
    expect(spec.toolAllowlist).toContain("search_discussions");
    expect(spec.toolAllowlist).toContain("post_entry");
    expect(spec.toolAllowlist).toContain("thread.createLink");

    // Phase 1 boundary: no browse / external research tools yet.
    expect(spec.toolAllowlist).not.toContain("browse");
    expect(spec.toolAllowlist).not.toContain("web_search");
    expect(spec.toolAllowlist).not.toContain("fetch_url");
  });

  it("Scout's allowlist includes the 4 crew task tools (Spec B Task 6)", async () => {
    // Task 6: the per-task tools (get_task / post_task_comment /
    // attach_task_artifact / set_task_status) must be on Scout's allowlist so a
    // crew agent dispatched onto a task can read it, comment progress, attach
    // its deliverable, and move the task forward.
    await ensureScout({} as any, "c1");
    const spec = seedCrewAgentMock.mock.calls[0]![2] as {
      toolAllowlist: string[];
    };

    expect(spec.toolAllowlist).toContain("get_task");
    expect(spec.toolAllowlist).toContain("post_task_comment");
    expect(spec.toolAllowlist).toContain("attach_task_artifact");
    expect(spec.toolAllowlist).toContain("set_task_status");
  });

  it("Scout fires on mention (single trigger)", async () => {
    await ensureScout({} as any, "c1");
    const spec = seedCrewAgentMock.mock.calls[0]![2] as {
      triggers: Array<{ kind: string; config: Record<string, unknown> }>;
    };

    expect(spec.triggers).toHaveLength(1);
    expect(spec.triggers[0]).toEqual({
      kind: "mention",
      config: { role: "scout" },
    });
  });
});
