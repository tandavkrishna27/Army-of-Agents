import { z } from "zod";
import { universeAttentionResponseSchema } from "./universe-attention.js";

const instant = z.string().datetime();

export const universeSnapshotReferenceSchema = z.object({
  key: z.string().min(1).max(1024),
  kind: z.enum(["task", "artifact", "browser"]),
  id: z.string().min(1).max(256),
  version: z.string().min(1).max(256).optional(),
  available: z.boolean(),
}).strict();

export const universeSnapshotTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(1024),
  status: z.string().max(100),
  updatedAt: instant,
}).strict();

export const universeSnapshotOutputSchema = z.object({
  id: z.string().min(1),
  issueId: z.string().min(1),
  type: z.string().max(100),
  title: z.string().max(1024),
  status: z.string().max(100),
  artifactId: z.string().nullable(),
  artifactVersionId: z.string().nullable(),
  updatedAt: instant,
}).strict();

/** Canonical, owner-scoped refresh payload. It deliberately contains only
 * presentation projections; messages, credentials and content bodies stay in
 * their existing authorized APIs. */
export const universeReconciliationSnapshotSchema = z.object({
  conversationId: z.string().min(1),
  currentSeq: z.number().int().safe().nonnegative(),
  layoutRevision: z.number().int().safe().nonnegative(),
  observedAt: instant,
  references: z.array(universeSnapshotReferenceSchema).max(100),
  tasks: z.array(universeSnapshotTaskSchema).max(100),
  outputs: z.array(universeSnapshotOutputSchema).max(500),
  attention: universeAttentionResponseSchema.nullable(),
  partialReasons: z.array(z.string().min(1).max(200)).max(20),
}).strict();

export type UniverseReconciliationSnapshot = z.infer<typeof universeReconciliationSnapshotSchema>;
