/**
 * thread-participation-runner — unit tests (Phase 2 / Task 2.1).
 *
 * `makeThreadParticipationRunner(db)` returns a `ParticipantRunner` that:
 *   1. Resolves the thread's company + thread-level autonomy from `discussions`.
 *   2. Resolves the company-level autonomy fallback from `internal_agent_config`.
 *   3. Resolves the crew role for the agent (resolveCrewRole — same path the
 *      dispatcher uses) so the trigger prompt is role-aware.
 *   4. Invokes `runAoaAgent(db, agentId, { companyId, source:"thread.participation",
 *      threadId, mention: prompt, effectiveAutonomy, role })`.
 *   5. Returns `""` (empty) — the agent SELF-POSTS its reply via the `post_entry`
 *      MCP tool DURING its run. `requestParticipation` skips its own entry-insert
 *      on the empty return, so there is NO double-post.
 *
 * This mirrors `controller-adjutant-runner.test.ts` (Proxy-table-stub +
 * sequence-db pattern; runner.js + resolve-crew-role.js module-mocked so no
 * real CLI spawn and no aoaAgentTriggers read).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  sql: Object.assign(
    vi.fn((s: TemplateStringsArray) => ({ _sql: s })),
    { raw: vi.fn() },
  ),
}));

// ── @armyofagents/db mock ─────────────────────────────────────────────────────
function tableProxy(name: string) {
  return new Proxy({}, { get(_t, prop) { return `${name}_${String(prop)}`; } });
}

vi.mock("@armyofagents/db", () => ({
  discussionEntries: tableProxy("discussionEntries"),
  discussions: tableProxy("discussions"),
  internalAgentConfig: tableProxy("internalAgentConfig"),
  threadAgentActions: tableProxy("threadAgentActions"),
}));

// ── Logger mock ───────────────────────────────────────────────────────────────
// Use vi.hoisted so the error spy is accessible as a stable module-level handle,
// matching the mockRunAoaAgent / mockResolveCrewRole pattern in this file.
const { mockLogError } = vi.hoisted(() => ({ mockLogError: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: mockLogError,
    })),
  },
}));

// ── runner.ts mock — we never want a real CLI spawn ──────────────────────────
// The default value path dynamic-imports runner.js; tests inject deps.runAgent
// and never hit it, but mock it anyway so the transitive heavy subtree
// (embeddings, ~40 tool modules) is never resolved against the partial db mock.
const { mockRunAoaAgent } = vi.hoisted(() => ({ mockRunAoaAgent: vi.fn() }));
vi.mock(
  "../services/internal-agent/aoa-agents/runner.js",
  () => ({ runAoaAgent: mockRunAoaAgent }),
);

// ── resolve-crew-role.ts mock ─────────────────────────────────────────────────
// The runner resolves the agent's crew role so the trigger prompt is role-aware.
// Module-mock it so the test controls the resolved role without an
// aoaAgentTriggers read.
const { mockResolveCrewRole } = vi.hoisted(() => ({ mockResolveCrewRole: vi.fn() }));
vi.mock(
  "../services/internal-agent/aoa-agents/resolve-crew-role.js",
  () => ({ resolveCrewRole: mockResolveCrewRole }),
);

// ── Import AFTER mocks ────────────────────────────────────────────────────────
import { makeThreadParticipationRunner } from "../services/internal-agent/aoa-agents/thread-participation-runner.js";

// ── DB builder helpers ────────────────────────────────────────────────────────

/**
 * Build a minimal stub db.
 *
 * The runner issues these selects in order:
 *   1. discussions          (threadRow)        — terminated by .limit(1)
 *   2. internalAgentConfig  (companyCfgRow)    — terminated by .limit(1)
 *   3. discussionEntries     count BEFORE run  — COUNT(*) awaited after .where()
 *   (runAgent runs)
 *   4. discussionEntries     count AFTER run   — COUNT(*) awaited after .where()
 *   5. threadAgentActions    post_reply probe  — awaited after .where() (fix (g),
 *      only when after<=before AND result.runId set)
 *
 * Review fix (g): the entry counts now use a COUNT(*) aggregate (rows of shape
 * [{ count }]) instead of a row LIMIT, and the post-detection probe reads
 * thread_agent_actions. The stub returns a flat sequence consumed at the terminal
 * op — `.limit()` for queries 1-2, awaiting `.where()` for queries 3-5.
 * resolveCrewRole is module-mocked so it does NOT touch this db.
 */
function makeDb(opts: {
  threadRow?: Record<string, unknown> | null;
  companyCfgRow?: Record<string, unknown> | null;
  beforeCount?: number;
  afterCount?: number;
  postReplyRows?: Array<Record<string, unknown>>;
}) {
  const {
    threadRow = null,
    companyCfgRow = null,
    beforeCount = 0,
    afterCount = 1,
    postReplyRows = [],
  } = opts;

  // Flat sequence of terminal results, consumed in issue order.
  const results: Array<Array<Record<string, unknown>>> = [
    threadRow ? [threadRow] : [],        // 1: discussions
    companyCfgRow ? [companyCfgRow] : [], // 2: internalAgentConfig
    [{ count: beforeCount }],             // 3: COUNT(*) before
    [{ count: afterCount }],              // 4: COUNT(*) after
    postReplyRows,                        // 5: thread_agent_actions probe
  ];
  let callIdx = 0;
  const next = () => Promise.resolve(results[callIdx++] ?? []);

  const db = {
    select: vi.fn(() => {
      // `where()` returns a thenable (for the awaited COUNT/probe queries) that
      // ALSO exposes `.limit()` (for the threadRow/companyCfg queries). Whichever
      // terminal the runner uses consumes exactly one sequence slot.
      const whereResult: Record<string, unknown> = {
        limit: vi.fn(() => next()),
        then: (resolve: (v: unknown) => unknown) => next().then(resolve),
      };
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn(() => whereResult),
      };
    }),
  };

  return db;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("makeThreadParticipationRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAoaAgent.mockReset();
    mockResolveCrewRole.mockReset();
    mockLogError.mockReset();
  });

  it("1: calls runAoaAgent with thread.participation payload and returns \"\" (agent self-posts)", async () => {
    mockRunAoaAgent.mockResolvedValue({ status: "succeeded" });
    mockResolveCrewRole.mockResolvedValue("scout");

    const db = makeDb({
      threadRow: { companyId: "company-abc", autonomyLevel: 2 },
      companyCfgRow: { autonomyLevel: 0 },
    });

    const runner = makeThreadParticipationRunner(db as any);
    const reply = await runner({
      threadId: "thread-42",
      agentId: "agent-scout-1",
      prompt: "@Scout what do you see?",
    });

    // Payload assertion — effectiveAutonomy resolves thread(2) ?? company(0) → 2.
    expect(mockRunAoaAgent).toHaveBeenCalledOnce();
    expect(mockRunAoaAgent).toHaveBeenCalledWith(
      db,
      "agent-scout-1",
      {
        companyId: "company-abc",
        source: "thread.participation",
        threadId: "thread-42",
        mention: "@Scout what do you see?",
        effectiveAutonomy: 2,
        role: "scout",
      },
    );

    // CRITICAL: the runner returns "" so requestParticipation skips its insert
    // (the agent already self-posted via post_entry). No double-post.
    expect(reply).toBe("");
  });

  it("2: effectiveAutonomy falls back to company autonomyLevel when thread.autonomyLevel is null", async () => {
    mockRunAoaAgent.mockResolvedValue({ status: "succeeded" });
    mockResolveCrewRole.mockResolvedValue("engineer");

    const db = makeDb({
      threadRow: { companyId: "company-l1", autonomyLevel: null },
      companyCfgRow: { autonomyLevel: 1 },
    });

    const runner = makeThreadParticipationRunner(db as any);
    await runner({ threadId: "thread-l1", agentId: "agent-eng-1", prompt: "ship it" });

    expect(mockRunAoaAgent).toHaveBeenCalledOnce();
    const payload = mockRunAoaAgent.mock.calls[0][2];
    expect(payload.effectiveAutonomy).toBe(1);
  });

  it("3: effectiveAutonomy defaults to 0 when neither thread nor company config sets it", async () => {
    mockRunAoaAgent.mockResolvedValue({ status: "succeeded" });
    mockResolveCrewRole.mockResolvedValue("planner");

    const db = makeDb({
      threadRow: { companyId: "company-x", autonomyLevel: null },
      companyCfgRow: null, // no internal_agent_config row
    });

    const runner = makeThreadParticipationRunner(db as any);
    await runner({ threadId: "thread-x", agentId: "agent-planner-1", prompt: "plan" });

    const payload = mockRunAoaAgent.mock.calls[0][2];
    expect(payload.effectiveAutonomy).toBe(0);
  });

  it("4: passes the resolved crew role through so the trigger prompt is role-aware", async () => {
    mockRunAoaAgent.mockResolvedValue({ status: "succeeded" });
    mockResolveCrewRole.mockResolvedValue("engineer");

    const db = makeDb({
      threadRow: { companyId: "company-role", autonomyLevel: 2 },
      companyCfgRow: { autonomyLevel: 0 },
    });

    const runner = makeThreadParticipationRunner(db as any);
    await runner({ threadId: "thread-role", agentId: "agent-eng-2", prompt: "@Engineer build" });

    expect(mockResolveCrewRole).toHaveBeenCalledWith(db, "agent-eng-2");
    const payload = mockRunAoaAgent.mock.calls[0][2];
    expect(payload.role).toBe("engineer");
  });

  it("5: role is undefined (omitted) when resolveCrewRole returns null — payload still valid", async () => {
    mockRunAoaAgent.mockResolvedValue({ status: "succeeded" });
    mockResolveCrewRole.mockResolvedValue(null);

    const db = makeDb({
      threadRow: { companyId: "company-norole", autonomyLevel: 2 },
      companyCfgRow: { autonomyLevel: 0 },
    });

    const runner = makeThreadParticipationRunner(db as any);
    const reply = await runner({ threadId: "thread-norole", agentId: "agent-unknown", prompt: "hi" });

    expect(mockRunAoaAgent).toHaveBeenCalledOnce();
    const payload = mockRunAoaAgent.mock.calls[0][2];
    // null role → the field is omitted (undefined), not literal null, so the
    // prompt builder's `typeof payload.role === "string"` check skips it cleanly.
    expect(payload.role).toBeUndefined();
    expect(reply).toBe("");
  });

  it("6: returns \"\" when the underlying run fails (Unit E: now logs error, still preserves B1 no-double-post)", async () => {
    // A failed run must still return "" — requestParticipation must not
    // synthesize an entry attributed to the agent (that would misattribute
    // the error text to the agent). Unit E (Phase 1) adds a log.error call
    // so the failure is no longer silently swallowed / mislabeled as a
    // "self-posted via MCP" debug message.
    mockRunAoaAgent.mockResolvedValue({ status: "failed", errorMessage: "cli exited 1" });
    mockResolveCrewRole.mockResolvedValue("scout");

    const db = makeDb({
      threadRow: { companyId: "company-fail", autonomyLevel: 1 },
      companyCfgRow: { autonomyLevel: 0 },
    });

    const runner = makeThreadParticipationRunner(db as any);
    const reply = await runner({ threadId: "thread-fail", agentId: "agent-scout-f", prompt: "go" });

    // B1 contract preserved: "" → no double-post.
    expect(reply).toBe("");
    // Unit E contract: the failed run is SURFACED — not silently swallowed.
    // A future refactor that re-swallows the error will break this assertion.
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it("7: throws when a successful run produced NO post action and posted no entry", async () => {
    // No runId on the result AND no post_reply action → genuinely posted nothing.
    mockRunAoaAgent.mockResolvedValue({ status: "succeeded" });
    mockResolveCrewRole.mockResolvedValue("adjutant");

    const db = makeDb({
      threadRow: { companyId: "company-no-post", autonomyLevel: 1 },
      companyCfgRow: { autonomyLevel: 0 },
      beforeCount: 1,
      afterCount: 1, // unchanged → no new agent entry
      postReplyRows: [], // no post_reply action produced
    });

    const runner = makeThreadParticipationRunner(db as any);
    await expect(
      runner({ threadId: "thread-no-post", agentId: "agent-adj", prompt: "@Adjutant respond" }),
    ).rejects.toThrow(/without an agent-authored post_entry/i);
  });

  it("7b: returns benignly (no throw) when the post_reply was suppressed-stale (fix (g))", async () => {
    // The gated agent queued a post_reply that runAoaAgent then suppressed as
    // stale (a newer human entry arrived). Entry count is unchanged, but this is
    // a benign outcome — the runner must NOT throw.
    mockRunAoaAgent.mockResolvedValue({ status: "succeeded", runId: "run-stale" });
    mockResolveCrewRole.mockResolvedValue("planner");

    const db = makeDb({
      threadRow: { companyId: "company-stale", autonomyLevel: 1 },
      companyCfgRow: { autonomyLevel: 0 },
      beforeCount: 3,
      afterCount: 3, // unchanged
      postReplyRows: [{ status: "suppressed_stale" }],
    });

    const runner = makeThreadParticipationRunner(db as any);
    const reply = await runner({
      threadId: "thread-stale",
      agentId: "agent-planner",
      prompt: "@Planner take this",
    });

    // Benign info return — no throw, no synthesized entry.
    expect(reply).toBe("");
  });

  it("7c: returns benignly when a post_reply WAS produced even if no new entry counted (fix (g))", async () => {
    mockRunAoaAgent.mockResolvedValue({ status: "succeeded", runId: "run-produced" });
    mockResolveCrewRole.mockResolvedValue("engineer");

    const db = makeDb({
      threadRow: { companyId: "company-produced", autonomyLevel: 1 },
      companyCfgRow: { autonomyLevel: 0 },
      beforeCount: 5,
      afterCount: 5,
      postReplyRows: [{ status: "committed" }],
    });

    const runner = makeThreadParticipationRunner(db as any);
    const reply = await runner({
      threadId: "thread-produced",
      agentId: "agent-eng",
      prompt: "@Engineer build",
    });

    expect(reply).toBe("");
  });

  it("7d: COUNT(*) above 1000 is read correctly — a posted entry is detected (fix (g))", async () => {
    // Regression for the old `.limit(1000)` cap: with 1500 before / 1501 after the
    // count must reflect the true totals so the new-entry check passes (no throw,
    // no spurious post-action probe).
    mockRunAoaAgent.mockResolvedValue({ status: "succeeded", runId: "run-big" });
    mockResolveCrewRole.mockResolvedValue("scout");

    const db = makeDb({
      threadRow: { companyId: "company-big", autonomyLevel: 1 },
      companyCfgRow: { autonomyLevel: 0 },
      beforeCount: 1500,
      afterCount: 1501, // a real new entry above the old 1000 cap
    });

    const runner = makeThreadParticipationRunner(db as any);
    const reply = await runner({
      threadId: "thread-big",
      agentId: "agent-scout-big",
      prompt: "go",
    });

    expect(reply).toBe("");
  });

  it("8: throws when the thread is not found (caller surfaces the error)", async () => {
    mockResolveCrewRole.mockResolvedValue("scout");
    const db = makeDb({ threadRow: null });

    const runner = makeThreadParticipationRunner(db as any);
    await expect(
      runner({ threadId: "thread-missing", agentId: "agent-x", prompt: "hi" }),
    ).rejects.toThrow(/thread not found/i);

    expect(mockRunAoaAgent).not.toHaveBeenCalled();
  });
});
