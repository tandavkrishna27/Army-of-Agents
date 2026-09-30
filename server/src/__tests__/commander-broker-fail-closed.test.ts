import { describe, it, expect } from "vitest";
import { agents, internalAgentConfig, heartbeatRuns, issues, discussions } from "@armyofagents/db";
import { resolveBrokerToolContext } from "../mcp/broker-tool-context.js";

// -----------------------------------------------------------------------------
// W7.5f Task 1 — the commander branch (W7.5a: resolveCommanderBrokerToolContext,
// a SEPARATE function with NO agents-row lookup) must not have weakened the
// agent resolver's `kind ∈ {aoa,org}` fail-closed (broker-tool-context.ts:181-188).
// This is a regression lock: no production change accompanies it.
// -----------------------------------------------------------------------------

// Table-aware drizzle-select stub. resolveBrokerToolContext runs three query
// shapes: `select().from(agents).where(...)` (awaited, no limit), then
// `select({...}).from(internalAgentConfig).where(...).limit(1)`, then (org only)
// the heartbeatRuns→issues→discussions override chain — each with `.limit(1)`.
// The chain routes rows by the table passed to `.from()` and is BOTH thenable
// (for the agents await) and `.limit()`-able (for the projected selects).
function makeDb(routes: {
  agents?: unknown[];
  config?: unknown[];
  heartbeatRuns?: unknown[];
  issues?: unknown[];
  discussions?: unknown[];
}) {
  let currentTable: unknown = null;
  const rowsFor = (): unknown[] => {
    if (currentTable === agents) return routes.agents ?? [];
    if (currentTable === internalAgentConfig) return routes.config ?? [];
    if (currentTable === heartbeatRuns) return routes.heartbeatRuns ?? [];
    if (currentTable === issues) return routes.issues ?? [];
    if (currentTable === discussions) return routes.discussions ?? [];
    return [];
  };
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = (t: unknown) => { currentTable = t; return chain; };
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(rowsFor());
  // Makes `await db.select().from(agents).where(...)` resolve the agents rows.
  chain.then = (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(rowsFor()).then(res, rej);
  return chain;
}

describe("broker fail-closed survives the commander addition (W7.5f Task 1)", () => {
  it("still throws forbidden for an agent kind not in {aoa,org} (e.g. platform)", async () => {
    const db = makeDb({ agents: [{ id: "a1", companyId: "c1", kind: "platform", runtimeConfig: {}, adapterType: "claude_local", status: "idle" }] });
    await expect(
      resolveBrokerToolContext({ db: db as never, companyId: "c1", agentId: "a1", runId: "run1" }),
    ).rejects.toThrow(/does not serve agent kind/);
  });

  it("still fails closed (cross-tenant) when the agents row's companyId != the requesting company", async () => {
    const db = makeDb({ agents: [{ id: "a1", companyId: "OTHER", kind: "org", runtimeConfig: {}, adapterType: "claude_local", status: "idle" }] });
    await expect(
      resolveBrokerToolContext({ db: db as never, companyId: "c1", agentId: "a1", runId: "run1" }),
    ).rejects.toThrow(/does not match the requesting company/);
  });

  it("an 'org' agent still resolves through the AGENT path (actorType:'agent', agentKind:'org' — NOT the commander branch)", async () => {
    const db = makeDb({
      agents: [{ id: "a1", companyId: "c1", kind: "org", runtimeConfig: {}, adapterType: "claude_local", status: "idle" }],
      config: [{ crewAutonomyLevel: 1 }],
      heartbeatRuns: [], // no context snapshot → override falls back to the company dial (undefined)
    });
    const ctx = await resolveBrokerToolContext({ db: db as never, companyId: "c1", agentId: "a1", runId: "run1" });
    // The commander branch is a DIFFERENT function; the agent resolver is untouched.
    expect(ctx.actorType).toBe("agent");
    expect(ctx.agentKind).toBe("org");
    expect(ctx.companyId).toBe("c1");
    // Org runs are team_member, never founder (broker-tool-context FIX A).
    expect(ctx.userRole).toBe("team_member");
    // Commander-only fields never appear on an agent-resolved context.
    expect(ctx.commanderToolPermissions).toBeUndefined();
  });

  it("an 'aoa' (crew) agent also resolves through the AGENT path (actorType:'agent', agentKind:'aoa')", async () => {
    const db = makeDb({
      agents: [{ id: "a1", companyId: "c1", kind: "aoa", runtimeConfig: { aoa: { toolAllowlist: [] } }, adapterType: "claude_local", status: "idle" }],
      config: [{ crewAutonomyLevel: 2 }],
    });
    const ctx = await resolveBrokerToolContext({ db: db as never, companyId: "c1", agentId: "a1", runId: "run1" });
    expect(ctx.actorType).toBe("agent");
    expect(ctx.agentKind).toBe("aoa");
  });
});
