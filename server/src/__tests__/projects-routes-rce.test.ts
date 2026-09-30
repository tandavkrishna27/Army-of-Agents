import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/index.js", () => ({
  projectService: () => ({
    getById: vi.fn().mockResolvedValue({ id: "p1", companyId: "company-A", name: "P" }),
    update: vi.fn().mockResolvedValue({ id: "p1", companyId: "company-A", name: "P", executionWorkspacePolicy: null }),
    create: vi.fn(),
    resolveByReference: vi.fn().mockResolvedValue({ project: { id: "p1" }, ambiguous: false }),
  }),
  instanceSettingsService: () => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  }),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
    syncEnvBindingsForTarget: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({
    getUserRoles: vi.fn().mockImplementation(async (_c: string, userId: string) => {
      if (userId === "user-fnd") return [{ role: "founder", projectId: null }];
      if (userId === "user-lead") return [{ role: "team_lead", projectId: "p1" }];
      return [{ role: "team_member", projectId: "p1" }];
    }),
    getEffectiveRole: vi.fn().mockImplementation(async (_c: string, userId: string) => {
      if (userId === "user-fnd") return "founder";
      if (userId === "user-lead") return "team_lead";
      return "team_member";
    }),
    isFounder: vi.fn().mockResolvedValue(false),
    isTeamLeadForDepartment: vi.fn().mockResolvedValue(false),
  }),
}));

import { assertCloudWorkspaceCommandConfigurationAllowed, projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/error-handler.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const baseActor = (userId: string) => ({
  type: "board",
  source: "session",
  userId,
  companyIds: ["company-A"],
  isInstanceAdmin: false,
});

describe("PATCH /projects/:id with provisionCommand", () => {
  const policyWithCmd = {
    workspaceStrategy: { type: "git_worktree", provisionCommand: "id > /tmp/pwn" },
  };

  it("403 for team_member", async () => {
    const app = makeApp(baseActor("user-tm"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ executionWorkspacePolicy: policyWithCmd });
    expect(res.status).toBe(403);
  });

  it("403 for team_lead", async () => {
    const app = makeApp(baseActor("user-lead"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ executionWorkspacePolicy: policyWithCmd });
    expect(res.status).toBe(403);
  });

  it("200 for founder", async () => {
    setDeploymentMode("local_trusted");
    const app = makeApp(baseActor("user-fnd"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ executionWorkspacePolicy: policyWithCmd });
    expect(res.status).toBe(200);
  });

  it("rejects new local workspace-command configuration in cloud_auth", () => {
    setDeploymentMode("cloud_auth");
    try {
      let caught: unknown;
      try {
        assertCloudWorkspaceCommandConfigurationAllowed();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ status: 400 });
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toMatch(/AOA_ALLOW_UNSANDBOXED_MULTITENANT/);
    } finally {
      setDeploymentMode("local_trusted");
    }
  });

  it("403 for agent actor", async () => {
    const app = makeApp({ type: "agent", agentId: "a1", companyId: "company-A", source: "agent_key" });
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ executionWorkspacePolicy: policyWithCmd });
    expect(res.status).toBe(403);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it("403 for mcp actor", async () => {
    const app = makeApp({ type: "mcp", userId: "mcp-user-1", companyId: "company-A", source: "key" });
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ executionWorkspacePolicy: policyWithCmd });
    expect(res.status).toBe(403);
  });

  it("200 for team_lead WITHOUT provisionCommand (regression guard)", async () => {
    const app = makeApp(baseActor("user-lead"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({ name: "renamed" });
    expect(res.status).toBe(200);
  });

  it("200 for team_lead changing non-command workspace policy", async () => {
    const app = makeApp(baseActor("user-lead"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          allowIssueOverride: true,
        },
      });
    expect(res.status).toBe(200);
  });

  it("403 for team_member changing non-command workspace policy", async () => {
    const app = makeApp(baseActor("user-tm"));
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          allowIssueOverride: true,
        },
      });
    expect(res.status).toBe(403);
  });

  it("403 for agent actor changing non-command workspace policy", async () => {
    const app = makeApp({ type: "agent", agentId: "a1", companyId: "company-A", source: "agent_key" });
    const res = await request(app)
      .patch("/api/projects/p1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          allowIssueOverride: true,
        },
      });
    expect(res.status).toBe(403);
  });
});

describe("project-workspace reserved runtime metadata", () => {
  const reserved = {
    cwd: "/repo",
    metadata: {
      runtimeConfig: {
        desiredState: "running",
        workspaceRuntime: { services: [{ name: "web", command: "echo unsafe" }] },
      },
    },
  };

  it.each([
    ["agent", { type: "agent", agentId: "a1", companyId: "company-A", source: "agent_key" }],
    ["mcp", { type: "mcp", userId: "mcp-user-1", companyId: "company-A", source: "key" }],
    ["team member", baseActor("user-tm")],
    ["team lead", baseActor("user-lead")],
  ])("rejects server-reserved runtimeConfig from %s callers", async (_label, actor) => {
    const res = await request(makeApp(actor))
      .post("/api/projects/p1/workspaces")
      .send(reserved);
    expect(res.status).toBe(400);
  });
});
