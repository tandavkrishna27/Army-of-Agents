import { describe, expect, it } from "vitest";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

describe("commander default bundle", () => {
  it("loads the 4-file commander bundle", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("commander");
    expect(Object.keys(bundle).sort()).toEqual(
      ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
    );
    expect(bundle["AGENTS.md"]).toContain("You are **Commander**");
  });
});
