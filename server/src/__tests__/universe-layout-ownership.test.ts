vi.mock("../services/activity-log.js", () => ({ insertActivityLog: vi.fn(), publishActivityLogged: vi.fn() }));
import { describe, expect, it, vi } from "vitest";
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));
vi.mock("@armyofagents/db", () => {
  const table = (name: string) => ({ name, id: "id", companyId: "companyId", userId: "userId",
    conversationId: "conversationId", layoutId: "layoutId", operationId: "operationId" });
  return { universePanelCheckpoints: table("universePanelCheckpoints"), issues: table("issues"), artifacts: table("artifacts"), artifactVersions: table("artifactVersions"), internalAgentConversations: table("internal_agent_conversations"),
    universeLayouts: table("universe_layouts"), universeLayoutOperations: table("universe_layout_operations") };
});
import { universeLayoutService } from "../services/universe-layout.js";
import type { Db } from "@armyofagents/db";
const scope = { companyId: "11111111-1111-4111-8111-111111111111", userId: "alice",
  conversationId: "22222222-2222-4222-8222-222222222222" };
function fixture(owned = false) {
  const predicates: unknown[] = [];
  const tables: string[] = [];
  const locks: string[] = [];
  const db: any = {
    select: vi.fn(() => ({ from: (table: any) => {
      const name = table.name; tables.push(name);
      const query: any = {
        innerJoin: () => query,
        where: (predicate: unknown) => { predicates.push(predicate); return query; },
        for: (mode: string) => { locks.push(mode); return query; },
        then: (resolve: any, reject: any) => Promise.resolve(
          owned && name === "internal_agent_conversations" ? [{ id: scope.conversationId }] : []
        ).then(resolve, reject),
      }; return query;
    } })),
    insert: vi.fn(() => { throw new Error("Unauthorized write reached insert"); }),
    transaction: vi.fn((fn: any) => fn(db)),
  };
  return { db: db as Db, insert: db.insert, predicates, tables, locks };
}
describe("Universe canonical conversation ownership", () => {
  for (const action of ["get", "getReceipt", "apply"] as const) {
    it(`${action} rejects absent or foreign canonical ownership before layout access`, async () => {
      const f = fixture(); const service = universeLayoutService(f.db);
      const result = action === "get" ? service.get(scope) : action === "getReceipt"
        ? service.getReceipt(scope, "receipt") : service.apply(scope, {
          schemaVersion: 1, operationId: "attempt", expectedRevision: 0,
          operations: [{ type: "presentation", selected: null, maximized: null }],
        });
      await expect(result).rejects.toMatchObject({ status: 404 });
      expect(f.insert).not.toHaveBeenCalled();
      expect(f.locks).toEqual(action === "apply" ? ["share"] : []);
      expect(f.tables).toEqual(["internal_agent_conversations"]);
      expect(f.predicates[0]).toEqual([
        { column: "companyId", value: scope.companyId },
        { column: "userId", value: scope.userId },
        { column: "id", value: scope.conversationId },
      ]);
    });
  }
  it("permits an owned conversation with no saved layout", async () => {
    const f = fixture(true);
    expect((await universeLayoutService(f.db).get(scope)).revision).toBe(0);
    expect(f.tables).toEqual(["internal_agent_conversations", "universe_layouts"]);
  });
  it("rejects malformed conversation IDs before querying UUID columns", async () => {
    const f = fixture();
    await expect(universeLayoutService(f.db).get({ ...scope, conversationId: "bad" }))
      .rejects.toMatchObject({ status: 404 });
    expect(f.tables).toEqual([]);
  });
});
