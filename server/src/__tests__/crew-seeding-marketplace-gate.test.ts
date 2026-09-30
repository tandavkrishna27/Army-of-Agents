// server/src/__tests__/crew-seeding-marketplace-gate.test.ts
//
// P8d discriminator. The gate lives in the CALLERS, so this test exercises a
// real caller (`maybeReensureAgentsOnConfigChange`) with the REAL
// ensureInfrastructureAgents / ensureCrewAgents (only the leaf ensure-* seeders
// and the gate predicate are stubbed).
//
// Why this test can only pass for the right reason:
//   * Old all-or-nothing design WITH the gate  → early return, Commander never
//     ensured → "commander" missing → FAIL.
//   * Old all-or-nothing design WITHOUT the gate → ensureAllCrewAgents runs the
//     whole roster → "scout" present → FAIL.
//   Only a genuine split (infra unconditional, crew gated) satisfies both
//   assertions at once.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { calls, isManaged } = vi.hoisted(() => ({
  calls: [] as string[],
  isManaged: vi.fn(async () => false),
}));

vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({ ensureCommanderAgent: vi.fn(async () => { calls.push("commander"); return "c"; }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-steward.js", () => ({ ensureSteward: vi.fn(async () => { calls.push("steward"); return "s"; }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-command-staff.js", () => ({ ensureCommandStaff: vi.fn(async () => { calls.push("staff"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-adjutant.js", () => ({ ensureAdjutant: vi.fn(async () => { calls.push("adjutant"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-scout.js", () => ({ ensureScout: vi.fn(async () => { calls.push("scout"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-engineer.js", () => ({ ensureEngineer: vi.fn(async () => { calls.push("engineer"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-chronicler.js", () => ({ ensureChronicler: vi.fn(async () => { calls.push("chronicler"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-librarian.js", () => ({ ensureLibrarian: vi.fn(async () => { calls.push("librarian"); }) }));

// Partial mock: keep the REAL ensureInfrastructureAgents / ensureCrewAgents so
// the split itself is under test; stub only the DB-backed gate predicate.
vi.mock("../services/internal-agent/aoa-agents/crew-seeding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/internal-agent/aoa-agents/crew-seeding.js")>()),
  isCrewMarketplaceManaged: isManaged,
}));

import { maybeReensureAgentsOnConfigChange } from "../routes/internal-agent.js";

const base = { provider: "openai", crewModel: null, cliTool: "claude_cli", model: null } as const;
const CREW = ["adjutant", "chronicler", "engineer", "librarian", "scout", "staff", "steward"];

describe("marketplace gate covers the crew half only (P8d)", () => {
  beforeEach(() => {
    calls.length = 0;
    isManaged.mockClear();
    isManaged.mockResolvedValue(false);
  });

  it("marketplace-managed: infrastructure still runs, crew does NOT", async () => {
    isManaged.mockResolvedValue(true);
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, cliTool: "codex" });

    // Infrastructure ran…
    expect(calls).toContain("commander");
    expect(calls).not.toContain("steward");
    // …and the marketplace-owned roster did not. Scout is the discriminator:
    // it exists in the published catalog (agent:aoa-curated/aoa-scout), so the
    // install owns it and the legacy seeder must stay off.
    expect(calls).not.toContain("scout");
    for (const crew of CREW) expect(calls).not.toContain(crew);
    expect(calls.slice().sort()).toEqual(["commander"]);
  });

  it("NOT marketplace-managed: the full legacy roster still runs (regression)", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base, cliTool: "codex" });
    expect(calls.slice().sort()).toEqual([...CREW, "commander"].sort());
    expect(calls.length).toBe(8);
  });

  it("no adapter-affecting change: neither half runs, and the gate is not even queried", async () => {
    await maybeReensureAgentsOnConfigChange({} as any, "co-1", base, { ...base });
    expect(calls).toEqual([]);
    expect(isManaged).not.toHaveBeenCalled();
  });
});
