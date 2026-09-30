import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { cliAuthRoutes } from "../routes/cli-auth.js";
import { forbidden } from "../errors.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeCurrentBoardApiKey: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  boardAuthService: () => mockBoardAuthService,
}));

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", cliAuthRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("cli auth routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDeploymentMode("local_trusted");
  });

  it("creates a CLI auth challenge with approval metadata", async () => {
    mockBoardAuthService.createCliAuthChallenge.mockResolvedValue({
      challenge: {
        id: "challenge-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
      challengeSecret: "aoa_cli_auth_secret",
      pendingBoardToken: "aoa_board_token",
    });

    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).post("/api/cli-auth/challenges").send({
      command: "aoa auth login",
      clientName: "aoa cli",
      requestedAccess: "board",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "challenge-1",
      token: "aoa_cli_auth_secret",
      boardApiToken: "aoa_board_token",
      approvalPath: "/cli-auth/challenge-1?token=aoa_cli_auth_secret",
      pollPath: "/cli-auth/challenges/challenge-1",
      expiresAt: "2026-03-23T13:00:00.000Z",
    });
    expect(res.body.approvalUrl).toContain(
      "/cli-auth/challenge-1?token=aoa_cli_auth_secret"
    );
  });

  it("marks challenge status as requiring sign-in for anonymous viewers", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-1",
      status: "pending",
      command: "aoa auth login",
      clientName: "aoa cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });

    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get(
      "/api/cli-auth/challenges/challenge-1?token=aoa_cli_auth_secret"
    );

    expect(res.status).toBe(200);
    expect(res.body.requiresSignIn).toBe(true);
    expect(res.body.canApprove).toBe(false);
  });

  it("allows signed-in board user to view challenge with canApprove=true", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-1",
      status: "pending",
      command: "aoa auth login",
      clientName: "aoa cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app).get(
      "/api/cli-auth/challenges/challenge-1?token=aoa_cli_auth_secret"
    );

    expect(res.status).toBe(200);
    expect(res.body.requiresSignIn).toBe(false);
    expect(res.body.canApprove).toBe(true);
  });

  it("does not allow an existing board key to approve another CLI key", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-board-key",
      status: "pending",
      command: "aoa auth login",
      clientName: "aoa cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      keyId: "board-key-1",
      operator: false,
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const getRes = await request(app).get(
      "/api/cli-auth/challenges/challenge-board-key?token=aoa_cli_auth_secret"
    );
    const postRes = await request(app)
      .post("/api/cli-auth/challenges/challenge-board-key/approve")
      .send({ token: "aoa_cli_auth_secret" });

    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({
      requiresSignIn: true,
      canApprove: false,
    });
    expect(postRes.status).toBe(401);
    expect(mockBoardAuthService.approveCliAuthChallenge).not.toHaveBeenCalled();
  });

  it("allows local implicit to view and approve instance-settings CLI access", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-local",
      status: "pending",
      command: "aoa auth login",
      clientName: "aoa cli",
      requestedAccess: "instance_admin_required",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      newlyApproved: true,
      challenge: {
        id: "challenge-local",
        boardApiKeyId: "board-key-local",
        requestedAccess: "instance_admin_required",
        requestedCompanyId: null,
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([]);
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      operator: false,
      isInstanceAdmin: true,
      companyIds: [],
    });

    const getRes = await request(app).get(
      "/api/cli-auth/challenges/challenge-local?token=aoa_cli_auth_secret"
    );
    const postRes = await request(app)
      .post("/api/cli-auth/challenges/challenge-local/approve")
      .send({ token: "aoa_cli_auth_secret" });

    expect(getRes.status).toBe(200);
    expect(getRes.body).toMatchObject({
      requiresSignIn: false,
      canApprove: true,
    });
    expect(postRes.status).toBe(200);
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      "challenge-local",
      "aoa_cli_auth_secret",
      "local-board",
      { canManageInstanceSettings: true }
    );
  });

  it("allows a session operator to view and approve instance-settings CLI access", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-operator",
      status: "pending",
      command: "aoa auth login",
      clientName: "aoa cli",
      requestedAccess: "instance_admin_required",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });
    const app = createApp({
      type: "board",
      userId: "operator-1",
      source: "session",
      operator: true,
      isInstanceAdmin: false,
      companyIds: [],
    });
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      newlyApproved: true,
      challenge: {
        id: "challenge-operator",
        boardApiKeyId: "board-key-operator",
        requestedAccess: "instance_admin_required",
        requestedCompanyId: null,
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([]);

    const getRes = await request(app).get(
      "/api/cli-auth/challenges/challenge-operator?token=aoa_cli_auth_secret"
    );
    const postRes = await request(app)
      .post("/api/cli-auth/challenges/challenge-operator/approve")
      .send({ token: "aoa_cli_auth_secret" });

    expect(getRes.status).toBe(200);
    expect(getRes.body.canApprove).toBe(true);
    expect(postRes.status).toBe(200);
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      "challenge-operator",
      "aoa_cli_auth_secret",
      "operator-1",
      { canManageInstanceSettings: true }
    );
  });

  it("denies a session non-operator instance-settings CLI approval", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-member",
      status: "pending",
      command: "aoa auth login",
      clientName: "aoa cli",
      requestedAccess: "instance_admin_required",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });
    const app = createApp({
      type: "board",
      userId: "member-1",
      source: "session",
      operator: false,
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    });
    mockBoardAuthService.approveCliAuthChallenge.mockRejectedValue(
      forbidden("Instance admin required")
    );

    const getRes = await request(app).get(
      "/api/cli-auth/challenges/challenge-member?token=aoa_cli_auth_secret"
    );
    const postRes = await request(app)
      .post("/api/cli-auth/challenges/challenge-member/approve")
      .send({ token: "aoa_cli_auth_secret" });

    expect(getRes.status).toBe(200);
    expect(getRes.body.canApprove).toBe(false);
    expect(postRes.status).toBe(403);
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      "challenge-member",
      "aoa_cli_auth_secret",
      "member-1",
      { canManageInstanceSettings: false }
    );
  });

  it("delegates approval and its atomic audit to the board auth service", async () => {
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      newlyApproved: true,
      challenge: {
        id: "challenge-1",
        boardApiKeyId: "board-key-1",
        requestedAccess: "board",
        requestedCompanyId: "company-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([
      "company-1",
    ]);

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-1/approve")
      .send({ token: "aoa_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      approved: true,
      status: "approved",
      userId: "user-1",
      keyId: "board-key-1",
      expiresAt: "2026-03-23T13:00:00.000Z",
    });
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      "challenge-1",
      "aoa_cli_auth_secret",
      "user-1",
      { canManageInstanceSettings: false }
    );
  });

  it("delegates instance-admin approval audit fan-out to the service transaction", async () => {
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      newlyApproved: true,
      challenge: {
        id: "challenge-2",
        boardApiKeyId: "board-key-2",
        requestedAccess: "instance_admin_required",
        requestedCompanyId: null,
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([
      "company-a",
      "company-b",
    ]);

    const app = createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      operator: true,
      isInstanceAdmin: false,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-2/approve")
      .send({ token: "aoa_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      "challenge-2",
      "aoa_cli_auth_secret",
      "admin-1",
      { canManageInstanceSettings: true }
    );
  });

  it("cancels a CLI auth challenge", async () => {
    mockBoardAuthService.cancelCliAuthChallenge.mockResolvedValue({
      status: "cancelled",
      challenge: { id: "challenge-1" },
    });

    const app = createApp({ type: "none", source: "none" });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-1/cancel")
      .send({ token: "aoa_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "cancelled", cancelled: true });
  });

  it("does not duplicate activity or overwrite provenance when approval is replayed", async () => {
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      newlyApproved: false,
      challenge: {
        id: "challenge-replayed",
        boardApiKeyId: "board-key-original",
        requestedAccess: "board",
        requestedCompanyId: "company-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });

    const app = createApp({
      type: "board",
      userId: "user-second",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-replayed/approve")
      .send({ token: "aoa_cli_auth_secret" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      approved: true,
      keyId: "board-key-original",
    });
    expect(
      mockBoardAuthService.resolveBoardActivityCompanyIds
    ).not.toHaveBeenCalled();
  });

  it("fails closed before key minting when a cloud challenge requests another company", async () => {
    setDeploymentMode("cloud_auth");
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-victim",
      status: "pending",
      requestedAccess: "board",
      requestedCompanyId: "company-victim",
    });
    const app = createApp({
      type: "board",
      userId: "user-attacker",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-attacker"],
    });

    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-victim/approve")
      .send({ token: "aoa_cli_auth_secret" });

    expect(res.status).toBe(403);
    expect(mockBoardAuthService.approveCliAuthChallenge).not.toHaveBeenCalled();
    expect(
      mockBoardAuthService.resolveBoardActivityCompanyIds
    ).not.toHaveBeenCalled();
  });

  it("passes only the requested cloud company into the atomic approval audit", async () => {
    setDeploymentMode("cloud_auth");
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-own",
      status: "pending",
      requestedAccess: "board",
      requestedCompanyId: "company-own",
    });
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      newlyApproved: true,
      challenge: {
        id: "challenge-own",
        boardApiKeyId: "board-key-own",
        requestedAccess: "board",
        requestedCompanyId: "company-own",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    const app = createApp({
      type: "board",
      userId: "user-own",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-own", "company-other"],
    });

    await request(app)
      .post("/api/cli-auth/challenges/challenge-own/approve")
      .send({ token: "aoa_cli_auth_secret" })
      .expect(200);

    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      "challenge-own",
      "aoa_cli_auth_secret",
      "user-own",
      {
        canManageInstanceSettings: false,
        activityCompanyIds: ["company-own"],
      }
    );
  });

  it("uses the live cloud actor snapshot for /cli-auth/me", async () => {
    setDeploymentMode("cloud_auth");
    mockBoardAuthService.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-1", name: "User One", email: "user@example.com" },
      companyIds: ["stale-revoked-company"],
      isInstanceAdmin: true,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      keyId: "board-key-1",
      isInstanceAdmin: false,
      companyIds: [],
    });

    const res = await request(app).get("/api/cli-auth/me");

    expect(res.status).toBe(200);
    expect(res.body.companyIds).toEqual([]);
    expect(res.body.isInstanceAdmin).toBe(false);
  });

  it("does not inject revoke activity into legacy tenant rows in cloud mode", async () => {
    setDeploymentMode("cloud_auth");
    mockBoardAuthService.revokeCurrentBoardApiKey.mockResolvedValue({
      id: "board-key-cloud",
      userId: "user-cloud",
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([
      "company-victim",
    ]);
    const app = createApp({
      type: "board",
      userId: "user-cloud",
      keyId: "board-key-cloud",
      source: "board_key",
      isInstanceAdmin: false,
      companyIds: [],
    });

    const res = await request(app)
      .post("/api/cli-auth/revoke-current")
      .send({});

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.revokeCurrentBoardApiKey).toHaveBeenCalledWith({
      keyId: "board-key-cloud",
      userId: "user-cloud",
      activityCompanyIds: [],
    });
    expect(
      mockBoardAuthService.resolveBoardActivityCompanyIds
    ).not.toHaveBeenCalled();
  });

  it("returns current user identity via /cli-auth/me", async () => {
    mockBoardAuthService.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-1", name: "User One", email: "user@example.com" },
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "board_key",
      keyId: "board-key-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app).get("/api/cli-auth/me");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      userId: "user-1",
      source: "board_key",
      keyId: "board-key-1",
    });
  });

  it("rejects /cli-auth/me for non-board actors", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/cli-auth/me");
    expect(res.status).toBe(401);
  });

  it("delegates current-key revocation and its atomic audit to the service", async () => {
    mockBoardAuthService.revokeCurrentBoardApiKey.mockResolvedValue({
      id: "board-key-3",
      userId: "admin-2",
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue([
      "company-z",
    ]);

    const app = createApp({
      type: "board",
      userId: "admin-2",
      keyId: "board-key-3",
      source: "board_key",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/cli-auth/revoke-current")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true, keyId: "board-key-3" });
    expect(mockBoardAuthService.revokeCurrentBoardApiKey).toHaveBeenCalledWith({
      keyId: "board-key-3",
      userId: "admin-2",
    });
  });

  it("rejects revoke for non-board-key source", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .post("/api/cli-auth/revoke-current")
      .send({});
    expect(res.status).toBe(401);
  });
});
