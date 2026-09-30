import { describe, expect, it, vi } from "vitest";
import { contextAssemblyService } from "../services/internal-agent/context-assembly.js";

const db:any = { select: () => ({ from: () => ({ where: () => ({ then:(r:any)=>Promise.resolve([]).then(r) }) }) }) };

describe("assembleContext relevance memory", () => {
  it("includes only the injected relevant approved items, not a blind dump", async () => {
    const memorySearch = vi.fn(async (_q:string)=>([{ title:"Refund policy", content:"30 day window", layer:"domain" }]));
    const out = await contextAssemblyService(db).assembleContext("c1", {
      systemInstructions: "P",
      relevanceQuery: "how do refunds work",
      memorySearch,
    });
    expect(memorySearch).toHaveBeenCalledWith("how do refunds work");
    expect(out.systemPrompt).toContain("Refund policy");
    expect(out.systemPrompt).toContain("30 day window");
  });
  it("omits the memory section when search yields nothing / throws (graceful)", async () => {
    const out = await contextAssemblyService(db).assembleContext("c1", {
      systemInstructions:"P", relevanceQuery:"x", memorySearch: async ()=>{ throw new Error("no key"); },
    });
    expect(out.systemPrompt).toContain("P");
  });
  it("formats pre-filtered memoryItems without invoking memorySearch", async () => {
    const memorySearch = vi.fn(async () => []);
    const out = await contextAssemblyService(db).assembleContext("c1", {
      systemInstructions: "P",
      relevanceQuery: "refunds",
      memorySearch,
      memoryItems: [{ title: "Refund policy", content: "30 day window", layer: "identity" }],
    });

    expect(memorySearch).not.toHaveBeenCalled();
    expect(out.systemPrompt).toContain("Refund policy");
    expect(out.systemPrompt).toContain("30 day window");
    expect(out.systemPrompt).toContain("[identity/scoped/approved/company]");
  });

  it("labels approved working memory and hides pending or expired items", async () => {
    const out = await contextAssemblyService(db).assembleContext("c1", {
      systemInstructions: "P",
      relevanceQuery: "scratch",
      memoryItems: [
        {
          title: "Current onboarding concern",
          content: "User is evaluating UI context.",
          layer: "working",
          visibility: "scoped",
          status: "approved",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          taskId: "task-1",
        },
        {
          title: "Pending memory",
          content: "pending memory content",
          layer: "domain",
          visibility: "shared",
          status: "pending",
        },
        {
          title: "Expired memory",
          content: "expired memory content",
          layer: "working",
          visibility: "scoped",
          status: "approved",
          expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
          taskId: "task-1",
        },
      ],
    });

    expect(out.systemPrompt).toContain("[working/scoped/approved/expires");
    expect(out.systemPrompt).toContain("/task]");
    expect(out.systemPrompt).toContain("Current onboarding concern");
    expect(out.systemPrompt).not.toContain("pending memory content");
    expect(out.systemPrompt).not.toContain("expired memory content");
  });
});
