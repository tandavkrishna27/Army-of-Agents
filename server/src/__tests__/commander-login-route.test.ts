import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { resolveScopedCliAuthHome } from "../services/cli-auth-topology.js";

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

  it("returns the exact scoped Docker terminal command only for a dedicated opt-in install", async () => {
    const previous = {
      profile: process.env.AOA_INSTALL_PROFILE,
      flag: process.env.AOA_CLAUDE_PASTE_AUTH,
      home: process.env.AOA_HOME,
    };
    process.env.AOA_INSTALL_PROFILE = "remote_single_tenant";
    process.env.AOA_CLAUDE_PASTE_AUTH = "true";
    process.env.AOA_HOME = "/aoa";
    mockLoadConfig.mockReturnValue({ deploymentMode: "authenticated", deploymentExposure: "public" });
    try {
      const res = await request(makeApp()).get("/api/companies/c1/internal-agent/commander-login/capabilities");
      expect(res.status).toBe(200);
      const commands = res.body.providers.anthropic.terminalCommands as Array<{ mode: string; command: string }>;
      expect(commands).toHaveLength(2);
      expect(commands[0]?.mode).toBe("standard");
      expect(commands[0]?.command).toContain("docker compose exec --user node");
      expect(commands[0]?.command).toContain("server claude auth login");
      expect(commands[0]?.command).toContain("CLAUDE_CONFIG_DIR=");
      expect(commands[0]?.command).not.toContain("~/.claude");
      expect(commands[1]?.mode).toBe("quickstart");
      expect(commands[1]?.command).toContain("-f docker-compose.quickstart.yml");
      expect(commands[1]?.command).toContain("aoa claude auth login");
      expect(res.body.providers.anthropic.terminalCommand).toBe(commands[0]?.command);
      expect(res.body.providers.anthropic.enabled).toBe(true);
    } finally {
      if (previous.profile === undefined) delete process.env.AOA_INSTALL_PROFILE; else process.env.AOA_INSTALL_PROFILE = previous.profile;
      if (previous.flag === undefined) delete process.env.AOA_CLAUDE_PASTE_AUTH; else process.env.AOA_CLAUDE_PASTE_AUTH = previous.flag;
      if (previous.home === undefined) delete process.env.AOA_HOME; else process.env.AOA_HOME = previous.home;
    }
  });

  it("rejects an unreadable scoped Claude credential without starting another login", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-route-auth-"));
    const previous = { profile: process.env.AOA_INSTALL_PROFILE, flag: process.env.AOA_CLAUDE_PASTE_AUTH, home: process.env.AOA_HOME };
    process.env.AOA_INSTALL_PROFILE = "remote_single_tenant";
    process.env.AOA_CLAUDE_PASTE_AUTH = "true";
    process.env.AOA_HOME = root;
    mockLoadConfig.mockReturnValue({ deploymentMode: "authenticated", deploymentExposure: "public" });
    const home = resolveScopedCliAuthHome({ env: process.env, executionTargetId: "control-plane", companyId: "c1", userId: "u1", provider: "anthropic" });
    await fs.mkdir(home, { recursive: true });
    const credential = path.join(home, ".credentials.json");
    await fs.writeFile(credential, "fixture-secret");
    const originalOpen = fs.open.bind(fs);
    const opened = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      if (String(candidate) === credential) throw Object.assign(new Error("EACCES fixture-secret"), { code: "EACCES" });
      return originalOpen(candidate, flags, mode);
    });
    try {
      const res = await request(makeApp()).post(startUrl).send({ provider: "anthropic" });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("claude_credentials_permission_denied");
      expect(JSON.stringify(res.body)).not.toContain("fixture-secret");
      expect(JSON.stringify(res.body)).not.toContain(root);
      expect(mockService.startChallenge).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
      if (previous.profile === undefined) delete process.env.AOA_INSTALL_PROFILE; else process.env.AOA_INSTALL_PROFILE = previous.profile;
      if (previous.flag === undefined) delete process.env.AOA_CLAUDE_PASTE_AUTH; else process.env.AOA_CLAUDE_PASTE_AUTH = previous.flag;
      if (previous.home === undefined) delete process.env.AOA_HOME; else process.env.AOA_HOME = previous.home;
    }
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
