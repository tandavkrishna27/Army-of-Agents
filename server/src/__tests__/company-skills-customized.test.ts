import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { companySkills: tableProxy, userRoles: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  isNull: () => Symbol("isNull"),
  or: () => Symbol("or"),
  gt: () => Symbol("gt"),
}));
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({ actorType: "board", actorId: "u1", agentId: null, runId: null })),
}));
vi.mock("../services/index.js", () => ({
  companySkillService: vi.fn(() => ({
    updateFile: vi.fn().mockResolvedValue({
      skillId: "skill-1",
      path: "SKILL.md",
      kind: "markdown",
      content: "# Updated",
      markdown: true,
    }),
    getById: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    importPackageFiles: vi.fn(),
    projectScan: vi.fn(),
    getFile: vi.fn(),
    deleteFile: vi.fn(),
    deleteSkill: vi.fn(),
  })),
  agentService: vi.fn(() => ({
    getById: vi.fn(),
    list: vi.fn(),
  })),
  accessService: vi.fn(() => ({
    assertCanAccess: vi.fn(),
  })),
  logActivity: vi.fn(),
}));
vi.mock("../middleware/logger.js", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { companySkillRoutes } from "../routes/company-skills.js";
import { companySkillService } from "../services/index.js";

function buildApp(capturedSets: any[] = []) {
  const db = {
    update: () => ({
      set: (values: any) => ({
        where: () => {
          capturedSets.push(values);
          return Promise.resolve();
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  };

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = { type: "board", source: "local_implicit", userId: "u1" };
    next();
  });
  app.use("/", companySkillRoutes(db as any));
  return app;
}

describe("PATCH /companies/:companyId/skills/:skillId/files — customized flag", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("sets customized=true exactly once — in the service's DB write, not as a separate route-level update", async () => {
    const capturedSets: any[] = [];
    const app = buildApp(capturedSets);

    const res = await request(app)
      .patch("/companies/c1/skills/skill-1/files")
      .send({ path: "SKILL.md", content: "# Updated content" });

    expect(res.status).toBe(200);

    // The route must NOT issue a standalone customized=true DB update.
    // The service's updateFile handles it atomically.
    // capturedSets should be empty — no route-level db.update() calls.
    expect(capturedSets).toHaveLength(0);
  });

  it("calls svc.updateFile with the correct arguments", async () => {
    const app = buildApp();

    await request(app)
      .patch("/companies/c1/skills/skill-1/files")
      .send({ path: "SKILL.md", content: "# Hello" });

    const svc = vi.mocked(companySkillService).mock.results[0].value;
    expect(svc.updateFile).toHaveBeenCalledWith("c1", "skill-1", "SKILL.md", "# Hello");
  });

  it("non-SKILL.md path: route still issues no standalone customized=true write", async () => {
    const capturedSets: any[] = [];
    // Override updateFile to simulate a non-SKILL.md response
    vi.mocked(companySkillService).mockReturnValueOnce({
      updateFile: vi.fn().mockResolvedValue({
        skillId: "skill-1",
        path: "config.json",
        kind: "json",
        content: "{}",
        markdown: false,
      }),
      getById: vi.fn(),
      create: vi.fn(),
      list: vi.fn(),
      importPackageFiles: vi.fn(),
      projectScan: vi.fn(),
      getFile: vi.fn(),
      deleteFile: vi.fn(),
      deleteSkill: vi.fn(),
    } as any);

    const app = buildApp(capturedSets);

    const res = await request(app)
      .patch("/companies/c1/skills/skill-1/files")
      .send({ path: "config.json", content: "{}" });

    expect(res.status).toBe(200);
    // Route must NOT issue any standalone DB update regardless of path
    expect(capturedSets).toHaveLength(0);

    // Confirm the non-SKILL.md mock was active during this request
    expect(res.body.path).toBe("config.json");
    expect(res.body.markdown).toBe(false);
  });
});
