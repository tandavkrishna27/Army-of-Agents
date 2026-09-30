import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscussionDb } from "./helpers/mock-db.js";

/**
 * Discussion Flow QA Tests
 *
 * Covers the full discussion pipeline:
 * - Create discussion → add entry → agent extracts → approve → tasks/memory created
 * - Threaded discussions with multiple entries
 * - Multi-type entries (paste, voice, MCP)
 * - Inline review: approve, reject, edit extracted items
 * - Annotations with anchor positions
 * - Scope linking and validation
 * - Archive/restore via status update
 * - Reprocess entry (extraction reset)
 * - Dedup handling (update_existing + selectedMemoryId)
 * - Discussion search via list filters
 */

// ── Mock drizzle-orm BEFORE imports ─────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  asc: vi.fn((col: any) => ({ asc: col })),
  desc: vi.fn((col: any) => ({ desc: col })),
  sql: vi.fn((strings: any, ...values: any[]) => ({ sql: true, strings, values })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  or: vi.fn((...args: any[]) => ({ or: args })),
}));

// ── Mock DB tables ──────────────────────────────────────────────────────────

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
    sourceInfo: "entries_source_info",
    extractionStatus: "entries_extraction_status",
    extractionRunId: "entries_extraction_run_id",
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
  projects: {
    id: "projects_id",
    type: "projects_type",
    companyId: "projects_company_id",
    name: "projects_name",
  },
  goals: { id: "goals_id", title: "goals_title" },
  agents: { id: "agents_id", name: "agents_name", icon: "agents_icon" },
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
  // Phase E batch 2 (T22): thread_participants + auth users (joined in getById
  // for the OriginCard static roster).
  threadParticipants: {
    id: "tp_id",
    threadId: "tp_thread_id",
    principalType: "tp_principal_type",
    principalId: "tp_principal_id",
    role: "tp_role",
    addedAt: "tp_added_at",
    companyId: "tp_company_id",
  },
  threadLinks: {
    id: "thread_links_id",
    companyId: "thread_links_company_id",
    fromThreadId: "thread_links_from_thread_id",
    toThreadId: "thread_links_to_thread_id",
    kind: "thread_links_kind",
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

const mockHubItemsService = vi.hoisted(() =>
  vi.fn(() => ({
    emit: vi.fn().mockResolvedValue({ deduped: false, item: null }),
    reconcile: vi.fn().mockResolvedValue({ healed: 0, closed: 0, refreshed: 0 }),
  })),
);

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: mockHubItemsService,
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

// P3-T1: discussions.update dynamically imports this on archive. Stub it so the
// archive test doesn't exercise the real Memory Keeper enqueue (its db mock
// doesn't model the wakeup select/insert chain). vi.mock intercepts the dynamic
// import; the real helper has its own unit tests (memory-on-close.test.ts).
vi.mock("../services/internal-agent/aoa-agents/memory-extraction-on-close.js", () => ({
  enqueueMemoryExtractionOnClose: vi.fn().mockResolvedValue(undefined),
}));

import { discussionService } from "../services/discussions.js";
import { publishLiveEvent } from "../services/live-events.js";
import { logActivity } from "../services/activity-log.js";

// ── Constants ───────────────────────────────────────────────────────────────

const COMPANY = "company-1";
const ACTOR = "user-1";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Discussion Flow QA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. Quick capture flow ─────────────────────────────────────────────────

  describe("1. Quick capture flow: paste → create discussion with entry → LiveEvent published", () => {
    it("creates discussion with inline entry and publishes live event", async () => {
      const createdDiscussion = {
        id: "disc-1",
        companyId: COMPANY,
        title: "Quick paste",
        status: "active",
        scopeType: null,
        scopeId: null,
        tags: [],
        entryCount: 1,
        pendingItemCount: 0,
        lastEntryAt: new Date(),
        createdBy: ACTOR,
      };
      const createdEntry = {
        id: "entry-1",
        discussionId: "disc-1",
        inputType: "paste",
        rawContent: "We need to update the landing page copy.",
        title: null,
        extractionStatus: "pending",
        createdBy: ACTOR,
      };

      const db = createDiscussionDb([
        // validateScope: no scope, skipped
        // transaction → insert discussion
        [createdDiscussion],
        // transaction → insert entry
        [createdEntry],
      ]);

      const svc = discussionService(db);
      const result = await svc.create(
        COMPANY,
        {
          title: "Quick paste",
          entry: {
            inputType: "paste",
            rawContent: "We need to update the landing page copy.",
          },
        },
        ACTOR,
      );

      expect(result.id).toBe("disc-1");
      expect(result.entry).toBeTruthy();
      expect(result.entry!.id).toBe("entry-1");
      expect(result.entry!.inputType).toBe("paste");

      // logActivity called with discussion.created
      expect(logActivity).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          companyId: COMPANY,
          action: "discussion.created",
          entityType: "discussion",
          entityId: "disc-1",
          details: { title: "Quick paste", hasEntry: true },
        }),
      );

      // publishLiveEvent called with discussion.entry.created
      expect(publishLiveEvent).toHaveBeenCalledWith({
        companyId: COMPANY,
        type: "discussion.entry.created",
        payload: {
          discussionId: "disc-1",
          entryId: "entry-1",
          inputType: "paste",
        },
      });
    });

    it("creates discussion without entry when entry is omitted", async () => {
      const createdDiscussion = {
        id: "disc-2",
        companyId: COMPANY,
        title: "Empty discussion",
        status: "active",
        entryCount: 0,
        pendingItemCount: 0,
      };

      const db = createDiscussionDb([
        // transaction → insert discussion (no entry)
        [createdDiscussion],
      ]);

      const svc = discussionService(db);
      const result = await svc.create(
        COMPANY,
        { title: "Empty discussion" },
        ACTOR,
      );

      expect(result.id).toBe("disc-2");
      expect(result.entry).toBeFalsy();

      // logActivity called but no LiveEvent (no entry)
      expect(logActivity).toHaveBeenCalled();
      expect(publishLiveEvent).not.toHaveBeenCalled();
    });
  });

  // ── 2. Threaded discussion ────────────────────────────────────────────────

  describe("2. Threaded discussion: create → add 3 entries → verify entryCount increments", () => {
    it("adds entries sequentially and publishes events for each", async () => {
      const existingDiscussion = {
        id: "disc-t",
        companyId: COMPANY,
        title: "Thread",
        status: "active",
        entryCount: 0,
      };

      // We'll call addEntry 3 times in sequence. Each call needs:
      // 1. select → verify discussion exists
      // 2. insert → create entry (returning)
      // 3. update → increment entryCount (no returning needed in the service,
      //    but the mock chain returns via .then anyway)

      for (let i = 1; i <= 3; i++) {
        const entryRow = {
          id: `entry-t-${i}`,
          discussionId: "disc-t",
          inputType: "paste",
          rawContent: `Entry content ${i}`,
          extractionStatus: "pending",
          createdBy: ACTOR,
        };

        const db = createDiscussionDb([
          // select discussion exists
          [existingDiscussion],
          // UPDATE discussions SET entrySeq+1 RETURNING (Plan 7 D1 atomic counter)
          [{ ...existingDiscussion, entrySeq: i }],
          // insert entry returning
          [entryRow],
        ]);

        const svc = discussionService(db);
        const result = await svc.addEntry(
          COMPANY,
          "disc-t",
          { inputType: "paste", rawContent: `Entry content ${i}` },
          ACTOR,
        );

        expect(result.id).toBe(`entry-t-${i}`);
        expect(publishLiveEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "discussion.entry.created",
            payload: expect.objectContaining({ entryId: `entry-t-${i}` }),
          }),
        );

        vi.clearAllMocks();
      }
    });

    it("throws notFound when adding entry to non-existent discussion", async () => {
      const db = createDiscussionDb([
        // select → discussion not found
        [],
      ]);

      const svc = discussionService(db);
      await expect(
        svc.addEntry(COMPANY, "disc-nope", { inputType: "paste", rawContent: "x" }, ACTOR),
      ).rejects.toThrow("Discussion not found");
    });
  });

  // ── 3. Multi-type entries ─────────────────────────────────────────────────

  describe("3. Multi-type entries: paste + voice + MCP in same discussion", () => {
    it("accepts paste, voice, and mcp inputTypes in same discussion", async () => {
      const disc = {
        id: "disc-multi",
        companyId: COMPANY,
        title: "Multi-type",
        status: "active",
        entryCount: 0,
      };

      const inputTypes = ["paste", "voice", "mcp"];

      for (let i = 0; i < inputTypes.length; i++) {
        const entryRow = {
          id: `entry-m-${i}`,
          discussionId: "disc-multi",
          inputType: inputTypes[i],
          rawContent: `Content for ${inputTypes[i]}`,
          extractionStatus: "pending",
          createdBy: ACTOR,
          sourceInfo: inputTypes[i] === "mcp" ? { tool: "github" } : null,
        };

        const db = createDiscussionDb([
          [disc],
          // UPDATE discussions SET entrySeq+1 RETURNING (Plan 7 D1 atomic counter)
          [{ ...disc, entrySeq: i + 1 }],
          [entryRow],
        ]);

        const svc = discussionService(db);
        const result = await svc.addEntry(
          COMPANY,
          "disc-multi",
          {
            inputType: inputTypes[i],
            rawContent: `Content for ${inputTypes[i]}`,
            sourceInfo: inputTypes[i] === "mcp" ? { tool: "github" } : null,
          },
          ACTOR,
        );

        expect(result.inputType).toBe(inputTypes[i]);
        expect(publishLiveEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({ inputType: inputTypes[i] }),
          }),
        );

        vi.clearAllMocks();
      }
    });
  });

  // ── 4. Inline review flow: approve items (task + memory) ──────────────────

  describe("4. Inline review flow: approve items (task + memory) → verify results", () => {
    it("approves a task item and a memory item, creates both", async () => {
      const disc = {
        id: "disc-review",
        companyId: COMPANY,
        title: "Review",
        status: "active",
        pendingItemCount: 2,
      };

      const taskItem = {
        id: "item-task-1",
        discussionEntryId: "entry-r-1",
        type: "task",
        title: "Fix the bug",
        description: "There is a bug in checkout flow.",
        status: "pending",
        suggestedPriority: "high",
        suggestedAssigneeId: "agent-1",
        suggestedDepartmentId: "dept-1",
        suggestedProjectId: null,
        suggestedGoalId: null,
        suggestedLayer: null,
        priority: null,
        layer: null,
        dedupAction: null,
        selectedMemoryId: null,
        mergedContent: null,
      };

      const memoryItem = {
        id: "item-mem-1",
        discussionEntryId: "entry-r-1",
        type: "decision",
        title: "Use TypeScript everywhere",
        description: "All new code must be TypeScript.",
        status: "pending",
        suggestedPriority: null,
        suggestedAssigneeId: null,
        suggestedDepartmentId: null,
        suggestedProjectId: null,
        suggestedGoalId: null,
        suggestedLayer: "domain",
        priority: null,
        layer: null,
        dedupAction: null,
        selectedMemoryId: null,
        mergedContent: null,
      };

      const db = createDiscussionDb([
        // select discussion exists
        [disc],
        // tx.select items by IDs
        [taskItem, memoryItem],
        // tx.select entries verification
        [{ id: "entry-r-1" }],
        // tx → issues.create for task item (happens inside issueService mock)
        // tx.update item status=approved, resultTaskId (for task)
        [{ ...taskItem, status: "approved", resultTaskId: "task-1" }],
        // tx → memory.create for memory item (happens inside memoryService mock)
        // tx.update item status=approved, resultMemoryId (for memory)
        [{ ...memoryItem, status: "approved", resultMemoryId: "mem-1" }],
        // tx.update discussions pendingItemCount
        [{ ...disc, pendingItemCount: 0 }],
      ]);

      const svc = discussionService(db);
      const result = await svc.approveItems(
        COMPANY,
        "disc-review",
        ["item-task-1", "item-mem-1"],
        ACTOR,
      );

      expect(result.approvedCount).toBe(2);
      expect(result.createdTaskIds).toContain("task-1");
      expect(result.createdMemoryIds).toContain("mem-1");

      // logActivity called with discussion.items.approved
      expect(logActivity).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          action: "discussion.items.approved",
          entityId: "disc-review",
          details: expect.objectContaining({ approvedCount: 2 }),
        }),
      );
    });

    it("throws badRequest when no itemIds provided", async () => {
      const db = createDiscussionDb([]);
      const svc = discussionService(db);

      await expect(
        svc.approveItems(COMPANY, "disc-x", [], ACTOR),
      ).rejects.toThrow("No items to approve");
    });

    it("throws notFound when discussion does not exist for approve", async () => {
      const db = createDiscussionDb([
        // select discussion → not found
        [],
      ]);
      const svc = discussionService(db);

      await expect(
        svc.approveItems(COMPANY, "disc-nope", ["item-1"], ACTOR),
      ).rejects.toThrow("Discussion not found");
    });

    it("throws badRequest when some item IDs not found", async () => {
      const disc = { id: "disc-x", companyId: COMPANY, pendingItemCount: 1 };

      const db = createDiscussionDb([
        [disc],
        // tx.select items → returns only 1 of 2 requested
        [{ id: "item-1", discussionEntryId: "e1", type: "task", title: "T", status: "pending" }],
      ]);
      const svc = discussionService(db);

      await expect(
        svc.approveItems(COMPANY, "disc-x", ["item-1", "item-missing"], ACTOR),
      ).rejects.toThrow("Some item IDs not found");
    });
  });

  // ── 5. Partial approval ───────────────────────────────────────────────────

  describe("5. Partial approval: approve 1 of 3 items → reject remaining → verify counts", () => {
    it("approves 1 task item, then rejects 2 remaining", async () => {
      const disc = {
        id: "disc-partial",
        companyId: COMPANY,
        pendingItemCount: 3,
      };

      const taskItem = {
        id: "item-p-1",
        discussionEntryId: "entry-p-1",
        type: "task",
        title: "Approved task",
        description: "This one gets approved.",
        status: "pending",
        suggestedPriority: "medium",
        suggestedAssigneeId: null,
        suggestedDepartmentId: null,
        suggestedProjectId: null,
        suggestedGoalId: null,
        suggestedLayer: null,
        priority: null,
        layer: null,
        dedupAction: null,
        selectedMemoryId: null,
        mergedContent: null,
      };

      // Step 1: approve 1 item
      const dbApprove = createDiscussionDb([
        [disc],
        // tx.select items
        [taskItem],
        // tx.select entries verification
        [{ id: "entry-p-1" }],
        // tx.update item → approved
        [{ ...taskItem, status: "approved", resultTaskId: "task-1" }],
        // tx.update discussion pendingItemCount
        [{ ...disc, pendingItemCount: 2 }],
      ]);

      const svc1 = discussionService(dbApprove);
      const approveResult = await svc1.approveItems(
        COMPANY,
        "disc-partial",
        ["item-p-1"],
        ACTOR,
      );

      expect(approveResult.approvedCount).toBe(1);
      expect(approveResult.createdTaskIds).toEqual(["task-1"]);

      vi.clearAllMocks();

      // Step 2: reject remaining 2 items
      const rejectedItems = [
        { id: "item-p-2", entryId: "entry-p-1", status: "rejected" },
        { id: "item-p-3", entryId: "entry-p-1", status: "rejected" },
      ];

      const dbReject = createDiscussionDb([
        // select discussion
        [disc],
        // select items to verify they belong to discussion
        [
          { id: "item-p-2", entryId: "entry-p-1" },
          { id: "item-p-3", entryId: "entry-p-1" },
        ],
        // select entries verification
        [{ id: "entry-p-1" }],
        // update items → rejected (returning)
        rejectedItems,
        // update discussion pendingItemCount
        [{ ...disc, pendingItemCount: 0 }],
      ]);

      const svc2 = discussionService(dbReject);
      const rejectResult = await svc2.rejectItems(
        COMPANY,
        "disc-partial",
        ["item-p-2", "item-p-3"],
        ACTOR,
      );

      expect(rejectResult.rejectedCount).toBe(2);

      expect(logActivity).toHaveBeenCalledWith(
        dbReject,
        expect.objectContaining({
          action: "discussion.items.rejected",
          details: expect.objectContaining({ rejectedCount: 2 }),
        }),
      );
    });

    it("throws badRequest when no items to reject", async () => {
      const db = createDiscussionDb([]);
      const svc = discussionService(db);

      await expect(
        svc.rejectItems(COMPANY, "disc-x", [], ACTOR),
      ).rejects.toThrow("No items to reject");
    });
  });

  // ── 6. Edit extracted item ────────────────────────────────────────────────

  describe("6. Edit extracted item: update item → status changes to 'edited'", () => {
    it("updates item fields and sets status to edited", async () => {
      const item = {
        id: "item-edit-1",
        discussionEntryId: "entry-e-1",
      };
      const entry = { discussionId: "disc-edit" };
      const disc = { companyId: COMPANY };
      const updatedItem = {
        id: "item-edit-1",
        title: "Updated title",
        description: "Updated description",
        priority: "high",
        status: "edited",
      };

      const db = createDiscussionDb([
        // select item
        [item],
        // select entry
        [entry],
        // select discussion (company check)
        [disc],
        // update item returning
        [updatedItem],
      ]);

      const svc = discussionService(db);
      const result = await svc.updateItem(COMPANY, "item-edit-1", {
        title: "Updated title",
        description: "Updated description",
        priority: "high",
      });

      expect(result.status).toBe("edited");
      expect(result.title).toBe("Updated title");
    });

    it("throws notFound when item does not exist", async () => {
      const db = createDiscussionDb([
        // select item → not found
        [],
      ]);
      const svc = discussionService(db);

      await expect(
        svc.updateItem(COMPANY, "item-nope", { title: "X" }),
      ).rejects.toThrow("Extracted item not found");
    });

    it("throws notFound when item belongs to different company", async () => {
      const db = createDiscussionDb([
        // select item
        [{ id: "item-1", discussionEntryId: "entry-1" }],
        // select entry
        [{ discussionId: "disc-1" }],
        // select discussion → different company
        [{ companyId: "other-company" }],
      ]);
      const svc = discussionService(db);

      await expect(
        svc.updateItem(COMPANY, "item-1", { title: "X" }),
      ).rejects.toThrow("Extracted item not found");
    });
  });

  // ── 7. Annotation flow ───────────────────────────────────────────────────

  describe("7. Annotation flow: add entry → add annotation with anchor positions", () => {
    it("creates annotation with anchor positions and logs activity", async () => {
      const entry = { discussionId: "disc-ann" };
      const disc = { companyId: COMPANY };
      const annotation = {
        id: "ann-1",
        discussionEntryId: "entry-ann-1",
        content: "This is important",
        anchorStart: 10,
        anchorEnd: 25,
        createdBy: ACTOR,
      };

      const db = createDiscussionDb([
        // select entry
        [entry],
        // select discussion (company check)
        [disc],
        // insert annotation returning
        [annotation],
      ]);

      const svc = discussionService(db);
      const result = await svc.addAnnotation(
        COMPANY,
        "entry-ann-1",
        { content: "This is important", anchorStart: 10, anchorEnd: 25 },
        ACTOR,
      );

      expect(result.id).toBe("ann-1");
      expect(result.anchorStart).toBe(10);
      expect(result.anchorEnd).toBe(25);

      expect(logActivity).toHaveBeenCalledWith(
        db,
        expect.objectContaining({
          action: "discussion.annotation.added",
          entityType: "discussion_annotation",
          entityId: "ann-1",
          details: { entryId: "entry-ann-1", discussionId: "disc-ann" },
        }),
      );
    });

    it("creates annotation without anchor positions (full-entry note)", async () => {
      const annotation = {
        id: "ann-2",
        discussionEntryId: "entry-ann-2",
        content: "General note",
        anchorStart: null,
        anchorEnd: null,
        createdBy: ACTOR,
      };

      const db = createDiscussionDb([
        [{ discussionId: "disc-ann" }],
        [{ companyId: COMPANY }],
        [annotation],
      ]);

      const svc = discussionService(db);
      const result = await svc.addAnnotation(
        COMPANY,
        "entry-ann-2",
        { content: "General note" },
        ACTOR,
      );

      expect(result.anchorStart).toBeNull();
      expect(result.anchorEnd).toBeNull();
    });

    it("throws notFound when entry does not exist", async () => {
      const db = createDiscussionDb([[]]);
      const svc = discussionService(db);

      await expect(
        svc.addAnnotation(COMPANY, "entry-nope", { content: "x" }, ACTOR),
      ).rejects.toThrow("Entry not found");
    });

    it("throws notFound when entry belongs to different company", async () => {
      const db = createDiscussionDb([
        [{ discussionId: "disc-x" }],
        [{ companyId: "other-company" }],
      ]);
      const svc = discussionService(db);

      await expect(
        svc.addAnnotation(COMPANY, "entry-x", { content: "x" }, ACTOR),
      ).rejects.toThrow("Entry not found");
    });
  });

  // ── 8. Scope linking ──────────────────────────────────────────────────────

  describe("8. Scope linking: create discussion → link to department scope → verify validation", () => {
    it("creates discussion linked to a department scope", async () => {
      const createdDiscussion = {
        id: "disc-scope",
        companyId: COMPANY,
        title: "Scoped discussion",
        scopeType: "department",
        scopeId: "dept-1",
      };

      const db = createDiscussionDb([
        // validateScope → select from projects where id=dept-1
        [{ id: "dept-1", type: "department" }],
        // transaction → insert discussion
        [createdDiscussion],
      ]);

      const svc = discussionService(db);
      const result = await svc.create(
        COMPANY,
        {
          title: "Scoped discussion",
          scopeType: "department",
          scopeId: "dept-1",
        },
        ACTOR,
      );

      expect(result.id).toBe("disc-scope");
      expect(result.scopeType).toBe("department");
      expect(result.scopeId).toBe("dept-1");
    });

    it("throws when scopeType is set but scopeId is missing", async () => {
      const db = createDiscussionDb([]);
      const svc = discussionService(db);

      await expect(
        svc.create(
          COMPANY,
          { title: "Bad scope", scopeType: "department" },
          ACTOR,
        ),
      ).rejects.toThrow("scopeId is required when scopeType is set");
    });

    it("throws when scopeId is set but scopeType is missing", async () => {
      const db = createDiscussionDb([]);
      const svc = discussionService(db);

      await expect(
        svc.create(
          COMPANY,
          { title: "Bad scope", scopeId: "dept-1" },
          ACTOR,
        ),
      ).rejects.toThrow("scopeType is required when scopeId is set");
    });

    it("throws when scope references wrong type (project vs department)", async () => {
      const db = createDiscussionDb([
        // validateScope → select returns project, but scopeType is department
        [{ id: "proj-1", type: "project" }],
      ]);
      const svc = discussionService(db);

      await expect(
        svc.create(
          COMPANY,
          { title: "Wrong scope", scopeType: "department", scopeId: "proj-1" },
          ACTOR,
        ),
      ).rejects.toThrow("Scope references a project, not a department");
    });

    it("throws when scopeId references non-existent entity", async () => {
      const db = createDiscussionDb([
        // validateScope → select returns empty
        [],
      ]);
      const svc = discussionService(db);

      await expect(
        svc.create(
          COMPANY,
          { title: "Missing scope", scopeType: "department", scopeId: "dept-nope" },
          ACTOR,
        ),
      ).rejects.toThrow("department with id 'dept-nope' not found");
    });

    it("throws for invalid scopeType", async () => {
      const db = createDiscussionDb([]);
      const svc = discussionService(db);

      await expect(
        svc.create(
          COMPANY,
          { title: "Bad", scopeType: "invalid" as any, scopeId: "x" },
          ACTOR,
        ),
      ).rejects.toThrow("Invalid scopeType 'invalid'");
    });

    it("validates goal scope correctly", async () => {
      const createdDiscussion = {
        id: "disc-goal",
        companyId: COMPANY,
        title: "Goal-scoped",
        scopeType: "goal",
        scopeId: "goal-1",
      };

      const db = createDiscussionDb([
        // validateScope → select from goals
        [{ id: "goal-1" }],
        // transaction → insert discussion
        [createdDiscussion],
      ]);

      const svc = discussionService(db);
      const result = await svc.create(
        COMPANY,
        { title: "Goal-scoped", scopeType: "goal", scopeId: "goal-1" },
        ACTOR,
      );

      expect(result.scopeType).toBe("goal");
    });
  });

  // ── 9. Archive and restore ────────────────────────────────────────────────

  describe("9. Archive and restore: create → archive → verify status change", () => {
    it("archives a discussion by updating status to archived", async () => {
      const updatedDiscussion = {
        id: "disc-arch",
        companyId: COMPANY,
        title: "Archived discussion",
        status: "archived",
      };

      const db = createDiscussionDb([
        // update → returning
        [updatedDiscussion],
      ]);

      const svc = discussionService(db);
      const result = await svc.update(COMPANY, "disc-arch", {
        status: "archived",
      });

      expect(result).toBeTruthy();
      expect(result!.status).toBe("archived");
    });

    it("restores an archived discussion by setting status to active", async () => {
      const restored = {
        id: "disc-arch",
        companyId: COMPANY,
        title: "Restored discussion",
        status: "active",
      };

      const db = createDiscussionDb([
        // update → returning
        [restored],
      ]);

      const svc = discussionService(db);
      const result = await svc.update(COMPANY, "disc-arch", {
        status: "active",
      });

      expect(result!.status).toBe("active");
    });

    it("returns null when updating non-existent discussion", async () => {
      const db = createDiscussionDb([
        // update → empty returning (no row matched)
        [],
      ]);

      const svc = discussionService(db);
      const result = await svc.update(COMPANY, "disc-nope", {
        title: "New title",
      });

      expect(result).toBeNull();
    });

    it("validates scope when updating scope fields on discussion", async () => {
      const existing = { scopeType: null, scopeId: null };

      const db = createDiscussionDb([
        // select existing scope
        [existing],
        // validateScope → select project
        [{ id: "dept-1", type: "department" }],
        // update → returning
        [{ id: "disc-x", scopeType: "department", scopeId: "dept-1" }],
      ]);

      const svc = discussionService(db);
      const result = await svc.update(COMPANY, "disc-x", {
        scopeType: "department",
        scopeId: "dept-1",
      });

      expect(result!.scopeType).toBe("department");
    });

    it("throws notFound when updating scope on non-existent discussion", async () => {
      const db = createDiscussionDb([
        // select existing scope → not found
        [],
      ]);
      const svc = discussionService(db);

      await expect(
        svc.update(COMPANY, "disc-nope", { scopeType: "department", scopeId: "x" }),
      ).rejects.toThrow("Discussion not found");
    });
  });

  // ── 10. Reprocess entry ───────────────────────────────────────────────────

  describe("10. Reprocess entry: add entry → reprocess → verify extraction status reset", () => {
    it("resets extraction status and deletes non-approved items", async () => {
      const entry = {
        id: "entry-rp-1",
        discussionId: "disc-rp",
        extractionStatus: "completed",
      };
      const disc = { companyId: COMPANY };

      const db = createDiscussionDb([
        // select entry
        [entry],
        // select discussion (company check)
        [disc],
        // select approved items → none
        [],
        // select pending items → 2 pending
        [{ id: "item-rp-1" }, { id: "item-rp-2" }],
        // delete items (consumed by delete mock, no sequence needed)
        // update entry extraction status (no returning)
        [{ ...entry, extractionStatus: "pending", extractionRunId: null }],
        // update discussion pendingItemCount
        [{ pendingItemCount: 0 }],
      ]);

      const svc = discussionService(db);
      const result = await svc.reprocessEntry(COMPANY, "entry-rp-1");

      expect(result.entryId).toBe("entry-rp-1");
      expect(result.extractionStatus).toBe("pending");
    });

    it("throws badRequest when entry has approved items", async () => {
      const entry = { id: "entry-rp-2", discussionId: "disc-rp" };
      const disc = { companyId: COMPANY };

      const db = createDiscussionDb([
        [entry],
        [disc],
        // approved items exist
        [{ id: "item-approved" }],
      ]);

      const svc = discussionService(db);
      await expect(
        svc.reprocessEntry(COMPANY, "entry-rp-2"),
      ).rejects.toThrow("Cannot reprocess entry with approved items");
    });

    it("throws notFound when entry does not exist", async () => {
      const db = createDiscussionDb([[]]);
      const svc = discussionService(db);

      await expect(
        svc.reprocessEntry(COMPANY, "entry-nope"),
      ).rejects.toThrow("Entry not found");
    });

    it("throws notFound when entry belongs to different company", async () => {
      const db = createDiscussionDb([
        [{ id: "entry-x", discussionId: "disc-x" }],
        [{ companyId: "other-company" }],
      ]);
      const svc = discussionService(db);

      await expect(
        svc.reprocessEntry(COMPANY, "entry-x"),
      ).rejects.toThrow("Entry not found");
    });
  });

  // ── 11. Dedup handling ────────────────────────────────────────────────────

  describe("11. Dedup handling: approve items with dedupAction='update_existing' and selectedMemoryId", () => {
    it("approves memory item with dedup fields set", async () => {
      const disc = {
        id: "disc-dedup",
        companyId: COMPANY,
        pendingItemCount: 1,
      };

      const memoryItem = {
        id: "item-dedup-1",
        discussionEntryId: "entry-d-1",
        type: "decision",
        title: "Updated decision",
        description: "New version of existing decision.",
        status: "pending",
        suggestedPriority: null,
        suggestedAssigneeId: null,
        suggestedDepartmentId: null,
        suggestedProjectId: null,
        suggestedGoalId: null,
        suggestedLayer: "domain",
        priority: null,
        layer: null,
        dedupAction: "update_existing",
        selectedMemoryId: "mem-existing-1",
        mergedContent: "Merged: old decision + new decision content.",
      };

      const db = createDiscussionDb([
        // select discussion
        [disc],
        // tx.select items
        [memoryItem],
        // tx.select entries verification
        [{ id: "entry-d-1" }],
        // tx.update item → approved with resultMemoryId
        [{ ...memoryItem, status: "approved", resultMemoryId: "mem-1" }],
        // tx.update discussions pendingItemCount
        [{ ...disc, pendingItemCount: 0 }],
      ]);

      const svc = discussionService(db);
      const result = await svc.approveItems(
        COMPANY,
        "disc-dedup",
        ["item-dedup-1"],
        ACTOR,
      );

      expect(result.approvedCount).toBe(1);
      expect(result.createdMemoryIds).toContain("mem-1");
    });

    it("skips already-approved items without double-counting", async () => {
      const disc = { id: "disc-d2", companyId: COMPANY, pendingItemCount: 1 };

      const alreadyApproved = {
        id: "item-already",
        discussionEntryId: "entry-d2",
        type: "task",
        title: "Already done",
        description: "Already approved.",
        status: "approved", // already approved
        suggestedPriority: null,
        suggestedAssigneeId: null,
        suggestedDepartmentId: null,
        suggestedProjectId: null,
        suggestedGoalId: null,
        suggestedLayer: null,
        priority: null,
        layer: null,
        dedupAction: null,
        selectedMemoryId: null,
        mergedContent: null,
        resultTaskId: "task-old",
      };

      const db = createDiscussionDb([
        [disc],
        // tx.select items
        [alreadyApproved],
        // tx.select entries
        [{ id: "entry-d2" }],
        // No update for pendingItemCount since approvedCount=0
      ]);

      const svc = discussionService(db);
      const result = await svc.approveItems(
        COMPANY,
        "disc-d2",
        ["item-already"],
        ACTOR,
      );

      expect(result.approvedCount).toBe(0);
      expect(result.createdTaskIds).toEqual([]);
      expect(result.createdMemoryIds).toEqual([]);
    });
  });

  // ── 12. Discussion search ─────────────────────────────────────────────────

  describe("12. Discussion search: create discussion with title → search by title via list filters", () => {
    it("lists discussions with status filter", async () => {
      const discRows = [
        { id: "disc-1", title: "Active one", status: "active" },
        { id: "disc-2", title: "Active two", status: "active" },
      ];

      const db = createDiscussionDb([discRows]);

      const svc = discussionService(db);
      const result = await svc.list(COMPANY, { status: "active" });

      expect(result).toHaveLength(2);
      expect(db.select).toHaveBeenCalled();
    });

    it("lists discussions with scopeType and scopeId filters", async () => {
      const discRows = [
        { id: "disc-s1", title: "Dept scoped", scopeType: "department", scopeId: "dept-1" },
      ];

      const db = createDiscussionDb([discRows]);

      const svc = discussionService(db);
      const result = await svc.list(COMPANY, {
        scopeType: "department",
        scopeId: "dept-1",
      });

      expect(result).toHaveLength(1);
    });

    it("lists discussions with hasPendingItems=true filter", async () => {
      const discRows = [
        { id: "disc-p1", title: "Has pending", pendingItemCount: 3 },
      ];

      const db = createDiscussionDb([discRows]);

      const svc = discussionService(db);
      const result = await svc.list(COMPANY, { hasPendingItems: true });

      expect(result).toHaveLength(1);
    });

    it("lists discussions with hasPendingItems=false filter", async () => {
      const discRows = [
        { id: "disc-p2", title: "No pending", pendingItemCount: 0 },
      ];

      const db = createDiscussionDb([discRows]);

      const svc = discussionService(db);
      const result = await svc.list(COMPANY, { hasPendingItems: false });

      expect(result).toHaveLength(1);
    });

    it("lists discussions filtered by inputType (joins with entries)", async () => {
      // When inputType is set, list uses selectDistinctOn + innerJoin
      const discRows = [
        {
          discussions: { id: "disc-v1", title: "Voice discussion" },
        },
      ];

      const db = createDiscussionDb([discRows]);

      const svc = discussionService(db);
      const result = await svc.list(COMPANY, { inputType: "voice" });

      // inputType filter maps through selectDistinctOn path, returns rows.map(r => r.discussions)
      expect(result).toHaveLength(1);
      expect(db.selectDistinctOn).toHaveBeenCalled();
    });

    it("returns empty array when no discussions match", async () => {
      const db = createDiscussionDb([[]]);

      const svc = discussionService(db);
      const result = await svc.list(COMPANY, { status: "archived" });

      expect(result).toHaveLength(0);
    });

    it("enriches list rows with scope, participant preview, and linked thread count", async () => {
      const discRows = [
        {
          id: "disc-1",
          title: "Pricing objections",
          scopeType: "department",
          scopeId: "dept-1",
          pendingItemCount: 2,
        },
      ];

      const db = createDiscussionDb([
        discRows,
        [{ id: "dept-1", name: "Engineering" }],
        [
          {
            threadId: "disc-1",
            principalType: "user",
            principalId: "user-1",
            role: "owner",
            addedAt: new Date("2026-01-01T00:00:00Z"),
            userName: "TK",
            userEmail: "tk@example.com",
            agentName: null,
          },
          {
            threadId: "disc-1",
            principalType: "agent",
            principalId: "agent-1",
            role: "worker",
            addedAt: new Date("2026-01-01T00:01:00Z"),
            userName: null,
            userEmail: null,
            agentName: "Revenue Agent",
          },
        ],
        [{ fromThreadId: "disc-1", toThreadId: "disc-2", kind: "spinoff" }],
      ]);

      const svc = discussionService(db);
      const result = await svc.list(COMPANY, { status: "active" });

      expect(result[0]).toMatchObject({
        id: "disc-1",
        scopeType: "department",
        scopeId: "dept-1",
        scopeName: "Engineering",
        participantPreview: [
          { principalType: "user", principalId: "user-1", name: "TK", role: "owner" },
          { principalType: "agent", principalId: "agent-1", name: "Revenue Agent", role: "worker" },
        ],
        participantCount: 2,
        linkCount: 1,
      });
    });
  });

  // ── Additional: getById ───────────────────────────────────────────────────

  describe("getById: retrieves full discussion with entries, items, annotations", () => {
    it("returns discussion with entries, items, and annotations", async () => {
      const disc = {
        id: "disc-get",
        companyId: COMPANY,
        title: "Full discussion",
        status: "active",
      };
      const entries = [
        {
          entry: { id: "entry-g1", discussionId: "disc-get", inputType: "paste" },
          authorAgentName: null,
          authorAgentAvatar: null,
        },
      ];
      const items = [
        { id: "item-g1", discussionEntryId: "entry-g1", type: "task", title: "A task" },
      ];
      const annotations = [
        { id: "ann-g1", discussionEntryId: "entry-g1", content: "Note" },
      ];

      const db = createDiscussionDb([
        // select discussion
        [disc],
        // select entries
        entries,
        // select items (inArray entryIds)
        items,
        // select annotations (inArray entryIds)
        annotations,
        // Phase E2: select attachments (inArray entryIds)
        [],
        // select plan steps (P5.2)
        [],
        // Phase E batch 2 (T22): select thread_participants (LEFT JOINs)
        [],
      ]);

      const svc = discussionService(db);
      const result = await svc.getById(COMPANY, "disc-get");

      expect(result).toBeTruthy();
      expect(result!.id).toBe("disc-get");
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0].extractedItems).toHaveLength(1);
      expect(result!.entries[0].annotations).toHaveLength(1);
    });

    it("returns null when discussion not found", async () => {
      const db = createDiscussionDb([[]]);

      const svc = discussionService(db);
      const result = await svc.getById(COMPANY, "disc-nope");

      expect(result).toBeNull();
    });

    it("returns empty items and annotations when discussion has no entries", async () => {
      const disc = {
        id: "disc-empty",
        companyId: COMPANY,
        title: "No entries",
        status: "active",
      };

      const db = createDiscussionDb([
        [disc],
        // entries → empty
        [],
        // plan steps → empty (P5.2)
        [],
        // Phase E batch 2 (T22): participants → empty
        [],
      ]);

      const svc = discussionService(db);
      const result = await svc.getById(COMPANY, "disc-empty");

      expect(result).toBeTruthy();
      expect(result!.entries).toHaveLength(0);
    });
  });
});
