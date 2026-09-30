import { describe, expect, it, vi } from "vitest";
import {
  buildSystemPrompt,
  buildUserMessage,
  estimateCostUsd,
  mapErrorToResult,
  resolveApiKey,
} from "../adapters/api-common.js";

describe("buildSystemPrompt", () => {
  it("includes company name and description", () => {
    const prompt = buildSystemPrompt({
      company: { name: "Acme Corp", description: "We build rockets" },
    });
    expect(prompt).toContain("Acme Corp");
    expect(prompt).toContain("We build rockets");
  });

  it("includes memory items", () => {
    const prompt = buildSystemPrompt({
      company: { name: "Test" },
      memory: [
        { title: "Code style", content: "Use TypeScript strict mode", category: "preference" },
        { title: "Stack", content: "React + Hono", category: "reference" },
      ],
    });
    expect(prompt).toContain("Code style");
    expect(prompt).toContain("Use TypeScript strict mode");
    expect(prompt).toContain("Stack");
  });

  it("handles missing company gracefully", () => {
    const prompt = buildSystemPrompt({});
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("handles empty memory array", () => {
    const prompt = buildSystemPrompt({
      company: { name: "Test" },
      memory: [],
    });
    expect(prompt).toContain("Test");
    expect(prompt).not.toContain("Memory");
  });
});

describe("buildUserMessage", () => {
  it("includes task title and description", () => {
    const ctx = {
      issueTitle: "Write a blog post",
      issueDescription: "About our new product launch",
    };
    const msg = buildUserMessage(ctx);
    expect(msg).toContain("Write a blog post");
    expect(msg).toContain("About our new product launch");
  });

  it("includes dependency outputs", () => {
    const ctx = {
      issueTitle: "Review spec",
      dependency_outputs: [
        { taskTitle: "Write spec", taskDescription: "Product spec for V2", status: "done" },
      ],
    };
    const msg = buildUserMessage(ctx);
    expect(msg).toContain("Write spec");
    expect(msg).toContain("Product spec for V2");
  });

  it("handles missing fields gracefully", () => {
    const msg = buildUserMessage({});
    expect(typeof msg).toBe("string");
  });
});

describe("estimateCostUsd", () => {
  it("calculates cost for known Claude model", () => {
    // claude-sonnet-4-6: $3/1M input, $15/1M output
    const cost = estimateCostUsd("anthropic", "claude-sonnet-4-6", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18.0, 1);
  });

  it("calculates cost for known OpenAI model", () => {
    // gpt-4o: $2.50/1M input, $10/1M output
    const cost = estimateCostUsd("openai", "gpt-4o", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(12.5, 1);
  });

  it("returns 0 for unknown model", () => {
    const cost = estimateCostUsd("anthropic", "future-model-9000", 1000, 500);
    expect(cost).toBe(0);
  });
});

describe("resolveApiKey", () => {
  it("resolves key using provided resolver function", async () => {
    const mockResolver = vi.fn().mockResolvedValue("sk-test-key");
    const key = await resolveApiKey("company-1", "anthropic", mockResolver);
    expect(key).toBe("sk-test-key");
    expect(mockResolver).toHaveBeenCalledWith("company-1", "llm:anthropic");
  });

  it("throws for unknown provider", async () => {
    await expect(resolveApiKey("company-1", "unknown_provider")).rejects.toThrow(
      "Unknown LLM provider",
    );
  });

  it("wraps not-found errors with helpful message", async () => {
    const mockResolver = vi.fn().mockRejectedValue(
      Object.assign(new Error("Secret not found: llm:anthropic"), { statusCode: 404 }),
    );
    await expect(resolveApiKey("company-1", "anthropic", mockResolver)).rejects.toThrow(
      "Configure your Anthropic API key",
    );
  });
});

describe("mapErrorToResult", () => {
  it("maps missing API key error", () => {
    const err = new Error("Configure your Anthropic API key in Settings > LLM Providers");
    (err as any).errorCode = "missing_api_key";
    const result = mapErrorToResult(err, "anthropic");
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("missing_api_key");
    expect(result.errorMessage).toContain("API key");
  });

  it("maps 'Invalid API key' messages to authentication_error", () => {
    const err = new Error("Invalid Anthropic API key provided");
    const result = mapErrorToResult(err, "anthropic");
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("authentication_error");
    expect(result.errorMessage).toContain("Invalid API key");
  });

  it("maps 'invalid api key' messages case-insensitively", () => {
    const err = new Error("Error: invalid api key format");
    const result = mapErrorToResult(err, "openai");
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("authentication_error");
  });

  it("maps unknown errors", () => {
    const result = mapErrorToResult(new Error("something weird"), "openai");
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("unknown_error");
  });
});
