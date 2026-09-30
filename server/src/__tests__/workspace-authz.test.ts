import { describe, expect, it, vi } from "vitest";
import type { Request } from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  userRoles: {
    id: "ur_id",
    companyId: "ur_company_id",
    userId: "ur_user_id",
    role: "ur_role",
    projectId: "ur_project_id",
  },
}));

// ── Import the unit under test ───────────────────────────────────────────────

import {
  assertCanControlWorkspace,
  checkCanControlWorkspace,
} from "../services/workspace-authz.js";
import { HttpError } from "../errors.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(actor: any): Request {
  return { actor } as unknown as Request;
}

/**
 * Minimal DB stub matching the shape used in workspace-authz: `db.select(...).from(...).where(...)`
 * where `where` resolves to the rows array.
 */
function makeDb(rolesRows: Array<{ role: string; projectId: string | null }>) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rolesRows),
  };
  return {
    select: vi.fn().mockReturnValue(chain),
    __chain: chain,
  } as any;
}

const WS_WITH_PROJECT = Object.freeze({ companyId: "co-1", projectId: "proj-1" });
const WS_NO_PROJECT = Object.freeze({ companyId: "co-1", projectId: null as string | null });

// ── checkCanControlWorkspace ─────────────────────────────────────────────────

describe("checkCanControlWorkspace", () => {
  it("rejects unauthenticated actors with 401 and does not touch the DB", async () => {
    const db = makeDb([]);
    const req = makeReq({ type: "none", source: "none" });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({
      allowed: false,
      status: 401,
      message: "Authentication required",
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("allows agent actors without a DB lookup", async () => {
    const db = makeDb([]);
    const req = makeReq({
      type: "agent",
      agentId: "agent-1",
      companyId: "co-1",
      source: "agent_key",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({
      allowed: false,
      status: 403,
      message: "Insufficient permissions to control this workspace",
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects mcp actors without a DB lookup", async () => {
    const db = makeDb([]);
    const req = makeReq({
      type: "mcp",
      userId: "user-1",
      companyId: "co-1",
      keyId: "key-1",
      source: "mcp_key",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({
      allowed: false,
      status: 403,
      message: "Insufficient permissions to control this workspace",
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("allows local_implicit board actors without a DB lookup", async () => {
    const db = makeDb([]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "local_implicit",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({ allowed: true });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("allows instance admins without a DB lookup", async () => {
    const db = makeDb([]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: true,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({ allowed: true });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("rejects board users with no role row in the company", async () => {
    const db = makeDb([]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({
      allowed: false,
      status: 403,
      message: "Insufficient permissions to control this workspace",
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("allows founders regardless of projectId scope", async () => {
    const db = makeDb([{ role: "founder", projectId: null }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({ allowed: true });
  });

  it("allows team_leads scoped to the workspace's project", async () => {
    const db = makeDb([{ role: "team_lead", projectId: "proj-1" }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({ allowed: true });
  });

  it("rejects team_leads scoped to a different project", async () => {
    const db = makeDb([{ role: "team_lead", projectId: "proj-other" }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({
      allowed: false,
      status: 403,
      message: "Insufficient permissions to control this workspace",
    });
  });

  it("allows company-wide team_leads (projectId = null)", async () => {
    const db = makeDb([{ role: "team_lead", projectId: null }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({ allowed: true });
  });

  it("rejects team_members only", async () => {
    const db = makeDb([{ role: "team_member", projectId: "proj-1" }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({
      allowed: false,
      status: 403,
      message: "Insufficient permissions to control this workspace",
    });
  });

  it("rejects scoped team_leads when the workspace has no projectId", async () => {
    const db = makeDb([{ role: "team_lead", projectId: "proj-1" }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_NO_PROJECT);

    expect(result).toEqual({
      allowed: false,
      status: 403,
      message: "Insufficient permissions to control this workspace",
    });
  });

  it("allows company-wide team_leads on a workspace with no projectId", async () => {
    const db = makeDb([{ role: "team_lead", projectId: null }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_NO_PROJECT);

    expect(result).toEqual({ allowed: true });
  });

  it("allows founders on a workspace with no projectId", async () => {
    const db = makeDb([{ role: "founder", projectId: null }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_NO_PROJECT);

    expect(result).toEqual({ allowed: true });
  });

  it("prefers founder when a user has multiple rows (founder wins)", async () => {
    const db = makeDb([
      { role: "team_member", projectId: "proj-1" },
      { role: "founder", projectId: null },
    ]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanControlWorkspace(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({ allowed: true });
  });
});

// ── assertCanControlWorkspace ────────────────────────────────────────────────

describe("assertCanControlWorkspace", () => {
  it("throws HttpError(401) for unauthenticated actors", async () => {
    const db = makeDb([]);
    const req = makeReq({ type: "none", source: "none" });

    await expect(assertCanControlWorkspace(db, req, WS_WITH_PROJECT))
      .rejects.toBeInstanceOf(HttpError);
    await expect(assertCanControlWorkspace(db, req, WS_WITH_PROJECT))
      .rejects.toMatchObject({ status: 401, message: "Authentication required" });
  });

  it("throws HttpError(403) for board users without a matching role", async () => {
    const db = makeDb([]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    await expect(assertCanControlWorkspace(db, req, WS_WITH_PROJECT))
      .rejects.toBeInstanceOf(HttpError);
    await expect(assertCanControlWorkspace(db, req, WS_WITH_PROJECT))
      .rejects.toMatchObject({
        status: 403,
        message: "Insufficient permissions to control this workspace",
      });
  });

  it("throws HttpError(403) for team_leads scoped to a different project", async () => {
    const db = makeDb([{ role: "team_lead", projectId: "proj-other" }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    await expect(assertCanControlWorkspace(db, req, WS_WITH_PROJECT))
      .rejects.toMatchObject({ status: 403 });
  });

  it("does not throw for founders", async () => {
    const db = makeDb([{ role: "founder", projectId: null }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    await expect(assertCanControlWorkspace(db, req, WS_WITH_PROJECT)).resolves.toBeUndefined();
  });

  it("does not throw for in-scope team_leads", async () => {
    const db = makeDb([{ role: "team_lead", projectId: "proj-1" }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    await expect(assertCanControlWorkspace(db, req, WS_WITH_PROJECT)).resolves.toBeUndefined();
  });

  it("throws HttpError(403) for agents and mcp actors", async () => {
    const db = makeDb([]);
    const cases = [
      { type: "agent", agentId: "a", companyId: "co-1", source: "agent_key" },
      { type: "mcp", userId: "u", companyId: "co-1", keyId: "k", source: "mcp_key" },
    ];
    for (const actor of cases) {
      await expect(assertCanControlWorkspace(db, makeReq(actor), WS_WITH_PROJECT))
        .rejects.toMatchObject({
          status: 403,
          message: "Insufficient permissions to control this workspace",
        });
    }
  });

  it("does not throw for local_implicit board actors or instance admins", async () => {
    const db = makeDb([]);
    const cases = [
      {
        type: "board",
        userId: "u",
        companyIds: ["co-1"],
        isInstanceAdmin: false,
        source: "local_implicit",
      },
      {
        type: "board",
        userId: "u",
        companyIds: ["co-1"],
        isInstanceAdmin: true,
        source: "session",
      },
    ];
    for (const actor of cases) {
      await expect(assertCanControlWorkspace(db, makeReq(actor), WS_WITH_PROJECT))
        .resolves.toBeUndefined();
    }
  });
});

describe("workspace shell-command config hardening", () => {
  it("detects command fields in execution workspace config patches", async () => {
    const {
      workspaceConfigPatchHasShellCommands,
    } = await import("../services/workspace-authz.js");

    expect(workspaceConfigPatchHasShellCommands({ provisionCommand: "pnpm install" })).toBe(true);
    expect(workspaceConfigPatchHasShellCommands({ teardownCommand: null })).toBe(true);
    expect(workspaceConfigPatchHasShellCommands({ cleanupCommand: "" })).toBe(true);
    expect(workspaceConfigPatchHasShellCommands({
      workspaceRuntime: {
        services: [
          { name: "web" },
          { name: "api", command: "pnpm dev" },
        ],
      },
    })).toBe(true);
    expect(workspaceConfigPatchHasShellCommands({
      desiredState: "running",
      workspaceRuntime: { services: [{ name: "web" }] },
    })).toBe(false);
    expect(workspaceConfigPatchHasShellCommands(null)).toBe(false);
  });

  it("allows founder board users to configure workspace shell commands", async () => {
    const {
      checkCanConfigureWorkspaceShellCommands,
    } = await import("../services/workspace-authz.js");
    const db = makeDb([{ role: "founder", projectId: null }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanConfigureWorkspaceShellCommands(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({ allowed: true });
  });

  it("rejects team leads for workspace shell command configuration", async () => {
    const {
      checkCanConfigureWorkspaceShellCommands,
    } = await import("../services/workspace-authz.js");
    const db = makeDb([{ role: "team_lead", projectId: "proj-1" }]);
    const req = makeReq({
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      isInstanceAdmin: false,
      source: "session",
    });

    const result = await checkCanConfigureWorkspaceShellCommands(db, req, WS_WITH_PROJECT);

    expect(result).toEqual({
      allowed: false,
      status: 403,
      message: "Only founders can configure workspace shell commands",
    });
  });

  it("rejects agent and mcp actors for workspace shell command configuration without a DB lookup", async () => {
    const {
      checkCanConfigureWorkspaceShellCommands,
    } = await import("../services/workspace-authz.js");
    const cases = [
      { type: "agent", agentId: "a", companyId: "co-1", source: "agent_key" },
      { type: "mcp", userId: "u", companyId: "co-1", keyId: "k", source: "mcp_key" },
    ];

    for (const actor of cases) {
      const db = makeDb([]);
      const result = await checkCanConfigureWorkspaceShellCommands(db, makeReq(actor), WS_WITH_PROJECT);
      expect(result).toEqual({
        allowed: false,
        status: 403,
        message: "Only founders can configure workspace shell commands",
      });
      expect(db.select).not.toHaveBeenCalled();
    }
  });
});
