import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

// Slice 8 / Task 8.3: contract tests for the new teamImportsRoutes(db) factory.
//
// Verifies the factory shape and that BOTH routes (preview + install) are
// registered at the expected paths. Handler behaviour (parse, collision
// detection, transactional cascade) is exercised by the service tests in
// team-import-{preview,install}-*.test.ts -- this contract test is just the
// route-table check.
//
// Dynamic import for parity with `teams-routes-contract.test.ts` (heavy
// transitive module graph + Drizzle ESM cycle).
vi.setConfig({ testTimeout: 15000 });

import { vi } from "vitest";

describe("teamImportsRoutes -- conformance + contract", () => {
  it("exports a factory function (not a top-level Router)", async () => {
    const mod = await import("../routes/team-imports.js");
    expect(typeof mod.teamImportsRoutes).toBe("function");
    expect(mod.teamImportsRoutes.length).toBe(1); // accepts (db) param
  });

  it("returns an Express Router when called with db", async () => {
    const { teamImportsRoutes } = await import("../routes/team-imports.js");
    const fakeDb = {} as unknown as never;
    const router = teamImportsRoutes(fakeDb);
    expect(router).toBeDefined();
    expect(typeof router).toBe("function"); // Express Routers are functions
    expect((router as unknown as { stack: unknown[] }).stack).toBeInstanceOf(Array);
  });

  it("registers both /_imports/preview and /_imports/install POST routes", async () => {
    const { teamImportsRoutes } = await import("../routes/team-imports.js");
    const fakeDb = {} as unknown as never;
    const router = teamImportsRoutes(fakeDb);
    const stack = (router as unknown as {
      stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
    }).stack;
    const paths = stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route?.path);
    expect(paths).toContain("/companies/:companyId/teams/_imports/preview");
    expect(paths).toContain("/companies/:companyId/teams/_imports/install");
    // Both are POST.
    for (const layer of stack) {
      if (!layer.route) continue;
      expect(layer.route.methods?.post).toBe(true);
    }
  });
});

// L12 (comprehensive-review fixup): behavioural backstop for the install
// route's log-line shape parity. Same harness pattern as
// `teams-routes-rbac.test.ts` -- mocks the import service + RBAC helpers,
// mounts a real Express app via the factory, drives one HTTP request.

const mockImportService = vi.hoisted(() => ({
  preview: vi.fn().mockResolvedValue({ summary: "ok", warnings: [], teams: [] }),
  install: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  teamImportService: () => mockImportService,
  logActivity: mockLogActivity,
}));

const mockAssertRole = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAssertDepartmentAccess = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);

vi.mock("../middleware/rbac.js", () => ({
  assertRole: mockAssertRole,
  assertHumanRole: mockAssertRole,
  assertDepartmentAccess: mockAssertDepartmentAccess,
}));

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const DEPT_A = "33333333-3333-4333-8333-333333333333";

async function createApp() {
  const { teamImportsRoutes } = await import("../routes/team-imports.js");
  const { errorHandler } = await import("../middleware/index.js");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "u1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", teamImportsRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("teamImportsRoutes -- install route defensive parity (L12)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("install route is robust when service returns object without warnings (L12 backstop)", async () => {
    // L12: Phase 4 caught a regression where the install route's log line
    // accessed team.warnings.length without optional chaining, while the
    // response body used team.warnings ?? [] defensively. If a future
    // service change (or test mock drift) returns an object without the
    // warnings field, the log line should NOT throw before the response
    // is sent -- same shape as the regression that broke
    // teams-routes-rbac.test.ts:341.
    mockImportService.install.mockResolvedValueOnce({
      id: "t-1",
      slug: "team-1",
      name: "Team 1",
      parentProjectId: DEPT_A,
      // Note: deliberately NO `warnings` field
    } as never);

    const app = await createApp();
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/teams/_imports/install`)
      .send({
        yamlContent: "schemaVersion: '1.0'\n",
        collisions: {},
        parentProjectId: DEPT_A,
      });

    // Must not be 500. Pre-fix: TypeError reading undefined.length -> 500.
    // Post-fix: log line uses warnings?.length ?? 0 -> 201 with response
    // body still containing warnings: [] from the route's `?? []` default.
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings).toEqual([]);
  });
});
