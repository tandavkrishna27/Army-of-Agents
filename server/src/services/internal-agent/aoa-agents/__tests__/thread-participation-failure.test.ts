/**
 * thread-participation-failure — unit tests (Phase 1 / Unit E).
 *
 * Tests for `mapRunFailureToFriendlyReason`, the pure function that maps a
 * raw AoaRunResult.errorMessage to a user-safe, secret-redacted string for
 * structured error-level logging in `thread-participation-runner.ts`.
 *
 * TDD: these tests were written BEFORE the implementation (red → green cycle).
 */

import { describe, it, expect } from "vitest";
import { mapRunFailureToFriendlyReason } from "../thread-participation-failure.js";

describe("mapRunFailureToFriendlyReason", () => {
  // ── Auth class ────────────────────────────────────────────────────────────

  it("auth: 'not logged in' → auth message", () => {
    const result = mapRunFailureToFriendlyReason("not logged in: please run `claude login`");
    expect(result).toMatch(/provider.*isn't authenticated|api key/i);
    expect(result).not.toMatch(/please run/i);
  });

  it("auth: 'login required' → auth message", () => {
    const result = mapRunFailureToFriendlyReason("login required");
    expect(result).toMatch(/provider.*isn't authenticated|api key/i);
  });

  it("auth: 'unauthorized' → auth message", () => {
    const result = mapRunFailureToFriendlyReason("Unauthorized access denied");
    expect(result).toMatch(/provider.*isn't authenticated|api key/i);
  });

  it("auth: 'authentication' keyword → auth message", () => {
    const result = mapRunFailureToFriendlyReason("authentication failed with 403");
    expect(result).toMatch(/provider.*isn't authenticated|api key/i);
  });

  it("auth: 'api_key' pattern → auth message", () => {
    const result = mapRunFailureToFriendlyReason("Invalid api_key supplied");
    expect(result).toMatch(/provider.*isn't authenticated|api key/i);
  });

  it("auth: 'api key' (spaced) → auth message", () => {
    const result = mapRunFailureToFriendlyReason("missing api key in header");
    expect(result).toMatch(/provider.*isn't authenticated|api key/i);
  });

  it("auth: '401' status in message → auth message", () => {
    const result = mapRunFailureToFriendlyReason("request failed with status 401");
    expect(result).toMatch(/provider.*isn't authenticated|api key/i);
  });

  // ── Model class ───────────────────────────────────────────────────────────

  it("model: 'model not supported' → model message", () => {
    const result = mapRunFailureToFriendlyReason("model not supported: claude-next-alpha");
    expect(result).toMatch(/model.*isn't available|model.*not available/i);
  });

  it("model: 'model not found' → model message", () => {
    const result = mapRunFailureToFriendlyReason("The model gpt-99 was not found");
    expect(result).toMatch(/model.*isn't available|model.*not available/i);
  });

  it("model: 'model invalid' → model message", () => {
    const result = mapRunFailureToFriendlyReason("model invalid for this provider");
    expect(result).toMatch(/model.*isn't available|model.*not available/i);
  });

  it("model: 'model' + '400' → model message", () => {
    const result = mapRunFailureToFriendlyReason("400 Bad Request: no such model");
    expect(result).toMatch(/model.*isn't available|model.*not available/i);
  });

  it("model: 'model unavailable' → model message", () => {
    const result = mapRunFailureToFriendlyReason("the requested model is unavailable right now");
    expect(result).toMatch(/model.*isn't available|model.*not available/i);
  });

  it("model: 'not available' two-word phrase → model message (Gemini/OpenAI/Claude region errors)", () => {
    const result = mapRunFailureToFriendlyReason("The model gemini-2.0-flash is not available in your region");
    expect(result).toMatch(/model.*isn't available|model.*not available/i);
  });

  // ── CLI-missing class ─────────────────────────────────────────────────────

  it("cli: 'command not found' → cli message", () => {
    const result = mapRunFailureToFriendlyReason("command not found: claude");
    expect(result).toMatch(/cli.*isn't installed|runtime.*isn't installed/i);
  });

  it("cli: 'ENOENT' → cli message", () => {
    const result = mapRunFailureToFriendlyReason("spawn ENOENT: no such file");
    expect(result).toMatch(/cli.*isn't installed|runtime.*isn't installed/i);
  });

  it("cli: 'not installed' → cli message", () => {
    const result = mapRunFailureToFriendlyReason("claude is not installed on this system");
    expect(result).toMatch(/cli.*isn't installed|runtime.*isn't installed/i);
  });

  it("cli: 'is not executable' → cli message", () => {
    const result = mapRunFailureToFriendlyReason("/usr/local/bin/codex is not executable");
    expect(result).toMatch(/cli.*isn't installed|runtime.*isn't installed/i);
  });

  // ── Generic fallback ──────────────────────────────────────────────────────

  it("unknown: generic error → generic message", () => {
    const result = mapRunFailureToFriendlyReason("some unexpected internal error at line 42");
    expect(result).toMatch(/did not complete successfully/i);
  });

  it("unknown: null → generic message", () => {
    const result = mapRunFailureToFriendlyReason(null);
    expect(result).toMatch(/did not complete successfully/i);
  });

  it("unknown: undefined → generic message", () => {
    const result = mapRunFailureToFriendlyReason(undefined);
    expect(result).toMatch(/did not complete successfully/i);
  });

  it("unknown: empty string → generic message", () => {
    const result = mapRunFailureToFriendlyReason("");
    expect(result).toMatch(/did not complete successfully/i);
  });

  // ── Secret redaction ──────────────────────────────────────────────────────

  it("redaction: an sk-ant-... token embedded in the error is NOT present in the output", () => {
    const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const errorMessage = `Invalid api key: ${secret} is not valid`;
    const result = mapRunFailureToFriendlyReason(errorMessage);
    // The friendly message must not echo back the planted secret
    expect(result).not.toContain(secret);
    expect(result).not.toContain("sk-ant-");
  });

  it("redaction: a generic vendor key in a model error message is NOT present in output", () => {
    const secret = "npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567";
    const errorMessage = `model not found, key=${secret}`;
    const result = mapRunFailureToFriendlyReason(errorMessage);
    expect(result).not.toContain(secret);
    expect(result).not.toContain("npm_");
  });

  // ── Return type ───────────────────────────────────────────────────────────

  it("always returns a non-empty string", () => {
    for (const input of [null, undefined, "", "401 auth fail", "command not found", "model invalid", "random"]) {
      const result = mapRunFailureToFriendlyReason(input);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    }
  });
});
