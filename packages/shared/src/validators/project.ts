import { z } from "zod";
import { AGENT_COMPLETION_POLICIES, PROJECT_STATUSES, PROJECT_TYPES } from "../constants.js";

/**
 * Strict shape mirroring `ExecutionWorkspaceStrategy` from
 * `packages/shared/src/types/workspace-runtime.ts`. `.strict()` rejects unknown
 * keys so callers can't smuggle additional shell-command-like fields past the
 * route role gate (security finding C1).
 */
const executionWorkspaceStrategySchema = z.object({
  type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]),
  baseRef: z.string().nullable().optional(),
  branchTemplate: z.string().nullable().optional(),
  worktreeParentDir: z.string().nullable().optional(),
  provisionCommand: z.string().nullable().optional(),
  teardownCommand: z.string().nullable().optional(),
}).strict();

/**
 * Strict shape mirroring `ProjectExecutionWorkspacePolicy`. The route handler
 * checks `workspaceStrategy.{provisionCommand,teardownCommand}` for the
 * founder-only gate; this schema constrains the surface so callers cannot pass
 * unknown fields that the runtime would otherwise consume verbatim.
 */
const executionWorkspacePolicySchema = z.object({
  enabled: z.boolean().optional(),
  defaultMode: z.enum([
    "shared_workspace",
    "isolated_workspace",
    "operator_branch",
    "adapter_default",
  ]).optional(),
  allowIssueOverride: z.boolean().optional(),
  defaultProjectWorkspaceId: z.string().nullable().optional(),
  workspaceStrategy: executionWorkspaceStrategySchema.nullable().optional(),
  workspaceRuntime: z.record(z.unknown()).nullable().optional(),
  branchPolicy: z.record(z.unknown()).nullable().optional(),
  pullRequestPolicy: z.record(z.unknown()).nullable().optional(),
  runtimePolicy: z.record(z.unknown()).nullable().optional(),
  cleanupPolicy: z.record(z.unknown()).nullable().optional(),
  ttlDays: z.number().int().positive().nullable().optional(),
}).strict();

const projectWorkspaceFields = {
  name: z.string().min(1).optional(),
  cwd: z.string().min(1).optional().nullable(),
  repoUrl: z.string().url().optional().nullable(),
  repoRef: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
};

function rejectReservedRuntimeMetadata(
  value: { metadata?: Record<string, unknown> | null },
  ctx: z.RefinementCtx,
): void {
  if (value.metadata && Object.prototype.hasOwnProperty.call(value.metadata, "runtimeConfig")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "metadata.runtimeConfig is server-reserved; use workspace runtime controls",
      path: ["metadata", "runtimeConfig"],
    });
  }
}

export const createProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  rejectReservedRuntimeMetadata(value, ctx);
  const hasCwd = typeof value.cwd === "string" && value.cwd.trim().length > 0;
  const hasRepo = typeof value.repoUrl === "string" && value.repoUrl.trim().length > 0;
  if (!hasCwd && !hasRepo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workspace requires at least one of cwd or repoUrl.",
      path: ["cwd"],
    });
  }
});

export type CreateProjectWorkspace = z.infer<typeof createProjectWorkspaceSchema>;

export const updateProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional(),
}).partial().superRefine(rejectReservedRuntimeMetadata);

export type UpdateProjectWorkspace = z.infer<typeof updateProjectWorkspaceSchema>;

const projectFields = {
  type: z.enum(PROJECT_TYPES).optional().default("department"),
  /** @deprecated Use goalIds instead */
  goalId: z.string().uuid().optional().nullable(),
  goalIds: z.array(z.string().uuid()).optional(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(PROJECT_STATUSES).optional().default("backlog"),
  leadAgentId: z.string().uuid().optional().nullable(),
  targetDate: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  functionType: z.string().optional().nullable(),
  archivedAt: z.string().datetime().optional().nullable(),
  executionWorkspacePolicy: executionWorkspacePolicySchema.nullable().optional(),
  agentCompletionPolicyDefault: z.enum(AGENT_COMPLETION_POLICIES).nullable().optional(),
  humanQuestionSlaHours: z.number().int().min(1).max(24 * 30).nullable().optional(),
};

export const createProjectSchema = z.object({
  ...projectFields,
  workspace: createProjectWorkspaceSchema.optional(),
});

export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object(projectFields).partial();

export type UpdateProject = z.infer<typeof updateProjectSchema>;
