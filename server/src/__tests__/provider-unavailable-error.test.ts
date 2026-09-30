// server/src/__tests__/provider-unavailable-error.test.ts
import { describe, it, expect } from "vitest";
import { ProviderUnavailableError } from "../services/provider-resolution.js";

describe("ProviderUnavailableError (cloud fail-closed run copy)", () => {
  it("preserves the machine-readable diagnostic fields", () => {
    const err = new ProviderUnavailableError("anthropic", "no_assignment", "conn-1");
    expect(err.code).toBe("provider_unavailable");
    expect(err.provider).toBe("anthropic");
    expect(err.reason).toBe("no_assignment");
    expect(err.connectionId).toBe("conn-1");
    expect(err.name).toBe("ProviderUnavailableError");
    expect(err).toBeInstanceOf(Error);
  });

  it("routes the founder to Settings -> Providers (never a keyless-CLI login)", () => {
    const err = new ProviderUnavailableError("anthropic", "assignment_rejected", "conn-9");
    // Actionable: names the per-company key surface.
    expect(err.message).toMatch(/Settings\s*→\s*Providers/);
    // Honest fail-closed: must NOT instruct a keyless-CLI / host login.
    expect(err.message).not.toMatch(
      /host login|CLI login|log ?in to the CLI|claude auth login|codex login|run the CLI/i,
    );
    // Keeps the diagnostic breadcrumb for support.
    expect(err.message).toContain("assignment_rejected");
    expect(err.message).toContain("conn-9");
  });

  it("omits the connection clause when there is no connection id", () => {
    const err = new ProviderUnavailableError("openai", "no_assignment", null);
    expect(err.message).not.toContain("connection ");
    expect(err.message).toMatch(/Settings\s*→\s*Providers/);
  });
});
