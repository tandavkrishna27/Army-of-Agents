import { describe, it, expect, vi } from "vitest";
import { assembleAgentPersona } from "../services/internal-agent/commander-context.js";

const agent = { id: "a1", companyId: "c1", name: "Planner", adapterConfig: null };

describe("assembleAgentPersona", () => {
  it("concatenates files in order AGENTS, SOUL, TOOLS, HEARTBEAT", async () => {
    const service = {
      readFile: vi.fn(async (_a: unknown, name: string) => ({ content: `[${name}]` })),
    };
    const persona = await assembleAgentPersona({ agent, service });
    expect(persona).toBe("[AGENTS.md]\n\n[SOUL.md]\n\n[TOOLS.md]\n\n[HEARTBEAT.md]");
  });

  it("skips empty files and preserves order", async () => {
    const service = {
      readFile: vi.fn(async (_a: unknown, name: string) =>
        name === "SOUL.md" ? { content: "   " } : { content: `[${name}]` },
      ),
    };
    const persona = await assembleAgentPersona({ agent, service });
    expect(persona).toBe("[AGENTS.md]\n\n[TOOLS.md]\n\n[HEARTBEAT.md]");
  });

  it("returns null when no file is readable (so caller can fall back)", async () => {
    const service = { readFile: vi.fn(async () => { throw new Error("ENOENT"); }) };
    expect(await assembleAgentPersona({ agent, service })).toBeNull();
  });

  it("loadCommanderPersona remains a working alias", async () => {
    const { loadCommanderPersona } = await import("../services/internal-agent/commander-context.js");
    const service = { readFile: vi.fn(async (_a: unknown, name: string) => ({ content: `[${name}]` })) };
    expect(await loadCommanderPersona({ agent, service })).toContain("[AGENTS.md]");
  });
});
