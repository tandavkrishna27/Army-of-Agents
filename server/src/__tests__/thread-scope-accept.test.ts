import { describe, expect, it, vi, beforeEach } from "vitest";

const issueCreate = vi.fn();
const memoryCreate = vi.fn();

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ create: issueCreate }),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({ create: memoryCreate }),
}));

import { threadScopeVersionService } from "../services/thread-scope-versions.js";

type UpdateQueueEntry = any[] | ((input: { data: unknown; where: unknown }) => any[]);

function predicateHasColumnValue(
  predicate: unknown,
  columnName: string,
  value: unknown,
  seen = new Set<unknown>(),
): boolean {
  if (!predicate || typeof predicate !== "object") return false;
  if (seen.has(predicate)) return false;
  seen.add(predicate);

  const record = predicate as Record<PropertyKey, unknown>;
  if ("value" in record && record.value === value) {
    const encoder = record.encoder as { name?: string } | undefined;
    if (encoder?.name === columnName) return true;
  }

  for (const key of Reflect.ownKeys(record)) {
    const child = record[key];
    if (Array.isArray(child)) {
      if (child.some((entry) => predicateHasColumnValue(entry, columnName, value, seen))) {
        return true;
      }
      continue;
    }
    if (predicateHasColumnValue(child, columnName, value, seen)) {
      return true;
    }
  }

  return false;
}

function createSequenceDb(selectQueue: any[][], updateQueue: UpdateQueueEntry[] = [], insertQueue: any[][] = []) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  const capturedInserts: unknown[] = [];
  const capturedUpdates: unknown[] = [];
  const capturedUpdateWheres: unknown[] = [];

  function makeSelectChain() {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
      ),
    };
  }

  function makeUpdateChain() {
    return {
      set: vi.fn((data: unknown) => {
        capturedUpdates.push(data);
        return {
          where: vi.fn((where: unknown) => ({
            returning: vi.fn().mockReturnThis(),
            then: vi.fn((fn: (rows: any[]) => any) => {
              capturedUpdateWheres.push(where);
              const next = updateQueue[updateIdx++] ?? [];
              const rows = typeof next === "function" ? next({ data, where }) : next;
              return Promise.resolve(fn(rows));
            }),
          })),
        };
      }),
    };
  }

  function makeInsertChain() {
    return {
      values: vi.fn((data: unknown) => {
        capturedInserts.push(data);
        return {
          returning: vi.fn().mockReturnThis(),
          then: vi.fn((fn: (rows: any[]) => any) =>
            Promise.resolve(fn(insertQueue[insertIdx++] ?? [])),
          ),
        };
      }),
    };
  }

  const dbObj: any = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
    insert: vi.fn(() => makeInsertChain()),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(dbObj)),
    capturedInserts,
    capturedUpdates,
    capturedUpdateWheres,
  };
  return dbObj;
}

const draftVersion = {
  id: "scope1",
  companyId: "co1",
  threadId: "thread1",
  versionNumber: 1,
  status: "draft",
  sourceEndSeq: 2,
};

const thread = { id: "thread1", companyId: "co1", subtype: "normal", entrySeq: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  issueCreate.mockResolvedValue({
    id: "task1",
    assigneeAgentId: "agent1",
    workMode: "planning",
    sourceDiscussionId: "thread1",
    scopeVersionId: "scope1",
  });
  memoryCreate.mockResolvedValue({ id: "memory1" });
});

describe("threadScopeVersionService.acceptDraft", () => {
  it("accepts the draft version when direct create applies the final actionable card", async () => {
    const draftTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "draft",
      title: "Build scope task",
      description: "Task from scope",
      payload: {
        priority: "high",
        assigneeAgentId: "agent1",
        projectId: "project1",
        labelIds: ["label1", "label2"],
      },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftTask],
      [],
      [{ id: "project1" }], // projectId company-scope validation lookup
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
    ], [
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
      [{ ...draftVersion, status: "accepted" }],
    ]);

    const result = await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({
      ok: true,
      item: expect.objectContaining({ id: "task-item", status: "applied", resultIssueId: "task1" }),
      createdTask: expect.objectContaining({ id: "task1", assigneeAgentId: "agent1" }),
    });
    expect(issueCreate).toHaveBeenCalledWith("co1", expect.objectContaining({
      title: "Build scope task",
      priority: "high",
      projectId: "project1",
      labelIds: ["label1", "label2"],
      sourceDiscussionId: "thread1",
      scopeVersionId: "scope1",
      workMode: "planning",
    }));
    expect(db.capturedUpdates).toHaveLength(2);
    expect(db.capturedUpdates[0]).toMatchObject({
      status: "applied",
      resultIssueId: "task1",
      appliedByUserId: "u1",
    });
    expect(db.capturedUpdates[1]).toMatchObject({
      status: "accepted",
      acceptedByUserId: "u1",
    });
  });

  it("keeps the draft open when direct create leaves another actionable draft card", async () => {
    const draftTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "draft",
      title: "Build scope task",
      description: "Task from scope",
      payload: { priority: "high" },
    };
    const draftMemory = {
      id: "memory-item",
      kind: "memory_candidate",
      status: "draft",
      title: "Remember scope rule",
      description: "Task cards should be reviewed before handoff.",
      payload: { category: "context" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftTask],
      [draftTask, draftMemory],
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }, draftMemory],
    ], [
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
    ]);

    const result = await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({ ok: true });
    expect(db.capturedUpdates).toHaveLength(1);
    expect(db.capturedUpdates[0]).toMatchObject({
      status: "applied",
      resultIssueId: "task1",
    });
  });

  it("creates one task output with selected scope handoff context", async () => {
    const draftTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "draft",
      title: "Build handoff viewer",
      description: "Task from selected scope evidence",
      sourceEntryIds: ["entry-1"],
      payload: {
        priority: "high",
        handoffRefs: [
          { type: "discussion_entry", id: "entry-1", label: "Founder requirement" },
          {
            type: "artifact",
            id: "artifact-document",
            label: "Document reference",
            metadata: { artifactType: "document", artifactVersionId: "version-document" },
          },
          { type: "url", label: "Reference URL", metadata: { url: "https://example.com/scope-reference" } },
        ],
      },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftTask],
    ], [
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
    ]);

    const result = await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({ ok: true });
    expect(issueCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({
        contextBundle: expect.objectContaining({
          sourceDiscussionId: "thread1",
          sourceScopeVersionId: "scope1",
          sourceScopeItemId: "task-item",
          sourceKind: "discussion_scope",
          brief: "Task from selected scope evidence",
          items: expect.arrayContaining([
            expect.objectContaining({ type: "discussion_entry", id: "entry-1", label: "Founder requirement" }),
            expect.objectContaining({
              type: "artifact",
              id: "artifact-document",
              label: "Document reference",
              metadata: expect.objectContaining({ artifactType: "document", artifactVersionId: "version-document" }),
            }),
            expect.objectContaining({
              type: "url",
              label: "Reference URL",
              metadata: { url: "https://example.com/scope-reference" },
            }),
          ]),
        }),
      }),
    );
  });

  it("includes sibling URL source signals in task context bundle when no explicit handoff refs are saved", async () => {
    const draftTask = {
      id: "task-item",
      scopeVersionId: "scope1",
      kind: "task_proposal",
      status: "draft",
      title: "Build with source evidence",
      description: "Task from scope",
      sourceEntryIds: ["entry-1"],
      payload: { priority: "medium" },
    };
    const urlSignal = {
      id: "url-signal",
      scopeVersionId: "scope1",
      kind: "source_signal",
      status: "draft",
      title: "Reference URL",
      description: "External source linked in the thread.",
      sourceEntryIds: ["entry-2"],
      payload: { role: "evidence", url: "https://example.com/scope-reference" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftTask],
      [urlSignal],
    ], [
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
    ]);

    const result = await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({ ok: true });
    expect(issueCreate).toHaveBeenCalledWith("co1", expect.objectContaining({
      contextBundle: expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ type: "discussion_entry", id: "entry-1" }),
          expect.objectContaining({
            type: "url",
            label: "Reference URL",
            metadata: expect.objectContaining({ url: "https://example.com/scope-reference" }),
          }),
        ]),
      }),
    }));
  });

  it("does not accept a draft when applyAcceptedDraft has zero accepted cards", async () => {
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [],
    ]);

    const result = await (threadScopeVersionService(db) as any).applyAcceptedDraft(
      "co1",
      "thread1",
      "scope1",
      { userId: "u1", isHuman: true },
    );

    expect(result).toEqual({
      ok: false,
      reason: "nothing_accepted",
      message: "No accepted scope cards to apply",
    });
    expect(db.capturedUpdates).toEqual([]);
    expect(issueCreate).not.toHaveBeenCalled();
    expect(memoryCreate).not.toHaveBeenCalled();
  });

  it("applies only accepted cards and leaves draft and rejected cards unapplied", async () => {
    const acceptedTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "accepted",
      title: "Build scope task",
      description: "Task from scope",
      payload: { priority: "high", assigneeAgentId: "agent1" },
    };
    const acceptedMemory = {
      id: "memory-item",
      kind: "memory_candidate",
      status: "accepted",
      title: "Decision preference",
      description: "Founder prefers small scope slices.",
      payload: {
        category: "policy",
        layer: "domain",
        departmentId: "dept1",
        projectId: "project1",
        goalId: "goal1",
        folderPath: "Engineering/Policies",
        visibility: "scoped",
        priority: 2,
        tags: ["pricing", "sales"],
      },
    };
    const acceptedArtifact = {
      id: "artifact-item",
      kind: "artifact_link",
      status: "accepted",
      title: "Mockup",
      description: null,
      artifactId: "artifact1",
      artifactVersionId: "artifact-version1",
      payload: { role: "mockup" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [acceptedTask, acceptedMemory, acceptedArtifact],
    ], [
      [{ ...acceptedTask, status: "applied", resultIssueId: "task1" }],
      [{ ...acceptedMemory, status: "applied", resultMemoryId: "memory1" }],
      [{ ...acceptedArtifact, status: "applied" }],
      [{ ...draftVersion, status: "accepted" }],
    ], [[{ id: "link1" }]]);

    const result = await (threadScopeVersionService(db) as any).applyAcceptedDraft(
      "co1",
      "thread1",
      "scope1",
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({
      ok: true,
      alreadyAccepted: false,
      appliedItems: [
        expect.objectContaining({ id: "task-item", kind: "task_proposal", status: "applied" }),
        expect.objectContaining({ id: "memory-item", kind: "memory_candidate", status: "applied" }),
        expect.objectContaining({ id: "artifact-item", kind: "artifact_link", status: "applied" }),
      ],
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.createdTasks).toHaveLength(1);
    expect(issueCreate).toHaveBeenCalledTimes(1);
    expect(issueCreate).toHaveBeenCalledWith("co1", expect.objectContaining({
      title: "Build scope task",
      workMode: "planning",
    }));
    expect(memoryCreate).toHaveBeenCalledTimes(1);
    expect(memoryCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({
        title: "Decision preference",
        content: "Founder prefers small scope slices.",
        category: "policy",
        source: "discussion",
        sourceContext: "thread_scope_version:scope1",
        status: "pending",
        layer: "domain",
        departmentId: "dept1",
        projectId: "project1",
        goalId: "goal1",
        folderPath: "Engineering/Policies",
        visibility: "scoped",
        priority: 2,
        tags: ["pricing", "sales"],
      }),
      expect.anything(),
    );
    expect(db.capturedInserts[0]).toMatchObject({
      companyId: "co1",
      scopeVersionId: "scope1",
      artifactId: "artifact1",
      artifactVersionId: "artifact-version1",
      role: "mockup",
    });
    expect(db.capturedUpdates[3]).toMatchObject({
      status: "accepted",
      acceptedByUserId: "u1",
    });
    expect(db.capturedUpdates).toHaveLength(4);
  });

  it("does not report success when final accepted version update returns no row", async () => {
    const acceptedTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "accepted",
      title: "Build scope task",
      description: "Task from scope",
      payload: { priority: "high", assigneeAgentId: "agent1" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [acceptedTask],
    ], [
      [{ ...acceptedTask, status: "applied", resultIssueId: "task1" }],
      [],
    ]);

    await expect((threadScopeVersionService(db) as any).applyAcceptedDraft(
      "co1",
      "thread1",
      "scope1",
      { userId: "u1", isHuman: true },
    )).rejects.toThrow("Scope draft could not be accepted because it changed during apply");

    expect(issueCreate).toHaveBeenCalledTimes(1);
    expect(db.capturedUpdates).toHaveLength(2);
    expect(db.capturedUpdates[1]).toMatchObject({ status: "accepted" });
  });

  it("does not report success when applying an accepted item update returns no row", async () => {
    const acceptedTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "accepted",
      title: "Build scope task",
      description: "Task from scope",
      payload: { priority: "high", assigneeAgentId: "agent1" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [acceptedTask],
    ], [
      [],
      [{ ...draftVersion, status: "accepted" }],
    ]);

    await expect((threadScopeVersionService(db) as any).applyAcceptedDraft(
      "co1",
      "thread1",
      "scope1",
      { userId: "u1", isHuman: true },
    )).rejects.toThrow("Scope item could not be applied because it changed during apply");

    expect(issueCreate).toHaveBeenCalledTimes(1);
    expect(db.capturedUpdates).toHaveLength(1);
    expect(db.capturedUpdates[0]).toMatchObject({
      status: "applied",
      resultIssueId: "task1",
    });
  });

  it("guards accepted item application against cards changed after load", async () => {
    const acceptedTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "accepted",
      title: "Build scope task",
      description: "Task from scope",
      payload: { priority: "high", assigneeAgentId: "agent1" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [acceptedTask],
    ], [
      ({ where }) => predicateHasColumnValue(where, "status", "accepted")
        ? []
        : [{ ...acceptedTask, status: "applied", resultIssueId: "task1" }],
      [{ ...draftVersion, status: "accepted" }],
    ]);

    await expect((threadScopeVersionService(db) as any).applyAcceptedDraft(
      "co1",
      "thread1",
      "scope1",
      { userId: "u1", isHuman: true },
    )).rejects.toThrow("Scope item could not be applied because it changed during apply");

    expect(issueCreate).toHaveBeenCalledTimes(1);
    expect(db.capturedUpdates).toHaveLength(1);
  });

  it("accepts a draft idempotently", async () => {
    const db = createSequenceDb([
      [{ ...draftVersion, status: "accepted" }],
    ]);

    const result = await threadScopeVersionService(db).acceptDraft(
      "co1",
      "thread1",
      "scope1",
      { itemIds: [] },
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({ ok: true, alreadyAccepted: true });
    expect(issueCreate).not.toHaveBeenCalled();
  });

  it("does not apply a selected item when marking it accepted returns no row", async () => {
    const item = {
      id: "item1",
      kind: "task_proposal",
      status: "draft",
      title: "Build scope task",
      description: "Task from scope",
      payload: { priority: "high", assigneeAgentId: "agent1" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [item],
      [draftVersion],
      [thread],
      [{ ...item, status: "accepted" }],
    ], [
      [],
      [{ ...item, status: "applied" }],
      [{ ...draftVersion, status: "accepted" }],
    ]);

    await expect(threadScopeVersionService(db).acceptDraft(
      "co1",
      "thread1",
      "scope1",
      { itemIds: ["item1"] },
      { userId: "u1", isHuman: true },
    )).rejects.toThrow("Scope item could not be accepted because it changed during apply");

    expect(issueCreate).not.toHaveBeenCalled();
    expect(db.capturedUpdates).toHaveLength(1);
  });

  it("creates tasks with sourceDiscussionId and scopeVersionId", async () => {
    const item = {
      id: "item1",
      kind: "task_proposal",
      status: "draft",
      title: "Build scope task",
      description: "Task from scope",
      payload: { priority: "high", assigneeAgentId: "agent1" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [item],
      [draftVersion],
      [thread],
      [{ ...item, status: "accepted" }],
    ], [
      [{ ...item, status: "accepted" }],
      [{ ...item, status: "applied" }],
      [{ ...draftVersion, status: "accepted" }],
    ]);

    const result = await threadScopeVersionService(db).acceptDraft(
      "co1",
      "thread1",
      "scope1",
      { itemIds: ["item1"] },
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({ ok: true, alreadyAccepted: false });
    if (!result.ok) throw new Error(result.message);
    expect(result.createdTasks[0]).toMatchObject({
      id: "task1",
      sourceDiscussionId: "thread1",
      scopeVersionId: "scope1",
    });
    expect(issueCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({
        sourceDiscussionId: "thread1",
        scopeVersionId: "scope1",
        originKind: "crew_thread",
      }),
    );
  });

  it.each(["document", "presentation", "code", "design", "report", "other"])(
    "creates accepted scope task with %s artifact handoff context",
    async (artifactType) => {
      const item = {
        id: "item1",
        kind: "task_proposal",
        status: "draft",
        title: `Build from ${artifactType}`,
        description: "Task from scope",
        sourceEntryIds: ["entry1"],
        payload: {
          priority: "high",
          handoffRefs: [
            { type: "discussion_entry", id: "entry1", label: "Founder source" },
            {
              type: "artifact",
              id: `artifact-${artifactType}`,
              label: `${artifactType} reference`,
              metadata: { artifactType, artifactVersionId: `version-${artifactType}` },
            },
          ],
        },
      };
      const db = createSequenceDb([
        [draftVersion],
        [thread],
        [item],
        [draftVersion],
        [thread],
        [{ ...item, status: "accepted" }],
      ], [
        [{ ...item, status: "accepted" }],
        [{ ...item, status: "applied", resultIssueId: "task1" }],
        [{ ...draftVersion, status: "accepted" }],
      ]);

      const result = await threadScopeVersionService(db).acceptDraft(
        "co1",
        "thread1",
        "scope1",
        { itemIds: ["item1"] },
        { userId: "u1", isHuman: true },
      );

      expect(result).toMatchObject({ ok: true });
      expect(issueCreate).toHaveBeenCalledWith(
        "co1",
        expect.objectContaining({
          contextBundle: expect.objectContaining({
            sourceDiscussionId: "thread1",
            sourceScopeVersionId: "scope1",
            sourceScopeItemId: "item1",
            sourceKind: "discussion_scope",
            items: expect.arrayContaining([
              expect.objectContaining({
                type: "artifact",
                id: `artifact-${artifactType}`,
                metadata: expect.objectContaining({ artifactType, artifactVersionId: `version-${artifactType}` }),
              }),
            ]),
          }),
        }),
      );
    },
  );

  it("creates pending memory with sourceContext thread_scope_version id", async () => {
    const item = {
      id: "item1",
      kind: "memory_candidate",
      status: "draft",
      title: "Decision preference",
      description: "Founder prefers small scope slices.",
      payload: {
        category: "preference",
        layer: "domain",
        departmentId: "dept1",
        projectId: "project1",
        goalId: "goal1",
        taskId: "task1",
        folderPath: "Engineering/Preferences",
        visibility: "scoped",
        priority: 3,
        tags: ["scope", "founder"],
      },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [item],
      [draftVersion],
      [thread],
      [{ ...item, status: "accepted" }],
    ], [
      [{ ...item, status: "accepted" }],
      [{ ...item, status: "applied" }],
      [{ ...draftVersion, status: "accepted" }],
    ]);

    const result = await threadScopeVersionService(db).acceptDraft(
      "co1",
      "thread1",
      "scope1",
      { itemIds: ["item1"] },
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({ ok: true });
    expect(memoryCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({
        source: "discussion",
        sourceContext: "thread_scope_version:scope1",
        status: "pending",
        category: "preference",
        layer: "domain",
        departmentId: "dept1",
        projectId: "project1",
        goalId: "goal1",
        taskId: "task1",
        folderPath: "Engineering/Preferences",
        visibility: "scoped",
        priority: 3,
        tags: ["scope", "founder"],
      }),
      expect.anything(),
    );
  });

  it("creates one memory output with scoped folder metadata without accepting the whole scope version", async () => {
    const draftMemory = {
      id: "memory-item",
      kind: "memory_candidate",
      status: "draft",
      title: "Pricing rule",
      description: "Use annual prepaid discount only for enterprise contracts.",
      payload: {
        category: "policy",
        layer: "domain",
        departmentId: "dept-id",
        projectId: "project-id",
        folderPath: "Engineering/Policies",
        visibility: "scoped",
        priority: 2,
        tags: ["pricing", "sales"],
      },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftMemory],
    ], [
      [{ ...draftMemory, status: "applied", resultMemoryId: "memory1" }],
    ]);

    const result = await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "memory-item",
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({
      ok: true,
      createdMemoryId: "memory1",
      item: expect.objectContaining({ id: "memory-item", status: "applied", resultMemoryId: "memory1" }),
    });
    expect(memoryCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({
        title: "Pricing rule",
        content: "Use annual prepaid discount only for enterprise contracts.",
        category: "policy",
        source: "discussion",
        sourceContext: "thread_scope_version:scope1",
        layer: "domain",
        departmentId: "dept-id",
        projectId: "project-id",
        folderPath: "Engineering/Policies",
        visibility: "scoped",
        priority: 2,
        tags: ["pricing", "sales"],
        status: "pending",
      }),
      expect.anything(),
    );
  });

  it("creates approved memory when a human explicitly saves approved from scope and approval is authorized", async () => {
    const draftMemory = {
      id: "memory-item",
      kind: "memory_candidate",
      status: "draft",
      title: "Handoff rule",
      description: "Accepted scope is the handoff source.",
      payload: { category: "decision", layer: "domain" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftMemory],
    ], [
      [{ ...draftMemory, status: "applied", resultMemoryId: "memory1" }],
    ]);

    await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "memory-item",
      { userId: "u1", isHuman: true },
      { memoryStatus: "approved", approveMemory: vi.fn().mockResolvedValue(undefined) },
    );

    expect(memoryCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({ status: "approved" }),
      expect.anything(),
    );
  });

  it("does not create approved memory when scope memory approval is denied", async () => {
    const draftMemory = {
      id: "memory-item",
      kind: "memory_candidate",
      status: "draft",
      title: "Domain rule",
      description: "Only approved by authorized memory reviewers.",
      payload: { category: "decision", layer: "domain", departmentId: "dept-1" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftMemory],
    ], [
      [{ ...draftMemory, status: "applied", resultMemoryId: "memory1" }],
    ]);
    const approveMemory = vi.fn().mockRejectedValue(new Error("Insufficient permissions to approve/reject memory items"));

    await expect(threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "memory-item",
      { userId: "u1", isHuman: true },
      { memoryStatus: "approved", approveMemory },
    )).rejects.toThrow("Insufficient permissions to approve/reject memory items");

    expect(approveMemory).toHaveBeenCalledWith({
      layer: "domain",
      departmentId: "dept-1",
    });
    expect(memoryCreate).not.toHaveBeenCalled();
    expect(db.capturedUpdates).toEqual([]);
  });

  it("keeps agent-created memory pending even if approved status is requested", async () => {
    const draftMemory = {
      id: "memory-item",
      kind: "memory_candidate",
      status: "draft",
      title: "Agent proposed memory",
      description: "Needs founder trust.",
      payload: { category: "context", layer: "domain" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftMemory],
    ], [
      [{ ...draftMemory, status: "applied", resultMemoryId: "memory1" }],
    ]);

    await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "memory-item",
      { agentId: "agent1", isHuman: false },
      { memoryStatus: "approved" },
    );

    expect(memoryCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({ status: "pending" }),
      expect.anything(),
    );
  });

  it("writes artifact links for selected artifact_link items", async () => {
    const item = {
      id: "item1",
      kind: "artifact_link",
      status: "draft",
      title: "Mockup",
      description: null,
      artifactId: "artifact1",
      artifactVersionId: "artifact-version1",
      payload: { role: "mockup" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [item],
      [draftVersion],
      [thread],
      [{ ...item, status: "accepted" }],
    ], [
      [{ ...item, status: "accepted" }],
      [{ ...item, status: "applied" }],
      [{ ...draftVersion, status: "accepted" }],
    ], [[{ id: "link1" }]]);

    const result = await threadScopeVersionService(db).acceptDraft(
      "co1",
      "thread1",
      "scope1",
      { itemIds: ["item1"] },
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({ ok: true });
    expect(db.capturedInserts[0]).toMatchObject({
      companyId: "co1",
      scopeVersionId: "scope1",
      artifactId: "artifact1",
      artifactVersionId: "artifact-version1",
      role: "mockup",
    });
  });

  it("returns unsupported-action for split and supersede application", async () => {
    const item = {
      id: "item1",
      kind: "task_change",
      status: "draft",
      title: "Split task",
      description: null,
      payload: { action: "split" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [item],
    ]);

    const result = await threadScopeVersionService(db).acceptDraft(
      "co1",
      "thread1",
      "scope1",
      { itemIds: ["item1"] },
      { userId: "u1", isHuman: true },
    );

    expect(result).toEqual({
      ok: false,
      reason: "unsupported_action",
      message: "Task change action split is not supported in this backend slice",
    });
  });

  it("rejects stale draft acceptance when thread has newer entries", async () => {
    const db = createSequenceDb([
      [draftVersion],
      [{ ...thread, entrySeq: 3 }],
      [{ id: "entry-3", seq: 3, inputType: "write", authorAgentId: null }],
    ]);

    const result = await threadScopeVersionService(db).acceptDraft(
      "co1",
      "thread1",
      "scope1",
      { itemIds: [] },
      { userId: "u1", isHuman: true },
    );

    expect(result).toEqual({
      ok: false,
      reason: "stale",
      message: "Scope draft is stale because the thread has newer human entries",
    });
  });

  it("allows creating output when only background agent entries were added after the draft", async () => {
    const draftTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "draft",
      title: "Build reliable handoff",
      description: "Task from scope",
      sourceEntryIds: ["entry-1"],
      payload: { priority: "medium" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [{ ...thread, entrySeq: 3 }],
      [
        { id: "entry-2", seq: 2, inputType: "agent", authorAgentId: "agent-chronicler" },
        { id: "entry-3", seq: 3, inputType: "agent", authorAgentId: "agent-chronicler" },
      ],
      [draftTask],
    ], [
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
    ]);

    const result = await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({ ok: true });
    expect(issueCreate).toHaveBeenCalledWith("co1", expect.objectContaining({
      title: "Build reliable handoff",
      workMode: "planning",
    }));
  });

  it("rejects creating output when human entries were added after the draft", async () => {
    const db = createSequenceDb([
      [draftVersion],
      [{ ...thread, entrySeq: 3 }],
      [{ id: "entry-3", seq: 3, inputType: "write", authorAgentId: null }],
    ]);

    const result = await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    );

    expect(result).toEqual({
      ok: false,
      reason: "stale",
      message: "Scope draft is stale because the thread has newer human entries",
    });
  });

  it("caps the task context bundle so threads with >20 entries do not trip the 422 limit", async () => {
    // Defect (h): the synthetic fallback task carries one ref per scoped entry.
    // For a thread with >20 entries, the bundle must be capped at 20 so apply
    // does not roll back with a 422 in issueService.create's bundle validation.
    const manyEntryIds = Array.from({ length: 25 }, (_, i) => `entry-${i + 1}`);
    const draftTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "draft",
      title: "Scope work from this discussion",
      description: "Synthetic fallback task",
      sourceEntryIds: manyEntryIds,
      payload: { priority: "medium" }, // no handoffRefs -> fallback refs generated
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftTask],
      [], // relatedItems
    ], [
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
    ]);

    const result = await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({ ok: true });
    const createCall = issueCreate.mock.calls.at(-1)?.[1];
    expect(createCall.contextBundle.items.length).toBeLessThanOrEqual(20);
    expect(createCall.contextBundle.items).toHaveLength(20);
  });

  it("rejects a task_proposal whose payload projectId does not belong to the company", async () => {
    const draftTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "draft",
      title: "Build scope task",
      description: "Task from scope",
      payload: { priority: "high", projectId: "foreign-project" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftTask],
      [], // relatedItems
      [], // projectId lookup -> not found in company
    ]);

    await expect(threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    )).rejects.toThrow("projectId does not belong to this company");

    expect(issueCreate).not.toHaveBeenCalled();
  });

  it("rejects a task_proposal whose payload goalId does not belong to the company", async () => {
    const draftTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "draft",
      title: "Build scope task",
      description: "Task from scope",
      payload: { priority: "high", goalId: "foreign-goal" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftTask],
      [], // relatedItems
      [], // goalId lookup -> not found in company
    ]);

    await expect(threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    )).rejects.toThrow("goalId does not belong to this company");

    expect(issueCreate).not.toHaveBeenCalled();
  });

  it("passes workMode:'standard' to issueService.create when dispatchMode:'standard' is given", async () => {
    const draftTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "draft",
      title: "Standard dispatch task",
      description: "Should be dispatched immediately",
      payload: { priority: "medium" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftTask],
      [],
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
    ], [
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
      [{ ...draftVersion, status: "accepted" }],
    ]);

    await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
      { dispatchMode: "standard" },
    );

    expect(issueCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({ workMode: "standard" }),
    );
  });

  it("defaults workMode to 'planning' when dispatchMode is not given (regression)", async () => {
    const draftTask = {
      id: "task-item",
      kind: "task_proposal",
      status: "draft",
      title: "Planning dispatch task",
      description: "Should stay in planning mode",
      payload: { priority: "medium" },
    };
    const db = createSequenceDb([
      [draftVersion],
      [thread],
      [draftTask],
      [],
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
    ], [
      [{ ...draftTask, status: "applied", resultIssueId: "task1" }],
      [{ ...draftVersion, status: "accepted" }],
    ]);

    await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
    );

    expect(issueCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({ workMode: "planning" }),
    );
  });
});
