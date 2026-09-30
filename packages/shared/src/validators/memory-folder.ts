import { z } from "zod";

const FOLDER_SEGMENT_RE = /^[a-zA-Z0-9 _-][a-zA-Z0-9 _.-]*$/;
const MAX_PATH_LENGTH = 512;
const MAX_SEGMENTS = 8;

export function normalizeMemoryFolderPath(raw: string): string {
  return raw
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join("/");
}

const memoryFolderPathSchema = z
  .string()
  .min(1, "path cannot be empty")
  .max(MAX_PATH_LENGTH)
  .refine((p) => !p.startsWith("/"), { message: "path cannot start with /" })
  .refine((p) => !p.includes("//"), { message: "path cannot contain empty segments" })
  .refine(
    (p) => p.split("/").every((s) => s !== "." && s !== ".."),
    { message: "path cannot contain . or .. segments" },
  )
  .refine(
    (p) => p.split("/").every((s) => FOLDER_SEGMENT_RE.test(s)),
    { message: "path segments must be alphanumeric with spaces, underscores, dashes, dots" },
  )
  .refine(
    (p) => p.split("/").length <= MAX_SEGMENTS,
    { message: `path cannot exceed ${MAX_SEGMENTS} segments` },
  );

export const memoryFolderCreateSchema = z.object({
  departmentId: z.string().uuid().nullable(),
  path: memoryFolderPathSchema,
  displayName: z.string().min(1).max(120),
  icon: z.string().max(8).nullable().optional(),
});

export const memoryFolderUpdateSchema = z.object({
  path: memoryFolderPathSchema.optional(),
  displayName: z.string().min(1).max(120).optional(),
  icon: z.string().max(8).nullable().optional(),
  sortOrder: z.number().int().nonnegative().optional(),
});
