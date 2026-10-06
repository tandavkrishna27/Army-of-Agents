import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  companyMemberships: makeTableProxy("company_memberships"),
}));

const mockResolveType = vi.hoisted(() => vi.fn());
const mockProbeConfig = vi.hoisted(() => vi.fn(async () => ({})));
const mockFindAdapter = vi.hoisted(() => vi.fn());
const mockTestEnvironment = vi.hoisted(() => vi.fn());
const mockAssertRole = vi.hoisted(() => vi.fn());
const mockVerifyAndBindSubscription = vi.hoisted(() =>
  vi.fn(async () => ({ credentialIds: [], bindingIds: [] })),
);

vi.mock("../services/commander-verify.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  // keep the real classifier; stub the db-touching resolvers
  return { ...actual, resolveCommanderAdapterType: mockResolveType, resolveCommanderProbeConfig: mockProbeConfig };
});
vi.mock("../adapters/registry.js", () => ({ findServerAdapter: mockFindAdapter }));
vi.mock("../middleware/rbac.js", () => ({ assertRole: mockAssertRole }));
vi.mock("../services/provider-credentials.js", () => ({
  verifyAndBindCommanderSubscriptionCredential: mockVerifyAndBindSubscription,
}));

import { commanderVerifyRoutes } from "../routes/commander-verify.js";
import { resolveScopedCliAuthHome } from "../services/cli-auth-topology.js";

const COMPANY_ID = "c1";

function dbWithMembership(rows: unknown[]) {
  return { select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) } as never;
}
function makeApp(db: unknown, actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = (actorOverride ?? {
      type: "board",
      source: "session",
      userId: "u1",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    }) as never;
    next();
  });
  app.use("/api", commanderVerifyRoutes(db as never));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err === "object" && err && "status" in err
      ? Number((err as { status: unknown }).status)
      : 500;
    res.status(Number.isFinite(status) ? status : 500).json({
      error: err instanceof Error ? err.message : "error",
    });
  });
  return app;
}
const probe = (status: "pass" | "warn" | "fail", codes: string[]) => ({
  adapterType: "claude_local",
  status,
  checks: codes.map((code) => ({ code, level: "info", message: code })),
  testedAt: "",
});

describe("POST /companies/:companyId/internal-agent/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTestEnvironment.mockReset();
    mockAssertRole.mockResolvedValue(undefined);
    mockResolveType.mockResolvedValue("claude_local");
    mockProbeConfig.mockResolvedValue({});
    mockFindAdapter.mockReturnValue({ testEnvironment: mockTestEnvironment });
    mockVerifyAndBindSubscription.mockResolvedValue({
      credentialIds: ["credential-1"],
      bindingIds: ["binding-1"],
    });
  });

  it("401 for a non-board actor", async () => {
    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }]), { type: "agent" }))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});
    expect(res.status).toBe(401);
  });

  it("403 when the user is not a member", async () => {
    const res = await request(makeApp(dbWithMembership([]), {
      type: "board",
      source: "session",
      userId: "u1",
      companyIds: [],
      isInstanceAdmin: false,
    }))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("allows an instance admin to verify a company without a membership row", async () => {
    mockProbeConfig.mockResolvedValueOnce({ env: { ANTHROPIC_API_KEY: "company-key" } });
    mockTestEnvironment.mockResolvedValue(probe("pass", ["claude_hello_probe_passed"]));

    const res = await request(makeApp(dbWithMembership([]), {
      type: "board",
      source: "session",
      userId: "u1",
      isInstanceAdmin: true,
      companyIds: [],
    }))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("verified");
  });

  it("rejects a non-founder before resolving or running the Commander adapter", async () => {
    mockAssertRole.mockRejectedValueOnce(
      Object.assign(new Error("Requires one of: founder"), { status: 403 }),
    );
    mockTestEnvironment.mockResolvedValue(probe("pass", ["claude_hello_probe_passed"]));

    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockAssertRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
    );
    expect(mockResolveType).not.toHaveBeenCalled();
    expect(mockTestEnvironment).not.toHaveBeenCalled();
  });

  it("200 verified for a founder-authorized board user when the probe passes", async () => {
    mockTestEnvironment.mockResolvedValue(probe("pass", ["claude_hello_probe_passed"]));
    mockVerifyAndBindSubscription.mockResolvedValueOnce({
      credentialIds: ["credential-1"],
      bindingIds: ["binding-1"],
    });
    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("verified");
    expect(mockAssertRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      COMPANY_ID,
      "founder",
    );
    expect(mockVerifyAndBindSubscription).toHaveBeenCalledWith(
      expect.anything(),
      {
        companyId: COMPANY_ID,
        userId: "u1",
        actorUserId: "u1",
        provider: "anthropic",
        executionTargetId: "control-plane",
      },
    );
  });

  it("does not report verified when terminal-only sign-in has no registered credential or Commander binding", async () => {
    mockTestEnvironment.mockResolvedValue(probe("pass", ["claude_hello_probe_passed"]));
    mockVerifyAndBindSubscription.mockResolvedValueOnce({ credentialIds: [], bindingIds: [] });

    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.outcome).toBe("failed");
    expect(res.body.result.checks.at(-1).code).toBe("subscription_credential_unbound");
  });

  it("shows a typed permission failure before a scoped Claude probe", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-verify-auth-"));
    const previous = { profile: process.env.AOA_INSTALL_PROFILE, home: process.env.AOA_HOME };
    process.env.AOA_INSTALL_PROFILE = "remote_single_tenant";
    process.env.AOA_HOME = root;
    const home = resolveScopedCliAuthHome({ env: process.env, executionTargetId: "control-plane", companyId: COMPANY_ID, userId: "u1", provider: "anthropic" });
    await fs.mkdir(home, { recursive: true });
    const credential = path.join(home, ".credentials.json");
    await fs.writeFile(credential, "fixture-secret");
    const originalOpen = fs.open.bind(fs);
    const opened = vi.spyOn(fs, "open").mockImplementation(async (candidate, flags, mode) => {
      if (String(candidate) === credential) throw Object.assign(new Error("EACCES fixture-secret"), { code: "EACCES" });
      return originalOpen(candidate, flags, mode);
    });
    try {
      const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
        .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
        .send({});
      expect(res.status).toBe(422);
      expect(res.body.outcome).toBe("failed");
      expect(res.body.result.checks[0].code).toBe("claude_credentials_permission_denied");
      expect(JSON.stringify(res.body)).not.toContain("fixture-secret");
      expect(JSON.stringify(res.body)).not.toContain(root);
      expect(mockTestEnvironment).not.toHaveBeenCalled();
    } finally {
      opened.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
      if (previous.profile === undefined) delete process.env.AOA_INSTALL_PROFILE; else process.env.AOA_INSTALL_PROFILE = previous.profile;
      if (previous.home === undefined) delete process.env.AOA_HOME; else process.env.AOA_HOME = previous.home;
    }
  });

  it.skipIf(process.platform !== "linux")("probes through the validated directory descriptor after a pathname swap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-verify-pinned-probe-"));
    const previous = { profile: process.env.AOA_INSTALL_PROFILE, home: process.env.AOA_HOME };
    process.env.AOA_INSTALL_PROFILE = "remote_single_tenant";
    process.env.AOA_HOME = root;
    const home = resolveScopedCliAuthHome({ env: process.env, executionTargetId: "control-plane", companyId: COMPANY_ID, userId: "u1", provider: "anthropic" });
    const movedHome = `${home}-original`;
    const replacementHome = path.join(root, "replacement");
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(replacementHome);
    await fs.writeFile(path.join(home, ".credentials.json"), "expected-scoped-fixture");
    let probeReadExpectedCredential = false;
    mockTestEnvironment.mockImplementationOnce(async ({ config }: { config: { env: Record<string, string> } }) => {
      const configDir = config.env.CLAUDE_CONFIG_DIR;
      expect(configDir).toMatch(/^\/proc\/\d+\/fd\/\d+$/);
      await fs.rename(home, movedHome);
      await fs.symlink(replacementHome, home, "dir");
      expect(await fs.readFile(path.join(configDir, ".credentials.json"), "utf8")).toBe("expected-scoped-fixture");
      probeReadExpectedCredential = true;
      return probe("pass", ["claude_hello_probe_passed"]);
    });
    try {
      const response = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])));
      const res = await response.post(`/api/companies/${COMPANY_ID}/internal-agent/verify`).send({});
      expect(res.status).toBe(200);
      expect(probeReadExpectedCredential).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      if (previous.profile === undefined) delete process.env.AOA_INSTALL_PROFILE; else process.env.AOA_INSTALL_PROFILE = previous.profile;
      if (previous.home === undefined) delete process.env.AOA_HOME; else process.env.AOA_HOME = previous.home;
    }
  });

  it("atomically verifies and binds the subscription transition", async () => {
    mockTestEnvironment.mockResolvedValue(probe("pass", ["claude_hello_probe_passed"]));
    mockVerifyAndBindSubscription.mockResolvedValueOnce({
      credentialIds: ["credential-1"],
      bindingIds: ["binding-1"],
    });

    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }]))).post(
      `/api/companies/${COMPANY_ID}/internal-agent/verify`,
    );

    expect(res.status).toBe(200);
    expect(mockVerifyAndBindSubscription).toHaveBeenCalledTimes(1);
  });

  it("does not verify a subscription record when the passing probe used an API key", async () => {
    mockProbeConfig.mockResolvedValueOnce({
      env: {
        ANTHROPIC_API_KEY: "company-key",
        CLAUDE_CONFIG_DIR: "/scoped/anthropic",
      },
    });
    mockTestEnvironment.mockResolvedValue(probe("pass", ["claude_hello_probe_passed"]));

    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }]))).post(
      `/api/companies/${COMPANY_ID}/internal-agent/verify`,
    );

    expect(res.status).toBe(200);
    expect(mockVerifyAndBindSubscription).not.toHaveBeenCalled();
  });

  it("returns 429 while a Commander probe is already running for the company", async () => {
    let releaseProbe!: () => void;
    let signalProbeStarted!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve; });
    const passingProbe = probe("pass", ["claude_hello_probe_passed"]);

    mockTestEnvironment.mockImplementationOnce(async () => {
      signalProbeStarted();
      await probeGate;
      return passingProbe;
    });
    mockTestEnvironment.mockResolvedValueOnce(passingProbe);

    const app = makeApp(dbWithMembership([{ id: COMPANY_ID }]));
    let resolveFirst!: (response: request.Response) => void;
    const firstResponse = new Promise<request.Response>((resolve) => { resolveFirst = resolve; });
    request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({})
      .end((_error, response) => resolveFirst(response));

    await probeStarted;
    const concurrentResponse = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    releaseProbe();
    const completedResponse = await firstResponse;
    const retryResponse = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(concurrentResponse.status).toBe(429);
    expect(concurrentResponse.headers["retry-after"]).toBe("30");
    expect(concurrentResponse.body.error).toMatch(/already running/i);
    expect(completedResponse.status).toBe(200);
    expect(retryResponse.status).toBe(200);
    expect(mockTestEnvironment).toHaveBeenCalledTimes(2);
  });

  it("allows Commander probes for different companies to run concurrently", async () => {
    let releaseProbe!: () => void;
    let signalProbeStarted!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve; });
    const passingProbe = probe("pass", ["claude_hello_probe_passed"]);

    mockTestEnvironment.mockImplementationOnce(async () => {
      signalProbeStarted();
      await probeGate;
      return passingProbe;
    });
    mockTestEnvironment.mockResolvedValueOnce(passingProbe);

    const app = makeApp(dbWithMembership([]), {
      type: "board",
      source: "session",
      userId: "u1",
      isInstanceAdmin: true,
      companyIds: [],
    });
    let resolveFirst!: (response: request.Response) => void;
    const firstResponse = new Promise<request.Response>((resolve) => { resolveFirst = resolve; });
    request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({})
      .end((_error, response) => resolveFirst(response));

    await probeStarted;
    const otherCompanyResponse = await request(app)
      .post("/api/companies/c2/internal-agent/verify")
      .send({});
    releaseProbe();
    const completedResponse = await firstResponse;

    expect(otherCompanyResponse.status).toBe(200);
    expect(completedResponse.status).toBe(200);
    expect(mockTestEnvironment).toHaveBeenCalledTimes(2);
  });

  it("releases the company probe slot when Commander verification throws", async () => {
    mockTestEnvironment
      .mockRejectedValueOnce(new Error("probe crashed"))
      .mockResolvedValueOnce(probe("pass", ["claude_hello_probe_passed"]));
    const app = makeApp(dbWithMembership([{ id: COMPANY_ID }]));

    const failedResponse = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});
    const retryResponse = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(failedResponse.status).toBe(500);
    expect(retryResponse.status).toBe(200);
    expect(mockTestEnvironment).toHaveBeenCalledTimes(2);
  });

  it("422 needs_auth (blocking) when login is required", async () => {
    mockTestEnvironment.mockResolvedValue(probe("fail", ["claude_hello_probe_auth_required"]));
    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.outcome).toBe("needs_auth");
    expect(mockVerifyAndBindSubscription).not.toHaveBeenCalled();
  });

  it("redacts secret-looking probe detail before returning it to onboarding", async () => {
    mockTestEnvironment.mockResolvedValue({
      adapterType: "claude_local",
      status: "fail",
      checks: [{
        code: "claude_hello_probe_failed",
        level: "error",
        message: "Claude hello probe failed.",
        detail: "provider rejected sk-ant-api03-super-secret-value",
        hint: "Inspect sk-ant-api03-super-secret-value",
      }],
      testedAt: "",
    });

    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain("sk-ant-api03-super-secret-value");
    expect(res.body.result.checks[0].detail).toContain("REDACTED");
    expect(res.body.result.checks[0].hint).toContain("REDACTED");
  });

  it("404 when the resolved adapter has no probe", async () => {
    mockFindAdapter.mockReturnValue(null);
    const res = await request(makeApp(dbWithMembership([{ id: COMPANY_ID }])))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});
    expect(res.status).toBe(404);
  });
});
