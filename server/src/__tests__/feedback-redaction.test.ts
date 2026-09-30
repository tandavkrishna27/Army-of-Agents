import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  createFeedbackRedactionState,
  finalizeFeedbackRedactionSummary,
  sanitizeFeedbackText,
  sanitizeFeedbackValue,
  sha256Digest,
  stableStringify,
} from "../services/feedback-redaction.js";

describe("feedback-redaction: FREE_TEXT_PATTERNS", () => {
  it("redacts PEM blocks (pem_block)", () => {
    const state = createFeedbackRedactionState();
    const input =
      "prefix\n-----BEGIN RSA PRIVATE KEY-----\nabc\nxyz\n-----END RSA PRIVATE KEY-----\nsuffix";
    const output = sanitizeFeedbackText(input, state, "body", 1_000);
    expect(output).toContain("[REDACTED_PEM_BLOCK]");
    expect(output).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(state.counts.get("pem_block")).toBe(1);
    expect(state.redactedFields.has("body")).toBe(true);
  });

  it("redacts secret assignments (secret_assignment)", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      "config: api_key=supersecret1234 and password=hunter2",
      state,
      "body",
      1_000,
    );
    expect(output).not.toContain("supersecret1234");
    expect(output).not.toContain("hunter2");
    expect(output).toContain("[REDACTED]");
    expect((state.counts.get("secret_assignment") ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("redacts Bearer tokens (bearer_token)", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      "sent Bearer abcDEF123-456/789+xyz==",
      state,
      "body",
      1_000,
    );
    expect(output).toContain("Bearer [REDACTED_TOKEN]");
    expect(output).not.toContain("abcDEF123-456");
    expect((state.counts.get("bearer_token") ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("redacts GitHub tokens (github_token)", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      "my token is ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123",
      state,
      "body",
      1_000,
    );
    expect(output).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(output).not.toContain("ghp_AbCd");
    expect(state.counts.get("github_token")).toBe(1);
  });

  it("redacts provider API keys (provider_api_key)", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      "key1=sk-ant-abcdefghijklmnop and key2=sk-openai123456789",
      state,
      "body",
      1_000,
    );
    expect(output).toContain("[REDACTED_API_KEY]");
    expect(output).not.toContain("sk-ant-abcd");
    expect(output).not.toContain("sk-openai123");
    expect((state.counts.get("provider_api_key") ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("redacts JWTs (jwt)", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      "token: eyJhbGc.eyJzdWIi.SflKxwRJSM",
      state,
      "body",
      1_000,
    );
    expect(output).toContain("[REDACTED_JWT]");
    expect(output).not.toContain("eyJhbGc");
    expect(state.counts.get("jwt")).toBe(1);
  });

  it("redacts database/broker connection strings (dsn)", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      "connect to postgres://user:pw@host:5432/db and mongodb+srv://u:p@host/x",
      state,
      "body",
      1_000,
    );
    expect(output).toContain("[REDACTED_CONNECTION_STRING]");
    expect(output).not.toContain("postgres://user");
    expect(output).not.toContain("mongodb+srv://u:p");
    expect((state.counts.get("dsn") ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("redacts email addresses (email)", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      "contact alice@example.com or bob+tag@example.org",
      state,
      "body",
      1_000,
    );
    expect(output).toContain("[REDACTED_EMAIL]");
    expect(output).not.toContain("alice@example.com");
    expect(output).not.toContain("bob+tag@example.org");
    expect((state.counts.get("email") ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it("redacts phone numbers (phone)", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      "call +1 (555) 123-4567 or 5551234567",
      state,
      "body",
      1_000,
    );
    expect(output).toContain("[REDACTED_PHONE]");
    expect(output).not.toContain("555) 123-4567");
    expect((state.counts.get("phone") ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("feedback-redaction: current-user + structured secrets", () => {
  it("redacts current OS username via log-redaction (current_user)", () => {
    const username = os.userInfo().username;
    if (!username) return;
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(
      `hello ${username} welcome`,
      state,
      "body",
      1_000,
    );
    expect(output).not.toContain(username);
    expect((state.counts.get("current_user") ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("redacts structured secret fields inside nested records (structured_secret)", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackValue(
      { env: { OPENAI_API_KEY: "sk-top", safe: "ok" } },
      state,
      "payload",
      1_000,
    );
    expect(output).toEqual({
      env: { OPENAI_API_KEY: "***REDACTED***", safe: "ok" },
    });
    expect((state.counts.get("structured_secret") ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("feedback-redaction: truncation + recursion + passthroughs", () => {
  it("truncates strings exceeding maxLength and records the field", () => {
    const state = createFeedbackRedactionState();
    const longInput = "a".repeat(500);
    const output = sanitizeFeedbackText(longInput, state, "body", 200);
    // Paperclip pattern: slice(0, maxLength - 1) + "..." → maxLength - 1 + 3 = maxLength + 2
    expect(output.length).toBe(202);
    expect(output.endsWith("...")).toBe(true);
    expect(state.truncatedFields.has("body")).toBe(true);
  });

  it("recurses into arrays with indexed field paths", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackValue(
      ["alice@example.com", "not-an-email", "bob@example.com"],
      state,
      "emails",
      1_000,
    );
    expect(Array.isArray(output)).toBe(true);
    expect((output as string[])[0]).toContain("[REDACTED_EMAIL]");
    expect((output as string[])[2]).toContain("[REDACTED_EMAIL]");
    expect(state.redactedFields.has("emails[0]")).toBe(true);
    expect(state.redactedFields.has("emails[2]")).toBe(true);
  });

  it("recurses into nested records with dotted field paths", () => {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackValue(
      { user: { email: "alice@example.com", name: "Alice" } },
      state,
      "root",
      1_000,
    );
    const userOut = (output as { user: { email: string; name: string } }).user;
    expect(userOut.email).toContain("[REDACTED_EMAIL]");
    expect(userOut.name).toBe("Alice");
    expect(state.redactedFields.has("root.user.email")).toBe(true);
  });

  it("passes non-string, non-array, non-record values through unchanged", () => {
    const state = createFeedbackRedactionState();
    expect(sanitizeFeedbackValue(42, state, "n", 1_000)).toBe(42);
    expect(sanitizeFeedbackValue(true, state, "b", 1_000)).toBe(true);
    expect(sanitizeFeedbackValue(null, state, "x", 1_000)).toBe(null);
    expect(state.redactedFields.size).toBe(0);
  });

  it("is idempotent — redacting already-redacted content is stable", () => {
    const stateA = createFeedbackRedactionState();
    const once = sanitizeFeedbackText(
      "email alice@example.com token ghp_AbCdEfGhIjKlMnOpQrStUv0123",
      stateA,
      "body",
      1_000,
    );
    const stateB = createFeedbackRedactionState();
    const twice = sanitizeFeedbackText(once, stateB, "body", 1_000);
    expect(twice).toBe(once);
  });
});

describe("feedback-redaction: finalize + helpers", () => {
  it("finalizeFeedbackRedactionSummary sorts and counts by kind", () => {
    const state = createFeedbackRedactionState();
    sanitizeFeedbackText("x@y.co and a@b.co", state, "f1", 1_000);
    sanitizeFeedbackText("sk-ant-aaaaaaaaaaaaa", state, "f2", 1_000);
    const summary = finalizeFeedbackRedactionSummary(state);
    expect(summary.strategy).toBe("deterministic_feedback_v2");
    expect(Array.isArray(summary.redactedFields)).toBe(true);
    expect((summary.redactedFields as string[])).toEqual((summary.redactedFields as string[]).slice().sort());
    const counts = summary.counts as Record<string, number>;
    expect(counts.email).toBeGreaterThanOrEqual(2);
    expect(counts.provider_api_key).toBeGreaterThanOrEqual(1);
  });

  it("stableStringify sorts object keys for deterministic output", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: 1, b: [3, 2] })).toBe('{"a":1,"b":[3,2]}');
  });

  it("sha256Digest produces stable hex for equivalent structures", () => {
    const left = sha256Digest({ b: 1, a: [2, 3] });
    const right = sha256Digest({ a: [2, 3], b: 1 });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });
});
