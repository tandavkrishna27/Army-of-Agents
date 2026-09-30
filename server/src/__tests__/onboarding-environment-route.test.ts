import express from "express";
import path from "node:path";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  companyMemberships: makeTableProxy("company_memberships"),
}));

const mockSetup = vi.hoisted(() => vi.fn());
const mockSafeLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/onboarding-environment.js", () => ({
  setupOnboardingEnvironment: mockSetup,
}));
vi.mock("../utils/safe-log-activity.js", () => ({
  safeLogActivity: mockSafeLogActivity,
}));

import {
  isAbsoluteFilesystemPath,
  onboardingEnvironmentRoutes,
} from "../routes/onboarding-environment.js";

const COMPANY_ID = "c1";

/** db stub: membership select().from().where().limit() → `rows`. */
function dbWithMembership(rows: unknown[]) {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  } as never;
}

function makeApp(db: unknown, actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const base: any = actorOverride ?? { type: "board", userId: "u1", isInstanceAdmin: true };
    // Mirror actorMiddleware: a genuine operator carries operator=true alongside
    // isInstanceAdmin. The operator-plane gate (canManageInstanceSettings) reads it.
    req.actor = (base.type === "board" && base.operator === undefined
      ? { ...base, operator: base.isInstanceAdmin === true }
      : base) as never;
    next();
  });
  app.use("/api", onboardingEnvironmentRoutes(db as never));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err === "object" && err && "status" in err ? Number((err as { status: unknown }).status) : 500;
    res.status(Number.isFinite(status) ? status : 500).json({ error: err instanceof Error ? err.message : "error" });
  });
  return app;
}

describe("POST /companies/:companyId/onboarding/environment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401 when the actor is not a board user", async () => {
    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }]), { type: "agent" }))
      .post(`/api/companies/${COMPANY_ID}/onboarding/environment`)
      .send({ rootFolder: "/tmp/acme" });
    expect(res.status).toBe(401);
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("allows an instance admin to set up a company without a membership row", async () => {
    mockSetup.mockResolvedValue({
      ok: true,
      environmentId: "e1",
      created: true,
      probe: { ok: true, summary: "ok" },
    });

    const res = await request(makeApp(dbWithMembership([]), {
      type: "board",
      source: "session",
      userId: "u1",
      isInstanceAdmin: true,
      companyIds: [],
    }))
      .post(`/api/companies/${COMPANY_ID}/onboarding/environment`)
      .send({ rootFolder: "/tmp/acme" });

    expect(res.status).toBe(200);
    expect(mockSetup).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_ID,
      rootFolder: "/tmp/acme",
    });
  });

  it("403 when a non-admin company member attempts filesystem setup", async () => {
    mockSetup.mockResolvedValue({ ok: true, environmentId: "e1", probe: { ok: true, summary: "ok" } });
    const res = await request(makeApp(
      dbWithMembership([{ id: COMPANY_ID }]),
      { type: "board", source: "session", userId: "u1", isInstanceAdmin: false },
    ))
      .post(`/api/companies/${COMPANY_ID}/onboarding/environment`)
      .send({ rootFolder: "/tmp/member-controlled" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/instance admin access required/i);
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("400 when rootFolder is missing", async () => {
    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/onboarding/environment`)
      .send({});
    expect(res.status).toBe(400);
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it.each(["AoA", "./AoA"])("400 when rootFolder is relative: %s", async (rootFolder) => {
    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/onboarding/environment`)
      .send({ rootFolder });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/absolute/i);
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it("422 (blocking) when the probe fails — stays on the step", async () => {
    mockSetup.mockResolvedValue({ ok: false, environmentId: null, probe: { ok: false, summary: "no perms" } });
    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/onboarding/environment`)
      .send({ rootFolder: "/tmp/acme" });
    expect(res.status).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(mockSetup).toHaveBeenCalledWith(expect.anything(), { companyId: COMPANY_ID, rootFolder: "/tmp/acme" });
    expect(mockSafeLogActivity).not.toHaveBeenCalled();
  });

  it("200 and activity log when the probe creates the environment", async () => {
    mockSetup.mockResolvedValue({
      ok: true,
      environmentId: "e1",
      created: true,
      probe: { ok: true, summary: "ok" },
    });
    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/onboarding/environment`)
      .send({ rootFolder: "  /tmp/acme  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, environmentId: "e1" });
    // trims before handing to the service
    expect(mockSetup).toHaveBeenCalledWith(expect.anything(), { companyId: COMPANY_ID, rootFolder: "/tmp/acme" });
    expect(mockSafeLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        actorType: "user",
        actorId: "u1",
        action: "environment.created",
        entityType: "environment",
        entityId: "e1",
      }),
    );
    expect(mockSafeLogActivity.mock.calls[0]?.[1]?.details).not.toHaveProperty("rootFolder");
  });
});

describe("isAbsoluteFilesystemPath", () => {
  it("uses native path semantics instead of accepting foreign drive syntax", () => {
    expect(isAbsoluteFilesystemPath("C:\\AoA", path.posix)).toBe(false);
    expect(isAbsoluteFilesystemPath("/srv/aoa", path.posix)).toBe(true);
  });
});
