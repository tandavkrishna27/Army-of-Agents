import { describe, it, expect } from "vitest";
import {
  shouldRedactSecretValue,
  redactEnvValue,
  formatEnvForDisplay,
} from "../env-redaction";

describe("shouldRedactSecretValue", () => {
  it("redacts by secret-looking key (incl. server-mirrored keys)", () => {
    expect(shouldRedactSecretValue("OPENAI_API_KEY", "x")).toBe(true);
    expect(shouldRedactSecretValue("PASSWORD", "x")).toBe(true);
    expect(shouldRedactSecretValue("WEBHOOK_SIGNING", "x")).toBe(true);
    expect(shouldRedactSecretValue("NPM_TOKEN", "x")).toBe(true);
    expect(shouldRedactSecretValue("DB_CONNECTION", "x")).toBe(true);
    expect(shouldRedactSecretValue("PORT", "8080")).toBe(false);
  });

  // Codex P2: these leaked verbatim before — key doesn't match, so the value
  // patterns must catch them (mirrors server redactEnvForLogs).
  it("redacts secret-looking VALUES even when the key looks benign", () => {
    expect(shouldRedactSecretValue("DATABASE_URL", "postgresql://user:pass@db:5432/app")).toBe(true);
    expect(shouldRedactSecretValue("CACHE", "redis://:hunter2@cache:6379/0")).toBe(true);
    expect(shouldRedactSecretValue("BILLING", "sk_live_abcd1234efgh5678")).toBe(true);
    expect(shouldRedactSecretValue("GH", "ghp_0123456789abcdef0123456789abcdef0123")).toBe(true);
    expect(shouldRedactSecretValue("CLOUD", "AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(
      shouldRedactSecretValue("JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwfQ.dGhpc2lzYXNpZ25hdHVyZXZhbA"),
    ).toBe(true);
  });

  it("does not over-redact benign AoA env display vars", () => {
    expect(shouldRedactSecretValue("AOA_API_URL", "http://localhost:3100")).toBe(false);
    expect(shouldRedactSecretValue("AOA_AGENT_ID", "ff55fc57-b5e2-4b15-90fd-2fc97605e5d5")).toBe(false);
    expect(shouldRedactSecretValue("NODE_VERSION", "v24.14.0")).toBe(false);
  });
});

describe("redactEnvValue", () => {
  it("masks secret_ref objects", () => {
    expect(redactEnvValue("ANY", { type: "secret_ref", secretId: "s" })).toBe(
      "***SECRET_REF***",
    );
  });
  it("masks secret keys and passes through plain values", () => {
    expect(redactEnvValue("API_KEY", "abc")).toBe("***REDACTED***");
    expect(redactEnvValue("REGION", "us-east-1")).toBe("us-east-1");
  });
});

describe("formatEnvForDisplay", () => {
  it("sorts keys and redacts", () => {
    expect(formatEnvForDisplay({ REGION: "us", API_KEY: "z" })).toBe(
      "API_KEY=***REDACTED***\nREGION=us",
    );
  });
  it("handles empty + unparseable", () => {
    expect(formatEnvForDisplay({})).toBe("<empty>");
    expect(formatEnvForDisplay("not-an-object")).toBe("<unable-to-parse>");
  });
});
