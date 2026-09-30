import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  internalAgentConversations: makeTableProxy("internal_agent_conversations"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  internalAgentMessages: makeTableProxy("internal_agent_messages"),
  internalAgentRuns: makeTableProxy("internal_agent_runs"),
  internalAgentReminders: makeTableProxy("internal_agent_reminders"),
  internalAgentRuntimeApprovals: makeTableProxy("internal_agent_runtime_approvals"),
  internalAgentToolTrustRules: makeTableProxy("internal_agent_tool_trust_rules"),
  userRoles: makeTableProxy("user_roles"),
}));

const mockGetActorInfo = vi.hoisted(() =>
  vi.fn(() => ({
    actorType: "user" as const,
    actorId: "user-1",
    agentId: null,
    runId: null,
  })),
);
vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: mockGetActorInfo,
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertDepartmentAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryApproval: vi.fn().mockResolvedValue(undefined),
  assertEntityAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../middleware/rate-limit.js", () => ({
  internalAgentChatLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../services/internal-agent/agent-loop.js", () => ({
  agentLoopService: vi.fn(() => ({ chat: vi.fn() })),
}));

vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: vi.fn(async () => "agent-id"),
  COMMANDER_TOOL_ALLOWLIST: [],
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: vi.fn(() => ({
    listSkillListItemsForAgent: vi.fn(async () => []),
    resolveSkillKeys: vi.fn(async () => []),
  })),
}));

const executeToolMock = vi.hoisted(() =>
  vi.fn(async () => ({
    success: true,
    data: { id: "issue-1" },
    summary: "Created issue",
  })),
);
vi.mock("../services/internal-agent/tool-registry.js", () => ({
  createToolRegistry: vi.fn(() => [
    {
      name: "create_task",
      description: "Create task",
      category: "action",
      requiredRole: "team_member",
      requiresConfirmation: true,
      execute: vi.fn(),
    },
  ]),
  executeTool: executeToolMock,
}));

vi.mock("../services/internal-agent/service-container.js", () => ({
  createServiceContainer: vi.fn(() => ({})),
}));

vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: vi.fn().mockResolvedValue("team_member"),
    isFounder: vi.fn().mockResolvedValue(false),
    getUserRoles: vi.fn().mockResolvedValue([]),
  })),
}));

const runtimeApprovalServiceMock = vi.hoisted(() => vi.fn());
vi.mock("../services/internal-agent/runtime-approvals.js", () => ({
  runtimeApprovalService: runtimeApprovalServiceMock,
}));

import { internalAgentRoutes } from "../routes/internal-agent.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const CONFIRM_ID = "11111111-1111-4111-8111-000000000001";
const TRUST_ID = "22222222-2222-4222-8222-000000000001";

function makeDb(
  configOverrides: Partial<{
    enabledCapabilities: string[];
    commanderToolPermissions: Record<string, unknown>;
    runtimeApprovalsEnabled: boolean;
    runtimeAllowAlwaysEnabled: boolean;
  }> = {},
) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "run-id" }])),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Promise.resolve([
            {
              enabledCapabilities: ["system_actions"],
              commanderToolPermissions: {},
              runtimeApprovalsEnabled: true,
              runtimeAllowAlwaysEnabled: true,
              ...configOverrides,
            },
          ]),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };
}

function makeApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", internalAgentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

function makeApproval() {
  return {
    id: CONFIRM_ID,
    companyId: COMPANY_ID,
    userId: "user-1",
    toolName: "create_task",
    params: { title: "Stored title" },
    status: "executing",
    paramsHash: "hash-1",
    paramsHashVersion: "v1",
  };
}

function installRuntimeService(overrides: Record<string, unknown> = {}) {
  const svc = {
    deny: vi.fn(async () => ({ id: CONFIRM_ID, status: "denied" })),
    claimForExecution: vi.fn(async () => makeApproval()),
    listTrustRules: vi.fn(async () => []),
    createTrustRule: vi.fn(async () => ({ id: "trust-1" })),
    revokeTrustRule: vi.fn(async () => ({ id: TRUST_ID, enabled: false })),
    markExecuted: vi.fn(async () => ({ id: CONFIRM_ID, status: "approved" })),
    markFailed: vi.fn(async () => ({ id: CONFIRM_ID, status: "failed" })),
    ...overrides,
  };
  runtimeApprovalServiceMock.mockReturnValue(svc);
  return svc;
}

describe("POST /internal-agent/confirm durable runtime approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: "user-1",
      agentId: null,
      runId: null,
    });
    executeToolMock.mockResolvedValue({
      success: true,
      data: { id: "issue-1" },
      summary: "Created issue",
    });
  });

  it("denies a durable approval without executing the tool", async () => {
    const svc = installRuntimeService();
    const app = makeApp(makeDb());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_ID, decision: "deny" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ confirmId: CONFIRM_ID, result: "denied" });
    expect(svc.deny).toHaveBeenCalledWith(CONFIRM_ID, COMPANY_ID, "user-1");
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("allow_once claims and executes the stored approval params", async () => {
    const svc = installRuntimeService();
    const app = makeApp(makeDb());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_ID, decision: "allow_once" });

    expect(res.status).toBe(200);
    expect(svc.claimForExecution).toHaveBeenCalledWith(
      CONFIRM_ID,
      COMPANY_ID,
      "user-1",
      "allow_once",
    );
    expect(executeToolMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "create_task" }),
      { title: "Stored title" },
      expect.objectContaining({ userRole: "team_member" }),
    );
    expect(svc.markExecuted).toHaveBeenCalledWith(CONFIRM_ID, COMPANY_ID, {
      summary: "Created issue",
      entityType: null,
      entityId: null,
    });
    expect(res.body).toMatchObject({ result: "executed", summary: "Created issue" });
  });

  it("returns not found and does not execute when atomic claim fails", async () => {
    installRuntimeService({ claimForExecution: vi.fn(async () => null) });
    const app = makeApp(makeDb());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_ID, decision: "allow_once" });

    expect(res.status).toBe(404);
    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("allow_always creates exact trust only after successful execution", async () => {
    const svc = installRuntimeService();
    const app = makeApp(makeDb());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_ID, decision: "allow_always" });

    expect(res.status).toBe(200);
    expect(svc.createTrustRule).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      userId: "user-1",
      toolName: "create_task",
      params: { title: "Stored title" },
      createdByUserId: "user-1",
    });
    expect(executeToolMock).toHaveBeenCalledOnce();
  });

  it("allow_always executes once without creating trust when durable trust is disabled", async () => {
    const svc = installRuntimeService();
    const app = makeApp(makeDb({ runtimeAllowAlwaysEnabled: false }));

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_ID, decision: "allow_always" });

    expect(res.status).toBe(200);
    expect(svc.createTrustRule).not.toHaveBeenCalled();
    expect(executeToolMock).toHaveBeenCalledOnce();
  });

  it("marks approval failed and does not trust the action when tool execution fails", async () => {
    executeToolMock.mockResolvedValue({
      success: false,
      data: null,
      summary: "Role denied",
      error: "FORBIDDEN_ROLE",
    });
    const svc = installRuntimeService();
    const app = makeApp(makeDb());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_ID, decision: "allow_always" });

    expect(res.status).toBe(200);
    expect(svc.createTrustRule).not.toHaveBeenCalled();
    expect(svc.markFailed).toHaveBeenCalledWith(
      CONFIRM_ID,
      COMPANY_ID,
      "FORBIDDEN_ROLE",
    );
    expect(res.body).toMatchObject({ result: "failed", error: "FORBIDDEN_ROLE" });
  });

  it("lists current user's durable trust rules", async () => {
    const svc = installRuntimeService({
      listTrustRules: vi.fn(async () => [
        {
          id: TRUST_ID,
          toolName: "create_task",
          scope: "exact_params",
          paramsHash: "abcdef123456",
          paramsHashVersion: "v1",
          createdAt: new Date("2026-05-26T00:00:00.000Z"),
          lastUsedAt: null,
          expiresAt: null,
        },
      ]),
    });
    const app = makeApp(makeDb());

    const res = await request(app).get(
      `/api/companies/${COMPANY_ID}/internal-agent/tool-trust-rules`,
    );

    expect(res.status).toBe(200);
    expect(svc.listTrustRules).toHaveBeenCalledWith(COMPANY_ID, "user-1");
    expect(res.body.rules).toHaveLength(1);
    expect(res.body.rules[0]).toMatchObject({
      id: TRUST_ID,
      toolName: "create_task",
      scope: "exact_params",
      paramsHashPrefix: "abcdef12",
      paramsHashVersion: "v1",
    });
  });

  it("revokes a current user's durable trust rule", async () => {
    const svc = installRuntimeService();
    const app = makeApp(makeDb());

    const res = await request(app).delete(
      `/api/companies/${COMPANY_ID}/internal-agent/tool-trust-rules/${TRUST_ID}`,
    );

    expect(res.status).toBe(200);
    expect(svc.revokeTrustRule).toHaveBeenCalledWith(TRUST_ID, COMPANY_ID, "user-1");
    expect(res.body).toEqual({ success: true });
  });
});
