import { z } from "zod";
import { normalizeMemoryFolderPath } from "./memory-folder.js";

export const memoryAssetUpdateSchema = z.object({
  fileName: z.string().min(1).max(255).optional(),
  folderPath: z.string().max(512).optional().transform((v) => v === undefined ? undefined : normalizeMemoryFolderPath(v)),
  metadata: z.record(z.unknown()).nullable().optional(),
});

export const memoryAssetMoveSchema = z.object({
  folderPath: z.string().max(512).transform(normalizeMemoryFolderPath),
});
