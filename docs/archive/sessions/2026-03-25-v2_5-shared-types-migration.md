# V2.5 Session 3: Shared Types + Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared constants, Zod validators, and live event types for the v2.5 discussion/agent/workflow/notification domain, plus a data migration script from debriefs to discussions.

**Architecture:** Constants and derived types in `constants.ts` (existing file), Zod validators in new per-domain files under `validators/`, barrel exports updated. Migration script as a standalone function in `server/src/migrations/`.

**Tech Stack:** TypeScript, Zod, Drizzle ORM, Vitest

**Spec:** `docs/superpowers/specs/2026-03-25-v2_5-shared-types-migration-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `packages/shared/src/constants.ts` | Add v2.5 constants + types |
| Create | `packages/shared/src/validators/discussion.ts` | Discussion/entry/item/annotation Zod schemas |
| Create | `packages/shared/src/validators/internal-agent.ts` | Agent config + chat message Zod schemas |
| Create | `packages/shared/src/validators/workflow-template.ts` | Workflow template Zod schemas |
| Modify | `packages/shared/src/validators/index.ts` | Barrel re-exports for new validators |
| Modify | `packages/shared/src/index.ts` | Barrel re-exports for new constants + validators |
| Create | `server/src/migrations/v2_5-migrate-debriefs-to-discussions.ts` | Migration function + verification |
| Create | `server/src/__tests__/shared-types-contract.test.ts` | Contract tests for constants + validators |
| Create | `server/src/__tests__/migration-debrief-to-discussion.test.ts` | Migration logic tests |

---

### Task 1: Discussion Constants

**Files:**
- Modify: `packages/shared/src/constants.ts` (append after line 433, the last existing constant block)

- [ ] **Step 1: Add discussion constants to constants.ts**

Append to the end of `packages/shared/src/constants.ts`:

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

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): add v2.5 discussion constants and types"
```

---

### Task 2: Internal Agent + Notification Constants

**Files:**
- Modify: `packages/shared/src/constants.ts` (append after discussion constants)

- [ ] **Step 1: Add internal agent constants**

Append to `packages/shared/src/constants.ts`:

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

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): add v2.5 internal agent and notification constants"
```

---

### Task 3: Live Event Types

**Files:**
- Modify: `packages/shared/src/constants.ts` (edit existing `LIVE_EVENT_TYPES` array around line 202)

- [ ] **Step 1: Extend LIVE_EVENT_TYPES**

Find the existing `LIVE_EVENT_TYPES` array (line 202-211) and add 6 new entries before the closing `] as const`:

```typescript
export const LIVE_EVENT_TYPES = [
  "heartbeat.run.queued",
  "heartbeat.run.status",
  "heartbeat.run.event",
  "heartbeat.run.log",
  "heartbeat.run.outputs_detected",
  "agent.status",
  "activity.logged",
  // V2.5: Discussions
  "discussion.entry.created",
  "discussion.extraction.completed",
  "discussion.extraction.failed",
  // V2.5: Internal Agent
  "internal_agent.greeting",
  "internal_agent.reminder",
  "internal_agent.notification",
] as const;
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(shared): add v2.5 live event types for discussions and internal agent"
```

---

### Task 4: Discussion Validators

**Files:**
- Create: `packages/shared/src/validators/discussion.ts`

- [ ] **Step 1: Create discussion validator file**

Create `packages/shared/src/validators/discussion.ts`:

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

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/validators/discussion.ts
git commit -m "feat(shared): add discussion Zod validators"
```

---

### Task 5: Internal Agent Validators

**Files:**
- Create: `packages/shared/src/validators/internal-agent.ts`

- [ ] **Step 1: Create internal agent validator file**

Create `packages/shared/src/validators/internal-agent.ts`:

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

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/validators/internal-agent.ts
git commit -m "feat(shared): add internal agent Zod validators"
```

---

### Task 6: Workflow Template Validators

**Files:**
- Create: `packages/shared/src/validators/workflow-template.ts`

- [ ] **Step 1: Create workflow template validator file**

Create `packages/shared/src/validators/workflow-template.ts`:

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

export const workflowDependencySchema = z
  .object({
    fromStep: z.number().int().nonnegative(),
    toStep: z.number().int().nonnegative(),
  })
  .refine((d) => d.fromStep !== d.toStep, {
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

- [ ] **Step 2: Verify no TypeScript errors**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/validators/workflow-template.ts
git commit -m "feat(shared): add workflow template Zod validators"
```

---

### Task 7: Barrel Exports

**Files:**
- Modify: `packages/shared/src/validators/index.ts` (append new exports)
- Modify: `packages/shared/src/index.ts` (add constants + validator exports)

- [ ] **Step 1: Update validators/index.ts**

Append to `packages/shared/src/validators/index.ts` (after the last existing export block, around line 195):

```typescript
export {
  createDiscussionSchema,
  createDiscussionEntrySchema,
  updateDiscussionSchema,
  approveItemsSchema,
  createAnnotationSchema,
  type CreateDiscussion,
  type CreateDiscussionEntry,
  type UpdateDiscussion,
  type ApproveItems,
  type CreateAnnotation,
} from "./discussion.js";

export {
  updateInternalAgentConfigSchema,
  chatMessageSchema,
  type UpdateInternalAgentConfig,
  type ChatMessage,
} from "./internal-agent.js";

export {
  workflowStepSchema,
  workflowDependencySchema,
  createWorkflowTemplateSchema,
  updateWorkflowTemplateSchema,
  type CreateWorkflowTemplate,
  type UpdateWorkflowTemplate,
} from "./workflow-template.js";
```

- [ ] **Step 2: Update index.ts constants exports**

In `packages/shared/src/index.ts`, find the constants export block (lines 1-111). Add the new constants and types to the export list. Insert after the existing `DEBRIEF_INPUT_TYPES` / `DEBRIEF_STATUSES` exports (or at the end of the constants block, before `type BriefDedupAction`):

```typescript
  // V2.5: Discussions
  DISCUSSION_STATUSES,
  DISCUSSION_SCOPE_TYPES,
  DISCUSSION_ENTRY_INPUT_TYPES,
  EXTRACTION_STATUSES,
  EXTRACTION_ITEM_TYPES,
  EXTRACTION_ITEM_STATUSES,
  // V2.5: Internal Agent
  AGENT_CAPABILITIES,
  AGENT_EXECUTION_MODES,
  AGENT_PROVIDERS,
  NOTIFICATION_PREFERENCES,
  TRIGGER_TYPES,
  TRIGGER_SOURCES,
  IA_RUN_STATUSES,
  IA_MESSAGE_ROLES,
  IA_CONVERSATION_STATUSES,
  REMINDER_STATUSES,
  NOTIFICATION_TYPES,
  // V2.5 types
  type DiscussionStatus,
  type DiscussionScopeType,
  type DiscussionEntryInputType,
  type ExtractionStatus,
  type ExtractionItemType,
  type ExtractionItemStatus,
  type AgentCapability,
  type AgentExecutionMode,
  type AgentProvider,
  type NotificationPreference,
  type TriggerType,
  type TriggerSource,
  type IaRunStatus,
  type IaMessageRole,
  type IaConversationStatus,
  type ReminderStatus,
  type NotificationType,
```

- [ ] **Step 3: Update index.ts validator exports**

In `packages/shared/src/index.ts`, find the validators export block (lines 207-350). Add the new validator exports. Insert after the existing artifact exports (or at the end of the validators block):

```typescript
  createDiscussionSchema,
  createDiscussionEntrySchema,
  updateDiscussionSchema,
  approveItemsSchema,
  createAnnotationSchema,
  type CreateDiscussion,
  type CreateDiscussionEntry,
  type UpdateDiscussion,
  type ApproveItems,
  type CreateAnnotation,
  updateInternalAgentConfigSchema,
  chatMessageSchema,
  type UpdateInternalAgentConfig,
  type ChatMessage,
  workflowStepSchema,
  workflowDependencySchema,
  createWorkflowTemplateSchema,
  updateWorkflowTemplateSchema,
  type CreateWorkflowTemplate,
  type UpdateWorkflowTemplate,
```

- [ ] **Step 4: Verify build**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/index.ts packages/shared/src/index.ts
git commit -m "feat(shared): export all v2.5 constants and validators from barrel files"
```

---

### Task 8: Shared Types Contract Tests

**Files:**
- Create: `server/src/__tests__/shared-types-contract.test.ts`

- [ ] **Step 1: Write contract tests**

Create `server/src/__tests__/shared-types-contract.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  DISCUSSION_STATUSES,
  DISCUSSION_SCOPE_TYPES,
  DISCUSSION_ENTRY_INPUT_TYPES,
  EXTRACTION_STATUSES,
  EXTRACTION_ITEM_TYPES,
  EXTRACTION_ITEM_STATUSES,
  AGENT_CAPABILITIES,
  AGENT_EXECUTION_MODES,
  AGENT_PROVIDERS,
  TRIGGER_TYPES,
  TRIGGER_SOURCES,
  NOTIFICATION_TYPES,
  NOTIFICATION_PREFERENCES,
  IA_RUN_STATUSES,
  IA_MESSAGE_ROLES,
  IA_CONVERSATION_STATUSES,
  REMINDER_STATUSES,
  LIVE_EVENT_TYPES,
  BRIEF_ITEM_TYPES,
  createDiscussionSchema,
  createDiscussionEntrySchema,
  updateDiscussionSchema,
  approveItemsSchema,
  createAnnotationSchema,
  updateInternalAgentConfigSchema,
  chatMessageSchema,
  createWorkflowTemplateSchema,
  updateWorkflowTemplateSchema,
  workflowDependencySchema,
} from "@armyofagents/shared";

// ── Constants ────────────────────────────────────────────────────────────────

describe("v2.5 discussion constants", () => {
  it("DISCUSSION_STATUSES has 2 values", () => {
    expect(DISCUSSION_STATUSES).toEqual(["active", "archived"]);
  });

  it("DISCUSSION_SCOPE_TYPES has 3 values", () => {
    expect(DISCUSSION_SCOPE_TYPES).toEqual(["department", "project", "goal"]);
  });

  it("DISCUSSION_ENTRY_INPUT_TYPES has 4 values", () => {
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toEqual(["paste", "write", "voice", "mcp"]);
  });

  it("EXTRACTION_STATUSES has 5 values", () => {
    expect(EXTRACTION_STATUSES).toEqual(["pending", "processing", "completed", "failed", "skipped"]);
  });

  it("EXTRACTION_ITEM_TYPES matches BRIEF_ITEM_TYPES", () => {
    expect([...EXTRACTION_ITEM_TYPES]).toEqual([...BRIEF_ITEM_TYPES]);
  });

  it("EXTRACTION_ITEM_STATUSES has 4 values", () => {
    expect(EXTRACTION_ITEM_STATUSES).toEqual(["pending", "approved", "rejected", "edited"]);
  });
});

describe("v2.5 internal agent constants", () => {
  it("AGENT_CAPABILITIES has 12 values", () => {
    expect(AGENT_CAPABILITIES).toHaveLength(12);
    expect(AGENT_CAPABILITIES).toContain("discussion_processing");
    expect(AGENT_CAPABILITIES).toContain("department_personas");
  });

  it("AGENT_EXECUTION_MODES has 2 values", () => {
    expect(AGENT_EXECUTION_MODES).toEqual(["api", "cli"]);
  });

  it("AGENT_PROVIDERS has 3 values", () => {
    expect(AGENT_PROVIDERS).toEqual(["anthropic", "openai", "google"]);
  });

  it("TRIGGER_TYPES has 4 values", () => {
    expect(TRIGGER_TYPES).toEqual(["conversation", "proactive", "event", "sub_agent"]);
  });

  it("TRIGGER_SOURCES has 6 values", () => {
    expect(TRIGGER_SOURCES).toHaveLength(6);
  });

  it("NOTIFICATION_TYPES has 5 values", () => {
    expect(NOTIFICATION_TYPES).toHaveLength(5);
  });

  it("IA_RUN_STATUSES has 3 values", () => {
    expect(IA_RUN_STATUSES).toEqual(["running", "completed", "failed"]);
  });

  it("IA_MESSAGE_ROLES has 5 values", () => {
    expect(IA_MESSAGE_ROLES).toEqual(["user", "assistant", "system", "tool_call", "tool_result"]);
  });

  it("IA_CONVERSATION_STATUSES has 2 values", () => {
    expect(IA_CONVERSATION_STATUSES).toEqual(["active", "archived"]);
  });

  it("REMINDER_STATUSES has 3 values", () => {
    expect(REMINDER_STATUSES).toEqual(["pending", "fired", "cancelled"]);
  });

  it("NOTIFICATION_PREFERENCES has 3 values", () => {
    expect(NOTIFICATION_PREFERENCES).toEqual(["silent", "digest", "realtime"]);
  });
});

describe("v2.5 live event types", () => {
  it("includes all 6 new event types", () => {
    const newTypes = [
      "discussion.entry.created",
      "discussion.extraction.completed",
      "discussion.extraction.failed",
      "internal_agent.greeting",
      "internal_agent.reminder",
      "internal_agent.notification",
    ];
    for (const t of newTypes) {
      expect(LIVE_EVENT_TYPES).toContain(t);
    }
  });

  it("still includes original event types", () => {
    expect(LIVE_EVENT_TYPES).toContain("heartbeat.run.queued");
    expect(LIVE_EVENT_TYPES).toContain("activity.logged");
  });
});

// ── Validators ───────────────────────────────────────────────────────────────

describe("createDiscussionSchema", () => {
  it("accepts valid input without entry", () => {
    const result = createDiscussionSchema.safeParse({
      title: "Test Discussion",
      scopeType: "department",
      scopeId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid input with entry", () => {
    const result = createDiscussionSchema.safeParse({
      title: "Test",
      entry: {
        inputType: "paste",
        rawContent: "Some content",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts minimal input (empty object)", () => {
    const result = createDiscussionSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects entry with empty rawContent", () => {
    const result = createDiscussionSchema.safeParse({
      entry: {
        inputType: "paste",
        rawContent: "",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid scopeType", () => {
    const result = createDiscussionSchema.safeParse({
      scopeType: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("createDiscussionEntrySchema", () => {
  it("accepts valid input", () => {
    const result = createDiscussionEntrySchema.safeParse({
      inputType: "voice",
      rawContent: "Transcribed content",
      sourceInfo: { transcriptionModel: "whisper-1" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing inputType", () => {
    const result = createDiscussionEntrySchema.safeParse({
      rawContent: "Content",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid inputType", () => {
    const result = createDiscussionEntrySchema.safeParse({
      inputType: "email",
      rawContent: "Content",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateDiscussionSchema", () => {
  it("accepts partial update", () => {
    const result = updateDiscussionSchema.safeParse({
      status: "archived",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status", () => {
    const result = updateDiscussionSchema.safeParse({
      status: "deleted",
    });
    expect(result.success).toBe(false);
  });
});

describe("approveItemsSchema", () => {
  it("accepts valid approval", () => {
    const result = approveItemsSchema.safeParse({
      items: [
        {
          itemId: "550e8400-e29b-41d4-a716-446655440000",
          action: "approved",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts approval with edits", () => {
    const result = approveItemsSchema.safeParse({
      items: [
        {
          itemId: "550e8400-e29b-41d4-a716-446655440000",
          action: "edited",
          edits: {
            title: "Updated title",
            priority: "high",
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects action of pending", () => {
    const result = approveItemsSchema.safeParse({
      items: [
        {
          itemId: "550e8400-e29b-41d4-a716-446655440000",
          action: "pending",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects self-dependency", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const result = approveItemsSchema.safeParse({
      items: [{ itemId: id, action: "approved" }],
      dependencies: [{ dependentItemId: id, dependencyItemId: id }],
    });
    expect(result.success).toBe(false);
  });
});

describe("createAnnotationSchema", () => {
  it("accepts content-only annotation", () => {
    const result = createAnnotationSchema.safeParse({
      content: "Important note",
    });
    expect(result.success).toBe(true);
  });

  it("accepts annotation with anchors", () => {
    const result = createAnnotationSchema.safeParse({
      content: "Highlight",
      anchorStart: 10,
      anchorEnd: 25,
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty content", () => {
    const result = createAnnotationSchema.safeParse({
      content: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("chatMessageSchema", () => {
  it("accepts valid message", () => {
    const result = chatMessageSchema.safeParse({
      content: "Hello agent",
    });
    expect(result.success).toBe(true);
  });

  it("accepts message with context", () => {
    const result = chatMessageSchema.safeParse({
      content: "Help with tasks",
      pageContext: "/tasks",
      departmentContext: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("enforces 10k char limit", () => {
    const result = chatMessageSchema.safeParse({
      content: "x".repeat(10001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 10k chars", () => {
    const result = chatMessageSchema.safeParse({
      content: "x".repeat(10000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty content", () => {
    const result = chatMessageSchema.safeParse({
      content: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateInternalAgentConfigSchema", () => {
  it("accepts valid partial update", () => {
    const result = updateInternalAgentConfigSchema.safeParse({
      executionMode: "api",
      provider: "anthropic",
    });
    expect(result.success).toBe(true);
  });

  it("rejects autonomyLevel > 3", () => {
    const result = updateInternalAgentConfigSchema.safeParse({
      autonomyLevel: 4,
    });
    expect(result.success).toBe(false);
  });

  it("rejects autonomyLevel < 0", () => {
    const result = updateInternalAgentConfigSchema.safeParse({
      autonomyLevel: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid provider", () => {
    const result = updateInternalAgentConfigSchema.safeParse({
      provider: "azure",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid capabilities array", () => {
    const result = updateInternalAgentConfigSchema.safeParse({
      enabledCapabilities: ["discussion_processing", "budget_awareness"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid capability", () => {
    const result = updateInternalAgentConfigSchema.safeParse({
      enabledCapabilities: ["not_a_capability"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects proactiveIntervalMinutes < 15", () => {
    const result = updateInternalAgentConfigSchema.safeParse({
      proactiveIntervalMinutes: 5,
    });
    expect(result.success).toBe(false);
  });
});

describe("createWorkflowTemplateSchema", () => {
  it("accepts valid template", () => {
    const result = createWorkflowTemplateSchema.safeParse({
      name: "Spec to Code",
      steps: [
        { order: 0, title: "Write spec" },
        { order: 1, title: "Implement" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("requires at least 1 step", () => {
    const result = createWorkflowTemplateSchema.safeParse({
      name: "Empty",
      steps: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = createWorkflowTemplateSchema.safeParse({
      steps: [{ order: 0, title: "Step" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("workflowDependencySchema", () => {
  it("rejects self-dependency (fromStep === toStep)", () => {
    const result = workflowDependencySchema.safeParse({
      fromStep: 1,
      toStep: 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid dependency", () => {
    const result = workflowDependencySchema.safeParse({
      fromStep: 0,
      toStep: 1,
    });
    expect(result.success).toBe(true);
  });
});

describe("updateWorkflowTemplateSchema", () => {
  it("accepts partial update", () => {
    const result = updateWorkflowTemplateSchema.safeParse({
      name: "Renamed",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty object", () => {
    const result = updateWorkflowTemplateSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- --run shared-types-contract`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add server/src/__tests__/shared-types-contract.test.ts
git commit -m "test(shared): add v2.5 shared types contract tests"
```

---

### Task 9: Migration Script

**Files:**
- Create: `server/src/migrations/v2_5-migrate-debriefs-to-discussions.ts`

**Reference docs:**
- Schema spec: `docs/aoa/specs/v2_5_discussions_and_agent_schema.md` (Migration Strategy section)
- Source tables: `packages/db/src/schema/debriefs.ts`, `packages/db/src/schema/briefs.ts`, `packages/db/src/schema/brief_items.ts`
- Target tables: `packages/db/src/schema/discussions.ts`

- [ ] **Step 1: Create migrations directory and script**

Run: `mkdir -p server/src/migrations`

Create `server/src/migrations/v2_5-migrate-debriefs-to-discussions.ts`:

```typescript
import { eq, sql, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  debriefs,
  briefs,
  briefItems,
  discussions,
  discussionEntries,
  discussionExtractedItems,
} from "@armyofagents/db";

type Db = NodePgDatabase<Record<string, never>>;

/**
 * Maps debrief status to discussion entry extraction status.
 * - 'ready' → 'completed' (extraction finished successfully)
 * - 'processing' → 'completed' if items exist, 'failed' if not
 * - 'processing_failed' → 'failed'
 * - 'archived' → 'completed'
 */
function mapExtractionStatus(
  debriefStatus: string,
  hasItems: boolean,
): string {
  switch (debriefStatus) {
    case "ready":
      return "completed";
    case "processing":
      return hasItems ? "completed" : "failed";
    case "processing_failed":
      return "failed";
    case "archived":
      return "completed";
    default:
      return "failed";
  }
}

/**
 * Infers discussion scope from debrief fields.
 * Priority: goalId > projectId > departmentId
 */
function inferScope(debrief: {
  goalId: string | null;
  projectId: string | null;
  departmentId: string | null;
}): { scopeType: string | null; scopeId: string | null } {
  if (debrief.goalId) return { scopeType: "goal", scopeId: debrief.goalId };
  if (debrief.projectId)
    return { scopeType: "project", scopeId: debrief.projectId };
  if (debrief.departmentId)
    return { scopeType: "department", scopeId: debrief.departmentId };
  return { scopeType: null, scopeId: null };
}

/**
 * Migrates all debriefs (with their briefs and brief_items) into the
 * discussions model. Idempotent — skips debriefs already migrated by
 * checking sourceInfo.migratedFromDebriefId on existing entries.
 */
export async function migrateDebriefsToDiscussions(db: Db): Promise<{
  migrated: number;
  skipped: number;
  itemsMigrated: number;
}> {
  // 1. Pre-scan: find already-migrated debrief IDs
  const existingEntries = await db
    .select({ sourceInfo: discussionEntries.sourceInfo })
    .from(discussionEntries);

  const alreadyMigrated = new Set<string>();
  for (const entry of existingEntries) {
    const info = entry.sourceInfo as Record<string, unknown> | null;
    if (info?.migratedFromDebriefId) {
      alreadyMigrated.add(info.migratedFromDebriefId as string);
    }
  }

  // 2. Fetch all debriefs
  const allDebriefs = await db.select().from(debriefs);

  let migrated = 0;
  let skipped = 0;
  let itemsMigrated = 0;

  for (const debrief of allDebriefs) {
    // Idempotency check
    if (alreadyMigrated.has(debrief.id)) {
      skipped++;
      continue;
    }

    // 3. Fetch brief + items for this debrief
    const debriefBriefs = await db
      .select()
      .from(briefs)
      .where(eq(briefs.debriefId, debrief.id));

    const debriefBrief = debriefBriefs[0] ?? null;

    let items: (typeof briefItems.$inferSelect)[] = [];
    if (debriefBrief) {
      items = await db
        .select()
        .from(briefItems)
        .where(eq(briefItems.briefId, debriefBrief.id));
    }

    const hasItems = items.length > 0;
    const { scopeType, scopeId } = inferScope(debrief);

    await db.transaction(async (tx) => {
      // 4. Create discussion
      const [discussion] = await tx
        .insert(discussions)
        .values({
          companyId: debrief.companyId,
          title: debrief.title,
          status: debrief.status === "archived" ? "archived" : "active",
          scopeType,
          scopeId,
          tags: [],
          entryCount: 1,
          pendingItemCount: items.filter((i) => i.status === "pending").length,
          lastEntryAt: debrief.createdAt,
          createdBy: debrief.createdBy,
          createdAt: debrief.createdAt,
          updatedAt: debrief.createdAt,
        })
        .returning();

      // 5. Create discussion entry
      const [entry] = await tx
        .insert(discussionEntries)
        .values({
          discussionId: discussion.id,
          inputType: debrief.inputType,
          rawContent: debrief.rawContent,
          title: debrief.title,
          sourceInfo: {
            ...(debrief.sourceInfo as Record<string, unknown> | null),
            migratedFromDebriefId: debrief.id,
            ...(debrief.artifactUrl
              ? { artifactUrl: debrief.artifactUrl }
              : {}),
          },
          departmentId: debrief.departmentId,
          projectId: debrief.projectId,
          goalId: debrief.goalId,
          extractionStatus: mapExtractionStatus(debrief.status, hasItems),
          createdBy: debrief.createdBy,
          createdAt: debrief.createdAt,
        })
        .returning();

      // 6. Migrate brief items → extracted items
      if (items.length > 0) {
        await tx.insert(discussionExtractedItems).values(
          items.map((item) => ({
            discussionEntryId: entry.id,
            type: item.type,
            title: item.title,
            description: item.description,
            suggestedPriority: item.suggestedPriority,
            suggestedAssigneeId: item.suggestedAssigneeId,
            suggestedDepartmentId: item.suggestedDepartmentId,
            suggestedProjectId: item.suggestedProjectId,
            suggestedLayer: item.suggestedLayer,
            layer: item.layer,
            dedupAction: item.dedupAction,
            selectedMemoryId: item.selectedMemoryId,
            mergedContent: item.mergedContent,
            status: item.status,
            resultTaskId: item.resultTaskId,
            resultMemoryId: item.resultMemoryId,
            // New columns — NULL for migrated records
            suggestedGoalId: null,
            priority: null,
            conflictsWith: null,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
        );
      }
    });

    migrated++;
    itemsMigrated += items.length;
  }

  return { migrated, skipped, itemsMigrated };
}

/**
 * Verifies migration completeness by comparing source and target counts.
 */
export async function verifyMigration(db: Db): Promise<{
  debriefCount: number;
  discussionCount: number;
  briefItemCount: number;
  extractedItemCount: number;
  match: boolean;
}> {
  const [{ count: debriefCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(debriefs);

  // Count discussions that were created by migration (have sourceInfo with migratedFromDebriefId)
  const migratedEntries = await db
    .select({ sourceInfo: discussionEntries.sourceInfo })
    .from(discussionEntries);

  let discussionCount = 0;
  for (const entry of migratedEntries) {
    const info = entry.sourceInfo as Record<string, unknown> | null;
    if (info?.migratedFromDebriefId) {
      discussionCount++;
    }
  }

  const [{ count: briefItemCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(briefItems);

  const [{ count: extractedItemCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(discussionExtractedItems);

  return {
    debriefCount,
    discussionCount,
    briefItemCount,
    extractedItemCount,
    // Note: extractedItemCount may exceed briefItemCount if new discussions
    // have been created post-migration. This is a sanity check, not exact.
    match:
      debriefCount === discussionCount &&
      briefItemCount <= extractedItemCount,
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add server/src/migrations/v2_5-migrate-debriefs-to-discussions.ts
git commit -m "feat(migration): add debrief-to-discussion migration script"
```

---

### Task 10: Migration Tests

**Files:**
- Create: `server/src/__tests__/migration-debrief-to-discussion.test.ts`

**Note:** These tests use pure function tests for `mapExtractionStatus` and `inferScope` (extracted as module-level exports for testability), and mock-based tests for the main migration function. Follow the existing mock DB pattern from `server/src/__tests__/`.

- [ ] **Step 1: Export helper functions for testing**

In `server/src/migrations/v2_5-migrate-debriefs-to-discussions.ts`, add `export` to the two helper functions:

Change `function mapExtractionStatus(` → `export function mapExtractionStatus(`
Change `function inferScope(` → `export function inferScope(`

- [ ] **Step 2: Write migration tests**

Create `server/src/__tests__/migration-debrief-to-discussion.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  mapExtractionStatus,
  inferScope,
} from "../migrations/v2_5-migrate-debriefs-to-discussions.js";

describe("mapExtractionStatus", () => {
  it("maps 'ready' to 'completed'", () => {
    expect(mapExtractionStatus("ready", true)).toBe("completed");
    expect(mapExtractionStatus("ready", false)).toBe("completed");
  });

  it("maps 'processing' to 'completed' when items exist", () => {
    expect(mapExtractionStatus("processing", true)).toBe("completed");
  });

  it("maps 'processing' to 'failed' when no items exist", () => {
    expect(mapExtractionStatus("processing", false)).toBe("failed");
  });

  it("maps 'processing_failed' to 'failed'", () => {
    expect(mapExtractionStatus("processing_failed", true)).toBe("failed");
    expect(mapExtractionStatus("processing_failed", false)).toBe("failed");
  });

  it("maps 'archived' to 'completed'", () => {
    expect(mapExtractionStatus("archived", true)).toBe("completed");
    expect(mapExtractionStatus("archived", false)).toBe("completed");
  });

  it("defaults unknown status to 'failed'", () => {
    expect(mapExtractionStatus("unknown_status", true)).toBe("failed");
  });
});

describe("inferScope", () => {
  it("returns goal scope when goalId is present", () => {
    const result = inferScope({
      goalId: "goal-1",
      projectId: "project-1",
      departmentId: "dept-1",
    });
    expect(result).toEqual({ scopeType: "goal", scopeId: "goal-1" });
  });

  it("returns project scope when projectId is present (no goalId)", () => {
    const result = inferScope({
      goalId: null,
      projectId: "project-1",
      departmentId: "dept-1",
    });
    expect(result).toEqual({ scopeType: "project", scopeId: "project-1" });
  });

  it("returns department scope when departmentId is present (no goalId/projectId)", () => {
    const result = inferScope({
      goalId: null,
      projectId: null,
      departmentId: "dept-1",
    });
    expect(result).toEqual({ scopeType: "department", scopeId: "dept-1" });
  });

  it("returns null scope when no IDs are present", () => {
    const result = inferScope({
      goalId: null,
      projectId: null,
      departmentId: null,
    });
    expect(result).toEqual({ scopeType: null, scopeId: null });
  });
});
```

- [ ] **Step 3: Run migration tests**

Run: `pnpm test -- --run migration-debrief-to-discussion`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add server/src/migrations/v2_5-migrate-debriefs-to-discussions.ts server/src/__tests__/migration-debrief-to-discussion.test.ts
git commit -m "test(migration): add debrief-to-discussion migration tests"
```

---

### Task 11: Final Build Verification

- [ ] **Step 1: Run full shared package build**

Run: `pnpm build`
Expected: Build succeeds with no errors

- [ ] **Step 2: Run all session tests**

Run: `pnpm test -- --run shared-types-contract`
Run: `pnpm test -- --run migration-debrief-to-discussion`
Expected: All tests pass

- [ ] **Step 3: Final commit (if any fixups needed)**

If any fixups were needed during verification, commit them:

```bash
git add -A
git commit -m "feat(shared): add v2.5 discussion, agent, workflow types and validators; add debrief migration script"
```
