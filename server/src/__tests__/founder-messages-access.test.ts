/**
 * Runtime HTTP tests verifying that founders can read message history for
 * conversations belonging to other users in the same company (P2 fix).
 *
 * The GET /conversations/:convId/messages route previously hardcoded
 * userId === actor.actorId with no founder bypass, while archive/pin/rename/
 * delete all allow founders to operate on any conversation. This test
 * verifies the corrected behaviour.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// ── DB table stubs ────────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => ({
  internalAgentConversations: makeTableProxy("internal_agent_conversations"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  internalAgentMessages: makeTableProxy("internal_agent_messages"),
  internalAgentRuns: makeTableProxy("internal_agent_runs"),
  internalAgentReminders: makeTableProxy("internal_agent_reminders"),
  userRoles: makeTableProxy("user_roles"),
}));

// ── Controllable permissionService mock ───────────────────────────────────────
const mockGetEffectiveRole = vi.hoisted(() => vi.fn().mockResolvedValue("team_member"));

vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: mockGetEffectiveRole,
    isFounder: vi.fn().mockResolvedValue(false),
    getUserRoles: vi.fn().mockResolvedValue([]),
  })),
}));

// ── Auth mocks ────────────────────────────────────────────────────────────────
// NOTE: Do NOT reference module-scope constants (USER_FOUNDER etc.) inside the
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

// ── Stub heavy transitive deps ────────────────────────────────────────────────
vi.mock("../services/internal-agent/agent-loop.js", () => ({
  agentLoopService: vi.fn(() => ({ chat: vi.fn() })),
}));
vi.mock("../services/internal-agent/tool-registry.js", () => ({
  createToolRegistry: vi.fn(() => []),
  executeTool: vi.fn(),
}));
vi.mock("../services/internal-agent/service-container.js", () => ({
  createServiceContainer: vi.fn(() => ({})),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: vi.fn(async () => "commander-agent-id"),
  COMMANDER_TOOL_ALLOWLIST: [],
}));
vi.mock("../services/company-skills.js", () => ({
  companySkillService: vi.fn(() => ({
    listSkillListItemsForAgent: vi.fn(async () => []),
    resolveSkillKeys: vi.fn(async () => []),
  })),
}));

// ── Constants ─────────────────────────────────────────────────────────────────
const COMPANY_ID  = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const USER_FOUNDER = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const USER_OTHER   = "bbbbbbbb-bbbb-4bbb-8bbb-000000000003";
const CONV_OTHER   = "cccccccc-cccc-4ccc-8ccc-000000000004";

// Conversation row owned by USER_OTHER
const OTHER_CONV_ROW = {
  id: CONV_OTHER,
  companyId: COMPANY_ID,
  userId: USER_OTHER,
  status: "active",
  archivedAt: null,
  title: null,
};

// Sample message row
const MSG_ROW = {
  id: "msg-1",
  conversationId: CONV_OTHER,
  role: "user",
  content: [{ type: "text", text: "hello" }],
  createdAt: new Date("2026-05-22T00:00:00Z"),
};

// ── Imports (after all vi.mock calls) ────────────────────────────────────────
import { internalAgentRoutes } from "../routes/internal-agent.js";
import { errorHandler } from "../middleware/index.js";

// ── DB factory ────────────────────────────────────────────────────────────────
/**
 * Two sequential selects happen in the fixed route:
 *   1. loadOwnedConversation → select from internalAgentConversations
 *   2. messages → select from internalAgentMessages (with .orderBy().limit().offset())
 *
 * When convExists is false, the first select returns [] → 404.
 */
function makeDb(convExists = true) {
  let selectCall = 0;
  return {
    select: vi.fn(() => {
      selectCall++;
      if (selectCall === 1) {
        // loadOwnedConversation ownership select
        return {
          from: vi.fn(() => ({
            where: vi.fn(() =>
              Promise.resolve(convExists ? [OTHER_CONV_ROW] : []),
            ),
          })),
        };
      }
      // messages select
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                offset: vi.fn(() => Promise.resolve([MSG_ROW])),
              })),
            })),
          })),
        })),
      };
    }),
    // Other methods are no-ops for these tests
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })) }),
    ),
  };
}

// ── App factory ───────────────────────────────────────────────────────────────
function makeApp(db: ReturnType<typeof makeDb>, actorIsInstanceAdmin = false) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      source: "session",
      userId: USER_FOUNDER,
      companyIds: [COMPANY_ID],
      isInstanceAdmin: actorIsInstanceAdmin,
    };
    next();
  });
  app.use("/api", internalAgentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /conversations/:convId/messages — founder bypass (P2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: USER_FOUNDER,
      agentId: null,
      runId: null,
    });
  });

  it("founder can read messages of a conversation owned by another user", async () => {
    // getEffectiveRole returns "founder" for USER_FOUNDER
    mockGetEffectiveRole.mockResolvedValue("founder");
    const db = makeDb(true);
    const app = makeApp(db);

    const res = await request(app).get(
      `/api/companies/${COMPANY_ID}/internal-agent/conversations/${CONV_OTHER}/messages`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      conversationId: CONV_OTHER,
      messages: expect.arrayContaining([
        expect.objectContaining({ id: "msg-1" }),
      ]),
    });
  });

  it("instance admin can read messages of a conversation owned by another user", async () => {
    // isInstanceAdmin actors bypass getEffectiveRole entirely — handled via req.actor flag
    mockGetEffectiveRole.mockResolvedValue("team_member"); // would deny if checked
    const db = makeDb(true);
    const app = makeApp(db, /* actorIsInstanceAdmin */ true);

    const res = await request(app).get(
      `/api/companies/${COMPANY_ID}/internal-agent/conversations/${CONV_OTHER}/messages`,
    );

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });

  it("non-founder gets 404 for another user's conversation messages", async () => {
    // team_member role → userId filter applied → conversation not found
    mockGetEffectiveRole.mockResolvedValue("team_member");
    // DB returns empty (conversation exists but userId doesn't match)
    const db = makeDb(false);
    const app = makeApp(db);

    const res = await request(app).get(
      `/api/companies/${COMPANY_ID}/internal-agent/conversations/${CONV_OTHER}/messages`,
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 for a conversation that does not exist in this company", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder");
    const db = makeDb(false); // empty result even for founder
    const app = makeApp(db);

    const res = await request(app).get(
      `/api/companies/${COMPANY_ID}/internal-agent/conversations/${CONV_OTHER}/messages`,
    );

    expect(res.status).toBe(404);
  });
});
