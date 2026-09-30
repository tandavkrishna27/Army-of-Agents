/**
 * P2-T3: Persona bundle resolution.
 *
 * Verifies that Engineer and Scout now load their OWN curated 4-file bundles
 * (distinct builder/researcher personas) instead of aliasing to maker/ and
 * default/. Uses the REAL loadDefaultAgentInstructionsBundle (no mock) so a
 * missing file or wrong dir mapping fails the test.
 */
import { describe, it, expect } from "vitest";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

describe("P2-T3 crew persona bundles", () => {
  it("engineer loads its own 4-file bundle with a builder-voiced SOUL", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("engineer");
    expect(Object.keys(bundle).sort()).toEqual(
      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
    );
    // Distinct Engineer identity — not the legacy "Maker".
    expect(bundle["SOUL.md"]).toContain("Engineer");
    expect(bundle["SOUL.md"]).not.toMatch(/You are the \*\*Maker\*\*/);
  });

  it("scout loads its own 4-file bundle with a researcher-voiced SOUL", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("scout");
    expect(Object.keys(bundle).sort()).toEqual(
      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
    );
    // Scout previously had NO SOUL (fell back to default/AGENTS.md only).
    expect(bundle["SOUL.md"]).toContain("Scout");
    expect(bundle["SOUL.md"].length).toBeGreaterThan(100);
  });

  it("engineer and scout SOULs are distinct from each other", async () => {
    const [engineer, scout] = await Promise.all([
      loadDefaultAgentInstructionsBundle("engineer"),
      loadDefaultAgentInstructionsBundle("scout"),
    ]);
    expect(engineer["SOUL.md"]).not.toEqual(scout["SOUL.md"]);
  });

  it("all crew SOULs keep the no-memory/no-tasks guardrail (Decisions #15/#16/#52)", async () => {
    for (const role of ["engineer", "scout"] as const) {
      const bundle = await loadDefaultAgentInstructionsBundle(role);
      expect(bundle["SOUL.md"]).toMatch(/#15\/#16\/#52/);
    }
  });
});
