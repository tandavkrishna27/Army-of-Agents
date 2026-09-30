/**
 * Planner plan-completeness eval suite (Phase F4, T10).
 *
 * Loads fixture scope_proposals and asks an LLM to make the same decision the
 * Planner agent makes at runtime: translate a scope_proposal into the markdown
 * plan that the Dispatcher will turn into concrete tasks. The plan is a
 * document-type artifact in production (`create_artifact`) — we drop the
 * artifact wrapping for evals and grade the markdown directly.
 *
 * We don't invoke the real Planner runtime because that touches the agent
 * runner, MCP bridge, DB, and the artifact storage path — none of which
 * produces a useful signal for prompt regression. Instead the suite mirrors
 * the decision the Planner prompt is asking the model to make: given a
 * scope_proposal (summary + proposed tasks + available agents), emit the
 * plan markdown. Future prompt changes should be reflected here (and in
 * fixtures) so the suite stays tied to the agent it audits.
 *
 * Three grade modes:
 *   - exact:    literal markdown match — almost never used for prose output
 *   - contains: every substring in expected.value MUST appear in the markdown
 *   - llm-graded: prose rubric judged by gpt-4o-mini (the F2/F3 pattern)
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalGrade, EvalSuite } from "../types.js";
import { loadFixtures } from "../fixture-loader.js";
import { gradeWithRubric, type LlmGraderConfig } from "../llm-grader.js";

const PLANNER_MODEL = "gpt-4o-mini";

const PLANNER_SYSTEM_PROMPT = `You are the Planner — translate a scope_proposal into an actionable markdown plan that the Dispatcher will turn into tasks.

Input you receive: a scope_proposal entry with a summary, proposed tasks (each with optional acceptance criteria), and a list of available agents you can suggest as assignees.

Output requirements — the markdown MUST include:
1. A short "Goal" line restating the scope summary in one sentence.
2. A "Tasks" section. Every proposed task from the scope_proposal MUST appear — do not drop, merge, or invent tasks. For each task:
   - Task title as an H3 (### N. <title>)
   - "Depends on:" line listing prior task numbers (e.g. "Depends on: 1, 2") or "Depends on: none"
   - "Acceptance criteria:" bullet list (copy what the scope provides, fill gaps with sensible defaults if any task lacks them)
   - "Suggested assignee:" line picking ONE agent from the available list
3. A "Sequencing" section: a one-paragraph summary of execution order (which tasks block which, parallelisable batches).

Heuristics:
- Implementation tasks before their test tasks ("implement X" before "test X").
- Research/scout tasks first when downstream tasks need their findings.
- Choose assignees by function: Engineer for build, Scout for research, Memory Keeper for extraction, etc.
- If a task is self-contained, "Depends on: none".

Return the markdown plan ONLY. No JSON, no preamble, no postamble.`;

/**
 * Fixture input shape. Each fixture is one synthetic scope_proposal — a
 * summary, an ordered list of proposed tasks (each with optional acceptance
 * criteria), and the available agents the Planner can pick from.
 */
export interface PlannerFixtureInput {
  scope: {
    threadId: string;
    summary: string;
    proposedTasks: Array<{
      title: string;
      acceptanceCriteria?: string[];
    }>;
    availableAgents: string[];
  };
}

export interface PlannerSuiteConfig {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  fixturesDir?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildPlannerSuite(
  config: PlannerSuiteConfig = {},
): Promise<EvalSuite<PlannerFixtureInput, string, unknown>> {
  const fixturesDir = config.fixturesDir ?? join(__dirname, "fixtures");
  const cases = await loadFixtures<PlannerFixtureInput, unknown>(fixturesDir);
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const model = config.model ?? PLANNER_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const graderConfig: LlmGraderConfig = { apiKey, fetchImpl };

  return {
    name: "planner-plan-completeness",
    cases,
    concurrency: 5,
    async runOne(input) {
      if (!apiKey) {
        throw new Error("no OPENAI_API_KEY configured");
      }
      const userPrompt = renderScopeForPlanner(input.scope);
      const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: PLANNER_SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          // The Planner emits markdown, NOT JSON — no response_format envelope.
          temperature: 0,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "<no body>");
        throw new Error(`Planner fetch failed ${response.status}: ${body.slice(0, 200)}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("planner returned empty content");
      return stripPlanPreamble(content);
    },
    async grade(actual, expected): Promise<EvalGrade> {
      if (expected.type === "exact") {
        const pass = typeof expected.value === "string" && actual === expected.value;
        return {
          pass,
          score: pass ? 1 : 0,
          reason: pass
            ? "markdown matched exactly"
            : `exact match failed (actual ${actual.length} chars)`,
        };
      }
      if (expected.type === "llm-graded") {
        return gradeWithRubric(
          actual,
          expected as { type: "llm-graded"; value: unknown; rubric?: string },
          graderConfig,
        );
      }
      // "contains" — expected.value MUST be string[] of substrings that all
      // need to appear in the markdown. Order-agnostic; CASE-INSENSITIVE so
      // "Depends on: None" still matches "Depends on: none" — the structural
      // contract lives in the prompt but humans/models occasionally drift
      // capitalization. Reject non-array shapes defensively (F2/F3 parity).
      const needles = Array.isArray(expected.value)
        ? (expected.value as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      if (needles.length === 0) {
        return {
          pass: false,
          score: 0,
          reason: "contains grading requires expected.value: string[]",
        };
      }
      const haystack = actual.toLowerCase();
      const missing = needles.filter((n) => !haystack.includes(n.toLowerCase()));
      const pass = missing.length === 0;
      return {
        pass,
        score: pass ? 1 : 0,
        reason: pass
          ? `all expected substrings present (${needles.length} total)`
          : `missing substrings: [${missing.map((m) => JSON.stringify(m)).join(", ")}]`,
      };
    },
  };
}

/**
 * Strip common chat-style preamble/postamble that gpt-4o-mini occasionally
 * adds despite the "Markdown only" instruction. We slice from the first
 * structural anchor (Goal: line, or a heading) and trim trailing
 * conversational fluff. Idempotent — clean input passes through unchanged.
 */
export function stripPlanPreamble(raw: string): string {
  // 1. Strip a leading code fence ```markdown ... ``` if present.
  const fenceMatch = raw.match(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) {
    return stripPlanPreamble(fenceMatch[1]);
  }

  // 2. Slice from the first structural anchor onwards. The prompt mandates
  //    "Goal:" leading line; fall back to the first heading if it's absent.
  const anchorIdx = (() => {
    const candidates = [/(^|\n)\s*Goal:/i, /(^|\n)\s*#{1,3}\s+/];
    let best = -1;
    for (const re of candidates) {
      const m = raw.match(re);
      if (m && m.index !== undefined && (best === -1 || m.index < best)) {
        best = m.index + (m[0].startsWith("\n") ? 1 : 0);
      }
    }
    return best;
  })();
  const sliced = anchorIdx >= 0 ? raw.slice(anchorIdx) : raw;

  // 3. Trim conversational trailing fluff after the last structural section.
  //    Look for "Let me know" / "Hope this helps" / "Feel free" style sign-offs
  //    on their own line and drop everything from there onwards.
  const tailDrop = sliced.match(
    /\n+(?:Let me know|Hope this|Feel free|Happy to|Anything else)[^\n]*$/i,
  );
  const trimmed = tailDrop && tailDrop.index !== undefined
    ? sliced.slice(0, tailDrop.index)
    : sliced;

  return trimmed.trim();
}

function renderScopeForPlanner(scope: PlannerFixtureInput["scope"]): string {
  const taskLines = scope.proposedTasks
    .map((t, i) => {
      const criteria = (t.acceptanceCriteria ?? []).length
        ? (t.acceptanceCriteria ?? []).map((c) => `    - ${c}`).join("\n")
        : "    (none provided — invent reasonable defaults)";
      return `${i + 1}. ${t.title}\n  Acceptance criteria:\n${criteria}`;
    })
    .join("\n");
  const agents = scope.availableAgents.join(", ") || "(no agents available)";
  return [
    `Scope summary: ${scope.summary}`,
    "",
    "Proposed tasks (in author-supplied order — keep them all):",
    taskLines,
    "",
    `Available agents: ${agents}`,
    "",
    "Emit the markdown plan now. Markdown only — no JSON envelope.",
  ].join("\n");
}
