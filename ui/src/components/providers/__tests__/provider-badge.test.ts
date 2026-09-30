import { describe, it, expect } from "vitest";
import { getProviderById } from "@armyofagents/shared";
import type { ProviderStatusRow, ScopedReadiness } from "@/api/providers";
import {
  deriveProviderBadge,
  TONE_DOT,
  type OutcomeTone,
} from "../ProviderReadinessCard";

function scope(over: Partial<ScopedReadiness> = {}): ScopedReadiness {
  return { scopeType: "company_default", scopeId: null, outcome: "verified", testedAt: null, checks: [], ...over };
}
function agent(name: string, outcome: ScopedReadiness["outcome"]): ScopedReadiness {
  return { scopeType: "agent", scopeId: name, agentName: name, outcome, testedAt: null, checks: [] };
}
function row(over: Partial<ProviderStatusRow> = {}): ProviderStatusRow {
  const d = getProviderById("anthropic")!;
  return {
    descriptor: d,
    companyDefault: scope(),
    agents: [],
    existingKey: { configured: false, source: null, secretName: null, envVar: "X" },
    ...over,
  };
}

describe("deriveProviderBadge", () => {
  it("verified + clean -> plain Ready, ready tone", () => {
    expect(deriveProviderBadge(row())).toEqual({ label: "Ready", tone: "ready" });
  });

  it("verified default + a failing agent -> warn tone, names the count", () => {
    const b = deriveProviderBadge(row({ agents: [agent("A", "needs_auth")] }));
    expect(b.tone).toBe("warn");
    expect(b.label).toMatch(/1 agent failing/);
  });

  it("verified default + only never-probed agents -> READY (green), NOT failing", () => {
    // The company key is verified and nothing is failing, so the provider works;
    // "not checked yet" is a caveat in the label, not a reason to grey it out.
    const b = deriveProviderBadge(row({ agents: [agent("A", "unknown"), agent("B", "unknown")] }));
    expect(b.tone).toBe("ready");
    expect(b.label).toMatch(/not checked yet/);
    expect(b.label).not.toMatch(/failing/);
  });

  it("a non-verified company default carries the outcome straight through", () => {
    expect(deriveProviderBadge(row({ companyDefault: scope({ outcome: "needs_auth" }) })))
      .toEqual({ label: "Needs sign-in", tone: "warn" });
  });

  it("TONE_DOT has a class for every tone", () => {
    const tones: OutcomeTone[] = ["ready", "neutral", "warn", "error"];
    for (const t of tones) expect(typeof TONE_DOT[t]).toBe("string");
  });
});
