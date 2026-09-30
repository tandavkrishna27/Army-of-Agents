import { beforeEach, describe, expect, it, vi } from "vitest";
const { eqMock, andMock, seedMock } = vi.hoisted(() => ({
  eqMock: vi.fn((a:unknown,b:unknown)=>({eq:[a,b]})),
  andMock: vi.fn((...a:unknown[])=>({and:a})),
  seedMock: vi.fn().mockResolvedValue({ seeded: true }),
}));
vi.mock("drizzle-orm", () => ({ and: andMock, eq: eqMock }));
// Task #39 fix: resolveCrewAdapterForCompany (introduced by P1-B fix) reads
// internalAgentConfig from @armyofagents/db; mocks must expose that table or
// import-time resolution throws "No internalAgentConfig export".
vi.mock("@armyofagents/db", () => { const t=(n:string)=>new Proxy({},{get:(_x,p)=>typeof p==="string"?Symbol(`${n}.${p}`):undefined}); return { agents:t("agents"), aoaAgentTriggers:t("agt"), internalAgentConfig:t("iac") }; });
vi.mock("../services/internal-agent/aoa-agents/seed-commander-bundle.js", () => ({
  seedRoleInstructionBundle: (...a: unknown[]) => seedMock(...a),
  seedCommanderInstructionBundle: vi.fn(),
}));
vi.mock("../services/agent-instructions.js", () => ({ agentInstructionsService: () => ({}) }));
import { ensureExtractionAgent, EXTRACTION_AGENT_NAME, EXTRACTION_AGENT_TOOL_ALLOWLIST } from "../services/internal-agent/aoa-agents/ensure-extraction-agent.js";
// Task #39 fix: chain helper now includes `.limit(N)` so the resolveCrewAdapterForCompany
// path (P1-B fix's new SELECT) doesn't blow up with "db.select(...).from(...).where(...).limit is not a function".
function sel(rows:unknown[]){const c:any={};c.from=()=>c;c.where=()=>c;c.limit=()=>c;c.then=(r:(v:unknown[])=>unknown)=>Promise.resolve(rows).then(r);return c;}
describe("ensureExtractionAgent", () => {
  beforeEach(() => { eqMock.mockClear(); andMock.mockClear(); seedMock.mockClear(); });
  it("creates kind='aoa' member + enabled outbox trigger + seeded instruction + toolAllowlist", async () => {
    const av:any[]=[]; const tv:any[]=[]; let n=0;
    const db:any = { select:()=>sel([]), insert:()=>{const w=n++;return{values:(v:any)=>{(w===0?av:tv).push(v);return{returning:()=>Promise.resolve([{id:w===0?"ext-1":"trg-1"}])};}};} };
    const id = await ensureExtractionAgent(db,"co-1");
    expect(id).toBe("ext-1");
    expect(av[0].kind).toBe("aoa"); expect(av[0].role).toBe("general");
    expect(av[0].runtimeConfig.aoa.role).toBe("member");
    expect(typeof av[0].runtimeConfig.aoa.instruction).toBe("string");
    expect(av[0].runtimeConfig.aoa.instruction).toContain("submit_extracted_items");
    // D2: toolAllowlist must be set to exactly submit_extracted_items
    expect(av[0].runtimeConfig.aoa.toolAllowlist).toEqual([...EXTRACTION_AGENT_TOOL_ALLOWLIST]);
    expect(tv[0].kind).toBe("outbox");
    expect(tv[0].config).toEqual({ source: "discussion_entry_pending" });
  });
  it("idempotent: existing row with toolAllowlist → no insert, no D2-backfill update", async () => {
    const insert = vi.fn();
    const updateSets: any[] = [];
    const update = vi.fn(() => ({ set: (v: any) => { updateSets.push(v); return { where: () => Promise.resolve([]) }; } }));
    const existingRc = { aoa: { role: "member", toolAllowlist: ["submit_extracted_items"] }, heartbeat: { enabled:false, intervalSec:0 } };
    const db:any = { select:()=>sel([{id:"ext-x", runtimeConfig: existingRc}]), insert, update };
    expect(await ensureExtractionAgent(db,"co-1")).toBe("ext-x");
    expect(insert).not.toHaveBeenCalled();
    // D2 backfill (runtimeConfig) must not fire when toolAllowlist already set.
    // Seeding (adapterConfig) is a separate expected update.
    expect(updateSets.some((v) => v.runtimeConfig)).toBe(false);
  });
  it("D2 backfill: existing row without toolAllowlist → merges toolAllowlist", async () => {
    const agentUpdateVals:any[]=[];
    const existingRc = { aoa: { role: "member", instruction: "extract" }, heartbeat: { enabled:false, intervalSec:0 } };
    const db:any = {
      select:()=>sel([{id:"ext-old", runtimeConfig: existingRc}]),
      insert: vi.fn(),
      update:()=>({set:(v:any)=>{agentUpdateVals.push(v);return{where:()=>Promise.resolve([])};}}),
    };
    expect(await ensureExtractionAgent(db,"co-1")).toBe("ext-old");
    const agentRcUpdate = agentUpdateVals.find((v:any)=>v.runtimeConfig);
    expect(agentRcUpdate).toBeDefined();
    expect(agentRcUpdate.runtimeConfig.aoa.toolAllowlist).toEqual([...EXTRACTION_AGENT_TOOL_ALLOWLIST]);
    // existing fields preserved
    expect(agentRcUpdate.runtimeConfig.aoa.role).toBe("member");
    expect(agentRcUpdate.runtimeConfig.aoa.instruction).toBe("extract");
  });
});
