/**
 * Eval framework — shared LLM grader (Phase F2 utility, shared with F3 + F4).
 *
 * Grades arbitrary `actual` outputs against `expected.value` using a prose
 * rubric. Used by the Phase F suites whose "right answer" is a judgement
 * call rather than a literal match — e.g. "did the Adjutant propose a
 * reasonable scope?" or "did the Memory Keeper extract the right items?".
 *
 * Direct fetch() call (no openai SDK — matches the house pattern in
 * `services/embeddings.ts` and `services/extraction.ts`). The grader uses
 * `response_format: json_object` so the model returns strict JSON; we
 * tolerate parse failures and surface them as pass:false reasons rather
 * than throwing — a flaky grader shouldn't tank the whole suite.
 *
 * When `OPENAI_API_KEY` is absent we return a no-key sentinel result so
 * unit tests can run without secrets and CI can explicitly signal the gap.
 */
import type { EvalGrade } from "./types.js";

const GRADER_MODEL = "gpt-4o-mini";

export interface LlmGraderConfig {
  apiKey?: string;
  model?: string;
  /** Optional fetch impl for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Grade an `actual` result against `expected.value` using a prose rubric.
 * Returns pass:false with reason "no OPENAI_API_KEY configured" when the
 * environment can't reach OpenAI — this lets unit tests run without secrets
 * and CI signal the gap explicitly.
 *
 * The grader returns strict JSON {pass:boolean, score:0..1, reason:string}.
 */
export async function gradeWithRubric(
  actual: unknown,
  expected: { type: "llm-graded"; value: unknown; rubric?: string },
  config: LlmGraderConfig = {},
): Promise<EvalGrade> {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      pass: false,
      score: 0,
      reason: "no OPENAI_API_KEY configured (llm-graded skipped)",
    };
  }
  if (!expected.rubric) {
    return { pass: false, score: 0, reason: "llm-graded case missing rubric" };
  }

  const model = config.model ?? GRADER_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const prompt = [
    "You are a strict grader for an LLM eval suite. Apply the rubric exactly.",
    "Return JSON only.",
    "",
    `Rubric: ${expected.rubric}`,
    `Expected: ${JSON.stringify(expected.value)}`,
    `Actual:   ${JSON.stringify(actual)}`,
    "",
    `JSON shape: {"pass": boolean, "score": number (0..1), "reason": string}`,
  ].join("\n");

  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>");
    return {
      pass: false,
      score: 0,
      reason: `grader fetch failed ${response.status}: ${body.slice(0, 200)}`,
    };
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return { pass: false, score: 0, reason: "grader returned empty content" };
  }
  try {
    const parsed = JSON.parse(content) as Partial<EvalGrade>;
    return {
      pass: parsed.pass === true,
      score: typeof parsed.score === "number" ? parsed.score : 0,
      reason: typeof parsed.reason === "string" ? parsed.reason : "grader returned no reason",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { pass: false, score: 0, reason: `grader JSON parse failed: ${message}` };
  }
}
