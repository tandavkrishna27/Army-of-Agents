import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  applyPendingMigrations,
  assets,
  createDb,
  internalAgentConversations,
  universeIntakes,
  type Db,
} from "@armyofagents/db";
import type { StorageService } from "../storage/types.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { insertTestCompany } from "./helpers/insert-test-company.js";
import { universeIntakeService } from "../services/universe-intake.js";
import { assertUniverseAssetAccess } from "../services/universe-asset-access.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: { databaseDir: string; user: string; password: string; port: number; persistent: boolean; initdbFlags?: string[] }) => EmbeddedPostgresInstance;

const digest = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const body = Buffer.from("Universe original\n", "utf8");

function memoryStorage(): StorageService & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    provider: "local_disk",
    objects,
    async putFile() { throw new Error("not used"); },
    async putReservedObject(input) { objects.set(input.objectKey, Buffer.from(input.body)); },
    async getObject(a: string | null, b: string, c?: string) {
      const key = c ?? b;
      const value = objects.get(key);
      if (!value) throw new Error("missing object");
      return { stream: Readable.from(value), contentLength: value.length, contentType: "text/plain" };
    },
    async headObject(a: string | null, b: string, c?: string) {
      const value = objects.get(c ?? b);
      return { exists: !!value, contentLength: value?.length };
    },
    async deleteObject(a: string | null, b: string, c?: string) { objects.delete(c ?? b); },
  };
}

describe.skipIf(process.platform === "win32")("Universe original intake (real PostgreSQL)", () => {
  let pg: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let db: Db;
  let storage: ReturnType<typeof memoryStorage>;
  let service: ReturnType<typeof universeIntakeService>;
  const companyId = randomUUID();
  const userId = `intake-${randomUUID()}`;
  const conversationId = randomUUID();
  const scope = { companyId, actorKey: userId };
  const input = (clientKey = randomUUID()) => ({
    clientKey,
    destination: { kind: "canvas" as const, conversationId },
    filename: "original.txt",
    contentType: "text/plain",
    byteSize: body.length,
    sha256: digest(body),
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-universe-intake-"));
    const port = await allocateEmbeddedPgPort();
    const { default: EmbeddedPostgres } = await import("embedded-postgres") as { default: EmbeddedPostgresCtor };
    pg = new EmbeddedPostgres({ databaseDir: join(dataDir, "db"), user: "test", password: "test", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
    await pg.initialise(); await pg.start();
    db = createDb(`postgres://test:test@localhost:${port}/postgres`);
    await applyPendingMigrations(`postgres://test:test@localhost:${port}/postgres`);
    await insertTestCompany(db, { id: companyId, name: "Universe Intake", issuePrefix: `UI${Math.floor(Math.random() * 9000 + 1000)}` });
    await db.insert(internalAgentConversations).values({ id: conversationId, companyId, userId });
    storage = memoryStorage();
    service = universeIntakeService(db, storage);
  }, 180_000);

  afterAll(async () => { await pg?.stop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

  it("resolves a repeated begin key and rejects changed content", async () => {
    const request = input();
    const first = await service.begin(scope, request);
    const second = await service.begin(scope, request);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshot.intakeId).toBe(first.snapshot.intakeId);
    await expect(service.begin(scope, { ...request, filename: "changed.txt" })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects replacement bytes for an already reserved part", async () => {
    const { snapshot } = await service.begin(scope, input());
    await service.putPart(scope, snapshot.intakeId, 0, body, digest(body));
    const changed = Buffer.from("different bytes\n");
    await expect(service.putPart(scope, snapshot.intakeId, 0, changed, digest(changed))).rejects.toMatchObject({ status: 422 });
  });

  it("publishes once and returns the same asset after a lost response", async () => {
    const { snapshot } = await service.begin(scope, input());
    await service.putPart(scope, snapshot.intakeId, 0, body, digest(body));
    const first = await service.finalize(scope, snapshot.intakeId);
    const second = await service.finalize(scope, snapshot.intakeId);
    expect(second.assetId).toBe(first.assetId);
    expect(await db.select().from(assets).where(eq(assets.id, first.assetId!))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.action, "asset.created"), eq(activityLog.entityId, first.assetId!)))).toHaveLength(1);
    await expect(assertUniverseAssetAccess(db, first.assetId!, { type: "board", userId: "another-user" })).rejects.toMatchObject({ status: 404 });
    await expect(assertUniverseAssetAccess(db, first.assetId!, { type: "board", userId })).resolves.toBeUndefined();
  });

  it("keeps ownership and destination authorization live", async () => {
    const { snapshot } = await service.begin(scope, input());
    await expect(service.get({ companyId, actorKey: "another-user" }, snapshot.intakeId)).rejects.toMatchObject({ status: 404 });
    await db.update(internalAgentConversations).set({ userId: "another-user" }).where(eq(internalAgentConversations.id, conversationId));
    await service.putPart(scope, snapshot.intakeId, 0, body, digest(body));
    await expect(service.finalize(scope, snapshot.intakeId)).rejects.toMatchObject({ status: 404 });
    await db.update(internalAgentConversations).set({ userId }).where(eq(internalAgentConversations.id, conversationId));
  });

  it("cancellation prevents publication and expiry removes unpublished objects", async () => {
    const { snapshot } = await service.begin(scope, input());
    await service.putPart(scope, snapshot.intakeId, 0, body, digest(body));
    const objectsBeforeExpiry = storage.objects.size;
    await service.cancel(scope, snapshot.intakeId);
    await expect(service.finalize(scope, snapshot.intakeId)).rejects.toMatchObject({ status: 409 });
    await db.update(universeIntakes).set({ expiresAt: new Date(0) }).where(eq(universeIntakes.id, snapshot.intakeId));
    expect(await service.reconcileExpired()).toBe(1);
    expect((await service.get(scope, snapshot.intakeId)).state).toBe("expired");
    expect(storage.objects.size).toBe(objectsBeforeExpiry - 1);
  });
});
