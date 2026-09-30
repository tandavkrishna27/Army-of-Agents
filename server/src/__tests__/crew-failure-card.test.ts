/**
 * P2-T2 — crew-failure-card unit tests.
 *
 * Tests:
 *   buildCrewFailureSourceInfo — pure builder (no I/O)
 *     1. returns type:"crew_failed" with all fields present
 *     2. truncates error longer than 500 chars (appends "…")
 *     3. short error passes through unchanged
 *
 *   postCrewFailureCard — DB + live-events integration (mocked)
 *     1. inserts a system entry with sourceInfo.type === "crew_failed"
 *     2. the inserted entry has extractionStatus:"skipped" and inputType:"system"
 *     3. does not throw on the happy path
 */

import { describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted before any imports) ───────────────────────────────────────

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
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

import {
  buildCrewFailureSourceInfo,
  postCrewFailureCard,
} from "../services/crew-failure-card.js";
import { publishLiveEvent } from "../services/live-events.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a mock db whose transaction callback is invoked with a tx stub that:
 *   - tx.update(...).set(...).where(...).returning() → [{ entrySeq: 1, companyId: "co-1" }]
 *   - tx.insert(...).values(...).returning() → [{ id: "entry-1", seq: 1 }]
 */
function makeMockDb(opts: {
  insertedEntry?: Record<string, unknown>;
} = {}) {
  const insertedEntry = opts.insertedEntry ?? { id: "entry-1", seq: 1 };

  const insertValues: Record<string, unknown> = {};

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
    transaction: vi.fn(async (cb: (tx: typeof txStub) => Promise<unknown>) => {
      return cb(txStub);
    }),
  };

  return { db, txStub, insertValues };
}

// ── Tests: buildCrewFailureSourceInfo ─────────────────────────────────────────

describe("buildCrewFailureSourceInfo", () => {
  it("returns type:'crew_failed' with all fields", () => {
    const result = buildCrewFailureSourceInfo({
      issueId: "issue-1",
      agentId: "agent-1",
      agentName: "Alice",
      taskTitle: "Write the spec",
      error: "Process exited with code 1",
    });

    expect(result.type).toBe("crew_failed");
    expect(result.issueId).toBe("issue-1");
    expect(result.agentId).toBe("agent-1");
    expect(result.agentName).toBe("Alice");
    expect(result.taskTitle).toBe("Write the spec");
    expect(result.error).toBe("Process exited with code 1");
  });

  it("truncates error longer than 500 chars and appends '…'", () => {
    const longError = "x".repeat(600);
    const result = buildCrewFailureSourceInfo({
      issueId: "i",
      agentId: "a",
      agentName: "Bob",
      taskTitle: "T",
      error: longError,
    });

    expect(result.error.length).toBe(501); // 500 chars + "…" (1 char)
    expect(result.error.endsWith("…")).toBe(true);
    expect(result.error.startsWith("x")).toBe(true);
  });

  it("passes through short errors unchanged", () => {
    const shortError = "timeout";
    const result = buildCrewFailureSourceInfo({
      issueId: "i",
      agentId: "a",
      agentName: "Carol",
      taskTitle: "T",
      error: shortError,
    });

    expect(result.error).toBe("timeout");
  });
});

// ── Tests: postCrewFailureCard ────────────────────────────────────────────────

describe("postCrewFailureCard", () => {
  it("inserts a system entry with sourceInfo.type === 'crew_failed'", async () => {
    const { db, insertValues } = makeMockDb();

    await postCrewFailureCard(db as any, {
      threadId: "thread-1",
      companyId: "co-1",
      issueId: "issue-42",
      agentId: "agent-7",
      agentName: "DeepSeek",
      taskTitle: "Build the landing page",
      error: "OOM at line 12",
    });

    expect(insertValues.inputType).toBe("system");
    expect((insertValues.sourceInfo as Record<string, unknown>).type).toBe("crew_failed");
    expect((insertValues.sourceInfo as Record<string, unknown>).issueId).toBe("issue-42");
    expect((insertValues.sourceInfo as Record<string, unknown>).agentName).toBe("DeepSeek");
  });

  it("sets extractionStatus:'skipped' and inputType:'system'", async () => {
    const { db, insertValues } = makeMockDb();

    await postCrewFailureCard(db as any, {
      threadId: "thread-1",
      companyId: "co-1",
      issueId: "issue-1",
      agentId: "agent-1",
      agentName: "Agent A",
      taskTitle: "Some task",
      error: "failed",
    });

    expect(insertValues.extractionStatus).toBe("skipped");
    expect(insertValues.inputType).toBe("system");
  });

  it("publishes two live events and does not throw on the happy path", async () => {
    const { db } = makeMockDb();
    vi.mocked(publishLiveEvent).mockClear();

    await expect(
      postCrewFailureCard(db as any, {
        threadId: "thread-99",
        companyId: "co-2",
        issueId: "issue-5",
        agentId: "agent-3",
        agentName: "Claude",
        taskTitle: "Write tests",
        error: "exit 1",
      }),
    ).resolves.toBeUndefined();

    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(publishLiveEvent).mock.calls;
    expect(calls[0][0].type).toBe("discussion.entry.created");
    expect(calls[1][0].type).toBe("thread.entry.created");
  });
});
