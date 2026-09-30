import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("agent local JWT", () => {
  const secretEnv = "AOA_AGENT_JWT_SECRET";
  const betterAuthEnv = "BETTER_AUTH_SECRET";
  const ttlEnv = "AOA_AGENT_JWT_TTL_SECONDS";
  const issuerEnv = "AOA_AGENT_JWT_ISSUER";
  const audienceEnv = "AOA_AGENT_JWT_AUDIENCE";

  const originalEnv = {
    secret: process.env[secretEnv],
    betterAuth: process.env[betterAuthEnv],
    ttl: process.env[ttlEnv],
    issuer: process.env[issuerEnv],
    audience: process.env[audienceEnv],
  };

  beforeEach(() => {
    process.env[secretEnv] = "test-secret";
    delete process.env[betterAuthEnv];
    process.env[ttlEnv] = "3600";
    delete process.env[issuerEnv];
    delete process.env[audienceEnv];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv.secret === undefined) delete process.env[secretEnv];
    else process.env[secretEnv] = originalEnv.secret;
    if (originalEnv.betterAuth === undefined) delete process.env[betterAuthEnv];
    else process.env[betterAuthEnv] = originalEnv.betterAuth;
    if (originalEnv.ttl === undefined) delete process.env[ttlEnv];
    else process.env[ttlEnv] = originalEnv.ttl;
    if (originalEnv.issuer === undefined) delete process.env[issuerEnv];
    else process.env[issuerEnv] = originalEnv.issuer;
    if (originalEnv.audience === undefined) delete process.env[audienceEnv];
    else process.env[audienceEnv] = originalEnv.audience;
  });

  it("creates and verifies a token", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(typeof token).toBe("string");

    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({
      sub: "agent-1",
      company_id: "company-1",
      adapter_type: "claude_local",
      run_id: "run-1",
      iss: "aoa",
      aud: "aoa-api",
    });
  });

  it("returns null when secret is missing", () => {
    process.env[secretEnv] = "";
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeNull();
    expect(verifyLocalAgentJwt("abc.def.ghi")).toBeNull();
  });

  it("rejects expired tokens", () => {
    process.env[ttlEnv] = "1";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });

  it("accepts legacy paperclip issuer/audience for backward compatibility", () => {
    // Simulate an in-flight token created before the rename (iss: "paperclip")
    process.env[issuerEnv] = "paperclip";
    process.env[audienceEnv] = "paperclip-api";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");

    // Switch to new defaults (simulating server post-rename)
    delete process.env[issuerEnv];   // falls back to "aoa"
    delete process.env[audienceEnv]; // falls back to "aoa-api"

    // Old token should still verify via dual-accept
    const claims = verifyLocalAgentJwt(token!);
    expect(claims).not.toBeNull();
    expect(claims!.iss).toBe("paperclip");
    expect(claims!.aud).toBe("paperclip-api");
    expect(claims!.sub).toBe("agent-1");
  });

  it("rejects issuer/audience mismatch", () => {
    process.env[issuerEnv] = "custom-issuer";
    process.env[audienceEnv] = "custom-audience";
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = createLocalAgentJwt("agent-1", "company-1", "codex_local", "run-1");

    process.env[issuerEnv] = "wrong-issuer";
    process.env[audienceEnv] = "wrong-audience";
    expect(verifyLocalAgentJwt(token!)).toBeNull();
  });
});

describe("AOA_AGENT_JWT_SECRET fallback", () => {
  const secretEnv = "AOA_AGENT_JWT_SECRET";
  const betterAuthEnv = "BETTER_AUTH_SECRET";

  afterEach(() => {
    // Clean up any env vars set during these tests
    delete process.env[secretEnv];
    delete process.env[betterAuthEnv];
  });

  it("falls back to BETTER_AUTH_SECRET when AOA_AGENT_JWT_SECRET is unset", () => {
    delete process.env[secretEnv];
    process.env[betterAuthEnv] = "test-better-auth-secret-32chars";

    const token = createLocalAgentJwt("a1", "c1", "claude_local", "r1");
    expect(token).toBeTruthy();

    const decoded = verifyLocalAgentJwt(token!);
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe("a1");
  });

  it("trims whitespace from AOA_AGENT_JWT_SECRET", () => {
    process.env[secretEnv] = "  whitespace-secret-32chars-x  ";
    delete process.env[betterAuthEnv];

    const token = createLocalAgentJwt("a1", "c1", "claude_local", "r1");
    expect(token).toBeTruthy();

    const decoded = verifyLocalAgentJwt(token!);
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe("a1");
  });

  it("trims whitespace from BETTER_AUTH_SECRET when used as fallback", () => {
    delete process.env[secretEnv];
    process.env[betterAuthEnv] = "  whitespace-better-auth-secret  ";

    const token = createLocalAgentJwt("a1", "c1", "claude_local", "r1");
    expect(token).toBeTruthy();

    const decoded = verifyLocalAgentJwt(token!);
    expect(decoded).not.toBeNull();
    expect(decoded!.sub).toBe("a1");
  });

  it("returns null when both secrets are unset", () => {
    delete process.env[secretEnv];
    delete process.env[betterAuthEnv];

    const token = createLocalAgentJwt("a1", "c1", "claude_local", "r1");
    expect(token).toBeNull();
  });
});
