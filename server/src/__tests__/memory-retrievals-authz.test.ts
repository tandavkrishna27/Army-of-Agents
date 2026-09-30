/**
 * Owner-authz contract tests for the conversation memory-retrievals endpoint.
 *
 * Codex P2 finding #1: GET /companies/:cid/conversations/:convId/memory-retrievals
 * previously lacked an owner/founder guard (only assertCompanyAccess). This test
 * suite locks the guard introduced in Task 2 of the authz plan.
 *
 * Strategy (Codex #6 — no tautology): loadOwnedConversation is NOT mocked.
 * We drive the route against realistic mocked DB rows (a conversation row with a
 * known userId) and observe the HTTP status/body outcome. permissionService is
 * mocked at module level so we can control the effective role per actor class.
 *
 * Actor class matrix (Codex #1):
 *   - founder role                               → 200 rows
 *   - local_implicit board (loopback)            → 200 rows (founder-equivalent bypass)
 *   - instance-admin board                       → 200 rows (founder-equivalent bypass)
 *   - non-founder board user, userId === owner   → 200 rows
 *   - non-founder board user, userId ≠ owner     → 404 (existence-leak-safe)
 *   - agent token (non-founder)                  → 404 (actorId ≠ conversation.userId)
 *   - mcp token (no matching userId)             → 404 (actorId ≠ conversation.userId)
 *   - founder-role mcp token, NOT owner          → 404 (Codex re-review P2: founder
 *       bypass is board-only; a founder-created token is owner-scoped, no role lookup)
 *   - founder-role mcp token, owns the conv      → 200 (self-management still works)
 *
 * Issue endpoint distinction (Codex #3): the issue endpoint is intentionally NOT
 * owner-guarded (tasks are company resources). An explicit test locks this.
 *
 * Quality strengthening (post-review):
 *   FIX #1: eq spy — asserts the guard's userId WHERE-condition is present for
 *     non-founders and absent for founder-equivalents, catching silent regressions
 *     that delete the userId scope without breaking outcome-only tests.
 *   FIX #2: distinct mcp actor type (type:"mcp", no userId match) → 404.
 *   FIX #3: assert listRetrievalsForConversation called with (companyId, conversationId)
 *     in every 200 case, so a future refactor can't silently pass the wrong args.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy } from "./helpers/drizzle-mock.js";

// ── drizzle-orm mock — eq is a vi.fn() so we can spy on its call args ────────
//
// FIX #1: Instead of drizzleOperatorStubs() (which returns `eq: () => "eq"`),
// we declare eq as vi.fn() via vi.hoisted() so it is available when the
// vi.mock() factory is hoisted to the top of the compiled output. All other
// operators are plain stubs because we only need to inspect eq calls.
//
// conversation-authz.ts imports { eq, and } from "drizzle-orm" — the mocked
// module's eq function IS the vi.fn() below, so every eq(...) call in the guard
// is recorded in eqSpy.mock.calls.
const { eqSpy } = vi.hoisted(() => ({
  eqSpy: vi.fn((..._args: unknown[]) => "eq"),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args, // collect conditions as an array for introspection
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
    { get: (t, p) => (p in t ? (t as Record<string | symbol, unknown>)[p] : () => "sql") },
  ),
}));

// ── DB table stubs ───────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => ({
  internalAgentConversations: makeTableProxy("internal_agent_conversations"),
  memoryRetrievals: makeTableProxy("memory_retrievals"),
}));

// ── memoryService mock ───────────────────────────────────────────────────────
// We mock the service so the test doesn't need a real DB for retrievals.
// The guard (loadOwnedConversation) runs before this call — if it throws 404 the
// service is never reached.
const mockListRetrievalsForConversation = vi.fn(async () => [{ id: "ret-1" }]);
const mockListRetrievalsForIssue = vi.fn(async () => [{ id: "ret-issue-1" }]);

vi.mock("../services/index.js", () => ({
  memoryService: vi.fn(() => ({
    listRetrievalsForConversation: mockListRetrievalsForConversation,
    listRetrievalsForIssue: mockListRetrievalsForIssue,
  })),
}));

// ── permissionService mock ───────────────────────────────────────────────────
// Controlled per test via mockGetEffectiveRole.mockResolvedValue(...)
const mockGetEffectiveRole = vi.fn().mockResolvedValue("team_member");

vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: mockGetEffectiveRole,
  })),
}));

// ── assertCompanyAccess mock — always passes ─────────────────────────────────
vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn((req: { actor: { type: string; agentId?: string; userId?: string } }) => {
    if (req.actor.type === "agent") {
      return { actorType: "agent" as const, actorId: req.actor.agentId ?? "agent-id", agentId: req.actor.agentId ?? null, runId: null };
    }
    // mcp actors: actorId is req.actor.userId ?? "mcp-user" (mirrors real getActorInfo)
    if (req.actor.type === "mcp") {
      return { actorType: "user" as const, actorId: (req.actor as { userId?: string }).userId ?? "mcp-user", agentId: null, runId: null };
    }
    return { actorType: "user" as const, actorId: (req.actor as { userId?: string }).userId ?? "unknown", agentId: null, runId: null };
  }),
}));

import { internalAgentConversations } from "@armyofagents/db";
import { memoryRetrievalsRoutes } from "../routes/memory-retrievals.js";
import { errorHandler } from "../middleware/index.js";

// ── Constants ────────────────────────────────────────────────────────────────
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV_ID    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ISSUE_ID   = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_ID   = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // conversation.userId
const OTHER_ID   = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // different user
const MCP_ANON_ID = "mcp-anon-ffffffff-ffff-4fff-8fff-ffffffffffff"; // MCP key with no matching userId

// Fake conversation row owned by OWNER_ID
const CONV_ROW = { id: CONV_ID, companyId: COMPANY_ID, userId: OWNER_ID };

// ── DB factory ────────────────────────────────────────────────────────────────
// Returns convRows for the conversation select; permissionService is mocked above.
function makeDb(convRows: unknown[] = [CONV_ROW]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(convRows)),
      })),
    })),
  };
}

// ── App factory ───────────────────────────────────────────────────────────────
type ActorShape =
  | { type: "board"; source: "session" | "local_implicit"; userId: string; companyIds: string[]; isInstanceAdmin: boolean }
  | { type: "agent"; companyId: string; agentId: string; runId: null }
  | { type: "mcp"; companyId: string; userId: string; runId: null };

function makeApp(db: ReturnType<typeof makeDb>, actor: ActorShape) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", memoryRetrievalsRoutes(db as never));
  app.use(errorHandler);
  return app;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const sessionActor = (userId: string): ActorShape => ({
  type: "board",
  source: "session",
  userId,
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
});

const localImplicitActor = (userId: string): ActorShape => ({
  type: "board",
  source: "local_implicit",
  userId,
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
});

const instanceAdminActor = (userId: string): ActorShape => ({
  type: "board",
  source: "session",
  userId,
  companyIds: [COMPANY_ID],
  isInstanceAdmin: true,
});

const agentActor = (): ActorShape => ({
  type: "agent",
  companyId: COMPANY_ID,
  agentId: "agent-00000000-0000-4000-8000-000000000001",
  runId: null,
});

/**
 * FIX #2: MCP actor with type:"mcp". The mocked getActorInfo returns
 * actorId = actor.userId (mirroring real getActorInfo for mcp type).
 * MCP_ANON_ID is a string that never matches OWNER_ID → 404.
 */
const mcpActor = (): ActorShape => ({
  type: "mcp",
  companyId: COMPANY_ID,
  userId: MCP_ANON_ID,
  runId: null,
});

/**
 * Codex re-review P2: an MCP key created by a FOUNDER replays the founder's
 * userId, which would resolve to "founder" via getEffectiveRole and grant the
 * read-anyone bypass. The fix gates the founder bypass on type:"board", so a
 * founder-backed mcp token is owner-scoped. `userId` here is a real (founder)
 * user id; the role lookup must NOT be reached for it after the fix.
 */
const founderMcpActor = (userId: string): ActorShape => ({
  type: "mcp",
  companyId: COMPANY_ID,
  userId,
  runId: null,
});

const convUrl = `/api/companies/${COMPANY_ID}/conversations/${CONV_ID}/memory-retrievals`;
const issueUrl = `/api/companies/${COMPANY_ID}/issues/${ISSUE_ID}/memory-retrievals`;

// ── FIX #1 helper: inspect eq spy calls ──────────────────────────────────────
//
// conversation-authz.ts calls eq(internalAgentConversations.userId, actorId)
// for non-founders. The column symbol is the Proxy symbol for "userId" on the
// internalAgentConversations table proxy.
//
// Returns true if any eq call used the userId column as its first argument.
function eqCalledWithUserIdColumn(): boolean {
  const userIdCol = internalAgentConversations.userId;
  return eqSpy.mock.calls.some(
    (args: unknown[]) => args[0] === userIdCol
  );
}

// ── Tests: conversation endpoint (owner-guarded) ──────────────────────────────

describe("GET /companies/:cid/conversations/:convId/memory-retrievals — owner guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("team_member");
    mockListRetrievalsForConversation.mockResolvedValue([{ id: "ret-1" }]);
  });

  it("founder role → 200 rows (owner bypass)", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder");
    // Founder: DB can return any conversation in the company (no userId filter)
    // We still return CONV_ROW since no userId condition is added for founder.
    const res = await request(makeApp(makeDb([CONV_ROW]), sessionActor(OTHER_ID)))
      .get(convUrl);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // FIX #1: Founders bypass userId scoping — eq must NOT have been called with
    // the userId column. If a regression re-adds userId scoping for founders, this fails.
    expect(eqCalledWithUserIdColumn()).toBe(false);

    // Codex re-review P2: a BOARD founder DOES go through the role lookup
    // (this is the only path that may founder-bypass via getEffectiveRole).
    expect(mockGetEffectiveRole).toHaveBeenCalled();

    // FIX #3: Service receives the correct (companyId, conversationId) args.
    expect(mockListRetrievalsForConversation).toHaveBeenCalledWith(
      COMPANY_ID,
      CONV_ID,
      expect.anything(),
    );
  });

  it("local_implicit board actor → 200 rows (founder-equivalent, no DB role check)", async () => {
    // local_implicit bypasses permissionService entirely — no getEffectiveRole call
    const res = await request(makeApp(makeDb([CONV_ROW]), localImplicitActor(OTHER_ID)))
      .get(convUrl);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // getEffectiveRole should NOT be called for local_implicit (it's a founder bypass)
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();

    // FIX #1: local_implicit is founder-equivalent — no userId scope on eq.
    expect(eqCalledWithUserIdColumn()).toBe(false);

    // FIX #3: Service receives the correct args.
    expect(mockListRetrievalsForConversation).toHaveBeenCalledWith(
      COMPANY_ID,
      CONV_ID,
      expect.anything(),
    );
  });

  it("instance-admin board actor → 200 rows (founder-equivalent, no DB role check)", async () => {
    const res = await request(makeApp(makeDb([CONV_ROW]), instanceAdminActor(OTHER_ID)))
      .get(convUrl);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();

    // FIX #1: instance admin is founder-equivalent — no userId scope on eq.
    expect(eqCalledWithUserIdColumn()).toBe(false);

    // FIX #3: Service receives the correct args.
    expect(mockListRetrievalsForConversation).toHaveBeenCalledWith(
      COMPANY_ID,
      CONV_ID,
      expect.anything(),
    );
  });

  it("non-founder board user whose userId === conversation.userId → 200 rows", async () => {
    // team_member but owns the conversation — WHERE includes userId filter,
    // and the DB returns the row (userId matches).
    mockGetEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp(makeDb([CONV_ROW]), sessionActor(OWNER_ID)))
      .get(convUrl);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // FIX #1: Non-founder — eq MUST have been called with userId column and OWNER_ID.
    // This is the key regression guard: if the userId condition is ever removed from
    // conversation-authz.ts for non-founders, this assertion fails.
    expect(eqCalledWithUserIdColumn()).toBe(true);
    const userIdCol = internalAgentConversations.userId;
    expect(eqSpy.mock.calls.some(
      (args: unknown[]) => args[0] === userIdCol && args[1] === OWNER_ID
    )).toBe(true);

    // FIX #3: Service receives the correct args.
    expect(mockListRetrievalsForConversation).toHaveBeenCalledWith(
      COMPANY_ID,
      CONV_ID,
      expect.anything(),
    );
  });

  it("non-founder board user whose userId ≠ conversation owner → 404 (existence-leak-safe, not 403)", async () => {
    // team_member, different user → WHERE adds userId constraint → DB returns [] → 404
    mockGetEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp(makeDb([]), sessionActor(OTHER_ID)))
      .get(convUrl);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);

    // FIX #1: Regression guard — eq MUST have been called with userId column and OTHER_ID.
    // An empty DB alone causes 404, but this ensures the WHERE clause actually carried
    // the userId condition (a guard that dropped the condition would still 404 on empty DB,
    // but would expose other users' conversations when the DB has rows).
    expect(eqCalledWithUserIdColumn()).toBe(true);
    const userIdCol = internalAgentConversations.userId;
    expect(eqSpy.mock.calls.some(
      (args: unknown[]) => args[0] === userIdCol && args[1] === OTHER_ID
    )).toBe(true);
  });

  it("agent token actor (non-founder) → 404 (actorId is not a userId, no ownership match)", async () => {
    // Agent actor: actorId = agentId string, never matches conversation.userId.
    // DB returns [] (no userId match) → 404.
    mockGetEffectiveRole.mockResolvedValue("team_member");
    const AGENT_ID = "agent-00000000-0000-4000-8000-000000000001";
    const res = await request(makeApp(makeDb([]), agentActor()))
      .get(convUrl);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);

    // FIX #1: eq MUST have been called with userId column and the agent's actorId.
    expect(eqCalledWithUserIdColumn()).toBe(true);
    const userIdCol = internalAgentConversations.userId;
    expect(eqSpy.mock.calls.some(
      (args: unknown[]) => args[0] === userIdCol && args[1] === AGENT_ID
    )).toBe(true);
  });

  /**
   * FIX #2: Distinct mcp actor (type:"mcp", anonymous key, no userId match).
   *
   * The real getActorInfo uses actor.userId ?? "mcp-user" for mcp type actors.
   * Our mocked getActorInfo mirrors this (see mock above). MCP_ANON_ID does not
   * match OWNER_ID, so the guard's WHERE adds userId = MCP_ANON_ID → DB returns
   * [] → 404. This locks the code path for mcp actor type separately from agent.
   */
  it("mcp actor (type:\"mcp\", no userId match) → 404 (not an owner, not a founder)", async () => {
    mockGetEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp(makeDb([]), mcpActor()))
      .get(convUrl);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);

    // FIX #1+2: eq was called with userId column and the mcp actor's userId.
    expect(eqCalledWithUserIdColumn()).toBe(true);
    const userIdCol = internalAgentConversations.userId;
    expect(eqSpy.mock.calls.some(
      (args: unknown[]) => args[0] === userIdCol && args[1] === MCP_ANON_ID
    )).toBe(true);
  });

  /**
   * Codex re-review P2 — the core case. A founder-CREATED MCP token replays the
   * founder's userId, which getEffectiveRole would resolve to "founder" and
   * (pre-fix) grant read-anyone. The fix gates the founder bypass on
   * type:"board", so this token is owner-scoped: the conversation is owned by
   * OWNER_ID, the token's userId is OTHER_ID → 404. The role lookup is NOT
   * reached for the non-board actor.
   */
  it("founder-role mcp token, NOT the owner → 404 (founder bypass is board-only)", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder"); // would bypass IF the role lookup ran
    const res = await request(makeApp(makeDb([]), founderMcpActor(OTHER_ID)))
      .get(convUrl);
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);

    // P2: role lookup is skipped entirely for non-board actors (board-gated).
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();

    // The userId predicate IS applied (owner-scoped), with the token's own userId.
    expect(eqCalledWithUserIdColumn()).toBe(true);
    const userIdCol = internalAgentConversations.userId;
    expect(eqSpy.mock.calls.some(
      (args: unknown[]) => args[0] === userIdCol && args[1] === OTHER_ID
    )).toBe(true);
  });

  it("founder-role mcp token, owns the conversation → 200 (self-management still works)", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder");
    const res = await request(makeApp(makeDb([CONV_ROW]), founderMcpActor(OWNER_ID)))
      .get(convUrl);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // Still board-gated (no role lookup); owner-scoped predicate matched OWNER_ID.
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
    expect(eqCalledWithUserIdColumn()).toBe(true);
    const userIdCol = internalAgentConversations.userId;
    expect(eqSpy.mock.calls.some(
      (args: unknown[]) => args[0] === userIdCol && args[1] === OWNER_ID
    )).toBe(true);
  });
});

// ── Tests: issue endpoint (company-scoped, intentionally NOT owner-guarded) ───

describe("GET /companies/:cid/issues/:issueId/memory-retrievals — NOT owner-guarded (Codex #3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListRetrievalsForIssue.mockResolvedValue([{ id: "ret-issue-1" }]);
  });

  it("non-founder non-owner actor → 200 rows (tasks are company resources, no owner check)", async () => {
    // This test documents that the issue endpoint is intentionally company-scoped
    // only (assertCompanyAccess). A future reviewer must NOT add an owner guard here.
    mockGetEffectiveRole.mockResolvedValue("team_member");
    const res = await request(makeApp(makeDb([]), sessionActor(OTHER_ID)))
      .get(issueUrl);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // loadOwnedConversation must NOT have been called for the issue route
    // (the DB mock's select is only wired for conversation lookup; if it were
    // called here it would return [] and potentially 404 — but 200 proves no call).
    expect(res.body).toEqual([{ id: "ret-issue-1" }]);
  });

  it("agent actor → 200 rows (issue endpoint is company-scoped, not user-scoped)", async () => {
    const res = await request(makeApp(makeDb([]), agentActor()))
      .get(issueUrl);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
