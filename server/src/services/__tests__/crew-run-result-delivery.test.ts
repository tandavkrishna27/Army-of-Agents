/**
 * Phase 7B / Task 4 — crew "run result" delivery unit tests.
 *
 * `deliverCrewRunResult` posts a NEW `agent` `discussion_entries` row onto the
 * originating thread when a crew run FINISHES — regardless of task status
 * (in-review included; distinct from the `done`-gated "Completed" relay). The
 * entry carries `outputRefs` = the navigational ShowRefs synthesized by
 * `synthesizeThreadDeliveryRefs`, and is idempotent per `runId`.
 *
 * Tests:
 *   1. delivers a new entry with outputRefs on run finish even when task status
 *      is NOT done (in_review) — { delivered: true }, entry has outputRefs +
 *      a per-runId marker, two live events published.
 *   2. idempotent — a prior run-result entry for the same runId → NO second
 *      insert, { delivered: false }.
 *   3. no source thread (sourceDiscussionId null) → no delivery, no throw.
 *   4. RBAC — every synthesized ref's provenance.entityId === threadId (a synth
 *      that returns a mismatched entityId is rejected — never posts).
 *   5. best-effort — a synth/insert error is swallowed (no throw out).
 *
 * Plus a small composition check that postCrewRunSuccess invokes deps.deliver
 * with the threaded runId/agentId when runId is present, and skips it otherwise.
 */

import { describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted before any imports) ───────────────────────────────────────

vi.mock("../live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

// Isolate the synth helper — inject it as a dep too, but mocking the module
// prevents its transitive drizzle/task-output imports from loading here.
vi.mock("../viewer-ref-synthesis.js", () => ({
  synthesizeThreadDeliveryRefs: vi.fn(),
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

vi.mock("../../middleware/logger.js", () => ({
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

import { deliverCrewRunResult } from "../crew-result-relay.js";
import { postCrewRunSuccess } from "../internal-agent/aoa-agents/crew-run-outcome.js";
import { publishLiveEvent } from "../live-events.js";
import type { ShowRef } from "@armyofagents/shared";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MockIssueRow {
  id: string;
  status: string;
  sourceDiscussionId: string | null;
  assigneeAgentId: string | null;
  companyId: string;
}

/** A minimal ShowRef with the given provenance entityId. */
function ref(kind: ShowRef["kind"], id: string, entityId: string): ShowRef {
  return {
    v: 2,
    kind,
    id,
    versionId: null,
    versionNumber: null,
    title: null,
    action: "referenced",
    toolCallId: null,
    mimeType: null,
    provenance: {
      surface: "discussion",
      entityId,
      runId: "run-1",
      agentId: "agent-7",
      messageId: null,
      seq: 0,
      emittedAt: new Date().toISOString(),
    },
  } as ShowRef;
}

/**
 * Build a mock db whose:
 *   - select().from().where()[.limit()]  → consumes from selectQueue
 *       Queue order: [0] issue row(s), [1] prior run-result entry row(s)
 *   - transaction callback → tx.update(...).returning() → [{ entrySeq, companyId }]
 *                            tx.insert(...).returning()  → [insertedEntry]
 */
function makeMockDb(opts: {
  issueRow?: MockIssueRow | null;
  priorEntryRows?: unknown[];
  insertedEntry?: Record<string, unknown>;
} = {}) {
  const issueRow: MockIssueRow | null =
    opts.issueRow !== undefined
      ? opts.issueRow
      : {
          id: "issue-1",
          status: "in_review",
          sourceDiscussionId: "thread-1",
          assigneeAgentId: "agent-7",
          companyId: "co-1",
        };

  const priorEntryRows = opts.priorEntryRows ?? [];
  const insertedEntry = opts.insertedEntry ?? { id: "entry-1", seq: 2 };
  const insertValues: Record<string, unknown> = {};

  const selectQueue: Array<unknown[]> = [
    issueRow ? [issueRow] : [],
    priorEntryRows,
  ];
  let selectIdx = 0;

  const txStub = {
    update: vi.fn((_table: unknown) => ({
      set: vi.fn((_vals: unknown) => ({
        where: vi.fn((_cond: unknown) => ({
          returning: vi.fn((_cols: unknown) =>
            Promise.resolve([{ entrySeq: 2, companyId: "co-1" }]),
          ),
        })),
      })),
    })),
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        Object.assign(insertValues, vals);
        return { returning: vi.fn(() => Promise.resolve([insertedEntry])) };
      }),
    })),
  };

  function whereResult(): Promise<unknown[]> & { limit: (n?: number) => Promise<unknown[]> } {
    const rows = selectQueue[selectIdx++] ?? [];
    const p = Promise.resolve(rows) as Promise<unknown[]> & {
      limit: (n?: number) => Promise<unknown[]>;
    };
    p.limit = () => Promise.resolve(rows);
    return p;
  }

  const db = {
    select: vi.fn((_cols: unknown) => ({
      from: vi.fn((_table: unknown) => ({
        where: vi.fn((_cond: unknown) => whereResult()),
      })),
    })),
    transaction: vi.fn(async (cb: (tx: typeof txStub) => Promise<unknown>) => cb(txStub)),
  };

  return { db, txStub, insertValues };
}

const baseInput = {
  companyId: "co-1",
  issueId: "issue-1",
  runId: "run-1",
  agentId: "agent-7",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("deliverCrewRunResult", () => {
  it("delivers a NEW entry with outputRefs on run finish even when task is NOT done (in_review)", async () => {
    const { db, insertValues, txStub } = makeMockDb();
    vi.mocked(publishLiveEvent).mockClear();

    const refs = [ref("task", "issue-1", "thread-1"), ref("artifact", "art-1", "thread-1")];
    const synth = vi.fn(async () => refs);

    const result = await deliverCrewRunResult({ db: db as any, ...baseInput }, { synthesize: synth });

    expect(result).toEqual({ delivered: true });
    expect(txStub.insert).toHaveBeenCalledTimes(1);

    // Entry shape
    expect(insertValues.inputType).toBe("agent");
    expect(insertValues.extractionStatus).toBe("skipped");
    expect(insertValues.discussionId).toBe("thread-1");
    expect(insertValues.seq).toBe(2);
    expect(insertValues.outputRefs).toEqual(refs);

    // Per-runId idempotency marker in sourceInfo
    expect((insertValues.sourceInfo as Record<string, unknown>).runResultRunId).toBe("run-1");

    // rawContent counts non-task refs (2 refs → 1 non-task result)
    expect(String(insertValues.rawContent)).toMatch(/Run finished/i);
    expect(String(insertValues.rawContent)).toContain("1");

    // Two live pokes
    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(publishLiveEvent).mock.calls;
    expect(calls[0][0].type).toBe("discussion.entry.created");
    expect(calls[1][0].type).toBe("thread.entry.created");
    expect((calls[1][0].payload as Record<string, unknown>).threadId).toBe("thread-1");
  });

  it("is idempotent — a prior run-result entry for the same runId → NO second insert", async () => {
    const { db, txStub } = makeMockDb({
      priorEntryRows: [{ id: "prior-entry" }],
    });
    vi.mocked(publishLiveEvent).mockClear();
    const synth = vi.fn(async () => [ref("task", "issue-1", "thread-1")]);

    const result = await deliverCrewRunResult({ db: db as any, ...baseInput }, { synthesize: synth });

    expect(result).toEqual({ delivered: false });
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(synth).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("no source thread (sourceDiscussionId null) → no delivery, no throw", async () => {
    const { db, txStub } = makeMockDb({
      issueRow: {
        id: "issue-2",
        status: "in_review",
        sourceDiscussionId: null,
        assigneeAgentId: "agent-7",
        companyId: "co-1",
      },
    });
    vi.mocked(publishLiveEvent).mockClear();
    const synth = vi.fn(async () => [ref("task", "issue-2", "thread-x")]);

    const result = await deliverCrewRunResult(
      { db: db as any, ...baseInput, issueId: "issue-2" },
      { synthesize: synth },
    );

    expect(result).toEqual({ delivered: false });
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(synth).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("is a no-op when the issue is not found", async () => {
    const { db, txStub } = makeMockDb({ issueRow: null });
    const synth = vi.fn(async () => [ref("task", "x", "thread-1")]);

    const result = await deliverCrewRunResult({ db: db as any, ...baseInput }, { synthesize: synth });

    expect(result).toEqual({ delivered: false });
    expect(txStub.insert).not.toHaveBeenCalled();
  });

  it("RBAC — rejects synthesized refs whose provenance.entityId != threadId (never posts)", async () => {
    const { db, txStub } = makeMockDb();
    vi.mocked(publishLiveEvent).mockClear();
    // Foreign entityId on the second ref — must be caught, no insert.
    const synth = vi.fn(async () => [
      ref("task", "issue-1", "thread-1"),
      ref("artifact", "art-1", "SOME-OTHER-THREAD"),
    ]);

    const result = await deliverCrewRunResult({ db: db as any, ...baseInput }, { synthesize: synth });

    expect(result).toEqual({ delivered: false });
    expect(txStub.insert).not.toHaveBeenCalled();
    expect(publishLiveEvent).not.toHaveBeenCalled();
  });

  it("best-effort — a synth throw is swallowed (no throw out of the function)", async () => {
    const { db, txStub } = makeMockDb();
    const synth = vi.fn(async () => {
      throw new Error("synth exploded");
    });

    const result = await deliverCrewRunResult({ db: db as any, ...baseInput }, { synthesize: synth });

    expect(result).toEqual({ delivered: false });
    expect(txStub.insert).not.toHaveBeenCalled();
  });

  it("best-effort — an insert throw is swallowed (no throw out of the function)", async () => {
    const { db } = makeMockDb();
    // Make the transaction blow up.
    (db.transaction as any).mockImplementationOnce(async () => {
      throw new Error("insert exploded");
    });
    const synth = vi.fn(async () => [ref("task", "issue-1", "thread-1")]);

    const result = await deliverCrewRunResult({ db: db as any, ...baseInput }, { synthesize: synth });

    expect(result).toEqual({ delivered: false });
  });

  it("rawContent reads 'Run finished' with no count when only the task ref is present", async () => {
    const { db, insertValues } = makeMockDb();
    const synth = vi.fn(async () => [ref("task", "issue-1", "thread-1")]);

    await deliverCrewRunResult({ db: db as any, ...baseInput }, { synthesize: synth });

    expect(String(insertValues.rawContent)).toMatch(/Run finished/i);
  });
});

// ── Composition: postCrewRunSuccess threads runId/agentId → deliver ───────────

describe("postCrewRunSuccess → deliverCrewRunResult wiring", () => {
  const db = {} as any;
  const successInput = {
    companyId: "co-1",
    issueId: "task-1",
    agentName: "Engineer",
    runtimeConfig: {} as Record<string, unknown>,
    startedAtMs: 1_000,
    nowMs: 2_000,
    adapterUsage: undefined,
    costCents: null as number | null,
    runId: "run-9",
    agentId: "agent-9",
  };

  it("invokes deps.deliver with the threaded runId + agentId when runId is present", async () => {
    const relay = vi.fn(async () => ({ posted: true }));
    const summarize = vi.fn(async () => ({ posted: true }));
    const deliver = vi.fn(async () => ({ delivered: true }));

    const result = await postCrewRunSuccess(db, successInput, { relay, summarize, deliver });

    // Return shape is unchanged (no `delivered` field leaks into the contract).
    expect(result).toEqual({ relayed: true, summarized: true });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({
      db,
      companyId: "co-1",
      issueId: "task-1",
      runId: "run-9",
      agentId: "agent-9",
    });
  });

  it("skips delivery when runId is absent (legacy caller)", async () => {
    const relay = vi.fn(async () => ({ posted: true }));
    const summarize = vi.fn(async () => ({ posted: true }));
    const deliver = vi.fn(async () => ({ delivered: true }));

    const { runId: _omit, ...noRunId } = successInput;
    await postCrewRunSuccess(db, noRunId, { relay, summarize, deliver });

    expect(deliver).not.toHaveBeenCalled();
  });

  it("a deliver throw is isolated — never fails the run (relay/summary still counted)", async () => {
    const relay = vi.fn(async () => ({ posted: true }));
    const summarize = vi.fn(async () => ({ posted: true }));
    const deliver = vi.fn(async () => {
      throw new Error("deliver exploded");
    });

    const result = await postCrewRunSuccess(db, successInput, { relay, summarize, deliver });

    expect(result).toEqual({ relayed: true, summarized: true });
  });
});
