import { describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures } from "../eval/fixture-loader.js";
import {
  buildAdjutantScopeSuite,
  type AdjutantClassification,
  type AdjutantThreadFixture,
} from "../eval/adjutant-scope-readiness/suite.js";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";
import { buildTriggerPrompt } from "../services/internal-agent/aoa-agents/aoa-trigger-prompt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "eval", "adjutant-scope-readiness", "fixtures");

function makeClassifierResponse(category: AdjutantClassification["category"], reasoning = "ok") {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: { content: JSON.stringify({ category, reasoning }) },
        },
      ],
    }),
  };
}

describe("loadFixtures", () => {
  it("loads all 18 Adjutant fixture cases sorted lexicographically", async () => {
    const cases = await loadFixtures<AdjutantThreadFixture, AdjutantClassification>(FIXTURES_DIR);
    expect(cases).toHaveLength(18);
    expect(cases.map((c) => c.id)).toEqual([
      "01-clearly-not-ready",
      "02-empty-thread",
      "03-pure-greetings",
      "04-phase-not-discuss",
      "05-only-agent-replies",
      "06-just-a-link",
      "07-medium-clarity",
      "08-vague-intent",
      "09-multiple-conflicting-ideas",
      "10-missing-constraints",
      "11-stalled-after-question",
      "12-full-alignment",
      "13-extensive-conversation",
      "14-rich-with-research",
      "15-obviously-ready",
      // P2-T4 regression fixtures — pin the QA-bug + new-behavior failure modes.
      "16-long-but-unconverged",       // QA-BUG-015: length ≠ readiness, don't scope prematurely
      "17-converged-facilitate",       // QA-BUG-016: facilitate (propose) when humans have aligned
      "18-already-proposed-awaiting-human", // act-once-then-silent: don't re-propose/loop
    ]);
  });

  it("returns properly shaped EvalCase records", async () => {
    const cases = await loadFixtures<AdjutantThreadFixture, AdjutantClassification>(FIXTURES_DIR);
    for (const c of cases) {
      expect(typeof c.id).toBe("string");
      expect(c.input.thread).toBeDefined();
      expect(["exact", "contains", "llm-graded"]).toContain(c.expected.type);
    }
  });
});

describe("buildAdjutantScopeSuite", () => {
  it("resolves to a suite named 'adjutant-scope-readiness' with 18 cases", async () => {
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    expect(suite.name).toBe("adjutant-scope-readiness");
    expect(suite.cases).toHaveLength(18);
    expect(suite.concurrency).toBe(5);
  });

  it("balances exact vs llm-graded across the fixture set (roughly 50/50)", async () => {
    const cases = await loadFixtures<AdjutantThreadFixture, AdjutantClassification>(FIXTURES_DIR);
    const exact = cases.filter((c) => c.expected.type === "exact").length;
    const graded = cases.filter((c) => c.expected.type === "llm-graded").length;
    expect(exact + graded).toBe(18);
    // Each side should have at least 5 cases so a single grading mode can't dominate.
    expect(exact).toBeGreaterThanOrEqual(5);
    expect(graded).toBeGreaterThanOrEqual(5);
  });

  it("covers all three categories with six fixtures each", async () => {
    const cases = await loadFixtures<AdjutantThreadFixture, AdjutantClassification>(FIXTURES_DIR);
    const counts: Record<string, number> = { wait: 0, "ask-clarifying": 0, "propose-scope": 0 };
    for (const c of cases) {
      const category = (c.expected.value as AdjutantClassification).category;
      counts[category] = (counts[category] ?? 0) + 1;
    }
    expect(counts).toEqual({ wait: 6, "ask-clarifying": 6, "propose-scope": 6 });
  });
});

describe("buildAdjutantScopeSuite.runOne", () => {
  it("calls fetch with the right body shape (model, system+user messages, json_object, temperature 0)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeClassifierResponse("wait", "nothing here"));
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });

    const first = suite.cases[0];
    const actual = await suite.runOne(first.input);
    expect(actual.category).toBe("wait");
    expect(actual.reasoning).toBe("nothing here");

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
    expect(body.messages[0].content).toContain("Adjutant");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("Thread phase:");
    expect(body.messages[1].content).toContain("Entries (oldest first):");
  });

  it("throws 'no OPENAI_API_KEY configured' when no key is supplied", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    // Force-clear process.env fallback for this test.
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const suite = await buildAdjutantScopeSuite({
        fetchImpl,
        fixturesDir: FIXTURES_DIR,
      });
      await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/no OPENAI_API_KEY/);
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("throws 'invalid category' when the classifier returns gibberish", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ category: "banana", reasoning: "?" }) } }],
      }),
    });
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/invalid category/);
  });

  it("throws when fetch returns non-ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/500/);
  });

  it("throws when the response is missing content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    });
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/empty content/);
  });
});

describe("buildAdjutantScopeSuite.grade", () => {
  it("returns exact match when categories match", async () => {
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(
      { category: "wait", reasoning: "" },
      { type: "exact", value: { category: "wait" } },
    );
    expect(grade.pass).toBe(true);
    expect(grade.score).toBe(1);
    expect(grade.reason).toContain("wait");
  });

  it("returns pass:false with 'expected X, got Y' helper text on exact mismatch", async () => {
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(
      { category: "wait", reasoning: "humans still chatting" },
      { type: "exact", value: { category: "propose-scope" } },
    );
    expect(grade.pass).toBe(false);
    expect(grade.score).toBe(0);
    expect(grade.reason).toContain("expected propose-scope");
    expect(grade.reason).toContain("got wait");
    // The classifier reasoning should be surfaced so failures are debuggable
    // from CI output without re-running the case.
    expect(grade.reason).toContain("humans still chatting");
  });

  it("delegates to the LLM grader for llm-graded cases (no-key sentinel path)", async () => {
    // No API key path — gradeWithRubric returns the sentinel without
    // calling fetch, which is exactly the signal we want CI to surface.
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const suite = await buildAdjutantScopeSuite({
        fetchImpl: vi.fn() as unknown as typeof fetch,
        fixturesDir: FIXTURES_DIR,
      });
      const grade = await suite.grade(
        { category: "propose-scope", reasoning: "looks good" },
        {
          type: "llm-graded",
          value: { category: "propose-scope" },
          rubric: "should converge into a scope",
        },
      );
      expect(grade.pass).toBe(false);
      expect(grade.reason).toContain("no OPENAI_API_KEY");
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("delegates to the LLM grader for llm-graded cases (mocked fetch path)", async () => {
    const graderFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ pass: true, score: 0.9, reason: "rubric satisfied" }),
            },
          },
        ],
      }),
    });
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: graderFetch as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(
      { category: "ask-clarifying", reasoning: "vague" },
      {
        type: "llm-graded",
        value: { category: "ask-clarifying" },
        rubric: "should ask a focused question",
      },
    );
    expect(grade.pass).toBe(true);
    expect(grade.score).toBe(0.9);
    expect(grade.reason).toBe("rubric satisfied");
    expect(graderFetch).toHaveBeenCalledTimes(1);
  });

  it("handles 'contains' grading by checking the category is in the allowed string[]", async () => {
    // expected.value MUST be a string[] of acceptable categories — narrow
    // contract instead of stringified-substring matching so {other:"wait-ish"}
    // can't false-positive when actual.category is "wait".
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const positive = await suite.grade(
      { category: "wait", reasoning: "" },
      { type: "contains", value: ["wait", "ask-clarifying"] },
    );
    expect(positive.pass).toBe(true);
    expect(positive.reason).toContain("allowed set");

    const negative = await suite.grade(
      { category: "propose-scope", reasoning: "" },
      { type: "contains", value: ["wait", "ask-clarifying"] },
    );
    expect(negative.pass).toBe(false);
    expect(negative.reason).toContain("propose-scope");
    expect(negative.reason).toContain("expected one of");
  });

  it("'contains' grading rejects non-array expected.value defensively", async () => {
    // Object-shaped expected.value (the old loose shape) must not false-positive.
    const suite = await buildAdjutantScopeSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const result = await suite.grade(
      { category: "wait", reasoning: "" },
      { type: "contains", value: { allowed: ["wait"] } as unknown as string[] },
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toContain("expected one of");
  });
});

/**
 * Real-bundle prompt content assertions (Task 5.1).
 *
 * These cases point at the ACTUAL assembled runtime prompt — the instruction
 * bundle loaded from onboarding-assets/adjutant/ (AGENTS + SOUL + TOOLS +
 * HEARTBEAT, concatenated in the same order as assembleAgentPersona) merged
 * with the ROLE_ACTION_DIRECTIVE.adjutant entry from aoa-trigger-prompt.ts.
 *
 * Assertions are purely deterministic (no LLM call, no fetch mock needed) and
 * run green in normal `pnpm test:run`. They act as a regression guard: if a
 * future edit removes propose_crew_work from the directive or adds a silence-
 * forbidden forcing clause, these cases fail immediately.
 *
 * Two invariants pinned here (Task 0.4 contract):
 *   1. Converged → propose: the assembled prompt directs the Adjutant to call
 *      `propose_crew_work` when the conversation has converged.
 *   2. Idle → silent: the assembled prompt explicitly permits returning without
 *      posting when there is nothing to do (no "returning is a bug" forcing
 *      clause that would make silence wrong).
 */
describe("real-bundle Adjutant prompt assertions (Task 5.1)", () => {
  /**
   * Assemble the real instruction bundle exactly as runner.ts does:
   *   loadDefaultAgentInstructionsBundle('adjutant') → join AGENTS, SOUL, TOOLS, HEARTBEAT
   *   then feed into buildTriggerPrompt with agentRoleKey='adjutant'.
   *
   * The BUNDLE_ORDER in assembleAgentPersona (commander-context.ts) is:
   *   ["AGENTS.md", "SOUL.md", "TOOLS.md", "HEARTBEAT.md"]
   * We replicate that join here without importing assembleAgentPersona
   * (which requires a full agentInstructionsService — a DB dependency).
   * loadDefaultAgentInstructionsBundle reads the canonical on-disk files
   * directly, which is the correct source of truth for the seed values
   * every new company receives.
   */
  async function buildRealAdjutantPrompt(overridePayload?: Record<string, unknown>): Promise<string> {
    const BUNDLE_ORDER = ["AGENTS.md", "SOUL.md", "TOOLS.md", "HEARTBEAT.md"] as const;
    const bundle = await loadDefaultAgentInstructionsBundle("adjutant");
    const instruction = BUNDLE_ORDER
      .map((name) => bundle[name] ?? "")
      .filter((c) => c.trim().length > 0)
      .join("\n\n");

    return buildTriggerPrompt({
      instruction,
      payload: {
        companyId: "co-test",
        source: "sweep.adjutant",
        threadId: "thr-test",
        ...overridePayload,
      },
      agentName: "Adjutant",
      agentRoleKey: "adjutant",
    });
  }

  it("assembled prompt contains propose_crew_work directive (converge → propose case)", async () => {
    const prompt = await buildRealAdjutantPrompt();
    // The ROLE_ACTION_DIRECTIVE for 'adjutant' in aoa-trigger-prompt.ts must
    // name propose_crew_work so the Adjutant knows which tool to call at convergence.
    expect(prompt).toContain("propose_crew_work");
  });

  it("assembled prompt contains convergence guidance in directive sentence", async () => {
    const prompt = await buildRealAdjutantPrompt();
    // The directive must condition propose_crew_work on convergence — not call it blindly.
    // "converged on work to do" or similar language must appear in the role directive.
    expect(prompt).toMatch(/converged|conversation has converged/i);
  });

  it("assembled prompt permits silence — does NOT contain 'returning without taking the directed action is a bug'", async () => {
    const prompt = await buildRealAdjutantPrompt();
    // Task 0.4 removed the old forcing clause that made silence a bug.
    // This regression guard ensures no future edit re-introduces it.
    expect(prompt).not.toMatch(/returning without taking the directed action is a bug/i);
  });

  it("assembled prompt explicitly marks silence as correct (idle → silent case)", async () => {
    const prompt = await buildRealAdjutantPrompt();
    // The directive must say "silence is correct" or similar — not merely omit
    // the forcing clause but actively sanction it, so the LLM treats staying
    // silent as a valid first-class outcome when the thread is not ready.
    expect(prompt).toMatch(/silence is (correct|acceptable|the right call)|staying? (quiet|silent) is the right|return without posting/i);
  });

  it("assembled TOOLS.md bundle independently documents propose_crew_work as primary convergence tool", async () => {
    // Separate from the directive: the TOOLS.md file the agent reads should
    // describe propose_crew_work so the agent can actually call it.
    const bundle = await loadDefaultAgentInstructionsBundle("adjutant");
    const tools = bundle["TOOLS.md"] ?? "";
    expect(tools).toContain("propose_crew_work");
    expect(tools).toMatch(/primary convergence tool|converge|converged/i);
  });

  it("assembled HEARTBEAT.md bundle instructs exit-silently when nothing to do", async () => {
    // The HEARTBEAT.md is the per-sweep decision flow document.
    // It must document the "exit silently" path for the idle case.
    const bundle = await loadDefaultAgentInstructionsBundle("adjutant");
    const heartbeat = bundle["HEARTBEAT.md"] ?? "";
    expect(heartbeat).toMatch(/exit silently|stay silent|return without posting|silence is correct/i);
  });
});
