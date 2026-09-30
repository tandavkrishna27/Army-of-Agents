// server/src/__tests__/c2-thread-post-scope-proposal.test.ts
//
// Task C2 batch 1 — thread.postScopeProposal tool tests.
// Verifies transactional integrity (entry + plan steps in ONE tx, rollback on
// failure), param validation, and the empty-proposedTasks happy path.
//
// Updated (Task 2.1): the tool now delegates to writeScopeProposal which does
// a companyId-validation SELECT before entering the transaction. Mocks updated
// to include the select chain returning a matching thread row. Contract
// assertions on the tool's result shape, error codes, and param validation are
// preserved unchanged.

import { describe, expect, it, vi } from "vitest";

// Mock publishLiveEvent — called after the transaction in T13's live-delivery fix.
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

import { threadPostScopeProposalTool } from "../services/internal-agent/tools/thread-post-scope-proposal.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// Build a mock tx that tracks inserts. The writer issues (in this order):
//   1. tx.update(discussions)  — bump entrySeq + entryCount (T13 live-delivery)
//   2. tx.insert(discussionEntries).values({...}).returning() — entry
//   3. tx.insert(threadPlanSteps).values([...]) — plan steps (when nonempty)
// We key insert behavior off ordinal rather than schema-table identity.
function makeTxTracker(opts: {
  entryReturn?: any[];
  planInsertThrows?: Error;
} = {}) {
  const insertCalls: Array<{ table: string; values: any }> = [];
  function makeChain(getResult: () => any[], idx: number) {
    const chain: any = {};
    chain.values = (vals: any) => {
      insertCalls[idx].values = vals;
      return chain;
    };
    chain.returning = () => Promise.resolve(getResult());
    chain.then = (resolve: any) => Promise.resolve(resolve(getResult()));
    return chain;
  }
  const insert = vi.fn((_table: any) => {
    const idx = insertCalls.length;
    const isEntryInsert = idx === 0; // first insert = discussion_entries
    const isPlanInsert = idx === 1; // second insert = thread_plan_steps
    const tableLabel = isEntryInsert
      ? "discussion_entries"
      : isPlanInsert
        ? "thread_plan_steps"
        : `insert-${idx}`;
    insertCalls.push({ table: tableLabel, values: undefined });
    if (opts.planInsertThrows && isPlanInsert) {
      throw opts.planInsertThrows;
    }
    if (isEntryInsert) {
      return makeChain(() => opts.entryReturn ?? [{ id: "entry-1", seq: 1 }], idx);
    }
    return makeChain(() => [], idx);
  });
  // T13: tx.update(discussions) bumps entrySeq — returns [{ entrySeq, companyId }].
  const update = vi.fn((_table: any) => ({
    set: (_vals: any) => ({
      where: (_cond: any) => ({
        returning: (_cols: any) =>
          Promise.resolve([{ entrySeq: 1, companyId: "co-1" }]),
      }),
    }),
  }));
  return { insert, update, insertCalls };
}

/**
 * Build a mock `select` chain that returns a thread row matching companyId "co-1".
 * writeScopeProposal calls db.select(...).from(discussions).where(eq(...)) for
 * the Codex-#14 companyId check before entering the transaction.
 */
function makeSelectChain(companyId = "co-1") {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([{ companyId, entrySeq: 0 }]),
  };
}

function makeCtx(transactionFn: any, selectChain?: any): ToolContext {
  const select = vi.fn().mockReturnValue(selectChain ?? makeSelectChain());
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: "agent-42",
    db: { transaction: transactionFn, select },
    services: {} as any,
  } as unknown as ToolContext;
}

describe("thread.postScopeProposal tool (C2 batch 1, D9 transactional)", () => {
  it("metadata: name, category=action, requiredRole=team_member, no confirmation", () => {
    expect(threadPostScopeProposalTool.name).toBe("thread.postScopeProposal");
    expect(threadPostScopeProposalTool.category).toBe("action");
    expect(threadPostScopeProposalTool.requiredRole).toBe("team_member");
    expect(threadPostScopeProposalTool.requiresConfirmation).toBe(false);
  });

  it("posts entry + plan steps in a single transaction", async () => {
    const tracker = makeTxTracker();
    const transactionFn = vi.fn(async (cb: any) => {
      return await cb({ insert: tracker.insert, update: tracker.update });
    });
    const ctx = makeCtx(transactionFn);

    const result = await threadPostScopeProposalTool.execute(
      {
        threadId: "thread-1",
        proposal: {
          summary: "Build the auth flow",
          proposedTasks: [
            { title: "Spec login UI" },
            { title: "Implement JWT issuance" },
            { title: "Add session refresh" },
          ],
        },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect((result.data as any).entryId).toBe("entry-1");
    // 2 insert calls: entry first, then plan steps batch
    expect(tracker.insertCalls.length).toBe(2);
    expect(tracker.insertCalls[0].table).toBe("discussion_entries");
    expect(tracker.insertCalls[1].table).toBe("thread_plan_steps");
    // P1-T7 (#3 root-cause fix): the entry MUST be inserted with
    //   extractionStatus="skipped"  → keeps it out of the autonomous Scribe
    //                                  drain + reprocess sweeps (no inputType
    //                                  filter there) so approval state can't be
    //                                  clobbered by extraction.
    //   proposalStatus="pending"    → the purpose-built approval-lifecycle field
    //                                  the Approve handler claims atomically.
    expect(tracker.insertCalls[0].values).toMatchObject({
      inputType: "scope_proposal",
      extractionStatus: "skipped",
      proposalStatus: "pending",
    });
    // Plan rows: stepOrder 0/1/2 with the titles
    expect(tracker.insertCalls[1].values).toEqual([
      { threadId: "thread-1", stepOrder: 0, title: "Spec login UI", linkedItemId: null },
      { threadId: "thread-1", stepOrder: 1, title: "Implement JWT issuance", linkedItemId: null },
      { threadId: "thread-1", stepOrder: 2, title: "Add session refresh", linkedItemId: null },
    ]);
  });

  it("rolls back the transaction (and returns error) when plan steps insert fails", async () => {
    const tracker = makeTxTracker({
      planInsertThrows: new Error("simulated plan-step DB error"),
    });
    const transactionFn = vi.fn(async (cb: any) => {
      // Simulate Postgres transaction behavior: the callback throws → re-throw.
      // No commit happens, no plan steps persist.
      return await cb({ insert: tracker.insert, update: tracker.update });
    });
    const ctx = makeCtx(transactionFn);

    const result = await threadPostScopeProposalTool.execute(
      {
        threadId: "t-1",
        proposal: {
          summary: "Plan",
          proposedTasks: [{ title: "T1" }],
        },
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("TRANSACTION_FAILED");
    expect(result.summary).toContain("simulated plan-step DB error");
  });

  it("handles empty proposedTasks array (only posts the entry, no plan steps)", async () => {
    const tracker = makeTxTracker();
    const transactionFn = vi.fn(async (cb: any) => {
      return await cb({ insert: tracker.insert, update: tracker.update });
    });
    const ctx = makeCtx(transactionFn);

    const result = await threadPostScopeProposalTool.execute(
      {
        threadId: "t-1",
        proposal: { summary: "Just a summary", proposedTasks: [] },
      },
      ctx,
    );

    expect(result.success).toBe(true);
    // Only entry insert; plan-steps insert is skipped
    expect(tracker.insertCalls.length).toBe(1);
    expect(tracker.insertCalls[0].table).toBe("discussion_entries");
  });

  it("returns INVALID_PARAMS when proposal.summary is missing", async () => {
    const transactionFn = vi.fn();
    const ctx = makeCtx(transactionFn);
    const result = await threadPostScopeProposalTool.execute(
      { threadId: "t-1", proposal: { proposedTasks: [] } },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(transactionFn).not.toHaveBeenCalled();
  });

  it("returns INVALID_PARAMS when threadId is missing", async () => {
    const transactionFn = vi.fn();
    const ctx = makeCtx(transactionFn);
    const result = await threadPostScopeProposalTool.execute(
      { proposal: { summary: "x", proposedTasks: [] } },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(transactionFn).not.toHaveBeenCalled();
  });

  it("rolls back when a proposed task is missing its title", async () => {
    const tracker = makeTxTracker();
    const transactionFn = vi.fn(async (cb: any) => {
      return await cb({ insert: tracker.insert, update: tracker.update });
    });
    const ctx = makeCtx(transactionFn);

    const result = await threadPostScopeProposalTool.execute(
      {
        threadId: "t-1",
        proposal: {
          summary: "Plan",
          proposedTasks: [{ title: "valid" }, { title: "" }],
        },
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("TRANSACTION_FAILED");
    expect(result.summary).toContain("title");
  });
});
