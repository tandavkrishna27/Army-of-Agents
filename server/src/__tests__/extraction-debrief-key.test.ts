import { beforeEach, describe, expect, it, vi } from "vitest";

// extractFromDebrief (the MCP debrief-push extraction path) is now CLI-only —
// it routes through extractViaCli (keyless), NOT a hosted provider key. This
// test pins: the CLI extractor is used, items land in brief_items, and the
// provider-key helpers are never consulted.

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  debriefs: { id: "debrief_id", companyId: "debrief_company_id" },
  briefs: {},
  briefItems: {},
  internalAgentConfig: { companyId: "iac_cid", cliTool: "iac_cli" },
  projects: {
    id: "project_id",
    name: "project_name",
    type: "project_type",
    companyId: "project_company_id",
  },
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// Provider-key helpers must NEVER be reached on the CLI-only debrief path.
const getKeyMock = vi.fn(async () => {
  throw new Error("getProviderApiKey must not be called on the CLI-only path");
});
const resolveProviderMock = vi.fn(async () => {
  throw new Error("resolveAvailableProvider must not be called on the CLI-only path");
});
vi.mock("../services/internal-agent/providers/index.js", () => ({
  getProviderApiKey: (...a: unknown[]) => getKeyMock(...a),
  createProvider: vi.fn(),
  resolveAvailableProvider: (...a: unknown[]) => resolveProviderMock(...a),
}));

// CLI tool resolution — pin to claude_cli.
vi.mock("../services/extraction-engine.js", () => ({
  resolveExtractionEngine: vi.fn(async () => "cli"),
  resolveCompanyCliTool: vi.fn(async () => "claude_cli"),
}));

// One-shot CLI extractor — controlled per-test.
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

import { extractionService } from "../services/extraction.js";

function makeSelectChain(queue: unknown[][]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (rows: unknown[]) => unknown) =>
      Promise.resolve(fn(queue.shift() ?? [])),
    ),
  };
}

describe("extractFromDebrief — CLI-only (no provider key)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    getKeyMock.mockImplementation(async () => {
      throw new Error("getProviderApiKey must not be called on the CLI-only path");
    });
    resolveProviderMock.mockImplementation(async () => {
      throw new Error("resolveAvailableProvider must not be called on the CLI-only path");
    });
  });

  it("routes through extractViaCli (no callLLM / no provider key) and writes brief items", async () => {
    const capturedBriefItems: Record<string, unknown>[] = [];
    // Queue: 1) debrief fetch, 2) departments list, 3) agent config (model hint)
    const selectQueue: unknown[][] = [
      [
        {
          id: "debrief-1",
          companyId: "company-1",
          rawContent: "Decision: ship it. Task: do the thing.",
          departmentId: null,
          projectId: null,
          goalId: null,
        },
      ],
      [],
      [{ model: null }],
    ];
    const db = {
      select: vi.fn(() => makeSelectChain(selectQueue)),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: vi.fn(() => ({
            values: vi.fn((v: unknown) => {
              if (Array.isArray(v)) capturedBriefItems.push(...v);
              return { returning: vi.fn().mockResolvedValue([{ id: "brief-1" }]) };
            }),
          })),
          update: vi.fn(() => ({
            set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
          })),
        }),
      ),
    } as unknown as Parameters<typeof extractionService>[0];

    mockExtractViaCli.mockResolvedValueOnce([
      { type: "task", title: "Ship it", description: "x", department: null },
    ]);

    await extractionService(db).extractFromDebrief("company-1", "debrief-1");

    // The keyless CLI extractor ran; no provider key was consulted.
    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);
    expect(getKeyMock).not.toHaveBeenCalled();
    expect(resolveProviderMock).not.toHaveBeenCalled();

    // Items were written.
    expect(capturedBriefItems.length).toBeGreaterThan(0);
    expect(capturedBriefItems[0].title).toBe("Ship it");
  });

  it("forwards the company's codex model to extractViaCli", async () => {
    const selectQueue: unknown[][] = [
      [
        {
          id: "debrief-2",
          companyId: "company-2",
          rawContent: "Some substantive debrief content for extraction.",
          departmentId: null,
          projectId: null,
          goalId: null,
        },
      ],
      [],
      [{ model: "gpt-5.5" }],
    ];
    const db = {
      select: vi.fn(() => makeSelectChain(selectQueue)),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: "brief-2" }]),
            })),
          })),
          update: vi.fn(() => ({
            set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
          })),
        }),
      ),
    } as unknown as Parameters<typeof extractionService>[0];

    mockExtractViaCli.mockResolvedValueOnce([]);

    await extractionService(db).extractFromDebrief("company-2", "debrief-2");

    // The 4th arg is the options bag carrying codexModel (mirror the discussion
    // path). We don't assert the exact model — just that an options object is
    // forwarded (codexModel key present).
    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);
    const opts = mockExtractViaCli.mock.calls[0][3];
    expect(opts).toBeDefined();
    expect(opts).toHaveProperty("codexModel");
  });
});
