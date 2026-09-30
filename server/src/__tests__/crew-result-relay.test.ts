/**
 * P3-T1 — crew-result-relay unit tests.
 *
 * Tests:
 *   relayCrewResult
 *     1. crew-thread issue with sourceDiscussionId → posts exactly ONE entry:
 *        - inputType 'agent'
 *        - authorAgentId = issue.assigneeAgentId
 *        - extractionStatus 'skipped'
 *        - entrySeq bumped (seq assigned from bumped value)
 *        - two live events published (discussion.entry.created, thread.entry.created)
 *        - returns { posted: true }
 *     2. originKind !== 'crew_thread' → no-op, { posted: false }, no insert
 *     3. sourceDiscussionId null → no-op, { posted: false }, no insert
 *     4. issue not found → no-op, { posted: false }
 */

import { describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted before any imports) ───────────────────────────────────────

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ _op: "and", args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  sql: Object.assign(
    vi.fn((_s: unknown) => ({ sql: true })),
    {
      raw: vi.fn((s: unknown) => s),
      placeholder: vi.fn((s: unknown) => s),
    },
  ),
}));

vi.mock("@armyofagents/db", () => {
  function tableProxy(name: string) {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          return `${name}.${String(prop)}`;
        },
      },
    );
  }
  return {
    issues: tableProxy("issues"),
    discussions: tableProxy("discussions"),
    discussionEntries: tableProxy("discussion_entries"),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// ── Imports (after all mocks) ─────────────────────────────────────────────────

import { relayCrewResult } from "../services/crew-result-relay.js";
import { publishLiveEvent } from "../services/live-events.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal crew-thread issue row. */
interface MockIssueRow {
  id: string;
  title: string;
  status: string;
  originKind: string | null;
  sourceDiscussionId: string | null;
  assigneeAgentId: string | null;
  companyId: string;
}

/**
 * Build a mock db whose:
 *   - select().from().where()  → consumes from selectQueue (queue of row arrays)
 *       Queue order: [0] issue row(s), [1] source thread row(s)
 *   - transaction callback → invoked with a txStub that:
 *       tx.update(...).set(...).where(...).returning() → [{ entrySeq: 1, companyId: "co-1" }]
 *       tx.insert(...).values(...).returning() → [insertedEntry]
 */
function makeMockDb(opts: {
  issueRow?: MockIssueRow | null;
  insertedEntry?: Record<string, unknown>;
  /** source thread companyId for the Guard 3 check; defaults to same as issue companyId */
  threadCompanyId?: string | null;
} = {}) {
  const issueRow: MockIssueRow | null =
    opts.issueRow !== undefined
      ? opts.issueRow
      : {
          id: "issue-1",
          title: "Build the API",
          status: "done",
          originKind: "crew_thread",
          sourceDiscussionId: "thread-1",
          assigneeAgentId: "agent-7",
          companyId: "co-1",
        };

  // Default threadCompanyId = same as issue (happy path)
  const threadCompanyId =
    opts.threadCompanyId !== undefined
      ? opts.threadCompanyId
      : issueRow?.companyId ?? "co-1";

  const insertedEntry = opts.insertedEntry ?? { id: "entry-1", seq: 1 };

  const insertValues: Record<string, unknown> = {};

  // Queue of results: [issue select, source-thread companyId select]
  const selectQueue: Array<unknown[]> = [
    issueRow ? [issueRow] : [],
    threadCompanyId != null ? [{ companyId: threadCompanyId }] : [],
  ];
  let selectIdx = 0;

  const txStub = {
    update: vi.fn((_table: unknown) => ({
      set: vi.fn((_vals: unknown) => ({
        where: vi.fn((_cond: unknown) => ({
          returning: vi.fn((_cols: unknown) =>
            Promise.resolve([{ entrySeq: 1, companyId: "co-1" }]),
          ),
        })),
      })),
    })),
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        Object.assign(insertValues, vals);
        return {
          returning: vi.fn(() => Promise.resolve([insertedEntry])),
        };
      }),
    })),
  };

  const db = {
    select: vi.fn((_cols: unknown) => ({
      from: vi.fn((_table: unknown) => ({
        where: vi.fn((_cond: unknown) =>
          Promise.resolve(selectQueue[selectIdx++] ?? []),
        ),
      })),
    })),
    transaction: vi.fn(async (cb: (tx: typeof txStub) => Promise<unknown>) => {
      return cb(txStub);
    }),
  };

  return { db, txStub, insertValues };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("relayCrewResult", () => {
  it("posts one agent entry and returns { posted: true } for a crew-thread issue", async () => {
    const { db, insertValues } = makeMockDb();
    vi.mocked(publishLiveEvent).mockClear();

    const result = await relayCrewResult(db as any, { issueId: "issue-1" });

    // Return value
    expect(result).toEqual({ posted: true });

    // Entry fields
    expect(insertValues.inputType).toBe("agent");
    expect(insertValues.authorAgentId).toBe("agent-7");
    expect(insertValues.createdBy).toBe("agent-7");
    expect(insertValues.extractionStatus).toBe("skipped");
    expect(insertValues.seq).toBe(1); // bumped entrySeq

    // rawContent contains task title and id
    expect(String(insertValues.rawContent)).toContain("Build the API");
    expect(String(insertValues.rawContent)).toContain("issue-1");
  });

  it("publishes discussion.entry.created and thread.entry.created live events", async () => {
    const { db } = makeMockDb();
    vi.mocked(publishLiveEvent).mockClear();

    await relayCrewResult(db as any, { issueId: "issue-1" });

    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(publishLiveEvent).mock.calls;
    expect(calls[0][0].type).toBe("discussion.entry.created");
    expect((calls[0][0].payload as Record<string, unknown>).inputType).toBe("agent");
    expect(calls[1][0].type).toBe("thread.entry.created");
    expect((calls[1][0].payload as Record<string, unknown>).threadId).toBe("thread-1");
  });

  it("is a no-op when originKind !== 'crew_thread'", async () => {
    const { db, txStub } = makeMockDb({
      issueRow: {
        id: "issue-2",
        title: "Some other task",
        status: "done",
        originKind: "routine_execution",
        sourceDiscussionId: "thread-2",
        assigneeAgentId: "agent-3",
        companyId: "co-1",
      },
    });
    vi.mocked(publishLiveEvent).mockClear();

    const result = await relayCrewResult(db as any, { issueId: "issue-2" });

    expect(result).toEqual({ posted: false });
    // transaction must NOT have been called
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("is a no-op when originKind is null", async () => {
    const { db, txStub } = makeMockDb({
      issueRow: {
        id: "issue-3",
        title: "Untagged task",
        status: "done",
        originKind: null,
        sourceDiscussionId: "thread-3",
        assigneeAgentId: "agent-1",
        companyId: "co-1",
      },
    });
    vi.mocked(publishLiveEvent).mockClear();

    const result = await relayCrewResult(db as any, { issueId: "issue-3" });

    expect(result).toEqual({ posted: false });
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("is a no-op when sourceDiscussionId is null", async () => {
    const { db, txStub } = makeMockDb({
      issueRow: {
        id: "issue-4",
        title: "Orphaned crew task",
        status: "done",
        originKind: "crew_thread",
        sourceDiscussionId: null,
        assigneeAgentId: "agent-5",
        companyId: "co-1",
      },
    });
    vi.mocked(publishLiveEvent).mockClear();

    const result = await relayCrewResult(db as any, { issueId: "issue-4" });

    expect(result).toEqual({ posted: false });
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("is a no-op when the issue is not found", async () => {
    const { db, txStub } = makeMockDb({ issueRow: null });
    vi.mocked(publishLiveEvent).mockClear();

    const result = await relayCrewResult(db as any, { issueId: "missing-issue" });

    expect(result).toEqual({ posted: false });
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("is a no-op when the run succeeds before the task reaches done", async () => {
    const { db, txStub } = makeMockDb({
      issueRow: {
        id: "issue-review",
        title: "Awaiting human review",
        status: "in_review",
        originKind: "crew_thread",
        sourceDiscussionId: "thread-review",
        assigneeAgentId: "agent-7",
        companyId: "co-1",
      },
    });
    vi.mocked(publishLiveEvent).mockClear();

    const result = await relayCrewResult(db as any, { issueId: "issue-review" });

    expect(result).toEqual({ posted: false });
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("uses issue.id as createdBy fallback when assigneeAgentId is null", async () => {
    const { db, insertValues } = makeMockDb({
      issueRow: {
        id: "issue-5",
        title: "Unassigned done task",
        status: "done",
        originKind: "crew_thread",
        sourceDiscussionId: "thread-5",
        assigneeAgentId: null,
        companyId: "co-1",
      },
    });

    await relayCrewResult(db as any, { issueId: "issue-5" });

    expect(insertValues.authorAgentId).toBeNull();
    // Falls back to issue.id as sentinel
    expect(insertValues.createdBy).toBe("issue-5");
  });

  // ── Guard 3: multi-tenant companyId cross-check (Codex #6) ───────────────────

  it("is a no-op when source thread belongs to a different company than the issue", async () => {
    const { db, txStub } = makeMockDb({
      issueRow: {
        id: "issue-6",
        title: "Cross-tenant task",
        status: "done",
        originKind: "crew_thread",
        sourceDiscussionId: "thread-6",
        assigneeAgentId: "agent-9",
        companyId: "co-1",
      },
      // Source thread is in a DIFFERENT company — cross-company mismatch
      threadCompanyId: "co-EVIL",
    });
    vi.mocked(publishLiveEvent).mockClear();

    const result = await relayCrewResult(db as any, { issueId: "issue-6" });

    // Must no-op: cross-company write refused
    expect(result).toEqual({ posted: false });
    // transaction must NOT have been called
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("is a no-op when source thread row is not found (Guard 3 treats missing as mismatch)", async () => {
    const { db, txStub } = makeMockDb({
      issueRow: {
        id: "issue-7",
        title: "Orphaned-thread task",
        status: "done",
        originKind: "crew_thread",
        sourceDiscussionId: "thread-7",
        assigneeAgentId: "agent-9",
        companyId: "co-1",
      },
      // No thread row found
      threadCompanyId: null,
    });
    vi.mocked(publishLiveEvent).mockClear();

    const result = await relayCrewResult(db as any, { issueId: "issue-7" });

    expect(result).toEqual({ posted: false });
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });
});
