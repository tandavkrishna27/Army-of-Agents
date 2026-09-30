import { describe, expect, it, vi } from "vitest";
vi.mock("drizzle-orm", () => ({ and: vi.fn((...a:any)=>({and:a})), eq: vi.fn((a:any,b:any)=>({eq:[a,b]})), desc: vi.fn((x:any)=>x), gt: vi.fn((a:any,b:any)=>({gt:[a,b]})), sql: Object.assign(()=>({}), { raw:()=>({}) }) }));
vi.mock("@armyofagents/db", () => ({ internalAgentConversations: {}, internalAgentMessages: { conversationId: "cid", id: "id", createdAt: "createdAt" } }));
import { conversationService } from "../services/internal-agent/conversation.js";

describe("getMessagesSince", () => {
  it("returns chronological messages strictly after the marker createdAt", async () => {
    const markerDate = new Date("2026-01-01T00:00:00Z");
    let callCount = 0;
    const db: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            // First call: marker lookup → returns the marker row
            // Second call (orderBy chain): returns message rows
            orderBy: () => ({ limit: () => ({ then: (r:any)=>Promise.resolve([{id:"m3"},{id:"m2"}]).then(r) }) }),
            then: (r:any) => { callCount++; return Promise.resolve([{createdAt: markerDate}]).then(r); },
          }),
        }),
      }),
    };
    const out = await conversationService(db).getMessagesSince("conv1", "m1", 50);
    expect(out.map((m:any)=>m.id)).toEqual(["m2","m3"]);
  });

  it("returns all messages when sinceMessageId is null", async () => {
    const db: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => ({ then: (r:any)=>Promise.resolve([{id:"m2"},{id:"m1"}]).then(r) }) }),
          }),
        }),
      }),
    };
    const out = await conversationService(db).getMessagesSince("conv1", null, 50);
    expect(out.map((m:any)=>m.id)).toEqual(["m1","m2"]);
  });
});
