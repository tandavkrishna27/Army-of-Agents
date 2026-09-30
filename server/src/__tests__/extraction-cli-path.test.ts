import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Keyless CLI extraction path (Task 6) ───────────────────────────────────────
// Proves: with the engine forced to "cli" and NO hosted provider key, the
// keyless path runs — extractViaCli's items are written to
// discussion_extracted_items and the entry terminalizes `completed` (NOT
// `skipped`). The legacy hosted-key precheck is BYPASSED entirely.

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({ sql: strings, values })),
    { raw: vi.fn((input: any) => input) },
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
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const mockPublishLiveEvent = vi.fn();
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: (...args: unknown[]) => mockPublishLiveEvent(...args),
}));

// NO hosted key: resolveAvailableProvider must NEVER be reached on the cli path.
// If it is, this rejection would surface as a failure (entry skipped/failed).
const mockResolveAvailableProvider = vi.fn(async () => {
  throw new Error("resolveAvailableProvider must not be called on the cli path");
});
const mockCreateProvider = vi.fn();
const mockGetProviderApiKey = vi.fn(async () => {
  throw new Error("getProviderApiKey must not be called on the cli path");
});
vi.mock("../services/internal-agent/providers/index.js", () => ({
  getProviderApiKey: (...a: unknown[]) => mockGetProviderApiKey(...a),
  createProvider: (...a: unknown[]) => mockCreateProvider(...a),
  resolveAvailableProvider: (...a: unknown[]) => mockResolveAvailableProvider(...a),
}));

// Force the engine to "cli".
vi.mock("../services/extraction-engine.js", () => ({
  resolveExtractionEngine: vi.fn(async () => "cli"),
  resolveCompanyCliTool: vi.fn(async () => "claude_cli"),
}));

// Mock the one-shot CLI extractor. Default: one task item. Tests can override.
const mockExtractViaCli = vi.fn();
vi.mock("../services/extraction-cli.js", () => {
  // Defined inside the (hoisted) factory so there is no TDZ reference to an
  // outer class — vi.mock factories may not close over top-level bindings.
  class FakeCliExtractionError extends Error {
    readonly kind: string;
    constructor(message: string, kind: string) {
      super(message);
      this.name = "CliExtractionError";
      this.kind = kind;
    }
  }
  return {
    extractViaCli: (...a: unknown[]) => mockExtractViaCli(...a),
    CliExtractionError: FakeCliExtractionError,
  };
});

import { extractionService } from "../services/extraction.js";
import { CliExtractionError } from "../services/extraction-cli.js";

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
  const selectQueue: any[][] = [];
  const capturedInserts: Array<{ table: string; values: any }> = [];
  const capturedUpdates: Array<{ table: string; set: any }> = [];

  const db = {
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue.shift() ?? [])),
      ),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn((values: any) => {
        capturedInserts.push({ table: table?._?.name ?? "unknown", values });
        return {
          returning: vi.fn().mockReturnThis(),
          then: vi.fn((fn: (rows: any[]) => any) =>
            Promise.resolve(
              fn(Array.isArray(values) ? values.map((v: any, i: number) => ({ id: `gen-${i}`, ...v })) : [{ id: "run-1", ...values }]),
            ),
          ),
        };
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((setData: any) => {
        capturedUpdates.push({ table: table?._?.name ?? "unknown", set: setData });
        return {
          where: vi.fn().mockReturnThis(),
          catch: vi.fn().mockReturnThis(),
          returning: vi.fn(() =>
            Promise.resolve([{ id: "claimed", extractionStatus: "processing" }]),
          ),
          then: vi.fn((fn?: (rows: any[]) => any) =>
            Promise.resolve(fn ? fn([]) : undefined),
          ),
        };
      }),
    })),
    transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db)),
  };

  return { db, selectQueue, capturedInserts, capturedUpdates };
}

describe("extractFromDiscussionEntry — keyless CLI path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    mockResolveAvailableProvider.mockImplementation(async () => {
      throw new Error("resolveAvailableProvider must not be called on the cli path");
    });
  });

  it("writes extracted items + terminalizes 'completed' with NO hosted key", async () => {
    const { db, selectQueue, capturedInserts, capturedUpdates } = createMockDb();

    // Queue: 1) entry, 2) discussion, 3) agentConfig, 4) previous entries, 5) departments
    selectQueue.push(
      [createMockEntry()],
      [createMockDiscussion()],
      [{ id: "cfg-1", companyId: "company-1", cliTool: "claude_cli", model: null }],
      [],
      [],
    );

    mockExtractViaCli.mockResolvedValueOnce([
      { type: "task", title: "Build onboarding flow", description: "User onboarding", priority: "high" },
    ]);

    await extractionService(db as any).extractFromDiscussionEntry("company-1", "entry-1");

    // The keyless CLI extractor ran; the hosted resolver was NEVER consulted.
    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);
    expect(mockResolveAvailableProvider).not.toHaveBeenCalled();
    expect(mockCreateProvider).not.toHaveBeenCalled();

    // The item was written.
    const itemInserts = capturedInserts.filter((i) => i.table === "discussion_extracted_items");
    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0].values).toHaveLength(1);
    expect(itemInserts[0].values[0].title).toBe("Build onboarding flow");

    // The entry terminalized COMPLETED (not skipped).
    const entryUpdates = capturedUpdates.filter((u) => u.table === "discussion_entries");
    const completed = entryUpdates.find((u) => u.set.extractionStatus === "completed");
    const skipped = entryUpdates.find((u) => u.set.extractionStatus === "skipped");
    expect(completed).toBeDefined();
    expect(skipped).toBeUndefined();

    expect(mockPublishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "discussion.extraction.completed" }),
    );
  });

  it("terminalizes 'failed' (not 'skipped') on a CliExtractionError", async () => {
    const { db, selectQueue, capturedUpdates } = createMockDb();
    selectQueue.push(
      [createMockEntry()],
      [createMockDiscussion()],
      [{ id: "cfg-1", companyId: "company-1", cliTool: "claude_cli", model: null }],
      [],
      [],
    );

    mockExtractViaCli.mockRejectedValueOnce(
      new CliExtractionError("claude CLI is not authenticated", "not_authed"),
    );

    await extractionService(db as any).extractFromDiscussionEntry("company-1", "entry-1");

    const entryUpdates = capturedUpdates.filter((u) => u.table === "discussion_entries");
    const failed = entryUpdates.find((u) => u.set.extractionStatus === "failed");
    const skipped = entryUpdates.find((u) => u.set.extractionStatus === "skipped");
    const completed = entryUpdates.find((u) => u.set.extractionStatus === "completed");
    expect(failed).toBeDefined();
    expect(skipped).toBeUndefined();
    expect(completed).toBeUndefined();

    expect(mockPublishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "discussion.extraction.failed" }),
    );
  });

  it("does NOT fall back to a hosted provider when CLI is not_authed (CLI-only)", async () => {
    const { db, selectQueue, capturedInserts, capturedUpdates } = createMockDb();
    selectQueue.push(
      [createMockEntry()],
      [createMockDiscussion()],
      [{ id: "cfg-1", companyId: "company-1", cliTool: "claude_cli", model: null }],
      [],
      [],
    );

    // CLI is installed but logged out — there is NO hosted-API fallback anymore.
    mockExtractViaCli.mockRejectedValueOnce(
      new CliExtractionError("claude CLI is not authenticated", "not_authed"),
    );

    await extractionService(db as any).extractFromDiscussionEntry("company-1", "entry-1");

    // The provider resolver / hosted path must NEVER be consulted.
    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);
    expect(mockResolveAvailableProvider).not.toHaveBeenCalled();
    expect(mockCreateProvider).not.toHaveBeenCalled();

    // Entry terminalized failed (no API rescue).
    const entryUpdates = capturedUpdates.filter((u) => u.table === "discussion_entries");
    expect(entryUpdates.find((u) => u.set.extractionStatus === "failed")).toBeDefined();
    expect(entryUpdates.find((u) => u.set.extractionStatus === "completed")).toBeUndefined();

    // Nothing was written.
    const itemInserts = capturedInserts.filter((i) => i.table === "discussion_extracted_items");
    expect(itemInserts).toHaveLength(0);
  });
});
