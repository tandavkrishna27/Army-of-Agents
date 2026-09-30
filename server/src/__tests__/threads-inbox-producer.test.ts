/**
 * Task 0.6 (Inbound Dirty-Data Routing) — contract tests for the
 * POST /companies/:companyId/discussions/inbox paste producer route.
 *
 * Verifies:
 *   (a) the POST /discussions/inbox route exists in discussionRoutes
 *   (b) the handler calls enqueueInboxItem with originMedium:'paste'
 *   (c) the handler uses the authed user id when originSource is omitted
 *   (d) 201 response shape: { inboxItemId, deduped }
 *   (e) RBAC: founder + team_lead have access (assertHumanRole called correctly)
 *
 * Mock pattern mirrors threads-inbox.test.ts exactly.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// ── Mocks (mirror threads-inbox.test.ts) ─────────────────────────────────────

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
  parseMentions: vi.fn().mockReturnValue([]),
  processMentions: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../services/inbox-attach.js", () => ({
  attachInboxItemToThread: vi.fn(),
  promoteInboxItemToNewThread: vi.fn(),
}));

// The key mock: capture calls to enqueueInboxItem.
vi.mock("../services/inbox-producer.js", () => ({
  enqueueInboxItem: vi.fn(),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { discussionRoutes } from "../routes/discussions.js";
import * as inboxProducer from "../services/inbox-producer.js";
import * as rbacModule from "../middleware/rbac.js";
import * as authzModule from "./authz.js";

// ── Helpers (mirror threads-inbox.test.ts) ────────────────────────────────────

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

// ── Contract tests ────────────────────────────────────────────────────────────

describe("paste producer route contract (Task 0.6)", () => {
  let routes: Array<{ method: string; path: string }>;

  beforeAll(() => {
    const router = discussionRoutes({} as any);
    routes = extractRoutes(router);
  });

  it("POST /companies/:companyId/discussions/inbox exists", () => {
    const found = routes.some(
      (r) => r.method === "POST" && r.path.endsWith("/discussions/inbox"),
    );
    expect(found).toBe(true);
  });

  it("POST /discussions/inbox is distinct from GET /discussions/inbox", () => {
    const getInbox = routes.find(
      (r) => r.method === "GET" && r.path.endsWith("/discussions/inbox"),
    );
    const postInbox = routes.find(
      (r) => r.method === "POST" && r.path.endsWith("/discussions/inbox"),
    );
    expect(getInbox).toBeDefined();
    expect(postInbox).toBeDefined();
    // Both exist as separate registrations.
    expect(getInbox?.method).not.toBe(postInbox?.method);
  });
});

// ── Delegation tests ──────────────────────────────────────────────────────────

describe("paste producer handler — delegates to enqueueInboxItem (Task 0.6)", () => {
  function getPostInboxHandler(db: any) {
    const router = discussionRoutes(db);
    const layer = (router.stack ?? []).find(
      (l: any) =>
        l.route &&
        l.route.methods?.post &&
        typeof l.route.path === "string" &&
        l.route.path.endsWith("/discussions/inbox") &&
        !l.route.path.includes(":itemId"),
    );
    if (!layer) throw new Error("POST /discussions/inbox route not found in router stack");
    return layer.route.stack[layer.route.stack.length - 1].handle as Function;
  }

  async function invokeHandler(
    db: any,
    params: { companyId: string },
    body: object,
    actorId = "u-authed-1",
  ): Promise<{ status: number; body: any }> {
    vi.mocked(authzModule.getActorInfo).mockReturnValue({
      actorType: "user",
      actorId,
      agentId: null,
      runId: null,
    } as any);

    const router = discussionRoutes(db);
    const layer = (router.stack ?? []).find(
      (l: any) =>
        l.route &&
        l.route.methods?.post &&
        typeof l.route.path === "string" &&
        l.route.path.endsWith("/discussions/inbox") &&
        !l.route.path.includes(":itemId"),
    );
    const realHandler = layer!.route.stack[layer!.route.stack.length - 1].handle as Function;

    let responseStatus = 200;
    let responseBody: any = null;

    const req: any = {
      params,
      body,
      actor: {
        type: "board",
        userId: actorId,
        source: "local_implicit",
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
    vi.mocked(inboxProducer.enqueueInboxItem).mockReset();
    vi.mocked(inboxProducer.enqueueInboxItem).mockResolvedValue({
      inboxItemId: "inbox-new-1",
      deduped: false,
    });
    vi.mocked(authzModule.getActorInfo).mockReturnValue({
      actorType: "user",
      actorId: "u1",
      agentId: null,
      runId: null,
    } as any);
  });

  it("calls enqueueInboxItem with originMedium:'paste'", async () => {
    const resp = await invokeHandler(
      {} as any,
      { companyId: "co-1" },
      { rawContent: "pasted text" },
    );

    expect(inboxProducer.enqueueInboxItem).toHaveBeenCalledOnce();
    const [_db, args] = vi.mocked(inboxProducer.enqueueInboxItem).mock.calls[0];
    expect(args.originMedium).toBe("paste");
  });

  it("uses rawContent from request body", async () => {
    await invokeHandler(
      {} as any,
      { companyId: "co-1" },
      { rawContent: "specific pasted content" },
    );

    const [_db, args] = vi.mocked(inboxProducer.enqueueInboxItem).mock.calls[0];
    expect(args.rawContent).toBe("specific pasted content");
  });

  it("uses authed user id as originSource when originSource is not provided", async () => {
    await invokeHandler(
      {} as any,
      { companyId: "co-1" },
      { rawContent: "hello" },
      "authed-user-42",
    );

    const [_db, args] = vi.mocked(inboxProducer.enqueueInboxItem).mock.calls[0];
    expect(args.originSource).toBe("authed-user-42");
  });

  it("uses explicit originSource when provided", async () => {
    await invokeHandler(
      {} as any,
      { companyId: "co-1" },
      { rawContent: "hello", originSource: "explicit-src" },
      "authed-user-42",
    );

    const [_db, args] = vi.mocked(inboxProducer.enqueueInboxItem).mock.calls[0];
    expect(args.originSource).toBe("explicit-src");
  });

  it("passes companyId correctly", async () => {
    await invokeHandler(
      {} as any,
      { companyId: "co-specific-42" },
      { rawContent: "company id test" },
    );

    const [_db, args] = vi.mocked(inboxProducer.enqueueInboxItem).mock.calls[0];
    expect(args.companyId).toBe("co-specific-42");
  });

  it("returns 201 with inboxItemId and deduped fields", async () => {
    vi.mocked(inboxProducer.enqueueInboxItem).mockResolvedValue({
      inboxItemId: "inbox-abc-999",
      deduped: false,
    });

    const resp = await invokeHandler(
      {} as any,
      { companyId: "co-1" },
      { rawContent: "return shape test" },
    );

    expect(resp.status).toBe(201);
    expect(resp.body.inboxItemId).toBe("inbox-abc-999");
    expect(resp.body.deduped).toBe(false);
  });

  it("returns deduped:true when item already existed", async () => {
    vi.mocked(inboxProducer.enqueueInboxItem).mockResolvedValue({
      inboxItemId: "inbox-existing-77",
      deduped: true,
    });

    const resp = await invokeHandler(
      {} as any,
      { companyId: "co-1" },
      { rawContent: "duplicate content" },
    );

    expect(resp.status).toBe(201);
    expect(resp.body.deduped).toBe(true);
    expect(resp.body.inboxItemId).toBe("inbox-existing-77");
  });

  it("400 when rawContent is missing", async () => {
    const resp = await invokeHandler(
      {} as any,
      { companyId: "co-1" },
      {},
    );

    expect(resp.status).toBe(400);
    expect(inboxProducer.enqueueInboxItem).not.toHaveBeenCalled();
  });

  it("RBAC: assertHumanRole is called with founder and team_lead", async () => {
    await invokeHandler(
      {} as any,
      { companyId: "co-rbac-check" },
      { rawContent: "rbac test" },
    );

    expect(vi.mocked(rbacModule.assertHumanRole)).toHaveBeenCalledWith(
      expect.anything(), // db
      expect.anything(), // req
      "co-rbac-check",   // companyId
      "founder",
      "team_lead",
    );
  });
});
