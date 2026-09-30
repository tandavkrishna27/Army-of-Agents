import { describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures } from "../eval/fixture-loader.js";
import { buildCompactSkillList } from "../services/internal-agent/commander-skills.js";
import {
  buildCommanderSkillTriggeringSuite,
  loadSkillsSnapshot,
  renderSkillsTable,
  type RoutingCaseInput,
} from "../eval/commander-skill-triggering/suite.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "eval", "commander-skill-triggering", "fixtures");
const SNAPSHOT_PATH = join(
  __dirname,
  "..",
  "eval",
  "commander-skill-triggering",
  "skills-snapshot.json",
);

// The 11 canonical RUNTIME seeder keys — hardcoded so the test fails loudly
// (not silently) if a skill is added/removed from skills-snapshot.json
// without updating this drift guard. Plan 3 added daily-triage,
// review-agent-output, and delegate-handoff (8 -> 11).
const CANONICAL_SKILL_KEYS = [
  "skill:aoa/brainstorm",
  "skill:aoa/office-hours",
  "skill:aoa/spec",
  "skill:aoa/sprint-planning",
  "skill:aoa/team-design",
  "skill:aoa/identity-setup",
  "skill:aoa/investigate",
  "skill:aoa/discussion-facilitation",
  "skill:aoa/daily-triage",
  "skill:aoa/review-agent-output",
  "skill:aoa/delegate-handoff",
].sort();

function makeClassifierResponse(key: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ key }) } }],
    }),
  };
}

describe("commander-skill-triggering fixtures", () => {
  it("loads exactly 16 fixture cases", async () => {
    const cases = await loadFixtures<RoutingCaseInput, string>(FIXTURES_DIR);
    expect(cases).toHaveLength(16);
  });

  it("every expected.value is 'none' or one of the 11 snapshot keys", async () => {
    const cases = await loadFixtures<RoutingCaseInput, string>(FIXTURES_DIR);
    const allowed = new Set([...CANONICAL_SKILL_KEYS, "none"]);
    for (const c of cases) {
      expect(allowed.has(c.expected.value)).toBe(true);
    }
  });

  it("every case is an exact-match EvalCase with a non-empty prompt", async () => {
    const cases = await loadFixtures<RoutingCaseInput, string>(FIXTURES_DIR);
    for (const c of cases) {
      expect(c.expected.type).toBe("exact");
      expect(typeof c.input.prompt).toBe("string");
      expect(c.input.prompt.length).toBeGreaterThan(0);
    }
  });
});

describe("commander-skill-triggering snapshot-drift guard", () => {
  it("contains exactly the 11 canonical RUNTIME seeder keys — nothing added or removed silently", async () => {
    const snapshot = await loadSkillsSnapshot(SNAPSHOT_PATH);
    const keys = snapshot.map((s) => s.key).sort();
    expect(keys).toEqual(CANONICAL_SKILL_KEYS);
  });

  it("every snapshot entry declares triggerPhrases explicitly (even if empty)", async () => {
    const snapshot = await loadSkillsSnapshot(SNAPSHOT_PATH);
    for (const s of snapshot) {
      expect(Array.isArray(s.triggerPhrases)).toBe(true);
    }
  });
});

describe("commander-skill-triggering B3 non-empty-table guard", () => {
  it("renders a non-empty table containing '## Available Skills' and at least one snapshot key", async () => {
    const snapshot = await loadSkillsSnapshot(SNAPSHOT_PATH);
    const table = await renderSkillsTable(snapshot);
    expect(table.length).toBeGreaterThan(0);
    expect(table).toContain("## Available Skills");
    expect(table).toContain("skill:aoa/brainstorm");
  });

  it("demonstrates the trap the guard exists for: buildCompactSkillList silently returns '' when a resolved entry is missing triggerPhrases", async () => {
    // This is the actual B3 failure mode, isolated from renderSkillsTable's
    // own `?? []` defense: buildCompactSkillList's resolve() return type
    // requires triggerPhrases: string[] and reads `.length` on it directly
    // (commander-skills.ts). A resolved entry missing that field throws
    // inside the loop, which buildCompactSkillList's own try/catch swallows,
    // returning "" — an empty table that would grade every case as a silent
    // "none" instead of failing loudly. This is exactly why
    // renderSkillsTable (used by the suite) applies `s.triggerPhrases ?? []`
    // on every row before calling buildCompactSkillList — see the next test.
    const emptyTable = await buildCompactSkillList({
      companyId: "test-company",
      agentId: "test-agent",
      resolve: async () =>
        [
          { key: "skill:aoa/brainstorm", name: "aoa-brainstorm", description: "desc" },
        ] as unknown as Array<{ key: string; name: string; description: string; triggerPhrases: string[] }>,
    });
    expect(emptyTable).toBe("");
  });

  it("renderSkillsTable's `?? []` fallback prevents that trap even when a snapshot row omits triggerPhrases", async () => {
    const snapshot = await loadSkillsSnapshot(SNAPSHOT_PATH);
    const withMissingField = snapshot.map((s, i) =>
      i === 0 ? ({ key: s.key, name: s.name, description: s.description } as any) : s,
    );
    const table = await renderSkillsTable(withMissingField);
    expect(table.length).toBeGreaterThan(0);
    expect(table).toContain("## Available Skills");
  });
});

describe("buildCommanderSkillTriggeringSuite", () => {
  it("resolves to a suite named 'commander-skill-triggering' with 16 cases, concurrency 5", async () => {
    const suite = await buildCommanderSkillTriggeringSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
      snapshotPath: SNAPSHOT_PATH,
    });
    expect(suite.name).toBe("commander-skill-triggering");
    expect(suite.cases).toHaveLength(16);
    expect(suite.concurrency).toBe(5);
  });
});

describe("buildCommanderSkillTriggeringSuite.runOne", () => {
  it("calls fetch with the right body shape (model, system+user messages, json_object, temperature 0)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeClassifierResponse("skill:aoa/spec"));
    const suite = await buildCommanderSkillTriggeringSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
      snapshotPath: SNAPSHOT_PATH,
    });

    const first = suite.cases[0];
    const actual = await suite.runOne(first.input);
    expect(actual.key).toBe("skill:aoa/spec");

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
    expect(body.messages[0].content).toContain("Commander's router");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("## Available Skills");
    expect(body.messages[1].content).toContain("User message:");
  });

  it("throws 'no OPENAI_API_KEY configured' when no key is supplied", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const prevKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const suite = await buildCommanderSkillTriggeringSuite({
        fetchImpl,
        fixturesDir: FIXTURES_DIR,
        snapshotPath: SNAPSHOT_PATH,
      });
      await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/no OPENAI_API_KEY/);
    } finally {
      if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
    }
  });

  it("throws when the response is missing content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    });
    const suite = await buildCommanderSkillTriggeringSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
      snapshotPath: SNAPSHOT_PATH,
    });
    await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/empty content/);
  });

  it("throws when fetch returns non-ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    });
    const suite = await buildCommanderSkillTriggeringSuite({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
      snapshotPath: SNAPSHOT_PATH,
    });
    await expect(suite.runOne(suite.cases[0].input)).rejects.toThrow(/500/);
  });
});

describe("buildCommanderSkillTriggeringSuite.grade", () => {
  it("grades pass:true when the classifier key matches expected.value exactly", async () => {
    const suite = await buildCommanderSkillTriggeringSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
      snapshotPath: SNAPSHOT_PATH,
    });
    const grade = await suite.grade({ key: "skill:aoa/spec" }, { type: "exact", value: "skill:aoa/spec" });
    expect(grade.pass).toBe(true);
    expect(grade.score).toBe(1);
    expect(grade.reason).toContain("skill:aoa/spec");
  });

  it("grades pass:false with 'expected X, got Y' helper text on mismatch", async () => {
    const suite = await buildCommanderSkillTriggeringSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
      snapshotPath: SNAPSHOT_PATH,
    });
    const grade = await suite.grade(
      { key: "skill:aoa/brainstorm" },
      { type: "exact", value: "skill:aoa/spec" },
    );
    expect(grade.pass).toBe(false);
    expect(grade.score).toBe(0);
    expect(grade.reason).toContain("expected skill:aoa/spec");
    expect(grade.reason).toContain("got skill:aoa/brainstorm");
  });

  it("grades pass:true for the 'none' negative case when the classifier also says none", async () => {
    const suite = await buildCommanderSkillTriggeringSuite({
      apiKey: "sk-test",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      fixturesDir: FIXTURES_DIR,
      snapshotPath: SNAPSHOT_PATH,
    });
    const grade = await suite.grade({ key: "none" }, { type: "exact", value: "none" });
    expect(grade.pass).toBe(true);
  });
});
