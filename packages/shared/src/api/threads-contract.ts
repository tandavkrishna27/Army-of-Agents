import { z } from "zod";

import { DISCUSSION_ENTRY_INPUT_TYPES, THREAD_VISIBILITIES } from "../constants.js";
import { showRefsSchema } from "../viewer-show-ref.js";

// ---- Discussion entry attachments (new field on DiscussionEntry) ----
export const DiscussionEntryAttachmentSchema = z.object({
  id: z.string().uuid(),
  artifactId: z.string().uuid().nullable(),
  assetId: z.string().uuid().nullable(),
  artifactType: z.string().nullable(),
  artifactTitle: z.string().nullable(),
  assetContentType: z.string().nullable().optional(),
  assetOriginalFilename: z.string().nullable().optional(),
  assetByteSize: z.number().int().nonnegative().nullable().optional(),
});
export type DiscussionEntryAttachment = z.infer<typeof DiscussionEntryAttachmentSchema>;

// ---- Phase 1 extended DiscussionEntry (adds attachments to existing shape) ----
// The legacy DISCUSSION_ENTRY_INPUT_TYPES_V2 alias was dropped in Task A3 —
// "scope_proposal" and "system" now live on the canonical
// DISCUSSION_ENTRY_INPUT_TYPES constant in packages/shared/src/constants.ts,
// matching the same rename pattern Task A2 used for THREAD_VISIBILITIES_V2.

export const DiscussionEntryV2Schema = z.object({
  id: z.string().uuid(),
  discussionId: z.string().uuid(),
  inputType: z.enum(DISCUSSION_ENTRY_INPUT_TYPES),
  rawContent: z.string(),
  title: z.string().nullable().optional(),
  parentEntryId: z.string().uuid().nullable(),
  authorAgentId: z.string().uuid().nullable(),
  authorAgentName: z.string().nullable(),
  authorAgentAvatar: z.string().nullable(),
  attachments: z.array(DiscussionEntryAttachmentSchema).default([]),
  // Viewer Upgrade Phase 7B: navigational ShowRefs on crew run-result entries.
  // Nullable + optional — only run-result delivery entries carry refs; all other
  // entries omit the field entirely.
  outputRefs: showRefsSchema.nullish(),
  createdAt: z.string(), // ISO string
  createdBy: z.string(),
});
export type DiscussionEntryV2 = z.infer<typeof DiscussionEntryV2Schema>;

// ---- Scope proposal payload (the JSON body of a scope_proposal entry) ----
export const ProposedTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable(),
  suggestedAssigneeAgentId: z.string().uuid().nullable(),
  suggestedDepartmentId: z.string().uuid().nullable(),
});
export type ProposedTask = z.infer<typeof ProposedTaskSchema>;

export const ScopeProposalPayloadSchema = z.object({
  summary: z.string().min(1),
  proposedTasks: z.array(ProposedTaskSchema).min(1),
  autoAdvanceAt: z.string().nullable(), // ISO string or null
});
export type ScopeProposalPayload = z.infer<typeof ScopeProposalPayloadSchema>;

// ---- Thread visibility (Phase 1: canonicalized in constants.ts) ----
// The legacy THREAD_VISIBILITIES_V2 / ThreadVisibilityV2 aliases were dropped
// in Task A2 — the underlying enum values now live on the canonical
// THREAD_VISIBILITIES constant in packages/shared/src/constants.ts and the
// ThreadVisibility type re-exported from the package root.
export const ThreadVisibilitySchema = z.enum(THREAD_VISIBILITIES);

// ---- Adapter configuration ----
export const AdapterConfigEntrySchema = z.object({
  adapter: z.string().min(1), // e.g. "claude_local", "codex_local", "gemini_local"
  model: z.string().min(1), // e.g. "claude-sonnet-4-6", "gpt-5.3-codex"
});
export type AdapterConfigEntry = z.infer<typeof AdapterConfigEntrySchema>;

export const CommanderAdapterConfigSchema = AdapterConfigEntrySchema;
export type CommanderAdapterConfig = z.infer<typeof CommanderAdapterConfigSchema>;

export const CrewAdapterConfigSchema = z.object({
  default: AdapterConfigEntrySchema.optional(),
  perAgent: z.record(z.string(), AdapterConfigEntrySchema).optional(),
});
export type CrewAdapterConfig = z.infer<typeof CrewAdapterConfigSchema>;

// ---- Notification types (new Phase 1 types extending existing constants) ----
// NOTE: thread.scope_proposal_posted + thread.human_input_needed were REMOVED
// (Task 10, 2026-07-04) with their pruned hub semantic types — zero writers ever
// shipped. Do NOT re-add without a real producer.
export const NEW_NOTIFICATION_TYPES = [
  "thread.artifact_needs_review",
  "thread.crew_failed",
  "thread.spinoff_suggested",
] as const;
export const NewNotificationTypeSchema = z.enum(NEW_NOTIFICATION_TYPES);
export type NewNotificationType = z.infer<typeof NewNotificationTypeSchema>;
