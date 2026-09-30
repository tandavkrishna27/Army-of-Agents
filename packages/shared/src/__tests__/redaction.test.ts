import { describe, it, expect } from "vitest";
import {
  SENSITIVE_ENV_KEY,
  SENSITIVE_ENV_VALUE_PATTERNS,
  looksLikeSecretValue,
  shouldRedactSecretValue,
  redactEnvForLogs,
} from "../redaction.js";
import * as sharedBarrel from "../index.js";

// ---------------------------------------------------------------------------
// Fixtures shared across the suites below.
// ---------------------------------------------------------------------------

// Key-name fragments that MUST trigger redaction regardless of value.
// One entry per fragment in the SENSITIVE_ENV_KEY alternation, plus case mix.
const SENSITIVE_KEY_CASES: Array<[string, string]> = [
  ["OPENAI_API_KEY", "key"],
  ["MY_TOKEN", "token"],
  ["MY_SECRET", "secret"],
  ["DB_PASSWORD", "password"],
  ["DB_PASSWD", "passwd"],
  ["AUTH_HEADER", "auth"],
  ["SESSION_COOKIE", "cookie"],
  ["X_CREDENTIAL", "credential"],
  ["API_BEARER", "bearer"],
  ["WEBHOOK_SIGNING", "signing"],
  ["FOO_WEBHOOK", "webhook"],
  ["NPM_CONFIG", "npm"],
  ["GH_PRIVATE", "private"],
  ["DB_CONNECTION", "connection"],
  // Case-insensitivity (regex is /…/i): lower-case fragment still matches.
  ["service_token", "token (lower-case)"],
];

// One secret-looking VALUE per value pattern, each under an INNOCUOUS key
// (key regex returns false) so the VALUE path — not the key path — is what
// forces redaction. The pattern index each case targets is noted.
const SECRET_VALUE_CASES: Array<[string, string, string]> = [
  // [innocuousKey, value, pattern]
  ["DATABASE_URL", "postgresql://user:s3cr3t@db.internal:5432/app", "p0 connection string (postgres)"],
  ["STORE", "mongodb+srv://u:p@cluster0.abc.mongodb.net/db", "p0 connection string (mongodb+srv)"],
  ["CACHE", "redis://:hunter2@cache:6379/0", "p0 connection string (redis)"],
  ["PROVIDER", "sk-ant-abcdefghijklmnop", "p1 sk-/sk-ant- provider key"],
  ["BILLING", "sk_live_abcdEFGH12345678", "p2 Stripe sk_live_"],
  ["CHECKOUT", "pk_test_abcdEFGH12345678", "p2 Stripe pk_test_"],
  ["DEPLOY_PAT", "ghp_abcdefghijklmnopqrstuvwxyz0123", "p3 GitHub ghp_"],
  ["VENDOR", "gho_abcdefghijklmnopqrstuvwxyz0123", "p3 GitHub gho_"],
  ["CLOUD", "AKIAIOSFODNN7EXAMPLE", "p4 AWS access key id"],
  ["SLACK", "xoxb-test-token-value", "p5 Slack token"],
  ["MESSENGER", "whsec_3f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c", "p6 generic prefix_<random> (whsec_)"],
  ["REGISTRY", "npm_abcdefghijklmnopqrstuvwxyz0123456789", "p6 generic prefix_<random> (npm_)"],
  [
    "JWT",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwfQ.dGhpc2lzYXNpZ25hdHVyZXZhbA",
    "p7 JWT (three base64url segments)",
  ],
  ["PEM_BLOB", "-----BEGIN RSA PRIVATE KEY-----", "p8 PEM private-key block"],
];

// Plain, non-secret values under innocuous keys → must NEVER be redacted.
const BENIGN_CASES: Array<[string, string]> = [
  ["AOA_API_URL", "http://localhost:3100"], // http (not a DSN scheme) → passthrough
  ["NODE_ENV", "production"],
  ["LOG_LEVEL", "info"],
  ["PORT", "8080"],
  ["REGION", "us-east-1"],
  ["NODE_VERSION", "v24.14.0"],
  ["AOA_AGENT_ID", "ff55fc57-b5e2-4b15-90fd-2fc97605e5d5"], // UUID is not JWT-shaped
];

describe("SENSITIVE_ENV_KEY", () => {
  it.each(SENSITIVE_KEY_CASES)("matches %s (fragment: %s)", (key) => {
    expect(SENSITIVE_ENV_KEY.test(key)).toBe(true);
  });
  it.each(BENIGN_CASES.map(([k]) => [k]))("does not match benign key %s", (key) => {
    expect(SENSITIVE_ENV_KEY.test(key)).toBe(false);
  });
  it("does not match the innocuous keys used by the value-shape cases", () => {
    // Guards the H4 contract: each value-shape case must exercise the VALUE
    // path, so its key must NOT short-circuit via the key regex.
    for (const [key] of SECRET_VALUE_CASES) {
      expect(SENSITIVE_ENV_KEY.test(key)).toBe(false);
    }
  });
});

describe("SENSITIVE_ENV_VALUE_PATTERNS", () => {
  it("has exactly nine patterns", () => {
    expect(SENSITIVE_ENV_VALUE_PATTERNS).toHaveLength(9);
  });
  it("each entry is a RegExp", () => {
    for (const re of SENSITIVE_ENV_VALUE_PATTERNS) {
      expect(re).toBeInstanceOf(RegExp);
    }
  });
});

describe("looksLikeSecretValue", () => {
  it.each(SECRET_VALUE_CASES)("flags the %s value (%s)", (_key, value) => {
    expect(looksLikeSecretValue(value)).toBe(true);
  });
  it.each(BENIGN_CASES)("ignores the benign value of %s (%s)", (_key, value) => {
    expect(looksLikeSecretValue(value)).toBe(false);
  });
});

describe("shouldRedactSecretValue", () => {
  // Key-name path: true regardless of the (string) value.
  it.each(SENSITIVE_KEY_CASES)("redacts by sensitive key %s (fragment: %s)", (key) => {
    expect(shouldRedactSecretValue(key, "x")).toBe(true);
  });
  // Value-shape path: innocuous key, secret-looking string value → true.
  it.each(SECRET_VALUE_CASES)("redacts by value shape under innocuous key %s (%s)", (key, value) => {
    expect(shouldRedactSecretValue(key, value)).toBe(true);
  });
  // Negative: innocuous key + plain value → false.
  it.each(BENIGN_CASES)("does not redact benign %s=%s", (key, value) => {
    expect(shouldRedactSecretValue(key, value)).toBe(false);
  });
  // Non-string values under a benign key are not redacted here (callers
  // handle secret_ref objects upstream); a sensitive key still wins.
  it("ignores non-string values when the key is benign", () => {
    expect(shouldRedactSecretValue("PORT", 8080)).toBe(false);
    expect(shouldRedactSecretValue("PORT", true)).toBe(false);
    expect(shouldRedactSecretValue("PORT", null)).toBe(false);
    expect(shouldRedactSecretValue("PORT", undefined)).toBe(false);
    expect(shouldRedactSecretValue("PORT", { type: "secret_ref" })).toBe(false);
  });
  it("redacts a sensitive key even when the value is a non-string", () => {
    expect(shouldRedactSecretValue("API_KEY", 8080)).toBe(true);
    expect(shouldRedactSecretValue("API_KEY", { type: "secret_ref" })).toBe(true);
  });
});

describe("redactEnvForLogs", () => {
  it("redacts every sensitive-key entry to ***REDACTED***", () => {
    const env = Object.fromEntries(SENSITIVE_KEY_CASES.map(([k]) => [k, "irrelevant-value"]));
    const out = redactEnvForLogs(env);
    for (const [k] of SENSITIVE_KEY_CASES) {
      expect(out[k]).toBe("***REDACTED***");
    }
  });
  it("redacts every secret-looking VALUE under an innocuous key", () => {
    const env = Object.fromEntries(SECRET_VALUE_CASES.map(([k, v]) => [k, v]));
    const out = redactEnvForLogs(env);
    for (const [k] of SECRET_VALUE_CASES) {
      expect(out[k]).toBe("***REDACTED***");
    }
  });
  it("preserves benign values byte-for-byte (incl. the http:// API URL)", () => {
    const env = Object.fromEntries(BENIGN_CASES.map(([k, v]) => [k, v]));
    const out = redactEnvForLogs(env);
    for (const [k, v] of BENIGN_CASES) {
      expect(out[k]).toBe(v);
    }
  });
  it("handles an empty env object", () => {
    expect(redactEnvForLogs({})).toEqual({});
  });
  it("redacts a mixed env in a single pass, leaving benign keys untouched", () => {
    const out = redactEnvForLogs({
      OPENAI_API_KEY: "sk-whatever", // sensitive key
      DATABASE_URL: "postgresql://user:s3cr3t@db.internal:5432/app", // sensitive value
      NODE_ENV: "production", // benign
      AOA_API_URL: "http://localhost:3100", // benign
    });
    expect(out.OPENAI_API_KEY).toBe("***REDACTED***");
    expect(out.DATABASE_URL).toBe("***REDACTED***");
    expect(out.NODE_ENV).toBe("production");
    expect(out.AOA_API_URL).toBe("http://localhost:3100");
  });
});

describe("shared barrel re-export", () => {
  it("exposes the redaction members from the package root", () => {
    expect(typeof sharedBarrel.redactEnvForLogs).toBe("function");
    expect(typeof sharedBarrel.looksLikeSecretValue).toBe("function");
    expect(typeof sharedBarrel.shouldRedactSecretValue).toBe("function");
    expect(sharedBarrel.SENSITIVE_ENV_KEY).toBeInstanceOf(RegExp);
    expect(Array.isArray(sharedBarrel.SENSITIVE_ENV_VALUE_PATTERNS)).toBe(true);
  });
});
