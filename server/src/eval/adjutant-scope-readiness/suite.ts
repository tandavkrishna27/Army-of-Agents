/**
 * Adjutant scope-readiness eval suite (Phase F2, T10).
 *
 * Loads fixture threads and asks an LLM to make the same readiness call the
 * Adjutant makes at runtime: "wait" (keep observing), "ask-clarifying" (post
 * a question into the thread), or "propose-scope" (post a scope_proposal).
 *
 * We don't invoke the real Adjutant runtime because that touches the agent
 * runner, MCP bridge, DB, and adapter subprocess — none of which give a
 * useful signal for prompt regression. Instead the suite mirrors the
 * decision the Adjutant prompt is asking the model to make. Future prompt
 * changes should be reflected here (and in fixtures) so the suite stays
 * tied to the agent it audits.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalGrade, EvalSuite } from "../types.js";
import { loadFixtures } from "../fixture-loader.js";
import { gradeWithRubric, type LlmGraderConfig } from "../llm-grader.js";

const CLASSIFY_MODEL = "gpt-4o-mini";

const SYSTEM_PROMPT = `You are the Adjutant — the discuss-phase director for a thread of conversation in the AoA hybrid workforce OS. You read the thread's entries (human + agent) and decide one of three actions:

- "wait": there is nothing useful you can add right now. The humans are still exchanging ideas; staying quiet is the right call.
- "ask-clarifying": the conversation has enough momentum that a focused question would help converge faster. Something is ambiguous and you can name it.
- "propose-scope": the humans have converged. Goals, constraints, and intended outcome are clear enough that you can post a scope_proposal entry with a summary + 2-4 concrete tasks for the founder to approve.

Use these heuristics:
- Greetings/casual chat with no concrete subject → wait
- One short opener with no follow-ups → ask-clarifying
- Multi-turn thread where humans say "let's do X" or "sounds good, start with Y" → propose-scope
- Mixed signals (some clarity, some ambiguity) → ask-clarifying
- Phase != "discuss" → wait (you only act in discuss)
- No human entries since your last action → wait

Return JSON only.`;

/**
 * Thread phase values mirror the canonical DB enum at
 * `packages/db/src/schema/discussions.ts:65`. Keep these in sync — the
 * eval suite is an interpretation of production behavior, not a fantasy.
 */
export type AdjutantThreadPhase = "discuss" | "scope" | "assign" | "done";

export interface AdjutantThreadFixture {
  thread: {
    id: string;
    phase: AdjutantThreadPhase;
    intent?: string[];
    summaryText?: string | null;
    entries: Array<{
      id: string;
      rawContent: string;
      authorAgentId: string | null;
      createdBy: string | null;
    }>;
  };
}

export interface AdjutantClassification {
  category: "wait" | "ask-clarifying" | "propose-scope";
  reasoning: string;
}

export interface AdjutantSuiteConfig {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  fixturesDir?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildAdjutantScopeSuite(
  config: AdjutantSuiteConfig = {},
): Promise<EvalSuite<AdjutantThreadFixture, AdjutantClassification, AdjutantClassification>> {
  const fixturesDir = config.fixturesDir ?? join(__dirname, "fixtures");
  const cases = await loadFixtures<AdjutantThreadFixture, AdjutantClassification>(fixturesDir);
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const model = config.model ?? CLASSIFY_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const graderConfig: LlmGraderConfig = { apiKey, fetchImpl };

  return {
    name: "adjutant-scope-readiness",
    cases,
    concurrency: 5,
    async runOne(input) {
      if (!apiKey) {
        throw new Error("no OPENAI_API_KEY configured");
      }
      const userPrompt = renderThreadForClassification(input.thread);
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
        throw new Error(`Adjutant classifier fetch failed ${response.status}: ${body.slice(0, 200)}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("classifier returned empty content");
      const parsed = JSON.parse(content) as Partial<AdjutantClassification>;
      if (parsed.category !== "wait" && parsed.category !== "ask-clarifying" && parsed.category !== "propose-scope") {
        throw new Error(`classifier returned invalid category: ${String(parsed.category)}`);
      }
      return {
        category: parsed.category,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      };
    },
    async grade(actual, expected): Promise<EvalGrade> {
      if (expected.type === "exact") {
        const expectedCategory = (expected.value as AdjutantClassification).category;
        const pass = actual.category === expectedCategory;
        return {
          pass,
          score: pass ? 1 : 0,
          reason: pass
            ? `category matched (${expectedCategory})`
            : `expected ${expectedCategory}, got ${actual.category} — ${actual.reasoning}`,
        };
      }
      if (expected.type === "llm-graded") {
        return gradeWithRubric(
          actual,
          expected as { type: "llm-graded"; value: unknown; rubric?: string },
          graderConfig,
        );
      }
      // "contains" — expected.value must be a string[] of acceptable categories.
      // We narrow rather than substring-match a stringified blob so a value of
      // {other: "wait-and-see"} can't false-positive when actual.category="wait".
      const allowed = Array.isArray(expected.value)
        ? (expected.value as unknown[]).filter((v): v is string => typeof v === "string")
        : [];
      const pass = allowed.includes(actual.category);
      return {
        pass,
        score: pass ? 1 : 0,
        reason: pass
          ? `category ${actual.category} is in allowed set`
          : `expected one of [${allowed.join(", ")}], got ${actual.category}`,
      };
    },
  };
}

function renderThreadForClassification(thread: AdjutantThreadFixture["thread"]): string {
  const intent = (thread.intent ?? []).join(", ") || "(none)";
  const summary = thread.summaryText?.trim() || "(no summary yet)";
  const entryLines = thread.entries
    .map((e, i) => {
      const author = e.authorAgentId ? `agent:${e.authorAgentId}` : e.createdBy ? `user:${e.createdBy}` : "system";
      return `[${i + 1}] (${author}) ${e.rawContent}`;
    })
    .join("\n");
  return [
    `Thread phase: ${thread.phase}`,
    `Intent tags: ${intent}`,
    `Current summary: ${summary}`,
    "",
    "Entries (oldest first):",
    entryLines,
    "",
    `Return JSON: {"category": "wait"|"ask-clarifying"|"propose-scope", "reasoning": string (≤2 sentences)}`,
  ].join("\n");
}
