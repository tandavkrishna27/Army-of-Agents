import { z } from "zod";

const uuid = z.string().uuid();

export const universeReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), id: uuid }).strict(),
  z.object({ kind: z.literal("artifact"), id: uuid, versionId: uuid.optional() }).strict(),
  z.object({ kind: z.literal("message"), id: uuid }).strict(),
]);

export const universeViewportSchema = z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().positive().max(16),
}).strict();

export const universeContextSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: uuid,
  selected: universeReferenceSchema.nullable(),
  visible: z.array(universeReferenceSchema).max(20),
  viewport: universeViewportSchema,
}).strict().refine(
  (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 16 * 1024,
  { message: "Universe context exceeds 16 KiB" },
);

export type UniverseContextInput = z.input<typeof universeContextSchema>;
