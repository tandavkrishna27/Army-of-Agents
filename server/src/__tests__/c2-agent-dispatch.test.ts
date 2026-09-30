// server/src/__tests__/c2-agent-dispatch.test.ts
//
// Task C2 batch 4 — agent.dispatch tool tests.
// Verifies:
//   - metadata (coordination category, team_member role, no confirmation),
//   - hop-count: 0→1, 1→2 (queued), 3 → HOP_LIMIT_EXCEEDED,
//   - AGENT_NOT_FOUND / CROSS_COMPANY_FORBIDDEN errors,
//   - dedup: when (agentId, threadId, status='queued') already exists,
//     onConflictDoNothing returns empty and wakeupId is null,
//   - dedupKey null when no threadId in context,
//   - reason defaults to 'agent_dispatch' when omitted.

import { describe, expect, it, vi } from "vitest";

// drizzle-orm + @armyofagents/db are mocked so the WHERE clause is an
// INSPECTABLE structure (`{ and: [{ eq: [col, val] }, …] }`) with columns
// rendered as stable "table.column" strings. This lets the harness below HONOR
// the companyId conjunct. The pre-strengthening mock ignored the WHERE entirely
// and keyed rows purely off the table + a caller-supplied `[]` — so a regression
// that dropped the `companyId` conjunct from the ownership check (re-opening the
// cross-tenant leak) would STILL have passed. With a WHERE-aware db, dropping
// that conjunct surfaces the foreign row and the SECURITY tests genuinely fail.
// The tool only uses `and`/`eq`. Mocking @armyofagents/db (table proxies) avoids
// loading the real Drizzle schema (which needs the full drizzle-orm surface).
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));
function tableProxy(name: string) {
  return new Proxy({}, { get(_t, prop) { return `${name}.${String(prop)}`; } });
}
vi.mock("@armyofagents/db", () => ({
  agents: tableProxy("agents"),
  agentWakeupRequests: tableProxy("agentWakeupRequests"),
  discussions: tableProxy("discussions"),
  issues: tableProxy("issues"),
}));

import { discussions, issues } from "@armyofagents/db";
import { agentDispatchTool } from "../services/internal-agent/tools/agent-dispatch.js";
import type { ToolContext } from "../services/internal-agent/types.js";

// Walk the mocked WHERE structure and read the value requested for a column
// (identity-compared against the real drizzle column ref, e.g.
// `discussions.companyId`). `undefined` ⇒ that column was NOT constrained (the
// vulnerable / reverted-conjunct shape).
function collectEqs(node: unknown, acc: Array<[unknown, unknown]> = []): Array<[unknown, unknown]> {
  if (!node || typeof node !== "object") return acc;
  const n = node as { eq?: unknown[]; and?: unknown[] };
  if (Array.isArray(n.eq)) acc.push([n.eq[0], n.eq[1]]);
  if (Array.isArray(n.and)) for (const c of n.and) collectEqs(c, acc);
  return acc;
}
function requestedValue(where: unknown, column: unknown): unknown {
  const pair = collectEqs(where).find(([col]) => col === column);
  return pair ? pair[1] : undefined;
}

// WHERE-aware db. The discussions/issues rows genuinely EXIST, owned by
// `threadOwnerCompanyId` / `issueOwnerCompanyId`, matched by id. A read returns
// the row UNLESS a companyId conjunct scopes it to a DIFFERENT company (the real
// tenant filter). An UNSCOPED read (id only — the pre-fix / reverted-conjunct
// query) STILL returns the row, so dropping the companyId conjunct surfaces the
// foreign row and the SECURITY tests FAIL. `threadExists`/`issueExists = false`
// models a genuinely absent id. Mirrors crew-context-bundle.test.ts's
// makeTenantScopedDb. The target-agent lookup returns `agentRows` as-is (its
// cross-company guard is enforced in JS, not the WHERE).
function makeDb(opts: {
  agentRows?: any[];
  threadOwnerCompanyId?: string;
  threadId?: string;
  threadExists?: boolean;
  issueOwnerCompanyId?: string;
  issueId?: string;
  issueExists?: boolean;
  insertedRows?: any[];
} = {}) {
  const agentRows = opts.agentRows ?? [{ id: "agent-target", companyId: "co-1" }];
  const threadOwner = opts.threadOwnerCompanyId ?? "co-1";
  const threadId = opts.threadId ?? "thread-7";
  const threadExists = opts.threadExists ?? true;
  const issueOwner = opts.issueOwnerCompanyId ?? "co-1";
  const issueId = opts.issueId ?? "issue-9";
  const issueExists = opts.issueExists ?? true;

  const select = vi.fn().mockImplementation(() => {
    const state: { table?: unknown; where?: unknown } = {};
    const limit = vi.fn().mockImplementation(() => {
      if (state.table === discussions) {
        if (!threadExists) return Promise.resolve([]);
        if (requestedValue(state.where, discussions.id) !== threadId) return Promise.resolve([]);
        const reqCo = requestedValue(state.where, discussions.companyId);
        // Row exists; only a mismatched companyId conjunct hides it.
        if (reqCo !== undefined && reqCo !== threadOwner) return Promise.resolve([]);
        return Promise.resolve([{ id: threadId }]);
      }
      if (state.table === issues) {
        if (!issueExists) return Promise.resolve([]);
        if (requestedValue(state.where, issues.id) !== issueId) return Promise.resolve([]);
        const reqCo = requestedValue(state.where, issues.companyId);
        if (reqCo !== undefined && reqCo !== issueOwner) return Promise.resolve([]);
        return Promise.resolve([{ id: issueId }]);
      }
      return Promise.resolve(agentRows);
    });
    const where = vi.fn().mockImplementation((c: unknown) => {
      state.where = c;
      return { limit };
    });
    const from = vi.fn().mockImplementation((t: unknown) => {
      state.table = t;
      return { where };
    });
    return { from };
  });

  // INSERT chain — returns the inserted row id (or empty on dedup conflict).
  const returning = vi.fn().mockResolvedValue(opts.insertedRows ?? [{ id: "wakeup-1" }]);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });

  return {
    db: { select, insert } as any,
    selectFn: select,
    insertFn: insert,
    valuesMock: values,
    onConflictDoNothingMock: onConflictDoNothing,
  };
}

function makeCtx(db: any, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: ["system_actions"],
    agentId: "agent-caller",
    db,
    services: {} as any,
    ...overrides,
  } as unknown as ToolContext;
}

describe("agent.dispatch tool (C2 batch 4)", () => {
  it("metadata: name, category=coordination, requiredRole=team_member, no confirmation", () => {
    expect(agentDispatchTool.name).toBe("agent.dispatch");
    expect(agentDispatchTool.category).toBe("coordination");
    expect(agentDispatchTool.requiredRole).toBe("team_member");
    expect(agentDispatchTool.requiresConfirmation).toBe(false);
  });

  it("dispatches with hopCount=0 → wakeup row inserted with hopCount=1 in payload", async () => {
    const { db, valuesMock } = makeDb();
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      {
        agentId: "agent-target",
        context: { threadId: "thread-7", hopCount: 0 },
        reason: "test_dispatch",
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).wakeupId).toBe("wakeup-1");
    expect((result.data as any).hopCount).toBe(1);
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues.payload.hopCount).toBe(1);
    expect(insertedValues.payload.threadId).toBe("thread-7");
    expect(insertedValues.source).toBe("agent.dispatch");
    expect(insertedValues.reason).toBe("test_dispatch");
    expect(insertedValues.companyId).toBe("co-1");
    expect(insertedValues.agentId).toBe("agent-target");
    expect(insertedValues.status).toBe("queued");
    expect(insertedValues.dedupKey).toBe("agent-target:thread-7:queued");
  });

  it("dispatches with hopCount=1 → wakeup row inserted with hopCount=2 in payload", async () => {
    const { db, valuesMock } = makeDb();
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      {
        agentId: "agent-target",
        context: { threadId: "thread-7", hopCount: 1 },
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).hopCount).toBe(2);
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues.payload.hopCount).toBe(2);
  });

  it("blocks dispatch when incoming hopCount=3 → returns HOP_LIMIT_EXCEEDED", async () => {
    const { db, insertFn, selectFn } = makeDb();
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      {
        agentId: "agent-target",
        context: { threadId: "thread-7", hopCount: 3 },
      },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("HOP_LIMIT_EXCEEDED");
    expect(result.summary).toContain("3");
    // No DB calls should happen — block fires before lookup or insert.
    expect(selectFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("returns AGENT_NOT_FOUND when target agent doesn't exist", async () => {
    const { db, insertFn } = makeDb({ agentRows: [] });
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      { agentId: "agent-missing" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("AGENT_NOT_FOUND");
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("returns CROSS_COMPANY_FORBIDDEN when target belongs to a different company", async () => {
    const { db, insertFn } = makeDb({
      agentRows: [{ id: "agent-other", companyId: "co-other" }],
    });
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      { agentId: "agent-other" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("CROSS_COMPANY_FORBIDDEN");
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("dedupes: second dispatch for same (agentId, threadId, queued) gets no new row", async () => {
    // Simulate the partial unique index firing — onConflictDoNothing returns
    // an empty array, so wakeupId resolves to null.
    const { db, valuesMock } = makeDb({ insertedRows: [] });
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      {
        agentId: "agent-target",
        context: { threadId: "thread-7" },
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect((result.data as any).wakeupId).toBeNull();
    expect(result.summary).toContain("Already queued");
    // We still attempted the insert with the dedupKey set — the DB rejected
    // it; the tool didn't.
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues.dedupKey).toBe("agent-target:thread-7:queued");
  });

  it("leaves dedupKey null when no threadId in context", async () => {
    const { db, valuesMock } = makeDb();
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      { agentId: "agent-target", context: {} },
      ctx,
    );
    expect(result.success).toBe(true);
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues.dedupKey).toBeNull();
  });

  it("leaves dedupKey null when context is omitted entirely", async () => {
    const { db, valuesMock } = makeDb();
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      { agentId: "agent-target" },
      ctx,
    );
    expect(result.success).toBe(true);
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues.dedupKey).toBeNull();
    // hopCount defaults to 0 → stored as 1
    expect(insertedValues.payload.hopCount).toBe(1);
  });

  it("defaults reason to 'agent_dispatch' when omitted", async () => {
    const { db, valuesMock } = makeDb();
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      { agentId: "agent-target" },
      ctx,
    );
    expect(result.success).toBe(true);
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues.reason).toBe("agent_dispatch");
  });

  // ── Cross-tenant confidentiality guard (Layer 1 — validate at the source) ──
  // A team_member in company A must not be able to smuggle a foreign entity id
  // into the wakeup payload. The threadId/issueId ownership check runs BEFORE
  // any enqueue, so a foreign id is refused and never reaches the dispatcher.

  it("SECURITY: refuses a foreign-company threadId (exists in company B, not caller's) — no insert", async () => {
    // The thread EXISTS in company B, but the company-scoped lookup (WHERE
    // companyId = caller) returns no row → treated as not-in-company → refused.
    // WHERE-aware: dropping the companyId conjunct would surface this row and
    // fail the test — the whole point of the strengthened harness.
    const { db, insertFn } = makeDb({
      threadOwnerCompanyId: "company-B",
      threadId: "thread-in-company-B",
    });
    const ctx = makeCtx(db); // caller is co-1
    const result = await agentDispatchTool.execute(
      { agentId: "agent-target", context: { threadId: "thread-in-company-B" } },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("CROSS_COMPANY_FORBIDDEN");
    expect(result.summary).toContain("threadId");
    // The foreign id never made it into a wakeup row.
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("SECURITY: a same-company threadId dispatches fine (legitimate case preserved)", async () => {
    const { db, valuesMock, insertFn } = makeDb({
      threadOwnerCompanyId: "co-1", // resolves within the caller's company
      threadId: "thread-7",
    });
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      { agentId: "agent-target", context: { threadId: "thread-7", hopCount: 0 } },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(insertFn).toHaveBeenCalledTimes(1);
    const insertedValues = valuesMock.mock.calls[0][0];
    expect(insertedValues.payload.threadId).toBe("thread-7");
    expect(insertedValues.dedupKey).toBe("agent-target:thread-7:queued");
  });

  it("SECURITY: refuses a foreign-company issueId (task-branch exposure) — no insert", async () => {
    const { db, insertFn } = makeDb({
      issueOwnerCompanyId: "company-B",
      issueId: "issue-in-company-B",
    });
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      { agentId: "agent-target", context: { issueId: "issue-in-company-B" } },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("CROSS_COMPANY_FORBIDDEN");
    expect(result.summary).toContain("issueId");
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("SECURITY: a same-company issueId dispatches fine", async () => {
    const { db, insertFn } = makeDb({ issueOwnerCompanyId: "co-1", issueId: "issue-9" });
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute(
      { agentId: "agent-target", context: { issueId: "issue-9" } },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(insertFn).toHaveBeenCalledTimes(1);
  });

  // ── Layer A — allowlist the forwarded context (drop trust/scope keys) ──────
  // The caller fully controls `context`. A `companyId` (or any other trust key)
  // inside it must NEVER reach the wakeup payload — otherwise the dispatcher's
  // `...(w.payload)` spread would let it override the trusted, server-set run
  // company (cross-tenant escalation). Only the allowlisted content-reference
  // keys are forwarded.

  it("SECURITY (Layer A): a caller-supplied context.companyId is DROPPED from the enqueued payload — never overrides the run company", async () => {
    const { db, valuesMock, insertFn } = makeDb(); // default thread-7 in co-1
    const ctx = makeCtx(db); // caller co-1
    const result = await agentDispatchTool.execute(
      {
        agentId: "agent-target",
        // Attacker smuggles a foreign companyId (+ other trust keys) alongside a
        // legitimate same-company threadId.
        context: {
          companyId: "co-VICTIM",
          effectiveAutonomy: 2,
          source: "spoofed",
          wakeupId: "forged",
          resolvedModel: "expensive-model",
          threadId: "thread-7",
          hopCount: 0,
        },
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(insertFn).toHaveBeenCalledTimes(1);
    const insertedValues = valuesMock.mock.calls[0][0];
    // The wakeup ROW company is the trusted server value (ctx.companyId)…
    expect(insertedValues.companyId).toBe("co-1");
    // …and NONE of the smuggled trust/scope keys made it into the payload the
    // dispatcher will later spread into the runner.
    expect(insertedValues.payload).not.toHaveProperty("companyId");
    expect(insertedValues.payload).not.toHaveProperty("effectiveAutonomy");
    expect(insertedValues.payload).not.toHaveProperty("source");
    expect(insertedValues.payload).not.toHaveProperty("wakeupId");
    expect(insertedValues.payload).not.toHaveProperty("resolvedModel");
    // Legitimate content keys ARE still forwarded; hopCount stays auto-managed.
    expect(insertedValues.payload.threadId).toBe("thread-7");
    expect(insertedValues.payload.hopCount).toBe(1);
  });

  it("SECURITY (Layer A): legitimate content keys survive the allowlist (threadId, issueId, entry refs)", async () => {
    const { db, valuesMock } = makeDb();
    const ctx = makeCtx(db);
    await agentDispatchTool.execute(
      {
        agentId: "agent-target",
        context: {
          threadId: "thread-7",
          issueId: "issue-9",
          mentionEntryId: "entry-42",
          parentEntryId: "entry-7",
          entryId: "entry-1",
          hopCount: 0,
        },
      },
      ctx,
    );
    const p = valuesMock.mock.calls[0][0].payload;
    expect(p.threadId).toBe("thread-7");
    expect(p.issueId).toBe("issue-9");
    expect(p.mentionEntryId).toBe("entry-42");
    expect(p.parentEntryId).toBe("entry-7");
    expect(p.entryId).toBe("entry-1");
    expect(p.hopCount).toBe(1);
    // No stray keys leaked in.
    expect(Object.keys(p).sort()).toEqual(
      ["entryId", "hopCount", "issueId", "mentionEntryId", "parentEntryId", "threadId"],
    );
  });

  it("rejects missing agentId with INVALID_PARAMS", async () => {
    const { db, selectFn, insertFn } = makeDb();
    const ctx = makeCtx(db);
    const result = await agentDispatchTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(selectFn).not.toHaveBeenCalled();
    expect(insertFn).not.toHaveBeenCalled();
  });
});
