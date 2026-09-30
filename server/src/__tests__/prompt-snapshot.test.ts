/**
 * Unit tests for redactAndCapPrompt (prompt-snapshot.ts).
 *
 * Validates:
 *  - Secret patterns are stripped (API keys, bearer tokens, PEM blocks, etc.)
 *  - Prompt is capped at MAX_PROMPT_SNAPSHOT_CHARS with TRUNCATION_SUFFIX
 *  - Non-secret content is preserved
 *  - Edge cases: empty string, non-string input
 */

import { describe, expect, it } from "vitest";
import {
  redactAndCapPrompt,
  MAX_PROMPT_SNAPSHOT_CHARS,
  TRUNCATION_SUFFIX,
} from "../services/prompt-snapshot.js";

describe("redactAndCapPrompt", () => {
  describe("secret redaction", () => {
    it("strips Anthropic API key (sk-ant-…)", () => {
      const prompt =
        "You have access to ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop in your env.";
      const out = redactAndCapPrompt(prompt);
      expect(out).not.toContain("sk-ant-api03-abcdefghijklmnop");
      expect(out).toContain("[REDACTED");
    });

    it("strips OpenAI-style API key (sk-…)", () => {
      const prompt = "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx is set.";
      const out = redactAndCapPrompt(prompt);
      expect(out).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx");
    });

    it("strips Bearer token", () => {
      const prompt = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
      const out = redactAndCapPrompt(prompt);
      // The bearer token pattern fires first, then JWT may catch the remainder;
      // either way the original value must not appear.
      expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9.payload.sig");
    });

    it("strips GitHub PAT (ghp_…)", () => {
      const prompt =
        "Your GitHub token is ghp_abcdefghijklmnopqrstuvwxyz123456.";
      const out = redactAndCapPrompt(prompt);
      expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
      expect(out).toContain("[REDACTED_GITHUB_TOKEN]");
    });

    it("strips AWS access key (AKIA…)", () => {
      const prompt = "Use AWS key AKIAIOSFODNN7EXAMPLE for S3.";
      const out = redactAndCapPrompt(prompt);
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(out).toContain("[REDACTED_AWS_KEY]");
    });

    it("strips secret assignment pattern (api_key: value)", () => {
      const prompt = "Set api_key: mysupersecretkey123 before running.";
      const out = redactAndCapPrompt(prompt);
      expect(out).not.toContain("mysupersecretkey123");
      expect(out).toContain("[REDACTED]");
    });

    it("strips postgres connection string (DSN)", () => {
      const prompt =
        "DB_URL=postgres://user:pass@localhost:5432/mydb should not appear.";
      const out = redactAndCapPrompt(prompt);
      expect(out).not.toContain("user:pass@localhost:5432/mydb");
      expect(out).toContain("[REDACTED_CONNECTION_STRING]");
    });

    it("strips PEM block", () => {
      const pem =
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
      const prompt = `Use this key:\n${pem}\nEnd.`;
      const out = redactAndCapPrompt(prompt);
      expect(out).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
      expect(out).toContain("[REDACTED_PEM_BLOCK]");
    });

    it("preserves non-secret content unchanged", () => {
      const prompt =
        "You are a helpful agent. Your task is to write a report. Use the tools listed below.";
      const out = redactAndCapPrompt(prompt);
      expect(out).toBe(prompt);
    });
  });

  describe("length cap", () => {
    it("returns prompt unchanged when under the cap", () => {
      const short = "A".repeat(100);
      expect(redactAndCapPrompt(short)).toBe(short);
    });

    it("caps prompt at MAX_PROMPT_SNAPSHOT_CHARS and appends TRUNCATION_SUFFIX", () => {
      const long = "X".repeat(MAX_PROMPT_SNAPSHOT_CHARS + 500);
      const out = redactAndCapPrompt(long);
      expect(out.length).toBe(MAX_PROMPT_SNAPSHOT_CHARS);
      expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    });

    it("does not append suffix when exactly at the cap", () => {
      const exact = "Y".repeat(MAX_PROMPT_SNAPSHOT_CHARS);
      const out = redactAndCapPrompt(exact);
      // No truncation — fits exactly
      expect(out.length).toBe(MAX_PROMPT_SNAPSHOT_CHARS);
      expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(false);
    });

    it("cap applies AFTER redaction so replaced content counts toward length", () => {
      // Build a prompt that is over cap but contains a secret; after redaction
      // the replacement text changes character count. We just verify the output
      // is capped and the secret is gone.
      const secret = "sk-ant-api03-" + "a".repeat(40);
      const filler = "Z".repeat(MAX_PROMPT_SNAPSHOT_CHARS + 100);
      const prompt = `${filler} ${secret}`;
      const out = redactAndCapPrompt(prompt);
      expect(out.length).toBe(MAX_PROMPT_SNAPSHOT_CHARS);
      expect(out).not.toContain(secret);
    });
  });

  describe("edge cases", () => {
    it("returns empty string unchanged", () => {
      expect(redactAndCapPrompt("")).toBe("");
    });

    it("handles non-string input gracefully (returns as-is)", () => {
      // The function signature says string, but callers might pass anything.
      // Verify it does not throw.
      expect(() => redactAndCapPrompt(null as unknown as string)).not.toThrow();
      expect(() => redactAndCapPrompt(undefined as unknown as string)).not.toThrow();
    });

    it("preserves newlines and markdown structure in non-secret content", () => {
      const prompt = [
        "## Vision",
        "Build the best product.",
        "",
        "## Your Task",
        "Write a report on performance.",
        "",
        "- Use the read_file tool",
        "- Use the write_file tool",
      ].join("\n");
      const out = redactAndCapPrompt(prompt);
      expect(out).toBe(prompt);
    });
  });
});
