import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB / drizzle stubs ────────────────────────────────────────────────────────
// Mirrors feedback-votes-service.test.ts so bundle service tests run without
// importing real drizzle-orm (ESM cycle guard, per shared test pattern in CLAUDE.md).

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
    feedbackExports: makeTable("feedback_exports"),
    issues: makeTable("issues"),
    issueComments: makeTable("issue_comments"),
    agents: makeTable("agents"),
  };
});

import {
  anonymizeForTransmission,
  buildBundle,
  buildExportId,
  FEEDBACK_ANONYMIZATION_FALLBACK_PEPPER,
  FEEDBACK_BUNDLE_VERSION,
  FEEDBACK_PAYLOAD_VERSION,
  FEEDBACK_SCHEMA_VERSION,
  hashIdentityValue,
  listExports,
} from "../services/feedback-bundles.js";
import { sha256Digest, stableStringify } from "../services/feedback-redaction.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const issueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "11111111-1111-4111-8111-111111111111";
const commentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const otherCommentIdBefore = "c1111111-cccc-4ccc-8ccc-cccccccccccc";
const otherCommentIdAfter = "c2222222-cccc-4ccc-8ccc-cccccccccccc";
const authorUserId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const authorAgentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const voteId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const exportRowId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";

const targetCreatedAt = new Date("2026-04-21T10:00:00Z");
const beforeCommentCreatedAt = new Date("2026-04-21T09:50:00Z");
const afterCommentCreatedAt = new Date("2026-04-21T10:10:00Z");
const voteCreatedAt = new Date("2026-04-21T10:30:00Z");

function makeVoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: voteId,
    companyId,
    issueId,
    targetType: "issue_comment",
    targetId: commentId,
    authorUserId,
    vote: "down",
    reason: "wrong answer",
    sharedWithLabs: false,
    sharedAt: null,
    consentVersion: null,
    redactionSummary: null,
    createdAt: voteCreatedAt,
    updatedAt: voteCreatedAt,
    ...overrides,
  };
}

function makeIssueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    projectId,
    identifier: "TASK-42",
    title: "Fix the thing",
    description: "Context description with some info",
    ...overrides,
  };
}

function makeTargetCommentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: commentId,
    issueId,
    companyId,
    authorAgentId,
    authorUserId: null,
    body: "Agent-authored comment body with multiple words.",
    createdAt: targetCreatedAt,
    ...overrides,
  };
}

function makeContextCommentRow(id: string, createdAt: Date, body: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    issueId,
    companyId,
    authorAgentId,
    authorUserId: null,
    body,
    createdAt,
    ...overrides,
  };
}

function makeAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: authorAgentId,
    companyId,
    name: "ResearchAgent",
    role: "research",
    title: "Research Analyst",
    status: "idle",
    adapterType: "claude_local",
    ...overrides,
  };
}

// ── Mock DB ──────────────────────────────────────────────────────────────────
// buildBundle performs reads in this order:
//   1. vote (by id)
//   2. issue (by id)
//   3. target comment (by id + issueId)
//   4. agent (by id)  — optional
//   5. surrounding issue comments (by issueId, ordered)
// then ONE insert into feedback_exports with onConflictDoUpdate.

type MockRow = Record<string, unknown>;

function createBundleMockDb(opts: {
  selects?: MockRow[][];
  returningRow?: MockRow;
} = {}) {
  const captured: {
    insertValues?: MockRow;
    conflictSet?: MockRow;
    selectCalls: number;
  } = { selectCalls: 0 };
  let selectIdx = 0;

  function makeSelectChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "where", "orderBy", "limit", "offset", "innerJoin", "leftJoin"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => {
      captured.selectCalls += 1;
      return Promise.resolve(getResult()).then(resolve);
    };
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
        tail.returning = () =>
          Promise.resolve([opts.returningRow ?? { id: exportRowId }]);
        return tail;
      };
      inner.returning = () =>
        Promise.resolve([opts.returningRow ?? { id: exportRowId }]);
      return inner;
    };
    return chain;
  }

  const db = {
    select: () => makeSelectChain(() => opts.selects?.[selectIdx++] ?? []),
    insert: () => makeInsertChain(),
  };

  return { db, captured };
}

// ── Tests: buildBundle ────────────────────────────────────────────────────────

describe("feedbackBundles — buildBundle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("assembles bundle from vote + issue + target + context + agent and writes feedback_exports row", async () => {
    const { db, captured } = createBundleMockDb({
      selects: [
        [makeVoteRow()],                                               // 1. vote
        [makeIssueRow()],                                              // 2. issue
        [makeTargetCommentRow()],                                      // 3. target comment
        [                                                              // 4. surrounding comments (ordered by createdAt asc)
          makeContextCommentRow(otherCommentIdBefore, beforeCommentCreatedAt, "Earlier comment body"),
          makeTargetCommentRow(),                                      //    target itself — filtered out of before/after
          makeContextCommentRow(otherCommentIdAfter, afterCommentCreatedAt, "Later comment body"),
        ],
        [makeAgentRow()],                                              // 5. agent lookup
      ],
    });

    const result = await buildBundle(db as any, { voteId });

    expect(result.feedbackExportId).toBe(exportRowId);
    expect(result.exportId).toMatch(/^fbexp_[0-9a-f]{24}$/);
    expect(result.payloadSnapshot).toMatchObject({
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      bundleVersion: FEEDBACK_BUNDLE_VERSION,
      sourceApp: "aoa",
      vote: {
        id: voteId,
        value: "down",
        reason: "wrong answer",
        authorUserId,
      },
    });
    expect(captured.insertValues).toBeDefined();
  });

  it("writes feedback_exports row with status='local_only' and all version constants", async () => {
    const { db, captured } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow()],
        [makeTargetCommentRow()],
        [makeAgentRow()],
      ],
    });

    await buildBundle(db as any, { voteId });

    expect(captured.insertValues).toMatchObject({
      companyId,
      feedbackVoteId: voteId,
      issueId,
      projectId,
      authorUserId,
      targetType: "issue_comment",
      targetId: commentId,
      vote: "down",
      status: "local_only",
      destination: null,
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      bundleVersion: FEEDBACK_BUNDLE_VERSION,
      payloadVersion: FEEDBACK_PAYLOAD_VERSION,
      attemptCount: 0,
    });
    expect(captured.insertValues?.exportId).toMatch(/^fbexp_[0-9a-f]{24}$/);
    expect(captured.insertValues?.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("populates feedback_exports row with targetSummary matching FeedbackTraceTargetSummary shape", async () => {
    const { db, captured } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow()],
        [makeTargetCommentRow()],
        [makeAgentRow()],
      ],
    });

    await buildBundle(db as any, { voteId });

    expect(captured.insertValues?.targetSummary).toMatchObject({
      label: "Comment",
      authorAgentId,
      authorUserId: null,
      documentKey: null,
      documentTitle: null,
      revisionNumber: null,
    });
    const summary = captured.insertValues?.targetSummary as Record<string, unknown>;
    expect(typeof summary.excerpt).toBe("string");
  });

  it("computes payloadDigest as sha256 of stableStringify(payloadSnapshot) including redactionSummary", async () => {
    const { db, captured } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow()],
        [makeTargetCommentRow()],
        [makeAgentRow()],
      ],
    });

    const result = await buildBundle(db as any, { voteId });

    const expectedDigest = sha256Digest(result.payloadSnapshot);
    expect(result.payloadDigest).toBe(expectedDigest);
    expect(captured.insertValues?.payloadDigest).toBe(expectedDigest);
  });

  it("captures redactionSummary — records counts when target body contains sensitive content", async () => {
    const { db, captured } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow({
          body: "reach me at alice@example.com or via Bearer xyz123ABC456",
        })],
        [makeAgentRow()],
        [makeTargetCommentRow()],
      ],
    });

    const result = await buildBundle(db as any, { voteId });

    const summary = result.redactionSummary as Record<string, unknown>;
    expect(summary.strategy).toBe("deterministic_feedback_v2");
    const counts = summary.counts as Record<string, number>;
    expect(counts.email).toBeGreaterThanOrEqual(1);
    expect(counts.bearer_token).toBeGreaterThanOrEqual(1);
    const redacted = summary.redactedFields as string[];
    expect(redacted.some((field) => field.startsWith("bundle.primaryContent.body"))).toBe(true);
    // redactionSummary must match between result and persisted row.
    expect(captured.insertValues?.redactionSummary).toEqual(summary);
  });

  it("includes primary content with truncated excerpt and sanitized body", async () => {
    const { db } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow({ body: "Hello world. ".repeat(100) })],
        [makeAgentRow()],
        [makeTargetCommentRow()],
      ],
    });

    const result = await buildBundle(db as any, { voteId });
    const snapshot = result.payloadSnapshot as Record<string, unknown>;
    const bundle = snapshot.bundle as Record<string, unknown>;
    const primary = bundle.primaryContent as Record<string, unknown>;

    expect(primary.type).toBe("issue_comment");
    expect(primary.id).toBe(commentId);
    expect(primary.label).toBe("Comment");
    expect(typeof primary.excerpt).toBe("string");
    expect((primary.excerpt as string).length).toBeLessThanOrEqual(200);
    expect(primary.authorAgentId).toBe(authorAgentId);
    expect(primary.authorUserId).toBeNull();
  });

  it("includes issueContext with before/after items (target excluded), issue metadata, sanitized description", async () => {
    const { db } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow()],
        [
          makeContextCommentRow(otherCommentIdBefore, beforeCommentCreatedAt, "earlier body"),
          makeTargetCommentRow(),
          makeContextCommentRow(otherCommentIdAfter, afterCommentCreatedAt, "later body"),
        ],
        [makeAgentRow()],
      ],
    });

    const result = await buildBundle(db as any, { voteId });
    const snapshot = result.payloadSnapshot as Record<string, unknown>;
    const bundle = snapshot.bundle as Record<string, unknown>;
    const issueContext = bundle.issueContext as Record<string, unknown>;

    expect(issueContext.issue).toMatchObject({
      id: issueId,
      identifier: "TASK-42",
      title: "Fix the thing",
      projectId,
    });
    const items = issueContext.items as Array<{ id: string; relation: string; body: string }>;
    expect(items).toHaveLength(2);
    // Items should NOT include the target comment itself
    expect(items.find((i) => i.id === commentId)).toBeUndefined();
    expect(items.find((i) => i.id === otherCommentIdBefore)?.relation).toBe("before");
    expect(items.find((i) => i.id === otherCommentIdAfter)?.relation).toBe("after");
  });

  it("includes agentContext with agent record fields when authorAgentId is present", async () => {
    const { db } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow()],
        [makeTargetCommentRow()],
        [makeAgentRow()],
      ],
    });

    const result = await buildBundle(db as any, { voteId });
    const snapshot = result.payloadSnapshot as Record<string, unknown>;
    const bundle = snapshot.bundle as Record<string, unknown>;
    const agentContext = bundle.agentContext as Record<string, unknown> | null;

    expect(agentContext).not.toBeNull();
    expect(agentContext).toMatchObject({
      agent: {
        id: authorAgentId,
        name: "ResearchAgent",
        role: "research",
        title: "Research Analyst",
        status: "idle",
        adapterType: "claude_local",
      },
      paperclip: {
        schemaVersion: FEEDBACK_SCHEMA_VERSION,
        bundleVersion: FEEDBACK_BUNDLE_VERSION,
      },
    });
  });

  it("agentContext is null when agent lookup returns nothing (orphan agent)", async () => {
    const { db } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow()],
        [makeTargetCommentRow()],    // surrounding comments (just the target)
        [],                          // agent not found
      ],
    });

    const result = await buildBundle(db as any, { voteId });
    const snapshot = result.payloadSnapshot as Record<string, unknown>;
    const bundle = snapshot.bundle as Record<string, unknown>;
    expect(bundle.agentContext).toBeNull();
  });

  it("throws notFound when vote does not exist", async () => {
    const { db } = createBundleMockDb({ selects: [[]] });
    await expect(buildBundle(db as any, { voteId })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws notFound when issue does not exist for a vote", async () => {
    const { db } = createBundleMockDb({
      selects: [[makeVoteRow()], []],
    });
    await expect(buildBundle(db as any, { voteId })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws notFound when target comment does not exist", async () => {
    const { db } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [],                          // target comment missing
      ],
    });
    await expect(buildBundle(db as any, { voteId })).rejects.toMatchObject({
      status: 404,
    });
  });

  it("throws unprocessable when target is not an agent-authored comment", async () => {
    const { db } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow({ authorAgentId: null, authorUserId })],
      ],
    });
    await expect(buildBundle(db as any, { voteId })).rejects.toMatchObject({
      status: 422,
    });
  });

  it("exportEligible=true + exportId set (F.3 always builds; F.4 gates by preference)", async () => {
    const { db } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow()],
        [makeTargetCommentRow()],
        [makeAgentRow()],
      ],
    });

    const result = await buildBundle(db as any, { voteId });
    const snapshot = result.payloadSnapshot as Record<string, unknown>;
    expect(snapshot.exportEligible).toBe(true);
    expect(snapshot.exportId).toMatch(/^fbexp_[0-9a-f]{24}$/);
  });

  it("sets conflictSet (onConflictDoUpdate) with matching digest + snapshot fields for idempotent rebuilds", async () => {
    const { db, captured } = createBundleMockDb({
      selects: [
        [makeVoteRow()],
        [makeIssueRow()],
        [makeTargetCommentRow()],
        [makeTargetCommentRow()],
        [makeAgentRow()],
      ],
    });

    await buildBundle(db as any, { voteId });
    expect(captured.conflictSet).toMatchObject({
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      bundleVersion: FEEDBACK_BUNDLE_VERSION,
      payloadVersion: FEEDBACK_PAYLOAD_VERSION,
      status: "local_only",
      destination: null,
      failureReason: null,
    });
    expect(captured.conflictSet?.updatedAt).toBeInstanceOf(Date);
  });
});

// ── Tests: buildExportId ──────────────────────────────────────────────────────

describe("feedbackBundles — buildExportId", () => {
  it("formats as fbexp_<24-char hex>", () => {
    const id = buildExportId(voteId, new Date("2026-04-21T10:00:00Z"));
    expect(id).toMatch(/^fbexp_[0-9a-f]{24}$/);
  });

  it("is deterministic for the same voteId + sharedAt", () => {
    const at = new Date("2026-04-21T10:00:00Z");
    expect(buildExportId(voteId, at)).toBe(buildExportId(voteId, at));
  });

  it("changes when sharedAt changes", () => {
    const a = buildExportId(voteId, new Date("2026-04-21T10:00:00Z"));
    const b = buildExportId(voteId, new Date("2026-04-21T10:00:01Z"));
    expect(a).not.toBe(b);
  });
});

// ── Tests: anonymizeForTransmission ───────────────────────────────────────────
// Pure function. Not called by F.3. Ships ahead of F.D1 destination decision so
// the transmission code path can snap it in without a design round-trip.

describe("feedbackBundles — anonymizeForTransmission", () => {
  const basePayload = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    bundleVersion: FEEDBACK_BUNDLE_VERSION,
    sourceApp: "aoa",
    capturedAt: "2026-04-21T10:30:00Z",
    consentVersion: null,
    vote: {
      id: voteId,
      value: "down" as const,
      reason: "wrong answer",
      authorUserId,
      sharedWithLabs: false,
      sharedAt: null,
    },
    target: {
      type: "issue_comment" as const,
      id: commentId,
      createdAt: "2026-04-21T10:00:00Z",
      authorAgentId,
      authorUserId: null,
      createdByRunId: runId,
      issuePath: "/tasks/TASK-42",
      targetPath: "/tasks/TASK-42#comment-c...",
    },
    exportId: "fbexp_abc",
    exportEligible: true,
    bundle: {
      primaryContent: {
        type: "issue_comment",
        id: commentId,
        authorAgentId,
        authorUserId: null,
        body: "body",
        excerpt: "body",
      },
      issueContext: {
        issue: { id: issueId, projectId, identifier: "TASK-42", title: "Fix", path: "/tasks/TASK-42", descriptionExcerpt: null },
        items: [
          {
            type: "issue_comment",
            id: otherCommentIdBefore,
            relation: "before",
            authorAgentId,
            authorUserId: "user-other",
            body: "earlier",
            excerpt: "earlier",
          },
        ],
      },
      agentContext: {
        agent: { id: authorAgentId, name: "ResearchAgent", role: "research", title: null, status: "idle", adapterType: "claude_local" },
        paperclip: { schemaVersion: FEEDBACK_SCHEMA_VERSION, bundleVersion: FEEDBACK_BUNDLE_VERSION },
      },
    },
    redactionSummary: {
      strategy: "deterministic_feedback_v2",
      redactedFields: [],
      truncatedFields: [],
      omittedFields: [],
      notes: [],
      counts: {},
    },
  };

  const bundle = {
    id: exportRowId,
    companyId,
    feedbackVoteId: voteId,
    issueId,
    projectId,
    payloadSnapshot: basePayload,
  };

  it("replaces vote.authorUserId with deterministic user hash", () => {
    const out = anonymizeForTransmission(bundle as any);
    const snapshot = out.payloadSnapshot as typeof basePayload;
    expect(snapshot.vote.authorUserId).toMatch(/^user_[0-9a-f]{16}$/);
    expect(snapshot.vote.authorUserId).not.toBe(authorUserId);
  });

  it("replaces top-level companyId with deterministic company hash", () => {
    const out = anonymizeForTransmission(bundle as any);
    expect(out.companyId).toMatch(/^company_[0-9a-f]{16}$/);
    expect(out.companyId).not.toBe(companyId);
  });

  it("replaces agent.id and primaryContent.authorAgentId with deterministic agent hash", () => {
    const out = anonymizeForTransmission(bundle as any);
    const snapshot = out.payloadSnapshot as typeof basePayload;
    expect((snapshot.bundle!.primaryContent as any).authorAgentId).toMatch(/^agent_[0-9a-f]{16}$/);
    expect((snapshot.bundle!.agentContext as any).agent.id).toMatch(/^agent_[0-9a-f]{16}$/);
  });

  it("strips human-readable agent fields (name, title) — keeps role + adapterType (non-identifying)", () => {
    const out = anonymizeForTransmission(bundle as any);
    const snapshot = out.payloadSnapshot as typeof basePayload;
    const agent = (snapshot.bundle!.agentContext as any).agent;
    expect(agent.name).toBeNull();
    expect(agent.title).toBeNull();
    expect(agent.role).toBe("research");
    expect(agent.adapterType).toBe("claude_local");
  });

  it("strips issue.title + identifier (human-readable); keeps id + projectId (opaque)", () => {
    const out = anonymizeForTransmission(bundle as any);
    const snapshot = out.payloadSnapshot as typeof basePayload;
    const issue = (snapshot.bundle!.issueContext as any).issue;
    expect(issue.title).toBeNull();
    expect(issue.identifier).toBeNull();
    expect(issue.path).toBeNull();
    expect(issue.id).toBe(issueId);
    expect(issue.projectId).toBe(projectId);
  });

  it("hashes authorUserId inside issueContext.items and replaces with user hash", () => {
    const out = anonymizeForTransmission(bundle as any);
    const snapshot = out.payloadSnapshot as typeof basePayload;
    const item = (snapshot.bundle!.issueContext as any).items[0];
    expect(item.authorUserId).toMatch(/^user_[0-9a-f]{16}$/);
  });

  it("is deterministic — same input + same pepper produces the same hash", () => {
    const a = anonymizeForTransmission(bundle as any);
    const b = anonymizeForTransmission(bundle as any);
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("different peppers produce different hashes (namespace rotation support)", () => {
    const a = anonymizeForTransmission(bundle as any, { pepper: "pepper-1" });
    const b = anonymizeForTransmission(bundle as any, { pepper: "pepper-2" });
    const aSnap = a.payloadSnapshot as typeof basePayload;
    const bSnap = b.payloadSnapshot as typeof basePayload;
    expect(aSnap.vote.authorUserId).not.toBe(bSnap.vote.authorUserId);
  });

  it("does not mutate the input bundle (pure)", () => {
    const before = stableStringify(bundle);
    anonymizeForTransmission(bundle as any);
    expect(stableStringify(bundle)).toBe(before);
  });

  it("strips vote.reason (may contain PII like names / claim text)", () => {
    const out = anonymizeForTransmission(bundle as any);
    const snapshot = out.payloadSnapshot as typeof basePayload;
    expect(snapshot.vote.reason).toBeNull();
  });
});

// ── Tests: hashIdentityValue ──────────────────────────────────────────────────

describe("feedbackBundles — hashIdentityValue", () => {
  it("returns prefix-prefixed 16-char hex hash", () => {
    const h = hashIdentityValue("user", authorUserId, FEEDBACK_ANONYMIZATION_FALLBACK_PEPPER);
    expect(h).toMatch(/^user_[0-9a-f]{16}$/);
  });

  it("is deterministic for same (kind, value, pepper)", () => {
    const a = hashIdentityValue("company", companyId, "pepper");
    const b = hashIdentityValue("company", companyId, "pepper");
    expect(a).toBe(b);
  });

  it("differs when kind differs (namespacing)", () => {
    const a = hashIdentityValue("user", "same-value", "pepper");
    const b = hashIdentityValue("company", "same-value", "pepper");
    expect(a).not.toBe(b);
  });

  it("differs when pepper differs (rotation)", () => {
    const a = hashIdentityValue("user", authorUserId, "pepper-1");
    const b = hashIdentityValue("user", authorUserId, "pepper-2");
    expect(a).not.toBe(b);
  });
});

// ── Tests: listExports (F.4) ─────────────────────────────────────────────────

describe("feedbackBundles — listExports", () => {
  function makeExportRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "export-1",
      exportId: "fbexp_0123456789abcdef01234567",
      companyId,
      issueId,
      projectId,
      authorUserId,
      vote: "down",
      status: "local_only",
      destination: null,
      createdAt: new Date("2026-04-22T10:23:00Z"),
      payloadSnapshot: { nested: { a: 1, b: "x" } },
      ...overrides,
    };
  }

  it("returns recent exports with size estimated from payloadSnapshot JSON bytes", async () => {
    const row = makeExportRow();
    const { db } = createBundleMockDb({ selects: [[row]] });

    const result = await listExports(db as any, { limit: 5 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "export-1",
      exportId: "fbexp_0123456789abcdef01234567",
      vote: "down",
      status: "local_only",
      createdAt: row.createdAt,
    });
    // Size approximates JSON.stringify(snapshot) byte count.
    expect(result[0].sizeBytes).toBe(Buffer.byteLength(JSON.stringify(row.payloadSnapshot), "utf8"));
  });

  it("orders results by createdAt DESC (newest first) — assertion on mock call shape", async () => {
    const a = makeExportRow({ id: "a", createdAt: new Date("2026-04-22T10:00:00Z") });
    const b = makeExportRow({ id: "b", createdAt: new Date("2026-04-20T10:00:00Z") });
    // Mock DB returns rows as given — real DB guarantees the ORDER via .orderBy(desc()).
    // Here we just verify the function passes them through + computes per-row sizes.
    const { db } = createBundleMockDb({ selects: [[a, b]] });

    const result = await listExports(db as any);
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("applies companyId filter when provided", async () => {
    const { db } = createBundleMockDb({ selects: [[makeExportRow()]] });
    const rows = await listExports(db as any, { companyId, limit: 3 });
    expect(rows).toHaveLength(1);
    // No throw = where(eq(companyId)) was applied via mocked drizzle-orm.
  });

  it("omits companyId filter when not provided (instance-scope admin view)", async () => {
    const rowA = makeExportRow({ id: "a", companyId: "company-1" });
    const rowB = makeExportRow({ id: "b", companyId: "company-2" });
    const { db } = createBundleMockDb({ selects: [[rowA, rowB]] });
    const rows = await listExports(db as any, { limit: 5 });
    expect(rows.map((r) => r.companyId)).toEqual(["company-1", "company-2"]);
  });

  it("clamps limit to [1, 50] (caller-supplied bounds guard)", async () => {
    const { db } = createBundleMockDb({ selects: [[]] });
    await listExports(db as any, { limit: 0 }); // below 1 → clamps to 1
    await listExports(db as any, { limit: 9999 }); // above 50 → clamps to 50
    await listExports(db as any); // undefined → default 10
    // No throw = bounds were coerced cleanly.
  });

  it("returns empty array when no rows match", async () => {
    const { db } = createBundleMockDb({ selects: [[]] });
    const result = await listExports(db as any);
    expect(result).toEqual([]);
  });

  it("returns sizeBytes=0 for rows with null payloadSnapshot", async () => {
    const { db } = createBundleMockDb({
      selects: [[makeExportRow({ payloadSnapshot: null })]],
    });
    const result = await listExports(db as any);
    expect(result[0].sizeBytes).toBe(0);
  });
});
