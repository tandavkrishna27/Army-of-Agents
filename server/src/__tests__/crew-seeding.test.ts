// server/src/__tests__/crew-seeding.test.ts
//
// P8d split: `ensureInfrastructureAgents` (Commander — always seeded) vs
// `ensureCrewAgents` (the marketplace-owned roster, including Steward — gated by the caller on
// isCrewMarketplaceManaged). There is deliberately no "seed everything" union
// export; each half is exercised on its own here, and the caller-seam gate is
// covered by crew-seeding-marketplace-gate.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({ ensureCommanderAgent: vi.fn(async () => { calls.push("commander"); return "c"; }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-command-staff.js", () => ({ ensureCommandStaff: vi.fn(async () => { calls.push("staff"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-adjutant.js", () => ({ ensureAdjutant: vi.fn(async () => { calls.push("adjutant"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-scout.js", () => ({ ensureScout: vi.fn(async () => { calls.push("scout"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-engineer.js", () => ({ ensureEngineer: vi.fn(async () => { calls.push("engineer"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-chronicler.js", () => ({ ensureChronicler: vi.fn(async () => { calls.push("chronicler"); }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-steward.js", () => ({ ensureSteward: vi.fn(async () => { calls.push("steward"); return "s"; }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-librarian.js", () => ({ ensureLibrarian: vi.fn(async () => { calls.push("librarian"); }) }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }));

import * as crewSeeding from "../services/internal-agent/aoa-agents/crew-seeding.js";
import {
  ensureCrewAgents,
  ensureInfrastructureAgents,
} from "../services/internal-agent/aoa-agents/crew-seeding.js";

const INFRA = ["commander"];
const CREW = ["adjutant", "chronicler", "engineer", "librarian", "scout", "staff", "steward"];

describe("crew seeding split (P8d)", () => {
  beforeEach(() => { calls.length = 0; });

  it("ensureInfrastructureAgents runs ONLY Commander", async () => {
    await ensureInfrastructureAgents({} as any, "co-1");
    expect(calls.slice().sort()).toEqual(INFRA);
  });

  it("ensureCrewAgents runs the marketplace-owned roster, including Steward (no Commander)", async () => {
    await ensureCrewAgents({} as any, "co-1");
    expect(calls.slice().sort()).toEqual(CREW);
  });

  // The union export was deleted deliberately: a "seed everything" symbol in a
  // module whose whole point is the split invites `if (managed) return;
  // seedEverything()` — P8d restored. Callers must pick a half.
  it("exports no ungated seed-everything union", () => {
    const exported = Object.keys(crewSeeding).sort();
    expect(exported).toEqual([
      "ensureCrewAgents",
      "ensureInfrastructureAgents",
      "isCrewMarketplaceManaged",
    ]);
  });

  it("one failing crew ensure does not abort the rest of the crew", async () => {
    const mod = await import("../services/internal-agent/aoa-agents/ensure-scout.js");
    (mod.ensureScout as any).mockRejectedValueOnce(new Error("boom"));
    await ensureCrewAgents({} as any, "co-1");
    expect(calls.slice().sort()).toEqual(CREW.filter((c) => c !== "scout"));
    expect(calls.length).toBe(6);
  });

  it("a failing infrastructure ensure is contained", async () => {
    const mod = await import("../services/internal-agent/aoa-agents/ensure-commander.js");
    (mod.ensureCommanderAgent as any).mockRejectedValueOnce(new Error("boom"));
    await ensureInfrastructureAgents({} as any, "co-1");
    expect(calls).toEqual([]);
  });

  it("a failing infrastructure ensure does not prevent a subsequent crew seed", async () => {
    const mod = await import("../services/internal-agent/aoa-agents/ensure-commander.js");
    (mod.ensureCommanderAgent as any).mockRejectedValueOnce(new Error("boom"));
    await ensureInfrastructureAgents({} as any, "co-1");
    await ensureCrewAgents({} as any, "co-1");
    expect(calls.slice().sort()).toEqual(CREW);
    expect(calls.length).toBe(7);
  });
});
