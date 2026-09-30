/**
 * T2.5 (D23) — `DELETE /api/companies/:companyId/marketplace/teams/:teamId`
 * detaches protected AoA agents instead of destroying them, and must REPORT
 * what it kept. A 200 that silently retained members the caller asked to remove
 * would be the failure mode that made refusing outright look attractive.
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@armyofagents/db", () => {
  const table = (name: string) =>
    new Proxy({}, { get: (_t, prop) => (prop === "__table" ? name : Symbol("col")) });
  return {
    marketplaceInstallOperations: table("marketplace_install_operations"),
    plugins: table("plugins"),
    agents: table("agents"),
    teams: table("teams"),
    teamMembers: table("team_members"),
    aoaAgentTriggers: table("aoa_agent_triggers"),
    companySkills: table("company_skills"),
    projects: table("projects"),
    userRoles: table("user_roles"),
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => ({ __op: "eq" }),
  and: (...args: unknown[]) => ({ __op: "and", args }),
  gt: () => ({ __op: "gt" }),
  isNull: () => ({ __op: "isNull" }),
  inArray: (_col: unknown, ids: string[]) => ({ __op: "inArray", ids }),
}));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
}));
vi.mock("../middleware/rbac.js", () => ({ assertRole: vi.fn().mockResolvedValue(undefined) }));

import { createMarketplaceInstallRouter } from "../routes/marketplace-installs.js";

interface MemberRow {
  agentId: string;
  name: string;
  templateOrigin: string | null;
}

function buildApp(teamRow: Record<string, unknown> | null, memberRows: MemberRow[]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", source: "local_implicit", userId: "u1", companyId: "c1" };
    next();
  });

  const deletedIds: string[] = [];
  const idsIn = (pred: any): string[] | null => {
    if (!pred || typeof pred !== "object") return null;
    if (pred.__op === "inArray") return pred.ids ?? [];
    if (pred.__op === "and") {
      for (const arg of pred.args ?? []) {
        const found = idsIn(arg);
        if (found) return found;
      }
    }
    return null;
  };
  // `returning()` echoes back what the code ASKED to delete, so a retained
  // agent can only be missing because the route's service excluded it.
  const deleted = vi.fn().mockImplementation((table: { __table?: string }) => ({
    where: vi.fn().mockImplementation((pred: unknown) => {
      const ids = idsIn(pred);
      if (table?.__table === "agents" && ids) deletedIds.push(...ids);
      return { returning: vi.fn().mockResolvedValue((ids ?? []).map((id) => ({ id }))) };
    }),
  }));

  const db: any = {
    select: () => ({
      from: (table: { __table?: string }) => {
        if (table?.__table === "teams") {
          return {
            where: () => ({ limit: async () => (teamRow ? [teamRow] : []) }),
          };
        }
        if (table?.__table === "team_members") {
          return { innerJoin: () => ({ where: async () => memberRows }) };
        }
        throw new Error(`unexpected from(${table?.__table ?? "?"})`);
      },
    }),
    delete: deleted,
    insert: () => ({ values: () => ({ returning: async () => [{ id: "op-1" }] }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    transaction: async (cb: any) =>
      cb({
        delete: deleted,
        insert: () => ({ values: () => ({ returning: async () => [{ id: "op-1" }] }) }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      }),
  };

  const router = createMarketplaceInstallRouter({
    db,
    catalogService: {
      readCache: async () => ({ schemaVersion: "1.0.0", generatedAt: "", itemCount: 0, items: [] }),
      sync: async () => ({ schemaVersion: "1.0.0", generatedAt: "", itemCount: 0, items: [] }),
      getStatus: async () => null,
      startSyncLoop: () => {},
      stopSyncLoop: () => {},
    } as any,
    pluginLoader: {} as any,
  });
  app.use("/api/companies/:companyId/marketplace", router);
  return { app, deletedIds };
}

const TEAM_ROW = {
  id: "t-1",
  companyId: "c1",
  templateOrigin: "team:aoa-curated/default-crew",
};

describe("DELETE /marketplace/teams/:teamId — protected agents (D23)", () => {
  it("returns 200, keeps the protected agent, and reports it with a reason", async () => {
    const { app, deletedIds } = buildApp(TEAM_ROW, [
      { agentId: "a-scout", name: "Scout", templateOrigin: "agent:aoa-curated/aoa-scout" },
      { agentId: "a-steward", name: "Steward", templateOrigin: null },
    ]);

    const res = await request(app).delete("/api/companies/c1/marketplace/teams/t-1");

    expect(res.status).toBe(200);
    expect(res.body.deletedAgentIds).toEqual(["a-scout"]);
    expect(res.body.retainedAgentIds).toEqual(["a-steward"]);
    expect(res.body.retainedAgents).toEqual([
      { id: "a-steward", name: "Steward", role: "steward", why: expect.stringMatching(/Inbox Hub/) },
    ]);
    // The founder is never left guessing: the retained agent is never destroyed.
    expect(deletedIds).toEqual(["a-scout"]);
  });

  // Discriminator: the route is not simply retaining every crew member.
  it("destroys every member of a team with no protected agents", async () => {
    const { app, deletedIds } = buildApp(TEAM_ROW, [
      { agentId: "a-scout", name: "Scout", templateOrigin: "agent:aoa-curated/aoa-scout" },
      { agentId: "a-chron", name: "Chronicler", templateOrigin: null },
    ]);

    const res = await request(app).delete("/api/companies/c1/marketplace/teams/t-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      deletedAgentIds: ["a-scout", "a-chron"],
      retainedAgentIds: [],
      retainedAgents: [],
    });
    expect(deletedIds).toEqual(["a-scout", "a-chron"]);
  });

  it("still returns 404 for a missing team", async () => {
    const { app } = buildApp(null, []);

    const res = await request(app).delete("/api/companies/c1/marketplace/teams/t-nope");

    expect(res.status).toBe(404);
  });
});
