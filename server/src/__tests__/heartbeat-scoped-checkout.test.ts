/**
 * Unit tests for the auto-checkout helpers introduced in Task 22 of the
 * upstream Paperclip resync (2026-04-26).
 *
 * isCheckoutConflictError is a pure predicate exported from heartbeat.ts.
 * It can be imported directly after mocking out DB/drizzle side-effects.
 */

import { vi } from "vitest";

// ── Mocks required because heartbeat.ts has top-level DB + drizzle imports ──

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop)),
      },
    );
  return {
    agents: makeTable(),
    agentRuntimeState: makeTable(),
    agentTaskSessions: makeTable(),
    agentWakeupRequests: makeTable(),
    heartbeatRunEvents: makeTable(),
    heartbeatRuns: makeTable(),
    costEvents: makeTable(),
    issues: makeTable(),
    projectWorkspaces: makeTable(),
    memoryItems: makeTable(),
    companies: makeTable(),
    taskDependencies: makeTable(),
    issueAttachments: makeTable(),
    issueComments: makeTable(),
    assets: makeTable(),
    projects: makeTable(),
    companySkills: makeTable(),
    // Required by services/embeddings.ts (B1: createEmbeddingService target map)
    discussions: makeTable(),
    discussionExtractedItems: makeTable(),
    embeddingQueue: makeTable(),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  asc: (..._args: unknown[]) => "asc",
  desc: (..._args: unknown[]) => "desc",
  eq: (..._args: unknown[]) => "eq",
  gt: (..._args: unknown[]) => "gt",
  inArray: (..._args: unknown[]) => "inArray",
  isNull: (..._args: unknown[]) => "isNull",
  or: (..._args: unknown[]) => "or",
  sql: new Proxy(
    Object.assign(() => ({ as: () => "sql" }), { raw: () => ({ as: () => "sql" }) }),
    {
      get: (_t: unknown, prop: string | symbol) =>
        prop === "apply" ? () => ({ as: () => "sql" }) : () => ({ as: () => "sql" }),
      apply: () => ({ as: () => "sql" }),
    },
  ),
}));

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/run-log-store.js", () => ({ getRunLogStore: vi.fn() }));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(),
  runningProcesses: new Map(),
}));
vi.mock("../agent-auth-jwt.js", () => ({ createLocalAgentJwt: vi.fn() }));
vi.mock("../adapters/utils.js", () => ({
  parseObject: vi.fn((v: unknown) => (v != null && typeof v === "object" ? v : {})),
  asBoolean: vi.fn(),
  asNumber: vi.fn(),
  appendWithCap: vi.fn(),
  MAX_EXCERPT_BYTES: 1024,
}));
vi.mock("../adapters/api-common.js", () => ({ setSecretResolver: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: vi.fn(() => ({})) }));
vi.mock("../services/output-detection.js", () => ({
  outputDetectionService: vi.fn(() => ({})),
}));
vi.mock("../services/run-summary.js", () => ({ formatRunSummary: vi.fn() }));
vi.mock("../services/issues.js", () => ({ issueService: vi.fn(() => ({})) }));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { isCheckoutConflictError } from "../services/heartbeat.js";
import { renderAoaWakePrompt } from "@armyofagents/adapter-utils/server-utils";

// ────────────────────────────────────────────────────────────────────────────

describe("isCheckoutConflictError", () => {
  it("returns true for HttpError with status 409 and exact 'Issue checkout conflict' message", () => {
    // Replicate what issueService.checkout throws: conflict("Issue checkout conflict", {...})
    // which is new HttpError(409, "Issue checkout conflict", details).
    const err = new HttpError(409, "Issue checkout conflict", { issueId: "iss_1" });
    expect(isCheckoutConflictError(err)).toBe(true);
  });

  it("returns false for a 409 HttpError with a different message", () => {
    const err = new HttpError(409, "Task has unmet dependencies");
    expect(isCheckoutConflictError(err)).toBe(false);
  });

  it("returns false for a non-409 HttpError", () => {
    const err = new HttpError(404, "Issue checkout conflict");
    expect(isCheckoutConflictError(err)).toBe(false);
  });

  it("returns false for a plain Error (not HttpError)", () => {
    expect(isCheckoutConflictError(new Error("Issue checkout conflict"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isCheckoutConflictError(null)).toBe(false);
  });

  it("returns false for a plain object with matching fields but not an HttpError instance", () => {
    expect(isCheckoutConflictError({ status: 409, message: "Issue checkout conflict" })).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isCheckoutConflictError(undefined)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────

describe("end-to-end: harness-checkout flag flows from context to wake prompt", () => {
  it("renders the harness-checkout advisory when context flag is set", () => {
    const prompt = renderAoaWakePrompt({
      reason: "issue_comment_received",
      issue: { id: "i1", identifier: "TASK-1", title: "x", status: "in_progress", priority: "med" },
      checkedOutByHarness: true,
      executionStage: null,
      commentIds: [],
      latestCommentId: null,
      comments: [],
      requestedCount: 0,
      includedCount: 0,
      missingCount: 0,
      truncated: false,
      fallbackFetchNeeded: false,
    });
    expect(prompt).toContain("already claimed by the harness");
  });

  it("omits harness advisory for checkedOutByHarness=false", () => {
    const prompt = renderAoaWakePrompt({
      reason: "issue_comment_received",
      issue: { id: "i1", identifier: "TASK-1", title: "x", status: "in_progress", priority: "med" },
      checkedOutByHarness: false,
      executionStage: null,
      commentIds: [],
      latestCommentId: null,
      comments: [],
      requestedCount: 0,
      includedCount: 0,
      missingCount: 0,
      truncated: false,
      fallbackFetchNeeded: false,
    });
    expect(prompt).not.toContain("already claimed by the harness");
  });
});
