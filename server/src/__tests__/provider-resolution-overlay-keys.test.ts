// server/src/__tests__/provider-resolution-overlay-keys.test.ts
import { describe, it, expect } from "vitest";
import { materializeEnvPatch } from "../services/provider-resolution.js";
import { GATEWAY_TOKEN_ENV_ALLOWLIST } from "@armyofagents/shared";
// Cross-package import is fine in TESTS: assert our enterprise_gateway env keys
// stay in the adapter's overlay-auth allow-list (ambient-config.ts:415-424), or
// the ambient strip would delete them at spawn. The real exported symbol is the
// flat key list CLAUDE_OVERLAY_AUTH_KEYS (Object.keys of the private
// CLAUDE_OVERLAY_AUTH_KEY_SHAPES map), re-exported from the package's `./server`
// subpath — the module file is not itself a NodeNext-resolvable subpath export.
import { CLAUDE_OVERLAY_AUTH_KEYS } from "@armyofagents/adapter-claude-local/server";

describe("resolver env keys survive the ambient strip", () => {
  it("every allowed gateway tokenEnvVar is in CLAUDE_OVERLAY_AUTH_KEYS", () => {
    // Guard against a tautology: prove the allowlist we assert against is real and
    // non-empty (a fabricated/empty adapter list would make `toContain` vacuous).
    expect(CLAUDE_OVERLAY_AUTH_KEYS.length).toBeGreaterThan(0);
    expect([...GATEWAY_TOKEN_ENV_ALLOWLIST].length).toBeGreaterThan(0);
    for (const key of GATEWAY_TOKEN_ENV_ALLOWLIST) {
      expect(CLAUDE_OVERLAY_AUTH_KEYS).toContain(key);
    }
  });

  it("enterprise_gateway emitted keys (base URL + token) are all in CLAUDE_OVERLAY_AUTH_KEYS", () => {
    const gateway = materializeEnvPatch({
      authMethod: "enterprise_gateway",
      provider: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      secretValue: "t",
      config: { baseUrl: "https://g" },
      subscriptionEnv: null,
    });
    // The patch must actually emit both a base URL and a token env var, otherwise
    // the loop below would pass vacuously.
    expect(Object.keys(gateway).length).toBe(2);
    for (const key of Object.keys(gateway)) {
      expect(CLAUDE_OVERLAY_AUTH_KEYS).toContain(key);
    }
  });
});
