import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAssertRole = vi.hoisted(() => vi.fn(async () => {}));
const mockLoadConfig = vi.hoisted(() =>
  vi.fn(() => ({ deploymentMode: "local_trusted", deploymentExposure: "private" })),
);
const mockService = vi.hoisted(() => ({
  startChallenge: vi.fn(),
  getStatus: vi.fn(),
  cancel: vi.fn(),
  reapOrphans: vi.fn(),
}));
vi.mock("../middleware/rbac.js", () => ({ assertRole: mockAssertRole }));
vi.mock("../routes/authz.js", () => ({ assertCompanyAccess: vi.fn() }));
vi.mock("../config.js", () => ({ loadConfig: mockLoadConfig }));
vi.mock("../services/commander-login-runtime.js", () => ({
  buildCommanderLoginService: () => mockService,
}));
import { errorHandler } from "../middleware/error-handler.js";
import { commanderLoginRoutes } from "../routes/commander-login.js";
import { LoginChallengeConflictError } from "../services/commander-login.js";

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
const startUrl = "/api/companies/c1/internal-agent/commander-login/start";

describe("commander-login routes (Plan 3 T4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRole.mockResolvedValue(undefined);
    mockLoadConfig.mockReturnValue({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
    });
  });

  it("401 for a non-board actor (agent)", async () => {
    const res = await request(makeApp({ type: "agent" })).post(startUrl).send({ provider: "openai" });
    expect(res.status).toBe(401);
    expect(mockService.startChallenge).not.toHaveBeenCalled();
  });

  it("403 for a team_member (assertRole throws)", async () => {
    mockAssertRole.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { status: 403, statusCode: 403 }));
    const res = await request(makeApp()).post(startUrl).send({ provider: "openai" });
    expect(res.status).toBe(403);
    expect(mockService.startChallenge).not.toHaveBeenCalled();
  });

  it("400 for an invalid provider", async () => {
    const res = await request(makeApp()).post(startUrl).send({ provider: "gemini" });
    expect(res.status).toBe(400);
  });

  it("fails closed for subscription auth on a hosted multi-tenant installation", async () => {
    mockLoadConfig.mockReturnValue({
      deploymentMode: "authenticated",
      deploymentExposure: "public",
    });
    const capabilities = await request(makeApp()).get(
      "/api/companies/c1/internal-agent/commander-login/capabilities",
    );
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.topology.installProfile).toBe("hosted_multi_tenant");
    expect(capabilities.body.providers.openai).toMatchObject({
      enabled: false,
      mode: "device_code",
    });

    const start = await request(makeApp()).post(startUrl).send({ provider: "openai" });
    expect(start.status).toBe(403);
    expect(start.body.code).toBe("subscription_auth_disabled");
    expect(mockService.startChallenge).not.toHaveBeenCalled();
  });

  it("200 start returns { challengeId, loginUrl }", async () => {
    mockService.startChallenge.mockResolvedValueOnce({
      challengeId: "ch-1",
      loginUrl: "https://chatgpt.com/device?code=A",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-07-27T12:00:00.000Z",
      completion: Promise.resolve(),
    });
    const res = await request(makeApp()).post(startUrl).send({ provider: "openai" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      challengeId: "ch-1",
      loginUrl: "https://chatgpt.com/device?code=A",
      mode: "device_code",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-07-27T12:00:00.000Z",
    });
    expect(mockService.startChallenge).toHaveBeenCalledWith({
      companyId: "c1",
      provider: "openai",
      startedByUserId: "u1",
      executionTargetId: "control-plane",
    });
  });

  it("409 when another company holds the (provider, authHome) lock", async () => {
    mockService.startChallenge.mockRejectedValueOnce(new LoginChallengeConflictError("busy"));
    const res = await request(makeApp()).post(startUrl).send({ provider: "openai" });
    expect(res.status).toBe(409);
  });

  it("502 when no verification URL is produced", async () => {
    mockService.startChallenge.mockRejectedValueOnce(new Error("no-url"));
    const res = await request(makeApp()).post(startUrl).send({ provider: "anthropic" });
    expect(res.status).toBe(502);
  });

  it("GET status returns the row; 404 when missing", async () => {
    mockService.getStatus.mockResolvedValueOnce({ status: "pending", loginUrl: "https://x" });
    const ok = await request(makeApp()).get("/api/companies/c1/internal-agent/commander-login/ch-1");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: "pending", loginUrl: "https://x" });
    // Codex P1 #1 — the gated companyId scopes the lookup (cross-tenant → null → 404).
    expect(mockService.getStatus).toHaveBeenCalledWith("c1", "ch-1", null, "u1");

    mockService.getStatus.mockResolvedValueOnce(null);
    const missing = await request(makeApp()).get("/api/companies/c1/internal-agent/commander-login/ch-x");
    expect(missing.status).toBe(404);
  });

  it("POST cancel returns { ok: true } and is founder-gated", async () => {
    const res = await request(makeApp()).post("/api/companies/c1/internal-agent/commander-login/ch-1/cancel");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Codex P1 #1 — the gated companyId scopes the cancel (cross-tenant → no-op).
    expect(mockService.cancel).toHaveBeenCalledWith("c1", "ch-1", null, "u1");
  });

  it("cancel is blocked for an agent actor (401)", async () => {
    const res = await request(makeApp({ type: "agent" })).post("/api/companies/c1/internal-agent/commander-login/ch-1/cancel");
    expect(res.status).toBe(401);
    expect(mockService.cancel).not.toHaveBeenCalled();
  });
});
