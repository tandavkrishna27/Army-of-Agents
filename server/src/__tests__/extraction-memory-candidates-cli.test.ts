import { beforeEach, describe, expect, it, vi } from "vitest";

// extractMemoryCandidates (the shared engine behind the 4 crew memory-extract
// tools) is CLI-only in production: when no `llm` is injected it routes through
// extractViaCli (keyless), mapping the returned ExtractedItem[] to
// MemoryCandidate[]. The `llm` injection seam survives for tests/evals only.

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
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
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

// Provider-key helpers must NEVER be reached on the CLI-only path.
const mockResolveAvailableProvider = vi.fn(async () => {
  throw new Error("resolveAvailableProvider must not be called");
});
const mockGetProviderApiKey = vi.fn(async () => {
  throw new Error("getProviderApiKey must not be called");
});
vi.mock("../services/internal-agent/providers/index.js", () => ({
  getProviderApiKey: (...a: unknown[]) => mockGetProviderApiKey(...a),
  createProvider: vi.fn(),
  resolveAvailableProvider: (...a: unknown[]) => mockResolveAvailableProvider(...a),
}));

vi.mock("../services/extraction-engine.js", () => ({
  resolveExtractionEngine: vi.fn(async () => "cli"),
  resolveCompanyCliTool: vi.fn(async () => "claude_cli"),
}));

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
    extractViaCli: (...a: unknown[]) => mockExtractViaCli(...a),
    CliExtractionError: FakeCliExtractionError,
  };
});

import { extractMemoryCandidates } from "../services/extraction.js";

const COMPANY_ID = "co-1";
const THREAD_ID = "thread-1";

/**
 * Sequence-based mock DB. extractMemoryCandidates (no cursor) issues selects:
 *   1. discussions privacy gate (allowMemoryExtraction)
 *   2. entries window
 *   3. departments list
 *   4. internal_agent_config (model hint, via resolveCliExtractionContext)
 */
function createSequenceDb(selects: Record<string, unknown>[][]) {
  let idx = 0;
  function makeChain(): any {
    const chain: any = {};
    for (const m of ["from", "where", "orderBy", "limit"]) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown[]) => unknown) =>
      Promise.resolve(resolve(selects[idx++] ?? []));
    return chain;
  }
  return { select: () => makeChain() };
}

function dbForCliPath() {
  return createSequenceDb([
    [{ allowMemoryExtraction: true }], // privacy gate
    [{ id: "e1", rawContent: "Substantive content for the extractor.", createdAt: new Date() }],
    [], // departments
    [{ model: null }], // agent config (model hint)
  ]);
}

describe("extractMemoryCandidates — CLI-only production path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAvailableProvider.mockImplementation(async () => {
      throw new Error("resolveAvailableProvider must not be called");
    });
    mockGetProviderApiKey.mockImplementation(async () => {
      throw new Error("getProviderApiKey must not be called");
    });
  });

  it("with no llm uses extractViaCli and maps to MemoryCandidate[]", async () => {
    mockExtractViaCli.mockResolvedValue([{ type: "insight", title: "I", description: "d" }]);

    const { candidates } = await extractMemoryCandidates(dbForCliPath() as never, null, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });

    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("insight");
    expect(candidates[0].title).toBe("I");
    // No provider key was consulted.
    expect(mockResolveAvailableProvider).not.toHaveBeenCalled();
    expect(mockGetProviderApiKey).not.toHaveBeenCalled();
  });

  it("with an injected llm uses .generate (eval seam) and does NOT call the CLI", async () => {
    const llm = { generate: vi.fn().mockResolvedValue('[{"type":"insight","title":"I"}]') };

    const db = createSequenceDb([
      [{ allowMemoryExtraction: true }],
      [{ id: "e1", rawContent: "Substantive content for the extractor.", createdAt: new Date() }],
      [], // departments
    ]);

    const { candidates } = await extractMemoryCandidates(db as never, llm as never, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });

    expect(llm.generate).toHaveBeenCalledTimes(1);
    expect(mockExtractViaCli).not.toHaveBeenCalled();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe("I");
  });

  it("forwards the codex model option to extractViaCli on the no-llm path", async () => {
    mockExtractViaCli.mockResolvedValue([]);

    const db = createSequenceDb([
      [{ allowMemoryExtraction: true }],
      [{ id: "e1", rawContent: "Substantive content for the extractor.", createdAt: new Date() }],
      [],
      [{ model: "gpt-5.5" }],
    ]);

    await extractMemoryCandidates(db as never, null, {
      companyId: COMPANY_ID,
      threadId: THREAD_ID,
    });

    const opts = mockExtractViaCli.mock.calls[0][3];
    expect(opts).toBeDefined();
    expect(opts).toHaveProperty("codexModel");
  });
});
