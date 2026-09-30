/**
 * Task 1.2 — Route controller-path @mentions through the controller
 * (`requestParticipation`) instead of dropping them on the now-skipped peer-wake
 * pipeline.
 *
 * THE BUG (confirmed live: 1 stranded `queued` row): a human `@Scout`-ing a crew
 * agent on a modern (controller-path) thread inserts a `thread_mention` peer-wake
 * row — which the dispatcher then TERMINALIZES as `skipped_controller_path`
 * (Task 1.1). Net: the mentioned agent NEVER runs. The mention is dropped.
 *
 * THE FIX: `processMentions` fetches the thread row (`useControllerPath`,
 * `companyId`) + the inviting entry's `rawContent`, and for a controller-path
 * thread calls `threadOrchestrationService(db).requestParticipation(threadId,
 * { agentId, prompt: <entry rawContent> }, {})` — which actually RUNS the agent
 * (the agent self-posts; Task 2.1 handles no-double-post). Legacy
 * (`useControllerPath=false`) threads keep the peer-wake `agent_wakeup_requests`
 * insert unchanged.
 *
 * Cases:
 *   (a) controller-path thread + crew @mention → requestParticipation(threadId,
 *       {agentId, prompt: <entry text>}); NO peer-wake insert.
 *   (b) legacy thread + crew @mention → peer-wake insert; NO requestParticipation.
 *   (c) @mention of a NON-agent name → neither (no peer-wake, no participation).
 *
 * Harness: the same sequence-based select/insert mock used by threads-mention.ts,
 * extended to account for the two NEW per-call selects (thread row + entry text)
 * that precede the per-mention agent/trigger/user lookups. requestParticipation
 * is a hoisted spy on a mocked thread-orchestration module.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted spy for requestParticipation (controller path) ───────────────────
const { requestParticipationMock } = vi.hoisted(() => ({
  requestParticipationMock: vi
    .fn()
    .mockResolvedValue({ spawned: true, hopCount: 1, entryId: null }),
}));

// processMentions lazy-imports thread-orchestration. Mocking the module makes the
// dynamic import resolve to this stub (vitest intercepts both static + dynamic).
vi.mock("../services/thread-orchestration.js", () => ({
  threadOrchestrationService: vi.fn(() => ({
    requestParticipation: requestParticipationMock,
  })),
}));

// ── drizzle-orm + db mocks (column-name proxies; no-op operators) ─────────────
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  agents: {
    id: "agents_id",
    companyId: "agents_company_id",
    name: "agents_name",
    kind: "agents_kind",
  },
  authUsers: { id: "auth_id", name: "auth_name" },
  companyMemberships: {
    id: "cm_id",
    companyId: "cm_company_id",
    principalId: "cm_principal_id",
    principalType: "cm_principal_type",
  },
  agentWakeupRequests: {
    id: "awr_id",
    companyId: "awr_company_id",
    agentId: "awr_agent_id",
    source: "awr_source",
    triggerDetail: "awr_trigger_detail",
    reason: "awr_reason",
    payload: "awr_payload",
    status: "awr_status",
    requestedByActorType: "awr_requested_by_actor_type",
    requestedByActorId: "awr_requested_by_actor_id",
  },
  aoaAgentTriggers: { id: "aat_id", agentId: "aat_agent_id", kind: "aat_kind", config: "aat_config" },
  discussions: { id: "d_id", companyId: "d_company_id", useControllerPath: "d_use_controller_path" },
  discussionEntries: { id: "de_id", rawContent: "de_raw_content" },
  notifications: { id: "n_id" },
}));

import { processMentions } from "../services/threads.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sequence-based mock DB.
//
// The select order inside the NEW processMentions for a single mention is:
//   0. thread row     (discussions: useControllerPath, companyId)   [per-call]
//   1. entry text     (discussionEntries: rawContent)               [per-call]
//   2. agent lookup   (agents)                                      [per-mention]
//   3. trigger config (aoaAgentTriggers)  — only when agent resolved
//   3'. user lookup   (authUsers)          — only when NO agent resolved
// ─────────────────────────────────────────────────────────────────────────────
function makeMockDb(selectQueue: unknown[][]) {
  let selectIdx = 0;
  const insertValues = vi.fn().mockReturnThis();
  const insertChain: any = {
    values: insertValues,
    returning: vi.fn(() => Promise.resolve([{ id: "row-stub" }])),
    onConflictDoNothing: vi.fn().mockReturnThis(),
  };
  const selectChain: any = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (rows: unknown[]) => unknown) =>
      Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
    ),
  };
  const insertMock = vi.fn(() => insertChain);
  return {
    db: { select: vi.fn(() => selectChain), insert: insertMock } as any,
    insertValues,
    insertMock,
  };
}

const CONTROLLER_THREAD = [{ useControllerPath: true, companyId: "company-1" }];
const LEGACY_THREAD = [{ useControllerPath: false, companyId: "company-1" }];
const ENTRY_TEXT = [{ rawContent: "@Scout please research the competitor landscape" }];

describe("Task 1.2 — controller-path @mention routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestParticipationMock.mockResolvedValue({ spawned: true, hopCount: 1, entryId: null });
  });

  // (a) controller-path thread + crew mention → requestParticipation, NO peer-wake.
  it("(a) calls requestParticipation(threadId, {agentId, prompt: <entry text>}) on a controller-path thread — NOT a peer-wake insert", async () => {
    const { db, insertMock } = makeMockDb([
      CONTROLLER_THREAD, // 0 thread row
      ENTRY_TEXT, // 1 entry text
      [{ id: "agent-scout", name: "Scout" }], // 2 agent lookup
      [{ config: { role: "scout" } }], // 3 trigger config
    ]);

    await processMentions(db, "company-1", "thread-1", "entry-1", [
      { raw: "@Scout", name: "Scout" },
    ]);

    expect(requestParticipationMock).toHaveBeenCalledTimes(1);
    expect(requestParticipationMock).toHaveBeenCalledWith(
      "thread-1",
      {
        agentId: "agent-scout",
        prompt: "@Scout please research the competitor landscape",
      },
      {},
    );
    // No peer-wake insert on the controller path.
    expect(insertMock).not.toHaveBeenCalled();
  });

  // (b) legacy thread + crew mention → peer-wake insert, NO requestParticipation.
  it("(b) keeps the peer-wake insert on a legacy (useControllerPath=false) thread — NO requestParticipation", async () => {
    const { db, insertMock, insertValues } = makeMockDb([
      LEGACY_THREAD, // 0 thread row
      ENTRY_TEXT, // 1 entry text
      [{ id: "agent-scout", name: "Scout" }], // 2 agent lookup
      [{ config: { role: "scout" } }], // 3 trigger config
    ]);

    await processMentions(db, "company-1", "thread-1", "entry-1", [
      { raw: "@Scout", name: "Scout" },
    ]);

    expect(requestParticipationMock).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: "agent-scout",
        source: "thread_mention",
      }),
    );
  });

  // (c) non-agent mention → neither path (no peer-wake, no participation).
  it("(c) a @mention of a NON-agent name triggers neither requestParticipation nor a peer-wake insert", async () => {
    const { db, insertMock } = makeMockDb([
      CONTROLLER_THREAD, // 0 thread row
      ENTRY_TEXT, // 1 entry text
      [], // 2 agent lookup → not an agent
      [], // 3 user lookup → not a member either
    ]);

    await processMentions(db, "company-1", "thread-1", "entry-1", [
      { raw: "@nobody", name: "nobody" },
    ]);

    expect(requestParticipationMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  // Multiple crew mentions on one entry dispatch each (controller path).
  // NOTE: on the controller path there is NO per-mention trigger-config lookup
  // (we route to requestParticipation and `continue`), so each mention consumes
  // exactly ONE select slot (the agent lookup) after the two per-call selects.
  it("dispatches requestParticipation once per crew mention on a controller-path thread", async () => {
    const { db } = makeMockDb([
      CONTROLLER_THREAD, // 0 thread row
      ENTRY_TEXT, // 1 entry text
      [{ id: "agent-scout", name: "Scout" }], // 2 @Scout agent lookup
      [{ id: "agent-eng", name: "Engineer" }], // 3 @Engineer agent lookup
    ]);

    await processMentions(db, "company-1", "thread-1", "entry-1", [
      { raw: "@Scout", name: "Scout" },
      { raw: "@Engineer", name: "Engineer" },
    ]);

    expect(requestParticipationMock).toHaveBeenCalledTimes(2);
    expect(requestParticipationMock).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.objectContaining({ agentId: "agent-scout" }),
      {},
    );
    expect(requestParticipationMock).toHaveBeenNthCalledWith(
      2,
      "thread-1",
      expect.objectContaining({ agentId: "agent-eng" }),
      {},
    );
  });

  it("does not let a slow first controller-path crew mention block later crew mentions", async () => {
    let releaseFirst: (value: { spawned: true; hopCount: number; entryId: null }) => void = () => {};
    const firstRun = new Promise<{ spawned: true; hopCount: number; entryId: null }>((resolve) => {
      releaseFirst = resolve;
    });
    requestParticipationMock
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue({ spawned: true, hopCount: 1, entryId: null });

    const { db } = makeMockDb([
      CONTROLLER_THREAD, // 0 thread row
      ENTRY_TEXT, // 1 entry text
      [{ id: "agent-scout", name: "Scout" }], // 2 @Scout agent lookup
      [{ id: "agent-eng", name: "Engineer" }], // 3 @Engineer agent lookup
    ]);

    const processing = processMentions(db, "company-1", "thread-1", "entry-1", [
      { raw: "@Scout", name: "Scout" },
      { raw: "@Engineer", name: "Engineer" },
    ]);

    await vi.waitFor(() => {
      expect(requestParticipationMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    expect(requestParticipationMock).toHaveBeenCalledTimes(2);
    expect(requestParticipationMock).toHaveBeenNthCalledWith(
      1,
      "thread-1",
      expect.objectContaining({ agentId: "agent-scout" }),
      {},
    );
    expect(requestParticipationMock).toHaveBeenNthCalledWith(
      2,
      "thread-1",
      expect.objectContaining({ agentId: "agent-eng" }),
      {},
    );

    releaseFirst({ spawned: true, hopCount: 1, entryId: null });
    await processing;
  });
});
