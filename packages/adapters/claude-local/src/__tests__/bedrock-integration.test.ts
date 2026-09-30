import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const fakeChild: any = {
      stdout: { on: vi.fn(), pipe: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn(), end: vi.fn() },
      on: vi.fn((event, cb) => {
        if (event === "exit") setTimeout(() => cb(0, null), 5);
      }),
      kill: vi.fn(),
      pid: 12345,
    };
    return fakeChild;
  }),
}));

import { resolveClaudeBillingType, isBedrockAuth } from "../server/execute.js";

describe("Bedrock integration — full execute path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("billingType resolves to metered_api when CLAUDE_CODE_USE_BEDROCK=1", () => {
    expect(resolveClaudeBillingType({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("metered_api");
  });

  it("billingType resolves to metered_api when ANTHROPIC_BEDROCK_BASE_URL is set", () => {
    expect(resolveClaudeBillingType({ ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.us-east-1.amazonaws.com" })).toBe("metered_api");
  });

  it("billingType resolves to api when only ANTHROPIC_API_KEY set", () => {
    expect(resolveClaudeBillingType({ ANTHROPIC_API_KEY: "sk-ant-..." })).toBe("api");
  });

  it("billingType resolves to subscription when no auth env present", () => {
    expect(resolveClaudeBillingType({})).toBe("subscription");
  });

  it("Bedrock takes precedence over API key (both set)", () => {
    expect(
      resolveClaudeBillingType({
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_API_KEY: "sk-ant-...",
      }),
    ).toBe("metered_api");
  });

  it("isBedrockAuth + resolveClaudeBillingType agree on truthy env", () => {
    const env = { CLAUDE_CODE_USE_BEDROCK: "true" };
    expect(isBedrockAuth(env)).toBe(true);
    expect(resolveClaudeBillingType(env)).toBe("metered_api");
  });
});
