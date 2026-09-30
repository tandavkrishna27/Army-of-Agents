import { describe, it, expect, vi, beforeAll } from "vitest";
import { nextSeq } from "../services/threads.js";

// Plan 7 Task 3: per-thread monotonic seq + catch-up endpoint.
describe("nextSeq", () => {
  it("increments from the current max (0-based start)", () => {
    expect(nextSeq(null)).toBe(1);
    expect(nextSeq(0)).toBe(1);
    expect(nextSeq(7)).toBe(8);
  });
});

// ── Route contract: GET …/discussions/:id/entries?sinceSeq=N ─────────────────
// Mirrors threads-routes-contract.test.ts: inspect the router layer stack
// without spinning up a server or DB.

vi.mock("drizzle-orm", () => {
  const SQL_STUB: any = { as: () => SQL_STUB, join: () => SQL_STUB, raw: () => SQL_STUB, toString: () => "sql" };
  const sqlFn = Object.assign((..._a: any[]) => SQL_STUB, { join: () => SQL_STUB, raw: () => SQL_STUB });
  const sql = new Proxy(sqlFn, { get: (t: any, p: any) => (p in t ? t[p] : () => SQL_STUB), apply: () => SQL_STUB });
  return {
    and: vi.fn((...args: any[]) => args),
    eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
    gt: vi.fn((a: any, b: any) => ({ gt: [a, b] })),
    asc: vi.fn((col: any) => ({ asc: col })),
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
    entriesSince: vi.fn().mockResolvedValue([]),
  })),
  logActivity: vi.fn().mockResolvedValue(undefined),
  permissionService: vi.fn(() => ({
    getEffectiveRole: vi.fn().mockResolvedValue("founder"),
  })),
}));

vi.mock("../services/threads.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/threads.js")>();
  return {
    ...actual,
    threadService: vi.fn(() => ({
      getById: vi.fn().mockResolvedValue({ id: "t1" }),
      entriesSince: vi.fn().mockResolvedValue([]),
    })),
  };
});

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

import { discussionRoutes } from "../routes/discussions.js";

function extractRoutes(router: any): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  for (const layer of (router.stack ?? []) as any[]) {
    if (layer.route) {
      const path = layer.route.path as string;
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ method: method.toUpperCase(), path });
      }
    }
  }
  return routes;
}

describe("catch-up route contract", () => {
  let routes: Array<{ method: string; path: string }>;
  beforeAll(() => {
    routes = extractRoutes(discussionRoutes({} as any));
  });

  it("GET …/discussions/:discussionId/entries exists (catch-up by sinceSeq)", () => {
    const has = routes.some(
      (r) => r.method === "GET" && r.path.endsWith("/discussions/:discussionId/entries"),
    );
    expect(has).toBe(true);
  });
});
