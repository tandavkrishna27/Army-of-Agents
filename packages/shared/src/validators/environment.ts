import { z } from "zod";
import {
  ENVIRONMENT_DRIVERS,
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_POLICIES,
  ENVIRONMENT_LEASE_STATUSES,
  ENVIRONMENT_STATUSES,
} from "../constants.js";
import { gvisorEnvironmentConfigSchema } from "./execution-target.js";

export const environmentDriverSchema = z.enum(ENVIRONMENT_DRIVERS);
export const environmentStatusSchema = z.enum(ENVIRONMENT_STATUSES);
export const environmentLeaseStatusSchema = z.enum(ENVIRONMENT_LEASE_STATUSES);
export const environmentLeasePolicySchema = z.enum(ENVIRONMENT_LEASE_POLICIES);
export const environmentLeaseCleanupStatusSchema = z.enum(ENVIRONMENT_LEASE_CLEANUP_STATUSES);

export const e2bEnvironmentConfigSchema = z.object({
  provider: z.literal("e2b"),
  credentialRef: z.literal("default").optional(),
  credentialSecretId: z.string().uuid().optional(),
  template: z.string().min(1).optional().default("base"),
  timeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
  reuseLease: z.boolean().optional(),
}).strict();

export type E2bEnvironmentConfig = z.infer<typeof e2bEnvironmentConfigSchema>;

export const environmentTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local") }),
  z.object({
    type: z.literal("sandbox-docker"),
    image: z.string().min(1),
    workdir: z.string().min(1).optional().nullable(),
    shell: z.enum(["sh", "bash"]).optional().nullable(),
    network: z.enum(["bridge", "host", "none"]).optional().nullable(),
    remove: z.boolean().optional(),
    env: z.record(z.string()).optional(),
    installCommand: z.string().optional().nullable(),
  }),
]);

function rejectInvalidProviderConfig(
  input: { driver?: unknown; config?: unknown },
  ctx: z.RefinementCtx,
) {
  if (input.driver !== "sandbox" || !input.config || typeof input.config !== "object" || Array.isArray(input.config)) {
    return;
  }
  const config = input.config as Record<string, unknown>;
  if (config.provider === "e2b") {
    const parsed = e2bEnvironmentConfigSchema.safeParse(config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["config", ...issue.path],
          message: issue.message,
        });
      }
    }
    return;
  }
  if (config.provider === "gvisor") {
    const parsed = gvisorEnvironmentConfigSchema.safeParse(config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["config", ...issue.path], message: issue.message });
      }
    }
  }
}

export const createEnvironmentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema.optional().default("local"),
  status: environmentStatusSchema.optional().default("active"),
  config: z.record(z.unknown()).optional().default({}),
  metadata: z.record(z.unknown()).optional().nullable(),
  envVars: z.record(z.unknown()).optional().default({}),
  connectionTarget: z.record(z.unknown()).optional().nullable(),
  target: environmentTargetSchema.optional().nullable(),
  executionTargetId: z.string().uuid().optional().nullable(),
}).superRefine(rejectInvalidProviderConfig);

export const updateEnvironmentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional().nullable(),
  driver: environmentDriverSchema.optional(),
  status: environmentStatusSchema.optional(),
  config: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional().nullable(),
  envVars: z.record(z.unknown()).optional(),
  connectionTarget: z.record(z.unknown()).optional().nullable(),
  target: environmentTargetSchema.optional().nullable(),
  executionTargetId: z.string().uuid().optional().nullable(),
}).superRefine(rejectInvalidProviderConfig);

export const probeEnvironmentSchema = z.object({
  driver: environmentDriverSchema,
  config: z.record(z.unknown()).optional().default({}),
}).superRefine(rejectInvalidProviderConfig);

export type CreateEnvironmentInput = z.infer<typeof createEnvironmentSchema>;
export type UpdateEnvironmentInput = z.infer<typeof updateEnvironmentSchema>;
export type ProbeEnvironmentInput = z.infer<typeof probeEnvironmentSchema>;
