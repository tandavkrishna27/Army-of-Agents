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

// Spy the instruction bundle seed so we assert it gets called with the right
// role key and won't crash the seeder on failure.
const seedMock = vi.fn().mockResolvedValue({ seededAdapterConfig: true });
vi.mock("../services/internal-agent/aoa-agents/seed-commander-bundle.js", () => ({
  seedRoleInstructionBundle: (...a: unknown[]) => seedMock(...a),
}));
vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: () => ({}),
}));

// ── Now import the SUT ──────────────────────────────────────────────────────
import {
  seedCrewAgent,
  type CrewAgentSpec,
} from "../services/internal-agent/aoa-agents/seed-crew-agent.js";

const BASE_SPEC: CrewAgentSpec = {
  name: "TestRole",
  role: "general",
  instruction: "test instruction",
  toolAllowlist: ["query_threads", "post_entry"],
  triggers: [{ kind: "mention", config: { role: "test_role" } }],
  instructionBundleRole: "scout",
};

interface MockRow {
  id: string;
  runtimeConfig?: Record<string, unknown> | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
  companyId?: string;
  name?: string;
  provider?: string | null;
}

/**
 * Build a chained-builder mock db where every leaf returns the same configured
 * row(s) regardless of which select/from/where path is taken. Tests configure
 * the `returning` and `limit` resolutions per scenario.
 */
function makeDb(opts: {
  insertReturning?: MockRow[];
  selectLimit?: MockRow[];
  /** Optional list of rows to return for the second select (current adapter). */
  currentAdapter?: MockRow[];
}) {
  const insertValues = vi.fn();
  const updateSet = vi.fn();
  const triggerInsertValues = vi.fn();

  // Track which insert call we're on so the trigger insert (second one) can
  // resolve differently from the agents insert.
  let insertCallNo = 0;

  const insertReturning = opts.insertReturning ?? [
    { id: "agent-1", runtimeConfig: null },
  ];
  const selectLimit = opts.selectLimit ?? [
    {
      id: "agent-1",
      companyId: "company-1",
      name: BASE_SPEC.name,
      adapterConfig: null,
    },
  ];

  const insert = vi.fn(() => {
    insertCallNo += 1;
    const thisCall = insertCallNo;
    return {
      values: vi.fn((vals: unknown) => {
        if (thisCall === 1) insertValues(vals);
        else triggerInsertValues(vals);
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue(insertReturning),
          })),
          returning: vi.fn().mockResolvedValue(insertReturning),
        };
      }),
    };
  });

  // Multi-select chain. In the conflict path the calls are:
  //   1 = resolveCrewAdapterForCompany (internalAgentConfig query)
  //   2 = conflict-fetch agents row
  //   3 = adapter-current probe (the spot the currentAdapter override targets)
  //   4 = bundle-row read (uses .then, not .limit)
  // In the new-agent path: 1 = adapter resolve, 2 = bundle-row read.
  let selectCallNo = 0;
  const select = vi.fn(() => {
    selectCallNo += 1;
    const callNo = selectCallNo;
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockImplementation(() => {
            if (callNo === 3 && opts.currentAdapter) {
              return Promise.resolve(opts.currentAdapter);
            }
            return Promise.resolve(selectLimit);
          }),
          then: vi.fn().mockImplementation((fn: (r: MockRow[]) => unknown) =>
            Promise.resolve(fn(selectLimit)),
          ),
        })),
      })),
    };
  });

  const update = vi.fn(() => ({
    set: vi.fn((set: unknown) => {
      updateSet(set);
      return {
        where: vi.fn().mockResolvedValue(undefined),
      };
    }),
  }));

  return {
    db: { insert, select, update } as any,
    insertValues,
    triggerInsertValues,
    updateSet,
  };
}

describe("seedCrewAgent (Phase D batch 1 / T9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("new agent path", () => {
    it("inserts agents row + trigger row on first call", async () => {
      const { db, insertValues, triggerInsertValues } = makeDb({
        insertReturning: [
          {
            id: "agent-1",
            runtimeConfig: {
              aoa: {
                role: "member",
                instruction: BASE_SPEC.instruction,
                toolAllowlist: BASE_SPEC.toolAllowlist,
              },
            },
          },
        ],
      });

      const id = await seedCrewAgent(db, "company-1", BASE_SPEC);

      expect(id).toBe("agent-1");
      // Agents insert was called with the full crew row shape
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: "company-1",
          name: BASE_SPEC.name,
          kind: "aoa",
          role: "general",
          status: "idle",
          runtimeConfig: expect.objectContaining({
            aoa: expect.objectContaining({
              toolAllowlist: BASE_SPEC.toolAllowlist,
            }),
          }),
        }),
      );
      // Trigger insert was called with the per-trigger array
      expect(triggerInsertValues).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            companyId: "company-1",
            agentId: "agent-1",
            kind: "mention",
            enabled: true,
            config: { role: "test_role" },
          }),
        ]),
      );
    });

    it("seeds multiple triggers when spec has more than one", async () => {
      const { db, triggerInsertValues } = makeDb({
        insertReturning: [{ id: "agent-2", runtimeConfig: null }],
      });

      await seedCrewAgent(db, "company-1", {
        ...BASE_SPEC,
        triggers: [
          { kind: "mention", config: { role: "engineer" } },
          { kind: "phase-advance", config: { role: "engineer" } },
        ],
      });

      const args = triggerInsertValues.mock.calls[0]?.[0];
      expect(args).toHaveLength(2);
      expect(args).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "mention" }),
          expect.objectContaining({ kind: "phase-advance" }),
        ]),
      );
    });
  });

  describe("idempotent conflict path", () => {
    it("returns existing id without inserting triggers", async () => {
      const { db, triggerInsertValues } = makeDb({
        insertReturning: [], // ON CONFLICT DO NOTHING → empty
        selectLimit: [
          {
            id: "agent-existing",
            companyId: "company-1",
            name: BASE_SPEC.name,
            adapterConfig: null,
            runtimeConfig: {
              aoa: {
                role: "member",
                instruction: "old",
                toolAllowlist: BASE_SPEC.toolAllowlist,
              },
            },
          },
        ],
      });

      const id = await seedCrewAgent(db, "company-1", BASE_SPEC);

      expect(id).toBe("agent-existing");
      expect(triggerInsertValues).not.toHaveBeenCalled();
    });

    it("throws if conflict fetch returns no row", async () => {
      const { db } = makeDb({
        insertReturning: [],
        selectLimit: [], // disappeared
      });

      await expect(seedCrewAgent(db, "company-1", BASE_SPEC)).rejects.toThrow(
        /disappeared after conflict/,
      );
    });

    it("backfills toolAllowlist when missing on existing row", async () => {
      const { db, updateSet } = makeDb({
        insertReturning: [],
        selectLimit: [
          {
            id: "agent-existing",
            companyId: "company-1",
            name: BASE_SPEC.name,
            adapterConfig: null,
            runtimeConfig: { aoa: {} }, // no toolAllowlist
          },
        ],
        currentAdapter: [
          { id: "agent-existing", adapterType: "codex_local", adapterConfig: {} },
        ],
      });

      await seedCrewAgent(db, "company-1", BASE_SPEC);

      // The first .set() call after the conflict path should write the
      // backfilled runtimeConfig.
      const backfillCall = updateSet.mock.calls.find((c) => {
        const arg = c[0] as Record<string, unknown> | undefined;
        return Boolean(
          arg && (arg.runtimeConfig as Record<string, unknown> | undefined)?.aoa,
        );
      });
      expect(backfillCall).toBeDefined();
      const backfilled = backfillCall?.[0] as { runtimeConfig: any };
      expect(backfilled.runtimeConfig.aoa.toolAllowlist).toEqual(
        BASE_SPEC.toolAllowlist,
      );
    });

    it("upgrades legacy process adapter to the resolved CLI adapter", async () => {
      const { db, updateSet } = makeDb({
        insertReturning: [],
        selectLimit: [
          {
            id: "agent-existing",
            companyId: "company-1",
            name: BASE_SPEC.name,
            adapterConfig: null,
            runtimeConfig: {
              aoa: {
                role: "member",
                instruction: BASE_SPEC.instruction,
                toolAllowlist: BASE_SPEC.toolAllowlist,
              },
            },
          },
        ],
        currentAdapter: [
          {
            id: "agent-existing",
            adapterType: "process", // legacy unrunnable
            adapterConfig: {}, // no command
          },
        ],
      });

      await seedCrewAgent(db, "company-1", BASE_SPEC);

      // We expect at least one update that sets adapterType to a real CLI
      // adapter (codex_local is the default fallback in resolveCrewAdapterFor).
      const adapterUpdate = updateSet.mock.calls.find((c) => {
        const arg = c[0] as Record<string, unknown> | undefined;
        return Boolean(arg && typeof arg.adapterType === "string");
      });
      expect(adapterUpdate).toBeDefined();
      const set = adapterUpdate?.[0] as { adapterType: string };
      // Resolves to codex_local for the default (no internalAgentConfig row).
      expect(set.adapterType).toBe("codex_local");
    });
  });

  describe("instruction bundle seed", () => {
    it("calls seedRoleInstructionBundle with the spec's bundle role", async () => {
      const { db } = makeDb({
        insertReturning: [{ id: "agent-1", runtimeConfig: null }],
      });

      await seedCrewAgent(db, "company-1", BASE_SPEC);

      expect(seedMock).toHaveBeenCalledWith(
        expect.objectContaining({ role: "scout" }),
      );
    });

    it("is non-fatal when bundle seeding rejects", async () => {
      seedMock.mockRejectedValueOnce(new Error("ENOENT"));
      const { db } = makeDb({
        insertReturning: [{ id: "agent-1", runtimeConfig: null }],
      });

      await expect(
        seedCrewAgent(db, "company-1", BASE_SPEC),
      ).resolves.toBe("agent-1");
    });
  });
});
