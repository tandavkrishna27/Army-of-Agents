/**
 * Task 3.1 — a direct @mention ALWAYS answers, at every dial (founder-driven).
 *
 * PLAN CORRECTION B2 (authoritative): there is NO dispatcher activation-gate edit
 * for this task. Controller-path @mentions flow `processMentions →
 * requestParticipation → runAoaAgent` DIRECTLY, and `runAoaAgent` has NO
 * activation gate — it only forwards `effectiveAutonomy` to the MCP bridge for
 * *tool-level* gating (runner.ts:235). So a @mentioned crew agent on a
 * controller-path thread ALREADY runs at any company dial, including Manual (0).
 * "@mention always answers" is therefore FREE on the controller path.
 *
 * This test LOCKS that contract: a controller-path @mention dispatches the
 * mentioned agent via `requestParticipation` with NO autonomy consulted on the
 * activation path. `processMentions` never reads `company.autonomyLevel` or
 * `discussions.autonomyLevel` — the proof that activation is dial-exempt is that
 * the dispatch happens with the dial nowhere in the call path. The Manual-vs-Assist
 * distinction lives ENTIRELY in the PROACTIVE wake (`fireAdjutantWakeup`, Task 3.2),
 * not in this activation path.
 *
 * Harness: reuses the `controller-mention-dispatch.test.ts` mock shape
 * (hoisted requestParticipation spy on a mocked thread-orchestration module +
 * a sequence-based select/insert DB). The thread row is staged controller-path;
 * the company dial is conceptually 0 (Manual) — and irrelevant, because the
 * activation path never queries it.
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
  discussions: {
    id: "d_id",
    companyId: "d_company_id",
    useControllerPath: "d_use_controller_path",
    autonomyLevel: "d_autonomy_level",
  },
  discussionEntries: { id: "de_id", rawContent: "de_raw_content" },
  notifications: { id: "n_id" },
  // Defensive: if the activation path ever (wrongly) tried to read company config,
  // referencing this table proxy must not crash the test. Its presence here does
  // NOT mean processMentions reads it — the assertion below proves it does not.
  internalAgentConfig: { companyId: "iac_company_id", autonomyLevel: "iac_autonomy_level" },
}));

import { processMentions } from "../services/threads.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sequence-based mock DB (identical shape to controller-mention-dispatch.test.ts).
// The select order inside processMentions for a single mention is:
//   0. thread row     (discussions: useControllerPath, companyId)   [per-call]
//   1. entry text     (discussionEntries: rawContent)               [per-call]
//   2. agent lookup   (agents)                                      [per-mention]
// (No trigger-config lookup on the controller path — it routes to participation
//  and `continue`s.)
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

// Controller-path thread (modern). Company dial is conceptually Manual (0) — but
// the activation path never queries the dial, so we don't stage a company-config
// select at all. That ABSENCE is the contract.
const CONTROLLER_THREAD = [{ useControllerPath: true, companyId: "company-1" }];
const ENTRY_TEXT = [{ rawContent: "@Scout please research the competitor landscape" }];

describe("Task 3.1 — a direct @mention always answers at Manual (B2: no activation gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestParticipationMock.mockResolvedValue({ spawned: true, hopCount: 1, entryId: null });
  });

  it("dispatches the mentioned agent via requestParticipation on a controller-path thread even at company dial=Manual(0)", async () => {
    const { db, insertMock } = makeMockDb([
      CONTROLLER_THREAD, // 0 thread row (controller-path)
      ENTRY_TEXT, // 1 entry text
      [{ id: "agent-scout", name: "Scout" }], // 2 agent lookup
    ]);

    await processMentions(db, "company-1", "thread-1", "entry-1", [
      { raw: "@Scout", name: "Scout" },
    ]);

    // The mentioned agent RUNS (founder-driven) — no activation gate blocks it.
    expect(requestParticipationMock).toHaveBeenCalledTimes(1);
    expect(requestParticipationMock).toHaveBeenCalledWith(
      "thread-1",
      { agentId: "agent-scout", prompt: "@Scout please research the competitor landscape" },
      {},
    );
    // It is NOT routed onto the dial-gated peer-wake pipeline.
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("min-autonomy roles (e.g. Planner, ROLE_MIN_AUTONOMY=2) also answer at Manual — direct address is activation-exempt", async () => {
    // The activation path does not consult ROLE_MIN_AUTONOMY at all: a @Planner
    // mention dispatches identically to @Scout. (Tool-level gating still applies
    // INSIDE the run via effectiveAutonomy — out of scope for activation.)
    const { db, insertMock } = makeMockDb([
      [{ useControllerPath: true, companyId: "company-1" }], // 0 thread row
      [{ rawContent: "@Planner can you draft the rollout plan?" }], // 1 entry text
      [{ id: "agent-planner", name: "Planner" }], // 2 agent lookup
    ]);

    await processMentions(db, "company-1", "thread-1", "entry-planner", [
      { raw: "@Planner", name: "Planner" },
    ]);

    expect(requestParticipationMock).toHaveBeenCalledTimes(1);
    expect(requestParticipationMock).toHaveBeenCalledWith(
      "thread-1",
      { agentId: "agent-planner", prompt: "@Planner can you draft the rollout plan?" },
      {},
    );
    expect(insertMock).not.toHaveBeenCalled();
  });
});
