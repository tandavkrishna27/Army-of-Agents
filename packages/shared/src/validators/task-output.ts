import { z } from "zod";

export const taskOutputTypeSchema = z.enum([
  "artifact",
  "artifact_version",
  "detected_file",
  "preview_url",
  "runtime_service",
  "pull_request",
  "branch",
  "commit",
  "external_link",
]);

export const taskOutputStatusSchema = z.enum([
  "pending",
  "active",
  "running",
  "stopped",
  "merged",
  "closed",
  "failed",
  "dismissed",
]);

export const taskOutputReviewStateSchema = z.enum([
  "none",
  "needs_review",
  "approved",
  "changes_requested",
]);

export const upsertTaskOutputSchema = z.object({
  type: taskOutputTypeSchema,
  provider: z.string().min(1).default("aoa"),
  externalId: z.string().min(1).nullable().optional(),
  artifactId: z.string().uuid().nullable().optional(),
  artifactVersionId: z.string().uuid().nullable().optional(),
  assetId: z.string().uuid().nullable().optional(),
  executionWorkspaceId: z.string().uuid().nullable().optional(),
  runtimeServiceId: z.string().uuid().nullable().optional(),
  url: z.string().url().nullable().optional(),
  title: z.string().min(1),
  status: taskOutputStatusSchema.default("active"),
  reviewState: taskOutputReviewStateSchema.default("none"),
  isPrimary: z.boolean().default(false),
  healthStatus: z.string().min(1).default("unknown"),
  summary: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  createdByRunId: z.string().uuid().nullable().optional(),
  createdByAgentId: z.string().uuid().nullable().optional(),
  createdByUserId: z.string().nullable().optional(),
}).strict();

export const mutableTaskOutputSchema = z.object({
  title: z.string().min(1).optional(),
  status: taskOutputStatusSchema.optional(),
  reviewState: taskOutputReviewStateSchema.optional(),
  isPrimary: z.boolean().optional(),
  healthStatus: z.string().min(1).optional(),
  summary: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
}).strict();

export type UpsertTaskOutput = z.infer<typeof upsertTaskOutputSchema>;
export type MutableTaskOutput = z.infer<typeof mutableTaskOutputSchema>;
