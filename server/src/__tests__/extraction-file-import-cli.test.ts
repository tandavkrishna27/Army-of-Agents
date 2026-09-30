import { beforeEach, describe, expect, it, vi } from "vitest";

// extractFromRawText (the file-import extraction path) is now CLI-only — it
// routes through extractViaCli (keyless) and returns [] gracefully on CLI
// failure so file-import.ts can fall back to paragraph chunking. No provider
// key is ever consulted.

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  debriefs: {},
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
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    warn: vi.fn(),
  },
}));

const resolveProviderMock = vi.fn(async () => {
  throw new Error("resolveAvailableProvider must not be called on the CLI-only path");
});
const getKeyMock = vi.fn(async () => {
  throw new Error("getProviderApiKey must not be called on the CLI-only path");
});
vi.mock("../services/internal-agent/providers/index.js", () => ({
  getProviderApiKey: (...a: unknown[]) => getKeyMock(...a),
  createProvider: vi.fn(),
  resolveAvailableProvider: (...a: unknown[]) => resolveProviderMock(...a),
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

import { extractionService } from "../services/extraction.js";
import { CliExtractionError } from "../services/extraction-cli.js";

function makeSelectChain(queue: unknown[][]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (rows: unknown[]) => unknown) =>
      Promise.resolve(fn(queue.shift() ?? [])),
    ),
  };
}

function makeDb() {
  // extractFromRawText only issues selects (departments list + cli-tool config).
  // Feed empty rows for everything.
  const select = vi.fn(() => makeSelectChain([[], [], []]));
  return { select } as unknown as Parameters<typeof extractionService>[0];
}

const COMPANY_ID = "co-fi-1";

describe("extractFromRawText — CLI-only (file import)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    resolveProviderMock.mockImplementation(async () => {
      throw new Error("resolveAvailableProvider must not be called on the CLI-only path");
    });
    getKeyMock.mockImplementation(async () => {
      throw new Error("getProviderApiKey must not be called on the CLI-only path");
    });
  });

  it("routes through extractViaCli (no callLLM) and returns the items", async () => {
    mockExtractViaCli.mockResolvedValueOnce([{ type: "task", title: "T", description: "d" }]);

    const items = await extractionService(makeDb()).extractFromRawText(
      COMPANY_ID,
      "raw text that is long enough to extract from",
    );

    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);
    expect(getKeyMock).not.toHaveBeenCalled();
    expect(resolveProviderMock).not.toHaveBeenCalled();
    expect(items[0].type).toBe("task");
  });

  it("returns [] on CLI failure (file-import then chunks)", async () => {
    mockExtractViaCli.mockRejectedValueOnce(
      new CliExtractionError("claude CLI not found", "not_installed"),
    );

    const items = await extractionService(makeDb()).extractFromRawText(
      COMPANY_ID,
      "raw text that is long enough to extract from",
    );

    expect(items).toEqual([]);
  });

  it("forwards a codexModel option to extractViaCli", async () => {
    mockExtractViaCli.mockResolvedValueOnce([]);

    await extractionService(makeDb()).extractFromRawText(
      COMPANY_ID,
      "raw text that is long enough to extract from",
    );

    const opts = mockExtractViaCli.mock.calls[0][3];
    expect(opts).toBeDefined();
    expect(opts).toHaveProperty("codexModel");
  });
});
