# V2.5 Session 3: Shared Types + Data Migration

**Date:** 2026-03-25
**Branch:** v2.5-s03
**Status:** Approved

## Overview

Define shared constants, types, Zod validators for the v2.5 discussion/internal-agent/workflow/notification domain, and create a data migration script to move existing debriefs into the new discussions model.

## Part A: Shared Types

### File Structure

Following existing codebase conventions:

- Constants + types go in `packages/shared/src/constants.ts`
- Validators go in `packages/shared/src/validators/<domain>.ts`
- Barrel exports in `packages/shared/src/validators/index.ts` and `packages/shared/src/index.ts`

### A1. Constants (`packages/shared/src/constants.ts`)

Add new constant blocks following the `as const` + derived type pattern:

**Discussion constants:**

```typescript
// ── V2.5: Discussions ─────────────────────────────────────────────────
export const DISCUSSION_STATUSES = ["active", "archived"] as const;
export type DiscussionStatus = (typeof DISCUSSION_STATUSES)[number];

export const DISCUSSION_SCOPE_TYPES = ["department", "project", "goal"] as const;
export type DiscussionScopeType = (typeof DISCUSSION_SCOPE_TYPES)[number];

export const DISCUSSION_ENTRY_INPUT_TYPES = ["paste", "write", "voice", "mcp"] as const;
export type DiscussionEntryInputType = (typeof DISCUSSION_ENTRY_INPUT_TYPES)[number];

export const EXTRACTION_STATUSES = ["pending", "processing", "completed", "failed", "skipped"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const EXTRACTION_ITEM_TYPES = ["decision", "task", "insight", "context", "reference", "preference"] as const;
export type ExtractionItemType = (typeof EXTRACTION_ITEM_TYPES)[number];

export const EXTRACTION_ITEM_STATUSES = ["pending", "approved", "rejected", "edited"] as const;
export type ExtractionItemStatus = (typeof EXTRACTION_ITEM_STATUSES)[number];
```

**Internal agent constants:**

```typescript
// ── V2.5: Internal Agent ──────────────────────────────────────────────
export const AGENT_CAPABILITIES = [
  "discussion_processing",
  "proactive_suggestions",
  "organizational_queries",
  "system_actions",
  "context_briefing",
  "memory_management",
  "conflict_detection",
  "budget_awareness",
  "workflow_coaching",
  "workflow_discovery",
  "cross_department_coordination",
  "department_personas",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

export const AGENT_EXECUTION_MODES = ["api", "cli"] as const;
export type AgentExecutionMode = (typeof AGENT_EXECUTION_MODES)[number];

export const AGENT_PROVIDERS = ["anthropic", "openai", "google"] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export const NOTIFICATION_PREFERENCES = ["silent", "digest", "realtime"] as const;
export type NotificationPreference = (typeof NOTIFICATION_PREFERENCES)[number];

export const TRIGGER_TYPES = ["conversation", "proactive", "event", "sub_agent"] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const TRIGGER_SOURCES = [
  "user_message",
  "discussion_entry",
  "proactive_scan",
  "event_hook",
  "reminder_fire",
  "sub_agent_dispatch",
] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const IA_RUN_STATUSES = ["running", "completed", "failed"] as const;
export type IaRunStatus = (typeof IA_RUN_STATUSES)[number];

export const IA_MESSAGE_ROLES = ["user", "assistant", "system", "tool_call", "tool_result"] as const;
export type IaMessageRole = (typeof IA_MESSAGE_ROLES)[number];

export const IA_CONVERSATION_STATUSES = ["active", "archived"] as const;
export type IaConversationStatus = (typeof IA_CONVERSATION_STATUSES)[number];

export const REMINDER_STATUSES = ["pending", "fired", "cancelled"] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  "discussion.extraction_complete",
  "discussion.extraction_failed",
  "internal_agent.reminder",
  "internal_agent.proactive",
  "internal_agent.action_result",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
```

**Live events (extend existing `LIVE_EVENT_TYPES` array):**

Add 6 new event types to the existing array:

```typescript
export const LIVE_EVENT_TYPES = [
  // ... existing 7 entries ...
  "discussion.entry.created",
  "discussion.extraction.completed",
  "discussion.extraction.failed",
  "internal_agent.greeting",
  "internal_agent.reminder",
  "internal_agent.notification",
] as const;
```

### A2. Validators

#### `packages/shared/src/validators/discussion.ts`

```typescript
import { z } from "zod";
import {
  DISCUSSION_STATUSES,
  DISCUSSION_SCOPE_TYPES,
  DISCUSSION_ENTRY_INPUT_TYPES,
  EXTRACTION_ITEM_TYPES,
  MEMORY_ITEM_LAYERS,
  BRIEF_DEDUP_ACTIONS,
} from "../constants.js";

export const createDiscussionEntrySchema = z.object({
  inputType: z.enum(DISCUSSION_ENTRY_INPUT_TYPES),
  rawContent: z.string().min(1),
  title: z.string().optional().nullable(),
  departmentId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  sourceInfo: z.record(z.unknown()).optional().nullable(),
});
export type CreateDiscussionEntry = z.infer<typeof createDiscussionEntrySchema>;

export const createDiscussionSchema = z.object({
  title: z.string().optional().nullable(),
  scopeType: z.enum(DISCUSSION_SCOPE_TYPES).optional().nullable(),
  scopeId: z.string().uuid().optional().nullable(),
  tags: z.array(z.string()).optional(),
  // Optional initial entry inline with discussion creation
  entry: createDiscussionEntrySchema.optional(),
});
export type CreateDiscussion = z.infer<typeof createDiscussionSchema>;

export const updateDiscussionSchema = z.object({
  title: z.string().optional().nullable(),
  status: z.enum(DISCUSSION_STATUSES).optional(),
  tags: z.array(z.string()).optional(),
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
```

#### `packages/shared/src/validators/internal-agent.ts`

```typescript
import { z } from "zod";
import {
  AGENT_EXECUTION_MODES,
  AGENT_PROVIDERS,
  AGENT_CAPABILITIES,
  NOTIFICATION_PREFERENCES,
} from "../constants.js";

export const updateInternalAgentConfigSchema = z.object({
  executionMode: z.enum(AGENT_EXECUTION_MODES).optional(),
  provider: z.enum(AGENT_PROVIDERS).optional().nullable(),
  model: z.string().optional().nullable(),
  cliTool: z.string().optional().nullable(),
  autonomyLevel: z.number().int().min(0).max(3).optional(),
  enabledCapabilities: z.array(z.enum(AGENT_CAPABILITIES)).optional(),
  notificationPreference: z.enum(NOTIFICATION_PREFERENCES).optional(),
  contextTokenBudget: z.number().int().positive().optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().nullable(),
  proactiveIntervalMinutes: z.number().int().min(15).optional(),
});
export type UpdateInternalAgentConfig = z.infer<typeof updateInternalAgentConfigSchema>;

export const chatMessageSchema = z.object({
  content: z.string().min(1).max(10000),
  pageContext: z.string().optional().nullable(),
  departmentContext: z.string().uuid().optional().nullable(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
```

#### `packages/shared/src/validators/workflow-template.ts`

```typescript
import { z } from "zod";

export const workflowStepSchema = z.object({
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  role: z.string().optional().nullable(),
  suggestedAssigneeType: z.string().optional().nullable(),
  suggestedDepartmentId: z.string().uuid().optional().nullable(),
  estimatedDurationHours: z.number().nonnegative().optional().nullable(),
  priority: z.string().optional().nullable(),
});

export const workflowDependencySchema = z.object({
  fromStep: z.number().int().nonnegative(),
  toStep: z.number().int().nonnegative(),
}).refine((d) => d.fromStep !== d.toStep, {
  message: "A step cannot depend on itself",
});

export const createWorkflowTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  steps: z.array(workflowStepSchema).min(1),
  dependencies: z.array(workflowDependencySchema).optional(),
});
export type CreateWorkflowTemplate = z.infer<typeof createWorkflowTemplateSchema>;

export const updateWorkflowTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  steps: z.array(workflowStepSchema).min(1).optional(),
  dependencies: z.array(workflowDependencySchema).optional(),
});
export type UpdateWorkflowTemplate = z.infer<typeof updateWorkflowTemplateSchema>;
```

### A3. Barrel Exports

**`packages/shared/src/validators/index.ts`** — Add:

```typescript
export {
  createDiscussionSchema, createDiscussionEntrySchema, updateDiscussionSchema,
  approveItemsSchema, createAnnotationSchema,
  type CreateDiscussion, type CreateDiscussionEntry, type UpdateDiscussion,
  type ApproveItems, type CreateAnnotation,
} from "./discussion.js";

export {
  updateInternalAgentConfigSchema, chatMessageSchema,
  type UpdateInternalAgentConfig, type ChatMessage,
} from "./internal-agent.js";

export {
  workflowStepSchema, workflowDependencySchema,
  createWorkflowTemplateSchema, updateWorkflowTemplateSchema,
  type CreateWorkflowTemplate, type UpdateWorkflowTemplate,
} from "./workflow-template.js";
```

**`packages/shared/src/index.ts`** — Add all new constants, types, and validator exports.

## Part B: Data Migration

### File: `server/src/migrations/v2_5-migrate-debriefs-to-discussions.ts`

#### `migrateDebriefsToDiscussions(db: Db)`

1. **Select all debriefs** joined through `debriefs → briefs → brief_items` chain. A debrief may have zero briefs (extraction failed before brief creation) or a brief may have zero items.
2. **For each debrief:**
   - **Idempotency check:** Query `discussions` where `metadata->>'migratedFromDebriefId' = debrief.id`. Skip if found. Uses the JSONB `metadata` approach rather than polluting `tags` (which is user-facing).
   - **Create discussion:**
     - `title` = debrief.title
     - `companyId` = debrief.companyId
     - `status` = `'active'` (all non-archived debriefs become active discussions; archived → `'archived'`)
     - `scopeType` / `scopeId` = inferred from debrief scope fields (priority: goalId → `'goal'`, projectId → `'project'`, departmentId → `'department'`, else null)
     - `tags` = `[]` (empty — migration metadata lives in `metadata` field, not tags)
     - `metadata` = `{ migratedFromDebriefId: debrief.id }` (not in schema yet — see note below)
     - `createdBy` = debrief.createdBy
     - `createdAt` = debrief.createdAt
   - **Note on idempotency field:** The `discussions` table already has no `metadata` column. Instead, we will use a simpler approach: query for existing discussions where `createdBy = debrief.createdBy AND createdAt = debrief.createdAt AND title = debrief.title`. Alternatively, maintain a local `Set<string>` of migrated debrief IDs by pre-scanning `discussion_entries.sourceInfo` for `{ migratedFromDebriefId }`. We use the `sourceInfo` approach on the entry (which is JSONB and already exists).
   - **Create discussion_entry:**
     - `inputType` = debrief.inputType
     - `rawContent` = debrief.rawContent
     - `sourceInfo` = `{ ...debrief.sourceInfo, migratedFromDebriefId: debrief.id, artifactUrl: debrief.artifactUrl }` (preserves artifactUrl data that has no direct equivalent column)
     - `departmentId` / `projectId` / `goalId` = from debrief
     - `extractionStatus`:
       - debrief.status `'ready'` → `'completed'`
       - debrief.status `'processing'` → `'failed'` (if no brief_items exist) or `'completed'` (if brief_items exist — extraction actually finished)
       - debrief.status `'processing_failed'` → `'failed'`
       - debrief.status `'archived'` → `'completed'`
     - `createdBy` = debrief.createdBy
     - `createdAt` = debrief.createdAt
   - **For each brief_item** (from debrief → brief → brief_items chain, if any):
     - CREATE `discussion_extracted_item` — direct column mapping:
       - `type`, `title`, `description`
       - `suggestedPriority`, `suggestedAssigneeId`, `suggestedDepartmentId`, `suggestedProjectId`, `suggestedLayer`
       - `layer`, `dedupAction`, `selectedMemoryId`, `mergedContent`
       - `status` — direct pass-through (pending/approved/rejected/edited)
       - `resultTaskId`, `resultMemoryId`
       - `suggestedGoalId` = NULL (column doesn't exist on brief_items)
       - `priority` = NULL (founder override column, not present on brief_items)
       - `conflictsWith` = NULL (new v2.5 column, not present on brief_items)
   - **Update discussion** denormalized counts:
     - `entryCount` = 1
     - `pendingItemCount` = count of items with status `'pending'`
     - `lastEntryAt` = entry.createdAt

#### `verifyMigration(db: Db)`

- Count debriefs → count discussions with migration tag → assert equal
- Count brief_items → count discussion_extracted_items → assert equal
- Verify no discussions have entryCount = 0 (each should have exactly 1 entry)

## Tests

### `server/src/__tests__/shared-types-contract.test.ts`

- Verify `DISCUSSION_STATUSES` has exactly 2 values
- Verify `EXTRACTION_STATUSES` has exactly 5 values
- Verify `AGENT_CAPABILITIES` has exactly 12 values
- Verify `EXTRACTION_ITEM_TYPES` matches `BRIEF_ITEM_TYPES` (same values)
- Verify `LIVE_EVENT_TYPES` includes all 6 new event types
- Verify `NOTIFICATION_TYPES` has 5 values
- Verify `createDiscussionSchema` accepts valid input with and without entry
- Verify `createDiscussionSchema` rejects empty rawContent in entry
- Verify `chatMessageSchema` accepts content up to 10000 chars
- Verify `chatMessageSchema` rejects content over 10000 chars
- Verify `createWorkflowTemplateSchema` requires at least 1 step
- Verify `approveItemsSchema` rejects self-dependency
- Verify `approveItemsSchema` action does not accept `"pending"` (only approved/rejected/edited)
- Verify `workflowDependencySchema` rejects fromStep === toStep
- Verify `updateInternalAgentConfigSchema` rejects autonomyLevel > 3

### `server/src/__tests__/migration-debrief-to-discussion.test.ts`

Uses mock DB pattern (sequence-based mocks):

- Test status mapping: debrief `ready` → entry extractionStatus `completed`
- Test status mapping: debrief `processing_failed` → entry extractionStatus `failed`
- Test denormalized counts: entryCount=1, pendingItemCount matches pending items
- Test idempotency: second run skips already-migrated debriefs
- Test scope inference: goalId present → scopeType='goal', scopeId=goalId
- Test `processing` status with items → extractionStatus `completed`
- Test `processing` status without items → extractionStatus `failed`
- Test artifactUrl preserved in sourceInfo of migrated entry
