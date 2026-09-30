import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

// Same harness as cli-auth-routes.test.ts: mock the board-auth service so the
// route runs without a real DB. These tests focus on how the CLI-auth
// `approvalUrl` origin is derived — it must come from the trusted origin
// (configured public URL → trust-proxy-gated / real Host), never a spoofable
// `X-Forwarded-Host` (the approval URL carries an auth token).
const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  boardAuthService: () => mockBoardAuthService,
  logActivity: mockLogActivity,
}));

// Env keys `loadConfig()` consults for the canonical public origin. We clear
// them per test and re-import the router so access-helpers' memoized
// public-base-url cache re-reads the current env.
const PUBLIC_URL_ENV_KEYS = [
  "AOA_AUTH_PUBLIC_BASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "AOA_PUBLIC_URL",
];

const savedEnv: Record<string, string | undefined> = {};

async function buildApp() {
  // Fresh module graph so access-helpers re-reads the configured public URL.
  vi.resetModules();
  const { cliAuthRoutes } = await import("../routes/cli-auth.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "none", source: "none" };
    next();
  });
  app.use("/api", cliAuthRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function stubChallenge() {
  mockBoardAuthService.createCliAuthChallenge.mockResolvedValue({
    challenge: {
      id: "challenge-1",
      expiresAt: new Date("2026-03-23T13:00:00.000Z"),
    },
    challengeSecret: "aoa_cli_auth_secret",
    pendingBoardToken: "aoa_board_token",
  });
}

describe("cli-auth approval URL origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of PUBLIC_URL_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PUBLIC_URL_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("does NOT point the approval URL at a spoofed X-Forwarded-Host (trust proxy off, no config)", async () => {
    stubChallenge();
    const app = await buildApp();

    const res = await request(app)
      .post("/api/cli-auth/challenges")
      .set("X-Forwarded-Host", "evil.com")
      .set("X-Forwarded-Proto", "https")
      .send({
        command: "aoa auth login",
        clientName: "aoa cli",
        requestedAccess: "board",
      });

    expect(res.status).toBe(201);
    // The spoofed forwarded host must never appear in the token-bearing URL.
    expect(res.body.approvalUrl).not.toContain("evil.com");
    // Path + token are preserved verbatim; only the origin derivation changed.
    expect(res.body.approvalUrl).toContain(
      "/cli-auth/challenge-1?token=aoa_cli_auth_secret",
    );
    expect(res.body.approvalPath).toBe(
      "/cli-auth/challenge-1?token=aoa_cli_auth_secret",
    );
  });

  it("uses the configured public origin for the approval URL, ignoring spoofed headers", async () => {
    process.env.AOA_AUTH_PUBLIC_BASE_URL = "https://cli.example.com";
    stubChallenge();
    const app = await buildApp();

    const res = await request(app)
      .post("/api/cli-auth/challenges")
      .set("X-Forwarded-Host", "evil.com")
      .set("X-Forwarded-Proto", "https")
      .send({
        command: "aoa auth login",
        clientName: "aoa cli",
        requestedAccess: "board",
      });

    expect(res.status).toBe(201);
    expect(res.body.approvalUrl).toBe(
      "https://cli.example.com/cli-auth/challenge-1?token=aoa_cli_auth_secret",
    );
    expect(res.body.approvalUrl).not.toContain("evil.com");
  });
});
