import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import {
  applyPendingMigrations,
  assets,
  companies,
  createDb,
  universeDrafts,
  type Db,
} from "@armyofagents/db";
import { insertTestCompany } from "./helpers/insert-test-company.js";
import {
  universeDraftsService,
  type UniverseScope,
} from "../services/universe-drafts.js";

/**
 * Real-Postgres proof of the destination-scoped draft service (E1.3/1): the
 * migration creates the table + FK + unique index, CAS on expectedRevision gives
 * one-write-one-conflict, drafts are isolated per (company, user, conversation,
 * destinationKind, destinationId), and deleting a company cascades to its drafts.
 * Embedded-postgres harness (skipIf win32 like the sibling integration suites).
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

const patch = (expectedRevision: number, text: string, attachmentAssetIds: string[] = []) => ({
  schemaVersion: 1 as const,
  expectedRevision,
  text,
  attachmentAssetIds,
});
const taskDest = (id: string) => ({ kind: "task" as const, id });

describe.skipIf(process.platform === "win32")(
  "universe draft persistence (real PostgreSQL)",
  () => {
    let db: Db;
    let svc: ReturnType<typeof universeDraftsService>;
    const companyA = randomUUID();
    const companyB = randomUUID();
    const userA = `universe-draft-a-${randomUUID()}`;
    const userB = `universe-draft-b-${randomUUID()}`;
    const scope = (companyId = companyA, userId = userA): UniverseScope => ({
      companyId,
      userId,
      conversationId: `conv-${randomUUID()}`,
    });

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-universe-drafts-integ-"));
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
      svc = universeDraftsService(db);
      const suffix = () => Math.floor(Math.random() * 9000 + 1000);
      await insertTestCompany(db, {
        id: companyA,
        name: "Universe Draft A",
        issuePrefix: `UDA${suffix()}`,
      });
      await insertTestCompany(db, {
        id: companyB,
        name: "Universe Draft B",
        issuePrefix: `UDB${suffix()}`,
      });
    }, 180_000);

    afterAll(async () => {
      await pg?.stop();
      if (dataDir) await rm(dataDir, { recursive: true, force: true });
    });

    it("get returns an empty draft at revision 0 before any write", async () => {
      const draft = await svc.get(scope(), taskDest("t1"));
      expect(draft).toEqual({ revision: 0, text: "", attachmentAssetIds: [] });
    });

    it("patch creates then updates, bumping the revision, and clears on empty", async () => {
      const s = scope();
      const assetId = randomUUID();
      await db.insert(assets).values({id: assetId, companyId: companyA, provider: "local", objectKey: `draft/${assetId}`, contentType: "text/plain", byteSize: 5, sha256: "0".repeat(64), composerValidated: true});
      const first = await svc.patch(s, taskDest("t1"), patch(0, "hello", [assetId]));
      expect(first).toEqual({ revision: 1, text: "hello", attachmentAssetIds: [assetId], payload: {kind: "task", text: "hello", attachmentAssetIds: [assetId]}, pendingAttempt: null });
      const second = await svc.patch(s, taskDest("t1"), patch(1, "hello world"));
      expect(second).toEqual({ revision: 2, text: "hello world", attachmentAssetIds: [], payload: {kind: "task", text: "hello world", attachmentAssetIds: []}, pendingAttempt: null });
      expect(await svc.get(s, taskDest("t1"))).toEqual(second);
      // Clear (post-send) is just a patch to empty at the current revision.
      const cleared = await svc.patch(s, taskDest("t1"), patch(2, ""));
      expect(cleared).toEqual({ revision: 3, text: "", attachmentAssetIds: [], payload: {kind: "task", text: "", attachmentAssetIds: []}, pendingAttempt: null });
    });

    it("persists a structured answer and rejects a payload for another destination", async () => {
      const s = scope();
      const question = {kind: "question" as const, id: randomUUID()};
      const first = await svc.patch(s, question, {
        schemaVersion: 1,
        expectedRevision: 0,
        payload: {kind: "question", expectedVersion: 2, text: "Because", selectedValues: ["yes"]},
        pendingAttempt: {attemptId: "attempt-1", draftRevision: 0, payloadHash: "hash-1", idempotencyKey: "idem-1", state: "pending"},
      });
      expect(first.payload).toMatchObject({kind: "question", expectedVersion: 2});
      expect(first.pendingAttempt).toMatchObject({attemptId: "attempt-1", state: "pending"});
      await expect(svc.patch(s, question, {
        schemaVersion: 1,
        expectedRevision: 1,
        payload: {kind: "approval", observedUpdatedAt: new Date().toISOString(), decision: null, decisionNote: ""},
      })).rejects.toMatchObject({status: 400});
    });

    it("a stale expectedRevision is a 409 and does not change the draft", async () => {
      const s = scope();
      await svc.patch(s, taskDest("t1"), patch(0, "v1"));
      await expect(
        svc.patch(s, taskDest("t1"), patch(0, "conflicting")),
      ).rejects.toMatchObject({ status: 409 });
      expect((await svc.get(s, taskDest("t1"))).text).toBe("v1");
    });

    it("drafts are isolated per destination, user and company", async () => {
      const s = scope();
      await svc.patch(s, taskDest("t1"), patch(0, "for-t1"));
      // Different destination id on the same scope is a separate empty draft.
      expect((await svc.get(s, taskDest("t2"))).revision).toBe(0);
      // Different destination kind is separate.
      expect(
        (await svc.get(s, { kind: "commander", id: "t1" })).revision,
      ).toBe(0);
      // Different user / company are separate.
      const conversationId = s.conversationId;
      expect(
        (await svc.get({ companyId: companyA, userId: userB, conversationId }, taskDest("t1"))).revision,
      ).toBe(0);
      expect(
        (await svc.get({ companyId: companyB, userId: userA, conversationId }, taskDest("t1"))).revision,
      ).toBe(0);
      expect((await svc.get(s, taskDest("t1"))).text).toBe("for-t1");
    });

    it("deleting a company cascades to its drafts", async () => {
      const cascadeCompany = randomUUID();
      await insertTestCompany(db, {
        id: cascadeCompany,
        name: "Universe Draft Cascade",
        issuePrefix: `UDC${Math.floor(Math.random() * 9000 + 1000)}`,
      });
      const s = scope(cascadeCompany);
      await svc.patch(s, taskDest("t1"), patch(0, "doomed"));
      expect(
        await db.select().from(universeDrafts).where(eq(universeDrafts.companyId, cascadeCompany)),
      ).toHaveLength(1);
      await db.delete(companies).where(eq(companies.id, cascadeCompany));
      expect(
        await db.select().from(universeDrafts).where(eq(universeDrafts.companyId, cascadeCompany)),
      ).toHaveLength(0);
    });
  },
);
