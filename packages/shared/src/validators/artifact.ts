import { z } from "zod";
import { ARTIFACT_TYPES, ARTIFACT_STATUSES, ARTIFACT_VERSION_SOURCES, ARTIFACT_STORAGE_KINDS } from "../constants.js";

/** Shared file-metadata fields for asset-backed versions (P1). All optional. */
const fileMetaFields = {
  storageKind: z.enum(ARTIFACT_STORAGE_KINDS).optional(),
  assetId: z.string().uuid().optional().nullable(),
  filename: z.string().optional().nullable(),
  contentType: z.string().optional().nullable(),
  extension: z.string().optional().nullable(),
  byteSize: z.number().int().nonnegative().optional().nullable(),
  sha256: z.string().optional().nullable(),
};

/** storageKind="asset" requires an assetId. */
function requireAssetId<T extends { storageKind?: string | undefined; assetId?: string | null | undefined }>(
  val: T,
  ctx: z.RefinementCtx,
) {
  if (val.storageKind === "asset" && !val.assetId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "assetId is required when storageKind is 'asset'", path: ["assetId"] });
  }
}

export const createArtifactSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional().nullable(),
    type: z.enum(ARTIFACT_TYPES),
    source: z.enum(ARTIFACT_VERSION_SOURCES).optional(),
    sourceDetail: z.string().optional().nullable(),
    changelog: z.string().optional().nullable(),
    content: z.string().optional().nullable(),
    fileUrl: z.string().optional().nullable(),
    ...fileMetaFields,
  })
  .superRefine(requireAssetId);

export type CreateArtifact = z.infer<typeof createArtifactSchema>;

export const updateArtifactSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  type: z.enum(ARTIFACT_TYPES).optional(),
  status: z.enum(ARTIFACT_STATUSES).optional(),
});

export type UpdateArtifact = z.infer<typeof updateArtifactSchema>;

export const createArtifactVersionSchema = z
  .object({
    source: z.enum(ARTIFACT_VERSION_SOURCES),
    sourceDetail: z.string().optional().nullable(),
    changelog: z.string().optional().nullable(),
    parentVersionId: z.string().uuid().optional().nullable(),
    content: z.string().optional().nullable(),
    fileUrl: z.string().optional().nullable(),
    ...fileMetaFields,
  })
  .superRefine(requireAssetId);

export type CreateArtifactVersion = z.infer<typeof createArtifactVersionSchema>;

/** MCP-specific artifact version push — source is always "mcp", sourceDetail required */
/** Raw field shape for the MCP artifact-version payload (exposed so callers that
 * build derived schemas can read fields without reaching through ZodEffects). */
export const mcpArtifactVersionShape = {
  sourceDetail: z.string().min(1, "MCP client identity is required"),
  changelog: z.string().optional().nullable(),
  parentVersionId: z.string().uuid().optional().nullable(),
  content: z.string().optional().nullable(),
  fileUrl: z.string().optional().nullable(),
  ...fileMetaFields,
};

export const mcpArtifactVersionSchema = z.object(mcpArtifactVersionShape).superRefine(requireAssetId);

export type McpArtifactVersion = z.infer<typeof mcpArtifactVersionSchema>;
