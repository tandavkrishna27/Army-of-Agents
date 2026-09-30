import { describe, it, expect, vi } from "vitest";
import { roleToAgentName, resolveRoleToAgentId } from "../services/internal-agent/tools/crew-role-map.js";

describe("roleToAgentName (pure)", () => {
  it("maps known crew roles to agent names (case/space-insensitive)", () => {
    expect(roleToAgentName("engineer")).toBe("Engineer");
    expect(roleToAgentName(" Engineer ")).toBe("Engineer");
    expect(roleToAgentName("SCOUT")).toBe("Scout");
    expect(roleToAgentName("memory_keeper")).toBe("Memory Keeper");
    expect(roleToAgentName("maker")).toBe("Maker"); // legacy alias
    expect(roleToAgentName("router")).toBe("Navigator"); // legacy alias
  });

  it("returns undefined for unknown/empty roles", () => {
    expect(roleToAgentName("designer")).toBeUndefined();
    expect(roleToAgentName("")).toBeUndefined();
  });
});

describe("resolveRoleToAgentId (db lookup)", () => {
  function dbReturning(rows: Array<{ id: string }>) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => rows }),
        }),
      }),
    };
  }

  it("returns the agent id for a known role with a matching agent", async () => {
    const id = await resolveRoleToAgentId(dbReturning([{ id: "agent-eng" }]), "co-1", "engineer");
    expect(id).toBe("agent-eng");
  });

  it("returns undefined for an unknown role without touching the db", async () => {
    const select = vi.fn();
    const id = await resolveRoleToAgentId({ select }, "co-1", "designer");
    expect(id).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("returns undefined when no agent matches", async () => {
    const id = await resolveRoleToAgentId(dbReturning([]), "co-1", "engineer");
    expect(id).toBeUndefined();
  });
});
