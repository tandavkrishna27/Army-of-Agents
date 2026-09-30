import { describe, expect, it, vi } from "vitest";
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn(), desc: vi.fn(), gt: vi.fn(), sql: Object.assign((s?:any)=>s,{ }) }));
vi.mock("@armyofagents/db", () => ({ internalAgentConversations: {}, internalAgentMessages: {} }));
import { conversationService } from "../services/internal-agent/conversation.js";

describe("summarizeIfNeeded injectable summarizer", () => {
  it("calls the injected summarize() with the old-message transcript and stores the result", async () => {
    let updated:any=null;
    const old = Array.from({length:25},(_,i)=>({ id:`m${i}`, role:"user", content:`msg${i}` }));
    const db:any = {
      select: (proj?:any) => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ then:(r:any)=>Promise.resolve(old.slice(0,5)).then(r) }) }), then:(r:any)=>Promise.resolve(proj?[{count:25}]:old).then(r) }) }) }),
      update: () => ({ set:(v:any)=>{ updated=v; return { where: ()=>Promise.resolve([]) }; } }),
    };
    const summarize = vi.fn(async (t:string)=>`SUM(${t.length})`);
    await conversationService(db).summarizeIfNeeded("conv1", summarize);
    expect(summarize).toHaveBeenCalled();
    expect(updated.summarizedContext).toMatch(/^SUM\(/);
  });
});
