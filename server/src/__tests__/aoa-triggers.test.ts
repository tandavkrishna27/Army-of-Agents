import { beforeEach, describe, expect, it, vi } from "vitest";
const { eqMock, andMock } = vi.hoisted(() => ({ eqMock: vi.fn((a:unknown,b:unknown)=>({eq:[a,b]})), andMock: vi.fn((...a:unknown[])=>({and:a})) }));
vi.mock("drizzle-orm", () => ({ and: andMock, eq: eqMock }));
vi.mock("@armyofagents/db", () => { const t=(n:string)=>new Proxy({},{get:(_x,p)=>typeof p==="string"?Symbol(`${n}.${p}`):undefined}); return { aoaAgentTriggers:t("agt"), agents:t("a") }; });
import { listEnabledOutboxAgents } from "../services/internal-agent/aoa-agents/triggers.js";
function sel(rows:unknown[]){const c:any={};c.from=()=>c;c.innerJoin=()=>c;c.where=()=>c;c.then=(r:(v:unknown[])=>unknown)=>Promise.resolve(rows).then(r);return c;}
describe("aoa triggers", () => {
  beforeEach(()=>{eqMock.mockClear();andMock.mockClear();});
  it("returns non-paused agents with an enabled outbox trigger for a company", async () => {
    const db:any = { select:()=>sel([{agentId:"ext-1",status:"idle"},{agentId:"ext-2",status:"paused"}]) };
    expect(await listEnabledOutboxAgents(db,"co-1")).toEqual(["ext-1"]);
  });
});
