// server/src/__tests__/discussions-create-mentions-route.test.ts
//
// Finding #7 (test-only) — route-level coverage for the create-with-first-message
// @mention dispatch (live-QA BUG-1 half b).
//
// POST /companies/:cid/discussions, when the create body carries a first entry
// whose rawContent contains an @mention, must dispatch those mentions via
// processMentions(db, companyId, discussionId, FIRST_ENTRY_ID, mentions) — exactly
// like the add-entry route does. Without this the @mention in an opening message
// is silently dropped.
//
// This asserts the route wiring only (no production change): processMentions is
// invoked with the first entry's id when create() returns an entry containing an
// @mention, and is NOT invoked when the first entry has no @mention.
//
// Harness mirrors routes-inbox-dismissals.test.ts (supertest + a local_implicit
// board actor so assertCompanyAccess passes) and p2-post-entry-tool.test.ts
// (mock ../services/threads.js so processMentions is a spy).

import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const DISCUSSION_ID = "22222222-2222-2222-2222-222222222222";
const FIRST_ENTRY_ID = "33333333-3333-3333-3333-333333333333";

// ── Mocks (hoisted before the route import) ─────────────────────────────────

// discussionService.create is the only service method the create route calls.
// logActivity + permissionService are also pulled from ../services/index.js by
// the route factory, so stub them too.
const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  discussionService: () => ({ create: mockCreate }),
  logActivity: vi.fn().mockResolvedValue(undefined),
  permissionService: () => ({}),
}));

// processMentions + parseMentions are spies. parseMentions mirrors the real
// @word regex so the route's `mentions.length > 0` branch fires for @mention text.
// threadService is exported from this module and called by the route factory
// (tSvc = threadService(db)) — stub it to a no-op object so module init succeeds.
const mockProcessMentions = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/threads.js", () => ({
  parseMentions: vi.fn((text: string) =>
    [...String(text ?? "").matchAll(/(?:^|\s)@(\w+)/g)].map((m) => ({
      raw: `@${m[1]}`,
      name: m[1],
    })),
  ),
  // Round-13 #2: the create route now resolves mentions multi-word-aware. In this
  // unit harness (no agent roster) it mirrors the parseMentions token behavior.
  resolveMentionTargets: vi.fn(async (_db: unknown, _companyId: string, text: string) =>
    [...String(text ?? "").matchAll(/(?:^|\s)@(\w+)/g)].map((m) => ({
      raw: `@${m[1]}`,
      name: m[1],
    })),
  ),
  processMentions: mockProcessMentions,
  threadService: vi.fn(() => ({})),
}));

// assertRole (rbac middleware) — the create route awaits it. No-op (allow).
vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertHumanRole: vi.fn().mockResolvedValue(undefined),
}));

import { discussionRoutes } from "../routes/discussions.js";
import { processMentions, resolveMentionTargets } from "../services/threads.js";

// ── App harness ──────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  // local_implicit board actor → assertCompanyAccess passes without companyIds.
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
  // Minimal error handler so thrown HttpErrors surface as JSON status codes.
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "error" });
  });
  return app;
}

describe("POST /discussions — first-message @mention dispatch (Finding #7 / round-15)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessMentions.mockResolvedValue(undefined);
  });

  it("threads the resolved opening mentions INTO svc.create (transactional outbox enqueue)", async () => {
    // Round-15: the summon is no longer a fire-and-forget processMentions from the
    // route. The route resolves the opening @mentions (round-14, pre-commit) and
    // passes them as svc.create's 4th arg, so svc.create enqueues the outbox row
    // IN the first-entry transaction (durable, retried-by-the-worker exactly once).
    mockCreate.mockResolvedValue({
      id: DISCUSSION_ID,
      companyId: COMPANY_A,
      title: "Need help",
      entry: {
        id: FIRST_ENTRY_ID,
        discussionId: DISCUSSION_ID,
        rawContent: "@Scout please dig into this",
        inputType: "write",
      },
    });

    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/discussions`)
      .send({
        title: "Need help",
        entry: { inputType: "write", rawContent: "@Scout please dig into this" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // The route no longer summons directly.
    expect(processMentions as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // The resolved mentions are passed as svc.create's 4th arg (enqueued in-tx).
    expect(mockCreate).toHaveBeenCalledOnce();
    const [calledCompanyId, , calledActorId, calledMentions] = mockCreate.mock.calls[0];
    expect(calledCompanyId).toBe(COMPANY_A);
    expect(calledActorId).toBeDefined();
    expect(calledMentions).toEqual(
      expect.arrayContaining([{ raw: "@Scout", name: "Scout" }]),
    );
  });

  it("passes an EMPTY opening-mentions list to svc.create when there is no @mention", async () => {
    mockCreate.mockResolvedValue({
      id: DISCUSSION_ID,
      companyId: COMPANY_A,
      title: "Just thinking out loud",
      entry: {
        id: FIRST_ENTRY_ID,
        discussionId: DISCUSSION_ID,
        rawContent: "no mentions here, just opening a thread",
        inputType: "write",
      },
    });

    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/discussions`)
      .send({
        title: "Just thinking out loud",
        entry: { inputType: "write", rawContent: "no mentions here, just opening a thread" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(processMentions as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const [, , , calledMentions] = mockCreate.mock.calls[0];
    expect(calledMentions).toEqual([]);
  });

  it("passes an EMPTY opening-mentions list to svc.create when created without a first entry", async () => {
    mockCreate.mockResolvedValue({
      id: DISCUSSION_ID,
      companyId: COMPANY_A,
      title: "Empty thread",
      entry: null,
    });

    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/discussions`)
      .send({ title: "Empty thread" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(processMentions as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const [, , , calledMentions] = mockCreate.mock.calls[0];
    expect(calledMentions).toEqual([]);
  });

  it("resolves mentions BEFORE create — a roster-query failure commits nothing (round-14 #2)", async () => {
    // Round-14 #2: resolveMentionTargets (a roster read) runs PRE-commit. If it
    // fails, svc.create must NOT have run — otherwise the discussion+entry are
    // durable, the request 500s, and a retry (no idempotency key) duplicates the
    // thread while the summon stays lost.
    (resolveMentionTargets as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("roster query DB down"),
    );

    const app = createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/discussions`)
      .send({
        title: "Need help",
        entry: { inputType: "write", rawContent: "@Scout dig into this" },
      });

    // Fails cleanly with NOTHING committed (create never ran) → safe client retry.
    expect(res.status).toBe(500);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
