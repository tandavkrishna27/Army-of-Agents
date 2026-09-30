import { describe, it, expect } from "vitest";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

const CREW = [
  "router",
  "planner",
  "dispatcher",
  "memory_keeper",
  "scribe",
  "steward",
] as const;

describe("default-agent-instructions — crew role bundles", () => {
  it("loads a 4-file bundle for every crew role", async () => {
    for (const role of CREW) {
      const bundle = await loadDefaultAgentInstructionsBundle(role as any);
      expect(Object.keys(bundle).sort()).toEqual([
        "AGENTS.md",
        "HEARTBEAT.md",
        "SOUL.md",
        "TOOLS.md",
      ]);
      // Files are non-empty markdown, not placeholders.
      for (const content of Object.values(bundle)) {
        expect(content.trim().length).toBeGreaterThan(40);
      }
    }
  });
});
