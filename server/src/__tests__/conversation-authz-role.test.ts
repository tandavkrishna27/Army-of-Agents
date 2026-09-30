/**
 * Unit tests for resolveActorRole (conversation-authz.ts).
 *
 * Board-gated effective-role helper: founder-equivalence is conferred ONLY to
 * interactive board sessions (local_implicit / instance admin / founder DB role).
 * MCP & agent bearer tokens are always "team_member", regardless of the
 * founder's userId being replayed on the token.
 *
 * TDD: written BEFORE the export exists; expected to fail until Task 1 Step 2.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

// ── drizzle-orm stub (ESM circular-dep workaround) ───────────────────────────
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// ── DB table stubs ────────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => ({
  internalAgentConversations: makeTableProxy("internal_agent_conversations"),
}));

// ── permissionService mock — controllable per test ─────────────────────────
const mockGetEffectiveRole = vi.hoisted(() => vi.fn().mockResolvedValue("team_member"));

vi.mock("../services/permissions.js", () => ({
  permissionService: vi.fn(() => ({
    getEffectiveRole: mockGetEffectiveRole,
  })),
}));

// ── getActorInfo mock — fixed: returns the userId for board/mcp actors ────────
vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn((req: { actor: { type: string; agentId?: string; userId?: string } }) => {
    if (req.actor.type === "agent") {
      return { actorType: "agent" as const, actorId: req.actor.agentId ?? "agent-id", agentId: req.actor.agentId ?? null, runId: null };
    }
    // mcp and board actors: actorId = userId (mirrors real getActorInfo)
    return { actorType: "user" as const, actorId: (req.actor as { userId?: string }).userId ?? "unknown", agentId: null, runId: null };
  }),
}));

// ── Import under test (after all vi.mock calls) ──────────────────────────────
import { resolveActorRole } from "../routes/conversation-authz.js";

// ── Constants ────────────────────────────────────────────────────────────────
const COMPANY_ID  = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const FOUNDER_ID  = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";
const MEMBER_ID   = "cccccccc-cccc-4ccc-8ccc-000000000003";

// ── Helpers: minimal req shapes ──────────────────────────────────────────────
function makeBoardReq(userId: string, opts: { source?: string; isInstanceAdmin?: boolean } = {}) {
  return {
    actor: {
      type: "board",
      source: opts.source ?? "session",
      userId,
      isInstanceAdmin: opts.isInstanceAdmin ?? false,
      companyIds: [COMPANY_ID],
    },
  } as unknown as import("express").Request;
}

function makeMcpReq(userId: string) {
  return {
    actor: {
      type: "mcp",
      userId,
      companyId: COMPANY_ID,
      runId: null,
    },
  } as unknown as import("express").Request;
}

function makeAgentReq(agentId: string) {
  return {
    actor: {
      type: "agent",
      agentId,
      companyId: COMPANY_ID,
      runId: null,
    },
  } as unknown as import("express").Request;
}

// ── Stub DB — not exercised by resolveActorRole, but required param ───────────
const stubDb = {} as unknown as import("@armyofagents/db").Db;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveActorRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffectiveRole.mockResolvedValue("team_member");
  });

  it("local_implicit board → 'founder' without calling getEffectiveRole", async () => {
    const req = makeBoardReq(FOUNDER_ID, { source: "local_implicit" });
    const role = await resolveActorRole(stubDb, req, COMPANY_ID);
    expect(role).toBe("founder");
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
  });

  it("instance-admin board → 'founder' without calling getEffectiveRole", async () => {
    const req = makeBoardReq(FOUNDER_ID, { isInstanceAdmin: true });
    const role = await resolveActorRole(stubDb, req, COMPANY_ID);
    expect(role).toBe("founder");
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
  });

  it("board session where getEffectiveRole returns 'founder' → 'founder'", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder");
    const req = makeBoardReq(FOUNDER_ID);
    const role = await resolveActorRole(stubDb, req, COMPANY_ID);
    expect(role).toBe("founder");
    expect(mockGetEffectiveRole).toHaveBeenCalledTimes(1);
  });

  it("board session where getEffectiveRole returns 'team_member' → 'team_member'", async () => {
    mockGetEffectiveRole.mockResolvedValue("team_member");
    const req = makeBoardReq(MEMBER_ID);
    const role = await resolveActorRole(stubDb, req, COMPANY_ID);
    expect(role).toBe("team_member");
    expect(mockGetEffectiveRole).toHaveBeenCalledTimes(1);
  });

  it("mcp actor with founder userId → 'team_member' AND getEffectiveRole NOT called", async () => {
    // This is the core security assertion: a founder-created MCP key replays the
    // founder's userId, which getEffectiveRole would resolve to "founder" and
    // (pre-fix) grant founder-level access. The fix gates founder-equivalence on
    // type:"board", so this returns "team_member" without ever calling getEffectiveRole.
    mockGetEffectiveRole.mockResolvedValue("founder"); // would return founder IF called
    const req = makeMcpReq(FOUNDER_ID);
    const role = await resolveActorRole(stubDb, req, COMPANY_ID);
    expect(role).toBe("team_member");
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
  });

  it("agent actor → 'team_member' without calling getEffectiveRole", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder"); // would return founder IF called
    const req = makeAgentReq("agent-00000000-0000-4000-8000-000000000001");
    const role = await resolveActorRole(stubDb, req, COMPANY_ID);
    expect(role).toBe("team_member");
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
  });
});
