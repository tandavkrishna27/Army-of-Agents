import { describe, expect, it } from "vitest";
import {
  redactSensitiveBodyFields,
  SENSITIVE_KEY_PATTERNS,
} from "../middleware/redact-sensitive.js";

describe("SENSITIVE_KEY_PATTERNS", () => {
  it("is a non-empty array of regex patterns", () => {
    expect(Array.isArray(SENSITIVE_KEY_PATTERNS)).toBe(true);
    expect(SENSITIVE_KEY_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of SENSITIVE_KEY_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});

describe("redactSensitiveBodyFields", () => {
  it("returns non-object bodies as-is", () => {
    expect(redactSensitiveBodyFields(undefined)).toBe(undefined);
    expect(redactSensitiveBodyFields(null)).toBe(null);
    expect(redactSensitiveBodyFields("hello")).toBe("hello");
    expect(redactSensitiveBodyFields(42)).toBe(42);
    expect(redactSensitiveBodyFields(true)).toBe(true);
  });

  it("returns empty objects/arrays unchanged", () => {
    expect(redactSensitiveBodyFields({})).toEqual({});
    expect(redactSensitiveBodyFields([])).toEqual([]);
  });

  it("redacts top-level password field", () => {
    const result = redactSensitiveBodyFields({ password: "supersecret" });
    expect(result).toEqual({ password: "[REDACTED]" });
  });

  it("redacts the whole 'secrets' key (covers nested secrets[i].value implicitly)", () => {
    const result = redactSensitiveBodyFields({
      secrets: [{ name: "db", value: "actual-db-password" }],
    });
    // Whole-redact is strictly safer: even the 'name' field can't leak.
    expect(result).toEqual({ secrets: "[REDACTED]" });
  });

  it("redacts nested credential payloads where parent itself is not sensitive", () => {
    const result = redactSensitiveBodyFields({
      payload: {
        user: "alice",
        password: "x",
        nestedToken: { token: "y" },
      },
    });
    expect(result).toEqual({
      payload: {
        user: "alice",
        password: "[REDACTED]",
        nestedToken: { token: "[REDACTED]" },
      },
    });
  });

  it("preserves non-sensitive keys while redacting sensitive ones (mixed types)", () => {
    const result = redactSensitiveBodyFields({
      user: "alice",
      password: "x",
      profile: { token: "y", name: "Alice" },
    });
    expect(result).toEqual({
      user: "alice",
      password: "[REDACTED]",
      profile: { token: "[REDACTED]", name: "Alice" },
    });
  });

  it("is case-insensitive (Password, PASSWORD, pAsSwOrD)", () => {
    const result = redactSensitiveBodyFields({
      Password: "a",
      PASSWORD: "b",
      pAsSwOrD: "c",
    });
    expect(result).toEqual({
      Password: "[REDACTED]",
      PASSWORD: "[REDACTED]",
      pAsSwOrD: "[REDACTED]",
    });
  });

  it("handles top-level arrays of objects", () => {
    const result = redactSensitiveBodyFields([
      { password: "p1" },
      { token: "t1" },
      { user: "u1" },
    ]);
    expect(result).toEqual([
      { password: "[REDACTED]" },
      { token: "[REDACTED]" },
      { user: "u1" },
    ]);
  });

  it("redacts canonical sensitive keys: pat, secret, secrets, token, apiKey, api_key", () => {
    const result = redactSensitiveBodyFields({
      pat: "ghp_xxx",
      secret: "s",
      secrets: "ss",
      token: "t",
      apiKey: "k",
      api_key: "k2",
    });
    expect(result).toEqual({
      pat: "[REDACTED]",
      secret: "[REDACTED]",
      secrets: "[REDACTED]",
      token: "[REDACTED]",
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
    });
  });

  it("redacts pat_value, private_key, client_secret, refresh_token, access_token, bearer, authorization", () => {
    const result = redactSensitiveBodyFields({
      pat_value: "v1",
      private_key: "v2",
      client_secret: "v3",
      refresh_token: "v4",
      access_token: "v5",
      bearer: "v6",
      authorization: "v7",
    });
    expect(result).toEqual({
      pat_value: "[REDACTED]",
      private_key: "[REDACTED]",
      client_secret: "[REDACTED]",
      refresh_token: "[REDACTED]",
      access_token: "[REDACTED]",
      bearer: "[REDACTED]",
      authorization: "[REDACTED]",
    });
  });

  it("returns '[redacted: depth exceeded]' when nesting goes 9 levels deep", () => {
    // Build a 9-deep object
    let deep: any = { value: "leaf" };
    for (let i = 0; i < 9; i++) {
      deep = { nested: deep };
    }
    const result = redactSensitiveBodyFields(deep) as any;

    // Walk down 8 levels — at level 8 we should hit the depth marker.
    let cursor: any = result;
    for (let i = 0; i < 8; i++) {
      expect(typeof cursor).toBe("object");
      cursor = cursor.nested;
    }
    expect(cursor).toBe("[redacted: depth exceeded]");
  });

  it("truncates arrays longer than 100 items with a marker", () => {
    const longArray = Array.from({ length: 150 }, (_, i) => ({ idx: i }));
    const result = redactSensitiveBodyFields(longArray) as unknown[];

    expect(result.length).toBe(101);
    expect(result[0]).toEqual({ idx: 0 });
    expect(result[99]).toEqual({ idx: 99 });
    expect(result[100]).toBe("[redacted: 50 more array items truncated]");
  });

  it("does not mutate the input object", () => {
    const input = { password: "x", profile: { token: "y" } };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactSensitiveBodyFields(input);
    expect(input).toEqual(snapshot);
  });

  it("redacts within deeply nested arrays", () => {
    const result = redactSensitiveBodyFields({
      items: [
        { name: "a", password: "p1" },
        { name: "b", token: "t1" },
      ],
    });
    expect(result).toEqual({
      items: [
        { name: "a", password: "[REDACTED]" },
        { name: "b", token: "[REDACTED]" },
      ],
    });
  });
});
