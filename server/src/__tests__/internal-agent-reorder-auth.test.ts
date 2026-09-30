/**
 * Runtime HTTP integration tests for reorder/reset owner-scoping (C12).
 *
 * These tests exercise the actual Express route handlers under real HTTP
 * requests (via supertest). They verify that:
 *   - PATCH .../conversations/reorder filters orderedIds to those owned by
 *     the actor, silently dropping foreign ids
 *   - PATCH .../conversations/reorder with empty orderedIds nulls out all
 *     owned conversations' sortOrder and returns 200
 *   - PATCH .../conversations/reorder with a missing/invalid body returns 400
 *   - DELETE .../conversations/order sets sortOrder: null scoped to the actor
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

// ── Stub route-level dependencies ────────────────────────────────────────────

// assertCompanyAccess and getActorInfo are used directly in the reorder/reset
// handlers. We stub them so tests can control the actor identity.
// Note: vi.hoisted runs before module-scope constants, so we inline the value.
const mockGetActorInfo = vi.hoisted(() =>
  vi.fn(() => ({
    actorType: "user" as const,
    actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", // USER_A
    agentId: null,
    runId: null,
  })),
);

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: mockGetActorInfo,
}));

// assertRole is referenced transitively by rbac middleware imports.
vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertDepartmentAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryApproval: vi.fn().mockResolvedValue(undefined),
  assertEntityAccess: vi.fn().mockResolvedValue(undefined),
}));

// permissionService is only used by routes that check founder status (list,
// archive, etc.) not by reorder/reset — but its module is imported at the top
// of internal-agent.ts so we need a stub.
vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: vi.fn().mockResolvedValue("team_member"),
    isFounder: vi.fn().mockResolvedValue(false),
    getUserRoles: vi.fn().mockResolvedValue([]),
  })),
}));

// Heavy transitive deps — stub them out to keep the test hermetic.
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
vi.mock("../middleware/rate-limit.js", () => ({
  internalAgentChatLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ── Constants (must be valid UUIDs — validated by Zod schema on orderedIds) ───
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const CONV_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONV_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

// ── Import route factory (after all vi.mock calls) ────────────────────────────
import { internalAgentRoutes } from "../routes/internal-agent.js";
import { errorHandler } from "../middleware/index.js";

// ── DB mock factory ───────────────────────────────────────────────────────────

/**
 * Build a mock DB whose select returns `selectRows` and whose transaction
 * proxies update calls through `txUpdate` (a spy). The reset endpoint uses
 * a top-level update (no transaction); `topUpdate` spies on that.
 */
function makeDb(options: {
  // Rows returned by the initial select (owned-conversations lookup)
  selectRows?: { id: string }[];
  // Capture what the transaction's update().set() is called with
  captureSet?: { values: unknown[] };
  // Capture args passed to select().from().where() (userId scope check)
  captureSelectWhere?: { args: unknown[] };
  // Capture args passed to top-level update().set().where() (reset scope check)
  captureResetWhere?: { args: unknown[] };
}) {
  const { selectRows = [], captureSet, captureSelectWhere, captureResetWhere } = options;

  const txUpdate = vi.fn(() => ({
    set: vi.fn((setVal: unknown) => {
      if (captureSet) captureSet.values.push(setVal);
      return {
        where: vi.fn(() => Promise.resolve()),
      };
    }),
  }));

  const topUpdate = vi.fn(() => ({
    set: vi.fn((setVal: unknown) => {
      if (captureSet) captureSet.values.push(setVal);
      return {
        where: vi.fn((...args: unknown[]) => {
          if (captureResetWhere) captureResetWhere.args.push(...args);
          return Promise.resolve([]);
        }),
      };
    }),
  }));

  return {
    // The reorder route uses db.select().from().where() to fetch owned convs
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((...args: unknown[]) => {
          if (captureSelectWhere) captureSelectWhere.args.push(...args);
          return Promise.resolve(selectRows);
        }),
      })),
    })),
    // Top-level update used by the reset route
    update: topUpdate,
    // transaction used by the reorder route
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = { update: txUpdate };
      return fn(tx);
    }),
    // Expose spies for assertions
    __txUpdate: txUpdate,
    __topUpdate: topUpdate,
  };
}

// ── App factory ───────────────────────────────────────────────────────────────

const boardActor = {
  type: "board" as const,
  source: "session" as const,
  userId: USER_A,
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

function makeApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = boardActor;
    next();
  });
  app.use("/api", internalAgentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("C12 — reorder/reset owner-scoping (runtime HTTP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset getActorInfo to default USER_A identity before each test
    mockGetActorInfo.mockReturnValue({
      actorType: "user" as const,
      actorId: USER_A,
      agentId: null,
      runId: null,
    });
  });

  // ── PATCH .../conversations/reorder ──────────────────────────────────────

  describe("PATCH /api/companies/:companyId/internal-agent/conversations/reorder", () => {
    it("drops ids the actor does not own — update called once (only for CONV_A)", async () => {
      // Actor owns only CONV_A; CONV_B belongs to someone else.
      const capturedSets: unknown[] = [];
      const selectWhereArgs: unknown[] = [];

      const dbWithCapture = makeDb({
        selectRows: [{ id: CONV_A }],
        captureSet: { values: capturedSets },
        captureSelectWhere: { args: selectWhereArgs },
      });

      const res = await request(makeApp(dbWithCapture))
        .patch(`/api/companies/${COMPANY_ID}/internal-agent/conversations/reorder`)
        .send({ orderedIds: [CONV_A, CONV_B] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // transaction() was called
      expect(dbWithCapture.transaction).toHaveBeenCalledTimes(1);

      // The tx.update inside transaction was called exactly once (CONV_B dropped)
      expect(dbWithCapture.__txUpdate).toHaveBeenCalledTimes(1);

      // The set was called with sortOrder: 0 (position of CONV_A)
      expect(capturedSets).toHaveLength(1);
      expect(capturedSets[0]).toMatchObject({ sortOrder: 0 });

      // The owned-set SELECT must pass a WHERE clause (userId scope not removed)
      expect(selectWhereArgs.length).toBeGreaterThan(0); // userId scope was passed to WHERE
    });

    it("empty orderedIds — nulls out all owned conversations, returns 200", async () => {
      // Even if the actor owns conversations, requesting [] means nothing to reorder.
      // The null-out pass should set sortOrder=null for all owned conversations,
      // making this equivalent to a full reset within a transaction.
      const capturedSets: unknown[] = [];
      const db = makeDb({ selectRows: [{ id: CONV_A }], captureSet: { values: capturedSets } });

      const res = await request(makeApp(db))
        .patch(`/api/companies/${COMPANY_ID}/internal-agent/conversations/reorder`)
        .send({ orderedIds: [] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // transaction is still called and the null-out pass fires once (for CONV_A).
      expect(db.__txUpdate).toHaveBeenCalledTimes(1);
      expect(capturedSets).toHaveLength(1);
      expect(capturedSets[0]).toMatchObject({ sortOrder: null });
    });

    it("missing body / invalid schema → 400", async () => {
      const db = makeDb({});

      // Omit orderedIds entirely (schema requires it)
      const res = await request(makeApp(db))
        .patch(`/api/companies/${COMPANY_ID}/internal-agent/conversations/reorder`)
        .send({});

      expect(res.status).toBe(400);
      // No DB interaction expected
      expect(db.transaction).not.toHaveBeenCalled();
    });
  });

  // ── DELETE .../conversations/order ───────────────────────────────────────

  describe("DELETE /api/companies/:companyId/internal-agent/conversations/order", () => {
    it("calls update with sortOrder:null scoped to the actor's userId → 200", async () => {
      const capturedSets: unknown[] = [];
      const resetWhereArgs: unknown[] = [];
      const db = makeDb({
        captureSet: { values: capturedSets },
        captureResetWhere: { args: resetWhereArgs },
      });

      const res = await request(makeApp(db))
        .delete(`/api/companies/${COMPANY_ID}/internal-agent/conversations/order`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // update() was called on the top-level db (no transaction for reset)
      expect(db.__topUpdate).toHaveBeenCalledTimes(1);

      // The set payload must include sortOrder: null
      expect(capturedSets).toHaveLength(1);
      expect(capturedSets[0]).toMatchObject({ sortOrder: null });

      // The WHERE clause must be non-empty (userId scope applied to reset)
      expect(resetWhereArgs.length).toBeGreaterThan(0); // userId scope applied to reset
    });
  });
});

// ── Codex #2: 404 behavior-lock — existence-leak-safe property ───────────────
// An existing conversation owned by a DIFFERENT non-founder user must return 404
// (not 403, not rows) through the shared loadOwnedConversation helper. This locks
// the existence-leak-safe property post-extraction so a future regression (e.g.
// accidentally returning 403) is caught immediately.
describe("loadOwnedConversation — 404 behavior-lock (Codex #2)", () => {
  // Use the messages route as the real call site: GET .../conversations/:convId/messages
  // The DB will return [] for the conversation select (simulating owner mismatch for
  // a non-founder actor), which must yield 404 (not 403, not a successful response).

  const NON_OWNER_CONV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

  // DB that returns no rows for the conversation select (ownership mismatch)
  function makeNoConvDb() {
    return {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([])), // no rows → 404
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
      })),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })) }),
      ),
    };
  }

  // permissionService is already mocked at module level to return "team_member"
  // (non-founder), so the userId scope condition fires. The DB returns no rows →
  // loadOwnedConversation throws 404.

  it("GET messages for a conversation not owned by the actor → 404 (not 403, not rows)", async () => {
    const db = makeNoConvDb();
    // boardActor is already set as non-founder (team_member via permissionService mock)
    const app = (() => {
      const a = express();
      a.use(express.json());
      a.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = boardActor;
        next();
      });
      a.use("/api", internalAgentRoutes(db as never));
      a.use(errorHandler);
      return a;
    })();

    const res = await request(app)
      .get(`/api/companies/${COMPANY_ID}/internal-agent/conversations/${NON_OWNER_CONV}/messages`);

    // Must be 404 — not 403 (existence leak) and not 200 (unauthorized access)
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });
});
