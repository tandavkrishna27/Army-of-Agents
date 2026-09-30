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

describe("discussion constants", () => {
  it("DISCUSSION_STATUSES has 2 values", () => {
    expect(DISCUSSION_STATUSES).toEqual(["active", "archived"]);
  });

  it("DISCUSSION_SCOPE_TYPES has 3 values", () => {
    expect(DISCUSSION_SCOPE_TYPES).toEqual(["department", "project", "goal"]);
  });

  it("DISCUSSION_ENTRY_INPUT_TYPES has 12 values (Phase 1 added scope_proposal + system)", () => {
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toHaveLength(12);
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toContain("paste");
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toContain("write");
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toContain("voice");
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toContain("mcp");
    // Phase 1 (Task A3): Adjutant scope proposal + crew failure messages
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toContain("scope_proposal");
    expect(DISCUSSION_ENTRY_INPUT_TYPES).toContain("system");
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

describe("internal agent constants", () => {
  it("AGENT_CAPABILITIES has 12 values", () => {
    expect(AGENT_CAPABILITIES).toHaveLength(12);
    expect(AGENT_CAPABILITIES).toContain("discussion_processing");
    expect(AGENT_CAPABILITIES).toContain("department_personas");
  });

  it("AGENT_EXECUTION_MODES has 2 values", () => {
    expect(AGENT_EXECUTION_MODES).toEqual(["api", "cli"]);
  });

  it("AGENT_PROVIDERS has 4 values (incl. opencode)", () => {
    // opencode is a first-class crew provider (resolveCrewAdapterFor handles it);
    // added in the provider-switching reconnect.
    expect(AGENT_PROVIDERS).toEqual(["anthropic", "openai", "google", "opencode"]);
  });

  it("TRIGGER_TYPES has 4 values", () => {
    expect(TRIGGER_TYPES).toEqual(["conversation", "proactive", "event", "sub_agent"]);
  });

  it("TRIGGER_SOURCES has 6 values", () => {
    expect(TRIGGER_SOURCES).toHaveLength(6);
  });

  it("NOTIFICATION_TYPES has 17 values", () => {
    // 12 pre-Phase-1 types + 3 remaining thread.* types (Phase E batch 3 / T23
    // added 5; thread.scope_proposal_posted + thread.human_input_needed were
    // PRUNED in Task 10, 2026-07-04) + work-question SLA breach + the E2B
    // U13.6 internal_agent.compaction_failed founder-notice (cloud compaction
    // failure). Keep this assertion in sync with
    // packages/shared/src/constants.ts so changes don't sneak in untested.
    expect(NOTIFICATION_TYPES).toHaveLength(17);
  });

  it("NOTIFICATION_TYPES includes the 3 retained Phase 1 thread.* types", () => {
    const set = new Set<string>(NOTIFICATION_TYPES);
    expect(set.has("thread.artifact_needs_review")).toBe(true);
    expect(set.has("thread.crew_failed")).toBe(true);
    expect(set.has("thread.spinoff_suggested")).toBe(true);
  });

  it("NOTIFICATION_TYPES excludes the pruned Phase 1 thread.* types (Task 10)", () => {
    const set = new Set<string>(NOTIFICATION_TYPES);
    expect(set.has("thread.scope_proposal_posted")).toBe(false);
    expect(set.has("thread.human_input_needed")).toBe(false);
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

describe("live event types", () => {
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
      message: "Hello agent",
    });
    expect(result.success).toBe(true);
  });

  it("accepts message with context", () => {
    const result = chatMessageSchema.safeParse({
      message: "Help with tasks",
      pageContext: "/tasks",
      departmentContext: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.success).toBe(true);
  });

  it("accepts Commander chat with structured context scope", () => {
    const result = chatMessageSchema.safeParse({
      message: "What should I remember here?",
      pageContext: "Task > Close onboarding gap",
      conversationId: "550e8400-e29b-41d4-a716-446655440001",
      contextScope: {
        surface: "task",
        route: "/tasks/550e8400-e29b-41d4-a716-446655440002",
        departmentId: "550e8400-e29b-41d4-a716-446655440003",
        projectId: "550e8400-e29b-41d4-a716-446655440004",
        goalId: "550e8400-e29b-41d4-a716-446655440005",
        taskId: "550e8400-e29b-41d4-a716-446655440006",
        memoryFolderPath: "Company/Product",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown Commander context surfaces", () => {
    const result = chatMessageSchema.safeParse({
      message: "hello",
      contextScope: { surface: "unknown" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed Commander context UUIDs", () => {
    const result = chatMessageSchema.safeParse({
      message: "hello",
      contextScope: { surface: "task", taskId: "not-a-uuid" },
    });
    expect(result.success).toBe(false);
  });

  it("enforces 10k char limit", () => {
    const result = chatMessageSchema.safeParse({
      message: "x".repeat(10001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 10k chars", () => {
    const result = chatMessageSchema.safeParse({
      message: "x".repeat(10000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty content", () => {
    const result = chatMessageSchema.safeParse({
      message: "",
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
