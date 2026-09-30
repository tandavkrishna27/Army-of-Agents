/**
 * Memory Keeper extraction eval suite — unit tests (Phase F3, T10).
 *
 * Verifies suite shape (12 fixtures, name, concurrency), runOne's wire
 * shape against the OpenAI Chat Completions API, the OPENAI_API_KEY
 * sentinel, and the three grade modes (exact / contains / llm-graded).
 *
 * runOne drives the real `extractMemoryCandidates` against a stub db, so
 * these tests also exercise the prompt + parser end-to-end via the
 * injected `ExtractionLlm`. The stub db is built inside the suite — these
 * tests just feed the LLM JSON and verify the suite shape downstream.
 */
import { describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures } from "../eval/fixture-loader.js";
import {
  buildMemoryKeeperSuite,
  type MemoryKeeperFixtureInput,
} from "../eval/memory-keeper-extraction/suite.js";
import type { MemoryCandidate } from "../services/extraction.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "eval", "memory-keeper-extraction", "fixtures");

/**
 * Builds a fetch-response stub for the OpenAI Chat Completions API.
 * The Memory Keeper prompt asks for a JSON array; we wrap it in the
 * response_format: json_object envelope (`{items: [...]}`) so the suite's
 * adapter has to unwrap it — this mirrors the real OpenAI behavior.
 */
function makeExtractorResponse(items: unknown[]) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: { content: JSON.stringify({ items }) },
        },
      ],
    }),
  };
}

describe("loadFixtures (Memory Keeper)", () => {
  it("loads all 12 Memory Keeper fixture cases sorted lexicographically", async () => {
    const cases = await loadFixtures<MemoryKeeperFixtureInput, unknown>(FIXTURES_DIR);
    expect(cases).toHaveLength(12);
    expect(cases.map((c) => c.id)).toEqual([
      "01-empty-thread",
      "02-greetings-only",
      "03-single-decision",
      "04-single-insight",
      "05-single-reference",
      "06-mixed-content",
      "07-decision-and-insight",
      "08-task-mention",
      "09-multiple-decisions",
      "10-preference-signal",
      "11-context-marker",
      "12-rich-thread",
    ]);
  });

  it("returns properly shaped EvalCase records", async () => {
    const cases = await loadFixtures<MemoryKeeperFixtureInput, unknown>(FIXTURES_DIR);
    for (const c of cases) {
      expect(typeof c.id).toBe("string");
      expect(c.input.thread).toBeDefined();
      expect(c.input.thread.id).toEqual(expect.any(String));
      expect(c.input.thread.companyId).toEqual(expect.any(String));
      expect(Array.isArray(c.input.thread.entries)).toBe(true);
      expect(["exact", "contains", "llm-graded"]).toContain(c.expected.type);
    }
  });
});

describe("buildMemoryKeeperSuite", () => {
  it("resolves to a suite named 'memory-keeper-extraction' with 12 cases", async () => {
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    expect(suite.name).toBe("memory-keeper-extraction");
    expect(suite.cases).toHaveLength(12);
    expect(suite.concurrency).toBe(5);
  });

  it("balances grading modes across the fixture set", async () => {
    // The spec authors 5 exact, 4 llm-graded, and 3 contains fixtures.
    // We don't lock the exact split, but each mode must have at least 2
    // fixtures so a single grading mode can't dominate.
    const cases = await loadFixtures<MemoryKeeperFixtureInput, unknown>(FIXTURES_DIR);
    const counts: Record<string, number> = { exact: 0, "llm-graded": 0, contains: 0 };
    for (const c of cases) {
      counts[c.expected.type] = (counts[c.expected.type] ?? 0) + 1;
    }
    expect(counts.exact + counts["llm-graded"] + counts.contains).toBe(12);
    expect(counts.exact).toBeGreaterThanOrEqual(2);
    expect(counts["llm-graded"]).toBeGreaterThanOrEqual(2);
    expect(counts.contains).toBeGreaterThanOrEqual(2);
  });
});

describe("buildMemoryKeeperSuite.runOne", () => {
  it("calls fetch with the right body shape (model, system+user messages, json_object, temperature 0)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        makeExtractorResponse([
          { type: "decision", title: "Use Tailwind", description: "for dashboard" },
        ]),
      );
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });

    // Pick a non-empty fixture so the extractor actually calls the LLM
    // (the 01-empty-thread case short-circuits before fetch).
    const fixture = suite.cases.find((c) => c.id === "03-single-decision");
    if (!fixture) throw new Error("fixture not found");
    const actual = await suite.runOne(fixture.input);

    expect(actual).toHaveLength(1);
    expect(actual[0].type).toBe("decision");
    expect(actual[0].title).toBe("Use Tailwind");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    // The prompt is the production extraction prompt — assert on a stable token.
    expect(body.messages[0].content).toContain("DECISIONS");
    expect(body.messages[1].role).toBe("user");
    // The user content is the concatenated entries with `---` separators
    // (a single-entry fixture has no separator). Either way the entry
    // content should appear verbatim.
    expect(body.messages[1].content).toContain("Tailwind");
  });

  it("parses an array-shaped LLM response (bare JSON array)", async () => {
    // The adapter also tolerates a bare array (no envelope) — this is the
    // shape parseExtractedItems was originally written for.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify([
                { type: "insight", title: "Conversion bottleneck at step 4" },
              ]),
            },
          },
        ],
      }),
    });
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const fixture = suite.cases.find((c) => c.id === "04-single-insight");
    if (!fixture) throw new Error("fixture not found");
    const actual = await suite.runOne(fixture.input);
    expect(actual).toHaveLength(1);
    expect(actual[0].type).toBe("insight");
  });

  it("short-circuits to [] for the empty-thread fixture without calling fetch", async () => {
    // Empty entries → extractMemoryCandidates returns {candidates: []} before
    // touching the LLM. We assert fetch was NOT called to lock in that the
    // suite passes through the extractor's short-circuit (no wasted spend).
    const fetchImpl = vi.fn();
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const fixture = suite.cases.find((c) => c.id === "01-empty-thread");
    if (!fixture) throw new Error("fixture not found");
    const actual = await suite.runOne(fixture.input);
    expect(actual).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws 'no OPENAI_API_KEY configured' when no key is supplied", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const suite = await buildMemoryKeeperSuite({
        fetchImpl,
        fixturesDir: FIXTURES_DIR,
      });
      // Use a non-empty fixture; the empty case skips the API-key path because
      // the LLM is never invoked.
      const fixture = suite.cases.find((c) => c.id === "03-single-decision");
      if (!fixture) throw new Error("fixture not found");
      await expect(suite.runOne(fixture.input)).rejects.toThrow(/no OPENAI_API_KEY/);
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("throws on non-ok fetch with status + body in the message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
    });
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const fixture = suite.cases.find((c) => c.id === "03-single-decision");
    if (!fixture) throw new Error("fixture not found");
    await expect(suite.runOne(fixture.input)).rejects.toThrow(/500/);
  });

  it("throws on empty LLM content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    });
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const fixture = suite.cases.find((c) => c.id === "03-single-decision");
    if (!fixture) throw new Error("fixture not found");
    await expect(suite.runOne(fixture.input)).rejects.toThrow(/empty content/);
  });
});

describe("buildMemoryKeeperSuite.grade (exact)", () => {
  it("passes when types match (order-agnostic)", async () => {
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const actual: MemoryCandidate[] = [
      candidate("insight", "A"),
      candidate("decision", "B"),
    ];
    const grade = await suite.grade(actual, {
      type: "exact",
      // Expected order is decision,insight — actual is insight,decision.
      // Order-agnostic grade should pass.
      value: { types: ["decision", "insight"] },
    });
    expect(grade.pass).toBe(true);
    expect(grade.score).toBe(1);
    expect(grade.reason).toContain("matched");
  });

  it("passes for the empty case when expected.types is []", async () => {
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade([], { type: "exact", value: { types: [] } });
    expect(grade.pass).toBe(true);
    expect(grade.reason).toContain("empty");
  });

  it("fails with a helpful diff when types mismatch", async () => {
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const actual: MemoryCandidate[] = [
      candidate("task", "Set up CI"),
      candidate("decision", "Use Tailwind"),
    ];
    const grade = await suite.grade(actual, {
      type: "exact",
      value: { types: ["decision"] },
    });
    expect(grade.pass).toBe(false);
    expect(grade.score).toBe(0);
    expect(grade.reason).toContain("expected [decision]");
    expect(grade.reason).toContain("got [decision, task]");
  });

  it("fails when expected.value is not the {types: string[]} shape", async () => {
    // Defensive narrowing — a stale `{category: ...}` style expected.value
    // (the Adjutant shape) must not false-positive against the Memory Keeper
    // contract.
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade([], {
      type: "exact",
      value: { category: "wait" } as unknown as { types: string[] },
    });
    expect(grade.pass).toBe(false);
    expect(grade.reason).toContain("expected.value.types");
  });
});

describe("buildMemoryKeeperSuite.grade (contains)", () => {
  it("passes when all expected types are present (extras are fine)", async () => {
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const actual: MemoryCandidate[] = [
      candidate("task", "Wire up CI"),
      candidate("decision", "Use BullMQ"),
    ];
    const grade = await suite.grade(actual, {
      type: "contains",
      value: ["task"],
    });
    expect(grade.pass).toBe(true);
    expect(grade.reason).toContain("all expected types present");
  });

  it("fails listing the missing types", async () => {
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const actual: MemoryCandidate[] = [candidate("insight", "Conversion drop")];
    const grade = await suite.grade(actual, {
      type: "contains",
      value: ["task", "decision"],
    });
    expect(grade.pass).toBe(false);
    expect(grade.reason).toContain("missing types [task, decision]");
    expect(grade.reason).toContain("insight");
  });

  it("rejects non-array expected.value defensively", async () => {
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade([], {
      type: "contains",
      value: { types: ["task"] } as unknown as string[],
    });
    expect(grade.pass).toBe(false);
    expect(grade.reason).toContain("expected.value: string[]");
  });
});

describe("buildMemoryKeeperSuite.grade (llm-graded)", () => {
  it("delegates to the LLM grader (no-key sentinel path)", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const suite = await buildMemoryKeeperSuite({
        fetchImpl: vi.fn() as unknown as typeof fetch,
        fixturesDir: FIXTURES_DIR,
      });
      const grade = await suite.grade([candidate("decision", "Use Tailwind")], {
        type: "llm-graded",
        value: { decisionCount: 1 },
        rubric: "should contain exactly one decision",
      });
      expect(grade.pass).toBe(false);
      expect(grade.reason).toContain("no OPENAI_API_KEY");
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("delegates to the LLM grader (mocked fetch path)", async () => {
    const graderFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ pass: true, score: 0.95, reason: "rubric satisfied" }),
            },
          },
        ],
      }),
    });
    const suite = await buildMemoryKeeperSuite({
      apiKey: "sk-test",
      fetchImpl: graderFetch as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(
      [candidate("decision", "Use PostgreSQL"), candidate("decision", "Use pnpm")],
      {
        type: "llm-graded",
        value: { decisionCount: 2 },
        rubric: "should contain exactly two decisions",
      },
    );
    expect(grade.pass).toBe(true);
    expect(grade.score).toBe(0.95);
    expect(grade.reason).toBe("rubric satisfied");
    expect(graderFetch).toHaveBeenCalledTimes(1);
  });
});

function candidate(
  type: MemoryCandidate["type"],
  title: string,
): MemoryCandidate {
  return {
    type,
    title,
    description: null,
    suggestedLayer: null,
    suggestedPriority: null,
    suggestedDepartment: null,
  };
}
