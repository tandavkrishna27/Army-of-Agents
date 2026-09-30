import { z } from "zod";
import {
  AGENT_COMPLETION_POLICIES,
  ISSUE_PRIORITIES,
  ISSUE_SOURCES,
  ISSUE_STATUSES,
  ISSUE_WORK_MODES,
} from "../constants.js";

export const issueAssigneeAdapterOverridesSchema = z
  .object({
    adapterConfig: z.record(z.unknown()).optional(),
    useProjectWorkspace: z.boolean().optional(),
  })
  .strict();

function hasIssueWorkspaceCommandKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasIssueWorkspaceCommandKey);
  const record = value as Record<string, unknown>;
  for (const key of ["command", "provisionCommand", "teardownCommand", "cleanupCommand"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return true;
  }
  return Object.values(record).some(hasIssueWorkspaceCommandKey);
}

const issueExecutionWorkspaceSettingsSchema = z
  .object({
    mode: z
      .enum([
        "inherit",
        "shared_workspace",
        "isolated_workspace",
        "operator_branch",
        "reuse_existing",
        "agent_default",
      ])
      .optional(),
    reuseWorkspaceId: z.string().uuid().nullable().optional(),
    workspaceStrategy: z
      .object({
        type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]),
        baseRef: z.string().nullable().optional(),
        branchTemplate: z.string().nullable().optional(),
        worktreeParentDir: z.string().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
    workspaceRuntime: z.record(z.unknown()).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (hasIssueWorkspaceCommandKey(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Issue workspace settings cannot include command fields.",
      });
    }
  });

export const issueContextBundleItemSchema = z.object({
  type: z.enum([
    "comment",
    "attachment",
    "artifact",
    "memory",
    "text",
    "discussion_entry",
    "asset",
    "url",
    "scope_item",
  ]),
  id: z.string().uuid().optional().nullable(),
  label: z.string().trim().max(240).optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
});

export const issueContextBundleSchema = z.object({
  sourceIssueId: z.string().uuid().optional().nullable(),
  sourceDiscussionId: z.string().uuid().optional().nullable(),
  sourceScopeVersionId: z.string().uuid().optional().nullable(),
  sourceScopeItemId: z.string().uuid().optional().nullable(),
  sourceKind: z.enum(["issue", "discussion_scope"]).optional().default("issue"),
  brief: z.string().trim().max(4000).optional().nullable(),
  items: z.array(issueContextBundleItemSchema).max(20).optional().default([]),
}).refine((value) => Boolean(value.sourceIssueId || value.sourceDiscussionId), {
  message: "contextBundle requires sourceIssueId or sourceDiscussionId",
});

export const createIssueSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  sourceDiscussionId: z.string().uuid().optional().nullable(),
  inheritExecutionWorkspaceFromIssueId: z.string().uuid().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(ISSUE_STATUSES).optional().default("backlog"),
  priority: z.enum(ISSUE_PRIORITIES).optional().default("medium"),
  workMode: z.enum(ISSUE_WORK_MODES).optional().default("standard"),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().optional().nullable(),
  responsibleUserId: z.string().optional().nullable(),
  requestDepth: z.number().int().nonnegative().optional().default(0),
  billingCode: z.string().optional().nullable(),
  assigneeAdapterOverrides: issueAssigneeAdapterOverridesSchema.optional().nullable(),
  source: z.enum(ISSUE_SOURCES).optional().nullable(),
  reviewerUserId: z.string().optional().nullable(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(50).optional().default([]),
  agentCompletionPolicyOverride: z.enum(AGENT_COMPLETION_POLICIES).optional().nullable(),
  dueDate: z.string().datetime().optional().nullable(),
  labelIds: z.array(z.string().uuid()).optional(),
  executionEnvironmentId: z.string().uuid().optional().nullable(),
  executionWorkspaceId: z.string().uuid().nullable().optional(),
  executionWorkspacePreference: z.string().nullable().optional(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.nullable().optional(),
  contextBundle: issueContextBundleSchema.optional(),
});

export type CreateIssue = z.infer<typeof createIssueSchema>;

export const createIssueLabelSchema = z.object({
  name: z.string().trim().min(1).max(48),
  color: z.string().regex(/^#(?:[0-9a-fA-F]{6})$/, "Color must be a 6-digit hex value"),
});

export type CreateIssueLabel = z.infer<typeof createIssueLabelSchema>;

export const issueMonitorPolicySchema = z.object({
  kind: z.string().trim().min(1).default("generic"),
  nextCheckAt: z.string().datetime(),
  scheduledBy: z.enum(["board", "assignee"]).default("board"),
  notes: z.string().max(4000).optional().nullable(),
  maxAttempts: z.number().int().positive().optional().nullable(),
  timeoutAt: z.string().datetime().optional().nullable(),
  externalRef: z.string().max(1000).optional().nullable(),
  recoveryPolicy: z.record(z.unknown()).optional().nullable(),
});

export type IssueMonitorPolicyInput = z.infer<typeof issueMonitorPolicySchema>;

export const updateIssueSchema = createIssueSchema.partial().extend({
  comment: z.string().min(1).optional(),
  // Idempotency key for the combined comment+reassign PATCH path (round-10 #2):
  // the comment insert carries it so a retry replays the comment (server dedup)
  // rather than duplicating it. Stripped from the issue-field update server-side.
  clientSubmissionId: z.string().trim().min(1).max(200).optional(),
  hiddenAt: z.string().datetime().nullable().optional(),
  executionWorkspaceId: z.string().uuid().nullable().optional(),
  executionWorkspacePreference: z.string().nullable().optional(),
  executionWorkspaceSettings: issueExecutionWorkspaceSettingsSchema.nullable().optional(),
  monitorPolicy: issueMonitorPolicySchema.nullable().optional(),
});

export type UpdateIssue = z.infer<typeof updateIssueSchema>;

export const checkoutIssueSchema = z.object({
  agentId: z.string().uuid(),
  expectedStatuses: z.array(z.enum(ISSUE_STATUSES)).nonempty(),
});

export type CheckoutIssue = z.infer<typeof checkoutIssueSchema>;

export const addIssueCommentSchema = z.object({
  body: z.string().min(1),
  reopen: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  // Client-generated idempotency key. A retried Send (same key) replays the
  // original comment instead of creating a duplicate or re-firing side-effects.
  clientSubmissionId: z.string().trim().min(1).max(200).optional(),
  authorType: z.enum(["user", "agent", "system"]).optional(),
  presentation: z
    .object({
      kind: z.enum(["plain", "system_notice"]),
      tone: z.enum(["info", "success", "warning", "danger"]).optional(),
      title: z.string().optional(),
      detailsDefaultOpen: z.boolean().optional(),
    })
    .optional()
    .nullable(),
  metadata: z
    .object({
      version: z.literal(1),
      sections: z.array(
        z.object({
          title: z.string(),
          rows: z.array(z.record(z.unknown())),
        }),
      ),
    })
    .optional()
    .nullable(),
});

export type AddIssueComment = z.infer<typeof addIssueCommentSchema>;

export const linkIssueApprovalSchema = z.object({
  approvalId: z.string().uuid(),
});

export type LinkIssueApproval = z.infer<typeof linkIssueApprovalSchema>;

export const createIssueAttachmentMetadataSchema = z.object({
  issueCommentId: z.string().uuid().optional().nullable(),
});

export type CreateIssueAttachmentMetadata = z.infer<typeof createIssueAttachmentMetadataSchema>;

export const ISSUE_DOCUMENT_FORMATS = ["markdown"] as const;
export const issueDocumentFormatSchema = z.enum(ISSUE_DOCUMENT_FORMATS);

export const issueDocumentKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Document key must be lowercase letters, numbers, _ or -");

export const upsertIssueDocumentSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  format: issueDocumentFormatSchema,
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

export type UpsertIssueDocument = z.infer<typeof upsertIssueDocumentSchema>;
