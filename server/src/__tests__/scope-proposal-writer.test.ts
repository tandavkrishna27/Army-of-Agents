// server/src/__tests__/scope-proposal-writer.test.ts
//
// Task 2.1 (Crew Work-as-Tasks): writeScopeProposal unit tests.
//
// Three cases:
//   (a) companyId mismatch → throws COMPANY_MISMATCH
//   (b) happy path → writes entry + plan-steps, returns existing:false
//   (c) pending-proposal unique violation → returns existing:true with existing entry id

import { describe, expect, it, vi } from "vitest";

// Mock publishLiveEvent — not under test here; we just want it not to throw.
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

import { writeScopeProposal } from "../services/scope-proposal-writer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROPOSAL = {
  summary: "Build the auth flow",
  proposedTasks: [
    { title: "Spec login UI" },
    { title: "Implement JWT issuance" },
  ],
};

const CONSTRAINT_NAME = "discussion_entries_one_pending_scope_proposal_idx";

/**
 * Simulate the Drizzle/postgres-js unique-violation shape.
 * The error must have code "23505" and constraint matching the index name
 * so that isUniqueViolation(..., CONSTRAINT_NAME) returns true.
 */
function makeUniqueViolationError(constraint: string): Error {
  const err: any = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  err.code = "23505";
  err.constraint = constraint;
  return err;
}

// ── Mock DB builder ───────────────────────────────────────────────────────────

/**
 * Build a mock `db` whose `select` path returns the given thread row and
 * whose `transaction` executes the callback with a `tx` that either succeeds
 * or throws `txError`.
 */
function makeDb(opts: {
  /** Row returned by SELECT on discussions (null = thread not found). */
  threadRow?: { companyId: string; entrySeq: number } | null;
  /** Return value from the entry insert. */
  entryReturn?: any[];
  /** If set, the transaction callback throws this error after the first insert. */
  txError?: Error;
  /** Id of the existing pending entry (for SELECT after unique-violation). */
  existingEntryId?: string;
}) {
  const {
    threadRow = { companyId: "co-1", entrySeq: 3 },
    entryReturn = [{ id: "entry-new-1", seq: 4 }],
    txError,
    existingEntryId = "entry-existing-1",
  } = opts;

  // Track insert calls so tests can inspect them.
  const insertCalls: Array<{ values: any }> = [];

  // select() chain: returns threadRow for the pre-tx companyId check,
  // and existingEntryId row for the post-violation SELECT.
  let selectCallCount = 0;
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) {
        // First select: thread companyId check
        return Promise.resolve(threadRow ? [threadRow] : []);
      }
      // Second select: find existing pending scope_proposal entry
      return Promise.resolve([{ id: existingEntryId }]);
    }),
  };
  const select = vi.fn().mockReturnValue(selectChain);

  // tx.update(discussions) — bumps entrySeq + entryCount, returns [{ entrySeq, companyId }]
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([
      {
        entrySeq: (threadRow?.entrySeq ?? 0) + 1,
        companyId: threadRow?.companyId ?? "co-1",
      },
    ]),
  };
  const update = vi.fn().mockReturnValue(updateChain);

  // tx.insert() chain — entry first, plan steps second.
  const insert = vi.fn().mockImplementation((_table: any) => {
    const idx = insertCalls.length;
    const isEntry = idx === 0;
    insertCalls.push({ values: undefined });

    const returningMock = vi.fn().mockResolvedValue(isEntry ? entryReturn : []);

    if (!isEntry && txError) {
      // plan-steps insert throws (simulates unique violation or other error)
      const chain: any = {
        values: vi.fn().mockImplementation((vals: any) => {
          insertCalls[idx].values = vals;
          throw txError;
        }),
        returning: returningMock,
      };
      return chain;
    }

    const chain: any = {
      values: vi.fn().mockImplementation((vals: any) => {
        insertCalls[idx].values = vals;
        // For entry insert: if txError triggers ON the entry insert itself
        if (isEntry && txError) throw txError;
        return chain;
      }),
      returning: returningMock,
    };
    return chain;
  });

  const transaction = vi.fn().mockImplementation(async (cb: any) => {
    return await cb({ insert, update });
  });

  return {
    db: { select, transaction } as any,
    insertCalls,
    select,
    update,
    insert,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("writeScopeProposal", () => {
  // (a) companyId mismatch
  describe("companyId validation (security — Codex #14)", () => {
    it("throws COMPANY_MISMATCH when thread is not found", async () => {
      const { db } = makeDb({ threadRow: null });
      await expect(
        writeScopeProposal(db, {
          threadId: "thread-1",
          companyId: "co-1",
          proposal: PROPOSAL,
          agentId: "agent-1",
        }),
      ).rejects.toThrow("COMPANY_MISMATCH");
    });

    it("throws COMPANY_MISMATCH when thread belongs to a different company", async () => {
      const { db } = makeDb({ threadRow: { companyId: "co-OTHER", entrySeq: 2 } });
      await expect(
        writeScopeProposal(db, {
          threadId: "thread-1",
          companyId: "co-1",
          proposal: PROPOSAL,
          agentId: "agent-1",
        }),
      ).rejects.toThrow("COMPANY_MISMATCH");
    });

    it("does NOT enter the transaction when the company check fails", async () => {
      const { db, db: { transaction } } = makeDb({ threadRow: null });
      await expect(
        writeScopeProposal(db, {
          threadId: "thread-1",
          companyId: "co-1",
          proposal: PROPOSAL,
          agentId: null,
        }),
      ).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  // (b) happy path
  describe("happy path", () => {
    it("returns existing:false with entryId and proposalCursorSeq", async () => {
      const { db } = makeDb({});
      const result = await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: PROPOSAL,
        agentId: "agent-1",
      });
      expect(result.existing).toBe(false);
      expect(result.entryId).toBe("entry-new-1");
      expect(typeof result.proposalCursorSeq).toBe("number");
    });

    it("sets proposalCursorSeq to the proposal entry's OWN seq (post-bump, NOT pre-bump)", async () => {
      // Regression test for the P0 stale-check bug:
      // Before the fix, proposalCursorSeq was stamped as the pre-bump value (N=7).
      // After the fix it equals the post-bump value (N+1=8) — the proposal's own seq.
      // This ensures the stale check (currentSeq > stampedSeq) is FALSE for a fresh
      // proposal (thread.entrySeq == 8 after the write, stampedSeq == 8 → not stale)
      // and TRUE only when a genuinely newer entry arrives (entrySeq > 8).
      const { db } = makeDb({ threadRow: { companyId: "co-1", entrySeq: 7 } });
      const result = await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: PROPOSAL,
        agentId: "agent-1",
      });
      // The mock's UPDATE ... RETURNING returns entrySeq = 7 + 1 = 8.
      // proposalCursorSeq must equal the bumped value (8), NOT the pre-bump (7).
      expect(result.proposalCursorSeq).toBe(8);
    });

    it("inserts entry with extractionStatus=skipped and proposalStatus=pending (D9)", async () => {
      const { db, insertCalls } = makeDb({});
      await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: PROPOSAL,
        agentId: "agent-42",
      });
      // First insert is the entry
      expect(insertCalls[0].values).toMatchObject({
        discussionId: "thread-1",
        inputType: "scope_proposal",
        extractionStatus: "skipped",
        proposalStatus: "pending",
        authorAgentId: "agent-42",
      });
    });

    it("rawContent includes proposalCursorSeq (post-bump) + proposal fields", async () => {
      // Regression: rawContent must embed the post-bump seq (N+1), not the pre-bump (N).
      // threadRow.entrySeq = 5 → UPDATE RETURNING gives 6 → proposalCursorSeq in rawContent = 6.
      const { db, insertCalls } = makeDb({ threadRow: { companyId: "co-1", entrySeq: 5 } });
      await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: PROPOSAL,
        agentId: null,
      });
      const parsed = JSON.parse(insertCalls[0].values.rawContent);
      // Must be the post-bump value (6), NOT the pre-bump (5).
      expect(parsed.proposalCursorSeq).toBe(6);
      expect(parsed.summary).toBe(PROPOSAL.summary);
      expect(Array.isArray(parsed.proposedTasks)).toBe(true);
    });

    it("inserts plan-steps with correct threadId, stepOrder, and title", async () => {
      const { db, insertCalls } = makeDb({});
      await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: {
          summary: "Plan",
          proposedTasks: [{ title: "Step A" }, { title: "Step B" }],
        },
        agentId: null,
      });
      // Second insert is plan steps
      expect(insertCalls.length).toBe(2);
      expect(insertCalls[1].values).toEqual([
        { threadId: "thread-1", stepOrder: 0, title: "Step A", linkedItemId: null },
        { threadId: "thread-1", stepOrder: 1, title: "Step B", linkedItemId: null },
      ]);
    });

    it("skips plan-steps insert when proposedTasks is empty (only 1 insert)", async () => {
      const { db, insertCalls } = makeDb({});
      await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: { summary: "Summary only", proposedTasks: [] },
        agentId: null,
      });
      expect(insertCalls.length).toBe(1);
    });

    it("uses authorAgentId=null and createdBy='aoa-agent' when agentId is null", async () => {
      const { db, insertCalls } = makeDb({});
      await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: PROPOSAL,
        agentId: null,
      });
      expect(insertCalls[0].values.authorAgentId).toBeNull();
      expect(insertCalls[0].values.createdBy).toBe("aoa-agent");
    });

    it("publishes two live events on success", async () => {
      const { publishLiveEvent } = await import("../services/live-events.js");
      (publishLiveEvent as ReturnType<typeof vi.fn>).mockClear();

      const { db } = makeDb({});
      await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: PROPOSAL,
        agentId: null,
      });
      expect(publishLiveEvent).toHaveBeenCalledTimes(2);
      const calls = (publishLiveEvent as ReturnType<typeof vi.fn>).mock.calls;
      const types = calls.map(([arg]: [any]) => arg.type);
      expect(types).toContain("discussion.entry.created");
      expect(types).toContain("thread.entry.created");
    });

    // REGRESSION TEST (P0 fix): fresh proposal is never stale
    // This reproduces the exact arithmetic that caused the bug:
    //   Pre-fix:  proposalCursorSeq = N (pre-bump)
    //             After write: thread.entrySeq = N+1
    //             Stale check: N+1 > N → ALWAYS stale (bug)
    //   Post-fix: proposalCursorSeq = N+1 (own seq, post-bump)
    //             After write: thread.entrySeq = N+1
    //             Stale check: N+1 > N+1 → false → NOT stale (correct)
    it("REGRESSION: proposalCursorSeq == thread.entrySeq after write (fresh proposal is not stale)", async () => {
      const PRE_BUMP_SEQ = 10;
      const { db } = makeDb({ threadRow: { companyId: "co-1", entrySeq: PRE_BUMP_SEQ } });
      const result = await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: PROPOSAL,
        agentId: null,
      });

      // The proposal entry's own seq is PRE_BUMP_SEQ + 1 = 11.
      // The thread's entrySeq after the write is also 11.
      // proposalCursorSeq MUST equal 11 so the stale check (currentSeq > stampedSeq)
      // evaluates: 11 > 11 = false → NOT stale.
      const POST_BUMP_SEQ = PRE_BUMP_SEQ + 1;
      expect(result.proposalCursorSeq).toBe(POST_BUMP_SEQ);

      // Confirm the rawContent also embeds the correct post-bump value.
      // (The stale check reads proposalCursorSeq FROM rawContent.)
    });
  });

  // (c) unique-violation → existing:true
  describe("one-pending-per-thread guard (idempotency)", () => {
    it("returns existing:true with the PENDING PROPOSAL's entry id (not an arbitrary entry) when unique violation fires", async () => {
      // Bug regression: the old unfiltered `.where(eq(discussionId, threadId))` returned
      // the FIRST entry for the thread (likely the oldest, non-proposal entry).
      // The fix adds `inputType='scope_proposal' AND proposalStatus='pending'` filters.
      //
      // This test has two entries in the mock:
      //   - "entry-old-unrelated" — an older non-proposal entry (oldest → returned first by unfiltered query)
      //   - "entry-pending-proposal-99" — the actual pending scope_proposal
      //
      // The mock's second select (post-violation) inspects the where-clause argument:
      //   - If the where clause is missing inputType/proposalStatus conditions → returns the wrong old entry
      //   - If the where clause contains both conditions → returns the correct pending proposal entry
      //
      // With the old unfiltered code, result.entryId would be "entry-old-unrelated" → assertion fails.
      // With the fix, result.entryId is "entry-pending-proposal-99" → assertion passes.
      const uniqueErr = makeUniqueViolationError(CONSTRAINT_NAME);

      const insertCalls: Array<{ values: any }> = [];
      const throwingInsert = vi.fn().mockImplementation((_table: any) => {
        const idx = insertCalls.length;
        insertCalls.push({ values: undefined });
        const chain: any = {
          values: vi.fn().mockImplementation((vals: any) => {
            insertCalls[idx].values = vals;
            return chain;
          }),
          returning: vi.fn().mockRejectedValue(uniqueErr),
        };
        return chain;
      });

      // Track the where-arg used on the second (post-violation) SELECT so we can
      // assert it contains inputType and proposalStatus predicates.
      let capturedPostViolationWhereArg: unknown = undefined;

      let selectCount = 0;
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation((whereArg: unknown) => {
          selectCount += 1;
          if (selectCount === 1) {
            // First select: thread companyId validation
            return Promise.resolve([{ companyId: "co-1", entrySeq: 2 }]);
          }
          // Second select: find the existing pending scope_proposal.
          // Capture the where arg so we can assert it has the right predicates.
          capturedPostViolationWhereArg = whereArg;

          // Simulate what the DB would do: only return the pending proposal row
          // when the where-clause actually filters by inputType + proposalStatus.
          //
          // Drizzle's SQL AST uses SQL objects with `queryChunks`. Literal param
          // values appear as StringChunk objects ({ value: "<literal>" }) nested
          // inside the queryChunks tree. We recursively collect these to detect
          // which literal values are present in the where-clause.
          //
          // An unfiltered eq(discussionId, threadId) only has "thread-1" in its
          // chunk values — NOT "scope_proposal" or "pending" — so it falls through
          // to the wrong (old, unrelated) entry, mirroring the bug.
          function collectStringChunkValues(obj: unknown, depth = 0): string[] {
            if (depth > 15 || obj == null) return [];
            if (typeof obj === "object") {
              const o = obj as any;
              const results: string[] = [];
              // StringChunk: has a string .value property (the literal param value)
              if (typeof o.value === "string") results.push(o.value);
              // SQL: has a .queryChunks array
              if (Array.isArray(o.queryChunks)) {
                for (const c of o.queryChunks) {
                  results.push(...collectStringChunkValues(c, depth + 1));
                }
              }
              return results;
            }
            return [];
          }
          const paramValues = collectStringChunkValues(whereArg);
          const hasInputTypeFilter = paramValues.includes("scope_proposal");
          const hasProposalStatusFilter = paramValues.includes("pending");
          if (hasInputTypeFilter && hasProposalStatusFilter) {
            return Promise.resolve([{ id: "entry-pending-proposal-99" }]);
          }
          // Old unfiltered query → returns the oldest (wrong) entry
          return Promise.resolve([{ id: "entry-old-unrelated" }]);
        }),
      };

      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ entrySeq: 3, companyId: "co-1" }]),
      };

      const db: any = {
        select: vi.fn().mockReturnValue(selectChain),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          return await cb({ insert: throwingInsert, update: vi.fn().mockReturnValue(updateChain) });
        }),
      };

      const result = await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: PROPOSAL,
        agentId: null,
      });

      expect(result.existing).toBe(true);
      // Must be the PENDING PROPOSAL's id — not the old unrelated entry.
      expect(result.entryId).toBe("entry-pending-proposal-99");

      // Additionally assert the where-clause structure: the post-violation SELECT
      // must be a Drizzle SQL object (not undefined/null) whose StringChunk param
      // values include all three filter literals: the threadId, 'scope_proposal',
      // and 'pending'. Drizzle's and(eq(...), eq(...), eq(...)) stores literal
      // param values as StringChunk objects ({ value: "<literal>" }) nested inside
      // queryChunks — collectStringChunkValues (defined in the mock above) extracts
      // them recursively.
      function collectStringChunkValues(obj: unknown, depth = 0): string[] {
        if (depth > 15 || obj == null) return [];
        if (typeof obj === "object") {
          const o = obj as any;
          const results: string[] = [];
          if (typeof o.value === "string") results.push(o.value);
          if (Array.isArray(o.queryChunks)) {
            for (const c of o.queryChunks) {
              results.push(...collectStringChunkValues(c, depth + 1));
            }
          }
          return results;
        }
        return [];
      }
      const whereParamValues = collectStringChunkValues(capturedPostViolationWhereArg);
      // All three conditions must be present in the where-clause
      expect(whereParamValues).toContain("thread-1");
      expect(whereParamValues).toContain("scope_proposal");
      expect(whereParamValues).toContain("pending");
    });

    it("re-throws unique violations from a DIFFERENT constraint (not the pending guard)", async () => {
      const otherErr = makeUniqueViolationError("some_other_unique_idx");

      const throwingInsert = vi.fn().mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockRejectedValue(otherErr),
      }));

      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ entrySeq: 2, companyId: "co-1" }]),
      };

      let selectCount = 0;
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          selectCount += 1;
          if (selectCount === 1) return Promise.resolve([{ companyId: "co-1", entrySeq: 1 }]);
          return Promise.resolve([{ id: "x" }]);
        }),
      };

      const db: any = {
        select: vi.fn().mockReturnValue(selectChain),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          return await cb({ insert: throwingInsert, update: vi.fn().mockReturnValue(updateChain) });
        }),
      };

      await expect(
        writeScopeProposal(db, {
          threadId: "thread-1",
          companyId: "co-1",
          proposal: PROPOSAL,
          agentId: null,
        }),
      ).rejects.toThrow();
    });

    it("does NOT publish live events when returning existing:true", async () => {
      const { publishLiveEvent } = await import("../services/live-events.js");
      (publishLiveEvent as ReturnType<typeof vi.fn>).mockClear();

      const uniqueErr = makeUniqueViolationError(CONSTRAINT_NAME);
      const throwingInsert = vi.fn().mockImplementation(() => ({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockRejectedValue(uniqueErr),
      }));

      let selectCount = 0;
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockImplementation(() => {
          selectCount += 1;
          if (selectCount === 1) return Promise.resolve([{ companyId: "co-1", entrySeq: 0 }]);
          return Promise.resolve([{ id: "entry-existing-2" }]);
        }),
      };
      const updateChain = {
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([{ entrySeq: 1, companyId: "co-1" }]),
      };

      const db: any = {
        select: vi.fn().mockReturnValue(selectChain),
        transaction: vi.fn().mockImplementation(async (cb: any) => {
          return await cb({ insert: throwingInsert, update: vi.fn().mockReturnValue(updateChain) });
        }),
      };

      await writeScopeProposal(db, {
        threadId: "thread-1",
        companyId: "co-1",
        proposal: PROPOSAL,
        agentId: null,
      });

      expect(publishLiveEvent).not.toHaveBeenCalled();
    });
  });
});
