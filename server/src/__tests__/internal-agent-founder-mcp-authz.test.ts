/**
 * Behavioral authz contract tests for the THREE founder-MCP-token bypass spots
 * in internal-agent.ts:
 *
 *   1. POST /internal-agent/chat (:166-186) — userRole passed to agentLoopService.chat
 *   2. POST /internal-agent/confirm (:402-416) — currentUserRole passed to executeTool
 *   3. GET  /internal-agent/conversations (:1005-1028) — isFounder controls userId WHERE
 *
 * TDD: written BEFORE the fix. Pre-fix, a founder-MCP token resolves to "founder" at all
 * 3 spots because getEffectiveRole is called and returns "founder" for the replayed userId.
 * Post-fix, all 3 spots use resolveActorRole, which gates founder-equivalence on type:"board",
 * demoting the MCP token to "team_member" without calling getEffectiveRole.
 *
 * Harness mirrors:
 *   - confirm-stale-permissions.test.ts (chat + confirm routes, mocked agentLoopService/
 *     executeTool/runtimeApprovalService/getActorInfo, supertest-driven)
 *   - memory-retrievals-authz.test.ts (eqSpy technique for the LIST own-scope assertion)
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy } from "./helpers/drizzle-mock.js";

// ── drizzle-orm mock — eq is a vi.fn() so we can spy on its call args (LIST test) ─
const { eqSpy } = vi.hoisted(() => ({
  eqSpy: vi.fn((..._args: unknown[]) => "eq"),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  or: () => "or",
  eq: eqSpy,
  ne: () => "ne",
  isNull: () => "isNull",
  isNotNull: () => "isNotNull",
  inArray: () => "inArray",
  notInArray: () => "notInArray",
  gt: () => "gt",
  gte: () => "gte",
  lt: () => "lt",
  lte: () => "lte",
  like: () => "like",
  ilike: () => "ilike",
  desc: () => "desc",
  asc: () => "asc",
  count: () => "count",
  sql: new Proxy(
    Object.assign(function () { return "sql"; }, { join: () => "sql", raw: () => "sql" }),
    { get: (t: Record<string | symbol, unknown>, p: string | symbol) => (p in t ? t[p] : () => "sql") },
  ),
}));

// ── DB table stubs ───────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => ({
  internalAgentConversations: makeTableProxy("internal_agent_conversations"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  internalAgentMessages: makeTableProxy("internal_agent_messages"),
  internalAgentRuns: makeTableProxy("internal_agent_runs"),
  internalAgentReminders: makeTableProxy("internal_agent_reminders"),
  userRoles: makeTableProxy("user_roles"),
}));

// ── permissionService mock — controllable per test ────────────────────────────
const mockGetEffectiveRole = vi.hoisted(() => vi.fn().mockResolvedValue("team_member"));

vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: mockGetEffectiveRole,
    isFounder: vi.fn().mockResolvedValue(false),
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

// ── Agent loop mock ───────────────────────────────────────────────────────────
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
const FOUNDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const CONFIRM_1  = "11111111-1111-4111-8111-000000000001";

// ── Imports (after all vi.mock calls) ────────────────────────────────────────
import { internalAgentRoutes } from "../routes/internal-agent.js";
import { internalAgentConversations } from "@armyofagents/db";
import { errorHandler } from "../middleware/index.js";

// ── DB factory ────────────────────────────────────────────────────────────────
// Flexible enough to handle:
//   - insert (run create): insert().values().returning()
//   - select for config (chat): select().from().where() → [{ enabledCapabilities: [] }]
//   - select for conversations (list): select().from().where().orderBy() → convRows
//   - update (run status): update().set().where()
function makeDb(convRows: unknown[] = []) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: "run-id" }])),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          // For the conversations list: .where().orderBy()
          orderBy: vi.fn(() => Promise.resolve(convRows)),
          // For config selects that don't chain orderBy: await .where() directly
          then: (resolve: (val: unknown) => void) =>
            resolve([{ enabledCapabilities: [], cliTool: null, model: null }]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };
}

// ── App factory — injects actor shape into req ────────────────────────────────
type ActorShape =
  | { type: "board"; source: "session" | "local_implicit"; userId: string; companyIds: string[]; isInstanceAdmin: boolean }
  | { type: "mcp"; companyId: string; userId: string; runId: null };

function makeApp(db: ReturnType<typeof makeDb>, actor: ActorShape) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", internalAgentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

// ── Actor helpers ─────────────────────────────────────────────────────────────
const boardFounderActor = (): ActorShape => ({
  type: "board",
  source: "session",
  userId: FOUNDER_ID,
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
});

const founderMcpActor = (): ActorShape => ({
  type: "mcp",
  companyId: COMPANY_ID,
  userId: FOUNDER_ID,
  runId: null,
});

// ── eq-spy helper: did the WHERE include userId column? ───────────────────────
function eqCalledWithUserIdColumn(): boolean {
  const userIdCol = internalAgentConversations.userId;
  return eqSpy.mock.calls.some((args: unknown[]) => args[0] === userIdCol);
}

function eqCalledWithUserIdValue(userId: string): boolean {
  const userIdCol = internalAgentConversations.userId;
  return eqSpy.mock.calls.some(
    (args: unknown[]) => args[0] === userIdCol && args[1] === userId,
  );
}

// ── Helper: drive the chat endpoint to emit action_confirmation ───────────────
async function seedPending(app: ReturnType<typeof makeApp>, confirmId: string) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Spot 1: chat /send — userRole reaches agentLoopService.chat
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /chat — founder-MCP token userRole (Spot 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: FOUNDER_ID,
      agentId: null,
      runId: null,
    });
    // getEffectiveRole would return "founder" for the replayed userId.
    // Pre-fix: this causes userRole:"founder" to reach agentLoopService.chat.
    // Post-fix: resolveActorRole ignores this and returns "team_member" for type:"mcp".
    mockGetEffectiveRole.mockResolvedValue("founder");
    // chat stub: emit a simple done to avoid timeout
    mockChat.mockImplementation(async function* () {
      yield { type: "done", runId: "run-id", durationMs: 0, costCents: 0, toolsCalled: [], tokenUsage: { inputTokens: 0, outputTokens: 0 } };
    });
  });

  it("founder-MCP token → userRole:'team_member' reaches agentLoopService.chat AND getEffectiveRole NOT called", async () => {
    const db = makeDb();
    const app = makeApp(db, founderMcpActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/chat`)
      .send({ message: "hello" });

    // Route succeeds (SSE stream completes)
    expect(res.status).toBe(200);

    // CORE ASSERTION: userRole passed to svc.chat must be "team_member" (demoted),
    // not "founder" (what getEffectiveRole would return pre-fix).
    expect(mockChat).toHaveBeenCalledTimes(1);
    const chatFirstArg = mockChat.mock.calls[0][0] as Record<string, unknown>;
    expect(chatFirstArg.userRole).toBe("team_member");

    // getEffectiveRole must NOT have been called (board-gate short-circuits for non-board actors).
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
  });

  it("board founder → userRole:'founder' still reaches agentLoopService.chat (board control)", async () => {
    const db = makeDb();
    const app = makeApp(db, boardFounderActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/chat`)
      .send({ message: "hello" });

    expect(res.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(1);
    const chatFirstArg = mockChat.mock.calls[0][0] as Record<string, unknown>;
    expect(chatFirstArg.userRole).toBe("founder");
    // Board session DOES call getEffectiveRole (it's not local_implicit/instanceAdmin)
    expect(mockGetEffectiveRole).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spot 2: /confirm — currentUserRole reaches executeTool
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /confirm — founder-MCP token currentUserRole (Spot 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: FOUNDER_ID,
      agentId: null,
      runId: null,
    });
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockClaimForExecution.mockResolvedValue({
      id: CONFIRM_1,
      companyId: COMPANY_ID,
      userId: FOUNDER_ID,
      toolName: "change_goal_status",
      params: { goalId: "goal-1", status: "achieved" },
    });
    mockMarkExecuted.mockResolvedValue({ id: CONFIRM_1, status: "approved" });
    mockMarkFailed.mockResolvedValue({ id: CONFIRM_1, status: "failed" });
    mockChat.mockImplementation(async function* () {
      yield {
        type: "action_confirmation",
        runId: CONFIRM_1,
        toolName: "change_goal_status",
        params: { goalId: "goal-1", status: "achieved" },
      };
    });
  });

  it("founder-MCP token → executeTool receives userRole:'team_member' AND getEffectiveRole NOT called", async () => {
    const db = makeDb();

    // Seed via chat with a BOARD founder (so chat itself works fine),
    // then call confirm with the MCP token. This mirrors the cross-actor confirm
    // scenario — the confirm endpoint's OWN role resolution is what we're testing.
    const chatApp = makeApp(db, boardFounderActor());
    await seedPending(chatApp, CONFIRM_1);

    // Now confirm with the MCP actor — resolveActorRole in confirm should demote.
    const confirmApp = makeApp(db, founderMcpActor());
    vi.clearAllMocks(); // Reset getEffectiveRole call count after seedPending
    mockGetEffectiveRole.mockResolvedValue("founder"); // would grant founder IF called
    mockClaimForExecution.mockResolvedValue({
      id: CONFIRM_1,
      companyId: COMPANY_ID,
      userId: FOUNDER_ID,
      toolName: "change_goal_status",
      params: { goalId: "goal-1", status: "achieved" },
    });
    mockMarkExecuted.mockResolvedValue({ id: CONFIRM_1, status: "approved" });
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: FOUNDER_ID,
      agentId: null,
      runId: null,
    });

    const res = await request(confirmApp)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_1, approved: true });

    expect(res.status).toBe(200);

    const { executeTool } = await import("../services/internal-agent/tool-registry.js");
    expect(vi.mocked(executeTool)).toHaveBeenCalledWith(
      expect.objectContaining({ name: "change_goal_status" }),
      expect.objectContaining({ goalId: "goal-1" }),
      expect.objectContaining({ userRole: "team_member" }),
    );

    // getEffectiveRole NOT called in the confirm handler for non-board actors.
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
  });

  it("board founder → executeTool receives userRole:'founder' (confirm board control)", async () => {
    const db = makeDb();
    const app = makeApp(db, boardFounderActor());
    await seedPending(app, CONFIRM_1);
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockClaimForExecution.mockResolvedValue({
      id: CONFIRM_1,
      companyId: COMPANY_ID,
      userId: FOUNDER_ID,
      toolName: "change_goal_status",
      params: { goalId: "goal-1", status: "achieved" },
    });
    mockMarkExecuted.mockResolvedValue({ id: CONFIRM_1, status: "approved" });
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: FOUNDER_ID,
      agentId: null,
      runId: null,
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/internal-agent/confirm`)
      .send({ confirmId: CONFIRM_1, approved: true });

    expect(res.status).toBe(200);

    const { executeTool } = await import("../services/internal-agent/tool-registry.js");
    expect(vi.mocked(executeTool)).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ userRole: "founder" }),
    );
    // Board session DOES call getEffectiveRole (not local_implicit/instanceAdmin)
    expect(mockGetEffectiveRole).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spot 3: GET /conversations — isFounder controls userId WHERE-condition (HIGH)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /conversations — founder-MCP token cross-user list leak (Spot 3, HIGH)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: FOUNDER_ID,
      agentId: null,
      runId: null,
    });
    // getEffectiveRole would return "founder" for the replayed userId.
    // Pre-fix: isFounder=true → userId WHERE dropped → every user's conversations listed.
    // Post-fix: resolveActorRole returns "team_member" for type:"mcp" → userId IS applied.
    mockGetEffectiveRole.mockResolvedValue("founder");
  });

  it("founder-MCP token → eq(userId, FOUNDER_ID) IS applied AND getEffectiveRole NOT called", async () => {
    const db = makeDb([]);
    const app = makeApp(db, founderMcpActor());

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/internal-agent/conversations`);

    expect(res.status).toBe(200);

    // CORE ASSERTION (HIGH): the userId WHERE condition must be present for the
    // MCP token — pre-fix it's dropped (isFounder=true), allowing cross-user listing.
    // Post-fix: resolveActorRole demotes to "team_member" → eq(userId, FOUNDER_ID) applied.
    expect(eqCalledWithUserIdColumn()).toBe(true);
    expect(eqCalledWithUserIdValue(FOUNDER_ID)).toBe(true);

    // The role lookup must NOT be reached for non-board actors.
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
  });

  it("board founder → userId condition NOT applied AND getEffectiveRole IS called (board control)", async () => {
    const db = makeDb([]);
    const app = makeApp(db, boardFounderActor());

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/internal-agent/conversations`);

    expect(res.status).toBe(200);

    // Board founder: isFounder=true → userId WHERE is NOT applied (can list all).
    expect(eqCalledWithUserIdColumn()).toBe(false);

    // Board session DOES call getEffectiveRole (not local_implicit/instanceAdmin).
    expect(mockGetEffectiveRole).toHaveBeenCalled();
  });
});
