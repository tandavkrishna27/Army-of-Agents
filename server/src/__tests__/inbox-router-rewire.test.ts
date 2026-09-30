/**
 * inbox-router-rewire.test.ts
 *
 * Tests for the rewired routeInboxItem (Navigator-over-cards design).
 *
 * Key assertions:
 * - dial='off'  → no wakeup queued, routingStatus='routed', routerDecision='human'
 * - dial≥suggest → claims → assembles snapshot → wakeup queued (payload carries
 *     inboundContent, NOT candidateCards), routingStatus='escalated'
 * - ZERO active threads (Option A) → STILL wakes the Navigator (it creates the
 *     first thread / suggests-new) — empty card set is NOT an error
 * - already claimed (0 rows from claim UPDATE) → no-op
 * - NAVIGATOR_NOT_FOUND → routingStatus='failed', outcome='failed'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  ne: vi.fn((a: unknown, b: unknown) => ({ _op: "ne", a, b })),
}));

vi.mock("@armyofagents/db", () => ({
  agents: new Proxy({} as any, { get: (_t, p) => p }),
  agentWakeupRequests: new Proxy({} as any, { get: (_t, p) => p }),
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => p }),
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const mockLogActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity-log.js", () => ({
  logActivity: (...a: any[]) => mockLogActivity(...a),
}));

import { routeInboxItem } from "../services/inbox-router.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INBOX_ITEM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NAVIGATOR_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const THREAD_1_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Capture inserted wakeup payloads so we can assert payload shape.
let insertedValues: any[] = [];

function makeDb({
  dial = "suggest",
  claimRows = [{ id: INBOX_ITEM_ID, companyId: COMPANY_ID, rawContent: "Hello from Acme" }],
  navRows = [{ id: NAVIGATOR_ID }],
  threadCardRows = [{ id: THREAD_1_ID, title: "Acme thread", summaryText: "About Acme", routingTerms: ["Acme"] }],
}: {
  dial?: string;
  claimRows?: object[];
  navRows?: object[];
  threadCardRows?: object[];
} = {}) {
  const updateResults: object[][] = [claimRows, [], []]; // claim(returning), then status/snapshot updates
  let updateCall = 0;

  // Actual select call order in routeInboxItem:
  //   1. config (dial)  2. cards (discussions, for snapshot)  3. Navigator (inside enqueue)
  const selectResults: object[][] = [
    [{ inboundRoutingLevel: dial }],  // config row
    threadCardRows,                   // active thread cards (discussions) — snapshot
    navRows,                          // Navigator agent lookup (inside enqueue)
  ];
  let selectCall = 0;

  const insertResult = [{ id: "wakeup-id-1" }];

  return {
    update: () => ({
      set: () => ({
        where: () => {
          const res = updateResults[updateCall++] ?? [];
          // Support both `.returning()` (claim) and awaited UPDATE (status writes).
          return {
            returning: () => Promise.resolve(res),
            then: (resolve: Function) => resolve(res),
            catch: () => Promise.resolve(res),
          };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResults[selectCall++] ?? []),
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        insertedValues.push(v);
        return { returning: () => Promise.resolve(insertResult) };
      },
    }),
  } as any;
}

describe("routeInboxItem (rewired)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues = [];
  });

  it("dial=off → no wakeup, routerDecision=human, outcome=off", async () => {
    const db = makeDb({ dial: "off" });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.action).toBe("human");
    expect(result.outcome).toBe("off");
    expect(insertedValues).toHaveLength(0); // Navigator NOT woken
  });

  it("claim returns 0 rows → no-op (already claimed)", async () => {
    const db = makeDb({ claimRows: [] });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.action).toBe("human");
    expect(result.outcome).toBe("already_claimed");
  });

  it("dial=suggest → Navigator woken; payload carries inboundContent, not cards", async () => {
    const db = makeDb({ dial: "suggest" });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.action).toBe("escalate_navigator");
    expect(result.outcome).toBe("navigator_woken");
    expect(insertedValues).toHaveLength(1);
    const payload = insertedValues[0].payload;
    expect(payload.inboxItemId).toBe(INBOX_ITEM_ID);
    expect(payload.inboundContent).toBe("Hello from Acme");
    expect(payload.candidateCards).toBeUndefined(); // cards are fetched fresh, not frozen
    expect(insertedValues[0].payload.threadId).toBeUndefined(); // Codex #4
  });

  it("ZERO active threads → STILL wakes Navigator (Option A — creates first thread)", async () => {
    const db = makeDb({ dial: "full_auto", threadCardRows: [] });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.action).toBe("escalate_navigator");
    expect(insertedValues).toHaveLength(1); // woken even with no candidates
  });

  it("NAVIGATOR_NOT_FOUND → outcome=failed (no throw)", async () => {
    const db = makeDb({ dial: "suggest", navRows: [] });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.outcome).toBe("failed");
  });
});
