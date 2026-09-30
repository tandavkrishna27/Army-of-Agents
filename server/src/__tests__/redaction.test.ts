import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, redactEventPayload, sanitizeRecord } from "../redaction.js";

describe("redaction", () => {
  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        AOA_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      AOA_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const input = {
      session: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("H4: redacts secret VALUES bound to innocuous key names", () => {
    const input = {
      env: {
        DATABASE_URL: "postgresql://user:s3cr3t@db.internal:5432/app",
        STRIPE_LIVE: "sk_live_abcdEFGH12345678",
        GITHUB_PAT: "ghp_abcdefghijklmnopqrstuvwxyz0123",
        NODE_ENV: "production",
        AOA_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input) as { env: Record<string, string> };

    // Secret-looking values are redacted even though the key names don't match
    // the sensitive-key regex.
    expect(result.env.DATABASE_URL).toBe(REDACTED_EVENT_VALUE);
    expect(result.env.STRIPE_LIVE).toBe(REDACTED_EVENT_VALUE);
    expect(result.env.GITHUB_PAT).toBe(REDACTED_EVENT_VALUE);
    // Non-secret values (and the http:// API URL, which is not a DSN scheme) stay.
    expect(result.env.NODE_ENV).toBe("production");
    expect(result.env.AOA_API_URL).toBe("http://localhost:3100");
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });
});
