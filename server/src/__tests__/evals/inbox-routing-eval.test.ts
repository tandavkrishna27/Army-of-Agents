/**
 * inbox-routing-eval.test.ts — routing regression eval gate (C9)
 *
 * Tests the routing state machine for known scenarios without LLM calls.
 * All cases assert that routeInboxItem produces the correct action+outcome pair.
 *
 * Scenarios:
 *   - dial=off → human/off
 *   - ZERO active threads (Option A) → STILL escalate_navigator (creates first thread)
 *   - active threads present, dial≥suggest → escalate_navigator
 *   - Navigator not found → failed (not a crash)
 *   - stale claim (already handled) → human/already_claimed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  ne: vi.fn((a: unknown, b: unknown) => ({ _op: "ne", a, b })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ _op: "inArray", a, b })),
  isNotNull: vi.fn((a: unknown) => ({ _op: "isNotNull", a })),
  lt: vi.fn((a: unknown, b: unknown) => ({ _op: "lt", a, b })),
}));

vi.mock("@armyofagents/db", () => ({
  agents: new Proxy({} as any, { get: (_t, p) => p }),
  agentWakeupRequests: new Proxy({} as any, { get: (_t, p) => p }),
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => p }),
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock("../../services/activity-log.js", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));

import { routeInboxItem } from "../../services/inbox-router.js";

const CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NAV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const T1  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function buildDb(scenario: {
  dial?: string;
  claimed?: boolean;
  hasNav?: boolean;
  hasThreads?: boolean;
}) {
  const { dial = "suggest", claimed = true, hasNav = true, hasThreads = true } = scenario;
  const claimRow = claimed ? [{ id: IID, companyId: CID, rawContent: "inbound text" }] : [];
  const configRow = [{ inboundRoutingLevel: dial }];
  const navRow = hasNav ? [{ id: NAV }] : [];
  const threadRows = hasThreads ? [{ id: T1, title: "T", summaryText: "S", routingTerms: null }] : [];

  // Actual select order in routeInboxItem: config → cards (discussions) → Navigator.
  const selectSeq = [configRow, threadRows, navRow];
  let si = 0;
  const updateBuf = [claimRow, [], []]; // claim(returning), then status update(s)
  let ui = 0;

  // UPDATE must support both `.returning()` (claim) and awaited form (status writes).
  const whereResult = () => {
    const res = updateBuf[ui++] ?? [];
    return {
      returning: () => Promise.resolve(res),
      then: (resolve: Function) => resolve(res),
      catch: () => Promise.resolve(res),
    };
  };

  return {
    update: () => ({ set: () => ({ where: whereResult }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(selectSeq[si++] ?? []) }) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "wakeup-1" }]) }) }),
  } as any;
}

describe("routing regression eval (C9)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("S1: dial=off → human/off", async () => {
    const r = await routeInboxItem(buildDb({ dial: "off" }), { inboxItemId: IID });
    expect(r.action).toBe("human");
    expect(r.outcome).toBe("off");
  });

  it("S2: already claimed → no-op, human/already_claimed", async () => {
    const r = await routeInboxItem(buildDb({ claimed: false }), { inboxItemId: IID });
    expect(r.action).toBe("human");
    expect(r.outcome).toBe("already_claimed");
  });

  it("S3: ZERO active threads → Option A → escalate_navigator (creates first thread)", async () => {
    const r = await routeInboxItem(buildDb({ hasThreads: false }), { inboxItemId: IID });
    expect(r.action).toBe("escalate_navigator");
    expect(r.outcome).toBe("navigator_woken");
  });

  it("S4: active threads + suggest dial → escalate_navigator", async () => {
    const r = await routeInboxItem(buildDb({ dial: "suggest" }), { inboxItemId: IID });
    expect(r.action).toBe("escalate_navigator");
    expect(r.outcome).toBe("navigator_woken");
  });

  it("S5: active threads + auto_attach dial → escalate_navigator", async () => {
    const r = await routeInboxItem(buildDb({ dial: "auto_attach" }), { inboxItemId: IID });
    expect(r.action).toBe("escalate_navigator");
  });

  it("S6: active threads + full_auto dial → escalate_navigator", async () => {
    const r = await routeInboxItem(buildDb({ dial: "full_auto" }), { inboxItemId: IID });
    expect(r.action).toBe("escalate_navigator");
  });

  it("S7: Navigator not found → outcome=failed (no crash)", async () => {
    const r = await routeInboxItem(buildDb({ hasNav: false }), { inboxItemId: IID });
    expect(r.outcome).toBe("failed");
  });
});
