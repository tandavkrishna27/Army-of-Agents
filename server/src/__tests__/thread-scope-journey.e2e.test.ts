import { beforeEach, describe, expect, it, vi } from "vitest";

const issueCreate = vi.fn();
const memoryCreate = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ create: issueCreate }),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({ create: memoryCreate }),
}));

import { threadScopeVersionService } from "../services/thread-scope-versions.js";

function createJourneyDb(config: {
  selects?: any[][];
  inserts?: any[][];
  updates?: any[][];
}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let updateIdx = 0;
  const captured = {
    inserts: [] as unknown[],
    updates: [] as unknown[],
  };

  function makeSelectChain() {
    return {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((resolve: (rows: any[]) => unknown) =>
        Promise.resolve(resolve(config.selects?.[selectIdx++] ?? [])),
      ),
    };
  }

  function makeInsertChain() {
    return {
      values: vi.fn((value: unknown) => {
        captured.inserts.push(value);
        return {
          returning: vi.fn().mockReturnThis(),
          then: vi.fn((resolve: (rows: any[]) => unknown) =>
            Promise.resolve(resolve(config.inserts?.[insertIdx++] ?? [])),
          ),
        };
      }),
    };
  }

  function makeUpdateChain() {
    return {
      set: vi.fn((value: unknown) => {
        captured.updates.push(value);
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockReturnThis(),
            then: vi.fn((resolve: (rows: any[]) => unknown) =>
              Promise.resolve(resolve(config.updates?.[updateIdx++] ?? [])),
            ),
          })),
        };
      }),
    };
  }

  const db: any = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => makeInsertChain()),
    update: vi.fn(() => makeUpdateChain()),
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
    captured,
  };
  return db;
}

describe("thread scope journey E2E", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issueCreate.mockResolvedValue({
      id: "task-1",
      assigneeAgentId: "agent-eng",
      workMode: "standard",
      sourceDiscussionId: "thread-1",
      scopeVersionId: "scope-1",
    });
    memoryCreate.mockResolvedValue({ id: "memory-1" });
  });

  it("starts from a work thread, creates a scope draft, accepts it, and applies task plus memory handoffs", async () => {
    const thread = {
      id: "thread-1",
      companyId: "co-1",
      subtype: "normal",
      entrySeq: 2,
    };
    const draft = {
      id: "scope-1",
      companyId: "co-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 2,
    };
    const taskItem = {
      id: "item-task",
      scopeVersionId: "scope-1",
      kind: "task_proposal",
      status: "draft",
      title: "Build scoped onboarding checklist",
      description: "Create the checklist agreed in the thread.",
      payload: {
        priority: "high",
        assigneeAgentId: "agent-eng",
        projectId: "project-1",
        goalId: "goal-1",
      },
    };
    const memoryItem = {
      id: "item-memory",
      scopeVersionId: "scope-1",
      kind: "memory_candidate",
      status: "accepted",
      title: "Founder scope preference",
      description: "Prefer small accepted scope versions as task handoff points.",
      payload: {
        layer: "domain",
        category: "preference",
        departmentId: "dept-1",
        goalId: "goal-1",
      },
    };
    const db = createJourneyDb({
      selects: [
        [thread],
        [],
        [
          {
            id: "entry-1",
            discussionId: "thread-1",
            seq: 1,
            inputType: "write",
            rawContent: "Ship the onboarding checklist as the first scoped work item.",
          },
          {
            id: "entry-2",
            discussionId: "thread-1",
            seq: 2,
            inputType: "write",
            rawContent: "Use accepted scope as the handoff point and create memory.",
          },
        ],
        [],
        [],
        [draft],
        [thread],
        [{ ...taskItem, status: "accepted" }, memoryItem],
        // projectId / goalId company-scope validation lookups for the task item.
        [{ id: "project-1" }],
        [{ id: "goal-1" }],
      ],
      inserts: [[draft]],
      updates: [
        [{ ...taskItem, status: "applied", resultIssueId: "task-1" }],
        [{ ...memoryItem, status: "applied", resultMemoryId: "memory-1" }],
        [{ ...draft, status: "accepted" }],
      ],
    });
    const service = threadScopeVersionService(db);

    const created = await service.createDraftFromThread(
      "co-1",
      "thread-1",
      { userId: "founder-1", isHuman: true },
      {
        summary: "Ship the onboarding checklist as the first scoped work item.",
        decisions: ["Use accepted scope as the handoff point"],
      },
    );

    expect(created).toEqual({ status: "created", version: draft });

    const accepted = await service.applyAcceptedDraft(
      "co-1",
      "thread-1",
      "scope-1",
      { userId: "founder-1", isHuman: true },
    );

    expect(accepted).toMatchObject({
      ok: true,
      alreadyAccepted: false,
      createdTasks: [{
        id: "task-1",
        sourceDiscussionId: "thread-1",
        scopeVersionId: "scope-1",
      }],
      appliedItems: [
        { id: "item-task", kind: "task_proposal", status: "applied" },
        { id: "item-memory", kind: "memory_candidate", status: "applied" },
      ],
    });
    expect(issueCreate).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({
        title: "Build scoped onboarding checklist",
        sourceDiscussionId: "thread-1",
        scopeVersionId: "scope-1",
        originKind: "crew_thread",
        projectId: "project-1",
        goalId: "goal-1",
      }),
    );
    expect(memoryCreate).toHaveBeenCalledWith(
      "co-1",
      expect.objectContaining({
        title: "Founder scope preference",
        source: "discussion",
        sourceContext: "thread_scope_version:scope-1",
        status: "pending",
        departmentId: "dept-1",
        goalId: "goal-1",
      }),
      expect.anything(),
    );
  });

  it("creates v2 from only the new messages after accepted v1", async () => {
    const threadV1 = {
      id: "thread-1",
      companyId: "co-1",
      subtype: "normal",
      title: "Scope cycle",
      summaryText: null,
      entrySeq: 3,
    };
    const threadV2 = { ...threadV1, entrySeq: 4 };
    const draftV1 = {
      id: "scope-1",
      companyId: "co-1",
      threadId: "thread-1",
      versionNumber: 1,
      status: "draft",
      sourceStartSeq: 1,
      sourceEndSeq: 3,
    };
    const acceptedV1 = { ...draftV1, status: "accepted" };
    const draftV2 = {
      id: "scope-2",
      companyId: "co-1",
      threadId: "thread-1",
      versionNumber: 2,
      status: "draft",
      sourceStartSeq: 4,
      sourceEndSeq: 4,
      baseVersionId: "scope-1",
    };

    const db = createJourneyDb({
      selects: [
        [threadV1],
        [],
        [
          {
            id: "entry-1",
            discussionId: "thread-1",
            seq: 1,
            inputType: "write",
            rawContent: "Scope should be deliberate and consider the whole conversation.",
          },
          {
            id: "entry-2",
            discussionId: "thread-1",
            seq: 2,
            inputType: "write",
            rawContent: "Accepted scope v1 should become the source of truth for tasks.",
          },
          {
            id: "entry-3",
            discussionId: "thread-1",
            seq: 3,
            inputType: "write",
            rawContent: "Memory should be retrievable by agents during task execution.",
          },
        ],
        [],
        [],
        [threadV2],
        [acceptedV1],
        [
          {
            id: "entry-4",
            discussionId: "thread-1",
            seq: 4,
            inputType: "write",
            rawContent: "After review, include analytics instrumentation in this same handoff.",
          },
        ],
        [],
        [],
      ],
      inserts: [[draftV1], [], [draftV2], []],
    });
    const service = threadScopeVersionService(db);

    const createdV1 = await service.createDraftFromThread(
      "co-1",
      "thread-1",
      { userId: "founder-1", isHuman: true },
      { mode: "generate" },
    );
    const createdV2 = await service.createDraftFromThread(
      "co-1",
      "thread-1",
      { userId: "founder-1", isHuman: true },
      { mode: "generate" },
    );

    expect(createdV1).toEqual({ status: "created", version: draftV1 });
    expect(createdV2).toEqual({ status: "created", version: draftV2 });

    const v1VersionInsert = db.captured.inserts[0] as Record<string, unknown>;
    const v1ItemsInsert = db.captured.inserts[1] as Array<{ title: string; sourceEntryIds: string[] }>;
    const v2VersionInsert = db.captured.inserts[2] as Record<string, unknown>;
    const v2ItemsInsert = db.captured.inserts[3] as Array<{ description: string; sourceEntryIds: string[] }>;

    expect(v1VersionInsert).toMatchObject({ sourceStartSeq: 1, sourceEndSeq: 3, versionNumber: 1 });
    expect(v1ItemsInsert[0]?.sourceEntryIds).toEqual(["entry-1", "entry-2", "entry-3"]);
    expect(v1ItemsInsert.map((item) => item.title)).toEqual(
      expect.arrayContaining(["Accepted scope versions are handoff source of truth"]),
    );
    expect(v2VersionInsert).toMatchObject({
      sourceStartSeq: 4,
      sourceEndSeq: 4,
      versionNumber: 2,
      baseVersionId: "scope-1",
    });
    expect(v2ItemsInsert[0]?.sourceEntryIds).toEqual(["entry-4"]);
    expect(v2ItemsInsert[0]?.description).toContain("analytics instrumentation");
  });
});
