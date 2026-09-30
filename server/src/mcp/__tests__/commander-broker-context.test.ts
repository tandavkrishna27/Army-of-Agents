import { describe, it, expect } from "vitest";
import { resolveCommanderBrokerToolContext } from "../broker-tool-context.js";

// Minimal drizzle-select stub: .select().from().where().limit() → the config row.
function dbReturning(row: unknown) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = async () => (row ? [row] : []);
  chain.then = (res: (rows: unknown[]) => unknown) => res(row ? [row] : []);
  return chain;
}

describe("resolveCommanderBrokerToolContext", () => {
  it("builds a commander ToolContext with NO agents-row lookup", async () => {
    const ctx = await resolveCommanderBrokerToolContext({
      db: dbReturning({
        commanderToolPermissions: {
          create_task: { enabled: true, requireConfirmation: true, minimumRole: "team_member" },
        },
        runtimeApprovalsEnabled: true,
        enabledCapabilities: ["system_actions", "memory_management"],
      }) as never,
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      conversationId: "conv1",
    });
    expect(ctx.actorType).toBe("commander");
    expect(ctx.agentKind).toBeUndefined();
    expect(ctx.toolAllowlist).toEqual([]);
    expect(ctx.companyId).toBe("c1");
    expect(ctx.userId).toBe("u1");
    expect(ctx.userRole).toBe("founder");
    expect(ctx.conversationId).toBe("conv1");
    expect(ctx.runtimeApprovalsEnabled).toBe(true);
    expect(ctx.commanderToolPermissions).toMatchObject({ create_task: { enabled: true } });
    expect(ctx.enabledCapabilities).toContain("system_actions");
    // Parity with the in-process bridge shape: db + services present.
    expect(ctx.db).toBeDefined();
    expect(ctx.services).toBeDefined();
  });

  it("defaults runtimeApprovalsEnabled to true and permissions to null when config is absent", async () => {
    const ctx = await resolveCommanderBrokerToolContext({
      db: dbReturning(null) as never,
      companyId: "c1",
      userId: "u1",
      userRole: "team_member",
      conversationId: "conv1",
    });
    expect(ctx.runtimeApprovalsEnabled).toBe(true);
    expect(ctx.commanderToolPermissions).toBeNull();
    expect(ctx.enabledCapabilities).toEqual([]);
  });
});
