import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

const getEffectiveRole = vi.fn();
const remove = vi.fn();
const archive = vi.fn();

vi.mock("../services/permissions.js", () => ({ permissionService: () => ({ getEffectiveRole }) }));
vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn() }),
  companyPortabilityService: () => ({}),
  companyService: () => ({ remove, archive }),
  organizationAccessService: () => ({ canOrg: vi.fn() }),
  logActivity: vi.fn(),
}));
vi.mock("../services/internal-agent/aoa-skills-seeder.js", () => ({ seedAoaNativeSkills: vi.fn() }));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({ ensureCommanderAgent: vi.fn() }));
vi.mock("../services/team.js", () => ({
  materializeCompanyProfileFromGlobal: vi.fn(),
  ensureCompanyProfileFromGlobal: vi.fn(),
}));

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api/companies", companyRoutes({} as any, { deploymentMode: "authenticated" }));
  app.use(errorHandler);
  return app;
}

const founderActor = { type: "board", source: "session", userId: "u-founder", companyIds: ["c1"], isInstanceAdmin: false };
const memberActor = { type: "board", source: "session", userId: "u-member", companyIds: ["c1"], isInstanceAdmin: false };

describe("companies destructive-route founder gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("403 when a team_member tries to DELETE a company", async () => {
    getEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp(memberActor)).delete("/api/companies/c1");
    expect(res.status).toBe(403);
    expect(remove).not.toHaveBeenCalled();
  });

  it("403 when a team_member tries to archive a company", async () => {
    getEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp(memberActor)).post("/api/companies/c1/archive");
    expect(res.status).toBe(403);
    expect(archive).not.toHaveBeenCalled();
  });

  it("200 when a founder deletes a company", async () => {
    getEffectiveRole.mockResolvedValue("founder");
    remove.mockResolvedValue({ id: "c1" });
    const res = await request(makeApp(founderActor)).delete("/api/companies/c1");
    expect(res.status).toBe(200);
    expect(remove).toHaveBeenCalledWith("c1");
  });
});
