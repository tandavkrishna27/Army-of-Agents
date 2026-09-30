// server/src/__tests__/discussions-add-entry-replay-authz.test.ts
//
// PR #291 round-2 review — route-level coverage for the add-entry endpoint:
//
//  C1 (P1): the clientSubmissionId replay lookup must run the SAME thread
//     authorization addEntry enforces BEFORE returning any replay, so a caller
//     who knows a prior key but cannot access the (private / cross-company)
//     thread gets the identical 404 — never the entry.
//
//  C4 (P1): when addEntry signals a replay (a simultaneous same-key race loser
//     that got back the winner's row), the route must NOT re-run processMentions
//     — otherwise the mentioned crew is summoned twice.
//
// Harness mirrors discussions-create-mentions-route.test.ts.

import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const DISCUSSION_ID = "22222222-2222-2222-2222-222222222222";
const ENTRY_ID = "33333333-3333-3333-3333-333333333333";

// ── Mocks (hoisted before the route import) ─────────────────────────────────

const mockAddEntry = vi.hoisted(() => vi.fn());
const mockGetEntryByClientSubmissionId = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  discussionService: () => ({
    addEntry: mockAddEntry,
    getEntryByClientSubmissionId: mockGetEntryByClientSubmissionId,
  }),
  logActivity: vi.fn().mockResolvedValue(undefined),
  permissionService: () => ({}),
}));

const mockProcessMentions = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAssertCanPostToThread = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/threads.js", () => ({
  parseMentions: vi.fn((text: string) =>
    [...String(text ?? "").matchAll(/(?:^|\s)@(\w+)/g)].map((m) => ({
      raw: `@${m[1]}`,
      name: m[1],
    })),
  ),
  processMentions: mockProcessMentions,
  assertCanPostToThread: mockAssertCanPostToThread,
  threadService: vi.fn(() => ({})),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertMemoryApproval: vi.fn().mockResolvedValue(undefined),
}));

import { discussionRoutes } from "../routes/discussions.js";
import { notFound } from "../errors.js";

// ── App harness ──────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  // local_implicit board actor → buildActor returns a founder Actor without
  // touching permissionService, and assertCompanyAccess passes.
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", discussionRoutes({} as any));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "error" });
  });
  return app;
}

function postEntry(body: Record<string, unknown>) {
  return request(createApp())
    .post(`/api/companies/${COMPANY_A}/discussions/${DISCUSSION_ID}/entries`)
    .send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets call history but NOT implementations — reset the async
  // return values explicitly so a resolved value from one test can't leak.
  mockProcessMentions.mockReset().mockResolvedValue(undefined);
  mockAssertCanPostToThread.mockReset().mockResolvedValue(undefined);
  mockGetEntryByClientSubmissionId.mockReset().mockResolvedValue(undefined);
  mockAddEntry.mockReset();
});

describe("POST /discussions/:id/entries — authorize before replay (C1)", () => {
  it("returns 404 and does NOT read the entry when the caller cannot access the thread", async () => {
    // Unauthorized: assertCanPostToThread rejects (hide-don't-403). A known key
    // must NOT leak the entry.
    mockAssertCanPostToThread.mockRejectedValue(notFound("Thread not found"));

    const res = await postEntry({
      inputType: "write",
      rawContent: "peek",
      clientSubmissionId: "known-key",
    });

    expect(res.status).toBe(404);
    // Authorization ran BEFORE any replay lookup, and neither the replay read
    // nor the insert happened.
    expect(mockAssertCanPostToThread).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_A,
      DISCUSSION_ID,
      expect.objectContaining({ role: "founder" }),
    );
    expect(mockGetEntryByClientSubmissionId).not.toHaveBeenCalled();
    expect(mockAddEntry).not.toHaveBeenCalled();
  });

  it("replays the entry (200) once the caller is authorized and the key is known", async () => {
    mockGetEntryByClientSubmissionId.mockResolvedValue({ id: ENTRY_ID, discussionId: DISCUSSION_ID });

    const res = await postEntry({
      inputType: "write",
      rawContent: "retry",
      clientSubmissionId: "known-key",
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ENTRY_ID);
    // Authorized first, then the replay was returned — no insert, no re-summon.
    expect(mockAssertCanPostToThread).toHaveBeenCalledOnce();
    expect(mockAddEntry).not.toHaveBeenCalled();
    expect(mockProcessMentions).not.toHaveBeenCalled();
  });
});

describe("POST /discussions/:id/entries — replay skips processMentions (C4)", () => {
  it("does NOT re-run processMentions when addEntry flags a race-loser replay", async () => {
    // Both same-key requests missed the pre-check; this one lost the insert race
    // and addEntry returned the winner's row flagged as a replay.
    mockAddEntry.mockResolvedValue({
      id: ENTRY_ID,
      discussionId: DISCUSSION_ID,
      rawContent: "@Scout look here",
      replayed: true,
    });

    const res = await postEntry({
      inputType: "write",
      rawContent: "@Scout look here",
      clientSubmissionId: "race-key",
    });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ENTRY_ID);
    // The winner already summoned the crew — the loser must not re-summon.
    expect(mockProcessMentions).not.toHaveBeenCalled();
    // The replay marker is stripped from the response body.
    expect(res.body.replayed).toBeUndefined();
  });

  it("does NOT summon synchronously for a freshly inserted entry — the outbox worker does (round-6 #3)", async () => {
    // The @mention summon is now enqueued to discussion_mention_outbox INSIDE
    // addEntry's transaction and drained exactly-once by the mention-outbox
    // worker. The route no longer calls processMentions — so a request failure
    // after commit can't lose the summon, and a same-key replay can't skip it.
    // (The atomic enqueue + worker drain are covered by the outbox integration
    // test; here we assert the route no longer summons inline.)
    mockAddEntry.mockResolvedValue({
      id: ENTRY_ID,
      discussionId: DISCUSSION_ID,
      rawContent: "@Scout look here",
    });

    const res = await postEntry({
      inputType: "write",
      rawContent: "@Scout look here",
      clientSubmissionId: "fresh-key",
    });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(ENTRY_ID);
    expect(mockProcessMentions).not.toHaveBeenCalled();
  });
});
