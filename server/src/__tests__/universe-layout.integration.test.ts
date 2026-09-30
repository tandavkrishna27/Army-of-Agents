import {companyService} from "../services/companies.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import {
  applyPendingMigrations,
  companies,
  activityLog,
  issues,
  artifacts, artifactVersions,
  internalAgentConversations,
  createDb,
  universeLayouts,
  universePanelCheckpoints,
  universeLayoutOperations,
  type Db,
} from "@armyofagents/db";
import * as activity from "../services/activity-log.js";
import { insertTestCompany } from "./helpers/insert-test-company.js";
import {
  universeLayoutService,
  type UniverseScope,
} from "../services/universe-layout.js";

/**
 * Real-Postgres proof of the revisioned universe-layout service â€” the parts a
 * Drizzle mock can't cover: the migration actually creates both tables + FKs +
 * unique indexes, the atomic apply() bumps a revision and journals a receipt,
 * revision gating + receipt dedup give exactly one ack per operation id, layouts
 * are isolated per (company, user, conversation), and deleting a company cascades
 * to its layout + operation rows.
 *
 * Embedded-postgres harness (matches home-board-layout.integration.test.ts). The
 * whole suite (boot included) skips on Windows per Issue #114; on Linux a boot
 * failure throws and reddens the suite (fail-closed) â€” it never silently skips.
 * To run locally on Windows, temporarily flip to `describe.skipIf(false)`.
 */
type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";

const rect = { x: 10, y: 20, width: 300, height: 200 };

describe.skipIf(process.platform === "win32")(
  "universe layout persistence (real PostgreSQL)",
  () => {
    let db: Db;
    let svc: ReturnType<typeof universeLayoutService>;
    const companyA = randomUUID();
    const companyB = randomUUID();
    const userA = `universe-user-a-${randomUUID()}`;
    const userB = `universe-user-b-${randomUUID()}`;
    const freshScope = async (companyId = companyA, userId = userA): Promise<UniverseScope> => {
      const conversationId = randomUUID();
      await db.insert(internalAgentConversations).values({ id: conversationId, companyId, userId });
      return { companyId, userId, conversationId };
    };

    const taskIds = new Map<string, string>();
    const openOp = async (scope: UniverseScope, label: string, title = label) => {
      const identity = `${scope.companyId}/${scope.conversationId}/${label}`;
      let id = taskIds.get(identity);
      if (!id) {
        id = randomUUID(); taskIds.set(identity, id);
        await db.insert(issues).values({ id, companyId: scope.companyId, title });
      }
      return { type: "open" as const,
        key: JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "task", id, null]),
        ref: { kind: "task" as const, id }, rect, title };
    };

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-universe-layout-integ-"));
      const port = await allocateEmbeddedPgPort();
      const { default: EmbeddedPostgres } = (await import(
        "embedded-postgres"
      )) as { default: EmbeddedPostgresCtor };
      pg = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"),
        user: "test",
        password: "test",
        port,
        persistent: false,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
      });
      await pg.initialise();
      await pg.start();
      const connectionString = `postgres://test:test@localhost:${port}/postgres`;
      await applyPendingMigrations(connectionString);
      db = createDb(connectionString);
      svc = universeLayoutService(db);
      const suffix = () => Math.floor(Math.random() * 9000 + 1000);
      await insertTestCompany(db, {
        id: companyA,
        name: "Universe A",
        issuePrefix: `UNA${suffix()}`,
      });
      await insertTestCompany(db, {
        id: companyB,
        name: "Universe B",
        issuePrefix: `UNB${suffix()}`,
      });
    }, 180_000);

    afterAll(async () => {
      await pg?.stop();
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    });

    it("get returns an empty document at revision 0 before any write", async () => {
      const snap = await svc.get(await freshScope());
      expect(snap.revision).toBe(0);
      expect(snap.document.panels).toHaveLength(0);
    });

    it("apply opens a panel, bumps the revision and reads back the document", async () => {
      const scope = await freshScope();
      const ack = await svc.apply(scope, {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevision: 0,
        operations: [await openOp(scope, "k1", "First")],
      });
      expect(ack.revision).toBe(1);
      const snap = await svc.get(scope);
      expect(snap.revision).toBe(1);
      expect(snap.document.panels).toHaveLength(1);
      const expected = await openOp(scope, "k1", "First");
      expect(snap.document.panels[0]).toMatchObject({
        key: expected.key,
        title: "First",
        ref: { companyId: scope.companyId, kind: "task", id: expected.ref.id },
      });
      expect(snap.document.order).toEqual([expected.key]);
    });

    it("concurrent revision-zero writes yield exactly one ack and one conflict", async () => {
      const scope = await freshScope();
      const operations = await Promise.all([openOp(scope, "k1"), openOp(scope, "k2")]);
      const results = await Promise.allSettled(operations.map(op => svc.apply(scope, {
        schemaVersion: 1, operationId: randomUUID(), expectedRevision: 0, operations: [op],
      })));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find(result => result.status === "rejected")).toMatchObject({reason: {status: 409}});
      expect((await svc.get(scope)).revision).toBe(1);
      const [layout] = await db.select().from(universeLayouts).where(eq(universeLayouts.conversationId, scope.conversationId));
      expect(await db.select().from(universeLayoutOperations).where(eq(universeLayoutOperations.layoutId, layout.id))).toHaveLength(1);
      const loser = operations[results.findIndex(result => result.status === "rejected")];
      const retry = await svc.apply(scope, {schemaVersion: 1, operationId: randomUUID(), expectedRevision: 1, operations: [loser]});
      expect(retry.nextOpenedOrdinal).toBe(3);
      const afterRetry = await svc.get(scope);
      expect(afterRetry.document.panels.map(panel => panel.openedOrdinal).sort()).toEqual([1, 2]);
      expect(afterRetry.revision).toBe(2);
    });

    it("replaying a patch returns the original ack; a changed payload under a reused id conflicts", async () => {
      const scope = await freshScope();
      const patch = {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevision: 0,
        operations: [await openOp(scope, "k1", "Original")],
      };
      const ack = await svc.apply(scope, patch);
      expect(await svc.apply(scope, patch)).toEqual(ack);
      await expect(
        svc.apply(scope, { ...patch, operations: [await openOp(scope, "k1", "Changed")] }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await svc.get(scope)).revision).toBe(1);
      const receipt = await svc.getReceipt(scope, patch.operationId);
      expect(receipt).toEqual(ack);
    });

    it("layouts and receipts are isolated per owner and per company", async () => {
      const scopeA = await freshScope();
      const { conversationId } = scopeA;
      const patch = {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevision: 0,
        operations: [await openOp(scopeA, "k1")],
      };
      await svc.apply(scopeA, patch);

      const otherUser: UniverseScope = { companyId: companyA, userId: userB, conversationId };
      const otherCompany: UniverseScope = { companyId: companyB, userId: userA, conversationId };
      for (const scope of [otherUser, otherCompany]) {
        await expect(svc.get(scope)).rejects.toMatchObject({ status: 404 });
        await expect(svc.apply(scope, patch)).rejects.toMatchObject({ status: 404 });
        // A receipt is reachable only through its own authorized parent layout.
        await expect(svc.getReceipt(scope, patch.operationId)).rejects.toMatchObject({ status: 404 });
      }
      expect((await svc.get(scopeA)).document.panels).toHaveLength(1);
    });

    it("rejects a foreign-company task even with a locally scoped panel key", async () => {
      const scope = await freshScope();
      const other = await freshScope(companyB);
      const foreign = await openOp(other, "foreign");
      foreign.key = JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "task", foreign.ref.id, null]);
      await expect(svc.apply(scope, { schemaVersion: 1, operationId: randomUUID(),
        expectedRevision: 0, operations: [foreign] })).rejects.toMatchObject({ status: 404 });
      expect((await svc.get(scope)).revision).toBe(0);
      expect(await db.select().from(universeLayouts).where(eq(universeLayouts.conversationId, scope.conversationId))).toHaveLength(0);
    });

    it("resolves current titles and retains layout when its task disappears", async () => {
      const scope = await freshScope(); const op = await openOp(scope, "rename", "Canonical");
      await svc.apply(scope, { schemaVersion: 1, operationId: randomUUID(), expectedRevision: 0,
        operations: [{ ...op, title: "Untrusted client title" }] });
      expect((await svc.get(scope)).document.panels[0].title).toBe("Canonical");
      await db.update(issues).set({ title: "Renamed" }).where(eq(issues.id, op.ref.id));
      expect((await svc.get(scope)).document.panels[0].title).toBe("Renamed");
      await db.delete(issues).where(eq(issues.id, op.ref.id));
      await expect(svc.get(scope)).rejects.toMatchObject({ status: 404 });
      const [saved] = await db.select().from(universeLayouts).where(eq(universeLayouts.conversationId, scope.conversationId));
      expect(saved.document.panels).toHaveLength(1);
      await svc.apply(scope, { schemaVersion: 1, operationId: randomUUID(), expectedRevision: 1,
        operations: [{ type: "close", key: op.key }] });
      expect((await svc.get(scope)).document.panels).toHaveLength(0);
    });

    it("checkpoint first-write race has one winner and survives panel close", async () => {
      const scope = await freshScope(); const id = randomUUID(); const version = randomUUID();
      await db.insert(artifacts).values({ id, companyId: scope.companyId, title: "Checkpoint artifact", type: "document", createdById: scope.userId });
      await db.insert(artifactVersions).values({ id: version, artifactId: id, versionNumber: 1, source: "human" });
      const key = JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "artifact", id, version]);
      const patch = { sourceVersionId: version, schemaVersion: 1, expectedRevision: 0,
        data: { inputs: { quantity: 2 }, selectedRows: [0], filters: {} } };
      expect(await svc.getCheckpoint(scope, key, version)).toBeNull();
      const results = await Promise.allSettled([svc.saveCheckpoint(scope, key, patch), svc.saveCheckpoint(scope, key, patch)]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
      await svc.apply(scope, { schemaVersion: 1, operationId: randomUUID(), expectedRevision: 0,
        operations: [{ type: "open", key, ref: { kind: "artifact", id, version }, rect, title: "ignored" }, { type: "close", key }] });
      expect(await svc.getCheckpoint(scope, key, version)).toEqual({ revision: 1, schemaVersion: 1, data: patch.data });
      await expect(svc.getCheckpoint({ ...scope, userId: userB }, key, version)).rejects.toMatchObject({ status: 404 });
    });

    it("checkpoint validation, version isolation, and revocation preserve existing state", async () => {
      const scope = await freshScope(); const id = randomUUID(); const v1 = randomUUID(); const v2 = randomUUID();
      await db.insert(artifacts).values({id, companyId: scope.companyId, title: "Versions", type: "document", createdById: scope.userId});
      await db.insert(artifactVersions).values([{id: v1, artifactId: id, versionNumber: 1, source: "human"}, {id: v2, artifactId: id, versionNumber: 2, source: "human"}]);
      const keyFor = (version: string) => JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "artifact", id, version]);
      const patch = {sourceVersionId: v1, schemaVersion: 1, expectedRevision: 0, data: {inputs: {quantity: 2}, selectedRows: [0], filters: {}}};
      await svc.saveCheckpoint(scope, keyFor(v1), patch);
      await expect(svc.saveCheckpoint(scope, keyFor(v1), patch)).rejects.toMatchObject({status: 409});
      for (const invalid of [
        {...patch, schemaVersion: 2},
        {...patch, data: {...patch.data, inputs: {large: "Ã©".repeat(20000)}}},
        {...patch, data: {...patch.data, execute: "not a registered field"}},
        {...patch, sourceVersionId: v2},
      ]) await expect(svc.saveCheckpoint(scope, keyFor(v1), invalid)).rejects.toMatchObject({status: 400});
      expect(await svc.getCheckpoint(scope, keyFor(v1), v1)).toEqual({revision: 1, schemaVersion: 1, data: patch.data});
      expect(await svc.getCheckpoint(scope, keyFor(v2), v2)).toBeNull();
      await svc.saveCheckpoint(scope, keyFor(v2), {...patch, sourceVersionId: v2});
      await expect(svc.getCheckpoint({...scope, companyId: companyB}, keyFor(v1), v1)).rejects.toMatchObject({status: 404});
      await db.update(universePanelCheckpoints).set({schemaVersion: 2}).where(and(eq(universePanelCheckpoints.conversationId, scope.conversationId), eq(universePanelCheckpoints.sourceVersionId, v2)));
      await expect(svc.getCheckpoint(scope, keyFor(v2), v2)).rejects.toMatchObject({status: 409});
      await db.update(internalAgentConversations).set({userId: userB}).where(eq(internalAgentConversations.id, scope.conversationId));
      await expect(svc.getCheckpoint(scope, keyFor(v1), v1)).rejects.toMatchObject({status: 404});
      await expect(svc.saveCheckpoint(scope, keyFor(v1), {...patch, expectedRevision: 1})).rejects.toMatchObject({status: 404});
    });

    it("persists camera and coupled presentation without changing restore geometry", async () => {
      const scope = await freshScope(); const first = await openOp(scope, "one"); const second = await openOp(scope, "two");
      await svc.apply(scope, {schemaVersion: 1, operationId: randomUUID(), expectedRevision: 0, operations: [first, second, {type: "geometry", key: first.key, rect, placement: "manual"},
        {type: "viewport", x: 120, y: -40, zoom: 0.75}, {type: "order", keys: [first.key, second.key]},
        {type: "presentation", selected: second.key, maximized: second.key}]});
      const snapshot = await svc.get(scope);
      expect(snapshot.document.viewport).toEqual({x: 120, y: -40, zoom: 0.75});
      expect(snapshot.document.maximized).toBe(second.key);
      expect(snapshot.document.panels[0].placement).toBe("manual");
      expect(snapshot.document.panels.map(panel => panel.rect)).toEqual([rect, rect]);
      await svc.apply(scope, {schemaVersion: 1, operationId: randomUUID(), expectedRevision: 1, operations: [{type: "minimize", key: second.key, value: true}]});
      const minimized = await svc.get(scope);
      expect(minimized.document.selected).toBe(first.key);
      expect(minimized.document.maximized).toBeNull();
      expect(minimized.document.viewport).toEqual(snapshot.document.viewport);
    });

    it("receipt retains opening incarnations after later document changes", async () => {
      const scope = await freshScope(); const op = await openOp(scope, "receipt");
      const patch = { schemaVersion: 1, operationId: randomUUID(), expectedRevision: 0,
        operations: [op, { type: "close", key: op.key }, op] };
      const ack = await svc.apply(scope, patch);
      expect(ack.opened).toEqual([{ operationIndex: 0, key: op.key, openedOrdinal: 1 }, { operationIndex: 2, key: op.key, openedOrdinal: 2 }]);
      expect(ack.nextOpenedOrdinal).toBe(3);
      await svc.apply(scope, { schemaVersion: 1, operationId: randomUUID(), expectedRevision: 1, operations: [{ type: "close", key: op.key }] });
      expect(await svc.apply(scope, patch)).toEqual(ack);
      expect(await svc.getReceipt(scope, patch.operationId)).toEqual(ack);
    });

    it("revoked conversation ownership denies existing layouts and receipt replay", async () => {
      const scope = await freshScope();
      const patch = { schemaVersion: 1, operationId: randomUUID(), expectedRevision: 0,
        operations: [await openOp(scope, "owned")] };
      await svc.apply(scope, patch);
      await db.update(internalAgentConversations).set({ userId: userB })
        .where(eq(internalAgentConversations.id, scope.conversationId));
      await expect(svc.get(scope)).rejects.toMatchObject({ status: 404 });
      await expect(svc.getReceipt(scope, patch.operationId)).rejects.toMatchObject({ status: 404 });
      await expect(svc.apply(scope, patch)).rejects.toMatchObject({ status: 404 });
      const [row] = await db.select().from(universeLayouts)
        .where(eq(universeLayouts.conversationId, scope.conversationId));
      expect(row.revision).toBe(1);
    });

    it("rolls back layout document, receipt, and audit when audit insertion fails", async () => {
      const scope = await freshScope(); const op = await openOp(scope, "audit");
      await svc.apply(scope, {schemaVersion: 1, operationId: randomUUID(), expectedRevision: 0, operations: [op]});
      const before = await svc.get(scope);
      const auditBefore = await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId));
      const operationId = randomUUID();
      const spy = vi.spyOn(activity, "insertActivityLog").mockRejectedValueOnce(new Error("injected audit failure"));
      try {
        await expect(svc.apply(scope, {schemaVersion: 1, operationId, expectedRevision: 1,
          operations: [{type: "geometry", key: op.key, rect: {...rect, x: 999}}]})).rejects.toThrow("injected audit failure");
      } finally { spy.mockRestore(); }
      expect(await svc.get(scope)).toEqual(before);
      expect(await svc.getReceipt(scope, operationId)).toBeNull();
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId))).toEqual(auditBefore);
    });

    it("rolls back checkpoint first-write sentinel and subsequent update on audit failure", async () => {
      const scope = await freshScope(); const id = randomUUID(); const version = randomUUID();
      await db.insert(artifacts).values({id, companyId: scope.companyId, title: "Rollback", type: "document", createdById: scope.userId});
      await db.insert(artifactVersions).values({id: version, artifactId: id, versionNumber: 1, source: "human"});
      const key = JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "artifact", id, version]);
      const patch = {sourceVersionId: version, schemaVersion: 1, expectedRevision: 0, data: {inputs: {value: 1}, selectedRows: [], filters: {}}};
      for (const revision of [0, 1]) {
        const auditBefore = await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId));
        const spy = vi.spyOn(activity, "insertActivityLog").mockRejectedValueOnce(new Error("checkpoint audit failure"));
        try {
          await expect(svc.saveCheckpoint(scope, key, {...patch, expectedRevision: revision,
            data: {...patch.data, inputs: {value: 999}}})).rejects.toThrow("checkpoint audit failure");
        } finally { spy.mockRestore(); }
        const rows = await db.select().from(universePanelCheckpoints).where(eq(universePanelCheckpoints.conversationId, scope.conversationId));
        expect(rows).toHaveLength(revision);
        expect(await svc.getCheckpoint(scope, key, version)).toEqual(revision === 0 ? null : {revision: 1, schemaVersion: 1, data: patch.data});
        expect(await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId))).toEqual(auditBefore);
        if (revision === 0) await svc.saveCheckpoint(scope, key, patch);
      }
    });

    it("denies foreign checkpoint sources and versions belonging to another artifact", async () => {
      const scope = await freshScope(); const own = randomUUID(); const otherOwn = randomUUID(); const foreign = randomUUID(); const version = randomUUID(); const otherVersion = randomUUID();
      await db.insert(artifacts).values([
        {id: own, companyId: scope.companyId, title: "Owned", type: "document", createdById: scope.userId},
        {id: otherOwn, companyId: scope.companyId, title: "Other owned", type: "document", createdById: scope.userId},
        {id: foreign, companyId: companyB, title: "Foreign", type: "document", createdById: scope.userId},
      ]);
      await db.insert(artifactVersions).values({id: version, artifactId: foreign, versionNumber: 1, source: "human"});
      await db.insert(artifactVersions).values({id: otherVersion, artifactId: otherOwn, versionNumber: 1, source: "human"});
      for (const [id, sourceVersion] of [[foreign, version], [own, version], [own, otherVersion]]) {
        const key = JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "artifact", id, sourceVersion]);
        await expect(svc.getCheckpoint(scope, key, sourceVersion)).rejects.toMatchObject({status: 404});
        await expect(svc.saveCheckpoint(scope, key, {sourceVersionId: sourceVersion, schemaVersion: 1, expectedRevision: 0,
          data: {inputs: {}, selectedRows: [], filters: {}}})).rejects.toMatchObject({status: 404});
      }
      expect(await db.select().from(universePanelCheckpoints).where(eq(universePanelCheckpoints.conversationId, scope.conversationId))).toHaveLength(0);
    });

    it("enforces the exact checkpoint UTF-8 byte boundary", async () => {
      const scope = await freshScope(); const id = randomUUID(); const version = randomUUID();
      await db.insert(artifacts).values({id, companyId: scope.companyId, title: "Boundary", type: "document", createdById: scope.userId});
      await db.insert(artifactVersions).values({id: version, artifactId: id, versionNumber: 1, source: "human"});
      const key = JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "artifact", id, version]);
      const data = {inputs: {text: ""}, selectedRows: [], filters: {}};
      data.inputs.text = "x".repeat(32768 - Buffer.byteLength(JSON.stringify(data)));
      expect(Buffer.byteLength(JSON.stringify(data))).toBe(32768);
      const patch = {sourceVersionId: version, schemaVersion: 1, expectedRevision: 0, data};
      await svc.saveCheckpoint(scope, key, patch);
      await expect(svc.saveCheckpoint(scope, key, {...patch, expectedRevision: 1,
        data: {...data, inputs: {text: data.inputs.text + "x"}}})).rejects.toMatchObject({status: 400});
      expect(await svc.getCheckpoint(scope, key, version)).toEqual({revision: 1, schemaVersion: 1, data});
    });

    it("rejects invalid final presentation and exhausted ordinals atomically", async () => {
      const scope = await freshScope(); const op = await openOp(scope, "existing");
      await svc.apply(scope, {schemaVersion: 1, operationId: randomUUID(), expectedRevision: 0, operations: [op]});
      const before = await svc.get(scope);
      const auditBefore = await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId));
      const invalidId = randomUUID();
      await expect(svc.apply(scope, {schemaVersion: 1, operationId: invalidId, expectedRevision: 1, operations: [
        {type: "geometry", key: op.key, rect: {...rect, x: 555}},
        {type: "presentation", selected: "missing", maximized: "missing"},
      ]})).rejects.toMatchObject({status: 400});
      expect(await svc.get(scope)).toEqual(before);
      expect(await svc.getReceipt(scope, invalidId)).toBeNull();
      await db.update(universeLayouts).set({document: {...before.document, nextOpenedOrdinal: Number.MAX_SAFE_INTEGER}})
        .where(eq(universeLayouts.conversationId, scope.conversationId));
      const exhausted = await svc.get(scope); const exhaustedId = randomUUID();
      await expect(svc.apply(scope, {schemaVersion: 1, operationId: exhaustedId, expectedRevision: 1,
        operations: [await openOp(scope, "overflow")]})).rejects.toMatchObject({status: 400});
      expect(await svc.get(scope)).toEqual(exhausted);
      expect(await svc.getReceipt(scope, exhaustedId)).toBeNull();
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, scope.companyId))).toEqual(auditBefore);
    });

    it("deleting a company cascades to its layouts, receipts, and panel checkpoints", async () => {
      const cascadeCompany = randomUUID();
      await insertTestCompany(db, {
        id: cascadeCompany,
        name: "Universe Cascade",
        issuePrefix: `UNC${Math.floor(Math.random() * 9000 + 1000)}`,
      });
      const scope = await freshScope(cascadeCompany);
      await svc.apply(scope, {
        schemaVersion: 1,
        operationId: randomUUID(),
        expectedRevision: 0,
        operations: [await openOp(scope, "k1")],
      });
      expect(
        await db
          .select()
          .from(universeLayouts)
          .where(eq(universeLayouts.companyId, cascadeCompany)),
      ).toHaveLength(1);

      const artifactId = randomUUID(); const version = randomUUID();
      await db.insert(artifacts).values({id: artifactId, companyId: cascadeCompany, title: "Cascade checkpoint", type: "document", createdById: scope.userId});
      await db.insert(artifactVersions).values({id: version, artifactId, versionNumber: 1, source: "human"});
      const panelKey = JSON.stringify([scope.companyId, scope.userId, scope.conversationId, "artifact", artifactId, version]);
      await svc.saveCheckpoint(scope, panelKey, {sourceVersionId: version, schemaVersion: 1, expectedRevision: 0,
        data: {inputs: {value: 7}, selectedRows: [], filters: {}}});
      expect(await db.select().from(universePanelCheckpoints).where(eq(universePanelCheckpoints.companyId, cascadeCompany))).toHaveLength(1);

      // Use the production removal path: ordinary activity rows are removed
      // before the company FK is cleared; denial evidence is retained.
      await companyService(db).remove(cascadeCompany);
      expect(await db.select().from(universePanelCheckpoints).where(eq(universePanelCheckpoints.companyId, cascadeCompany))).toHaveLength(0);


      expect(
        await db
          .select()
          .from(universeLayouts)
          .where(eq(universeLayouts.companyId, cascadeCompany)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(universeLayoutOperations)
          .where(and(eq(universeLayoutOperations.companyId, cascadeCompany))),
      ).toHaveLength(0);
    });
  },
);
