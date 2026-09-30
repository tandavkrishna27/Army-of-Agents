/**
 * Planner plan-completeness eval suite — unit tests (Phase F4, T10).
 *
 * Verifies suite shape (10 fixtures, name, concurrency), runOne's wire shape
 * against the OpenAI Chat Completions API (markdown — NO response_format
 * envelope), the OPENAI_API_KEY sentinel, and the three grade modes (exact
 * / contains / llm-graded).
 *
 * runOne is a thin LLM-call wrapper around the Planner prompt, so unlike F3
 * there's no extractor stub to maintain — we mock fetch directly with the
 * markdown body the prompt would produce.
 */
import { describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures } from "../eval/fixture-loader.js";
import {
  buildPlannerSuite,
  stripPlanPreamble,
  type PlannerFixtureInput,
} from "../eval/planner-plan-completeness/suite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "eval", "planner-plan-completeness", "fixtures");

/**
 * Builds a fetch-response stub for the OpenAI Chat Completions API.
 * The Planner emits markdown directly — no JSON envelope — so the stub
 * just wraps the markdown string in the standard chat-completion shape.
 */
function makePlannerResponse(markdown: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: { content: markdown },
        },
      ],
    }),
  };
}

/** Realistic enough markdown to exercise the `contains` grader on real tokens. */
const SAMPLE_PLAN = [
  "Goal: ship the thing.",
  "",
  "## Tasks",
  "",
  "### 1. Implement the thing",
  "Depends on: none",
  "Acceptance criteria:",
  "- it works",
  "Suggested assignee: Engineer",
  "",
  "### 2. Test the thing",
  "Depends on: 1",
  "Acceptance criteria:",
  "- tests pass",
  "Suggested assignee: Engineer",
  "",
  "## Sequencing",
  "Task 1 first, then task 2.",
].join("\n");

describe("loadFixtures (Planner)", () => {
  it("loads all 10 Planner fixture cases sorted lexicographically", async () => {
    const cases = await loadFixtures<PlannerFixtureInput, unknown>(FIXTURES_DIR);
    expect(cases).toHaveLength(10);
    expect(cases.map((c) => c.id)).toEqual([
      "01-single-task",
      "02-two-independent-tasks",
      "03-implement-then-test",
      "04-research-then-build",
      "05-four-tasks-mixed-deps",
      "06-acceptance-criteria-passthrough",
      "07-no-criteria-provided",
      "08-assignee-routing",
      "09-all-tasks-present",
      "10-rich-scope",
    ]);
  });

  it("returns properly shaped EvalCase records", async () => {
    const cases = await loadFixtures<PlannerFixtureInput, unknown>(FIXTURES_DIR);
    for (const c of cases) {
      expect(typeof c.id).toBe("string");
      expect(c.input.scope).toBeDefined();
      expect(c.input.scope.threadId).toEqual(expect.any(String));
      expect(c.input.scope.summary).toEqual(expect.any(String));
      expect(Array.isArray(c.input.scope.proposedTasks)).toBe(true);
      expect(c.input.scope.proposedTasks.length).toBeGreaterThan(0);
      expect(Array.isArray(c.input.scope.availableAgents)).toBe(true);
      expect(["exact", "contains", "llm-graded"]).toContain(c.expected.type);
    }
  });
});

describe("buildPlannerSuite", () => {
  it("resolves to a suite named 'planner-plan-completeness' with 10 cases", async () => {
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    expect(suite.name).toBe("planner-plan-completeness");
    expect(suite.cases).toHaveLength(10);
    expect(suite.concurrency).toBe(5);
  });

  it("balances grading modes across the fixture set", async () => {
    // The spec authors 4 'contains' + 6 'llm-graded' fixtures (no 'exact' —
    // exact-matching a markdown blob is too brittle for a prose suite).
    // Lock the floor for each used mode so a single grading mode can't
    // dominate without the suite test catching it.
    const cases = await loadFixtures<PlannerFixtureInput, unknown>(FIXTURES_DIR);
    const counts: Record<string, number> = { exact: 0, "llm-graded": 0, contains: 0 };
    for (const c of cases) {
      counts[c.expected.type] = (counts[c.expected.type] ?? 0) + 1;
    }
    expect(counts.exact + counts["llm-graded"] + counts.contains).toBe(10);
    expect(counts.contains).toBeGreaterThanOrEqual(3);
    expect(counts["llm-graded"]).toBeGreaterThanOrEqual(3);
  });
});

describe("buildPlannerSuite.runOne", () => {
  it("calls fetch with the right body shape (model, system+user messages, temperature 0, NO response_format)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makePlannerResponse(SAMPLE_PLAN));
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });

    const first = suite.cases[0];
    const actual = await suite.runOne(first.input);
    expect(actual).toBe(SAMPLE_PLAN);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.temperature).toBe(0);
    // The Planner emits markdown — there must be NO response_format envelope
    // (json_object would force the model to wrap the markdown and pollute it).
    expect(body.response_format).toBeUndefined();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Planner");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("Scope summary:");
    expect(body.messages[1].content).toContain("Proposed tasks");
    expect(body.messages[1].content).toContain("Available agents:");
  });

  it("throws 'no OPENAI_API_KEY configured' when no key is supplied", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const suite = await buildPlannerSuite({
        fetchImpl,
        fixturesDir: FIXTURES_DIR,
      });
      await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/no OPENAI_API_KEY/);
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("throws on non-ok fetch with status + body in the message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "upstream busy",
    });
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/503/);
  });

  it("throws on empty LLM content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    });
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/empty content/);
  });
});

describe("buildPlannerSuite.grade (contains)", () => {
  it("passes when every expected substring appears in the markdown", async () => {
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(SAMPLE_PLAN, {
      type: "contains",
      value: ["Goal", "### 1.", "Depends on: none", "Suggested assignee", "Sequencing"],
    });
    expect(grade.pass).toBe(true);
    expect(grade.score).toBe(1);
    expect(grade.reason).toContain("all expected substrings present");
  });

  it("fails listing the missing substrings", async () => {
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade("Goal: ship it.\nTasks coming.", {
      type: "contains",
      value: ["### 1.", "Depends on:", "Sequencing"],
    });
    expect(grade.pass).toBe(false);
    expect(grade.score).toBe(0);
    expect(grade.reason).toContain("missing substrings");
    // Each missing needle is JSON-quoted so escapes are unambiguous in CI output.
    expect(grade.reason).toContain('"### 1."');
    expect(grade.reason).toContain('"Sequencing"');
  });

  it("rejects non-array expected.value defensively", async () => {
    // Object-shaped expected.value (the Memory Keeper exact shape, or the
    // Adjutant llm-graded value shape) must not false-positive against the
    // Planner contains contract.
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(SAMPLE_PLAN, {
      type: "contains",
      value: { substrings: ["Goal"] } as unknown as string[],
    });
    expect(grade.pass).toBe(false);
    expect(grade.reason).toContain("expected.value: string[]");
  });
});

describe("buildPlannerSuite.grade (exact)", () => {
  it("passes when the markdown matches the expected string verbatim", async () => {
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(SAMPLE_PLAN, { type: "exact", value: SAMPLE_PLAN });
    expect(grade.pass).toBe(true);
    expect(grade.score).toBe(1);
    expect(grade.reason).toContain("matched exactly");
  });

  it("fails when the markdown differs from the expected string", async () => {
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(SAMPLE_PLAN, {
      type: "exact",
      value: "something else entirely",
    });
    expect(grade.pass).toBe(false);
    expect(grade.score).toBe(0);
    expect(grade.reason).toContain("exact match failed");
  });
});

describe("buildPlannerSuite.grade (llm-graded)", () => {
  it("delegates to the LLM grader (no-key sentinel path)", async () => {
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const suite = await buildPlannerSuite({
        fetchImpl: vi.fn() as unknown as typeof fetch,
        fixturesDir: FIXTURES_DIR,
      });
      const grade = await suite.grade(SAMPLE_PLAN, {
        type: "llm-graded",
        value: { expectedDependency: "task 2 depends on task 1" },
        rubric: "task 2 should depend on task 1",
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
              content: JSON.stringify({ pass: true, score: 0.88, reason: "rubric satisfied" }),
            },
          },
        ],
      }),
    });
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: graderFetch as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(SAMPLE_PLAN, {
      type: "llm-graded",
      value: { expectedDependency: "task 2 depends on task 1" },
      rubric: "task 2 should depend on task 1",
    });
    expect(grade.pass).toBe(true);
    expect(grade.score).toBe(0.88);
    expect(grade.reason).toBe("rubric satisfied");
    expect(graderFetch).toHaveBeenCalledTimes(1);
  });
});

describe("stripPlanPreamble", () => {
  it("returns clean markdown unchanged (idempotent)", () => {
    expect(stripPlanPreamble(SAMPLE_PLAN)).toBe(SAMPLE_PLAN);
  });

  it("strips a leading 'Sure, here is …' chat preamble before 'Goal:'", () => {
    const noisy = "Sure! Here is the plan you requested:\n\n" + SAMPLE_PLAN;
    expect(stripPlanPreamble(noisy)).toBe(SAMPLE_PLAN);
  });

  it("strips a leading code fence wrapper ```markdown ... ```", () => {
    const fenced = "```markdown\n" + SAMPLE_PLAN + "\n```";
    expect(stripPlanPreamble(fenced)).toBe(SAMPLE_PLAN);
  });

  it("strips a trailing 'Let me know …' sign-off", () => {
    const noisy = SAMPLE_PLAN + "\n\nLet me know if you want to adjust!";
    expect(stripPlanPreamble(noisy)).toBe(SAMPLE_PLAN);
  });

  it("strips both preamble AND postamble in one pass", () => {
    const noisy =
      "Here is the plan:\n\n" + SAMPLE_PLAN + "\n\nHope this helps with shipping.";
    expect(stripPlanPreamble(noisy)).toBe(SAMPLE_PLAN);
  });

  it("falls back to first heading when no 'Goal:' anchor is present", () => {
    const noGoal = "Random intro line.\n\n## Tasks\n\n### 1. Do thing\nDepends on: none";
    const stripped = stripPlanPreamble(noGoal);
    expect(stripped.startsWith("## Tasks")).toBe(true);
  });
});

describe("buildPlannerSuite.grade (case-insensitive contains)", () => {
  // The eval prompt mandates 'Depends on: none' in lowercase, but gpt-4o-mini
  // occasionally drifts to 'Depends on: None'. The contains grader is now
  // case-insensitive to absorb that drift without losing semantic signal.
  it("matches substrings case-insensitively", async () => {
    const suite = await buildPlannerSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
    });
    const grade = await suite.grade(SAMPLE_PLAN, {
      type: "contains",
      // Mixed-case needles MUST still match against lowercase markdown.
      value: ["GOAL:", "depends on: NONE", "### 1."],
    });
    expect(grade.pass).toBe(true);
    expect(grade.reason).toContain("all expected substrings present");
  });
});
