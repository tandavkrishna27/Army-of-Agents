// Contract test for the atomic pending->processing claim in
// extractFromDiscussionEntry. Proves: a caller that loses the claim
// (UPDATE ... WHERE status='pending' RETURNING → []) bails BEFORE doing
// any extraction work (no second select, no insert) → no double extraction.
// This also fixes the pre-existing non-atomic-guard race. Windows-runnable.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  and: vi.fn((...a: any[]) => ({ and: a })),
  desc: vi.fn((c: any) => ({ desc: c })),
  sql: Object.assign(vi.fn(() => ({ sql: true })), { raw: vi.fn(() => ({ sql: true })) }),
}));

vi.mock("@armyofagents/db", () => ({
  discussionEntries: { id: "de_id", extractionStatus: "de_status", discussionId: "de_did" },
  discussions: { id: "d_id", companyId: "d_cid" },
  internalAgentConfig: { companyId: "iac_cid" },
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// Force the engine to "cli" so the atomic-claim assertions (select counts) are
// not perturbed by a real CLI PATH probe and so we never spawn a real binary.
vi.mock("../services/extraction-engine.js", () => ({
  resolveExtractionEngine: vi.fn(async () => "cli"),
  resolveCompanyCliTool: vi.fn(async () => "claude_cli"),
}));

// Keyless CLI extractor is stubbed — the winner-of-the-claim test only needs the
// extraction to proceed past the claim, not to produce real items.
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
    extractViaCli: vi.fn(async () => []),
    CliExtractionError: FakeCliExtractionError,
  };
});

import { extractionService } from "../services/extraction.js";

const PENDING_ENTRY = {
  id: "e1",
  discussionId: "d1",
  extractionStatus: "pending",
  rawContent: "x".repeat(50),
};

function makeDb(claimReturns: unknown[]) {
  let selectCalls = 0;
  const insert = vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([{}]) }) }));
  const db: any = {
    _selectCalls: () => selectCalls,
    _insert: insert,
    select: () => {
      selectCalls += 1;
      const n = selectCalls;
      const chain: any = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => chain;
      chain.then = (resolve: (v: unknown[]) => unknown) =>
        Promise.resolve(n === 1 ? [PENDING_ENTRY] : []).then(resolve);
      return chain;
    },
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve(claimReturns) }),
      }),
    }),
    insert,
  };
  return db;
}

describe("extractFromDiscussionEntry atomic claim", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "k";
    vi.clearAllMocks();
  });

  it("caller that LOSES the claim ([] returned) bails before any extraction work", async () => {
    const db = makeDb([]); // claim returns no row → not claimable
    await extractionService(db).extractFromDiscussionEntry("c1", "e1");
    // Only the initial entry fetch happened; no discussion fetch, no insert.
    expect(db._selectCalls()).toBe(1);
    expect(db._insert).not.toHaveBeenCalled();
  });

  it("caller that WINS the claim ([{id}] returned) proceeds past the claim", async () => {
    const db = makeDb([{ id: "e1" }]); // claimed
    await extractionService(db).extractFromDiscussionEntry("c1", "e1");
    // Proceeded past the claim to fetch the parent discussion (2nd select).
    expect(db._selectCalls()).toBeGreaterThanOrEqual(2);
  });
});
