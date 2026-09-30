/**
 * Runtime HTTP tests verifying that the confirm endpoint re-fetches
 * permissions at execute time rather than using the stale snapshot from
 * when Commander asked for confirmation.
 *
 * Scenario:
 *   1. Chat endpoint fires → permissionService returns "founder"
 *      → SSE forwards the durable confirmId that the CLI/MCP path created.
 *      Permissions (userRole, enabledCapabilities) are NOT snapshotted. [Codex-P1 fix]
 *   2. Role changes: permissionService now returns "team_member"
 *   3. User clicks Confirm → confirm endpoint fires
 *   4. After fix: confirm handler re-fetches role from DB → executeTool gets "team_member"
 *   5. Before fix (pre-P1): executeTool would have used the stale "founder" snapshot
 */

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

// ── Controllable permissionService mock ───────────────────────────────────────
// vi.hoisted so the factory below can reference the spy.
const mockGetEffectiveRole = vi.hoisted(() => vi.fn().mockResolvedValue("team_member"));

vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: mockGetEffectiveRole,
    isFounder: vi.fn().mockResolvedValue(false),
    getUserRoles: vi.fn().mockResolvedValue([]),
  })),
}));

// ── Auth mocks ────────────────────────────────────────────────────────────────
// NOTE: Do NOT reference module-scope constants (USER_A etc.) inside the
// vi.hoisted factory — those constants are in the temporal dead zone when
// the hoisted factory executes. The implementation is set in beforeEach.
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

// ── Agent loop mock — emits action_confirmation chunk ────────────────────────
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
    { name: "change_goal_status", description: "Change goal status", requiredRole: "founder" },
  ]),
  executeTool: vi.fn(async () => ({ success: true, summary: "done", error: null })),
}));

vi.mock("../services/internal-agent/service-container.js", () => ({
  createServiceContainer: vi.fn(() => ({})),
}));

const mockClaimForExecution = vi.hoisted(() => vi.fn());
const mockMarkExecuted = vi.hoisted(() => vi.fn());
const mockMarkFailed = vi.hoisted(() => vi.fn());

vi.mock("../services/internal-agent/runtime-approvals.js", () => ({
  runtimeApprovalService: vi.fn(() => ({
    deny: vi.fn(),
    claimForExecution: mockClaimForExecution,
    createTrustRule: vi.fn(),
    markExecuted: mockMarkExecuted,
    markFailed: mockMarkFailed,
  })),
}));

// ── Constants ─────────────────────────────────────────────────────────────────
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const CONFIRM_1 = "11111111-1111-4111-8111-000000000001";

// ── Imports (after all vi.mock calls) ────────────────────────────────────────
import { internalAgentRoutes } from "../routes/internal-agent.js";
import { errorHandler } from "../middleware/index.js";

// ── DB factory ────────────────────────────────────────────────────────────────
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

// ── Helper: emit an action_confirmation chunk through the chat SSE endpoint ───
async function seedPending(
  app: ReturnType<typeof makeApp>,
  confirmId: string,
) {
  mockChat.mockImplementation(async function* () {
    yield {
      type: "action_confirmation",
      runId: confirmId,
      toolName: "change_goal_status",
      params: { goalId: "goal-1", status: "achieved" },
    };
  });
  await request(app)
    .post(`/api/companies/${COMPANY_ID}/internal-agent/chat`)
    .send({ message: "mark goal as achieved" });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /confirm — stale permissions (re-fetch at execute time)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClaimForExecution.mockResolvedValue({
      id: CONFIRM_1,
      companyId: COMPANY_ID,
      userId: USER_A,
      toolName: "change_goal_status",
      params: { goalId: "goal-1", status: "achieved" },
    });
    mockMarkExecuted.mockResolvedValue({ id: CONFIRM_1, status: "approved" });
    mockMarkFailed.mockResolvedValue({ id: CONFIRM_1, status: "failed" });
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: USER_A,
      agentId: null,
      runId: null,
    });
  });

  it("uses current userRole at execute time, not the role snapshotted at prompt time", async () => {
    const db = makeDb();
    const app = makeApp(db);

    // Phase 1: seed with founder role active. The chat endpoint stores the
    // confirmation metadata (toolName, params, actorType) but does NOT snapshot
    // the role — permissions are re-fetched at confirm time. [Codex-P1 fix]
    mockGetEffectiveRole.mockResolvedValue("founder");
    await seedPending(app, CONFIRM_1);

    // Phase 2: role is downgraded before the user clicks Confirm.
    mockGetEffectiveRole.mockResolvedValue("team_member");

    // Phase 3: user clicks Confirm. After the fix, the confirm handler
    // re-fetches the role and passes "team_member" to executeTool.
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_1, approved: true });

    expect(res.status).toBe(200);

    // The critical assertion: executeTool must receive the CURRENT role
    // ("team_member"), not the stale snapshot ("founder").
    const { executeTool } = await import(
      "../services/internal-agent/tool-registry.js"
    );
    expect(vi.mocked(executeTool)).toHaveBeenCalledWith(
      expect.objectContaining({ name: "change_goal_status" }),
      expect.objectContaining({ goalId: "goal-1" }),
      expect.objectContaining({ userRole: "team_member" }),
    );
  });

  it("uses current enabledCapabilities at execute time (not stale snapshot)", async () => {
    const db = makeDb();
    const app = makeApp(db);

    // Seed with full capabilities in DB (mock returns enabledCapabilities: ["system_actions"])
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Promise.resolve([{ enabledCapabilities: ["system_actions"] }]),
        ),
      })),
    });
    mockGetEffectiveRole.mockResolvedValue("founder");

    const CONFIRM_2 = "22222222-2222-4222-8222-000000000002";
    mockClaimForExecution.mockResolvedValue({
      id: CONFIRM_2,
      companyId: COMPANY_ID,
      userId: USER_A,
      toolName: "change_goal_status",
      params: { goalId: "goal-1", status: "achieved" },
    });
    await seedPending(app, CONFIRM_2);

    // Capabilities are now disabled at company level (empty array).
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ enabledCapabilities: [] }])),
      })),
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_2, approved: true });

    expect(res.status).toBe(200);

    const { executeTool } = await import(
      "../services/internal-agent/tool-registry.js"
    );
    // enabledCapabilities passed to executeTool must be the CURRENT value (empty),
    // not the snapshot (["system_actions"]).
    expect(vi.mocked(executeTool)).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ enabledCapabilities: [] }),
    );
  });
});
