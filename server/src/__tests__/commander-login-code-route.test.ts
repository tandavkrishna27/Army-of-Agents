import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAssertRole = vi.hoisted(() => vi.fn(async () => {}));
const mockService = vi.hoisted(() => ({
  startChallenge: vi.fn(),
  getStatus: vi.fn(),
  cancel: vi.fn(),
  reapOrphans: vi.fn(),
  submitCode: vi.fn(),
}));
vi.mock("../middleware/rbac.js", () => ({ assertRole: mockAssertRole }));
vi.mock("../routes/authz.js", () => ({ assertCompanyAccess: vi.fn() }));
vi.mock("../services/commander-login-runtime.js", () => ({
  buildCommanderLoginService: () => mockService,
}));
import { errorHandler } from "../middleware/error-handler.js";
import { commanderLoginRoutes } from "../routes/commander-login.js";

function makeApp(actor: Record<string, unknown> = { type: "board", userId: "u1" }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor as never;
    next();
  });
  app.use("/api", commanderLoginRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const codeUrl = "/api/companies/c1/internal-agent/commander-login/ch-1/code";

describe("commander-login code route (Plan 3 T4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRole.mockResolvedValue(undefined);
  });

  it("delivered -> 202, and service.submitCode called with (companyId, id, code) in that order", async () => {
    mockService.submitCode.mockReturnValueOnce("delivered");
    const res = await request(makeApp()).post(codeUrl).send({ code: "ABC-123" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(mockService.submitCode).toHaveBeenCalledWith("c1", "ch-1", "ABC-123", "u1");
  });

  it("not-live -> 404, body mentions starting again", async () => {
    mockService.submitCode.mockReturnValueOnce("not-live");
    const res = await request(makeApp()).post(codeUrl).send({ code: "ABC-123" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/start.*again/i);
  });

  it("write-failed -> 410", async () => {
    mockService.submitCode.mockReturnValueOnce("write-failed");
    const res = await request(makeApp()).post(codeUrl).send({ code: "ABC-123" });
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/start.*again/i);
  });

  it("unsupported -> 409", async () => {
    mockService.submitCode.mockReturnValueOnce("unsupported");
    const res = await request(makeApp()).post(codeUrl).send({ code: "ABC-123" });
    expect(res.status).toBe(409);
  });

  it("empty/whitespace code -> 400 and the service is NOT called", async () => {
    const res1 = await request(makeApp()).post(codeUrl).send({ code: "" });
    expect(res1.status).toBe(400);
    expect(mockService.submitCode).not.toHaveBeenCalled();

    const res2 = await request(makeApp()).post(codeUrl).send({ code: "   " });
    expect(res2.status).toBe(400);
    expect(mockService.submitCode).not.toHaveBeenCalled();

    const res3 = await request(makeApp()).post(codeUrl).send({});
    expect(res3.status).toBe(400);
    expect(mockService.submitCode).not.toHaveBeenCalled();
  });

  it("the code never appears in the response body", async () => {
    mockService.submitCode.mockReturnValueOnce("delivered");
    const distinctive = "SUPER-SECRET-DISTINCTIVE-CODE-42";
    const res = await request(makeApp()).post(codeUrl).send({ code: distinctive });
    expect(JSON.stringify(res.body)).not.toContain(distinctive);
  });

  it("401 for a non-board actor (agent)", async () => {
    const res = await request(makeApp({ type: "agent" })).post(codeUrl).send({ code: "ABC-123" });
    expect(res.status).toBe(401);
    expect(mockService.submitCode).not.toHaveBeenCalled();
  });

  it("403 for a team_member (assertRole throws)", async () => {
    mockAssertRole.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { status: 403, statusCode: 403 }),
    );
    const res = await request(makeApp()).post(codeUrl).send({ code: "ABC-123" });
    expect(res.status).toBe(403);
    expect(mockService.submitCode).not.toHaveBeenCalled();
  });
});
