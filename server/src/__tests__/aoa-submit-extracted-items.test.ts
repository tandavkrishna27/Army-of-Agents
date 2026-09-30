import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBuildDiscussionPendingHubEmit,
  mockEmitHubItem,
} = vi.hoisted(() => ({
  mockBuildDiscussionPendingHubEmit: vi.fn((discussion) => ({
    sourceType: "discussion",
    sourceId: discussion.id,
  })),
  mockEmitHubItem: vi.fn(),
}));

// Drizzle-orm ESM cycle workaround: stub the operators we use.
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  and: (...preds: unknown[]) => ({ and: preds }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: { strings: Array.from(strings), values },
  }),
}));

// Proxy-based table stubs so column references resolve to symbols.
vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy(
      {},
      {
        get: (_x, p) =>
          typeof p === "string" ? Symbol(`${n}.${p}`) : undefined,
      },
    );
  return {
    discussionExtractedItems: t("dei"),
    discussionEntries: t("de"),
    discussions: t("d"),
  };
});

vi.mock("../services/hub-source-producers.js", () => ({
  buildDiscussionPendingHubEmit: mockBuildDiscussionPendingHubEmit,
  emitHubItem: mockEmitHubItem,
}));

import { submitExtractedItemsTool } from "../services/internal-agent/tools/submit-extracted-items.js";

// Builds a mock Db that records insert/update calls (with the table the
// update/insert targeted + the `.where(...)` predicate) and serves a
// `select(...).from(...).innerJoin(...).where(...)` chain resolving the entry
// to its owning discussion's { discussionId, companyId }.
//
// The resolution query now JOINs discussion_entries -> discussions to also
// yield the discussion's companyId (mirrors dispatcher.ts:131-137 — the
// established entry->discussion->companyId resolution pattern in this codebase)
// so the tool can gate all side-effects on a caller-company match (M3). The
// mock therefore exposes `.innerJoin(...)` as a pass-through that returns the
// same configured row, now carrying companyId. Default companyId === "co-1"
// keeps every existing scenario SAME-COMPANY (ctx.companyId is "co-1" in every
// test below): faithful mock-shape alignment to the tool's new single-query
// shape — no existing assertion is changed or weakened.
function makeMockDb(
  discussionId: string | null = "disc-1",
  companyId: string = "co-1",
  terminalRows: Array<{ id: string }> = [{ id: "entry" }],
) {
  const inserted: { table: any; values: any }[] = [];
  const updated: { table: any; set: any; where: any }[] = [];
  const selects: { from: any; where: any }[] = [];
  const resolvedRow =
    discussionId === null
      ? []
      : [
          {
            id: discussionId,
            discussionId,
            companyId,
            title: "Thread",
            ownerUserId: "u-1",
            scopeType: null,
            scopeId: null,
            pendingItemCount: 1,
            updatedAt: new Date("2026-06-29T00:00:00Z"),
          },
        ];
  const db: any = {
    insert: (table: any) => ({
      values: (v: any) => {
        inserted.push({ table, values: v });
        return Promise.resolve([]);
      },
    }),
    update: (table: any) => ({
      set: (v: any) => ({
        where: (w: any) => {
          updated.push({ table, set: v, where: w });
          // The guarded terminal entry-status write calls `.returning()`
          // (same idiom as runner.ts's M2 atomic claim) so the F2 emit can
          // be gated on whether the pending->completed transition happened.
          // The bare pendingItemCount increment awaits this directly. Return
          // a thenable that ALSO exposes `.returning()` so both call shapes
          // work. A NON-EMPTY array is faithful to every test here: the
          // entry is `processing` in each scenario (the I-2 test asserts the
          // guarded `processing` where-clause), so the terminal UPDATE
          // legitimately matches a row. This is mock-shape alignment to the
          // tool's call shape — it does not change any I-1/I-2 assertion
          // (those inspect the recorded `set`/`where`, not the return value).
          const handle: any = Promise.resolve([]);
          handle.returning = (_proj?: any) => Promise.resolve(terminalRows);
          return handle;
        },
      }),
    }),
    select: (_cols?: any) => ({
      from: (fromTable: any) => {
        // `.where(...)` resolves directly; `.innerJoin(...).where(...)` also
        // resolves to the same configured row (the join is a pass-through —
        // the resolved row already carries the joined discussion companyId).
        const resolve = (w: any) => {
          selects.push({ from: fromTable, where: w });
          return Promise.resolve(resolvedRow);
        };
        return {
          innerJoin: (_t: any, _on: any) => ({ where: resolve }),
          where: resolve,
        };
      },
    }),
  };
  return { db, inserted, updated, selects };
}

describe("submit-extracted-items internal-agent tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmitHubItem.mockResolvedValue({ id: "hub-1", version: 0 });
  });

  it("inserts mapped discussion_extracted_items + reports count + marks entry completed", async () => {
    const { db, inserted, updated } = makeMockDb();
    // Real ToolContext shape (see internal-agent/types.ts).
    const ctx: any = {
      companyId: "co-1",
      userId: "u-1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      db,
      services: {},
    };

    // Real AgentTool shape: `execute(params, ctx)` -> ToolResult.
    const res = await submitExtractedItemsTool.execute(
      {
        entryId: "e1",
        items: [{ type: "task", content: "Ship X", confidence: 0.9 }],
      },
      ctx,
    );

    expect(res.success).toBe(true);
    expect((res.data as any).count).toBe(1);
    const itemInserts = inserted.filter(
      (i) => i.values?.[0]?.discussionEntryId !== undefined,
    );
    expect(itemInserts.length).toBe(1); // one bulk insert (values array)
    expect(Array.isArray(itemInserts[0].values)).toBe(true);
    expect(itemInserts[0].values).toHaveLength(1);
    // Mapped onto the REAL discussion_extracted_items columns.
    expect(itemInserts[0].values[0].discussionEntryId).toBe("e1");
    expect(itemInserts[0].values[0].type).toBe("task");
    expect(itemInserts[0].values[0].title).toBe("Ship X");
    expect(itemInserts[0].values[0].status).toBe("pending");
    // entry extractionStatus updated to completed.
    const statusUpdates = updated.filter(
      (u) => u.set?.extractionStatus === "completed",
    );
    expect(statusUpdates.length).toBe(1);
  });

  it("emits a discussion_pending hub item after extracted items become pending", async () => {
    const { db } = makeMockDb("disc-42");
    const ctx: any = {
      companyId: "co-1",
      userId: "u-1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      db,
      services: {},
    };

    await submitExtractedItemsTool.execute(
      {
        entryId: "e1",
        items: [{ type: "task", content: "Ship X" }],
      },
      ctx,
    );

    expect(mockBuildDiscussionPendingHubEmit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "disc-42", companyId: "co-1" }),
    );
    expect(mockEmitHubItem).toHaveBeenCalledWith(ctx.db, {
      sourceType: "discussion",
      sourceId: "disc-42",
    });
  });

  it("does not persist items, increment pending count, or emit hub work when terminalization loses the race", async () => {
    const { db, inserted, updated } = makeMockDb("disc-42", "co-1", []);
    const ctx: any = {
      companyId: "co-1",
      userId: "u-1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      db,
      services: {},
    };

    const res = await submitExtractedItemsTool.execute(
      {
        entryId: "e1",
        items: [{ type: "task", content: "Ship X" }],
      },
      ctx,
    );

    expect(res.success).toBe(true);
    expect(inserted).toHaveLength(0);
    expect(updated.filter((u) => u.set?.pendingItemCount !== undefined)).toHaveLength(0);
    expect(mockEmitHubItem).not.toHaveBeenCalled();
  });

  it("rolls back terminalization when persistence after the guard fails", async () => {
    const committed: string[] = [];
    let staged: string[] = [];
    const tx: any = {
      insert: () => ({
        values: () => {
          throw new Error("insert failed");
        },
      }),
      update: () => ({
        set: (v: any) => ({
          where: () => {
            const handle: any = Promise.resolve([]);
            handle.returning = () => {
              if (v?.extractionStatus === "completed") staged.push("completed");
              return Promise.resolve([{ id: "entry" }]);
            };
            return handle;
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    };
    const db: any = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve([{ discussionId: "disc-42", companyId: "co-1" }]),
          }),
        }),
      }),
      transaction: async (callback: (executor: any) => Promise<unknown>) => {
        staged = [];
        const result = await callback(tx);
        committed.push(...staged);
        return result;
      },
    };
    const ctx: any = {
      companyId: "co-1",
      userId: "u-1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      db,
      services: {},
    };

    await expect(
      submitExtractedItemsTool.execute(
        {
          entryId: "e1",
          items: [{ type: "task", content: "Ship X" }],
        },
        ctx,
      ),
    ).rejects.toThrow("insert failed");
    expect(committed).not.toContain("completed");
    expect(mockEmitHubItem).not.toHaveBeenCalled();
  });

  it("skips insert when items is empty but still marks entry completed", async () => {
    const { db, inserted, updated } = makeMockDb();
    const ctx: any = {
      companyId: "co-1",
      userId: "u-1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      db,
      services: {},
    };

    const res = await submitExtractedItemsTool.execute(
      { entryId: "e2", items: [] },
      ctx,
    );

    expect(res.success).toBe(true);
    expect((res.data as any).count).toBe(0);
    const itemInserts = inserted.filter(
      (i) => i.values?.[0]?.discussionEntryId !== undefined,
    );
    expect(itemInserts.length).toBe(0);
    const statusUpdates = updated.filter(
      (u) => u.set?.extractionStatus === "completed",
    );
    expect(statusUpdates.length).toBe(1);
  });

  // ── I-1: pendingItemCount increment parity with extraction.ts ─────────────
  it("resolves the entry's discussionId and increments discussions.pendingItemCount by N", async () => {
    const { db, updated, selects } = makeMockDb("disc-42");
    const ctx: any = {
      companyId: "co-1",
      userId: "u-1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      db,
      services: {},
    };

    const res = await submitExtractedItemsTool.execute(
      {
        entryId: "e1",
        items: [
          { type: "task", content: "Ship X" },
          { type: "decision", content: "Use Y" },
        ],
      },
      ctx,
    );

    expect(res.success).toBe(true);
    // It must resolve the entry -> discussionId first (a select on
    // discussionEntries keyed by the entry id).
    expect(selects.length).toBeGreaterThanOrEqual(1);
    // A discussions-table update incrementing pendingItemCount via a `sql`
    // expression was recorded (mirrors extraction.ts:614-620).
    const pendingUpdates = updated.filter(
      (u) => u.set?.pendingItemCount !== undefined,
    );
    expect(pendingUpdates.length).toBe(1);
    const incr = pendingUpdates[0].set.pendingItemCount;
    // sql`${discussions.pendingItemCount} + ${rows.length}` — N === 2.
    expect(incr?.sql?.values).toContain(2);
  });

  it("does NOT issue a pendingItemCount increment when items is empty", async () => {
    const { db, updated, selects } = makeMockDb("disc-7");
    const ctx: any = {
      companyId: "co-1",
      userId: "u-1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      db,
      services: {},
    };

    const res = await submitExtractedItemsTool.execute(
      { entryId: "e9", items: [] },
      ctx,
    );

    expect(res.success).toBe(true);
    const pendingUpdates = updated.filter(
      (u) => u.set?.pendingItemCount !== undefined,
    );
    expect(pendingUpdates.length).toBe(0);
    // F2: discussionId is now resolved UNCONDITIONALLY so the
    // discussion.extraction.completed LiveEvent fires even for empty
    // extractions (parity with extraction.ts). The no-increment contract is
    // still enforced by the pendingUpdates assertion above.
    expect(selects.length).toBe(1);
  });

  // ── I-2: terminal extractionStatus update is guarded on "processing" ──────
  it("guards the terminal extractionStatus update with extractionStatus='processing'", async () => {
    const { db, updated } = makeMockDb();
    const ctx: any = {
      companyId: "co-1",
      userId: "u-1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      db,
      services: {},
    };

    await submitExtractedItemsTool.execute(
      {
        entryId: "e1",
        items: [{ type: "task", content: "Ship X" }],
      },
      ctx,
    );

    const statusUpdates = updated.filter(
      (u) => u.set?.extractionStatus === "completed",
    );
    expect(statusUpdates.length).toBe(1);
    // The `.where(...)` must be an `and(...)` of (id = entryId) AND
    // (extractionStatus = 'processing') — not an unguarded blind write.
    const where = statusUpdates[0].where;
    expect(where?.and).toBeDefined();
    const flat = JSON.stringify(where);
    expect(flat).toContain("processing");
    expect(flat).toContain("e1");
  });

  // ── M3: caller-company isolation gate ─────────────────────────────────────
  it("returns an error result and performs NO writes when the entry's discussion belongs to a different company", async () => {
    // Entry resolves, but its owning discussion belongs to "co-OTHER" while
    // the caller's ctx.companyId is "co-1". entryId is an untrusted agent/
    // payload input; every other write path enforces company match. The tool
    // MUST refuse: no insert, no pendingItemCount update, no extractionStatus
    // update, no LiveEvent.
    const { db, inserted, updated } = makeMockDb("disc-x", "co-OTHER");
    const ctx: any = {
      companyId: "co-1",
      userId: "u-1",
      userRole: "founder",
      enabledCapabilities: ["discussion_processing"],
      db,
      services: {},
    };

    const res = await submitExtractedItemsTool.execute(
      {
        entryId: "e-cross",
        items: [{ type: "task", content: "Cross-tenant write attempt" }],
      },
      ctx,
    );

    // Error-result convention mirrors delegate-to-subagent.ts ("no such
    // agent"): { success:false, data:null, summary, error }.
    expect(res.success).toBe(false);
    expect(res.data).toBeNull();
    expect(typeof res.summary).toBe("string");
    expect((res as any).error).toBeTruthy();

    // ZERO side-effects: no item insert, no pendingItemCount increment, no
    // extractionStatus terminal write.
    const itemInserts = inserted.filter(
      (i) => i.values?.[0]?.discussionEntryId !== undefined,
    );
    expect(itemInserts.length).toBe(0);
    const pendingUpdates = updated.filter(
      (u) => u.set?.pendingItemCount !== undefined,
    );
    expect(pendingUpdates.length).toBe(0);
    const statusUpdates = updated.filter(
      (u) => u.set?.extractionStatus === "completed",
    );
    expect(statusUpdates.length).toBe(0);
  });

  it("conforms to the AgentTool shape (discussion category, founder role)", () => {
    expect(submitExtractedItemsTool.name).toBe("submit_extracted_items");
    expect(submitExtractedItemsTool.parameters.type).toBe("object");
    expect(submitExtractedItemsTool.parameters.required).toContain("entryId");
    expect(submitExtractedItemsTool.parameters.required).toContain("items");
    expect(submitExtractedItemsTool.category).toBe("discussion");
    expect(typeof submitExtractedItemsTool.execute).toBe("function");
  });
});
