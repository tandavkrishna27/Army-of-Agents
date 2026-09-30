// server/src/__tests__/internal-agent-config-reensure.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted: the mock fns are referenced inside the vi.mock factory (hoisted to
// the top of the module), so they must be defined via vi.hoisted to exist at
// factory-evaluation time. Matches the codebase idiom (aoa-ensure-commander.test.ts).
const { ensureInfra, ensureCrew, isManaged } = vi.hoisted(() => ({
  ensureInfra: vi.fn(async () => {}),
  ensureCrew: vi.fn(async () => {}),
  isManaged: vi.fn(async () => false),
}));
vi.mock("../services/internal-agent/aoa-agents/crew-seeding.js", () => ({
  ensureInfrastructureAgents: ensureInfra,
  ensureCrewAgents: ensureCrew,
  isCrewMarketplaceManaged: isManaged,
}));

import { maybeReensureAgentsOnConfigChange } from "../routes/internal-agent.js";

const base = { provider: "openai", crewModel: null, cliTool: "claude_cli", model: null } as const;

describe("maybeReensureAgentsOnConfigChange", () => {
  beforeEach(() => {
    ensureInfra.mockClear();
    ensureCrew.mockClear();
    isManaged.mockClear();
    isManaged.mockResolvedValue(false);
  });

  it("re-ensures when crew provider changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", { ...base, provider: "anthropic" }, { ...base, provider: "openai" });
    expect(ensureInfra).toHaveBeenCalledWith({}, "co-1");
    expect(ensureCrew).toHaveBeenCalledWith({}, "co-1");
  });
  it("re-ensures when crewModel changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, crewModel: "gpt-5.5" });
    expect(ensureCrew).toHaveBeenCalledTimes(1);
  });
  it("re-ensures when Commander cliTool changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, cliTool: "codex" });
    expect(ensureInfra).toHaveBeenCalledTimes(1);
    expect(ensureCrew).toHaveBeenCalledTimes(1);
  });
  it("re-ensures when Commander model changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, model: "claude-opus-4-1" });
    expect(ensureInfra).toHaveBeenCalledTimes(1);
  });
  it("does NOT re-ensure when nothing adapter-affecting changed", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base });
    expect(ensureInfra).not.toHaveBeenCalled();
    expect(ensureCrew).not.toHaveBeenCalled();
  });
  it("refreshes Commander but skips the full legacy crew, including Steward, when marketplace-managed", async () => {
    isManaged.mockResolvedValue(true);
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, provider: "anthropic" });
    // Commander's adapter must still follow a provider/cliTool switch.
    expect(ensureInfra).toHaveBeenCalledWith({}, "co-1");
    expect(ensureCrew).not.toHaveBeenCalled();
  });
});
