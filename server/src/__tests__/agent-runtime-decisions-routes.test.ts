import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { agentRuntimeDecisionRoutes } from "../routes/agent-runtime-decisions.js";

const mockRuntimeDecisions = vi.hoisted(() => ({
  getDetail: vi.fn(),
  answerPrompt: vi.fn(),
  listTrustRules: vi.fn(),
  revokeTrustRule: vi.fn(),
}));

const mockHubItems = vi.hoisted(() => ({
  getVisibleBySource: vi.fn(),
}));

const mockPerms = vi.hoisted(() => ({
  isFounder: vi.fn(),
  getEffectiveRole: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentRuntimeDecisionService: () => mockRuntimeDecisions,
  hubItemsService: () => mockHubItems,
  permissionService: () => mockPerms,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";
const DECISION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TRUST_RULE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const permissionDetail = {
  id: DECISION_ID,
  hubItemId: null,
  companyId: COMPANY_A,
  agentId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
  adapterType: "openai_codex",
  adapterSessionId: "session-1",
  kind: "permission",
  status: "created",
  sourceRevision: 2,
  nonce: "nonce-1",
  title: "Allow command?",
  summary: "The agent wants to run a command",
  promptText: "May I run pnpm test?",
  toolName: "shell",
  command: "pnpm test",
  cwd: "C:/repo",
  path: null,
  networkTarget: null,
  riskClass: "medium",
  options: null,
  timeoutPolicy: "deny",
  expiresAt: null,
  answeredAt: null,
  relayedAt: null,
  relayError: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const trustRule = {
  id: TRUST_RULE_ID,
  companyId: COMPANY_A,
  agentId: "22222222-2222-2222-2222-222222222222",
  adapterType: "openai_codex",
  toolName: "shell",
  commandHash: "abc123456789",
  pathScope: "C:/repo",
  networkScope: null,
  riskClass: "medium",
  enabled: true,
  expiresAt: null,
  createdByUserId: "user-1",
  lastUsedAt: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
};

function boardActor(
  overrides: Partial<{
    userId: string;
    companyIds: string[];
    isInstanceAdmin: boolean;
    source: string;
  }> = {},
) {
  return {
    type: "board" as const,
    userId: overrides.userId ?? "user-1",
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

function createApp(actor: unknown = boardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", agentRuntimeDecisionRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("agent runtime decision routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPerms.isFounder.mockResolvedValue(true);
    mockPerms.getEffectiveRole.mockResolvedValue("team_member");
    mockHubItems.getVisibleBySource.mockResolvedValue(null);
    mockRuntimeDecisions.getDetail.mockResolvedValue(permissionDetail);
    mockRuntimeDecisions.answerPrompt.mockResolvedValue({ ...permissionDetail, status: "answered", sourceRevision: 3 });
    mockRuntimeDecisions.listTrustRules.mockResolvedValue([trustRule]);
    mockRuntimeDecisions.revokeTrustRule.mockResolvedValue({ ...trustRule, enabled: false });
  });

  it("GET trust rules requires founder authority and does not fall through to detail", async () => {
    mockPerms.isFounder.mockResolvedValue(false);

    const rejected = await request(createApp())
      .get(`/api/companies/${COMPANY_A}/agent-runtime-decisions/trust-rules`);

    expect(rejected.status).toBe(403);
    expect(mockRuntimeDecisions.getDetail).not.toHaveBeenCalled();
    expect(mockRuntimeDecisions.listTrustRules).not.toHaveBeenCalled();

    mockPerms.isFounder.mockResolvedValue(true);
    const allowed = await request(createApp())
      .get(`/api/companies/${COMPANY_A}/agent-runtime-decisions/trust-rules`);

    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.rules).toEqual([
      expect.objectContaining({
        id: TRUST_RULE_ID,
        adapterType: "openai_codex",
        commandHashPrefix: "abc12345",
        enabled: true,
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
    ]);
    expect(mockRuntimeDecisions.listTrustRules).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      includeDisabled: false,
    });
    expect(mockRuntimeDecisions.getDetail).not.toHaveBeenCalled();
  });

  it("DELETE trust rule requires founder authority and revokes by company", async () => {
    mockPerms.isFounder.mockResolvedValue(false);

    const rejected = await request(createApp())
      .delete(`/api/companies/${COMPANY_A}/agent-runtime-decisions/trust-rules/${TRUST_RULE_ID}`);

    expect(rejected.status).toBe(403);
    expect(mockRuntimeDecisions.revokeTrustRule).not.toHaveBeenCalled();

    mockPerms.isFounder.mockResolvedValue(true);
    const allowed = await request(createApp())
      .delete(`/api/companies/${COMPANY_A}/agent-runtime-decisions/trust-rules/${TRUST_RULE_ID}`);

    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body).toEqual({ success: true });
    expect(mockRuntimeDecisions.revokeTrustRule).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      ruleId: TRUST_RULE_ID,
      actorUserId: "user-1",
    });
  });

  it("GET detail requires board authentication and company access", async () => {
    const noAuth = await request(createApp({ type: "none", source: "none" }))
      .get(`/api/companies/${COMPANY_A}/agent-runtime-decisions/${DECISION_ID}`);
    expect(noAuth.status).toBe(401);

    const wrongCompany = await request(createApp(boardActor({ companyIds: [COMPANY_B] })))
      .get(`/api/companies/${COMPANY_A}/agent-runtime-decisions/${DECISION_ID}`);
    expect(wrongCompany.status).toBe(403);
    expect(mockRuntimeDecisions.getDetail).not.toHaveBeenCalled();
  });

  it("GET detail returns a runtime decision for founders", async () => {
    const res = await request(createApp())
      .get(`/api/companies/${COMPANY_A}/agent-runtime-decisions/${DECISION_ID}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: DECISION_ID, kind: "permission", sourceRevision: 2 });
    expect(mockRuntimeDecisions.getDetail).toHaveBeenCalledWith(COMPANY_A, DECISION_ID);
    expect(mockHubItems.getVisibleBySource).not.toHaveBeenCalled();
  });

  it("GET detail allows non-founder board users only when the hub item is visible", async () => {
    mockPerms.isFounder.mockResolvedValue(false);
    mockPerms.getEffectiveRole.mockResolvedValue("team_member");
    mockHubItems.getVisibleBySource.mockResolvedValue({ id: "hub-1" });

    const allowed = await request(createApp())
      .get(`/api/companies/${COMPANY_A}/agent-runtime-decisions/${DECISION_ID}`);

    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(mockHubItems.getVisibleBySource).toHaveBeenCalledWith(COMPANY_A, {
      sourceType: "runtime_decision",
      sourceId: DECISION_ID,
      actorUserId: "user-1",
      role: "team_member",
      status: "any",
    });
    expect(mockRuntimeDecisions.getDetail).toHaveBeenCalledWith(COMPANY_A, DECISION_ID);
  });

  it("GET detail hides prompts from non-founder board users without visible hub access", async () => {
    mockPerms.isFounder.mockResolvedValue(false);
    mockPerms.getEffectiveRole.mockResolvedValue("team_member");
    mockHubItems.getVisibleBySource.mockResolvedValue(null);

    const res = await request(createApp())
      .get(`/api/companies/${COMPANY_A}/agent-runtime-decisions/${DECISION_ID}`);

    expect(res.status).toBe(404);
    expect(mockRuntimeDecisions.getDetail).not.toHaveBeenCalled();
  });

  it("POST answer rejects non-founder board users before mutating", async () => {
    mockPerms.isFounder.mockResolvedValue(false);

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_A}/agent-runtime-decisions/${DECISION_ID}/answer`)
      .send({
        kind: "permission",
        decision: "allow_once",
        expectedSourceRevision: 2,
        nonce: "nonce-1",
      });

    expect(res.status).toBe(403);
    expect(mockRuntimeDecisions.answerPrompt).not.toHaveBeenCalled();
  });

  it("POST answer accepts permission decisions and threads optimistic concurrency fields", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_A}/agent-runtime-decisions/${DECISION_ID}/answer`)
      .send({
        kind: "permission",
        decision: "allow_once",
        expectedSourceRevision: 2,
        nonce: "nonce-1",
        idempotencyKey: "idem-1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockRuntimeDecisions.answerPrompt).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      decisionId: DECISION_ID,
      actorUserId: "user-1",
      kind: "permission",
      decision: "allow_once",
      expectedSourceRevision: 2,
      nonce: "nonce-1",
      idempotencyKey: "idem-1",
    });
  });

  it("POST answer rejects invalid work-question payloads", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_A}/agent-runtime-decisions/${DECISION_ID}/answer`)
      .send({
        kind: "work_question",
        decision: "deny",
        expectedSourceRevision: 2,
        nonce: "nonce-1",
      });

    expect(res.status).toBe(400);
    expect(mockRuntimeDecisions.answerPrompt).not.toHaveBeenCalled();
  });

  it("POST answer returns stale-prompt conflicts from the service", async () => {
    mockRuntimeDecisions.answerPrompt.mockRejectedValue(
      new HttpError(409, "Runtime decision source revision mismatch"),
    );

    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_A}/agent-runtime-decisions/${DECISION_ID}/answer`)
      .send({
        kind: "permission",
        decision: "deny",
        expectedSourceRevision: 1,
        nonce: "nonce-1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Runtime decision source revision mismatch");
  });
});
