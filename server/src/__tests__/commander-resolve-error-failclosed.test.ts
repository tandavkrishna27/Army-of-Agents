// server/src/__tests__/commander-resolve-error-failclosed.test.ts
import { describe, it, expect } from "vitest";
import { handleCommanderResolveError } from "../services/internal-agent/cli-mode.js";

// Commander resolves its per-session provider credential through the unified
// resolver. When that resolution throws, the decision of whether to fail closed
// (rethrow) or degrade to the operator's ambient host login (return {}) MUST NOT
// leak the host login on a shared multi-tenant (cloud_auth) host.
describe("handleCommanderResolveError — fail closed on cloud, host-login only self-hosted", () => {
  const providerUnavailable = Object.assign(new Error("provider down"), {
    code: "provider_unavailable",
  });

  it("cloud (tenantIsolationEnforced) rethrows a GENERIC resolver error — never borrows the host login", () => {
    // The confirmed bug: a DB/config/import fault previously degraded to {} on
    // cloud, silently spawning Commander on the operator's ~/.claude/~/.codex.
    expect(() =>
      handleCommanderResolveError(new Error("db down"), { tenantIsolationEnforced: true }),
    ).toThrow("db down");
  });

  it("self-hosted degrades a GENERIC resolver error to the host login ({}) — unchanged", () => {
    expect(
      handleCommanderResolveError(new Error("db down"), { tenantIsolationEnforced: false }),
    ).toEqual({});
  });

  it("provider_unavailable rethrows on cloud", () => {
    expect(() =>
      handleCommanderResolveError(providerUnavailable, { tenantIsolationEnforced: true }),
    ).toThrow(providerUnavailable);
  });

  it("provider_unavailable rethrows self-hosted (self-hosted still surfaces it, not host login)", () => {
    expect(() =>
      handleCommanderResolveError(providerUnavailable, { tenantIsolationEnforced: false }),
    ).toThrow(providerUnavailable);
  });
});
