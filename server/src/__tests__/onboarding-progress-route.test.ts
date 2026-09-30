import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { onboardingRoutes } from "../routes/onboarding.js";

const { getProgressMock, advanceStateMock } = vi.hoisted(() => ({
  getProgressMock: vi.fn(),
  advanceStateMock: vi.fn(),
}));

vi.mock("../services/onboarding.js", () => ({
  getProgress: getProgressMock,
  advanceState: advanceStateMock,
}));

function appWith(actor: unknown, db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", onboardingRoutes(db as any));
  return app;
}

// db whose membership lookup returns no rows → access denied.
const noAccessDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
};

describe("onboarding progress routes (Stage B / B4)", () => {
  beforeEach(() => {
    getProgressMock.mockReset().mockResolvedValue(null);
    advanceStateMock.mockReset().mockResolvedValue({
      status: "ok",
      row: {
        id: "progress-1",
        userId: "u1",
        companyId: "c2",
        journey: "founder",
        currentState: "ORGANIZATION_CREATED",
        completedStates: ["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED"],
        version: 1,
      },
    });
  });

  it("GET → 401 when not a board actor", async () => {
    const res = await request(appWith({ type: "none" }, {})).get("/api/onboarding/progress");
    expect(res.status).toBe(401);
  });

  it("PATCH → 400 on invalid journey", async () => {
    const res = await request(appWith({ type: "board", userId: "u1" }, {}))
      .patch("/api/onboarding/progress")
      .send({ journey: "bogus", requestedState: "PROFILE_SET" });
    expect(res.status).toBe(400);
  });

  it("PATCH → 400 on invalid state", async () => {
    const res = await request(appWith({ type: "board", userId: "u1" }, {}))
      .patch("/api/onboarding/progress")
      .send({ journey: "founder", requestedState: "NOPE" });
    expect(res.status).toBe(400);
  });

  it("GET → 403 when company access is denied", async () => {
    const res = await request(appWith({ type: "board", userId: "u1" }, noAccessDb)).get(
      "/api/onboarding/progress?companyId=c2",
    );
    expect(res.status).toBe(403);
  });

  it("PATCH → 403 when company access is denied", async () => {
    const res = await request(appWith({ type: "board", userId: "u1" }, noAccessDb))
      .patch("/api/onboarding/progress")
      .send({ journey: "founder", requestedState: "ORGANIZATION_CREATED", companyId: "c2" });
    expect(res.status).toBe(403);
  });

  it("GET allows an instance admin to load company progress without a membership", async () => {
    const res = await request(
      appWith({ type: "board", userId: "u1", companyIds: [], isInstanceAdmin: true }, noAccessDb),
    ).get("/api/onboarding/progress?companyId=c2");

    expect(res.status).toBe(200);
    expect(getProgressMock).toHaveBeenCalledWith(noAccessDb, "u1", "c2");
  });

  it("PATCH allows local implicit board access to advance company progress without a membership", async () => {
    const res = await request(
      appWith(
        { type: "board", userId: "local-board", companyIds: [], source: "local_implicit" },
        noAccessDb,
      ),
    )
      .patch("/api/onboarding/progress")
      .send({ journey: "founder", requestedState: "ORGANIZATION_CREATED", companyId: "c2" });

    expect(res.status).toBe(200);
    expect(advanceStateMock).toHaveBeenCalledWith(noAccessDb, {
      userId: "local-board",
      companyId: "c2",
      journey: "founder",
      requestedState: "ORGANIZATION_CREATED",
    });
  });
});
