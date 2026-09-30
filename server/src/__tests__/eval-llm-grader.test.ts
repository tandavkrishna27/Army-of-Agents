import { describe, expect, it, vi } from "vitest";
import { gradeWithRubric } from "../eval/llm-grader.js";

describe("gradeWithRubric", () => {
  it("returns no-key sentinel when apiKey is absent", async () => {
    // Make sure we don't accidentally fall through to process.env.
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const grade = await gradeWithRubric(
      { foo: "bar" },
      { type: "llm-graded", value: { foo: "bar" }, rubric: "match exactly" },
      { apiKey: "", fetchImpl },
    );
    expect(grade.pass).toBe(false);
    expect(grade.reason).toContain("no OPENAI_API_KEY configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns missing-rubric sentinel when rubric is absent", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const grade = await gradeWithRubric(
      { foo: "bar" },
      { type: "llm-graded", value: { foo: "bar" } },
      { apiKey: "sk-test", fetchImpl },
    );
    expect(grade.pass).toBe(false);
    expect(grade.reason).toContain("missing rubric");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls fetch with the correct shape when key + rubric are present", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ pass: true, score: 1, reason: "match" }) } }],
      }),
    }) as unknown as typeof fetch;

    await gradeWithRubric(
      { category: "wait" },
      { type: "llm-graded", value: { category: "wait" }, rubric: "should be wait" },
      { apiKey: "sk-test", fetchImpl, model: "gpt-4o-mini" },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    // The prompt should reference the rubric, expected, and actual values.
    expect(body.messages[0].content).toContain("should be wait");
    expect(body.messages[0].content).toContain('"category":"wait"');
  });

  it("parses JSON response and returns an EvalGrade", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ pass: true, score: 0.85, reason: "looks right" }),
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const grade = await gradeWithRubric(
      { category: "wait" },
      { type: "llm-graded", value: { category: "wait" }, rubric: "should be wait" },
      { apiKey: "sk-test", fetchImpl },
    );

    expect(grade).toEqual({ pass: true, score: 0.85, reason: "looks right" });
  });

  it("coerces missing/invalid grader fields to safe defaults", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({}) } }],
      }),
    }) as unknown as typeof fetch;

    const grade = await gradeWithRubric(
      { x: 1 },
      { type: "llm-graded", value: { x: 1 }, rubric: "match" },
      { apiKey: "sk-test", fetchImpl },
    );

    expect(grade.pass).toBe(false);
    expect(grade.score).toBe(0);
    expect(grade.reason).toBe("grader returned no reason");
  });

  it("returns pass:false with status code in reason when fetch returns non-ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    }) as unknown as typeof fetch;

    const grade = await gradeWithRubric(
      { x: 1 },
      { type: "llm-graded", value: { x: 1 }, rubric: "match" },
      { apiKey: "sk-test", fetchImpl },
    );

    expect(grade.pass).toBe(false);
    expect(grade.reason).toContain("429");
    expect(grade.reason).toContain("rate limited");
  });

  it("returns pass:false with empty-content reason when response has no content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null } }] }),
    }) as unknown as typeof fetch;

    const grade = await gradeWithRubric(
      { x: 1 },
      { type: "llm-graded", value: { x: 1 }, rubric: "match" },
      { apiKey: "sk-test", fetchImpl },
    );

    expect(grade.pass).toBe(false);
    expect(grade.reason).toContain("empty content");
  });

  it("returns pass:false with parse-failed reason when content is not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not-json{{" } }] }),
    }) as unknown as typeof fetch;

    const grade = await gradeWithRubric(
      { x: 1 },
      { type: "llm-graded", value: { x: 1 }, rubric: "match" },
      { apiKey: "sk-test", fetchImpl },
    );

    expect(grade.pass).toBe(false);
    expect(grade.reason).toContain("parse failed");
  });
});
