import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryAssets } from "@armyofagents/db";
import { normalizeMemoryFolderPath } from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

const log = logger.child({ service: "memory-assets" });

interface CreateInput {
  companyId: string;
  departmentId: string | null;
  folderPath: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageKey: string;
  importJobId?: string | null;
  metadata?: Record<string, unknown> | null;
  uploadedByUserId?: string | null;
}

interface UpdateInput {
  fileName?: string;
  folderPath?: string;
  metadata?: Record<string, unknown> | null;
}

interface ListInput {
  companyId: string;
  departmentId?: string | null;
  folderPath?: string;
  mimeType?: string;
}

export function memoryAssetsService(db: Db) {
  return {
    list: async ({ companyId, departmentId, folderPath, mimeType }: ListInput) => {
      const conditions = [eq(memoryAssets.companyId, companyId)];
      if (departmentId !== undefined && departmentId !== null) {
        conditions.push(eq(memoryAssets.departmentId, departmentId));
      }
      if (folderPath !== undefined) {
        conditions.push(eq(memoryAssets.folderPath, normalizeMemoryFolderPath(folderPath)));
      }
      if (mimeType !== undefined) {
        conditions.push(eq(memoryAssets.mimeType, mimeType));
      }
      return db.select().from(memoryAssets).where(and(...conditions));
    },

    get: async (id: string, companyId: string) => {
      const rows = await db
        .select()
        .from(memoryAssets)
        .where(and(eq(memoryAssets.id, id), eq(memoryAssets.companyId, companyId)));
      return rows[0] ?? null;
    },

    create: async (input: CreateInput) => {
      const [row] = await db
        .insert(memoryAssets)
        .values({
          companyId: input.companyId,
          departmentId: input.departmentId,
          folderPath: normalizeMemoryFolderPath(input.folderPath),
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileSize: input.fileSize,
          storageKey: input.storageKey,
          importJobId: input.importJobId ?? null,
          metadata: input.metadata ?? null,
          uploadedByUserId: input.uploadedByUserId ?? null,
          extractedItemCount: 0,
        })
        .returning();
      publishLiveEvent({
        type: "memory.asset.created",
        companyId: input.companyId,
        payload: { asset: row },
      });
      return row;
    },

    update: async (id: string, companyId: string, patch: UpdateInput) => {
      const next: Record<string, unknown> = { updatedAt: new Date() };
      if (patch.fileName !== undefined) next.fileName = patch.fileName;
      if (patch.folderPath !== undefined) next.folderPath = normalizeMemoryFolderPath(patch.folderPath);
      if (patch.metadata !== undefined) next.metadata = patch.metadata;
      const [row] = await db
        .update(memoryAssets)
        .set(next)
        .where(and(eq(memoryAssets.id, id), eq(memoryAssets.companyId, companyId)))
        .returning();
      if (row) {
        publishLiveEvent({
          type: "memory.asset.updated",
          companyId,
          payload: { asset: row },
        });
      }
      return row ?? null;
    },

    remove: async (id: string, companyId: string): Promise<void> => {
      await db
        .delete(memoryAssets)
        .where(and(eq(memoryAssets.id, id), eq(memoryAssets.companyId, companyId)));
      publishLiveEvent({
        type: "memory.asset.deleted",
        companyId,
        payload: { id },
      });
    },

    incrementExtractedCount: async (id: string, companyId: string, delta: number): Promise<void> => {
      await db
        .update(memoryAssets)
        .set({
          extractedItemCount: sql`${memoryAssets.extractedItemCount} + ${delta}`,
          updatedAt: new Date(),
        })
        .where(and(eq(memoryAssets.id, id), eq(memoryAssets.companyId, companyId)));
    },
  };
}

export type MemoryAssetsService = ReturnType<typeof memoryAssetsService>;
