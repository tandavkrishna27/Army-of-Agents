import { z } from "zod";

export const universeAttentionSourceRefSchema = z.object({
  kind: z.enum(["task", "routine", "approval", "work_question", "runtime_decision", "hub"]),
  id: z.string().min(1).max(200),
}).strict();

export const universeAttentionEntrySchema = z.object({
  id: z.string().min(1).max(240),
  kind: z.enum(["hub", "routine"]),
  sourceId: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  summary: z.string().max(4_000).nullable(),
  version: z.number().int().nonnegative(),
  sourceRef: universeAttentionSourceRefSchema,
  stale: z.literal(false),
}).strict();

export const universeAttentionResponseSchema = z.object({
  asOf: z.string().datetime(),
  needsYou: z.array(universeAttentionEntrySchema).max(50),
  ready: z.array(universeAttentionEntrySchema).max(50),
  comingUp: z.array(universeAttentionEntrySchema).max(50),
  nextCursor: z.string().max(8_000).nullable(),
  checkpoint: z.object({
    revision: z.number().int().nonnegative(),
    lastAcknowledgedAt: z.string().datetime().nullable(),
  }).strict().optional(),
  checkpointToken: z.string().min(1).max(2_000).optional(),
}).strict();

export const universeAttentionCheckpointInputSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  through: z.string().min(1).max(2_000),
}).strict();

export const universeAttentionCheckpointSchema = z.object({
  revision: z.number().int().nonnegative(),
  lastAcknowledgedAt: z.string().datetime().nullable(),
}).strict();

export type UniverseAttentionSourceRef = z.infer<typeof universeAttentionSourceRefSchema>;
export type UniverseAttentionEntry = z.infer<typeof universeAttentionEntrySchema>;
export type UniverseAttentionResponse = z.infer<typeof universeAttentionResponseSchema>;
export type UniverseAttentionCheckpointInput = z.infer<typeof universeAttentionCheckpointInputSchema>;
export type UniverseAttentionCheckpoint = z.infer<typeof universeAttentionCheckpointSchema>;
