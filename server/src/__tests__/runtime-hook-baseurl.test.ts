import { describe, it, expect } from "vitest";
import { resolveRuntimeHookBaseUrl, isLoopbackApiUrl } from "../services/heartbeat.js";

// U2e: the claude_local PreToolUse runtime-permission hook needs a base URL to
// call back to the control plane. `http://127.0.0.1:${PORT}` is unreachable
// from inside an E2B sandbox VM — for a brokered (sandboxed) run the base URL
// MUST be a routable control-plane URL (AOA_API_URL). The `127.0.0.1` fallback
// stays valid ONLY for host-local (desktop/unsandboxed) runs.
describe("resolveRuntimeHookBaseUrl", () => {
  it("sandbox run: returns AOA_API_URL when set", () => {
    expect(
      resolveRuntimeHookBaseUrl({ apiUrl: "https://cp.example", port: "3100", brokered: true }),
    ).toBe("https://cp.example");
  });

  it("sandbox run: MUST NOT fall back to loopback — throws when AOA_API_URL is empty", () => {
    expect(() =>
      resolveRuntimeHookBaseUrl({ apiUrl: "", port: "3100", brokered: true }),
    ).toThrow(/AOA_API_URL required for sandboxed runtime hook/);
  });

  it("host-local run: loopback fallback preserved when AOA_API_URL is empty (desktop unchanged)", () => {
    expect(
      resolveRuntimeHookBaseUrl({ apiUrl: "", port: "3100", brokered: false }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("host-local run: AOA_API_URL still takes precedence over loopback when set (matches today's `||` precedence)", () => {
    expect(
      resolveRuntimeHookBaseUrl({ apiUrl: "https://cp.example", port: "3100", brokered: false }),
    ).toBe("https://cp.example");
  });

  it("uses the port value verbatim in the loopback fallback", () => {
    expect(
      resolveRuntimeHookBaseUrl({ apiUrl: "", port: "4200", brokered: false }),
    ).toBe("http://127.0.0.1:4200");
  });

  it("sandbox run: THROWS on a loopback AOA_API_URL the VM cannot reach (fail-before-spend, not a silent MCP failure)", () => {
    for (const url of [
      "http://localhost:3100",
      "http://127.0.0.1:3100",
      "http://[::1]:3100",
      "http://0.0.0.0:3100",
    ]) {
      expect(() =>
        resolveRuntimeHookBaseUrl({ apiUrl: url, port: "3100", brokered: true }),
      ).toThrow(/reachable from the sandbox VM/);
    }
  });

  it("sandbox run: a public URL is accepted", () => {
    expect(
      resolveRuntimeHookBaseUrl({ apiUrl: "https://cp.example.com", port: "3100", brokered: true }),
    ).toBe("https://cp.example.com");
  });

  it("host-local run: a loopback AOA_API_URL is NOT rejected (only brokered runs must be routable)", () => {
    expect(
      resolveRuntimeHookBaseUrl({ apiUrl: "http://localhost:3100", port: "3100", brokered: false }),
    ).toBe("http://localhost:3100");
  });
});

describe("isLoopbackApiUrl", () => {
  it.each([
    ["http://localhost:3100", true],
    ["http://127.0.0.1:3100", true],
    ["http://127.5.5.5:3100", true],
    ["http://[::1]:3100", true],
    ["http://0.0.0.0:3100", true],
    ["http://api.localhost:3100", true],
    ["https://cp.example.com", false],
    ["https://staging.aoa.dev/companies/x/mcp", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isLoopbackApiUrl(url as string)).toBe(expected);
  });
});
