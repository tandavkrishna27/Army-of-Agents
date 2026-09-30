/**
 * Runtime HTTP tests verifying that the runtime-approval confirm endpoint emits
 * viewer navigational refs for approval-gated Commander writes.
 *
 * Bug: the non-approval (auto-run) path builds refs via buildOutputRefs in
 * mcp-bridge.ts executeAndFormat, but the APPROVAL path executed the tool in the
 * confirm route WITHOUT building refs — so approved writes rendered no nav chip.
 * Since runtimeApprovalsEnabled defaults to TRUE, that is the DEFAULT path.
 *
 * Fix: after a confirmed tool executes successfully, build the output refs with
 * the SAME buildOutputRefs the auto-run path uses and persist a small assistant
 * message carrying them (conversationService.appendMessage) so the UI's existing
 * OutputRefChips render path (fired by the confirm handler's refetch) shows them.
 *
 * Assertions:
 *   1. create_task success (data.id) → appendMessage called on
 *      claimed.conversationId with outputRefs containing {kind:"task",action:"created"}.
 *   2. claimed.conversationId === null → appendMessage NOT called (no throw).
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

// ── permissionService (drives resolveActorRole for board sessions) ────────────
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

// ── Tool registry: a create_task tool + executeTool returning a create_task
//    success shape (data.id) so the REAL buildOutputRefs mints a task/created ref.
vi.mock("../services/internal-agent/tool-registry.js", () => ({
  createToolRegistry: vi.fn(() => [
    { name: "create_task", description: "Create a task", requiredRole: "team_member" },
  ]),
  executeTool: vi.fn(async () => ({
    success: true,
    // action-tools.ts:65 → data: issue row (id at data.id).
    data: { id: "task-123", title: "Ship the thing" },
    summary: "Created task Ship the thing",
    error: null,
  })),
}));

vi.mock("../services/internal-agent/service-container.js", () => ({
  createServiceContainer: vi.fn(() => ({})),
}));

// NOTE: output-refs.js is deliberately NOT mocked — the test exercises the REAL
// buildOutputRefs so the assertion proves an actual task/created nav ref is built.

// ── conversationService.appendMessage spy ─────────────────────────────────────
const mockAppendMessage = vi.hoisted(() => vi.fn(async () => ({ id: "msg-1" })));

vi.mock("../services/internal-agent/conversation.js", () => ({
  conversationService: vi.fn(() => ({ appendMessage: mockAppendMessage })),
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

// ── Constants ─────────────────────────────────────────────────────────────────
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-000000000003";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-000000000004";
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
        where: vi.fn(() =>
          Promise.resolve([{ enabledCapabilities: [], runtimeApprovalsEnabled: true }]),
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
      isInstanceAdmin: true, // founder-equivalent board session
    };
    next();
  });
  app.use("/api", internalAgentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /confirm — emit viewer refs for approval-gated writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkExecuted.mockResolvedValue({ id: CONFIRM_1, status: "approved" });
    mockMarkFailed.mockResolvedValue({ id: CONFIRM_1, status: "failed" });
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: USER_A,
      agentId: null,
      runId: null,
    });
  });

  it("appends an assistant message with a task/created output ref when the confirmed tool succeeds", async () => {
    const db = makeDb();
    const app = makeApp(db);

    mockClaimForExecution.mockResolvedValue({
      id: CONFIRM_1,
      companyId: COMPANY_ID,
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      userId: USER_A,
      toolName: "create_task",
      params: { title: "Ship the thing" },
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_1, approved: true });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe("executed");

    // The refs must be persisted on the originating conversation so the UI's
    // existing OutputRefChips path renders a nav chip on the confirm refetch.
    expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    const [convId, message] = mockAppendMessage.mock.calls[0] as [string, Record<string, unknown>];
    expect(convId).toBe(CONVERSATION_ID);
    expect(message).toMatchObject({ role: "assistant" });
    expect(message.outputRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "task", action: "created", id: "task-123" }),
      ]),
    );
  });

  it("does NOT append a message (and does not throw) when the approval has no conversation", async () => {
    const db = makeDb();
    const app = makeApp(db);

    mockClaimForExecution.mockResolvedValue({
      id: CONFIRM_1,
      companyId: COMPANY_ID,
      conversationId: null,
      runId: null,
      userId: USER_A,
      toolName: "create_task",
      params: { title: "Ship the thing" },
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_1, approved: true });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe("executed");
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });
});
