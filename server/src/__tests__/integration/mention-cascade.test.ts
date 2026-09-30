/**
 * Phase G4.2 — Integration tests for the @mention / agent.dispatch cascade firewall.
 *
 * Verifies the MAX_HOP_COUNT=3 cap that bounds agent→agent cascades, the
 * cross-company forbid, and the per-(agent,thread,queued) dedup at the
 * agent.dispatch tool boundary. Mirror tests at the thread-events.dispatchMention
 * boundary live in `thread-pipeline.test.ts` — the cap is intentionally
 * enforced at BOTH boundaries (the agent-dispatch tool's MAX_HOP_COUNT is a
 * literal mirror of thread-events.MAX_HOP_COUNT for this reason). If a future
 * change drifts one without the other the asymmetry shows up here.
 *
 * The agent.dispatch tool does NOT itself produce a `{ ok: false, reason }`
 * shape — it returns the AgentTool shape `{ success, data, summary, error }`.
 * The plan asks for `reason: "hop_limit"` / `"cross_company"` semantics; we
 * map those to the tool's `error` codes (HOP_LIMIT_EXCEEDED / CROSS_COMPANY_
 * FORBIDDEN) and document the mapping inline.
 */

import { describe, it, expect, vi } from "vitest";
import { agentDispatchTool } from "../../services/internal-agent/tools/agent-dispatch.js";
import type { ToolContext } from "../../services/internal-agent/types.js";

// ---------------------------------------------------------------------------
// Mock harness — mirrors the existing c2-agent-dispatch.test.ts shape. The
// integration angle here is: we drive the same tool that the new thread-
// pipeline dispatch path invokes, asserting hop-count + cross-company +
// dedup guarantees end-to-end (incoming hopCount → stored hopCount → DB
// behavior under dedupKey conflict).
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-cascade-1";
const OTHER_COMPANY_ID = "co-cascade-2";
const CALLER_AGENT_ID = "agent-cascade-caller";
const TARGET_AGENT_ID = "agent-cascade-target";
const THREAD_ID = "thread-cascade-1";

function makeDb(opts: {
  agentRows?: any[];
  insertedRows?: any[];
} = {}) {
  // SELECT chain → returns the target agent.
  const limit = vi.fn().mockResolvedValue(
    opts.agentRows ?? [{ id: TARGET_AGENT_ID, companyId: COMPANY_ID }],
  );
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  // INSERT chain → returns inserted wakeup id, or empty on dedup conflict.
  const returning = vi.fn().mockResolvedValue(
    opts.insertedRows ?? [{ id: "wakeup-cascade-1" }],
  );
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });

  return {
    db: { select, insert } as any,
    selectFn: select,
    insertFn: insert,
    valuesMock: values,
  };
}

function makeCtx(db: any, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: COMPANY_ID,
    userId: "u-cascade-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: CALLER_AGENT_ID,
    db,
    services: {} as any,
    ...overrides,
  } as unknown as ToolContext;
}

describe("integration: @mention / agent.dispatch cascade firewall", () => {
  // ── Hop-count cap (mirrors thread-events.MAX_HOP_COUNT=3) ─────────────────

  it("hopCount=0 → stored payload.hopCount=1 (first hop counted)", async () => {
    const { db, valuesMock } = makeDb();
    const result = await agentDispatchTool.execute(
      {
        agentId: TARGET_AGENT_ID,
        context: { threadId: THREAD_ID, hopCount: 0 },
        reason: "cascade_test_hop0",
      },
      makeCtx(db),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).hopCount).toBe(1);
    const v = valuesMock.mock.calls[0][0];
    expect(v.payload.hopCount).toBe(1);
    expect(v.dedupKey).toBe(`${TARGET_AGENT_ID}:${THREAD_ID}:queued`);
  });

  it("hopCount=2 → stored payload.hopCount=3 (cap reached, still allowed)", async () => {
    const { db, valuesMock } = makeDb();
    const result = await agentDispatchTool.execute(
      {
        agentId: TARGET_AGENT_ID,
        context: { threadId: THREAD_ID, hopCount: 2 },
      },
      makeCtx(db),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).hopCount).toBe(3);
    const v = valuesMock.mock.calls[0][0];
    // hopCount=3 is the max — the NEXT hop (3 → 4) is the one that gets
    // blocked. This boundary is intentional: a maker can answer ONE level
    // deep into a cascade, but cannot themselves cascade further.
    expect(v.payload.hopCount).toBe(3);
  });

  it("hopCount=3 → HOP_LIMIT_EXCEEDED, no DB calls (firewall)", async () => {
    const { db, selectFn, insertFn } = makeDb();
    const result = await agentDispatchTool.execute(
      {
        agentId: TARGET_AGENT_ID,
        context: { threadId: THREAD_ID, hopCount: 3 },
      },
      makeCtx(db),
    );

    expect(result.success).toBe(false);
    // Plan calls this `reason: "hop_limit"`; the tool surfaces it as the
    // AgentTool `error` code HOP_LIMIT_EXCEEDED.
    expect(result.error).toBe("HOP_LIMIT_EXCEEDED");
    expect(result.summary).toContain("3");
    // Critical firewall property: the block fires BEFORE the agent lookup
    // and BEFORE the wakeup insert. We must not even read the target row.
    expect(selectFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("hopCount=4 (over cap) → HOP_LIMIT_EXCEEDED, no DB calls", async () => {
    const { db, selectFn, insertFn } = makeDb();
    const result = await agentDispatchTool.execute(
      {
        agentId: TARGET_AGENT_ID,
        context: { threadId: THREAD_ID, hopCount: 4 },
      },
      makeCtx(db),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("HOP_LIMIT_EXCEEDED");
    expect(selectFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  // ── Cross-company guard ──────────────────────────────────────────────────

  it("cross-company dispatch attempt → CROSS_COMPANY_FORBIDDEN, no insert", async () => {
    // The target agent belongs to a DIFFERENT company than the caller.
    // The agent lookup succeeds (so we can compare companyIds), but the
    // insert is suppressed.
    const { db, insertFn } = makeDb({
      agentRows: [{ id: TARGET_AGENT_ID, companyId: OTHER_COMPANY_ID }],
    });
    const result = await agentDispatchTool.execute(
      {
        agentId: TARGET_AGENT_ID,
        context: { threadId: THREAD_ID, hopCount: 0 },
      },
      makeCtx(db),
    );

    expect(result.success).toBe(false);
    // Plan: `reason: "cross_company"` → tool error code.
    expect(result.error).toBe("CROSS_COMPANY_FORBIDDEN");
    expect(insertFn).not.toHaveBeenCalled();
  });

  // ── Dedup within the queued window ───────────────────────────────────────

  it("duplicate dispatch within the dedup window returns null wakeupId (no DB row created)", async () => {
    // Simulate the partial unique index firing: onConflictDoNothing causes
    // the .returning() to resolve to an empty array. The tool flags the
    // attempt as success with wakeupId=null (idempotent semantics).
    const { db, valuesMock } = makeDb({ insertedRows: [] });
    const result = await agentDispatchTool.execute(
      {
        agentId: TARGET_AGENT_ID,
        context: { threadId: THREAD_ID, hopCount: 0 },
      },
      makeCtx(db),
    );

    expect(result.success).toBe(true);
    expect((result.data as any).wakeupId).toBeNull();
    expect(result.summary).toMatch(/already queued/i);
    // We still attempted the insert — the DB-level partial unique index
    // rejected it; the tool did not.
    const v = valuesMock.mock.calls[0][0];
    expect(v.dedupKey).toBe(`${TARGET_AGENT_ID}:${THREAD_ID}:queued`);
  });

  it("dedup is keyed by (agentId, threadId, queued) — same agent, different thread = NEW wakeup", async () => {
    // Two dispatches to the same target but DIFFERENT threads must each
    // produce their own wakeup row (different dedupKey, no conflict).
    const dbA = makeDb();
    await agentDispatchTool.execute(
      {
        agentId: TARGET_AGENT_ID,
        context: { threadId: "thread-A", hopCount: 0 },
      },
      makeCtx(dbA.db),
    );
    expect(dbA.valuesMock.mock.calls[0][0].dedupKey).toBe(
      `${TARGET_AGENT_ID}:thread-A:queued`,
    );

    const dbB = makeDb();
    await agentDispatchTool.execute(
      {
        agentId: TARGET_AGENT_ID,
        context: { threadId: "thread-B", hopCount: 0 },
      },
      makeCtx(dbB.db),
    );
    expect(dbB.valuesMock.mock.calls[0][0].dedupKey).toBe(
      `${TARGET_AGENT_ID}:thread-B:queued`,
    );
  });

  it("dispatch with no threadId in context leaves dedupKey null (treated as one-off)", async () => {
    // Without a thread, the dedup window doesn't apply; the partial unique
    // index ignores NULL keys, so repeated thread-less dispatches each
    // produce their own row.
    const { db, valuesMock } = makeDb();
    await agentDispatchTool.execute(
      { agentId: TARGET_AGENT_ID, context: { hopCount: 0 } },
      makeCtx(db),
    );
    expect(valuesMock.mock.calls[0][0].dedupKey).toBeNull();
  });

  it("target agent not found → AGENT_NOT_FOUND, no insert", async () => {
    const { db, insertFn } = makeDb({ agentRows: [] });
    const result = await agentDispatchTool.execute(
      { agentId: "agent-does-not-exist", context: { hopCount: 0 } },
      makeCtx(db),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("AGENT_NOT_FOUND");
    expect(insertFn).not.toHaveBeenCalled();
  });
});
