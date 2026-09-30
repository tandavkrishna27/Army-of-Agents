/**
 * Phase G4.4 — Integration tests for thread-privacy → memory inheritance.
 *
 * The plan asks for four privacy contracts. After tracing the code paths
 * we found the following ACTUAL behavior — tests below assert what is
 * implemented today and explicitly call out gaps where the implementation
 * diverges from the plan's intent:
 *
 *   1. Plan: "Memory Keeper running on a private thread creates memory
 *      candidates with scope: 'private'".
 *      Reality: `memory_items` has no `scope: 'private'` field. Privacy
 *      is enforced by REJECTING identity/domain proposals from private
 *      threads (VISIBILITY_VIOLATION), not by tagging the row. The
 *      working/active_context proposals that DO succeed have no
 *      "scope=private" marker — they're regular pending items with the
 *      thread breadcrumb in sourceContext. We assert that behavior.
 *
 *   2. Plan: "Memory Keeper running on a company thread creates candidates
 *      with default company scope". Reality: same as above — there is no
 *      explicit scope tag. We assert the layer is allowed (any of four).
 *
 *   3. Plan: "propose_memory_from_thread respects allowMemoryExtraction=
 *      false". Reality: YES — this is the one check that works today.
 *      Returns MEMORY_EXTRACTION_DISABLED.
 *
 *   4. Plan: "extractMemoryCandidates skips threads with
 *      allowMemoryExtraction=false". Reality: CLOSED (G3 follow-up) —
 *      extractMemoryCandidates now reads discussions.allowMemoryExtraction as
 *      its first select and short-circuits to {candidates:[]} when false (the
 *      privacy gate). The describe block at the bottom of this file pins that
 *      behavior. Note: extraction is now CLI-only (keyless), so these tests
 *      feed empty entry sets — the keyless CLI is never spawned in a unit test.
 */

import { describe, expect, it, vi } from "vitest";
import { proposeMemoryFromThreadTool } from "../../services/internal-agent/tools/memory-propose.js";
import { extractMemoryCandidates } from "../../services/extraction.js";
import type { ToolContext } from "../../services/internal-agent/types.js";

// ---------------------------------------------------------------------------
// Mock harness — minimal proxy DB shape for both the tool (one .select() per
// thread lookup + .insert() for the pending memory item) and the extraction
// service (cursor lookup + entry fetch).
// ---------------------------------------------------------------------------

function makeProposeDb(opts: {
  threadRow?: any | null;
  memoryId?: string;
} = {}) {
  const insertValues: { last?: any } = {};

  const limit = vi.fn().mockResolvedValue(opts.threadRow ? [opts.threadRow] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const insert = vi.fn((_table: any) => {
    const chain: any = {};
    chain.values = (vals: any) => {
      insertValues.last = vals;
      return chain;
    };
    chain.returning = () =>
      Promise.resolve([{ id: opts.memoryId ?? "mem-new" }]);
    return chain;
  });

  return { db: { select, insert } as any, insertValues };
}

function makeCtx(db: any, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: "co-priv-1",
    userId: "u-priv-1",
    userRole: "team_member",
    enabledCapabilities: ["memory_management"],
    agentId: "agent-memkeeper",
    db,
    services: {} as any,
    ...overrides,
  } as unknown as ToolContext;
}

// ---------------------------------------------------------------------------
// Tests — propose_memory_from_thread boundary
// ---------------------------------------------------------------------------

describe("integration: thread privacy → memory proposal inheritance", () => {
  // ── Private thread allowed layers ────────────────────────────────────────

  it("private thread: layer='working' is allowed; insert has no 'scope:private' field (privacy via layer restriction, not row tag)", async () => {
    const { db, insertValues } = makeProposeDb({
      threadRow: {
        id: "th-private",
        visibility: "private",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
      memoryId: "mem-priv-1",
    });

    const result = await proposeMemoryFromThreadTool.execute(
      { content: "private working note", layer: "working", sourceThreadId: "th-private" },
      makeCtx(db),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).memoryItemId).toBe("mem-priv-1");

    // The inserted row has NO scope:'private' field — see file header for
    // why. The privacy contract is enforced at the layer choice (which
    // layers a private thread may seed); the row is otherwise normal.
    expect(insertValues.last).toMatchObject({
      companyId: "co-priv-1",
      content: "private working note",
      layer: "working",
      status: "pending",
      source: "agent",
      sourceContext: "thread:th-private",
    });
    expect((insertValues.last as Record<string, unknown>).scope).toBeUndefined();
    expect((insertValues.last as Record<string, unknown>).visibility).toBeUndefined();
  });

  it("private thread: layer='active_context' is allowed", async () => {
    const { db } = makeProposeDb({
      threadRow: {
        id: "th-private",
        visibility: "private",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });

    const result = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "active_context", sourceThreadId: "th-private" },
      makeCtx(db),
    );

    expect(result.success).toBe(true);
  });

  // ── Private thread forbidden layers (the actual privacy enforcement) ────

  it("private thread: layer='identity' is REJECTED with VISIBILITY_VIOLATION", async () => {
    const { db } = makeProposeDb({
      threadRow: {
        id: "th-private",
        visibility: "private",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });

    const result = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "identity", sourceThreadId: "th-private" },
      makeCtx(db),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("VISIBILITY_VIOLATION");
    expect(result.summary).toMatch(/private/i);
  });

  it("private thread: layer='domain' is REJECTED with VISIBILITY_VIOLATION", async () => {
    const { db } = makeProposeDb({
      threadRow: {
        id: "th-private",
        visibility: "private",
        allowMemoryExtraction: true,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });

    const result = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "domain", sourceThreadId: "th-private" },
      makeCtx(db),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("VISIBILITY_VIOLATION");
  });

  // ── Company / department thread allowed layers ───────────────────────────

  it("company thread: all four layers (identity, domain, active_context, working) are allowed", async () => {
    for (const layer of ["identity", "domain", "active_context", "working"]) {
      const { db } = makeProposeDb({
        threadRow: {
          id: "th-company",
          visibility: "company",
          allowMemoryExtraction: true,
          scopeType: null,
          scopeId: null,
          goalId: null,
        },
      });

      const result = await proposeMemoryFromThreadTool.execute(
        { content: "x", layer, sourceThreadId: "th-company" },
        makeCtx(db),
      );

      expect(result.success).toBe(true);
    }
  });

  it("department thread: all four layers are allowed (visibility !== 'private')", async () => {
    const { db, insertValues } = makeProposeDb({
      threadRow: {
        id: "th-dept",
        visibility: "department",
        allowMemoryExtraction: true,
        scopeType: "department",
        scopeId: "dept-eng",
        goalId: null,
      },
    });

    const result = await proposeMemoryFromThreadTool.execute(
      { content: "x", layer: "domain", sourceThreadId: "th-dept" },
      makeCtx(db),
    );

    expect(result.success).toBe(true);
    // Department scope is inherited onto the new memory item (departmentId).
    expect(insertValues.last.departmentId).toBe("dept-eng");
  });

  // ── allowMemoryExtraction flag ──────────────────────────────────────────

  it("allowMemoryExtraction=false on the source thread → MEMORY_EXTRACTION_DISABLED", async () => {
    const { db, insertValues } = makeProposeDb({
      threadRow: {
        id: "th-disabled",
        visibility: "company",
        allowMemoryExtraction: false,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });

    const result = await proposeMemoryFromThreadTool.execute(
      { content: "this should be rejected", layer: "domain", sourceThreadId: "th-disabled" },
      makeCtx(db),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("MEMORY_EXTRACTION_DISABLED");
    expect(result.summary).toMatch(/disabled/i);
    // The insert must NOT have run — pending memory must not be written
    // when the founder has opted out of extraction for the source thread.
    expect(insertValues.last).toBeUndefined();
  });

  it("allowMemoryExtraction=false ALSO blocks even allowed-by-layer proposals (gate is global)", async () => {
    // Belt-and-suspenders: a working-layer proposal would normally succeed
    // even on a private thread. But allowMemoryExtraction=false MUST block
    // it regardless of layer — the founder's opt-out is the strongest
    // signal in the privacy stack.
    const { db } = makeProposeDb({
      threadRow: {
        id: "th-private-disabled",
        visibility: "private",
        allowMemoryExtraction: false,
        scopeType: null,
        scopeId: null,
        goalId: null,
      },
    });

    const result = await proposeMemoryFromThreadTool.execute(
      { content: "should be rejected", layer: "working", sourceThreadId: "th-private-disabled" },
      makeCtx(db),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("MEMORY_EXTRACTION_DISABLED");
  });
});

// ---------------------------------------------------------------------------
// Tests — extractMemoryCandidates wiring gap
// ---------------------------------------------------------------------------

describe("integration: extractMemoryCandidates respects allowMemoryExtraction (G4 gap closed in G3 follow-up)", () => {
  // Mock harness for the extraction service. The discussions privacy gate
  // (added 2026-05-29 as a G4-surfaced fix) is the FIRST select; entry fetch
  // is the SECOND select when extraction is allowed. We control which path
  // the test exercises by providing a discussions-row queue.
  function makeExtractionDb(opts: {
    threadAllowExtraction?: boolean | undefined;
    entryRows?: any[];
  }) {
    const entryRows = opts.entryRows ?? [];
    const discussionsRow =
      opts.threadAllowExtraction === undefined
        ? []
        : [{ allowMemoryExtraction: opts.threadAllowExtraction }];

    // Each .select() pops one result off the queue. Order matches the
    // order of selects inside extractMemoryCandidates: discussions privacy
    // gate first, then entries fetch.
    const queue: any[][] = [discussionsRow, entryRows];

    const select = vi.fn().mockImplementation(() => {
      const result = queue.shift() ?? [];
      // The drizzle chain is `select().from(t).where(p).orderBy(c)` —
      // every call shape resolves to `result`. .where returns a thenable
      // that resolves to result, and also exposes .orderBy that resolves
      // to result.
      const orderBy = vi.fn().mockResolvedValue(result);
      const whereChain = {
        orderBy,
        then: (cb: (v: any) => any) => Promise.resolve(cb(result)),
      };
      const where = vi.fn().mockReturnValue(whereChain);
      const from = vi.fn().mockReturnValue({ where });
      return { from };
    });

    return { db: { select } as any };
  }

  it(
    "short-circuits to {candidates:[]} when discussions.allowMemoryExtraction=false",
    async () => {
      const { db } = makeExtractionDb({ threadAllowExtraction: false });

      const result = await extractMemoryCandidates(db as any, null, {
        companyId: "co-priv-1",
        threadId: "th-disabled-extract",
      });

      expect(result.candidates).toEqual([]);
      // Exactly ONE select: the discussions privacy gate. Entry fetch was
      // never issued because the gate short-circuited.
      expect((db.select as any).mock.calls.length).toBe(1);
    },
  );

  it(
    "proceeds to entry fetch when discussions.allowMemoryExtraction=true",
    async () => {
      const { db } = makeExtractionDb({
        threadAllowExtraction: true,
        entryRows: [], // no entries, so the keyless CLI is still never invoked
      });

      const result = await extractMemoryCandidates(db as any, null, {
        companyId: "co-priv-1",
        threadId: "th-allowed-extract",
      });

      expect(result.candidates).toEqual([]);
      // Two selects: discussions gate (allowed) + entries fetch (empty).
      expect((db.select as any).mock.calls.length).toBe(2);
    },
  );

  it(
    "is permissive when the discussions row is missing (defensive: treat as allowed)",
    async () => {
      // Edge case: stale threadId, race with deletion, etc. The flag is
      // undefined, not explicitly false, so we DO NOT short-circuit —
      // letting the entry fetch handle the "no rows" case naturally.
      const { db } = makeExtractionDb({
        threadAllowExtraction: undefined, // discussions query returns []
        entryRows: [],
      });

      const result = await extractMemoryCandidates(db as any, null, {
        companyId: "co-priv-1",
        threadId: "th-deleted",
      });

      expect(result.candidates).toEqual([]);
      // Two selects: the (empty) discussions check + the entries fetch.
      expect((db.select as any).mock.calls.length).toBe(2);
    },
  );
});
