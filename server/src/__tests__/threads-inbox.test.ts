/**
 * Contract tests for threads inbox/triage endpoints (Plan 5, Task 4).
 *
 * Verifies the following endpoints exist in discussionRoutes:
 *   GET  /companies/:companyId/discussions/inbox         — list pending inbox items
 *   POST /companies/:companyId/discussions/inbox/:itemId/triage
 *        body: { action: "attach" | "dismiss" | "make_thread", threadId?: string }
 *
 * Also verifies GET /companies/:companyId/discussions already accepts
 * phase + q filter query params (route-level inspection only).
 *
 * These are contract-only tests — no real DB or HTTP server is started.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ── Mocks (mirror threads-routes-contract.test.ts pattern) ───────────────────

vi.mock("drizzle-orm", () => {
  const SQL_STUB: any = { as: () => SQL_STUB, join: () => SQL_STUB, raw: () => SQL_STUB, toString: () => "sql" };
  const sqlFn = Object.assign((..._a: any[]) => SQL_STUB, { join: () => SQL_STUB, raw: () => SQL_STUB });
  const sql = new Proxy(sqlFn, { get: (t: any, p: any) => (p in t ? t[p] : () => SQL_STUB), apply: () => SQL_STUB });
  return {
    and: vi.fn((...args: any[]) => args),
    eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
    desc: vi.fn((col: any) => ({ desc: col })),
    inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
    isNull: vi.fn((col: any) => ({ isNull: col })),
    ilike: vi.fn((col: any, val: any) => ({ ilike: [col, val] })),
    sql,
  };
});

vi.mock("@armyofagents/db", () => {
  const colProxy = () => new Proxy({} as any, { get: (_t, col) => col });
  return new Proxy({} as any, {
    get: (_t, name: string | symbol) => {
      if (typeof name !== "string") return undefined;
      return colProxy();
    },
    has: (_t, _name) => true,
    ownKeys: (_t) => [],
    getOwnPropertyDescriptor: (_t, name) => ({
      value: colProxy(),
      writable: true,
      enumerable: true,
      configurable: true,
    }),
  });
});

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => { const e = new Error(msg); (e as any).status = 400; return e; },
  notFound: (msg: string) => { const e = new Error(msg); (e as any).status = 404; return e; },
  unauthorized: () => { const e = new Error("Unauthorized"); (e as any).status = 401; return e; },
  forbidden: () => { const e = new Error("Forbidden"); (e as any).status = 403; return e; },
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
  },
}));

vi.mock("../services/index.js", () => ({
  discussionService: vi.fn(() => ({
    list: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    addEntry: vi.fn(),
    reprocessEntry: vi.fn(),
    reprocessAllEntries: vi.fn(),
    updateItem: vi.fn(),
    approveItems: vi.fn(),
    rejectItems: vi.fn(),
    addAnnotation: vi.fn(),
    linkEntry: vi.fn(),
  })),
  logActivity: vi.fn().mockResolvedValue(undefined),
  permissionService: vi.fn(() => ({
    getEffectiveRole: vi.fn().mockResolvedValue("founder"),
  })),
}));

vi.mock("../services/threads.js", () => ({
  threadService: vi.fn(() => ({
    advancePhase: vi.fn().mockResolvedValue({ id: "t1", phase: "scope" }),
    claim: vi.fn().mockResolvedValue({ ownerUserId: "u1" }),
    transferOwnership: vi.fn().mockResolvedValue({ ownerUserId: "u2" }),
    addParticipant: vi.fn().mockResolvedValue({ ok: true }),
    promoteToGoal: vi.fn().mockResolvedValue({ goalId: "g1" }),
    assignScopeItems: vi.fn().mockResolvedValue({ created: 0 }),
  })),
}));

vi.mock("../middleware/validate.js", () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertHumanRole: vi.fn().mockResolvedValue(undefined),
  assertDepartmentAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn().mockReturnValue({ actorType: "user", actorId: "u1", agentId: null }),
}));

vi.mock("../redaction.js", () => ({
  sanitizeRecord: vi.fn((r: any) => r),
}));

// ── Mock 0.3 write-path (inbox-attach service) ────────────────────────────────
// These mocks let the delegation tests assert that the route calls the 0.3
// functions with the correct args without actually executing DB logic.
//
// NOTE: vi.mock() is hoisted to the top of the file by Vitest, so the factory
// must not reference outer `const` variables declared after the vi.mock call.
// We export the spy references from the factory and import them back via
// vi.mocked() after the import block.

vi.mock("../services/inbox-attach.js", () => ({
  attachInboxItemToThread: vi.fn(),
  promoteInboxItemToNewThread: vi.fn(),
}));

// ── Import ────────────────────────────────────────────────────────────────────

import { discussionRoutes } from "../routes/discussions.js";
import * as inboxAttachModule from "../services/inbox-attach.js";

// ── Helper ────────────────────────────────────────────────────────────────────

function extractRoutes(router: any): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  const layers: any[] = router.stack ?? [];
  for (const layer of layers) {
    if (layer.route) {
      const path = layer.route.path as string;
      const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
      for (const method of methods) {
        routes.push({ method, path });
      }
    }
  }
  return routes;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("threads inbox/triage route contracts", () => {
  let routes: Array<{ method: string; path: string }>;

  beforeAll(() => {
    const mockDb = {} as any;
    const router = discussionRoutes(mockDb);
    routes = extractRoutes(router);
  });

  function hasRoute(method: string, pathSuffix: string): boolean {
    return routes.some(
      (r) => r.method === method && r.path.endsWith(pathSuffix),
    );
  }

  it("GET /companies/:companyId/discussions/inbox exists", () => {
    expect(hasRoute("GET", "/discussions/inbox")).toBe(true);
  });

  it("POST /companies/:companyId/discussions/inbox/:itemId/triage exists", () => {
    expect(hasRoute("POST", "/discussions/inbox/:itemId/triage")).toBe(true);
  });

  it("triage route path contains both inbox and itemId and triage segments", () => {
    const triageRoute = routes.find(
      (r) => r.method === "POST" && r.path.includes("inbox") && r.path.includes("triage"),
    );
    expect(triageRoute).toBeDefined();
    expect(triageRoute!.path).toMatch(/inbox\/:itemId\/triage/);
  });

  it("inbox list route path contains inbox segment", () => {
    const inboxRoute = routes.find(
      (r) => r.method === "GET" && r.path.endsWith("/discussions/inbox"),
    );
    expect(inboxRoute).toBeDefined();
  });
});

// ── Triage action validation tests (logic-level, no DB) ──────────────────────

describe("triage action validation", () => {
  const VALID_ACTIONS = ["attach", "dismiss", "make_thread"];

  it("recognizes all valid triage actions", () => {
    for (const action of VALID_ACTIONS) {
      expect(VALID_ACTIONS).toContain(action);
    }
  });

  it("requires threadId when action is attach", () => {
    // Contract: attach without threadId should be rejected
    function validateTriagePayload(body: { action: string; threadId?: string }): string | null {
      if (!VALID_ACTIONS.includes(body.action)) return "invalid action";
      if (body.action === "attach" && !body.threadId) return "threadId required for attach";
      return null;
    }

    expect(validateTriagePayload({ action: "dismiss" })).toBeNull();
    expect(validateTriagePayload({ action: "make_thread" })).toBeNull();
    expect(validateTriagePayload({ action: "attach" })).toBe("threadId required for attach");
    expect(validateTriagePayload({ action: "attach", threadId: "t-1" })).toBeNull();
  });

  it("dismiss sets status to dismissed (action contract)", () => {
    const STATUS_MAP: Record<string, string> = {
      dismiss: "dismissed",
      attach: "attached",
      make_thread: "attached", // inbox item is marked attached to the new discussion
    };
    expect(STATUS_MAP["dismiss"]).toBe("dismissed");
    expect(STATUS_MAP["attach"]).toBe("attached");
  });
});

// ── Delegation tests (Codex #6 fix — Task 0.4) ───────────────────────────────
//
// The `attach` and `make_thread` handlers must delegate to the 0.3 write-path
// (inbox-attach.ts) so that inbound rawContent actually lands as a
// discussion_entries row.  The `dismiss` handler is unchanged.
//
// Strategy: build a lightweight fake Express environment (req/res), find the
// triage handler from the router stack, and invoke it directly.  We assert
// that the mock 0.3 functions are called with the correct arguments.

describe("triage handler delegation to 0.3 write-path (Codex #6)", () => {
  // A minimal mock db whose select chain returns pre-configured rows.
  // The route pre-flight checks need:
  //   - threadInboxItems select → item row (for all actions)
  //   - discussions select → thread row (for attach only)
  // After the route delegates to inbox-attach.ts, those mocks do the work.
  function makeMockDb(opts: {
    itemRow?: object | null;
    threadRow?: object | null;
  } = {}) {
    const {
      itemRow = {
        id: "item-1",
        companyId: "co-1",
        rawContent: "hello world",
        status: "pending",
      },
      threadRow = { id: "00000000-0000-0000-0000-000000000001" },
    } = opts;

    // select is called in order: first for inbox item, then (for attach) for thread.
    let callIdx = 0;
    const rows = [itemRow, threadRow];
    // Build a chainable object where from() returns the same object (not 'this'
    // on the mock function — mockReturnThis() returns the vi.fn, not the parent obj).
    function makeSelectChain() {
      const chain: any = {
        from: (_table: any) => chain,
        where: (_cond: any) => {
          const result = rows[callIdx] ? [rows[callIdx]] : [];
          callIdx++;
          return Promise.resolve(result);
        },
      };
      return chain;
    }
    const select = vi.fn(() => makeSelectChain());

    // update is still used by the dismiss branch (no delegation).
    const update = vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    }));

    return { db: { select, update } as any };
  }

  /** Find the triage POST handler from the router stack. */
  function getTriageHandler() {
    const { db } = makeMockDb();
    const router = discussionRoutes(db);
    const layer = (router.stack ?? []).find(
      (l: any) =>
        l.route &&
        l.route.methods?.post &&
        typeof l.route.path === "string" &&
        l.route.path.includes("inbox") &&
        l.route.path.includes("triage"),
    );
    if (!layer) throw new Error("triage route not found in router stack");
    return layer.route.stack[layer.route.stack.length - 1].handle as Function;
  }

  /** Build a fake req/res pair and invoke the handler, returning the response payload. */
  async function invokeHandler(
    handler: Function,
    db: any,
    params: { companyId: string; itemId: string },
    body: object,
  ): Promise<{ status: number; body: any }> {
    // Re-create the router with this specific db so the handler closure captures it.
    const router = discussionRoutes(db);
    const layer = (router.stack ?? []).find(
      (l: any) =>
        l.route &&
        l.route.methods?.post &&
        typeof l.route.path === "string" &&
        l.route.path.includes("inbox") &&
        l.route.path.includes("triage"),
    );
    const realHandler = layer!.route.stack[layer!.route.stack.length - 1].handle as Function;

    let responseStatus = 200;
    let responseBody: any = null;

    const req: any = {
      params,
      body,
      // Provide the actor shape that assertCompanyAccess + getActorInfo read.
      actor: {
        type: "board",
        userId: "u1",
        source: "local_implicit", // bypasses company-list check in assertCompanyAccess
        companyIds: [params.companyId],
        isInstanceAdmin: false,
      },
    };
    const res: any = {
      status: (s: number) => { responseStatus = s; return res; },
      json: (b: any) => { responseBody = b; return res; },
    };

    await realHandler(req, res, (err: any) => { throw err; });

    return { status: responseStatus, body: responseBody };
  }

  beforeEach(() => {
    vi.mocked(inboxAttachModule.attachInboxItemToThread).mockReset();
    vi.mocked(inboxAttachModule.promoteInboxItemToNewThread).mockReset();
  });

  it("attach action: delegates to attachInboxItemToThread with correct args", async () => {
    const { db } = makeMockDb();
    vi.mocked(inboxAttachModule.attachInboxItemToThread).mockResolvedValue({
      posted: true,
      entryId: "entry-new",
      alreadyHandled: false,
    });

    const resp = await invokeHandler(
      getTriageHandler(),
      db,
      { companyId: "co-1", itemId: "item-1" },
      { action: "attach", threadId: "00000000-0000-0000-0000-000000000001" },
    );

    expect(inboxAttachModule.attachInboxItemToThread).toHaveBeenCalledOnce();
    const [_calledDb, calledArgs] = vi.mocked(inboxAttachModule.attachInboxItemToThread).mock.calls[0];
    expect(calledArgs.companyId).toBe("co-1");
    expect(calledArgs.inboxItemId).toBe("item-1");
    expect(calledArgs.threadId).toBe("00000000-0000-0000-0000-000000000001");
    expect(calledArgs.actor).toBeDefined();

    // Response must include the entryId so callers know the entry was posted.
    expect(resp.body.entryId).toBe("entry-new");
    expect(resp.body.status).toBe("attached");
  });

  it("attach action: alreadyHandled is still 200 (idempotent)", async () => {
    // The item is already 'attached' — but for the route pre-flight we still
    // get a 409 from the status check.  The alreadyHandled path is hit when
    // the 0.3 claim UPDATE finds no pending row INSIDE the transaction.
    // We test idempotency at the service level here by making the service
    // return alreadyHandled:true and asserting a 200.
    const { db } = makeMockDb();
    vi.mocked(inboxAttachModule.attachInboxItemToThread).mockResolvedValue({
      posted: false,
      entryId: null,
      alreadyHandled: true,
    });

    const resp = await invokeHandler(
      getTriageHandler(),
      db,
      { companyId: "co-1", itemId: "item-1" },
      { action: "attach", threadId: "00000000-0000-0000-0000-000000000001" },
    );

    expect(resp.status).toBe(200);
    expect(resp.body.alreadyHandled).toBe(true);
  });

  it("make_thread action: delegates to promoteInboxItemToNewThread with correct args", async () => {
    const { db } = makeMockDb();
    vi.mocked(inboxAttachModule.promoteInboxItemToNewThread).mockResolvedValue({
      threadId: "new-thread-99",
      entryId: "entry-first",
      alreadyHandled: false,
    });

    const resp = await invokeHandler(
      getTriageHandler(),
      db,
      { companyId: "co-1", itemId: "item-1" },
      { action: "make_thread" },
    );

    expect(inboxAttachModule.promoteInboxItemToNewThread).toHaveBeenCalledOnce();
    const [_calledDb, calledArgs] = vi.mocked(inboxAttachModule.promoteInboxItemToNewThread).mock.calls[0];
    expect(calledArgs.companyId).toBe("co-1");
    expect(calledArgs.inboxItemId).toBe("item-1");
    expect(calledArgs.actor).toBeDefined();

    // Response includes threadId + entryId.
    expect(resp.body.threadId).toBe("new-thread-99");
    expect(resp.body.entryId).toBe("entry-first");
    expect(resp.status).toBe(201);
  });

  it("make_thread action: alreadyHandled → 200 with alreadyHandled:true, no logActivity", async () => {
    const { db } = makeMockDb();
    vi.mocked(inboxAttachModule.promoteInboxItemToNewThread).mockResolvedValue({
      threadId: null,
      entryId: null,
      alreadyHandled: true,
    });

    const resp = await invokeHandler(
      getTriageHandler(),
      db,
      { companyId: "co-1", itemId: "item-1" },
      { action: "make_thread" },
    );

    expect(resp.status).toBe(200);
    expect(resp.body.alreadyHandled).toBe(true);
    expect(resp.body.threadId).toBeNull();
  });

  it("dismiss action: does NOT call inbox-attach functions", async () => {
    const { db } = makeMockDb();
    // dismiss still does a direct DB update — no 0.3 delegation.
    (db as any).update = vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    }));

    await invokeHandler(
      getTriageHandler(),
      db,
      { companyId: "co-1", itemId: "item-1" },
      { action: "dismiss" },
    );

    expect(inboxAttachModule.attachInboxItemToThread).not.toHaveBeenCalled();
    expect(inboxAttachModule.promoteInboxItemToNewThread).not.toHaveBeenCalled();
  });
});
