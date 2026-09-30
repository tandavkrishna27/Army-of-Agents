import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @armyofagents/db — Proxy-based tables (project standard pattern)
// ---------------------------------------------------------------------------
vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
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
    agents: makeTable("agents"),
    companyMemberships: makeTable("company_memberships"),
    userRoles: makeTable("user_roles"),
  };
});

// ---------------------------------------------------------------------------
// Mock drizzle-orm operators
// ---------------------------------------------------------------------------
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  or: vi.fn((...args: unknown[]) => args),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({
      sql: strings,
      values,
    })),
    { raw: vi.fn((s: unknown) => s) },
  ),
}));

// ---------------------------------------------------------------------------
// Sequence-based mock DB
// ---------------------------------------------------------------------------
type MockRow = Record<string, unknown>;

function createSequenceDb(
  config: {
    selects?: MockRow[][];
    updates?: MockRow[][];
    inserts?: MockRow[][];
  } = {},
) {
  let selectIdx = 0;
  let updateIdx = 0;

  const selects = config.selects ?? [];
  const updates = config.updates ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of [
      "from",
      "where",
      "set",
      "values",
      "returning",
      "innerJoin",
      "leftJoin",
      "orderBy",
      "limit",
      "delete",
    ]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) =>
      makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) =>
      makeChain(() => updates[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => []),
    delete: (..._args: unknown[]) => makeChain(() => []),
  };
}

// ---------------------------------------------------------------------------
// Import service under test (after mocks are registered)
// ---------------------------------------------------------------------------
import { orgHierarchyService } from "../services/org-hierarchy.js";

// ---------------------------------------------------------------------------
// assertNoCycle
// ---------------------------------------------------------------------------
describe("orgHierarchyService", () => {
  describe("assertNoCycle", () => {
    it("allows null parent (root node)", async () => {
      const db = createSequenceDb();
      const svc = orgHierarchyService(db as any);
      // Should resolve without throwing — no DB calls needed
      await expect(
        svc.assertNoCycle("co-1", "a1", "agent", null, null),
      ).resolves.toBeUndefined();
    });

    it("rejects self-reference (same id + same type)", async () => {
      const db = createSequenceDb();
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "a1", "agent", "a1", "agent"),
      ).rejects.toThrow("Cannot set an entity as its own parent");
    });

    it("rejects self-reference for user type", async () => {
      const db = createSequenceDb();
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "u1", "user", "u1", "user"),
      ).rejects.toThrow("Cannot set an entity as its own parent");
    });

    it("allows same id but different type (not a self-reference)", async () => {
      const db = createSequenceDb({
        // Walk from agent "x1" → no parent (root)
        selects: [[{ parentType: null, parentId: null }]],
      });
      const svc = orgHierarchyService(db as any);
      // entity is user "x1", parent is agent "x1" — different types, allowed
      await expect(
        svc.assertNoCycle("co-1", "x1", "user", "x1", "agent"),
      ).resolves.toBeUndefined();
    });

    it("detects agent→agent cycle", async () => {
      // Chain: a2 → a3 → a1 (cycle back to entity)
      const db = createSequenceDb({
        selects: [
          // lookup a2: parent is a3 (agent)
          [{ parentType: "agent", parentId: "a3" }],
          // lookup a3: parent is a1 (agent) — CYCLE
          [{ parentType: "agent", parentId: "a1" }],
        ],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "a1", "agent", "a2", "agent"),
      ).rejects.toThrow("circular reporting chain");
    });

    it("detects mixed agent→user→agent cycle", async () => {
      // entity = agent a1, newParent = user u1
      // Chain: u1 → agent a2 → agent a1 (cycle)
      const db = createSequenceDb({
        selects: [
          // lookup user u1 in company_memberships: parent is agent a2
          [{ parentType: "agent", parentId: "a2" }],
          // lookup agent a2: parent is agent a1 — CYCLE
          [{ parentType: "agent", parentId: "a1" }],
        ],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "a1", "agent", "u1", "user"),
      ).rejects.toThrow("circular reporting chain");
    });

    it("respects 50-step depth limit without throwing", async () => {
      // Build a chain of 60 agents, none of which is the entity.
      // The loop should stop at depth 50, NOT throw.
      const selects: MockRow[][] = [];
      for (let i = 0; i < 60; i++) {
        selects.push([{ parentType: "agent", parentId: `deep-${i + 1}` }]);
      }
      const db = createSequenceDb({ selects });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "target", "agent", "deep-0", "agent"),
      ).resolves.toBeUndefined();
    });

    it("walks chain without false positives", async () => {
      // Chain: a2 → a3 → root (null parent). No cycle.
      const db = createSequenceDb({
        selects: [
          [{ parentType: "agent", parentId: "a3" }],
          [{ parentType: null, parentId: null }],
        ],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "a1", "agent", "a2", "agent"),
      ).resolves.toBeUndefined();
    });

    it("stops at root when agent has no parent", async () => {
      const db = createSequenceDb({
        selects: [
          // agent a2 has no parent — root
          [{ parentType: null, parentId: null }],
        ],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "a1", "agent", "a2", "agent"),
      ).resolves.toBeUndefined();
    });

    it("stops at root when user has no parent", async () => {
      const db = createSequenceDb({
        selects: [
          // user u2 has no parent — root
          [{ parentType: null, parentId: null }],
        ],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "a1", "agent", "u2", "user"),
      ).resolves.toBeUndefined();
    });

    it("stops when agent row not found", async () => {
      const db = createSequenceDb({
        selects: [
          // No row returned for agent lookup
          [],
        ],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "a1", "agent", "a2", "agent"),
      ).resolves.toBeUndefined();
    });

    it("includes depth in cycle error message", async () => {
      // Direct cycle at depth 1: a2 → a1
      const db = createSequenceDb({
        selects: [[{ parentType: "agent", parentId: "a1" }]],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.assertNoCycle("co-1", "a1", "agent", "a2", "agent"),
      ).rejects.toThrow("(depth 1)");
    });
  });

  // ---------------------------------------------------------------------------
  // ensureParent
  // ---------------------------------------------------------------------------
  describe("ensureParent", () => {
    it("accepts valid agent in same company", async () => {
      const db = createSequenceDb({
        selects: [[{ id: "a1", status: "active" }]],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.ensureParent("co-1", "agent", "a1"),
      ).resolves.toBeUndefined();
    });

    it("accepts idle agent in same company", async () => {
      const db = createSequenceDb({
        selects: [[{ id: "a1", status: "idle" }]],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.ensureParent("co-1", "agent", "a1"),
      ).resolves.toBeUndefined();
    });

    it("rejects agent not found (different company or nonexistent)", async () => {
      const db = createSequenceDb({
        selects: [[]],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.ensureParent("co-1", "agent", "a-nonexistent"),
      ).rejects.toThrow("Parent agent not found in this company");
    });

    it("rejects terminated agent", async () => {
      const db = createSequenceDb({
        selects: [[{ id: "a1", status: "terminated" }]],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.ensureParent("co-1", "agent", "a1"),
      ).rejects.toThrow("Cannot report to a terminated agent");
    });

    it("accepts active user with membership", async () => {
      const db = createSequenceDb({
        selects: [[{ principalId: "u1" }]],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.ensureParent("co-1", "user", "u1"),
      ).resolves.toBeUndefined();
    });

    it("rejects inactive user (no active membership)", async () => {
      const db = createSequenceDb({
        selects: [[]],
      });
      const svc = orgHierarchyService(db as any);
      await expect(
        svc.ensureParent("co-1", "user", "u-inactive"),
      ).rejects.toThrow(
        "Parent user not found or not active in this company",
      );
    });

    it("throws 404 for missing agent", async () => {
      const db = createSequenceDb({ selects: [[]] });
      const svc = orgHierarchyService(db as any);
      try {
        await svc.ensureParent("co-1", "agent", "a-missing");
        expect.unreachable("should have thrown");
      } catch (e: any) {
        expect(e.status).toBe(404);
      }
    });

    it("throws 422 for terminated agent", async () => {
      const db = createSequenceDb({
        selects: [[{ id: "a1", status: "terminated" }]],
      });
      const svc = orgHierarchyService(db as any);
      try {
        await svc.ensureParent("co-1", "agent", "a1");
        expect.unreachable("should have thrown");
      } catch (e: any) {
        expect(e.status).toBe(422);
      }
    });

    it("throws 422 for inactive user", async () => {
      const db = createSequenceDb({ selects: [[]] });
      const svc = orgHierarchyService(db as any);
      try {
        await svc.ensureParent("co-1", "user", "u-gone");
        expect.unreachable("should have thrown");
      } catch (e: any) {
        expect(e.status).toBe(422);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // reparentChildren
  //
  // W6: removing an entity re-parents its children up to the removed entity's
  // OWN parent (fallback: company founder), never to null/root. The .set()
  // clause must therefore carry the resolved parent, not null.
  // ---------------------------------------------------------------------------
  describe("reparentChildren", () => {
    let updateCalls: { table: string; setArg: unknown; whereArg: unknown }[];

    // `selects` is a sequence of result-sets consumed in order. The order of
    // selects inside reparentChildren is:
    //   1. removed entity's own parent (agents OR company_memberships)
    //   2. (only if no parent found) getFounderUserId: user_roles, then owner
    //      membership fallback.
    function createTrackingDb(selects: MockRow[][] = []) {
      updateCalls = [];
      let selectIdx = 0;

      function makeUpdateChain(tableName: string) {
        let setArg: unknown;
        const chain: Record<string, unknown> = {};

        chain.set = (...args: unknown[]) => {
          setArg = args[0];
          return chain;
        };
        chain.where = (...args: unknown[]) => {
          updateCalls.push({ table: tableName, setArg, whereArg: args[0] });
          return chain;
        };
        // Remaining chain methods
        for (const m of ["from", "values", "returning", "limit"]) {
          chain[m] = (..._args: unknown[]) => chain;
        }
        chain.then = (resolve: (v: MockRow[]) => unknown) =>
          Promise.resolve(resolve([]));
        return chain;
      }

      // Track which table each update targets
      let updateCallCount = 0;
      const tableOrder = ["agents", "company_memberships"];

      return {
        select: (..._args: unknown[]) => {
          const result = selects[selectIdx++] ?? [];
          const chain: Record<string, unknown> = {};
          for (const m of [
            "from",
            "where",
            "set",
            "values",
            "returning",
            "limit",
          ]) {
            chain[m] = (...__args: unknown[]) => chain;
          }
          chain.then = (resolve: (v: MockRow[]) => unknown) =>
            Promise.resolve(resolve(result));
          return chain;
        },
        update: (..._args: unknown[]) => {
          const tableName = tableOrder[updateCallCount++] ?? "unknown";
          return makeUpdateChain(tableName);
        },
        insert: (..._args: unknown[]) => {
          const chain: Record<string, unknown> = {};
          for (const m of ["from", "where", "set", "values", "returning"]) {
            chain[m] = (...__args: unknown[]) => chain;
          }
          chain.then = (resolve: (v: MockRow[]) => unknown) =>
            Promise.resolve(resolve([]));
          return chain;
        },
      };
    }

    it("re-parents agent children to the removed agent's own parent", async () => {
      // Removed agent a1's parent lookup → user u-parent.
      const db = createTrackingDb([[{ parentType: "user", parentId: "u-parent" }]]);
      const svc = orgHierarchyService(db as any);
      await svc.reparentChildren("co-1", "a1", "agent");

      expect(updateCalls.length).toBe(2);
      // First update targets agents table, carries the resolved parent (NOT null)
      expect(updateCalls[0].table).toBe("agents");
      expect(updateCalls[0].setArg).toEqual(
        expect.objectContaining({
          parentType: "user",
          parentId: "u-parent",
          // reportsTo is null because the new parent is a user, not an agent
          reportsTo: null,
        }),
      );
    });

    it("re-parents child agents' reportsTo when the new parent is an agent", async () => {
      // Removed agent a1's parent lookup → agent a-grandparent.
      const db = createTrackingDb([[{ parentType: "agent", parentId: "a-grandparent" }]]);
      const svc = orgHierarchyService(db as any);
      await svc.reparentChildren("co-1", "a1", "agent");

      expect(updateCalls[0].table).toBe("agents");
      expect(updateCalls[0].setArg).toEqual(
        expect.objectContaining({
          parentType: "agent",
          parentId: "a-grandparent",
          // agent parent → reportsTo follows the agent parent
          reportsTo: "a-grandparent",
        }),
      );
    });

    it("re-parents user children (company_memberships) to the removed entity's parent", async () => {
      // Removed user u1's membership lookup → user u-manager.
      const db = createTrackingDb([[{ parentType: "user", parentId: "u-manager" }]]);
      const svc = orgHierarchyService(db as any);
      await svc.reparentChildren("co-1", "u1", "user");

      expect(updateCalls.length).toBe(2);
      // Second update targets company_memberships, carries resolved parent (NOT null)
      expect(updateCalls[1].table).toBe("company_memberships");
      expect(updateCalls[1].setArg).toEqual(
        expect.objectContaining({
          parentType: "user",
          parentId: "u-manager",
        }),
      );
      // No reportsTo on the company_memberships set clause
      expect(updateCalls[1].setArg).not.toHaveProperty("reportsTo");
    });

    it("falls back to the company founder when the removed entity has no parent", async () => {
      // 1st select: removed agent a1's parent → none (root).
      // 2nd select: getFounderUserId → user_roles founder = u-founder.
      const db = createTrackingDb([
        [{ parentType: null, parentId: null }],
        [{ userId: "u-founder" }],
      ]);
      const svc = orgHierarchyService(db as any);
      await svc.reparentChildren("co-1", "a1", "agent");

      expect(updateCalls[0].table).toBe("agents");
      // Children re-parent to the founder, NOT to null.
      expect(updateCalls[0].setArg).toEqual(
        expect.objectContaining({
          parentType: "user",
          parentId: "u-founder",
          reportsTo: null,
        }),
      );
    });

    it("clears reportsTo on agent children only for agent parents", async () => {
      // When removing an AGENT, reportsTo is set on agent children (here null,
      // because the resolved new parent is a user).
      const db1 = createTrackingDb([[{ parentType: "user", parentId: "u-parent" }]]);
      const svc1 = orgHierarchyService(db1 as any);
      await svc1.reparentChildren("co-1", "a1", "agent");
      expect(updateCalls[0].table).toBe("agents");
      expect(updateCalls[0].setArg).toHaveProperty("reportsTo");

      // When removing a USER, reportsTo should NOT be present on the agent set
      // clause (reportsTo is agent-to-agent only; user parents don't affect it).
      updateCalls.length = 0;
      const db2 = createTrackingDb([[{ parentType: "user", parentId: "u-manager" }]]);
      const svc2 = orgHierarchyService(db2 as any);
      await svc2.reparentChildren("co-1", "u1", "user");
      expect(updateCalls[0].table).toBe("agents");
      expect(updateCalls[0].setArg).not.toHaveProperty("reportsTo");
    });

    it("accepts a transaction object instead of default db", async () => {
      const tx = createTrackingDb([[{ parentType: "user", parentId: "u-parent" }]]);
      // Create service with a different db, but pass tx
      const mainDb = createSequenceDb();
      const svc = orgHierarchyService(mainDb as any);
      await svc.reparentChildren("co-1", "a1", "agent", tx as any);

      // Should have used tx, not mainDb
      expect(updateCalls.length).toBe(2);
    });
  });
});
