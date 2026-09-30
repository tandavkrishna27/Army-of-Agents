import { describe, expect, it } from "vitest";
import { contextAssemblyService } from "../services/internal-agent/context-assembly.js";

const db: any = { select: () => ({ from: () => ({ where: () => ({ then: (r: any) => Promise.resolve([]).then(r) }) }) }) };

describe("assembleContext systemInstructions override", () => {
  it("uses the provided systemInstructions instead of the default constant", async () => {
    const out = await contextAssemblyService(db).assembleContext("c1", { systemInstructions: "ROLE: Commander persona X" });
    expect(out.systemPrompt).toContain("ROLE: Commander persona X");
    expect(out.systemPrompt).not.toContain("You are the internal AI assistant for this company");
  });
  it("falls back to the default constant when systemInstructions is empty/absent", async () => {
    const out = await contextAssemblyService(db).assembleContext("c1", {});
    expect(out.systemPrompt).toContain("You are the internal AI assistant for this company");
  });
});
