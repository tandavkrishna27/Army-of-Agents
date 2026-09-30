import type { Db } from "@armyofagents/db";
import { companyMemberships, companyUserCapabilityDocuments } from "@armyofagents/db";
import {
  STANDARD_HUMAN_CAPABILITY_DOCUMENTS,
  type CreateHumanCapabilityDocument,
  type HumanCapabilityBundle,
  type HumanCapabilityDocumentDetail,
  type HumanCapabilityDocumentKind,
  type UpdateHumanCapabilityDocument,
} from "@armyofagents/shared";
import { and, asc, eq } from "drizzle-orm";
import { conflict, notFound } from "../errors.js";

function slugFromFilename(filename: string): string {
  return filename.replace(/\.md$/i, "");
}

function toCapabilityDocument(row: typeof companyUserCapabilityDocuments.$inferSelect): HumanCapabilityDocumentDetail {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    slug: row.slug,
    filename: row.filename,
    title: row.title,
    kind: row.kind as HumanCapabilityDocumentKind,
    content: row.content,
    sortOrder: row.sortOrder,
    isStandard: row.isStandard,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
  };
}

export function humanCapabilitiesService(db: Db) {
  async function assertActiveMember(companyId: string, userId: string) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) throw notFound("Team member not found");
    return membership;
  }

  async function ensureStandardDocuments(
    companyId: string,
    userId: string,
    actorUserId: string | null = null,
  ) {
    const existing = await db
      .select({ slug: companyUserCapabilityDocuments.slug })
      .from(companyUserCapabilityDocuments)
      .where(
        and(
          eq(companyUserCapabilityDocuments.companyId, companyId),
          eq(companyUserCapabilityDocuments.userId, userId),
        ),
      );
    const existingSlugs = new Set(existing.map((row) => row.slug));
    const missing = STANDARD_HUMAN_CAPABILITY_DOCUMENTS
      .filter((doc) => !existingSlugs.has(doc.slug))
      .map((doc) => ({
        companyId,
        userId,
        slug: doc.slug,
        filename: doc.filename,
        title: doc.title,
        kind: doc.kind,
        content: doc.content,
        sortOrder: doc.sortOrder,
        isStandard: true,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      }));
    if (missing.length === 0) return;
    await db
      .insert(companyUserCapabilityDocuments)
      .values(missing)
      .onConflictDoNothing();
  }

  async function listDocuments(
    companyId: string,
    userId: string,
    actorUserId: string | null = null,
  ): Promise<HumanCapabilityBundle> {
    await assertActiveMember(companyId, userId);
    await ensureStandardDocuments(companyId, userId, actorUserId);
    const rows = await db
      .select()
      .from(companyUserCapabilityDocuments)
      .where(
        and(
          eq(companyUserCapabilityDocuments.companyId, companyId),
          eq(companyUserCapabilityDocuments.userId, userId),
        ),
      )
      .orderBy(asc(companyUserCapabilityDocuments.sortOrder), asc(companyUserCapabilityDocuments.filename));
    return {
      companyId,
      userId,
      documents: rows.map(toCapabilityDocument),
    };
  }

  async function getDocument(companyId: string, userId: string, documentId: string) {
    await assertActiveMember(companyId, userId);
    await ensureStandardDocuments(companyId, userId);
    const row = await db
      .select()
      .from(companyUserCapabilityDocuments)
      .where(
        and(
          eq(companyUserCapabilityDocuments.companyId, companyId),
          eq(companyUserCapabilityDocuments.userId, userId),
          eq(companyUserCapabilityDocuments.id, documentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Capability document not found");
    return toCapabilityDocument(row);
  }

  async function createDocument(
    companyId: string,
    userId: string,
    input: CreateHumanCapabilityDocument,
    actorUserId: string | null,
  ) {
    await assertActiveMember(companyId, userId);
    await ensureStandardDocuments(companyId, userId, actorUserId);
    const slug = slugFromFilename(input.filename);
    const now = new Date();
    const row = await db
      .insert(companyUserCapabilityDocuments)
      .values({
        companyId,
        userId,
        slug,
        filename: input.filename,
        title: input.title,
        kind: "custom",
        content: input.content ?? "",
        sortOrder: 1000,
        isStandard: false,
        createdAt: now,
        updatedAt: now,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      })
      .returning()
      .then((rows) => rows[0] ?? null)
      .catch((err) => {
        throw conflict("Capability document already exists", err);
      });
    if (!row) throw conflict("Unable to create capability document");
    return toCapabilityDocument(row);
  }

  async function updateDocument(
    companyId: string,
    userId: string,
    documentId: string,
    input: UpdateHumanCapabilityDocument,
    actorUserId: string | null,
  ) {
    await assertActiveMember(companyId, userId);
    const patch: Partial<typeof companyUserCapabilityDocuments.$inferInsert> = {
      updatedAt: new Date(),
      updatedByUserId: actorUserId,
    };
    if (input.title !== undefined) patch.title = input.title;
    if (input.content !== undefined) patch.content = input.content;
    const row = await db
      .update(companyUserCapabilityDocuments)
      .set(patch)
      .where(
        and(
          eq(companyUserCapabilityDocuments.companyId, companyId),
          eq(companyUserCapabilityDocuments.userId, userId),
          eq(companyUserCapabilityDocuments.id, documentId),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Capability document not found");
    return toCapabilityDocument(row);
  }

  async function deleteDocument(companyId: string, userId: string, documentId: string) {
    await assertActiveMember(companyId, userId);
    const existing = await db
      .select()
      .from(companyUserCapabilityDocuments)
      .where(
        and(
          eq(companyUserCapabilityDocuments.companyId, companyId),
          eq(companyUserCapabilityDocuments.userId, userId),
          eq(companyUserCapabilityDocuments.id, documentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Capability document not found");
    if (existing.isStandard) {
      throw conflict("Standard capability documents cannot be deleted");
    }
    await db
      .delete(companyUserCapabilityDocuments)
      .where(
        and(
          eq(companyUserCapabilityDocuments.companyId, companyId),
          eq(companyUserCapabilityDocuments.userId, userId),
          eq(companyUserCapabilityDocuments.id, documentId),
        ),
      );
    return { ok: true as const };
  }

  return {
    ensureStandardDocuments,
    listDocuments,
    getDocument,
    createDocument,
    updateDocument,
    deleteDocument,
  };
}
