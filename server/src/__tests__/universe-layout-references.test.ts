import { describe, expect, it, vi } from "vitest";
const audit = vi.hoisted(() => ({ insert: vi.fn(async (_db: unknown, input: unknown) => ({ id: "audit", ...(input as object) })), publish: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ insertActivityLog: audit.insert, publishActivityLogged: audit.publish }));
vi.mock("drizzle-orm", () => ({ and: (...parts: unknown[]) => parts, eq: (column: unknown, value: unknown) => ({ column, value }) }));
vi.mock("@armyofagents/db", () => {
  const table = (name: string) => Object.fromEntries(["id", "companyId", "userId", "conversationId", "layoutId", "operationId", "artifactId", "title"].map(k => [k, name + "." + k]).concat([["name", name]]));
  return Object.fromEntries(["internalAgentConversations", "universeLayouts", "universeLayoutOperations", "issues", "artifacts", "artifactVersions", "universePanelCheckpoints"].map(n => [n, table(n)]));
});
import { hashLayoutOperations } from "../services/universe-layout-document.js";
import { universeLayoutService } from "../services/universe-layout.js";
import { layoutPatchSchema, emptyUniverseLayoutDocument } from "@armyofagents/shared";
import type { Db } from "@armyofagents/db";
const scope = { companyId: "11111111-1111-4111-8111-111111111111", userId: "alice", conversationId: "22222222-2222-4222-8222-222222222222" };
const id = "33333333-3333-4333-8333-333333333333";
const version = "44444444-4444-4444-8444-444444444444";
const keyFor = (kind = "task", v?: string) => JSON.stringify([scope.companyId, scope.userId, scope.conversationId, kind, id, v ?? null]);
const open = (kind = "task", v?: string) => ({ type: "open", key: keyFor(kind, v), ref: { kind, id, ...(v ? { version: v } : {}) }, title: "untrusted", rect: { x: 0, y: 0, width: 300, height: 200 } });
function fixture(rows: Record<string, unknown[]> = {}, document = emptyUniverseLayoutDocument()) {
  const predicates: unknown[] = [];
  const writes: any[] = [];
  const state = { inTransaction: false };
  const db: any = {
    select: () => ({ from: (table: any) => {
      const query: any = { where: (p: unknown) => { predicates.push(p); return query; }, innerJoin: () => query, for: () => query,
        then: (yes: any, no: any) => Promise.resolve(rows[table.name] ?? (table.name === "internalAgentConversations" ? [{ id: scope.conversationId }] : table.name === "universeLayouts" ? [{ id: "layout", revision: 0, schemaVersion: 1, document }] : [])).then(yes, no) };
      return query;
    } }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
    update: () => ({ set: (value: any) => { writes.push(value); return { where: async () => {} }; } }),
    transaction: async (fn: any) => { state.inTransaction = true; try { return await fn(db); } finally { state.inTransaction = false; } },
  };
  return { service: universeLayoutService(db as Db), predicates, writes, state };
}
const patch = (op = open()) => ({ schemaVersion: 1, operationId: "attempt", expectedRevision: 0, operations: [op] });
describe("Universe reference authorization", () => {
  it("rejects missing or foreign task before saving or acknowledging", async () => {
    const f = fixture(); await expect(f.service.apply(scope, patch())).rejects.toMatchObject({ status: 404 }); expect(f.writes).toEqual([]);
  });
  it("checks company and resolves canonical task title", async () => {
    const f = fixture({ issues: [{ title: "Canonical task" }] }); await f.service.apply(scope, patch());
    expect(f.writes[0].document.panels[0].title).toBe("Canonical task");
    expect(f.predicates).toContainEqual([{ column: "issues.companyId", value: scope.companyId }, { column: "issues.id", value: id }]);
  });
  it("rejects a noncanonical key", async () => {
    const f = fixture({ issues: [{ title: "Task" }] }); await expect(f.service.apply(scope, patch({ ...open(), key: "forged" }))).rejects.toMatchObject({ status: 400 });
  });
  it("fails closed for unsupported browser references", async () => {
    await expect(fixture().service.apply(scope, patch(open("browser")))).rejects.toMatchObject({ status: 404 });
  });
  it("rejects task version identifiers instead of ignoring them", async () => {
    await expect(fixture({ issues: [{ title: "Task" }] }).service.apply(scope, patch(open("task", version)))).rejects.toMatchObject({ status: 404 });
  });
  it("requires artifact version to belong to the scoped artifact", async () => {
    const f = fixture({ artifacts: [{ title: "Artifact" }] });
    await expect(f.service.apply(scope, patch(open("artifact", version)))).rejects.toMatchObject({ status: 404 });
  });
  it("accepts the exact artifact version and checks both identities", async () => {
    const f = fixture({ artifacts: [{ title: "Artifact" }], artifactVersions: [{ id: version }] });
    await f.service.apply(scope, patch(open("artifact", version)));
    expect(f.writes[0].document.panels[0].title).toBe("Artifact");
    expect(f.predicates).toContainEqual([{ column: "artifacts.companyId", value: scope.companyId }, { column: "artifacts.id", value: id }]);
    expect(f.predicates).toContainEqual([{ column: "artifactVersions.artifactId", value: id }, { column: "artifactVersions.id", value: version }]);
  });
  it("rejects malformed reference IDs without querying a UUID column", async () => {
    const f = fixture(); const op = open(); op.ref.id = "invalid";
    op.key = JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "task", "invalid", null]);
    await expect(f.service.apply(scope, patch(op))).rejects.toMatchObject({ status: 404 });
    expect(f.predicates.flat()).not.toContainEqual({ column: "issues.id", value: "invalid" });
  });
  it("bounds canonical titles to the layout display limit", async () => {
    const f = fixture({ issues: [{ title: "x".repeat(1100) }] });
    await f.service.apply(scope, patch());
    expect(f.writes[0].document.panels[0].title).toBe("x".repeat(1024));
  });
  it("inserts content-free audit in the transaction and publishes after commit", async () => {
    const f = fixture({ issues: [{ title: "secret title" }] });
    audit.insert.mockClear(); audit.publish.mockClear();
    audit.insert.mockImplementationOnce(async (_db, input) => {
      expect(f.state.inTransaction).toBe(true);
      expect(JSON.stringify(input)).not.toContain("secret title");
      expect(JSON.stringify(input)).not.toContain("untrusted");
      return { id: "audit", ...(input as object) };
    });
    audit.publish.mockImplementationOnce(() => expect(f.state.inTransaction).toBe(false));
    await f.service.apply(scope, patch());
    expect(audit.insert).toHaveBeenCalledTimes(1);
    expect(audit.publish).toHaveBeenCalledTimes(1);
  });
  it("does not reject a committed operation when live publication fails", async () => {
    const f = fixture({ issues: [{ title: "Task" }] });
    audit.publish.mockImplementationOnce(() => { throw new Error("offline subscriber"); });
    expect((await f.service.apply(scope, patch())).revision).toBe(1);
    expect(audit.publish).toHaveBeenCalled();
  });
  it("receipt replay does not insert or publish another audit", async () => {
    const input = patch();
    const f = fixture({ universeLayoutOperations: [{ payloadHash: hashLayoutOperations(layoutPatchSchema.parse(input).operations), revision: 1, acknowledgement: { operationId: input.operationId, revision: 1, schemaVersion: 1, nextOpenedOrdinal: 2, opened: [{ operationIndex: 0, key: input.operations[0].key, openedOrdinal: 1 }] } }] });
    audit.insert.mockClear(); audit.publish.mockClear();
    expect((await f.service.apply(scope, input)).revision).toBe(1);
    expect(audit.insert).not.toHaveBeenCalled(); expect(audit.publish).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
  it("audit insertion failure aborts without publishing", async () => {
    const f = fixture({ issues: [{ title: "Task" }] });
    audit.publish.mockClear(); audit.insert.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(f.service.apply(scope, patch())).rejects.toThrow("audit unavailable");
    expect(audit.publish).not.toHaveBeenCalled();
  });
  it("checkpoint rejects non-versioned task keys and unknown schemas", async () => {
    const f = fixture();
    await expect(f.service.saveCheckpoint(scope, keyFor(), { sourceVersionId: version, schemaVersion: 1, expectedRevision: 0,
      data: { inputs: {}, selectedRows: [], filters: {} } })).rejects.toMatchObject({ status: 400 });
    await expect(f.service.saveCheckpoint(scope, keyFor("artifact", version), { sourceVersionId: version, schemaVersion: 99, expectedRevision: 0,
      data: {} })).rejects.toMatchObject({ status: 400 });
  });
  it("checkpoint read authenticates the exact artifact version even with no row", async () => {
    const f = fixture({ artifacts: [{ title: "Artifact" }], artifactVersions: [{ id: version }] });
    expect(await f.service.getCheckpoint(scope, keyFor("artifact", version), version)).toBeNull();
    await expect(fixture({ artifacts: [{ title: "Artifact" }] }).service.getCheckpoint(scope, keyFor("artifact", version), version)).rejects.toMatchObject({ status: 404 });
  });
  it("re-resolves titles on read instead of exposing saved text", async () => {
    const op = open(); const doc = { ...emptyUniverseLayoutDocument(), panels: [{ key: op.key, ref: { ...op.ref, kind: "task" as const, companyId: scope.companyId }, title: "stale", rect: op.rect, openedOrdinal: 1, pinned: false, minimized: false }], order: [op.key], nextOpenedOrdinal: 2 };
    const f = fixture({ issues: [{ title: "New title" }] }, doc);
    expect((await f.service.get(scope)).document.panels[0].title).toBe("New title");
    await expect(fixture({}, doc).service.get(scope)).rejects.toMatchObject({ status: 404 });
  });
});

it("keeps canonical title growth within the aggregate snapshot budget", async () => {
  const panels = Array.from({length:130}, (_, i) => {
    const panelId = `33333333-3333-4333-8333-${String(i).padStart(12,"0")}`;
    return {key:JSON.stringify([scope.companyId,scope.userId,scope.conversationId,"task",panelId,null]),
      ref:{companyId:scope.companyId,kind:"task" as const,id:panelId},title:"short",rect:{x:0,y:0,width:300,height:200},openedOrdinal:i+1,pinned:false,minimized:false};
  });
  const f = fixture({issues:[{title:"界".repeat(1024)}]}, {...emptyUniverseLayoutDocument(),panels,order:panels.map(p=>p.key),nextOpenedOrdinal:131});
  const result = await f.service.get(scope);
  expect(new TextEncoder().encode(JSON.stringify(result.document)).length).toBeLessThanOrEqual(262144);
  expect(result.document.panels.every(p=>p.title.length>0)).toBe(true);
});
