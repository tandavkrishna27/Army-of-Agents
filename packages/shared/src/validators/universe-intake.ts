import { z } from "zod";

export const universeIntakeDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("canvas"), conversationId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("commander_attachment"), conversationId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("discussion_attachment"), discussionId: z.string().uuid() }).strict(),
]);

export const beginUniverseIntakeSchema = z.object({
  clientKey: z.string().uuid(),
  destination: universeIntakeDestinationSchema,
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(255).transform((value) => value.toLowerCase()),
  byteSize: z.number().int().positive().max(50 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const universeIntakeSnapshotSchema = z.object({
  intakeId: z.string().uuid(),
  revision: z.number().int().positive(),
  state: z.enum(["receiving", "validating", "publishing", "published", "cancelled", "expired", "rejected"]),
  receivedParts: z.array(z.number().int().nonnegative()),
  expiresAt: z.string().datetime(),
  assetId: z.string().uuid().nullable(),
  reason: z.enum(["type_mismatch", "too_large", "hash_mismatch", "access_revoked"]).nullable(),
}).strict();

export type UniverseIntakeDestination = z.infer<typeof universeIntakeDestinationSchema>;
export type BeginUniverseIntake = z.infer<typeof beginUniverseIntakeSchema>;
export type UniverseIntakeSnapshot = z.infer<typeof universeIntakeSnapshotSchema>;
