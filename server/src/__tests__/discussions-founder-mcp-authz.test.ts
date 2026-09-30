/**
 * discussions-founder-mcp-authz.test.ts
 *
 * Contract test for the HIGH-severity authz bypass in discussions.ts:
 * buildActor() was calling getEffectiveRole() for non-board bearer tokens,
 * so a founder-created MCP key (which replays the founder's userId via
 * authz.ts:44 + auth.ts:160-173) resolved to role "founder" and gained
 * read-anyone + privileged writes + agent dispatch on the threads surface.
 *
 * Fix: gate the getEffectiveRole call on req.actor.type === "board" only.
 * Non-board actors (mcp, agent) get role "team_member" regardless of
 * what getEffectiveRole would return. (Mirrors conversation-authz.ts.)
 *
 * Strategy (no tautology): drive the REAL Express route (supertest +
 * discussionRoutes) with mocked permissionService/getActorInfo/
 * assertCompanyAccess/threadService deps.  The guard (buildActor) is NOT
 * mocked — the test asserts its observable HTTP outcomes and whether
 * getEffectiveRole was/wasn't called per actor class.
 *
 * Reference: git show 7ae21f3f6:server/src/__tests__/memory-retrievals-authz.test.ts
 * Actor matrix:
 *   1. mcp founder token, NOT participant → 404  AND getEffectiveRole NOT called   [RED pre-fix]
 *   2. board founder → 200                AND getEffectiveRole IS called            [GREEN always]
 *   3. mcp founder token, write route     → 404  AND getEffectiveRole NOT called   [RED pre-fix]
 *   4. board non-founder (sanity)         → scoped as before                        [GREEN always]
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── drizzle-orm mock ──────────────────────────────────────────────────────────
// We stub all operators — the route+service read columns from the mocked DB via
// the threadService mock below, so operator identity is irrelevant here.
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  or: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => ({ _eq: args }),
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
    { get: (t: Record<string, unknown>, p: string | symbol) => (p in t ? t[p] : () => "sql") },
  ),
}));

// ── @armyofagents/db mock ─────────────────────────────────────────────────────
// Only the tables directly imported by discussions.ts at the top level need to
// be present; columns are accessed as symbols so exact values don't matter.
function makeProxy(name: string) {
  const cols: Record<string, symbol> = {};
  return new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "_") return { name };
      if (typeof prop === "string") {
        if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
        return cols[prop];
      }
      return undefined;
    },
  });
}

vi.mock("@armyofagents/db", () => ({
  discussions:              makeProxy("discussions"),
  threadParticipants:       makeProxy("threadParticipants"),
  threadLinks:              makeProxy("threadLinks"),
  userRoles:                makeProxy("userRoles"),
  discussionEntries:        makeProxy("discussionEntries"),
  discussionExtractedItems: makeProxy("discussionExtractedItems"),
  scopeItemDependencies:    makeProxy("scopeItemDependencies"),
  taskDependencies:         makeProxy("taskDependencies"),
  issues:                   makeProxy("issues"),
  agents:                   makeProxy("agents"),
  authUsers:                makeProxy("authUsers"),
  companyMemberships:       makeProxy("companyMemberships"),
  agentWakeupRequests:      makeProxy("agentWakeupRequests"),
  aoaAgentTriggers:         makeProxy("aoaAgentTriggers"),
  threadPlanSteps:          makeProxy("threadPlanSteps"),
  threadInboxItems:         makeProxy("threadInboxItems"),
  internalAgentConfig:      makeProxy("internalAgentConfig"),
  // Further tables accessed via dynamic import inside discussions.ts
  discussionAnnotations:    makeProxy("discussionAnnotations"),
  projects:                 makeProxy("projects"),
  goals:                    makeProxy("goals"),
  assets:                   makeProxy("assets"),
  artifacts:                makeProxy("artifacts"),
  companySecrets:           makeProxy("companySecrets"),
  inbox:                    makeProxy("inbox"),
}));

// ── threadService mock ────────────────────────────────────────────────────────
// We mock threadService so we control what it returns per actor class.
// The real buildActor runs BEFORE the service call, so mocking here doesn't
// short-circuit the guard under test.
const mockEntriesSince = vi.fn();
const mockRouteItem    = vi.fn();
const mockAddEntry     = vi.fn();

vi.mock("../services/threads.js", () => ({
  threadService: vi.fn(() => ({
    entriesSince:      mockEntriesSince,
    routeItem:         mockRouteItem,
    // stubs for other methods called at route construction time (none for our tested routes)
    list:              vi.fn(),
    getById:           vi.fn(),
    create:            vi.fn(),
    advancePhase:      vi.fn(),
    claim:             vi.fn(),
    transfer:          vi.fn(),
    addParticipant:    vi.fn(),
    updateSummary:     vi.fn(),
    listLinks:         vi.fn(),
    createLink:        vi.fn(),
    spinOff:           vi.fn(),
    getEnvelopeRbac:   vi.fn(),
    assignScopeItems:  vi.fn(),
    createScopeItem:   vi.fn(),
    updateScopeItem:   vi.fn(),
    deleteScopeItem:   vi.fn(),
    reorderScopeItems: vi.fn(),
    listScopeItems:    vi.fn(),
    getScopeItemGraph: vi.fn(),
    addScopeItemDependency:    vi.fn(),
    removeScopeItemDependency: vi.fn(),
    getDeliverables:   vi.fn(),
    addDeliverable:    vi.fn(),
    removeDeliverable: vi.fn(),
    delete:            vi.fn(),
    postEntry:         vi.fn(),
    updatePlan:        vi.fn(),
    updatePlanStep:    vi.fn(),
    createPlanStep:    vi.fn(),
    deletePlanStep:    vi.fn(),
    reorderPlanSteps:  vi.fn(),
  })),
  parseMentions:    vi.fn(() => []),
  processMentions:  vi.fn(async () => {}),
}));

// ── permissionService mock ────────────────────────────────────────────────────
// The KEY spy: we assert whether it was or wasn't called per actor class.
const mockGetEffectiveRole = vi.fn();

vi.mock("../services/index.js", () => ({
  discussionService: vi.fn(() => ({
    getById:     vi.fn(),
    list:        vi.fn(),
    create:      vi.fn(),
    update:      vi.fn(),
    addEntry:    mockAddEntry,
    updateEntry: vi.fn(),
    approve:     vi.fn(),
    delete:      vi.fn(),
  })),
  logActivity:       vi.fn(async () => {}),
  permissionService: vi.fn(() => ({
    getEffectiveRole: mockGetEffectiveRole,
  })),
}));

// ── assertCompanyAccess + getActorInfo mock ───────────────────────────────────
// assertCompanyAccess is a no-op so it never rejects any actor.
// getActorInfo mirrors the real implementation: mcp actor → actorId = userId.
vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn((req: { actor: Record<string, unknown> }) => {
    const actor = req.actor;
    if (actor.type === "agent") {
      return { actorType: "agent" as const, actorId: actor.agentId ?? "agent-id", agentId: actor.agentId ?? null, runId: null };
    }
    // mcp actors: actorId = req.actor.userId (mirrors auth.ts:160-173 + authz.ts:44)
    if (actor.type === "mcp") {
      return { actorType: "user" as const, actorId: actor.userId ?? "mcp-user", agentId: null, runId: null };
    }
    // board
    return { actorType: "user" as const, actorId: actor.userId ?? "unknown", agentId: null, runId: null };
  }),
}));

// ── misc mocks needed by discussions.ts at module load ────────────────────────
vi.mock("../middleware/validate.js",          () => ({ validate: () => (_: unknown, __: unknown, next: () => void) => next() }));
vi.mock("../middleware/rbac.js",              () => ({ assertRole: vi.fn(async () => {}) }));
vi.mock("../middleware/logger.js",            () => { const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }; logger.child = vi.fn(() => logger); return { logger }; });
// scope-version routes (added to discussionRoutes) pull in memory→embeddings→db at
// module load; stub the service so this auth-focused test doesn't load that chain.
vi.mock("../services/thread-scope-versions.js", () => ({ threadScopeVersionService: () => new Proxy({}, { get: () => () => Promise.resolve(undefined) }) }));
vi.mock("../services/live-events.js",         () => ({ publishLiveEvent: vi.fn(async () => {}) }));
vi.mock("../services/activity-log.js",        () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("../services/issue-assignee-wakeup.js", () => ({ enqueueIssueAssigneeWakeup: vi.fn(async () => {}) }));
vi.mock("../services/inbox-attach.js",        () => ({
  attachInboxItemToThread:    vi.fn(async () => {}),
  promoteInboxItemToNewThread: vi.fn(async () => {}),
}));
vi.mock("../routes/issues-planning-mode-dispatch.js", () => ({ shouldDispatchIssueWakeup: vi.fn(() => true) }));
vi.mock("../errors.js", () => ({
  notFound:   (msg: string) => Object.assign(new Error(msg), { status: 404 }),
  badRequest: (msg: string) => Object.assign(new Error(msg), { status: 400 }),
  HttpError: class HttpError extends Error { status: number; constructor(msg: string, status: number) { super(msg); this.status = status; } },
}));

// ── Import route AFTER all mocks are registered ───────────────────────────────
import { discussionRoutes } from "../routes/discussions.js";
import { errorHandler } from "../middleware/index.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const COMPANY_ID   = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID    = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM_ID      = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FOUNDER_ID   = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OTHER_ID     = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

// ── Actor factory helpers ─────────────────────────────────────────────────────
type ActorShape =
  | { type: "board"; source: "session" | "local_implicit"; userId: string; companyIds: string[]; isInstanceAdmin: boolean }
  | { type: "agent"; companyId: string; agentId: string; runId: null }
  | { type: "mcp";   companyId: string; userId: string;   runId: null };

const boardFounder = (userId = FOUNDER_ID): ActorShape => ({
  type: "board", source: "session", userId, companyIds: [COMPANY_ID], isInstanceAdmin: false,
});

const boardMember = (userId = OTHER_ID): ActorShape => ({
  type: "board", source: "session", userId, companyIds: [COMPANY_ID], isInstanceAdmin: false,
});

const mcpFounder = (userId = FOUNDER_ID): ActorShape => ({
  type: "mcp", companyId: COMPANY_ID, userId, runId: null,
});

// ── App factory ───────────────────────────────────────────────────────────────
function makeApp(actor: ActorShape) {
  // Minimal DB stub — the route only hits the DB via mocked threadService/permissionService
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) })) })),
  } as unknown as Parameters<typeof discussionRoutes>[0];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", discussionRoutes(db));
  app.use(errorHandler);
  return app;
}

// URL helpers
const entriesUrl = `/api/companies/${COMPANY_ID}/discussions/${THREAD_ID}/entries`;
const routingUrl = `/api/companies/${COMPANY_ID}/discussions/${THREAD_ID}/items/${ITEM_ID}/routing`;

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildActor — board-gate (HIGH founder-MCP authz bypass fix)", () => {

  /**
   * Case 1 — READ, mcp founder token NOT participant.
   *
   * Pre-fix: getEffectiveRole("founder") → actor.role="founder" → assertCanView
   * early-returns → 200 (leaks private thread).
   * Post-fix: non-board guard fires BEFORE getEffectiveRole → role="team_member"
   * → threadService.entriesSince gets a team_member actor → (since service is
   * mocked) the gate is reflected in the actor passed to the service; we assert
   * getEffectiveRole was NOT called.
   *
   * The threadService mock returns entries, so the only thing that can produce
   * a 404 here (pre-fix) is if the actor's role was team_member and the real
   * service denied — but we mock the service too. Therefore we focus on the
   * getEffectiveRole NOT-called assertion as the discriminator (plus the role
   * that would have been derived), and we verify the service receives a
   * team_member actor by configuring entriesSince to throw notFound for
   * team_member (simulating the real canViewThread check) and succeed for founder.
   */
  it("READ — mcp founder token → getEffectiveRole NOT called, entriesSince receives team_member actor (denied)", async () => {
    // Configure service: throw 404 for non-founder actors (simulates canViewThread=false)
    mockGetEffectiveRole.mockResolvedValue("founder"); // would return "founder" IF called
    mockEntriesSince.mockImplementation((_cid: string, _tid: string, _seq: number, actor: { role: string }) => {
      if (actor.role === "founder") return Promise.resolve([]);
      return Promise.reject(Object.assign(new Error("Thread not found"), { status: 404 }));
    });

    const res = await request(makeApp(mcpFounder(FOUNDER_ID)))
      .get(entriesUrl);

    // Pre-fix: would be 200 (founder bypass); post-fix: 404 (team_member denied by service)
    expect(res.status).toBe(404);

    // The guard must NOT have called getEffectiveRole for a non-board actor
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
  });

  /**
   * Case 2 — READ, board founder.
   *
   * Board actor goes through getEffectiveRole (the normal path). Service
   * receives founder → returns entries → 200.
   */
  it("READ — board founder → getEffectiveRole IS called, 200", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockEntriesSince.mockImplementation((_cid: string, _tid: string, _seq: number, actor: { role: string }) => {
      if (actor.role === "founder") return Promise.resolve([]);
      return Promise.reject(Object.assign(new Error("Thread not found"), { status: 404 }));
    });

    const res = await request(makeApp(boardFounder()))
      .get(entriesUrl);

    expect(res.status).toBe(200);
    expect(mockGetEffectiveRole).toHaveBeenCalledWith(COMPANY_ID, FOUNDER_ID);
  });

  /**
   * Case 3 — WRITE (routeItem PATCH), mcp founder token.
   *
   * Pre-fix: actor.role="founder" → routeItem's founder gate passes → service
   * runs (and would dispatch wakeup, spend budget, etc.).
   * Post-fix: role="team_member" → routeItem's founder gate throws notFound
   * immediately (threads.ts:1671) → 404.
   * getEffectiveRole must NOT be called.
   */
  it("WRITE — mcp founder token, routeItem PATCH → getEffectiveRole NOT called, denied 404", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder"); // would elevate IF called
    mockRouteItem.mockImplementation((_cid: string, _iid: string, _routing: unknown, actor: { role: string }) => {
      if (actor.role !== "founder") {
        return Promise.reject(Object.assign(new Error("Thread not found"), { status: 404 }));
      }
      return Promise.resolve({ id: ITEM_ID });
    });

    const res = await request(makeApp(mcpFounder(FOUNDER_ID)))
      .patch(routingUrl)
      .send({ assigneeUserId: OTHER_ID });

    expect(res.status).toBe(404);
    expect(mockGetEffectiveRole).not.toHaveBeenCalled();
  });

  /**
   * Case 4 — WRITE (routeItem PATCH), board founder (sanity).
   *
   * Board actor → getEffectiveRole → "founder" → routeItem succeeds → 200.
   */
  it("WRITE — board founder → getEffectiveRole IS called, routeItem succeeds", async () => {
    mockGetEffectiveRole.mockResolvedValue("founder");
    mockRouteItem.mockImplementation((_cid: string, _iid: string, _routing: unknown, actor: { role: string }) => {
      if (actor.role !== "founder") {
        return Promise.reject(Object.assign(new Error("Thread not found"), { status: 404 }));
      }
      return Promise.resolve({ id: ITEM_ID });
    });

    const res = await request(makeApp(boardFounder()))
      .patch(routingUrl)
      .send({ assigneeUserId: OTHER_ID });

    expect(res.status).toBe(200);
    expect(mockGetEffectiveRole).toHaveBeenCalledWith(COMPANY_ID, FOUNDER_ID);
  });

  /**
   * Case 5 — board non-founder (team_member, sanity).
   *
   * A board user whose role resolves to team_member still goes through
   * getEffectiveRole (it's a board session). Service receives team_member → denied.
   */
  it("READ — board non-founder team_member → getEffectiveRole IS called, denied by service", async () => {
    mockGetEffectiveRole.mockResolvedValue("team_member");
    mockEntriesSince.mockImplementation((_cid: string, _tid: string, _seq: number, actor: { role: string }) => {
      if (actor.role === "founder") return Promise.resolve([]);
      return Promise.reject(Object.assign(new Error("Thread not found"), { status: 404 }));
    });

    const res = await request(makeApp(boardMember()))
      .get(entriesUrl);

    expect(res.status).toBe(404);
    expect(mockGetEffectiveRole).toHaveBeenCalledWith(COMPANY_ID, OTHER_ID);
  });

  it("POST entry resolves a team_member actor and delegates authorization to the service", async () => {
    mockGetEffectiveRole.mockResolvedValue("team_member");
    mockAddEntry.mockResolvedValue({ id: "entry-1" });

    const res = await request(makeApp(boardMember()))
      .post(entriesUrl)
      .send({ inputType: "write", rawContent: "Participant reply" });

    expect(res.status).toBe(201);
    expect(mockAddEntry).toHaveBeenCalledWith(
      COMPANY_ID,
      THREAD_ID,
      expect.objectContaining({ rawContent: "Participant reply" }),
      OTHER_ID,
      expect.objectContaining({
        userId: OTHER_ID,
        role: "team_member",
        isHuman: true,
      }),
    );
  });
});
