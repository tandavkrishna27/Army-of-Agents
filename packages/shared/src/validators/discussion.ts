import { z } from "zod";
import {
  DISCUSSION_STATUSES,
  DISCUSSION_SCOPE_TYPES,
  DISCUSSION_ENTRY_INPUT_TYPES,
  EXTRACTION_ITEM_TYPES,
  MEMORY_ITEM_LAYERS,
  BRIEF_DEDUP_ACTIONS,
  THREAD_VISIBILITIES,
  COMPOSER_MAX_ATTACHMENTS,
} from "../constants.js";

export const createDiscussionEntrySchema = z.object({
  inputType: z.enum(DISCUSSION_ENTRY_INPUT_TYPES),
  rawContent: z.string(),
  title: z.string().optional().nullable(),
  departmentId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  sourceInfo: z.record(z.unknown()).optional().nullable(),
  parentEntryId: z.string().uuid().optional().nullable(),
  authorAgentId: z.string().uuid().optional().nullable(),
  // Client-generated idempotency key. A retried Send (same key) replays the
  // original entry instead of creating a duplicate or re-firing side-effects.
  clientSubmissionId: z.string().trim().min(1).max(200).optional().nullable(),
  // Phase E1: composer can attach assets (file uploads) and artifacts
  // (e.g. an existing plan or document) when posting an entry. Server links
  // each via discussion_entry_attachments after the entry is inserted.
  attachments: z
    .array(
      z
        .object({
          assetId: z.string().uuid().optional().nullable(),
          artifactId: z.string().uuid().optional().nullable(),
        })
        // {} / { assetId: null, artifactId: null } would be silently dropped
        // by the server before insert — and would let a blank entry slip
        // through the attachment-only exemption below (PR #291 review).
        .refine((a) => Boolean(a.assetId || a.artifactId), {
          message: "Attachment must reference an assetId or artifactId",
        }),
    )
    // Enforce the shared composer cap server-side (PR #291 round-6 review): a
    // direct API caller must not attach more than the UI/composer limit.
    .max(COMPOSER_MAX_ATTACHMENTS)
    .optional(),
}).superRefine((entry, ctx) => {
  // Belt-and-braces: count only attachments carrying a real reference, so the
  // blank-entry guard cannot be bypassed even if the item schema loosens.
  const realAttachments =
    entry.attachments?.filter((a) => a.assetId || a.artifactId).length ?? 0;
  if (entry.rawContent.trim().length === 0 && realAttachments === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["rawContent"],
      message: "rawContent is required unless the entry includes an attachment",
    });
  }
});

export type CreateDiscussionEntry = z.infer<typeof createDiscussionEntrySchema>;

export const createDiscussionSchema = z.object({
  title: z.string().optional().nullable(),
  scopeType: z.enum(DISCUSSION_SCOPE_TYPES).optional().nullable(),
  scopeId: z.string().uuid().optional().nullable(),
  tags: z.array(z.string()).optional(),
  entry: createDiscussionEntrySchema.optional(),
});

export type CreateDiscussion = z.infer<typeof createDiscussionSchema>;

export const updateDiscussionSchema = z.object({
  title: z.string().optional().nullable(),
  status: z.enum(DISCUSSION_STATUSES).optional(),
  tags: z.array(z.string()).optional(),
  autonomyLevel: z.number().int().min(0).max(2).nullable().optional(),
  // Phase 1 Phase E batch 2 (T22): OriginCard's 3-option visibility selector
  // patches via this endpoint. The service `update()` already passes the
  // field through to the discussions UPDATE.
  visibility: z.enum(THREAD_VISIBILITIES).optional(),
  // Phase G3 (T5, D6): per-thread Memory Keeper opt-out. When false,
  // memory.propose tool refuses with MEMORY_EXTRACTION_DISABLED for entries
  // in this thread. UI toggle lives in OriginCard advanced settings.
  allowMemoryExtraction: z.boolean().optional(),
});

export type UpdateDiscussion = z.infer<typeof updateDiscussionSchema>;

export const approveItemsSchema = z.object({
  items: z.array(
    z.object({
      itemId: z.string().uuid(),
      action: z.enum(["approved", "rejected", "edited"] as const),
      edits: z
        .object({
          title: z.string().min(1).optional(),
          description: z.string().optional().nullable(),
          type: z.enum(EXTRACTION_ITEM_TYPES).optional(),
          priority: z.string().optional().nullable(),
          assigneeId: z.string().uuid().optional().nullable(),
          departmentId: z.string().uuid().optional().nullable(),
          projectId: z.string().uuid().optional().nullable(),
          goalId: z.string().uuid().optional().nullable(),
          layer: z.enum(MEMORY_ITEM_LAYERS).optional().nullable(),
          dedupAction: z.enum(BRIEF_DEDUP_ACTIONS).optional().nullable(),
          selectedMemoryId: z.string().uuid().optional().nullable(),
          mergedContent: z.string().optional().nullable(),
        })
        .optional(),
    }),
  ),
  dependencies: z
    .array(
      z
        .object({
          dependentItemId: z.string().uuid(),
          dependencyItemId: z.string().uuid(),
        })
        .refine((d) => d.dependentItemId !== d.dependencyItemId, {
          message: "A task cannot depend on itself",
        }),
    )
    .optional(),
});

export type ApproveItems = z.infer<typeof approveItemsSchema>;

export const createAnnotationSchema = z.object({
  content: z.string().min(1),
  anchorStart: z.number().int().nonnegative().optional().nullable(),
  anchorEnd: z.number().int().nonnegative().optional().nullable(),
});

export type CreateAnnotation = z.infer<typeof createAnnotationSchema>;
