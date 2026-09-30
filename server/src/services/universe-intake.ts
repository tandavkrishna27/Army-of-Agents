import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, or } from "drizzle-orm";
import {
  assets,
  companies,
  discussions,
  internalAgentConversations,
  threadParticipants,
  universeIntakeParts,
  universeIntakes,
  type Db,
} from "@armyofagents/db";
import {
  beginUniverseIntakeSchema,
  universeIntakeSnapshotSchema,
  type BeginUniverseIntake,
  type UniverseIntakeDestination,
  type UniverseIntakeSnapshot,
} from "@armyofagents/shared";
import type { StorageService } from "../storage/types.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { insertActivityLog, publishActivityLogged, type PersistedActivity } from "./activity-log.js";
import { sniffAndVerifyContentType } from "./asset-content-guard.js";

const PART_BYTES = 4 * 1024 * 1024;
const EXPIRY_MS = 24 * 60 * 60 * 1000;

type Scope = { companyId: string; actorKey: string };

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function payloadHash(input: BeginUniverseIntake): string {
  return sha(JSON.stringify({
    destination: input.destination,
    filename: input.filename,
    contentType: input.contentType,
    byteSize: input.byteSize,
    sha256: input.sha256,
  }));
}

async function streamBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function universeIntakeService(db: Db, storage: StorageService) {
  async function assertDestination(executor: Db, scope: Scope, destination: UniverseIntakeDestination) {
    if (destination.kind === "canvas" || destination.kind === "commander_attachment") {
      const row = await executor.select({ id: internalAgentConversations.id })
        .from(internalAgentConversations)
        .where(and(
          eq(internalAgentConversations.id, destination.conversationId),
          eq(internalAgentConversations.companyId, scope.companyId),
          eq(internalAgentConversations.userId, scope.actorKey),
        )).then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Intake destination not found");
      return;
    }
    const row = await executor.select({
      id: discussions.id,
      visibility: discussions.visibility,
      ownerUserId: discussions.ownerUserId,
    }).from(discussions).where(and(
      eq(discussions.id, destination.discussionId),
      eq(discussions.companyId, scope.companyId),
    )).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Intake destination not found");
    if (row.visibility === "private" && row.ownerUserId !== scope.actorKey) {
      const participant = await executor.select({ id: threadParticipants.id })
        .from(threadParticipants)
        .where(and(
          eq(threadParticipants.threadId, destination.discussionId),
          eq(threadParticipants.companyId, scope.companyId),
          eq(threadParticipants.principalType, "user"),
          eq(threadParticipants.principalId, scope.actorKey),
        )).then((rows) => rows[0] ?? null);
      if (!participant) throw notFound("Intake destination not found");
    }
  }

  async function owned(scope: Scope, intakeId: string, lock = false, executor: Db = db) {
    let query = executor.select().from(universeIntakes).where(and(
      eq(universeIntakes.id, intakeId),
      eq(universeIntakes.companyId, scope.companyId),
      eq(universeIntakes.actorKey, scope.actorKey),
    ));
    if (lock) query = query.for("update") as typeof query;
    const row = await query.then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Universe intake not found");
    return row;
  }

  async function snapshot(scope: Scope, intakeId: string): Promise<UniverseIntakeSnapshot> {
    const row = await owned(scope, intakeId);
    const parts = await db.select({ partIndex: universeIntakeParts.partIndex })
      .from(universeIntakeParts)
      .where(and(eq(universeIntakeParts.intakeId, row.id), eq(universeIntakeParts.state, "stored")))
      .orderBy(asc(universeIntakeParts.partIndex));
    return universeIntakeSnapshotSchema.parse({
      intakeId: row.id,
      revision: row.revision,
      state: row.state,
      receivedParts: parts.map((part) => part.partIndex),
      expiresAt: row.expiresAt.toISOString(),
      assetId: row.assetId,
      reason: row.reason,
    });
  }

  async function begin(scope: Scope, raw: unknown): Promise<{ created: boolean; snapshot: UniverseIntakeSnapshot }> {
    const input = beginUniverseIntakeSchema.parse(raw);
    await assertDestination(db, scope, input.destination);
    const company = await db.select({ organizationId: companies.organizationId }).from(companies)
      .where(eq(companies.id, scope.companyId)).then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");
    const fingerprint = payloadHash(input);
    const inserted = await db.insert(universeIntakes).values({
      organizationId: company.organizationId,
      companyId: scope.companyId,
      actorKey: scope.actorKey,
      clientKey: input.clientKey,
      payloadSha256: fingerprint,
      destination: input.destination,
      filename: input.filename,
      declaredContentType: input.contentType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      expiresAt: new Date(Date.now() + EXPIRY_MS),
    }).onConflictDoNothing().returning({ id: universeIntakes.id });
    const row = inserted[0] ?? await db.select().from(universeIntakes).where(and(
      eq(universeIntakes.companyId, scope.companyId),
      eq(universeIntakes.actorKey, scope.actorKey),
      eq(universeIntakes.clientKey, input.clientKey),
    )).then((rows) => rows[0]);
    if (!row) throw conflict("Could not resolve intake identity");
    const full = "payloadSha256" in row ? row : await owned(scope, row.id);
    if (full.payloadSha256 !== fingerprint) throw conflict("Intake key already has different content");
    return { created: inserted.length > 0, snapshot: await snapshot(scope, full.id) };
  }

  async function putPart(scope: Scope, intakeId: string, partIndex: number, body: Buffer, partSha256: string) {
    if (!Number.isSafeInteger(partIndex) || partIndex < 0) throw unprocessable("Invalid part index");
    if (!body.length || body.length > PART_BYTES || sha(body) !== partSha256) throw unprocessable("Part length or hash mismatch");
    const row = await owned(scope, intakeId);
    if (row.state !== "receiving") throw conflict("Intake is not receiving parts");
    const partCount = Math.ceil(row.byteSize / PART_BYTES);
    if (partIndex >= partCount) throw unprocessable("Part index exceeds declared file size");
    const expectedBytes = partIndex === partCount - 1 ? row.byteSize - PART_BYTES * partIndex : PART_BYTES;
    if (body.length !== expectedBytes) throw unprocessable("Part length does not match declared file size");
    const prefix = `${row.organizationId}/${row.companyId}/universe-intakes/${row.id}`;
    const objectKey = `${prefix}/parts/${partIndex}`;
    await db.insert(universeIntakeParts).values({
      intakeId: row.id, organizationId: row.organizationId, companyId: row.companyId,
      partIndex, objectKey, byteSize: body.length, sha256: partSha256,
    }).onConflictDoNothing();
    const reserved = await db.select().from(universeIntakeParts).where(and(
      eq(universeIntakeParts.intakeId, row.id), eq(universeIntakeParts.partIndex, partIndex),
    )).then((rows) => rows[0] ?? null);
    if (!reserved || reserved.sha256 !== partSha256 || reserved.byteSize !== body.length) throw conflict("Part already reserved with different bytes");
    await storage.putReservedObject({ organizationId: row.organizationId, companyId: row.companyId, objectKey, body, contentType: "application/octet-stream", sha256: partSha256 });
    await db.update(universeIntakeParts).set({ state: "stored", updatedAt: new Date() }).where(and(
      eq(universeIntakeParts.intakeId, row.id), eq(universeIntakeParts.partIndex, partIndex),
    ));
    return snapshot(scope, row.id);
  }

  async function finalize(scope: Scope, intakeId: string): Promise<UniverseIntakeSnapshot> {
    const initial = await owned(scope, intakeId);
    if (initial.state === "published") return snapshot(scope, intakeId);
    if (initial.state !== "receiving" && initial.state !== "validating") throw conflict("Intake cannot be finalized");
    await assertDestination(db, scope, initial.destination);
    const parts = await db.select().from(universeIntakeParts).where(and(
      eq(universeIntakeParts.intakeId, initial.id), eq(universeIntakeParts.state, "stored"),
    )).orderBy(asc(universeIntakeParts.partIndex));
    const expectedCount = Math.ceil(initial.byteSize / PART_BYTES);
    if (parts.length !== expectedCount || parts.some((part, index) => part.partIndex !== index)) throw conflict("Intake parts are incomplete");
    await db.update(universeIntakes).set({ state: "validating", revision: initial.revision + 1, updatedAt: new Date() }).where(and(
      eq(universeIntakes.id, initial.id), eq(universeIntakes.state, "receiving"),
    ));
    const chunks: Buffer[] = [];
    for (const part of parts) chunks.push(await streamBuffer((await storage.getObject(initial.organizationId, initial.companyId, part.objectKey)).stream));
    const body = Buffer.concat(chunks);
    if (body.length !== initial.byteSize || sha(body) !== initial.sha256) {
      await db.update(universeIntakes).set({ state: "rejected", reason: "hash_mismatch", updatedAt: new Date() }).where(eq(universeIntakes.id, initial.id));
      throw unprocessable("Final object hash mismatch");
    }
    try {
      sniffAndVerifyContentType(body, initial.declaredContentType);
    } catch (error) {
      await db.update(universeIntakes).set({ state: "rejected", reason: "type_mismatch", updatedAt: new Date() }).where(eq(universeIntakes.id, initial.id));
      throw error;
    }
    const finalObjectKey = `${initial.organizationId}/${initial.companyId}/universe-intakes/${initial.id}/original`;
    await db.update(universeIntakes).set({
      state: "publishing",
      finalObjectKey,
      finalByteSize: body.length,
      finalSha256: initial.sha256,
      updatedAt: new Date(),
    }).where(eq(universeIntakes.id, initial.id));
    await storage.putReservedObject({ organizationId: initial.organizationId, companyId: initial.companyId, objectKey: finalObjectKey, body, contentType: initial.declaredContentType, sha256: initial.sha256 });
    const storedFinal = await streamBuffer((await storage.getObject(initial.organizationId, initial.companyId, finalObjectKey)).stream);
    if (storedFinal.length !== body.length || sha(storedFinal) !== initial.sha256) {
      throw unprocessable("Stored final object could not be verified");
    }

    let activity: PersistedActivity | null = null;
    await db.transaction(async (tx) => {
      const current = await owned(scope, initial.id, true, tx as unknown as Db);
      if (current.state === "published") return;
      if (current.state !== "publishing") throw conflict("Intake publication was cancelled");
      await assertDestination(tx as unknown as Db, scope, current.destination);
      const [asset] = await tx.insert(assets).values({
        companyId: current.companyId,
        provider: storage.provider,
        objectKey: finalObjectKey,
        contentType: current.declaredContentType,
        byteSize: current.byteSize,
        sha256: current.sha256,
        originalFilename: current.filename,
        createdByUserId: scope.actorKey,
        uploadNamespace: "universe-intake",
        composerValidated: false,
      }).returning();
      if (!asset) throw new Error("Asset insert failed");
      await tx.update(universeIntakes).set({ state: "published", assetId: asset.id, revision: current.revision + 1, updatedAt: new Date() }).where(eq(universeIntakes.id, current.id));
      activity = await insertActivityLog(tx as unknown as Db, {
        companyId: current.companyId, actorType: "user", actorId: scope.actorKey,
        action: "asset.created", entityType: "asset", entityId: asset.id,
        details: { originalFilename: current.filename, contentType: current.declaredContentType, byteSize: current.byteSize, source: "universe_intake" },
      });
    });
    if (activity) publishActivityLogged(activity);
    return snapshot(scope, initial.id);
  }

  async function cancel(scope: Scope, intakeId: string) {
    const row = await owned(scope, intakeId);
    if (row.state === "published" || row.state === "cancelled") return snapshot(scope, intakeId);
    await db.update(universeIntakes).set({ state: "cancelled", revision: row.revision + 1, updatedAt: new Date() }).where(and(
      eq(universeIntakes.id, row.id), eq(universeIntakes.companyId, scope.companyId), eq(universeIntakes.actorKey, scope.actorKey),
    ));
    return snapshot(scope, intakeId);
  }

  async function reconcileExpired(now = new Date()): Promise<number> {
    const expired = await db.select().from(universeIntakes).where(and(
      lt(universeIntakes.expiresAt, now),
      inArray(universeIntakes.state, ["receiving", "validating", "publishing", "cancelled", "rejected"]),
    ));
    let reconciled = 0;
    for (const row of expired) {
      const changed = await db.update(universeIntakes).set({
        state: "expired",
        revision: row.revision + 1,
        updatedAt: now,
      }).where(and(
        eq(universeIntakes.id, row.id),
        or(
          eq(universeIntakes.state, "receiving"),
          eq(universeIntakes.state, "validating"),
          eq(universeIntakes.state, "publishing"),
          eq(universeIntakes.state, "cancelled"),
          eq(universeIntakes.state, "rejected"),
        ),
      )).returning({ id: universeIntakes.id });
      if (!changed.length) continue;
      const parts = await db.select({ objectKey: universeIntakeParts.objectKey })
        .from(universeIntakeParts).where(eq(universeIntakeParts.intakeId, row.id));
      for (const part of parts) {
        await storage.deleteObject(row.organizationId, row.companyId, part.objectKey).catch(() => undefined);
      }
      if (row.finalObjectKey && !row.assetId) {
        await storage.deleteObject(row.organizationId, row.companyId, row.finalObjectKey).catch(() => undefined);
      }
      reconciled += 1;
    }
    return reconciled;
  }

  return { begin, get: snapshot, putPart, finalize, cancel, reconcileExpired };
}
