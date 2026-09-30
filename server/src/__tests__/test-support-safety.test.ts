import { describe, expect, it } from "vitest";
import {
  assertTestSupportFlagSafe,
  TestSupportFlagUnsafeError,
} from "../services/test-support-safety.js";

const safe = {
  testSupportEnabled: true,
  testSupportToken: "t".repeat(32),
  deploymentExposure: "private",
  bindHost: "127.0.0.1",
  authPublicBaseUrl: "http://localhost:3210",
  nodeEnv: "test",
};

describe("assertTestSupportFlagSafe", () => {
  it("allows a private loopback test instance", () => {
    expect(() => assertTestSupportFlagSafe(safe)).not.toThrow();
  });

  it("does not affect normal boots when the flag is off", () => {
    expect(() =>
      assertTestSupportFlagSafe({
        ...safe,
        testSupportEnabled: false,
        deploymentExposure: "public",
        bindHost: "0.0.0.0",
        nodeEnv: "production",
      }),
    ).not.toThrow();
  });

  it.each([
    [undefined, "missing token"],
    ["t".repeat(31), "token shorter than 32 bytes"],
  ])("refuses a dedicated test-support boot with %s (%s)", (testSupportToken) => {
    expect(() => assertTestSupportFlagSafe({ ...safe, testSupportToken })).toThrow(
      TestSupportFlagUnsafeError,
    );
  });

  it.each([
    [{ deploymentExposure: "public" }, "public exposure"],
    [{ bindHost: "0.0.0.0" }, "non-loopback bind"],
    [{ authPublicBaseUrl: "https://qa.example.com" }, "non-loopback base URL"],
    [{ authPublicBaseUrl: "not a url" }, "invalid base URL"],
    [{ nodeEnv: "production" }, "production NODE_ENV"],
  ])("refuses $1", (patch) => {
    expect(() => assertTestSupportFlagSafe({ ...safe, ...patch })).toThrow(
      TestSupportFlagUnsafeError,
    );
  });
});
