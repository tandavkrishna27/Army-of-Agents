/**
 * threads-mention.test.ts
 * TDD: Task 1 — @mention parsing + agent wakeup / human notification dispatch
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must come before imports that use them) ──────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  or: vi.fn((...args: any[]) => ({ or: args })),
  inArray: vi.fn((a: any, b: any) => ({ inArray: [a, b] })),
  // hubItems.emit builds `onConflictDoUpdate({ setWhere: sql`…` })` — the mock
  // must be callable as a tag function so the emit path doesn't throw.
  sql: vi.fn((...args: any[]) => ({ sql: args })),
}));

vi.mock("@armyofagents/db", () => ({
  agents: {
    id: "agents_id",
    companyId: "agents_company_id",
    name: "agents_name",
    kind: "agents_kind",
    slug: "agents_slug",
  },
  authUsers: {
    id: "auth_id",
    companyId: "auth_company_id",
    name: "auth_name",
    email: "auth_email",
  },
  companyMemberships: {
    id: "cm_id",
    companyId: "cm_company_id",
    userId: "cm_user_id",
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
  notifications: {
    id: "n_id",
    companyId: "n_company_id",
    userId: "n_user_id",
    type: "n_type",
    title: "n_title",
    message: "n_message",
    relatedEntityType: "n_related_entity_type",
    relatedEntityId: "n_related_entity_id",
  },
  // hubItems aliases the notifications table; the human-mention path now routes
  // through hubItemsService(db).emit which references these columns.
  hubItems: {
    id: "hub_id",
    status: "hub_status",
    sourceUniqueKey: "hub_source_unique_key",
  },
  hubItemUserState: {},
  hubAudit: {},
  approvals: {},
  heartbeatRuns: {},
  // UAT iteration 2: processMentions now looks up the agent's mention-
  // trigger config to include role in the wakeup payload (so the dispatcher
  // autonomy gate can read it).
  aoaAgentTriggers: {
    id: "aat_id",
    agentId: "aat_agent_id",
    kind: "aat_kind",
    config: "aat_config",
  },
  // Task 1.2: processMentions now fetches the thread row (useControllerPath +
  // companyId) and the inviting entry's rawContent up front, to decide between
  // the controller participation path and the legacy peer-wake insert.
  discussions: {
    id: "discussions_id",
    companyId: "discussions_company_id",
    useControllerPath: "discussions_use_controller_path",
  },
  discussionEntries: {
    id: "entries_id",
    rawContent: "entries_raw_content",
  },
}));

// Import the pure function (no DB) directly
import { parseMentions, processMentions } from "../services/threads.js";

// ── parseMentions ─────────────────────────────────────────────────────────────

describe("parseMentions", () => {
  it("extracts a single @mention from text", () => {
    expect(parseMentions("Hello @alice")).toEqual([{ raw: "@alice", name: "alice" }]);
  });

  it("extracts multiple @mentions from text", () => {
    const result = parseMentions("Hello @alice and @Bot");
    expect(result).toEqual([
      { raw: "@alice", name: "alice" },
      { raw: "@Bot", name: "Bot" },
    ]);
  });

  it("returns empty array when no mentions", () => {
    expect(parseMentions("No mentions here")).toEqual([]);
    expect(parseMentions("")).toEqual([]);
  });

  it("deduplicates repeated mentions", () => {
    const result = parseMentions("@alice and @alice again");
    // alice appears twice — deduped to one
    expect(result.filter((m) => m.name === "alice").length).toBe(1);
  });

  it("ignores email-style @ (mentions must be standalone word)", () => {
    // user@example.com should not extract "example" as a mention
    const result = parseMentions("Email user@example.com here");
    // "@example" is preceded by "user" not whitespace/start — should not match
    const names = result.map((m) => m.name);
    expect(names).not.toContain("example");
  });

  it("handles mention at start of string", () => {
    const result = parseMentions("@Bot please help");
    expect(result).toEqual([{ raw: "@Bot", name: "Bot" }]);
  });
});

// ── processMentions ────────────────────────────────────────────────────────────

describe("processMentions (dispatch)", () => {
  function makeMockDb({
    agentRow,
    authRow,
    triggerRole,
  }: {
    agentRow?: any;
    authRow?: any;
    /** Role string returned from the aoaAgentTriggers lookup when agentRow resolves. */
    triggerRole?: string;
  }) {
    const insertValues = vi.fn().mockReturnThis();
    // `.returning()` resolves to a single-row array so `const [row] = await …`
    // destructures cleanly. The human-mention path now goes through
    // hubItems.emit → insert().values().onConflictDoUpdate().returning().
    const insertChain: any = {
      values: insertValues,
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "notif-stub" }])),
    };

    // Queue mirrors the actual sequence of selects in processMentions():
    //   0. thread row     (discussions: useControllerPath, companyId)  [per-call, Task 1.2]
    //   1. entry text      (discussionEntries: rawContent)             [per-call, Task 1.2]
    //   2. agent lookup    (always)
    //   3. if agent found: aoaAgentTriggers lookup (UAT iter 2 fix; legacy path only)
    //   3'. if no agent: user lookup
    // These tests exercise the LEGACY peer-wake path, so the thread row is
    // useControllerPath=false (controller-path routing has its own suite,
    // controller-mention-dispatch.test.ts).
    const LEGACY_THREAD = [{ useControllerPath: false, companyId: "company-1" }];
    const ENTRY_TEXT = [{ rawContent: "@mention text" }];
    const selectQueue: any[][] = agentRow
      ? [
          LEGACY_THREAD,
          ENTRY_TEXT,
          [agentRow],
          triggerRole != null ? [{ config: { role: triggerRole } }] : [{ config: null }],
        ]
      : [LEGACY_THREAD, ENTRY_TEXT, [], authRow ? [authRow] : []];
    let selectIdx = 0;

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
      ),
    };

    return {
      db: {
        select: vi.fn(() => selectChain),
        insert: vi.fn(() => insertChain),
      } as any,
      insertValues,
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("creates an agent_wakeup_requests row when mention resolves to an agent", async () => {
    const { db, insertValues } = makeMockDb({
      agentRow: { id: "agent-1", name: "Bot", slug: "bot" },
    });

    await processMentions(
      db,
      "company-1",
      "thread-1",
      "entry-1",
      [{ raw: "@Bot", name: "Bot" }],
    );

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: "agent-1",
        source: "thread_mention",
      }),
    );
  });

  it("UAT iter 2 regression: populates payload.role from aoaAgentTriggers.config.role so the dispatcher autonomy gate can evaluate crew-role @mentions (router/planner/dispatcher → require L2). Without this, every @Router/@Planner mention bypassed the gate", async () => {
    const { db, insertValues } = makeMockDb({
      agentRow: { id: "agent-router", name: "Router" },
      triggerRole: "router",
    });

    await processMentions(
      db,
      "company-1",
      "thread-1",
      "entry-1",
      [{ raw: "@Router", name: "Router" }],
    );

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          threadId: "thread-1",
          entryId: "entry-1",
          mention: "@Router",
          role: "router",
        }),
      }),
    );
  });

  it("UAT iter 2: when the agent has no mention-trigger config, payload.role is omitted (not 'undefined' string) so the dispatcher's payloadRole truthy-check skips the gate cleanly", async () => {
    const { db, insertValues } = makeMockDb({
      agentRow: { id: "agent-1", name: "Bot" },
      // triggerRole intentionally undefined → trigger row has config: null
    });

    await processMentions(
      db,
      "company-1",
      "thread-1",
      "entry-1",
      [{ raw: "@Bot", name: "Bot" }],
    );

    const call = insertValues.mock.calls[0]?.[0];
    expect(call.payload).not.toHaveProperty("role");
  });

  it("emits a hub item (mention) when mention resolves to a human user", async () => {
    const { db, insertValues } = makeMockDb({
      agentRow: null, // no agent with that name
      authRow: { id: "user-1", name: "alice" },
    });

    await processMentions(
      db,
      "company-1",
      "thread-1",
      "entry-1",
      [{ raw: "@alice", name: "alice" }],
    );

    expect(db.insert).toHaveBeenCalledTimes(1);
    // Routed through hubItems.emit: semanticType `mention`, sourceType
    // `discussion`, owner = the mentioned user (legacy `userId` kept in lockstep
    // so the legacy notification bell still reads the row).
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        userId: "user-1",
        ownerUserId: "user-1",
        type: "mention",
        semanticType: "mention",
        sourceType: "discussion",
        sourceId: "thread-1:entry-1:user-1",
      }),
    );
  });

  it("skips mentions that resolve to neither agent nor user", async () => {
    const { db, insertValues } = makeMockDb({
      agentRow: null,
      authRow: null,
    });

    await processMentions(
      db,
      "company-1",
      "thread-1",
      "entry-1",
      [{ raw: "@unknown", name: "unknown" }],
    );

    expect(insertValues).not.toHaveBeenCalled();
  });

  it("handles multiple mentions in one call", async () => {
    // We need a mock db that returns two different results for agent lookups
    const insertValues = vi.fn().mockReturnThis();
    const insertChain: any = {
      values: insertValues,
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn(() => Promise.resolve([{ id: "notif-stub" }])),
    };

    // selectQueue mirrors processMentions() select order (Task 1.2 prepends the
    // per-call thread-row + entry-text selects; legacy thread → peer-wake path):
    //   thread row (useControllerPath=false) → entry text →
    //   @Bot → agent lookup (found) → aoaAgentTriggers lookup (UAT iter 2)
    //   @alice → agent lookup (not found) → user lookup
    const selectQueue = [
      [{ useControllerPath: false, companyId: "company-1" }], // 0 thread row
      [{ rawContent: "@Bot and @alice" }], // 1 entry text
      [{ id: "agent-1", name: "Bot" }], // @Bot → agent lookup (found)
      [{ config: null }], // @Bot → triggers lookup (no role configured)
      [], // @alice → agent lookup (not found)
      [{ id: "user-2", name: "alice" }], // @alice → user lookup (found)
    ];
    let idx = 0;
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[idx++] ?? [])),
      ),
    };
    const db = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => insertChain),
    } as any;

    await processMentions(
      db,
      "company-1",
      "thread-1",
      "entry-1",
      [
        { raw: "@Bot", name: "Bot" },
        { raw: "@alice", name: "alice" },
      ],
    );

    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});
