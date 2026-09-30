import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  debriefs: { id: "debrief_id", companyId: "debrief_company_id" },
  briefs: {},
  briefItems: {},
  projects: { id: "project_id", name: "project_name", type: "project_type", companyId: "project_company_id" },
  discussions: { id: "disc_id", companyId: "disc_company_id" },
  discussionEntries: {
    id: "entry_id",
    discussionId: "entry_disc_id",
    inputType: "entry_input_type",
    extractionStatus: "entry_extraction_status",
    rawContent: "entry_raw_content",
  },
  discussionExtractedItems: {},
  internalAgentConfig: {},
  internalAgentRuns: {},
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Extraction is CLI-only — pin the CLI tool resolution + stub the one-shot
// extractor so these unit tests stay deterministic and never spawn a real
// `claude`/`codex` binary.
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

function makeSelectChain(queue: any[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn(queue.shift() ?? []))),
  };
}

describe("extractionService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
  });

  it("stores suggested layer and selected layer on extracted brief items", async () => {
    const capturedBriefItems: any[] = [];
    // Queue: 1) debrief, 2) departments, 3) agent config (model hint)
    const selectQueue = [
      [
        {
          id: "debrief-1",
          companyId: "company-1",
          rawContent: "Founder preference: write in a direct tone",
          departmentId: null,
          projectId: null,
          goalId: "goal-1",
        },
      ],
      [],
      [{ model: null }],
    ];
    const db = {
      select: vi.fn(() => makeSelectChain(selectQueue)),
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
        fn({
          insert: vi.fn((table: any) => ({
            values: vi.fn((values: any) => {
              if (Array.isArray(values)) {
                capturedBriefItems.push(...values);
              }
              return {
                returning: vi.fn().mockResolvedValue([{ id: "brief-1" }]),
              };
            }),
          })),
          update: vi.fn(() => ({
            set: vi.fn(() => ({
              where: vi.fn().mockResolvedValue(undefined),
            })),
          })),
        })),
    } as any;

    // Keyless CLI extractor returns already-parsed items (deterministic).
    mockExtractViaCli.mockResolvedValueOnce([
      {
        type: "preference",
        title: "Write directly",
        description: "Use a direct, concise tone.",
        department: null,
        layer: "identity",
      },
    ]);

    await extractionService(db).extractFromDebrief("company-1", "debrief-1");

    expect(mockExtractViaCli).toHaveBeenCalledTimes(1);
    expect(capturedBriefItems[0]).toEqual(
      expect.objectContaining({
        type: "preference",
        suggestedLayer: "identity",
        layer: "identity",
      }),
    );
  });

  // ── P1-T7 (#3): extractFromDiscussionEntry must REFUSE scope_proposal ──────────
  // A scope_proposal entry carries structured proposal JSON in rawContent and
  // its approval lifecycle in proposalStatus. If the extractor ever claimed it,
  // it would flip extractionStatus (pending → processing → completed) and break
  // the Approve handler's idempotency read. The guard must short-circuit BEFORE
  // the atomic claim, so db.update is never called.
  it("skips a scope_proposal entry without claiming/updating it", async () => {
    const selectQueue = [
      // 1st select: the entry (a scope_proposal)
      [
        {
          id: "entry-sp",
          discussionId: "disc-1",
          inputType: "scope_proposal",
          extractionStatus: "pending",
          rawContent: JSON.stringify({ summary: "Plan", proposedTasks: [{ title: "T1" }] }),
        },
      ],
    ];
    const updateSpy = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const db = {
      select: vi.fn(() => makeSelectChain(selectQueue)),
      update: updateSpy,
      insert: vi.fn(),
      transaction: vi.fn(),
    } as any;

    await extractionService(db).extractFromDiscussionEntry("company-1", "entry-sp");

    // The guard returned before the atomic claim → no status mutation, no LLM call.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
