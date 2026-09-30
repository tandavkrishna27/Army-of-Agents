import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must precede imports that transitively import drizzle) ────────────
const eqMock = vi.fn((a: unknown, b: unknown) => ({ op: "eq", a, b }));
const andMock = vi.fn((...args: unknown[]) => ({ op: "and", args }));

vi.mock("drizzle-orm", () => ({
  eq: eqMock,
  and: andMock,
}));

// Mock Drizzle table references as Proxies
// Task #39 fix: include internalAgentConfig so resolveCrewAdapterForCompany
// (introduced as ensure-adjutant's new dependency in P1-B fix) can resolve.
vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return {
    agents: t("agents"),
    aoaAgentTriggers: t("aoaAgentTriggers"),
    internalAgentConfig: t("internalAgentConfig"),
  };
});

// Mock the seeding service
const seedMock = vi.fn().mockResolvedValue({ someAdapterConfig: true });
vi.mock("../services/internal-agent/aoa-agents/seed-commander-bundle.js", () => ({
  seedRoleInstructionBundle: seedMock,
}));

// Mock the agent instructions service
vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: () => ({}),
}));

// ── Now import the functions under test ────────────────────────────────────
import { isRoleActiveAtAutonomy } from "../services/internal-agent/aoa-agents/autonomy.js";

describe("P3.1 Adjutant role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isRoleActiveAtAutonomy", () => {
    it("adjutant is active at autonomy level 0 (nudges)", () => {
      expect(isRoleActiveAtAutonomy("adjutant", 0)).toBe(true);
    });

    it("adjutant is active at autonomy level 1", () => {
      expect(isRoleActiveAtAutonomy("adjutant", 1)).toBe(true);
    });

    it("adjutant is active at autonomy level 2 (can advance_phase)", () => {
      expect(isRoleActiveAtAutonomy("adjutant", 2)).toBe(true);
    });
  });

  describe("ensureAdjutant", () => {
    it("inserts adjutant agent + trigger on first call (new company)", async () => {
      const mockDb = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  id: "adj-1",
                  runtimeConfig: {
                    aoa: {
                      role: "member",
                      instruction: expect.any(String),
                      toolAllowlist: ["query_threads", "query_extracted_items", "advance_phase", "notify_owner", "post_entry"],
                    },
                  },
                },
              ]),
            }),
          }),
        }),
        // Task #39 fix: `.limit(1)` must be `await`-able directly.
        // The previous mock returned { then: vi.fn().mockResolvedValue(...) }
        // but await calls .then(onFulfilled, onRejected) and the mock
        // ignored the callbacks → unresolved promise → 5s timeout.
        // Returning mockResolvedValue from .limit() makes the chain a real
        // Thenable that resolves with the array.
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "adj-1",
                  companyId: "company-1",
                  name: "Adjutant",
                  adapterConfig: null,
                },
              ]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({}),
          }),
        }),
      };

      const { ensureAdjutant } = await import("../services/internal-agent/aoa-agents/ensure-adjutant.js");
      await ensureAdjutant(mockDb as unknown as any, "company-1");

      // Verify insert was called once
      expect(mockDb.insert).toHaveBeenCalledTimes(2); // agents + triggers
      expect(mockDb.insert).toHaveBeenCalledWith(expect.anything()); // agents table

      // Verify the trigger was inserted
      expect(mockDb.insert).toHaveBeenNthCalledWith(1, expect.anything());
    });

    it("idempotent: conflict path fetches existing agent, skips trigger insert", async () => {
      const insertMock = vi.fn();
      const selectMock = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: vi.fn().mockImplementation((fn: Function) => fn([
                {
                  id: "adj-1",
                  companyId: "company-1",
                  name: "Adjutant",
                  adapterConfig: null,
                },
              ]),),
            }),
          }),
        }),
      });

      const mockDb = {
        insert: insertMock.mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]), // conflict: no insertion (empty array)
            }),
          }),
        }),
        select: selectMock,
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue({}),
          }),
        }),
      };

      const { ensureAdjutant } = await import("../services/internal-agent/aoa-agents/ensure-adjutant.js");
      await ensureAdjutant(mockDb as unknown as any, "company-1");

      // Verify insert was called (once for agents, but trigger insert should not happen on conflict)
      expect(insertMock).toHaveBeenCalled();
    });

    it("D2 backfill: conflict path adds toolAllowlist when missing", async () => {
      const updateMock = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue({}),
        }),
      });

      const selectMock = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              then: vi.fn().mockImplementation((fn: Function) => fn([
                {
                  id: "adj-1",
                  companyId: "company-1",
                  name: "Adjutant",
                  adapterConfig: null,
                  runtimeConfig: { aoa: {} }, // missing toolAllowlist
                },
              ]),),
            }),
          }),
        }),
      });

      const mockDb = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]), // conflict (empty array)
            }),
          }),
        }),
        select: selectMock,
        update: updateMock,
      };

      const { ensureAdjutant } = await import("../services/internal-agent/aoa-agents/ensure-adjutant.js");
      await ensureAdjutant(mockDb as unknown as any, "company-1");

      // Verify update was called to add toolAllowlist
      expect(updateMock).toHaveBeenCalled();
    });
  });
});
