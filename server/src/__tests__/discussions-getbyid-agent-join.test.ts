import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  asc: vi.fn((col: any) => ({ asc: col })),
  desc: vi.fn((col: any) => ({ desc: col })),
  sql: vi.fn((strings: any, ...values: any[]) => ({
    sql: true,
    strings,
    values,
  })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
}));

vi.mock("@armyofagents/db", () => ({
  discussions: {
    id: "discussions_id",
    companyId: "discussions_company_id",
    title: "discussions_title",
    status: "discussions_status",
    scopeType: "discussions_scope_type",
    scopeId: "discussions_scope_id",
    tags: "discussions_tags",
    entryCount: "discussions_entry_count",
    entrySeq: "discussions_entry_seq",
    pendingItemCount: "discussions_pending_item_count",
    lastEntryAt: "discussions_last_entry_at",
    createdBy: "discussions_created_by",
    createdAt: "discussions_created_at",
    updatedAt: "discussions_updated_at",
  },
  discussionEntries: {
    id: "entries_id",
    discussionId: "entries_discussion_id",
    inputType: "entries_input_type",
    rawContent: "entries_raw_content",
    title: "entries_title",
    departmentId: "entries_department_id",
    projectId: "entries_project_id",
    goalId: "entries_goal_id",
    parentEntryId: "entries_parent_entry_id",
    authorAgentId: "entries_author_agent_id",
    sourceInfo: "entries_source_info",
    extractionStatus: "entries_extraction_status",
    extractionRunId: "entries_extraction_run_id",
    seq: "entries_seq",
    createdBy: "entries_created_by",
    createdAt: "entries_created_at",
  },
  discussionExtractedItems: {
    id: "items_id",
    discussionEntryId: "items_discussion_entry_id",
    type: "items_type",
    title: "items_title",
    description: "items_description",
    status: "items_status",
    suggestedPriority: "items_suggested_priority",
    suggestedAssigneeId: "items_suggested_assignee_id",
    suggestedDepartmentId: "items_suggested_department_id",
    suggestedProjectId: "items_suggested_project_id",
    suggestedLayer: "items_suggested_layer",
    suggestedGoalId: "items_suggested_goal_id",
    layer: "items_layer",
    priority: "items_priority",
    dedupAction: "items_dedup_action",
    selectedMemoryId: "items_selected_memory_id",
    mergedContent: "items_merged_content",
    resultTaskId: "items_result_task_id",
    resultMemoryId: "items_result_memory_id",
    conflictsWith: "items_conflicts_with",
    createdAt: "items_created_at",
    updatedAt: "items_updated_at",
  },
  discussionAnnotations: {
    id: "annotations_id",
    discussionEntryId: "annotations_discussion_entry_id",
    content: "annotations_content",
    anchorStart: "annotations_anchor_start",
    anchorEnd: "annotations_anchor_end",
    createdBy: "annotations_created_by",
    createdAt: "annotations_created_at",
    updatedAt: "annotations_updated_at",
  },
  agents: {
    id: "agents_id",
    name: "agents_name",
    icon: "agents_icon",
  },
  projects: {
    id: "projects_id",
    type: "projects_type",
    companyId: "projects_company_id",
    name: "projects_name",
  },
  goals: {
    id: "goals_id",
  },
  threadPlanSteps: {
    id: "tps_id",
    threadId: "tps_thread_id",
    stepOrder: "tps_step_order",
  },
  threadScopeVersions: {
    id: "tsv_id",
    companyId: "tsv_company_id",
    threadId: "tsv_thread_id",
    versionNumber: "tsv_version_number",
    status: "tsv_status",
    sourceEndSeq: "tsv_source_end_seq",
    createdAt: "tsv_created_at",
  },
  threadScopeItems: {
    id: "tsi_id",
    scopeVersionId: "tsi_scope_version_id",
    status: "tsi_status",
  },
  // Phase E2: discussion-entry attachments + artifacts (joined in getById)
  discussionEntryAttachments: {
    id: "dea_id",
    discussionEntryId: "dea_discussion_entry_id",
    assetId: "dea_asset_id",
    artifactId: "dea_artifact_id",
  },
  artifacts: { id: "artifacts_id", type: "artifacts_type", title: "artifacts_title", status: "artifacts_status", currentVersionId: "artifacts_current_version_id" },
  artifactVersions: {
    id: "artifact_versions_id",
    artifactId: "artifact_versions_artifact_id",
    storageKind: "artifact_versions_storage_kind",
    filename: "artifact_versions_filename",
    contentType: "artifact_versions_content_type",
    byteSize: "artifact_versions_byte_size",
    assetId: "artifact_versions_asset_id",
  },
  assets: {
    id: "assets_id",
    contentType: "assets_content_type",
    originalFilename: "assets_original_filename",
    byteSize: "assets_byte_size",
  },
  // Phase E batch 2 (T22): thread_participants + auth users (joined in getById)
  threadParticipants: {
    id: "tp_id",
    threadId: "tp_thread_id",
    principalType: "tp_principal_type",
    principalId: "tp_principal_id",
    role: "tp_role",
    addedAt: "tp_added_at",
    companyId: "tp_company_id",
  },
  authUsers: { id: "auth_users_id", name: "auth_users_name", email: "auth_users_email" },
  threadOrchestrationState: {
    threadId: "tos_thread_id",
    lastError: "tos_last_error",
    consecutiveCommitFailures: "tos_consecutive_commit_failures",
  },
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 400;
    return err;
  },
  notFound: (msg: string) => {
    const err = new Error(msg);
    (err as any).status = 404;
    return err;
  },
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({
    create: vi.fn().mockResolvedValue({ id: "task-1" }),
  })),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: vi.fn(() => ({
    create: vi.fn().mockResolvedValue({ id: "mem-1" }),
    findSimilarItems: vi.fn().mockResolvedValue([]),
  })),
}));

import { discussionService } from "../services/discussions.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a mock DB that sequences through select results.
 * For getById the flow is:
 *   1. select discussion by id+companyId  (plain select → .then)
 *   2. select entries left-joined with agents  (select → .from → .leftJoin → .where → .orderBy → resolves as array)
 *   3. select extracted items (inArray) — can be empty
 *   4. select annotations (inArray) — can be empty
 */
function createSequenceDb(selects: any[][]) {
  let idx = 0;

  function makeSelectChain() {
    const result = selects[idx++] ?? [];
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue(result),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn(result))),
    };
  }

  const db: any = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn(() => ({
        returning: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn([]))),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn([]))),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db)),
  };

  return db;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("discussionService.getById — agent join serialization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serializes authorAgentName and authorAgentAvatar from agents join, and parentEntryId on replies", async () => {
    const db = createSequenceDb([
      // 1. select discussion
      [{ id: "disc-1", companyId: "co", title: "Test", status: "active" }],
      // 2. select entries left-joined with agents — rows shaped as { entry, authorAgentName, authorAgentAvatar }
      [
        {
          entry: {
            id: "e1",
            discussionId: "disc-1",
            inputType: "agent",
            rawContent: "Agent says hello",
            authorAgentId: "agent-7",
            parentEntryId: null,
            createdAt: new Date(),
          },
          authorAgentName: "Scribe",
          authorAgentAvatar: "scribe.png",
        },
        {
          entry: {
            id: "e2",
            discussionId: "disc-1",
            inputType: "write",
            rawContent: "Human reply",
            authorAgentId: null,
            parentEntryId: "e1",
            createdAt: new Date(),
          },
          authorAgentName: null,
          authorAgentAvatar: null,
        },
      ],
      // 3. extracted items — empty
      [],
      // 4. annotations — empty
      [],
      // 5. Phase E2: attachments — empty
      [],
      // 6. plan steps (P5.2) — empty
      [],
      // 7. Phase E batch 2 (T22): thread participants — empty
      [],
    ]);

    const result = await discussionService(db).getById("co", "disc-1");

    expect(result).not.toBeNull();
    const entries = result!.entries;

    // First entry: agent-authored
    expect(entries[0].authorAgentId).toBe("agent-7");
    expect(entries[0].authorAgentName).toBe("Scribe");
    expect(entries[0].authorAgentAvatar).toBe("scribe.png");

    // Second entry: human reply with parentEntryId set
    expect(entries[1].parentEntryId).toBe("e1");
    expect(entries[1].authorAgentId).toBeNull();
  });
});
