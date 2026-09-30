// W7.5e — Task 3 (SC7): the host confirm route (`routes/internal-agent.ts:419-577`)
// is UNCHANGED and sandbox-agnostic. It executes the approved tool HOST-SIDE
// against the control-plane `db`, re-fetching fresh role + capabilities, and it
// NEVER reaches for a sandbox / lease / acquire path.
//
// This is a regression lock: W7.5e adds NO production code to the confirm route.
// Approvals over the broker are the ⚡CONFIRM MARKER (a non-blocking tool result
// — see commander-broker-approval.test.ts); the eventual approval always runs
// through this same host-side route, whether the marker was minted by the
// in-process stdio bridge or by the broker. So the confirm route stays byte-
// identical and does not care whether the turn ran in an E2B sandbox.
//
// Harness modeled on confirm-stale-permissions.test.ts (same route + mock db).
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

// ── drizzle-orm mock (ESM circular-dep workaround) ───────────────────────────
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// ── DB table stubs ───────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => ({
  internalAgentConversations: makeTableProxy("internal_agent_conversations"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  internalAgentMessages: makeTableProxy("internal_agent_messages"),
  internalAgentRuns: makeTableProxy("internal_agent_runs"),
  internalAgentReminders: makeTableProxy("internal_agent_reminders"),
  userRoles: makeTableProxy("user_roles"),
}));

// ── Fresh role at execute time (re-fetched — NOT the prompt-time snapshot) ────
const mockGetEffectiveRole = vi.hoisted(() => vi.fn().mockResolvedValue("founder"));
vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: mockGetEffectiveRole,
    isFounder: vi.fn().mockResolvedValue(true),
    getUserRoles: vi.fn().mockResolvedValue([]),
  })),
}));

// ── Auth mocks ────────────────────────────────────────────────────────────────
const mockGetActorInfo = vi.hoisted(() => vi.fn());
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

// The approved tool the route looks up + executes HOST-SIDE.
const mockExecuteTool = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, summary: "goal updated", error: null })),
);
vi.mock("../services/internal-agent/tool-registry.js", () => ({
  createToolRegistry: vi.fn(() => [
    { name: "change_goal_status", description: "Change goal status" },
  ]),
  executeTool: mockExecuteTool,
}));

vi.mock("../services/internal-agent/service-container.js", () => ({
  createServiceContainer: vi.fn(() => ({})),
}));

const mockClaimForExecution = vi.hoisted(() => vi.fn());
const mockMarkExecuted = vi.hoisted(() => vi.fn());
const mockMarkFailed = vi.hoisted(() => vi.fn());
const mockCreateTrustRule = vi.hoisted(() => vi.fn());
vi.mock("../services/internal-agent/runtime-approvals.js", () => ({
  runtimeApprovalService: vi.fn(() => ({
    deny: vi.fn(),
    claimForExecution: mockClaimForExecution,
    createTrustRule: mockCreateTrustRule,
    markExecuted: mockMarkExecuted,
    markFailed: mockMarkFailed,
  })),
}));

// SANDBOX-AGNOSTIC PROOF: spy the sandbox acquire entry point. The confirm route
// does not import it — so if the route is host-side, this spy is NEVER called.
// (A future change that made the confirm route reach for a sandbox would trip
// this assertion — the whole point of the regression lock.)
const mockAcquireExecutionContext = vi.hoisted(() => vi.fn());
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: mockAcquireExecutionContext,
}));

// ── Constants ─────────────────────────────────────────────────────────────────
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const CONFIRM_1 = "11111111-1111-4111-8111-000000000001";

// ── Imports (after all vi.mock calls) ────────────────────────────────────────
import { internalAgentRoutes } from "../routes/internal-agent.js";
import { errorHandler } from "../middleware/index.js";

// A control-plane db whose config select returns fresh caps/permissions.
function makeDb() {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: "run-id" }])) })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Promise.resolve([
            {
              enabledCapabilities: ["system_actions"],
              commanderToolPermissions: null,
              runtimeApprovalsEnabled: true,
              runtimeAllowAlwaysEnabled: true,
            },
          ]),
        ),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
  };
}

function makeApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      source: "session",
      userId: USER_A,
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", internalAgentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

describe("POST /confirm — host-side + sandbox-agnostic (W7.5e / SC7 regression lock)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteTool.mockResolvedValue({ success: true, summary: "goal updated", error: null });
    mockClaimForExecution.mockResolvedValue({
      id: CONFIRM_1,
      companyId: COMPANY_ID,
      userId: USER_A,
      toolName: "change_goal_status",
      params: { goalId: "goal-1", status: "achieved" },
      conversationId: null, // skip the (best-effort) output-ref append path
      runId: null,
    });
    mockMarkExecuted.mockResolvedValue({ id: CONFIRM_1, status: "approved" });
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: USER_A,
      agentId: null,
      runId: null,
    });
  });

  it("executes the approved tool host-side with a fresh commander ToolContext and never touches a sandbox", async () => {
    const db = makeDb();
    const app = makeApp(db);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_1, decision: "allow_once" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ confirmId: CONFIRM_1, result: "executed" });

    // Host-side execution against the control-plane db with a commander
    // ToolContext built from FRESH role + capabilities (not the prompt-time
    // snapshot). The db passed to executeTool is the exact route db instance —
    // i.e. the control plane, never a sandbox handle.
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "change_goal_status" }),
      expect.objectContaining({ goalId: "goal-1", status: "achieved" }),
      expect.objectContaining({
        actorType: "commander",
        userRole: "founder", // freshly resolved
        enabledCapabilities: ["system_actions"], // freshly fetched
        db, // control-plane db instance, not a sandbox
      }),
    );

    // The route is sandbox-agnostic: it never acquires an execution context /
    // lease / provider sandbox.
    expect(mockAcquireExecutionContext).not.toHaveBeenCalled();
  });
});
