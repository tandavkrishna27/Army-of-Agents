import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { onboardingRoutes } from "../routes/onboarding.js";

const { getProgressMock, advanceStateMock, setFirstRunProgressMock, logActivityMock } = vi.hoisted(() => ({
  getProgressMock: vi.fn(),
  advanceStateMock: vi.fn(),
  setFirstRunProgressMock: vi.fn(),
  logActivityMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/onboarding.js", () => ({
  getProgress: getProgressMock,
  advanceState: advanceStateMock,
  setFirstRunProgress: setFirstRunProgressMock,
}));

vi.mock("../services/index.js", () => ({
  logActivity: logActivityMock,
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

const boardActor = { type: "board", userId: "u1", companyIds: ["c1"] };

describe("PATCH /onboarding/first-run (WS0b)", () => {
  beforeEach(() => {
    getProgressMock.mockReset();
    advanceStateMock.mockReset();
    logActivityMock.mockReset().mockResolvedValue(undefined);
    setFirstRunProgressMock.mockReset().mockResolvedValue({
      status: "ok",
      row: {
        id: "progress-1",
        userId: "u1",
        companyId: "c1",
        journey: "founder",
        currentState: "SETUP_COMPLETE",
        completedStates: ["AUTHENTICATED", "SETUP_COMPLETE"],
        version: 2,
        firstRunCompletedAt: new Date("2026-07-18T00:00:00Z"),
        firstRunPersona: "explorer",
      },
    });
  });

  it("401s when not a board actor", async () => {
    const res = await request(appWith({ type: "none" }, {}))
      .patch("/api/onboarding/first-run")
      .send({ companyId: "c1", completed: true });
    expect(res.status).toBe(401);
    expect(setFirstRunProgressMock).not.toHaveBeenCalled();
  });

  it("400s when companyId is missing", async () => {
    const res = await request(appWith(boardActor, {}))
      .patch("/api/onboarding/first-run")
      .send({ completed: true });
    expect(res.status).toBe(400);
    expect(setFirstRunProgressMock).not.toHaveBeenCalled();
  });

  it("403s when company access is denied", async () => {
    const res = await request(appWith({ type: "board", userId: "u1", companyIds: [] }, noAccessDb))
      .patch("/api/onboarding/first-run")
      .send({ companyId: "c2", completed: true });
    expect(res.status).toBe(403);
    expect(setFirstRunProgressMock).not.toHaveBeenCalled();
  });

  it("400s on an invalid firstRunPersona value", async () => {
    const res = await request(appWith(boardActor, {}))
      .patch("/api/onboarding/first-run")
      .send({ companyId: "c1", firstRunPersona: "bogus" });
    expect(res.status).toBe(400);
    expect(setFirstRunProgressMock).not.toHaveBeenCalled();
  });

  it("400s when neither firstRunPersona nor completed is supplied", async () => {
    const res = await request(appWith(boardActor, {}))
      .patch("/api/onboarding/first-run")
      .send({ companyId: "c1" });
    expect(res.status).toBe(400);
    expect(setFirstRunProgressMock).not.toHaveBeenCalled();
  });

  it("404s when the service reports no progress row for this actor", async () => {
    setFirstRunProgressMock.mockResolvedValue({ status: "not_found" });
    const res = await request(appWith(boardActor, {}))
      .patch("/api/onboarding/first-run")
      .send({ companyId: "c1", completed: true });
    expect(res.status).toBe(404);
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("409s on an optimistic-concurrency conflict", async () => {
    setFirstRunProgressMock.mockResolvedValue({ status: "conflict" });
    const res = await request(appWith(boardActor, {}))
      .patch("/api/onboarding/first-run")
      .send({ companyId: "c1", completed: true });
    expect(res.status).toBe(409);
    expect(logActivityMock).not.toHaveBeenCalled();
  });

  it("derives userId from the board actor, never from the request body — cannot write another user's row", async () => {
    const res = await request(appWith(boardActor, {}))
      .patch("/api/onboarding/first-run")
      .send({ companyId: "c1", userId: "attacker", firstRunPersona: "in_flight" });

    expect(res.status).toBe(200);
    expect(setFirstRunProgressMock).toHaveBeenCalledWith(expect.anything(), {
      userId: "u1",
      companyId: "c1",
      persona: "in_flight",
      completed: false,
    });
  });

  it("on success, writes an activity-log entry and returns the updated row", async () => {
    const res = await request(appWith(boardActor, {}))
      .patch("/api/onboarding/first-run")
      .send({ companyId: "c1", completed: true });

    expect(res.status).toBe(200);
    expect(res.body.progress.firstRunPersona).toBe("explorer");
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    const logArg = logActivityMock.mock.calls[0][1];
    expect(logArg).toMatchObject({
      companyId: "c1",
      action: "onboarding.first_run_updated",
      entityType: "onboarding_progress",
      entityId: "progress-1",
    });
  });

  it("allows local implicit board access without a membership row", async () => {
    setFirstRunProgressMock.mockResolvedValue({
      status: "ok",
      row: {
        id: "progress-2",
        userId: "local-board",
        companyId: "c2",
        journey: "founder",
        currentState: "SETUP_COMPLETE",
        completedStates: ["SETUP_COMPLETE"],
        version: 1,
        firstRunCompletedAt: new Date(),
        firstRunPersona: null,
      },
    });
    const res = await request(
      appWith({ type: "board", userId: "local-board", companyIds: [], source: "local_implicit" }, noAccessDb),
    )
      .patch("/api/onboarding/first-run")
      .send({ companyId: "c2", completed: true });

    expect(res.status).toBe(200);
    expect(setFirstRunProgressMock).toHaveBeenCalledWith(expect.anything(), {
      userId: "local-board",
      companyId: "c2",
      persona: undefined,
      completed: true,
    });
  });
});
