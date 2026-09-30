import { describe, expect, it, vi } from "vitest";
import { loadCommanderPersona } from "../services/internal-agent/commander-context.js";

describe("loadCommanderPersona", () => {
  it("concatenates the bundle files in AGENTS,SOUL,TOOLS,HEARTBEAT order", async () => {
    const service = {
      readFile: vi.fn(async (_a: unknown, rel: string) => ({ content: `<<${rel}>>` })),
    } as any;
    const out = await loadCommanderPersona({ agent: { id: "a1", companyId: "c1", name: "Commander", adapterConfig: {} }, service });
    expect(out).toBe("<<AGENTS.md>>\n\n<<SOUL.md>>\n\n<<TOOLS.md>>\n\n<<HEARTBEAT.md>>");
  });
  it("returns null when the bundle is unreadable (caller falls back to the constant)", async () => {
    const service = { readFile: vi.fn(async () => { throw new Error("no bundle"); }) } as any;
    const out = await loadCommanderPersona({ agent: { id: "a1", companyId: "c1", name: "Commander", adapterConfig: {} }, service });
    expect(out).toBeNull();
  });
});
