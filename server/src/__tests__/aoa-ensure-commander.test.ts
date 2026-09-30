import { beforeEach, describe, expect, it, vi } from "vitest";
const { eqMock, andMock, seedBundleFn } = vi.hoisted(() => ({
  eqMock: vi.fn((a:unknown,b:unknown)=>({eq:[a,b]})),
  andMock: vi.fn((...a:unknown[])=>({and:a})),
  seedBundleFn: vi.fn(async (_args: any) => ({ instructionsBundle: { mode: "managed" } } as Record<string, unknown>)),
}));
vi.mock("drizzle-orm", () => ({ and: andMock, eq: eqMock }));
vi.mock("@armyofagents/db", () => { const t=(n:string)=>new Proxy({},{get:(_x,p)=>typeof p==="string"?Symbol(`${n}.${p}`):undefined}); return { agents:t("agents"), internalAgentConfig:t("iac") }; });
vi.mock("../services/internal-agent/aoa-agents/seed-commander-bundle.js", () => ({ seedCommanderInstructionBundle: seedBundleFn }));
vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: vi.fn(() => ({
    ensureWritableBundle: vi.fn(async () => ({ adapterConfig: { instructionsBundle: { mode: "managed" } }, state: { rootPath: null, entryFile: "AGENTS.md" } })),
  })),
}));
import { ensureCommanderAgent, COMMANDER_TOOL_ALLOWLIST } from "../services/internal-agent/aoa-agents/ensure-commander.js";
function sel(rows:unknown[]){const c:any={};c.from=()=>c;c.where=()=>c;c.limit=()=>c;c.then=(r:(v:unknown[])=>unknown)=>Promise.resolve(rows).then(r);return c;}
describe("ensureCommanderAgent", () => {
  beforeEach(() => { eqMock.mockClear(); andMock.mockClear(); seedBundleFn.mockClear(); });
  it("default Commander allowlist includes human discovery and context tools", () => {
    expect(COMMANDER_TOOL_ALLOWLIST).toContain("find_humans");
    expect(COMMANDER_TOOL_ALLOWLIST).toContain("query_human_context");
  });

  it("returns existing commander id, no insert (complete toolAllowlist already set -> no update)", async () => {
    // With atomic INSERT ON CONFLICT, insert is always attempted but returns [] on conflict.
    // The fallback SELECT then finds the existing commander.
    const insert = vi.fn(()=>({values:()=>({onConflictDoNothing:()=>({returning:()=>Promise.resolve([])})})}));
    const setCalls: Array<Record<string, unknown>> = [];
    const update = vi.fn(()=>({set:(v:Record<string, unknown>)=>{setCalls.push(v);return{where:()=>Promise.resolve([])};}}));
    const existingRc = { aoa: { role: "lead", toolAllowlist: [...COMMANDER_TOOL_ALLOWLIST] }, heartbeat: { enabled:false, intervalSec:0 } };
    const db:any = { select:()=>sel([{id:"cmd-1", runtimeConfig: existingRc}]), insert, update };
    expect(await ensureCommanderAgent(db,"co-1")).toBe("cmd-1");
    // insert is called (attempt), but the conflict path means no new row was created
    expect(insert).toHaveBeenCalled();
    // Agent row must NOT be updated when the default toolAllowlist is already complete
    const agentRcUpdates = setCalls.filter((s) => "runtimeConfig" in s);
    expect(agentRcUpdates).toHaveLength(0);
    // Only the internalAgentConfig.agentId link update is expected
    const configLinkUpdates = setCalls.filter((s) => "agentId" in s);
    expect(configLinkUpdates).toHaveLength(1);
  });
  it("D2 backfill: existing row with partial toolAllowlist -> merges missing Commander tools", async () => {
    const agentUpdateVals:any[]=[];
    const existingRc = { aoa: { role: "lead", toolAllowlist: ["delegate_to_subagent", "custom_tool"] }, heartbeat: { enabled:false, intervalSec:0 } };
    const db:any = {
      select:()=>sel([{id:"cmd-partial", runtimeConfig: existingRc}]),
      insert: vi.fn(()=>({values:()=>({onConflictDoNothing:()=>({returning:()=>Promise.resolve([])})})})),
      update:()=>({set:(v:any)=>{agentUpdateVals.push(v);return{where:()=>Promise.resolve([])};}}),
    };
    expect(await ensureCommanderAgent(db,"co-1")).toBe("cmd-partial");
    const agentRcUpdate = agentUpdateVals.find((v:any)=>v.runtimeConfig);
    expect(agentRcUpdate).toBeDefined();
    expect(agentRcUpdate.runtimeConfig.aoa.toolAllowlist).toEqual([
      "delegate_to_subagent",
      "custom_tool",
      ...COMMANDER_TOOL_ALLOWLIST.filter((tool) => tool !== "delegate_to_subagent"),
    ]);
    expect(agentRcUpdate.runtimeConfig.aoa.toolAllowlist).toContain("find_humans");
    expect(agentRcUpdate.runtimeConfig.aoa.toolAllowlist).toContain("query_human_context");
    expect(agentRcUpdate.runtimeConfig.aoa.role).toBe("lead");
  });
  it("creates kind='aoa' role='general' runtimeConfig.aoa.role='lead' + toolAllowlist + links config", async () => {
    const av:any[]=[]; const sv:any[]=[];
    const db:any = { select:()=>sel([]), insert:()=>({values:(v:any)=>{av.push(v);return{onConflictDoNothing:()=>({returning:()=>Promise.resolve([{id:"cmd-new"}])})};}}), update:()=>({set:(v:any)=>{sv.push(v);return{where:()=>Promise.resolve([])};}}) };
    expect(await ensureCommanderAgent(db,"co-1")).toBe("cmd-new");
    expect(av[0].kind).toBe("aoa");
    expect(av[0].role).toBe("general");
    // D2: toolAllowlist must be present and include delegate_to_subagent
    expect(av[0].runtimeConfig.aoa.role).toBe("lead");
    expect(Array.isArray(av[0].runtimeConfig.aoa.toolAllowlist)).toBe(true);
    expect(av[0].runtimeConfig.aoa.toolAllowlist).toContain("delegate_to_subagent");
    expect(av[0].runtimeConfig.aoa.toolAllowlist).toEqual([...COMMANDER_TOOL_ALLOWLIST]);
    expect(av[0].runtimeConfig.heartbeat).toEqual({ enabled:false, intervalSec:0 });
    expect(sv.some((s)=>s.agentId==="cmd-new")).toBe(true);
  });
  it("D2 backfill: existing row without toolAllowlist → merges toolAllowlist", async () => {
    const agentUpdateVals:any[]=[];
    const existingRc = { aoa: { role: "lead" }, heartbeat: { enabled:false, intervalSec:0 } };
    const db:any = {
      select:()=>sel([{id:"cmd-old", runtimeConfig: existingRc}]),
      // Conflict path: insert returns [] so fallback SELECT is used to find the existing row
      insert: vi.fn(()=>({values:()=>({onConflictDoNothing:()=>({returning:()=>Promise.resolve([])})})})),
      update:()=>({set:(v:any)=>{agentUpdateVals.push(v);return{where:()=>Promise.resolve([])};}}),
    };
    expect(await ensureCommanderAgent(db,"co-1")).toBe("cmd-old");
    // Should have updated the agent row with toolAllowlist
    const agentRcUpdate = agentUpdateVals.find((v:any)=>v.runtimeConfig);
    expect(agentRcUpdate).toBeDefined();
    expect(Array.isArray(agentRcUpdate.runtimeConfig.aoa.toolAllowlist)).toBe(true);
    expect(agentRcUpdate.runtimeConfig.aoa.toolAllowlist).toContain("delegate_to_subagent");
    // role must be preserved
    expect(agentRcUpdate.runtimeConfig.aoa.role).toBe("lead");
  });
  it("Task 5b: Commander row follows cliTool, NOT crew provider (claude_cli + provider=openai → claude_local)", async () => {
    // resolveCommanderAdapterForCompany runs real against this mock db and selects
    // cliTool + model. cliTool='claude_cli' (Commander's CLI) must win even though
    // the crew provider is 'openai' — proving Commander follows its own CLI.
    const av: any[] = [];
    const db: any = {
      select: () => sel([{ cliTool: "claude_cli", provider: "openai", model: null }]),
      insert: () => ({ values: (v: any) => { av.push(v); return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: "cmd-new" }]) }) }; } }),
      update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }),
    };
    expect(await ensureCommanderAgent(db, "co-1")).toBe("cmd-new");
    expect(av[0].adapterType).toBe("claude_local");
    expect(av[0].adapterType).not.toBe("codex_local");
  });
  it("seeds the commander instruction bundle and persists the linked adapterConfig", async () => {
    const setCalls: unknown[] = [];
    const db = {
      select: () => sel([{ id: "cmd1", runtimeConfig: { aoa: { toolAllowlist: ["x"] } }, companyId: "c1", name: "Commander", adapterConfig: {} }]),
      update: () => ({ set: (v: unknown) => { setCalls.push(v); return { where: () => Promise.resolve([]) }; } }),
      insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: () => Promise.resolve([{ id: "cmd1" }]) }) }) }),
    };
    const { ensureCommanderAgent: eca } = await import("../services/internal-agent/aoa-agents/ensure-commander.js");
    const id = await eca(db as any, "c1");
    expect(id).toBe("cmd1");
    expect(seedBundleFn).toHaveBeenCalled();
    const calledAgentId = seedBundleFn.mock.calls[0]?.[0]?.agent?.id;
    expect(calledAgentId).toBe("cmd1");
    expect(setCalls.some((c: any) => c.adapterConfig?.instructionsBundle)).toBe(true);
  });
});
