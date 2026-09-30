/**
 * W1b Contract Test: dispatchMode → workMode + auto-accept gate stability
 *
 * Locks two contracts that the W1b autonomy-gated auto-accept relies on:
 *   (a) resolveScopeAutoAcceptGate — the 3-way gate mapping must not drift.
 *       Any change to 0→draft_only / 1→accept_apply / ≥2→accept_apply_dispatch
 *       silently changes the auto-accept behaviour for existing customers.
 *   (b) createOutputItem dispatchMode → workMode — the Drive path sets
 *       dispatchMode:"standard" to make the task dispatchable; if the mapping
 *       ever breaks, Drive tasks silently land in planning mode and never fire.
 *
 * (b) is also covered in depth by thread-scope-accept.test.ts (T2).
 * This file re-asserts the critical boundary at the contract level so the
 * two properties are co-located and visible to reviewers touching W1b.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── (b) Mock issueService before importing thread-scope-versions ─────────────
const issueCreate = vi.fn();
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ create: issueCreate }),
}));
vi.mock("../services/memory.js", () => ({
  memoryService: () => ({ create: vi.fn() }),
}));

// ── Real imports ─────────────────────────────────────────────────────────────
import { resolveScopeAutoAcceptGate } from "../services/crew-task-service.js";
import { threadScopeVersionService } from "../services/thread-scope-versions.js";

// ── Minimal DB harness (mirrors thread-scope-accept.test.ts createSequenceDb) ─
function createSequenceDb(selectQueue: any[][], updateQueue: any[][] = []) {
  let selectIdx = 0;
  let updateIdx = 0;
  const capturedUpdates: unknown[] = [];

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
          where: vi.fn(() => ({
            returning: vi.fn().mockReturnThis(),
            then: vi.fn((fn: (rows: any[]) => any) =>
              Promise.resolve(fn(updateQueue[updateIdx++] ?? [])),
            ),
          })),
        };
      }),
    };
  }

  const db: any = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
    insert: vi.fn(),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db)),
    capturedUpdates,
  };
  return db;
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
    assigneeAgentId: null,
    workMode: "planning",
    sourceDiscussionId: "thread1",
    scopeVersionId: "scope1",
  });
});

// ── (a) Gate mapping contract ─────────────────────────────────────────────────
describe("CONTRACT (a): resolveScopeAutoAcceptGate — 3-way gate is stable", () => {
  it("maps level 0 (Manual) → draft_only", () => {
    expect(resolveScopeAutoAcceptGate(0)).toBe("draft_only");
  });

  it("maps level 1 (Assist) → accept_apply", () => {
    expect(resolveScopeAutoAcceptGate(1)).toBe("accept_apply");
  });

  it("maps level 2 (Drive) → accept_apply_dispatch", () => {
    expect(resolveScopeAutoAcceptGate(2)).toBe("accept_apply_dispatch");
  });

  it("clamps ≥3 up to accept_apply_dispatch (no higher mode)", () => {
    expect(resolveScopeAutoAcceptGate(3)).toBe("accept_apply_dispatch");
    expect(resolveScopeAutoAcceptGate(10)).toBe("accept_apply_dispatch");
  });

  it("fails closed for null → draft_only (no auto-accept when autonomy unknown)", () => {
    expect(resolveScopeAutoAcceptGate(null)).toBe("draft_only");
  });

  it("fails closed for undefined → draft_only", () => {
    expect(resolveScopeAutoAcceptGate(undefined)).toBe("draft_only");
  });

  it("fails closed for negative → draft_only", () => {
    expect(resolveScopeAutoAcceptGate(-1)).toBe("draft_only");
  });
});

// ── (b) dispatchMode → workMode contract ─────────────────────────────────────
describe("CONTRACT (b): createOutputItem dispatchMode sets task workMode", () => {
  const taskItem = {
    id: "task-item",
    kind: "task_proposal",
    status: "draft",
    title: "Crew task",
    description: "Drive path task",
    payload: { priority: "medium" },
  };

  it("dispatchMode:'standard' (Drive) → workMode:'standard' on created issue", async () => {
    const db = createSequenceDb(
      [
        [draftVersion],
        [thread],
        [taskItem],
        [], // relatedItems
        [{ ...taskItem, status: "applied", resultIssueId: "task1" }],
      ],
      [
        [{ ...taskItem, status: "applied", resultIssueId: "task1" }],
        [{ ...draftVersion, status: "accepted" }],
      ],
    );

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

  it("omitting dispatchMode (Assist / default) → workMode:'planning' (regression guard)", async () => {
    const db = createSequenceDb(
      [
        [draftVersion],
        [thread],
        [taskItem],
        [], // relatedItems
        [{ ...taskItem, status: "applied", resultIssueId: "task1" }],
      ],
      [
        [{ ...taskItem, status: "applied", resultIssueId: "task1" }],
        [{ ...draftVersion, status: "accepted" }],
      ],
    );

    await threadScopeVersionService(db).createOutputItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { userId: "u1", isHuman: true },
      // no dispatchMode option — default
    );

    expect(issueCreate).toHaveBeenCalledWith(
      "co1",
      expect.objectContaining({ workMode: "planning" }),
    );
  });
});
