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

const seedCrewAgentMock = vi.fn().mockResolvedValue("engineer-1");
vi.mock("../services/internal-agent/aoa-agents/seed-crew-agent.js", () => ({
  seedCrewAgent: (...args: unknown[]) => seedCrewAgentMock(...args),
}));

import { ensureEngineer } from "../services/internal-agent/aoa-agents/ensure-engineer.js";

describe("ensureEngineer (Phase D batch 1 / T6)", () => {
  beforeEach(() => {
    seedCrewAgentMock.mockClear();
  });

  it("renames any Maker → Engineer before delegating to seedCrewAgent", async () => {
    const updateSet = vi.fn();
    const where = vi.fn().mockResolvedValue(undefined);
    // L13: ensureEngineer first SELECTs for an existing Engineer row; return []
    // (none yet) so the rename proceeds on this common path.
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      })),
      update: vi.fn(() => ({
        set: vi.fn((s: unknown) => {
          updateSet(s);
          return { where };
        }),
      })),
    };

    // Capture call order: the rename UPDATE must run before seedCrewAgent.
    let renameCallNo: number | null = null;
    let seedCallNo: number | null = null;
    let callOrder = 0;
    (db.update as any).mockImplementation(() => {
      renameCallNo = ++callOrder;
      return {
        set: vi.fn((s: unknown) => {
          updateSet(s);
          return { where };
        }),
      };
    });
    seedCrewAgentMock.mockImplementation(async () => {
      seedCallNo = ++callOrder;
      return "engineer-1";
    });

    await ensureEngineer(db as any, "company-1");

    expect(renameCallNo).not.toBeNull();
    expect(seedCallNo).not.toBeNull();
    expect(renameCallNo as unknown as number).toBeLessThan(
      seedCallNo as unknown as number,
    );
    // The UPDATE.set received {name: "Engineer", updatedAt: Date}.
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Engineer" }),
    );
  });

  it("L13: SKIPS the Maker rename when an Engineer row already exists (no unique-index collision)", async () => {
    const updateFn = vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    }));
    // SELECT returns an existing Engineer → the rename UPDATE must NOT run.
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([{ id: "engineer-existing" }]),
      })),
      update: updateFn,
    };

    await ensureEngineer(db as any, "company-dup");

    // No rename UPDATE issued (would have collided on agents_aoa_name_per_company_idx).
    expect(updateFn).not.toHaveBeenCalled();
    // Still idempotently delegates to the seeder (keeps the Engineer canonical).
    expect(seedCrewAgentMock).toHaveBeenCalledTimes(1);
  });

  it("delegates to seedCrewAgent with the Engineer spec", async () => {
    const db = {
      // L13: no existing Engineer → rename path; the SELECT precedes the rename.
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    };

    await ensureEngineer(db as any, "company-1");

    expect(seedCrewAgentMock).toHaveBeenCalledTimes(1);
    const [, companyId, spec] = seedCrewAgentMock.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    expect(spec).toMatchObject({
      name: "Engineer",
      role: "general",
      instructionBundleRole: "engineer",
    });
  });

  it("Engineer allowlist closes the Phase D TODO: artifact-version + workspace tools", async () => {
    const db = {
      // L13: no existing Engineer → rename path; the SELECT precedes the rename.
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    };

    await ensureEngineer(db as any, "c1");
    const spec = seedCrewAgentMock.mock.calls[0]![2] as {
      toolAllowlist: string[];
    };

    // The TODO in tool-registry.ts:84-87 listed these three; assert all are
    // on the Engineer allowlist now.
    expect(spec.toolAllowlist).toContain("create_artifact");
    expect(spec.toolAllowlist).toContain("create_artifact_version");
    expect(spec.toolAllowlist).toContain("query_artifacts");
    expect(spec.toolAllowlist).toContain("request_thread_workspace");
    expect(spec.toolAllowlist).toContain("post_entry");
  });

  it("Engineer's allowlist includes the 4 crew task tools (Spec B Task 6)", async () => {
    // Task 6: Engineer executes artifact work on a dispatched task, so it needs
    // the per-task tools to read its task (get_task), comment progress
    // (post_task_comment), hand back its deliverable (attach_task_artifact), and
    // advance the task (set_task_status).
    const db = {
      // L13: no existing Engineer → rename path; the SELECT precedes the rename.
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    };

    await ensureEngineer(db as any, "c1");
    const spec = seedCrewAgentMock.mock.calls[0]![2] as {
      toolAllowlist: string[];
    };

    expect(spec.toolAllowlist).toContain("get_task");
    expect(spec.toolAllowlist).toContain("post_task_comment");
    expect(spec.toolAllowlist).toContain("attach_task_artifact");
    expect(spec.toolAllowlist).toContain("set_task_status");
  });

  it("Engineer fires on both mention AND phase-advance", async () => {
    const db = {
      // L13: no existing Engineer → rename path; the SELECT precedes the rename.
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    };

    await ensureEngineer(db as any, "c1");
    const spec = seedCrewAgentMock.mock.calls[0]![2] as {
      triggers: Array<{ kind: string; config: Record<string, unknown> }>;
    };

    expect(spec.triggers).toHaveLength(2);
    const kinds = spec.triggers.map((t) => t.kind);
    expect(kinds).toContain("mention");
    expect(kinds).toContain("phase-advance");
    // Both triggers carry the canonical 'engineer' role key so the dispatcher
    // can resolve the action directive correctly.
    expect(spec.triggers.every((t) => t.config.role === "engineer")).toBe(true);
  });
});
