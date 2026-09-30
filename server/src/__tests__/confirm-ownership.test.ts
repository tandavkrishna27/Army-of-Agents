import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

// ── Drizzle mock ──────────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  internalAgentConversations: makeTableProxy("internal_agent_conversations"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  internalAgentMessages: makeTableProxy("internal_agent_messages"),
  internalAgentRuns: makeTableProxy("internal_agent_runs"),
  internalAgentReminders: makeTableProxy("internal_agent_reminders"),
  userRoles: makeTableProxy("user_roles"),
}));

// ── Auth mocks ────────────────────────────────────────────────────────────────
const mockGetActorInfo = vi.hoisted(() =>
  vi.fn(() => ({
    actorType: "user" as const,
    actorId: "user-aaaa-aaaa-4aaa-8aaa-000000000001",
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

// ── Agent loop mock ───────────────────────────────────────────────────────────
// mockChat is hoisted so it can be used in vi.mock factory AND in tests.
const mockChat = vi.hoisted(() => vi.fn());

vi.mock("../services/internal-agent/agent-loop.js", () => ({
  agentLoopService: vi.fn(() => ({ chat: mockChat })),
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

vi.mock("../services/internal-agent/tool-registry.js", () => ({
  createToolRegistry: vi.fn(() => [
    { name: "list_tasks", description: "List tasks", requiresConfirmation: true },
  ]),
  executeTool: vi.fn(async () => ({ success: true, summary: "ok", error: null })),
}));

vi.mock("../services/internal-agent/service-container.js", () => ({
  createServiceContainer: vi.fn(() => ({})),
}));

const mockDeny = vi.hoisted(() => vi.fn());
const mockClaimForExecution = vi.hoisted(() => vi.fn());
const mockMarkExecuted = vi.hoisted(() => vi.fn());
const mockMarkFailed = vi.hoisted(() => vi.fn());
const mockCreateTrustRule = vi.hoisted(() => vi.fn());

vi.mock("../services/internal-agent/runtime-approvals.js", () => ({
  runtimeApprovalService: vi.fn(() => ({
    deny: mockDeny,
    claimForExecution: mockClaimForExecution,
    markExecuted: mockMarkExecuted,
    markFailed: mockMarkFailed,
    createTrustRule: mockCreateTrustRule,
  })),
}));

vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: vi.fn().mockResolvedValue("team_member"),
    isFounder: vi.fn().mockResolvedValue(false),
    getUserRoles: vi.fn().mockResolvedValue([]),
  })),
}));

// ── Constants ─────────────────────────────────────────────────────────────────
const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
const USER_A    = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const USER_B    = "bbbbbbbb-bbbb-4bbb-8bbb-000000000003";
// Unique confirmIds per test (valid UUIDs) — avoids Map pollution
const CONFIRM_T1 = "11111111-1111-4111-8111-000000000001";
const CONFIRM_T2 = "22222222-2222-4222-8222-000000000002";
const CONFIRM_T3 = "33333333-3333-4333-8333-000000000003";

// ── Imports (after all vi.mock calls) ────────────────────────────────────────
import { internalAgentRoutes } from "../routes/internal-agent.js";
import { errorHandler } from "../middleware/index.js";

// ── DB factory ────────────────────────────────────────────────────────────────
// Chat endpoint uses insert + select + update. Confirm endpoint has no direct DB
// calls before executeTool (which is separately mocked).
function makeDb() {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "run-id" }])),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ enabledCapabilities: [] }])),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };
}

// ── App factory ───────────────────────────────────────────────────────────────
// Actor identity is controlled via mockGetActorInfo per-request, not here.
function makeApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      source: "session",
      userId: "unused",
      companyIds: [COMPANY_A, COMPANY_B],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", internalAgentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

// ── Helper: emit an action_confirmation chunk through the SSE chat endpoint ───
async function seedPending(
  app: ReturnType<typeof makeApp>,
  companyId: string,
  actorId: string,
  confirmId: string,
) {
  mockGetActorInfo.mockReturnValue({
    actorType: "user" as const,
    actorId,
    agentId: null,
    runId: null,
  });
  mockChat.mockImplementation(async function* () {
    yield {
      type: "action_confirmation",
      runId: confirmId,
      toolName: "list_tasks",
      params: {},
    };
  });
  await request(app)
    .post(`/api/companies/${companyId}/internal-agent/chat`)
    .send({ message: "seed" });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /confirm — user ownership check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeny.mockResolvedValue({ id: CONFIRM_T2, status: "denied" });
    mockClaimForExecution.mockImplementation(async (_id, companyId, userId) =>
      companyId === COMPANY_A && userId === USER_A
        ? {
            id: CONFIRM_T1,
            companyId: COMPANY_A,
            userId: USER_A,
            toolName: "list_tasks",
            params: {},
          }
        : null,
    );
    mockMarkExecuted.mockResolvedValue({ id: CONFIRM_T1, status: "approved" });
    mockMarkFailed.mockResolvedValue({ id: CONFIRM_T1, status: "failed" });
    mockCreateTrustRule.mockResolvedValue({ id: "trust-1" });
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: USER_A,
      agentId: null,
      runId: null,
    });
  });

  it("returns 404 when USER_B tries to confirm USER_A's pending action", async () => {
    const app = makeApp(makeDb());
    await seedPending(app, COMPANY_A, USER_A, CONFIRM_T1);

    // Switch actor to USER_B and attempt to confirm
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: USER_B,
      agentId: null,
      runId: null,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_T1, approved: true });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining("pending confirmation") });
    const { executeTool } = await import("../services/internal-agent/tool-registry.js");
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("allows USER_A to confirm their own pending action (same actor)", async () => {
    const app = makeApp(makeDb());
    await seedPending(app, COMPANY_A, USER_A, CONFIRM_T2);

    // Confirm as USER_A — use approved: false to return early before tool execution.
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: USER_A,
      agentId: null,
      runId: null,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_T2, approved: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ confirmId: CONFIRM_T2, result: "denied" });
  });

  it("returns 404 when confirmId belongs to a different company (existing check preserved)", async () => {
    // Seed in COMPANY_A, then attempt confirm at COMPANY_B — existing check fires first
    const app = makeApp(makeDb());
    await seedPending(app, COMPANY_A, USER_A, CONFIRM_T3);

    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: USER_A,
      agentId: null,
      runId: null,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_B}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_T3, approved: true });

    expect(res.status).toBe(404);
  });
});
