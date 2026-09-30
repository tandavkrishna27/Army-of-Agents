import { describe, it, expect } from "vitest";
import { assembleAgentPersona } from "../services/internal-agent/commander-context.js";

const agent = { id: "a1", companyId: "c1", name: "Router", adapterConfig: null };

function makeService(files: Record<string, string | null>) {
  return {
    readFile: async (_agent: unknown, name: string) => {
      const content = files[name];
      if (content === null || content === undefined) throw new Error("not found");
      return { content };
    },
  };
}

describe("assembleAgentPersona", () => {
  it("concatenates AGENTS → SOUL → TOOLS → HEARTBEAT in bundle order", async () => {
    const service = makeService({
      "AGENTS.md": "agents-content",
      "SOUL.md": "soul-content",
      "TOOLS.md": "tools-content",
      "HEARTBEAT.md": "hb-content",
    });
    const result = await assembleAgentPersona({ agent, service });
    expect(result).toBe("agents-content\n\nsoul-content\n\ntools-content\n\nhb-content");
  });

  it("returns null when no files can be read (fallback path)", async () => {
    const result = await assembleAgentPersona({ agent, service: makeService({}) });
    expect(result).toBeNull();
  });

  it("skips files with empty or whitespace-only content", async () => {
    const service = makeService({
      "AGENTS.md": "agents-content",
      "SOUL.md": "   ",
      "TOOLS.md": "tools-content",
      "HEARTBEAT.md": "",
    });
    const result = await assembleAgentPersona({ agent, service });
    expect(result).toBe("agents-content\n\ntools-content");
  });

  it("returns partial bundle when only some files exist", async () => {
    const service = makeService({ "AGENTS.md": "agents-only" });
    const result = await assembleAgentPersona({ agent, service });
    expect(result).toBe("agents-only");
  });
});
