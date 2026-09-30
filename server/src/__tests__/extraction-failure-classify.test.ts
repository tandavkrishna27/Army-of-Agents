/**
 * Tests for the CLI extraction retry + failure classification logic in
 * `extractFromDiscussionEntry` (server/src/services/extraction.ts).
 *
 * Sub-tests:
 *   1. `timeout` CliExtractionError — extractViaCli is retried 3 times total,
 *      then the entry is set to `failed`.
 *   2. `not_installed` CliExtractionError — extractViaCli is called exactly once
 *      (no retry for structural failures), entry is set to `failed` immediately.
 *
 * Mocking strategy follows extraction-cli-path.test.ts:
 *   - drizzle-orm + @armyofagents/db mocked with Proxy stubs.
 *   - extraction-engine.js forced to cli + claude_cli.
 *   - extraction-cli.js's extractViaCli controlled per-test.
 *   - Sequence-based mock DB for the select chain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module-level mocks (must precede imports) ─────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: vi.fn((input: unknown) => input) },
  ),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    });
  return {
    discussions: makeTable("discussions"),
    discussionEntries: makeTable("discussion_entries"),
    discussionExtractedItems: makeTable("discussion_extracted_items"),
    internalAgentConfig: makeTable("internal_agent_config"),
    internalAgentRuns: makeTable("internal_agent_runs"),
    projects: makeTable("projects"),
    debriefs: makeTable("debriefs"),
    briefs: makeTable("briefs"),
    briefItems: makeTable("brief_items"),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const mockPublishLiveEvent = vi.fn();
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: (...args: unknown[]) => mockPublishLiveEvent(...args),
}));

// Provider resolver must NEVER be called on the cli path.
const mockResolveAvailableProvider = vi.fn(async () => {
  throw new Error("resolveAvailableProvider must not be called on the cli path");
});
const mockGetProviderApiKey = vi.fn(async () => {
  throw new Error("getProviderApiKey must not be called on the cli path");
});
vi.mock("../services/internal-agent/providers/index.js", () => ({
  resolveAvailableProvider: (...a: unknown[]) => mockResolveAvailableProvider(...a),
  createProvider: vi.fn(),
  getProviderApiKey: (...a: unknown[]) => mockGetProviderApiKey(...a),
}));

// Pin the engine to "cli" (overridable per-test via mockResolveExtractionEngine).
const mockResolveExtractionEngine = vi.fn(async () => "cli");
vi.mock("../services/extraction-engine.js", () => ({
  resolveExtractionEngine: (...a: unknown[]) => mockResolveExtractionEngine(...a),
  resolveCompanyCliTool: vi.fn(async () => "claude_cli"),
}));

// extractViaCli is controlled per-test.
const mockExtractViaCli = vi.fn();
vi.mock("../services/extraction-cli.js", () => {
  class FakeCliExtractionError extends Error {
    readonly kind: string;
    constructor(message: string, kind: string) {
      super(message);
      this.name = "CliExtractionError";
      this.kind = kind;
    }
  }
  return {
    extractViaCli: (...args: unknown[]) => mockExtractViaCli(...args),
    CliExtractionError: FakeCliExtractionError,
  };
});

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { extractionService } from "../services/extraction.js";
import { CliExtractionError } from "../services/extraction-cli.js";

// ── Mock DB factory ──────────────────────────────────────────────────────────

function createMockEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    discussionId: "disc-1",
    rawContent: "We need to build a user onboarding flow this sprint.",
    inputType: "paste",
    extractionStatus: "pending",
    extractionRunId: null,
    ...overrides,
  };
}

function createMockDiscussion() {
  return { id: "disc-1", companyId: "company-1", title: "Planning" };
}

function createMockDb() {
  const selectQueue: unknown[][] = [];
  const capturedUpdates: Array<{ table: string; set: Record<string, unknown> }> = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: unknown[]) => unknown) =>
        Promise.resolve(fn(selectQueue.shift() ?? [])),
      ),
    })),
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((values: unknown) => ({
        returning: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: unknown[]) => unknown) =>
          Promise.resolve(
            fn(
              Array.isArray(values)
                ? values.map((v: Record<string, unknown>, i: number) => ({ id: `gen-${i}`, ...v }))
                : [{ id: "run-1", ...(values as Record<string, unknown>) }],
            ),
          ),
        ),
      })),
    })),
    update: vi.fn((table: { _: { name: string } }) => ({
      set: vi.fn((setData: Record<string, unknown>) => {
        capturedUpdates.push({ table: table?._?.name ?? "unknown", set: setData });
        return {
          where: vi.fn().mockReturnThis(),
          catch: vi.fn().mockReturnThis(),
          returning: vi.fn(() =>
            Promise.resolve([{ id: "claimed", extractionStatus: "processing" }]),
          ),
          then: vi.fn((fn?: (rows: unknown[]) => unknown) =>
            Promise.resolve(fn ? fn([]) : undefined),
          ),
        };
      }),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };

  return { db, selectQueue, capturedUpdates };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("extractFromDiscussionEntry — CLI failure classification + retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // clearAllMocks wipes implementations — re-establish the engine default + the
    // provider-resolver guards (must throw if ever reached on the cli path).
    mockResolveExtractionEngine.mockImplementation(async () => "cli");
    mockResolveAvailableProvider.mockImplementation(async () => {
      throw new Error("resolveAvailableProvider must not be called on the cli path");
    });
    mockGetProviderApiKey.mockImplementation(async () => {
      throw new Error("getProviderApiKey must not be called on the cli path");
    });
    // Re-use fake timer replacement so we don't actually wait 500ms per retry.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries up to 3 times on timeout, then terminalizes failed", async () => {
    const { db, selectQueue, capturedUpdates } = createMockDb();

    // Queue: 1) entry, 2) discussion, 3) agentConfig, 4) previous entries, 5) departments
    selectQueue.push(
      [createMockEntry()],
      [createMockDiscussion()],
      [{ id: "cfg-1", companyId: "company-1", cliTool: "claude_cli", model: null }],
      [],
      [],
    );

    // All 3 attempts fail with timeout.
    mockExtractViaCli
      .mockRejectedValueOnce(new CliExtractionError("CLI timed out (attempt 1)", "timeout"))
      .mockRejectedValueOnce(new CliExtractionError("CLI timed out (attempt 2)", "timeout"))
      .mockRejectedValueOnce(new CliExtractionError("CLI timed out (attempt 3)", "timeout"));

    // Run extraction concurrently; advance fake timers to drain setTimeout delays.
    const extractionPromise = extractionService(db as never).extractFromDiscussionEntry(
      "company-1",
      "entry-1",
    );

    // Drain two 500ms retry delays (between attempt 1→2 and 2→3).
    await vi.advanceTimersByTimeAsync(1100);

    await extractionPromise;

    // extractViaCli must have been called exactly 3 times.
    expect(mockExtractViaCli).toHaveBeenCalledTimes(3);

    // Entry must be terminalized as failed (not skipped, not completed).
    const entryUpdates = capturedUpdates.filter((u) => u.table === "discussion_entries");
    const failedUpdate = entryUpdates.find((u) => u.set.extractionStatus === "failed");
    const skippedUpdate = entryUpdates.find((u) => u.set.extractionStatus === "skipped");
    const completedUpdate = entryUpdates.find((u) => u.set.extractionStatus === "completed");

    expect(failedUpdate).toBeDefined();
    expect(skippedUpdate).toBeUndefined();
    expect(completedUpdate).toBeUndefined();

    // The failure live event must fire.
    expect(mockPublishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "discussion.extraction.failed" }),
    );
  });

  it("does NOT retry on not_installed — calls extractViaCli once and fails", async () => {
    const { db, selectQueue, capturedUpdates } = createMockDb();

    selectQueue.push(
      [createMockEntry()],
      [createMockDiscussion()],
      [{ id: "cfg-1", companyId: "company-1", cliTool: "claude_cli", model: null }],
      [],
      [],
    );

    mockExtractViaCli.mockRejectedValueOnce(
      new CliExtractionError("claude CLI not found on PATH.", "not_installed"),
    );

    await extractionService(db as never).extractFromDiscussionEntry("company-1", "entry-1");

    // Only one call — no retry for structural errors.
    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);

    const entryUpdates = capturedUpdates.filter((u) => u.table === "discussion_entries");
    const failedUpdate = entryUpdates.find((u) => u.set.extractionStatus === "failed");
    expect(failedUpdate).toBeDefined();

    expect(mockPublishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "discussion.extraction.failed" }),
    );
  });

  it("does NOT retry on not_authed — calls extractViaCli once and fails", async () => {
    const { db, selectQueue, capturedUpdates } = createMockDb();

    selectQueue.push(
      [createMockEntry()],
      [createMockDiscussion()],
      [{ id: "cfg-1", companyId: "company-1", cliTool: "claude_cli", model: null }],
      [],
      [],
    );

    mockExtractViaCli.mockRejectedValueOnce(
      new CliExtractionError("claude CLI is not authenticated.", "not_authed"),
    );

    await extractionService(db as never).extractFromDiscussionEntry("company-1", "entry-1");

    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);

    const failed = capturedUpdates
      .filter((u) => u.table === "discussion_entries")
      .find((u) => u.set.extractionStatus === "failed");
    expect(failed).toBeDefined();
  });

  it("succeeds on first attempt — no retries needed", async () => {
    const { db, selectQueue, capturedUpdates } = createMockDb();

    selectQueue.push(
      [createMockEntry()],
      [createMockDiscussion()],
      [{ id: "cfg-1", companyId: "company-1", cliTool: "claude_cli", model: null }],
      [],
      [],
    );

    mockExtractViaCli.mockResolvedValueOnce([
      { type: "task", title: "Onboarding flow", description: null, priority: null },
    ]);

    await extractionService(db as never).extractFromDiscussionEntry("company-1", "entry-1");

    // Only one call — no retry on success.
    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);

    const completed = capturedUpdates
      .filter((u) => u.table === "discussion_entries")
      .find((u) => u.set.extractionStatus === "completed");
    expect(completed).toBeDefined();

    expect(mockPublishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "discussion.extraction.completed" }),
    );
  });

  it("succeeds on second attempt after one timeout", async () => {
    const { db, selectQueue, capturedUpdates } = createMockDb();

    selectQueue.push(
      [createMockEntry()],
      [createMockDiscussion()],
      [{ id: "cfg-1", companyId: "company-1", cliTool: "claude_cli", model: null }],
      [],
      [],
    );

    mockExtractViaCli
      .mockRejectedValueOnce(new CliExtractionError("timed out", "timeout"))
      .mockResolvedValueOnce([
        { type: "task", title: "Retry succeeded", description: null, priority: null },
      ]);

    const extractionPromise = extractionService(db as never).extractFromDiscussionEntry(
      "company-1",
      "entry-1",
    );

    // Advance past the first retry delay.
    await vi.advanceTimersByTimeAsync(600);

    await extractionPromise;

    // Called twice: once on timeout, once on success.
    expect(mockExtractViaCli).toHaveBeenCalledTimes(2);

    const completed = capturedUpdates
      .filter((u) => u.table === "discussion_entries")
      .find((u) => u.set.extractionStatus === "completed");
    expect(completed).toBeDefined();

    // No failure event fired.
    expect(mockPublishLiveEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "discussion.extraction.failed" }),
    );
  });

  it("no CLI + no key → entry skipped with CLI-install message, no key lookup", async () => {
    const { db, selectQueue, capturedUpdates } = createMockDb();

    // Only the entry fetch + atomic claim happen before the engine resolves.
    selectQueue.push([createMockEntry()], [createMockDiscussion()]);

    // The engine router throws (no supported CLI; hosted keys are NOT a fallback).
    mockResolveExtractionEngine.mockRejectedValueOnce(
      new Error(
        "No extraction engine available. Install a CLI (e.g. the Claude Code CLI) and run its login flow (`claude auth login`).",
      ),
    );

    await extractionService(db as never).extractFromDiscussionEntry("company-1", "entry-1");

    // The CLI extractor was never reached, and NO provider key was consulted.
    expect(mockExtractViaCli).not.toHaveBeenCalled();
    expect(mockResolveAvailableProvider).not.toHaveBeenCalled();
    expect(mockGetProviderApiKey).not.toHaveBeenCalled();

    // Entry terminalized skipped with a CLI-install message (no key wording).
    const entryUpdates = capturedUpdates.filter((u) => u.table === "discussion_entries");
    const skipped = entryUpdates.find((u) => u.set.extractionStatus === "skipped");
    expect(skipped).toBeDefined();
    const payload = JSON.stringify(skipped!.set);
    expect(payload).toMatch(/install a cli|claude/i);
    expect(payload).not.toMatch(/api key|provider key|Settings . LLM Providers/i);
  });
});
