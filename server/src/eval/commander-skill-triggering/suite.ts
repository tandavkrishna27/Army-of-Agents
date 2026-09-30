/**
 * Commander skill-triggering eval suite (Plan 2, Task 6 — lite skill-triggering eval).
 *
 * Commander's `use_skill` runs inside a real CLI subprocess (see
 * `agent-loop.ts` — the assembled prompt/system context is handed to
 * claude/codex over stdin, not driven in-process), so there is no
 * in-process router function to unit-test directly, and the skill KEY the
 * model chose is never persisted (`internal_agent_messages.toolCalls` stores
 * only the tool `name`, e.g. "use_skill" — see `agent-loop.ts:313-315`).
 *
 * This suite is the honest analog of the three existing Phase F suites
 * (`adjutant-scope-readiness`, `memory-keeper-extraction`,
 * `planner-plan-completeness`): it renders the REAL production skills table
 * (via `buildCompactSkillList` + the shared Commander preamble + the
 * Task-4-rewritten WHEN-only descriptions, sourced from `skills-snapshot.json`)
 * and asks a cheap classifier, at temperature 0, which skill key it would
 * `use_skill` for a naive prompt that never names the skill — then grades
 * exact-match against the expected key (or "none" for a plain query that a
 * skill would incorrectly hijack).
 *
 * Because it renders the actual descriptions, this suite regresses when a
 * Task 4 description regresses — that is the point. It doubles as the
 * acceptance test for the WHEN-only rewrite.
 *
 * B3 GUARD: `buildCompactSkillList`'s `resolve` return type requires
 * `triggerPhrases: string[]` and reads `.length` on it. A snapshot entry
 * missing that field throws inside `resolve`, which `buildCompactSkillList`
 * swallows in its own try/catch and returns `""` — an EMPTY table that would
 * silently make every case grade against a blank "## Available Skills"
 * section (i.e. every case looks like "none" was the honest answer, when
 * really the skills table never rendered). `buildCommanderSkillTriggeringSuite`
 * renders the table once at suite-build time and throws loudly if it does not
 * contain "## Available Skills" — see the `renderSkillsTable` guard below and
 * the mirrored unit test in `commander-skill-triggering-suite.test.ts`.
 *
 * HONEST SCOPE (do not oversell): this suite needs `OPENAI_API_KEY` (a paid
 * secret CI does not provide), so `runAllEvalSuites` prints `[skipped]` and
 * returns `[]` in CI (`run-all.ts:69-75`). Its ≥80% pass threshold is a
 * manual/local acceptance signal run before shipping description changes —
 * it is NOT CI-enforced. What runs in CI is only the mocked-fetch unit test
 * (fixture-loading, snapshot-drift guard, B3 non-empty-table guard, grade()
 * logic), which does not exercise live routing.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { EvalGrade, EvalSuite } from "../types.js";
import { loadFixtures } from "../fixture-loader.js";
import { buildCompactSkillList } from "../../services/internal-agent/commander-skills.js";

const CLASSIFY_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT =
  "You are Commander's router. Given the Available Skills table and a user message, " +
  'reply JSON {"key": <skill key or \'none\'>} for the single skill you would `use_skill` for, ' +
  "or 'none' if a plain query answers it. Return JSON only.";

/** One row of the synced skills snapshot (`skills-snapshot.json`). */
export interface SkillSnapshotEntry {
  key: string;
  name: string;
  description: string;
  triggerPhrases: string[];
}

export interface RoutingCaseInput {
  prompt: string;
  userRole?: string;
}

export interface RoutingClassification {
  key: string;
}

export interface CommanderSkillTriggeringSuiteConfig {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  fixturesDir?: string;
  snapshotPath?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadSkillsSnapshot(snapshotPath: string): Promise<SkillSnapshotEntry[]> {
  const raw = await readFile(snapshotPath, "utf8");
  const parsed = JSON.parse(raw) as { skills: SkillSnapshotEntry[] };
  return parsed.skills;
}

/**
 * Render the exact production skills table (preamble + "## Available Skills"
 * markdown) Commander would see this turn, by calling the REAL
 * `buildCompactSkillList` over the snapshot. `triggerPhrases: e.triggerPhrases
 * ?? []` guards the B3 empty-table trap even if a snapshot row omits the
 * field (still, every checked-in row must include it explicitly — see the
 * drift guard in the unit test).
 */
export async function renderSkillsTable(snapshot: SkillSnapshotEntry[]): Promise<string> {
  return buildCompactSkillList({
    companyId: "eval-company",
    agentId: "eval-agent",
    resolve: async () =>
      snapshot.map((s) => ({
        key: s.key,
        name: s.name,
        description: s.description,
        triggerPhrases: s.triggerPhrases ?? [],
      })),
  });
}

export async function buildCommanderSkillTriggeringSuite(
  config: CommanderSkillTriggeringSuiteConfig = {},
): Promise<EvalSuite<RoutingCaseInput, RoutingClassification, string>> {
  const fixturesDir = config.fixturesDir ?? join(__dirname, "fixtures");
  const snapshotPath = config.snapshotPath ?? join(__dirname, "skills-snapshot.json");
  const cases = await loadFixtures<RoutingCaseInput, string>(fixturesDir);
  const snapshot = await loadSkillsSnapshot(snapshotPath);
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const model = config.model ?? CLASSIFY_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;

  // B3 guard — fail loudly (suite build throws) instead of silently grading
  // every case as "none" because the rendered table came back empty.
  const table = await renderSkillsTable(snapshot);
  if (!table.includes("## Available Skills")) {
    throw new Error(
      "empty skill table — snapshot shape regressed (buildCompactSkillList returned no " +
        "'## Available Skills' section; check that every skills-snapshot.json entry has a " +
        "triggerPhrases array)",
    );
  }

  return {
    name: "commander-skill-triggering",
    cases,
    concurrency: 5,
    async runOne(input) {
      if (!apiKey) {
        throw new Error("no OPENAI_API_KEY configured");
      }
      const userPrompt = [table, "", `User message: ${input.prompt}`].join("\n");
      const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "<no body>");
        throw new Error(
          `skill-triggering classifier fetch failed ${response.status}: ${body.slice(0, 200)}`,
        );
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("classifier returned empty content");
      const parsed = JSON.parse(content) as Partial<RoutingClassification>;
      if (typeof parsed.key !== "string" || parsed.key.length === 0) {
        throw new Error(`classifier returned invalid key: ${JSON.stringify(parsed)}`);
      }
      return { key: parsed.key };
    },
    async grade(actual, expected): Promise<EvalGrade> {
      if (expected.type !== "exact") {
        return { pass: false, score: 0, reason: `unsupported expected.type: ${expected.type}` };
      }
      const expectedKey = expected.value;
      const pass = actual.key === expectedKey;
      return {
        pass,
        score: pass ? 1 : 0,
        reason: pass
          ? `key matched (${expectedKey})`
          : `expected ${expectedKey}, got ${actual.key}`,
      };
    },
  };
}
