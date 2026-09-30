import express from "express";
import request from "supertest";
import { describe, beforeEach, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";

// Codex P2: founder company-create must materialize the founder's company
// Human Operating Profile from their global profile (onboarding's
// HumanProfileStep only writes the global user_profiles row). This test locks
// the wiring: the shared helper is called with the operator id after
// ensureRealOperator, and a failure never blocks company creation.

const mockCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    id: "co-test",
    name: "TestCo",
    requireBoardApprovalForNewAgents: false,
  }),
);
const ensureRealOperatorMock = vi.hoisted(() => vi.fn().mockResolvedValue("operator-user-id"));
const materializeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const ensureProfileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const publishActivityMock = vi.hoisted(() => vi.fn());
const seedNativeSkillsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const ensureCommanderMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const createOutcome = vi.hoisted(() => ({ created: true }));

vi.mock("../services/activity-log.js", () => ({
  insertActivityLog: vi.fn(async (_db: unknown, input: unknown) => input),
  publishActivityLogged: publishActivityMock,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: mockCreate,
    // P3: the route creates atomically via `createWithOperator`. Delegate to
    // `mockCreate` for the company and provision the operator via the passed
    // access factory, so ensureRealOperator runs and its id flows to Group B.
    createWithOperator: vi.fn(async (input: any, opts: any, ownerUserId: any, buildAccess: any, recordActivity: any) => {
      const company = await mockCreate(input, opts);
      const operatorId = createOutcome.created
        ? await buildAccess(undefined).ensureRealOperator(company.id, ownerUserId)
        : "operator-user-id";
      const committedActivity = createOutcome.created
        ? await recordActivity(undefined, company, operatorId)
        : null;
      return { company, operatorId, created: createOutcome.created, committedActivity };
    }),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: vi.fn().mockResolvedValue(undefined),
    ensureRealOperator: ensureRealOperatorMock,
  }),
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/team.js", () => ({
  materializeCompanyProfileFromGlobal: materializeMock,
  ensureCompanyProfileFromGlobal: ensureProfileMock,
}));

vi.mock("../services/internal-agent/aoa-skills-seeder.js", () => ({
  seedAoaNativeSkills: seedNativeSkillsMock,
}));

vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: ensureCommanderMock,
}));

vi.mock("../middleware/logger.js", () => {
  // `child` is required: the company routes now import identity-backfill.ts, which
  // calls `logger.child(...)` at module load (PR #318 identity-memory mirror).
  const base = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { logger: { ...base, child: vi.fn(() => base) } };
});

const db = { __sentinel: true } as unknown;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: false,
      userId: null,
      companyIds: [],
    };
    next();
  });
  app.use("/api/companies", companyRoutes(db as any, { deploymentMode: "local_trusted" }));
  return app;
}

describe("POST /api/companies — founder company profile seeding", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    ensureRealOperatorMock.mockClear();
    materializeMock.mockReset();
    materializeMock.mockResolvedValue(undefined);
    ensureProfileMock.mockReset();
    ensureProfileMock.mockResolvedValue(undefined);
    publishActivityMock.mockReset();
    seedNativeSkillsMock.mockClear();
    ensureCommanderMock.mockClear();
    createOutcome.created = true;
  });

  it("materializes the founder's company profile from their global profile using the operator id", async () => {
    const res = await request(makeApp()).post("/api/companies").send({ name: "TestCo" });

    expect(res.status).toBe(201);
    expect(ensureRealOperatorMock).toHaveBeenCalledOnce();
    // Called with the db handle, the new company id, and the operator id for
    // BOTH the target user and the attribution (the operator seeds their own
    // profile).
    expect(materializeMock).toHaveBeenCalledWith(db, "co-test", "operator-user-id", "operator-user-id");
  });

  it("never fails company creation when profile materialization throws (best-effort)", async () => {
    materializeMock.mockRejectedValue(new Error("boom"));

    const res = await request(makeApp()).post("/api/companies").send({ name: "TestCo" });

    expect(res.status).toBe(201);
    expect(materializeMock).toHaveBeenCalledOnce();
    expect(ensureProfileMock).not.toHaveBeenCalled();
  });

  it("keeps the 201 response when post-commit realtime publication fails", async () => {
    publishActivityMock.mockImplementationOnce(() => {
      throw new Error("socket unavailable");
    });

    const res = await request(makeApp()).post("/api/companies").send({ name: "TestCo" });

    expect(res.status).toBe(201);
    expect(publishActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "company.created", entityId: "co-test" }),
    );
  });

  it("reconciles idempotent bootstrap on replay without republishing create activity", async () => {
    createOutcome.created = false;

    const res = await request(makeApp()).post("/api/companies").send({ name: "TestCo" });

    expect(res.status).toBe(201);
    expect(ensureRealOperatorMock).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
    expect(ensureProfileMock).toHaveBeenCalledOnce();
    expect(seedNativeSkillsMock).toHaveBeenCalledOnce();
    expect(ensureCommanderMock).toHaveBeenCalledOnce();
    expect(publishActivityMock).not.toHaveBeenCalled();
  });
});
