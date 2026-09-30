import { describe, it, expect, vi } from "vitest";

// Mock drizzle-orm and @armyofagents/db to avoid ESM cycle in test env
vi.mock("drizzle-orm", () => ({
  eq: (..._args: unknown[]) => "eq",
  and: (..._args: unknown[]) => "and",
  ne: (..._args: unknown[]) => "ne",
  isNull: (..._args: unknown[]) => "isNull",
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    marketplacePendingUpdates: makeTable("marketplace_pending_updates"),
    companySkills: makeTable("company_skills"),
    userRoles: makeTable("user_roles"),
  };
});

// Pure function import — no drizzle calls in canInstallType
import { canInstallType, resolveInstallDecision } from "../routes/marketplace-installs.js";

describe("canInstallType", () => {
  it("founder can install all types", () => {
    expect(canInstallType("founder", "skill", false)).toBe(true);
    expect(canInstallType("founder", "plugin", false)).toBe(true);
    expect(canInstallType("founder", "agent", false)).toBe(true);
    expect(canInstallType("founder", "team", false)).toBe(true);
  });

  it("team_lead can install skill/agent/team", () => {
    expect(canInstallType("team_lead", "skill", false)).toBe(true);
    expect(canInstallType("team_lead", "agent", false)).toBe(true);
    expect(canInstallType("team_lead", "team", false)).toBe(true);
  });

  it("team_lead cannot install plugin by default", () => {
    expect(canInstallType("team_lead", "plugin", false)).toBe(false);
  });

  it("team_lead can install plugin when allowTeamLeadPlugins=true", () => {
    expect(canInstallType("team_lead", "plugin", true)).toBe(true);
  });

  it("team_member cannot install anything", () => {
    expect(canInstallType("team_member", "skill", false)).toBe(false);
    expect(canInstallType("team_member", "plugin", true)).toBe(false);
  });
});

describe("resolveInstallDecision", () => {
  it("returns 'allow' when canInstallType passes", () => {
    expect(resolveInstallDecision("founder", "plugin", { allowTeamLeadPlugins: false, teamMemberCanRequestInstall: false })).toBe("allow");
    expect(resolveInstallDecision("team_lead", "skill", { allowTeamLeadPlugins: false, teamMemberCanRequestInstall: false })).toBe("allow");
  });

  it("returns 'request' for team_member when teamMemberCanRequestInstall=true", () => {
    expect(resolveInstallDecision("team_member", "skill", { allowTeamLeadPlugins: false, teamMemberCanRequestInstall: true })).toBe("request");
    expect(resolveInstallDecision("team_member", "plugin", { allowTeamLeadPlugins: true, teamMemberCanRequestInstall: true })).toBe("request");
  });

  it("returns 'deny' for team_member when teamMemberCanRequestInstall=false", () => {
    expect(resolveInstallDecision("team_member", "skill", { allowTeamLeadPlugins: false, teamMemberCanRequestInstall: false })).toBe("deny");
  });

  it("returns 'deny' for team_lead trying to install plugin without allowTeamLeadPlugins", () => {
    expect(resolveInstallDecision("team_lead", "plugin", { allowTeamLeadPlugins: false, teamMemberCanRequestInstall: false })).toBe("deny");
  });
});
