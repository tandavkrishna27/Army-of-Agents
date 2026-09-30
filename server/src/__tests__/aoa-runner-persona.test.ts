import { describe, it, expect, vi } from "vitest";
import { resolveAoaInstruction } from "../services/internal-agent/aoa-agents/runner.js";

const agentRow = { id: "a1", companyId: "c1", name: "Planner", adapterConfig: null };

describe("resolveAoaInstruction (runner persona resolution)", () => {
  it("uses the assembled bundle when files are readable", async () => {
    const persona = "## BUNDLE PERSONA";
    const out = await resolveAoaInstruction({
      agent: agentRow,
      fallbackInstruction: "legacy one-liner",
      assemble: vi.fn().mockResolvedValue(persona),
    });
    expect(out).toBe(persona);
  });

  it("falls back to runtimeConfig.aoa.instruction when no bundle is readable", async () => {
    const out = await resolveAoaInstruction({
      agent: agentRow,
      fallbackInstruction: "legacy one-liner",
      assemble: vi.fn().mockResolvedValue(null),
    });
    expect(out).toBe("legacy one-liner");
  });

  it("falls back when assembly throws (never hard-fails the run)", async () => {
    const out = await resolveAoaInstruction({
      agent: agentRow,
      fallbackInstruction: "legacy one-liner",
      assemble: vi.fn().mockRejectedValue(new Error("boom")),
    });
    expect(out).toBe("legacy one-liner");
  });
});
