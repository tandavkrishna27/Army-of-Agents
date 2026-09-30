import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB / drizzle stubs ────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
  lte: vi.fn((a: unknown, b: unknown) => ({ lte: [a, b] })),
  sql: new Proxy(() => ({ sql: true }), {
    get: () => () => ({ sql: true }),
    apply: () => ({ sql: true }),
  }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    feedbackVotes: makeTable("feedback_votes"),
  };
});

import { feedbackVotesService } from "../services/feedback-votes.js";

// ── Mock DB helpers ──────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createUpsertCaptureDb(opts: {
  returning?: MockRow[];
  selects?: MockRow[][];
} = {}) {
  const captured: {
    insertValues?: MockRow;
    conflictSet?: MockRow;
    deletedWhere?: unknown;
  } = {};
  let selectIdx = 0;

  function makeSelectChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "where", "orderBy", "limit", "offset"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeInsertChain() {
    const chain: Record<string, unknown> = {};
    chain.values = (v: MockRow) => {
      captured.insertValues = v;
      const inner: Record<string, unknown> = {};
      inner.onConflictDoUpdate = (cfg: { set?: MockRow }) => {
        captured.conflictSet = cfg.set;
        const tail: Record<string, unknown> = {};
        tail.returning = () => Promise.resolve(opts.returning ?? [{ ...v, id: "vote-id" }]);
        return tail;
      };
      // fallback for inserts without onConflict
      inner.returning = () => Promise.resolve(opts.returning ?? [{ ...v, id: "vote-id" }]);
      return inner;
    };
    return chain;
  }

  function makeDeleteChain() {
    const chain: Record<string, unknown> = {};
    chain.where = (w: unknown) => {
      captured.deletedWhere = w;
      return Promise.resolve();
    };
    return chain;
  }

  const db = {
    select: () => makeSelectChain(() => opts.selects?.[selectIdx++] ?? []),
    insert: () => makeInsertChain(),
    delete: () => makeDeleteChain(),
  };

  return { db, captured };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const issueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const targetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const authorUserId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherAuthorUserId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const voteId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const baseInput = {
  companyId,
  authorUserId,
  issueId,
  targetType: "issue_comment" as const,
  targetId,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("feedbackVotesService — recordVote", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts upvote with no reason (reason stripped per Paperclip normalizeReason)", async () => {
    const { db, captured } = createUpsertCaptureDb();
    const svc = feedbackVotesService(db as any);
    await svc.recordVote({ ...baseInput, vote: "up", reason: "looks great" });

    expect(captured.insertValues).toMatchObject({
      companyId,
      issueId,
      authorUserId,
      targetType: "issue_comment",
      targetId,
      vote: "up",
      reason: null,
      sharedWithLabs: false,
      sharedAt: null,
      consentVersion: null,
      redactionSummary: null,
    });
  });

  it("inserts downvote with trimmed reason", async () => {
    const { db, captured } = createUpsertCaptureDb();
    const svc = feedbackVotesService(db as any);
    await svc.recordVote({ ...baseInput, vote: "down", reason: "  not accurate  " });

    expect(captured.insertValues).toMatchObject({
      vote: "down",
      reason: "not accurate",
    });
  });

  it("normalizes empty-string reason on downvote to null", async () => {
    const { db, captured } = createUpsertCaptureDb();
    const svc = feedbackVotesService(db as any);
    await svc.recordVote({ ...baseInput, vote: "down", reason: "   " });

    expect(captured.insertValues?.reason).toBeNull();
  });

  it("missing reason on downvote → null (not undefined)", async () => {
    const { db, captured } = createUpsertCaptureDb();
    const svc = feedbackVotesService(db as any);
    await svc.recordVote({ ...baseInput, vote: "down" });

    expect(captured.insertValues?.reason).toBeNull();
  });

  it("passes updatedAt + insertedAt as Date so Drizzle timestamps round-trip", async () => {
    const { db, captured } = createUpsertCaptureDb();
    const svc = feedbackVotesService(db as any);
    await svc.recordVote({ ...baseInput, vote: "up" });

    expect(captured.insertValues?.updatedAt).toBeInstanceOf(Date);
  });

  it("configures onConflictDoUpdate set to update vote / reason / updatedAt", async () => {
    const { db, captured } = createUpsertCaptureDb();
    const svc = feedbackVotesService(db as any);
    await svc.recordVote({ ...baseInput, vote: "down", reason: "missed the mark" });

    expect(captured.conflictSet).toMatchObject({
      vote: "down",
      reason: "missed the mark",
    });
    expect(captured.conflictSet?.updatedAt).toBeInstanceOf(Date);
  });

  it("returns the upserted vote row", async () => {
    const { db } = createUpsertCaptureDb({
      returning: [
        {
          id: voteId,
          companyId,
          issueId,
          targetType: "issue_comment",
          targetId,
          authorUserId,
          vote: "up",
          reason: null,
          sharedWithLabs: false,
        },
      ],
    });
    const svc = feedbackVotesService(db as any);
    const result = await svc.recordVote({ ...baseInput, vote: "up" });
    expect(result.id).toBe(voteId);
    expect(result.vote).toBe("up");
  });
});

describe("feedbackVotesService — listVotes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns votes matching companyId filter", async () => {
    const rows = [
      { id: voteId, companyId, vote: "up", issueId, authorUserId, targetType: "issue_comment", targetId },
    ];
    const { db } = createUpsertCaptureDb({ selects: [rows] });
    const svc = feedbackVotesService(db as any);
    const result = await svc.listVotes({ companyId });
    expect(result).toEqual(rows);
  });

  it("accepts optional issueId / authorUserId / targetType / targetId / since filters", async () => {
    const { db } = createUpsertCaptureDb({ selects: [[]] });
    const svc = feedbackVotesService(db as any);
    const since = new Date("2026-04-01T00:00:00Z");
    await svc.listVotes({
      companyId,
      issueId,
      authorUserId,
      targetType: "issue_comment",
      targetId,
      since,
    });
    // No throw = filters all applied cleanly via mocked drizzle-orm operators.
    expect(true).toBe(true);
  });
});

describe("feedbackVotesService — dismissVote", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes vote when the caller is the original author", async () => {
    const { db, captured } = createUpsertCaptureDb({
      selects: [[{ id: voteId, authorUserId, companyId, issueId, vote: "up", targetType: "issue_comment", targetId }]],
    });
    const svc = feedbackVotesService(db as any);
    await svc.dismissVote(voteId, authorUserId);
    expect(captured.deletedWhere).toBeDefined();
  });

  it("throws forbidden when caller is not the vote's author", async () => {
    const { db } = createUpsertCaptureDb({
      selects: [[{ id: voteId, authorUserId, companyId }]],
    });
    const svc = feedbackVotesService(db as any);
    await expect(svc.dismissVote(voteId, otherAuthorUserId)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("throws notFound when vote does not exist", async () => {
    const { db } = createUpsertCaptureDb({ selects: [[]] });
    const svc = feedbackVotesService(db as any);
    await expect(svc.dismissVote(voteId, authorUserId)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("feedbackVotesService — preference-gated post-vote bundle hook (F.4)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fires onVoteShared when preference='allowed'", async () => {
    const { db } = createUpsertCaptureDb({
      returning: [{ id: voteId, companyId, issueId, authorUserId, vote: "up", targetType: "issue_comment", targetId }],
    });
    const getFeedbackSharingPreference = vi.fn().mockResolvedValue("allowed");
    const onVoteShared = vi.fn().mockResolvedValue(undefined);
    const svc = feedbackVotesService(db as any, { getFeedbackSharingPreference, onVoteShared });

    await svc.recordVote({ ...baseInput, vote: "up" });
    // Fire-and-forget: drain microtasks so the chained .then/.catch settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(getFeedbackSharingPreference).toHaveBeenCalledTimes(1);
    expect(onVoteShared).toHaveBeenCalledTimes(1);
    expect(onVoteShared).toHaveBeenCalledWith(voteId);
  });

  it("does NOT fire onVoteShared when preference='not_allowed'", async () => {
    const { db } = createUpsertCaptureDb({
      returning: [{ id: voteId, companyId, issueId, authorUserId, vote: "up", targetType: "issue_comment", targetId }],
    });
    const getFeedbackSharingPreference = vi.fn().mockResolvedValue("not_allowed");
    const onVoteShared = vi.fn();
    const svc = feedbackVotesService(db as any, { getFeedbackSharingPreference, onVoteShared });

    await svc.recordVote({ ...baseInput, vote: "up" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(getFeedbackSharingPreference).toHaveBeenCalledTimes(1);
    expect(onVoteShared).not.toHaveBeenCalled();
  });

  it("does NOT fire onVoteShared when preference='prompt' (frontend handles the transition)", async () => {
    const { db } = createUpsertCaptureDb({
      returning: [{ id: voteId, companyId, issueId, authorUserId, vote: "down", targetType: "issue_comment", targetId }],
    });
    const getFeedbackSharingPreference = vi.fn().mockResolvedValue("prompt");
    const onVoteShared = vi.fn();
    const svc = feedbackVotesService(db as any, { getFeedbackSharingPreference, onVoteShared });

    await svc.recordVote({ ...baseInput, vote: "down" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(onVoteShared).not.toHaveBeenCalled();
  });

  it("does nothing when deps are omitted (backward compat)", async () => {
    const { db } = createUpsertCaptureDb({
      returning: [{ id: voteId, companyId, issueId, authorUserId, vote: "up", targetType: "issue_comment", targetId }],
    });
    const svc = feedbackVotesService(db as any);

    // If the service tried to resolve a preference, db would error because no mock is wired.
    // The fact that this resolves cleanly means deps were properly optional.
    const result = await svc.recordVote({ ...baseInput, vote: "up" });
    expect(result.id).toBe(voteId);
  });

  it("does NOT block recordVote response on bundle build (fire-and-forget timing)", async () => {
    const { db } = createUpsertCaptureDb({
      returning: [{ id: voteId, companyId, issueId, authorUserId, vote: "up", targetType: "issue_comment", targetId }],
    });
    let resolveShare: (() => void) | null = null;
    const onVoteShared = vi.fn(
      () => new Promise<void>((r) => { resolveShare = () => r(); }),
    );
    const svc = feedbackVotesService(db as any, {
      getFeedbackSharingPreference: () => Promise.resolve("allowed"),
      onVoteShared,
    });

    // recordVote should resolve even though onVoteShared's promise is still pending.
    const result = await svc.recordVote({ ...baseInput, vote: "up" });
    expect(result.id).toBe(voteId);

    // Drain microtasks so the fire-and-forget chain enters onVoteShared.
    await new Promise((resolve) => setImmediate(resolve));
    expect(onVoteShared).toHaveBeenCalledTimes(1);

    // Cleanup.
    resolveShare?.();
  });

  it("swallows onVoteShared rejections via logger.warn (does not propagate)", async () => {
    const { db } = createUpsertCaptureDb({
      returning: [{ id: voteId, companyId, issueId, authorUserId, vote: "up", targetType: "issue_comment", targetId }],
    });
    const boom = new Error("bundle boom");
    const onVoteShared = vi.fn().mockRejectedValue(boom);
    const warn = vi.fn();
    const svc = feedbackVotesService(db as any, {
      getFeedbackSharingPreference: () => Promise.resolve("allowed"),
      onVoteShared,
      logger: { warn },
    });

    const result = await svc.recordVote({ ...baseInput, vote: "up" });
    expect(result.id).toBe(voteId);

    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalled();
    const call = warn.mock.calls[0];
    expect(String(call[0])).toMatch(/feedback bundle/i);
    expect(call[1]).toMatchObject({ voteId });
  });

  it("swallows preference-lookup failures via logger.warn", async () => {
    const { db } = createUpsertCaptureDb({
      returning: [{ id: voteId, companyId, issueId, authorUserId, vote: "up", targetType: "issue_comment", targetId }],
    });
    const onVoteShared = vi.fn();
    const warn = vi.fn();
    const svc = feedbackVotesService(db as any, {
      getFeedbackSharingPreference: () => Promise.reject(new Error("settings unavailable")),
      onVoteShared,
      logger: { warn },
    });

    const result = await svc.recordVote({ ...baseInput, vote: "up" });
    expect(result.id).toBe(voteId);

    await new Promise((resolve) => setImmediate(resolve));
    expect(onVoteShared).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe("feedbackVotesService — voteSummaryForTarget", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts ups and downs across votes for the same target", async () => {
    const rows = [{ vote: "up" }, { vote: "up" }, { vote: "down" }];
    const { db } = createUpsertCaptureDb({ selects: [rows] });
    const svc = feedbackVotesService(db as any);
    const summary = await svc.voteSummaryForTarget({
      companyId,
      targetType: "issue_comment",
      targetId,
    });
    expect(summary).toEqual({ ups: 2, downs: 1, total: 3 });
  });

  it("returns zeros for a target with no votes", async () => {
    const { db } = createUpsertCaptureDb({ selects: [[]] });
    const svc = feedbackVotesService(db as any);
    const summary = await svc.voteSummaryForTarget({
      companyId,
      targetType: "issue_comment",
      targetId,
    });
    expect(summary).toEqual({ ups: 0, downs: 0, total: 0 });
  });

  it("accepts optional issueId scoping filter", async () => {
    const { db } = createUpsertCaptureDb({ selects: [[{ vote: "up" }]] });
    const svc = feedbackVotesService(db as any);
    const summary = await svc.voteSummaryForTarget({
      companyId,
      issueId,
      targetType: "issue_comment",
      targetId,
    });
    expect(summary.ups).toBe(1);
  });
});
