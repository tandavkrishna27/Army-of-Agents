import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

// Route-level test for POST /companies/:cid/invites/:id/resend URL building.
// The resend link (rotated token) must be built from the trusted origin — the
// configured public URL first (parity with invite-create), then a
// trust-proxy-gated / real-Host fallback — never a spoofable X-Forwarded-Host.
const mockAccessService = vi.hoisted(() => ({
  resendInvite: vi.fn(),
}));

const mockTeamService = vi.hoisted(() => ({
  assertFounder: vi.fn().mockResolvedValue(undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  humanCapabilitiesService: () => ({}),
  humanContextService: () => ({}),
  humanDiscoveryService: () => ({}),
  logActivity: mockLogActivity,
  teamService: () => mockTeamService,
}));

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const INVITE_ID = "inv-1";
const FOUNDER_USER_ID = "founder-user-1";

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
  const { teamRoutes } = await import("../routes/team.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      userId: FOUNDER_USER_ID,
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", teamRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function stubResend() {
  mockAccessService.resendInvite.mockResolvedValue({
    invite: {
      id: "inv-2",
      expiresAt: new Date("2026-03-23T13:00:00.000Z"),
    },
    token: "fresh-token",
  });
}

describe("POST /companies/:companyId/invites/:inviteId/resend URL origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamService.assertFounder.mockResolvedValue(undefined);
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

  it("prefers the configured public origin over a spoofed forwarded host (parity with create)", async () => {
    process.env.AOA_AUTH_PUBLIC_BASE_URL = "https://team.example.com";
    stubResend();
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/invites/${INVITE_ID}/resend`)
      .set("X-Forwarded-Host", "evil.com")
      .set("X-Forwarded-Proto", "https")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.inviteUrl).toBe("https://team.example.com/invite/fresh-token");
    expect(res.body.inviteUrl).not.toContain("evil.com");
    expect(res.body.token).toBe("fresh-token");
  });

  it("does NOT point the resend link at a spoofed forwarded host when no public URL is configured", async () => {
    stubResend();
    const app = await buildApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/invites/${INVITE_ID}/resend`)
      .set("X-Forwarded-Host", "evil.com")
      .set("X-Forwarded-Proto", "https")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.inviteUrl).not.toContain("evil.com");
    expect(res.body.inviteUrl).toContain("/invite/fresh-token");
  });
});
