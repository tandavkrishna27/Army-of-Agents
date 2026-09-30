import { describe, expect, it, vi } from "vitest";

const writes: Record<string, string> = {};
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    stat: vi.fn(async (p: string) => (writes[p] ? { isFile: () => true } : Promise.reject(new Error("ENOENT")))),
    writeFile: vi.fn(async (p: string, c: string) => { writes[p] = c; }),
    readFile: vi.fn(async () => "DEFAULT CONTENT"),
  },
}));

import { seedCommanderInstructionBundle } from "../services/internal-agent/aoa-agents/seed-commander-bundle.js";

function fakeService() {
  return {
    ensureWritableBundle: vi.fn(async () => ({
      adapterConfig: { instructionsBundle: { mode: "managed", rootPath: "/root", entryFile: "AGENTS.md" } },
      state: { rootPath: "/root", entryFile: "AGENTS.md" },
    })),
  };
}

describe("seedCommanderInstructionBundle", () => {
  it("writes the 4 commander files and returns the linked adapterConfig", async () => {
    const svc = fakeService();
    const cfg = await seedCommanderInstructionBundle({
      agent: { id: "a1", companyId: "c1", name: "Commander", adapterConfig: {} },
      service: svc as any,
    });
    expect(svc.ensureWritableBundle).toHaveBeenCalled();
    expect(Object.keys(writes).some((p) => p.endsWith("AGENTS.md"))).toBe(true);
    expect(cfg).toEqual({ instructionsBundle: { mode: "managed", rootPath: "/root", entryFile: "AGENTS.md" } });
  });

  it("does not overwrite a file that already exists (preserves user edits)", async () => {
    writes["/root/SOUL.md"] = "USER EDITED";
    const svc = fakeService();
    await seedCommanderInstructionBundle({ agent: { id: "a1", companyId: "c1", name: "Commander", adapterConfig: {} }, service: svc as any });
    expect(writes["/root/SOUL.md"]).toBe("USER EDITED");
  });
});
