/**
 * Contract tests for thread lifecycle routes.
 *
 * These tests verify that all 6 new thread endpoints exist in the
 * discussionRoutes factory by inspecting the router's route layer stack.
 * They do not spin up a real server or database.
 *
 * Endpoints under test (all scoped under /companies/:companyId/discussions/:discussionId):
 *   PATCH  …/phase           — advance thread phase
 *   POST   …/claim           — claim an unclaimed thread
 *   POST   …/transfer        — transfer ownership
 *   POST   …/participants    — add participant
 *   POST   …/promote-to-goal — promote thread to goal
 *   POST   …/assign          — assign scope items to tasks
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// ── Mocks required by the route module and its imports ───────────────────────

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
  assertDepartmentAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn().mockReturnValue({ actorType: "user", actorId: "u1", agentId: null }),
}));

vi.mock("../redaction.js", () => ({
  sanitizeRecord: vi.fn((r: any) => r),
}));

// ── Import the router factory ─────────────────────────────────────────────────

import { discussionRoutes } from "../routes/discussions.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract all routes from an Express Router layer stack */
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

describe("thread lifecycle route contracts", () => {
  let routes: Array<{ method: string; path: string }>;

  beforeAll(() => {
    const mockDb = {} as any;
    const router = discussionRoutes(mockDb);
    routes = extractRoutes(router);
  });

  function hasRoute(method: string, pathSuffix: string): boolean {
    return routes.some(
      (r) =>
        r.method === method &&
        r.path.endsWith(pathSuffix),
    );
  }

  it("PATCH …/discussions/:discussionId/phase exists", () => {
    expect(hasRoute("PATCH", "/discussions/:discussionId/phase")).toBe(true);
  });

  it("POST …/discussions/:discussionId/claim exists", () => {
    expect(hasRoute("POST", "/discussions/:discussionId/claim")).toBe(true);
  });

  it("POST …/discussions/:discussionId/transfer exists", () => {
    expect(hasRoute("POST", "/discussions/:discussionId/transfer")).toBe(true);
  });

  it("POST …/discussions/:discussionId/participants exists", () => {
    expect(hasRoute("POST", "/discussions/:discussionId/participants")).toBe(true);
  });

  it("POST …/discussions/:discussionId/promote-to-goal exists", () => {
    expect(hasRoute("POST", "/discussions/:discussionId/promote-to-goal")).toBe(true);
  });

  it("POST …/discussions/:discussionId/assign exists", () => {
    expect(hasRoute("POST", "/discussions/:discussionId/assign")).toBe(true);
  });

  it("total thread lifecycle routes count is 6", () => {
    const threadRoutes = routes.filter((r) =>
      ["/phase", "/claim", "/transfer", "/participants", "/promote-to-goal", "/assign"].some(
        (suffix) => r.path.endsWith(suffix),
      ),
    );
    expect(threadRoutes.length).toBe(6);
  });
});
