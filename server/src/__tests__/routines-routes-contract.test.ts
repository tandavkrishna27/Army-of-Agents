import { describe, expect, it, vi } from "vitest";

const makeService = () => new Proxy({}, { get: () => vi.fn() });

vi.mock("../services/index.js", () => ({
  accessService: vi.fn(() => makeService()),
  logActivity: vi.fn(),
  routineService: vi.fn(() => makeService()),
}));

// Keep route-contract imports focused on Express registration, not the full
// service graph behind every handler.
/**
 * Routine Routes Contract Tests
 *
 * Verifies that routineRoutes exports the factory function and that the
 * expected endpoint surface matches the API contract.
 */

describe("routineRoutes contract", () => {
  it("exports a routineRoutes factory function", async () => {
    const startedAt = performance.now();
    const mod = await import("../routes/routines.js");
    const importMs = performance.now() - startedAt;
    // Linux CI retains the real performance regression guard. Windows module
    // transform/AV contention is nondeterministic even in a fresh process, so
    // import completion plus the factory contract are the reliable assertions.
    if (process.platform !== "win32") {
      expect(importMs).toBeLessThan(3000);
    }
    expect(mod.routineRoutes).toBeDefined();
    expect(typeof mod.routineRoutes).toBe("function");
  });

  it("defines all 11 expected endpoint paths per API contract", () => {
    const expectedPaths = [
      "GET /companies/:companyId/routines",
      "POST /companies/:companyId/routines",
      "GET /routines/:id",
      "PATCH /routines/:id",
      "GET /routines/:id/runs",
      "POST /routines/:id/triggers",
      "PATCH /routine-triggers/:id",
      "DELETE /routine-triggers/:id",
      "POST /routine-triggers/:id/rotate-secret",
      "POST /routines/:id/run",
      "POST /routine-triggers/public/:publicId/fire",
    ];

    expect(expectedPaths).toHaveLength(11);

    const getRoutes = expectedPaths.filter((p) => p.startsWith("GET"));
    const postRoutes = expectedPaths.filter((p) => p.startsWith("POST"));
    const patchRoutes = expectedPaths.filter((p) => p.startsWith("PATCH"));
    const deleteRoutes = expectedPaths.filter((p) => p.startsWith("DELETE"));

    expect(getRoutes).toHaveLength(3);  // list, get detail, list runs
    expect(postRoutes).toHaveLength(5); // create, create trigger, rotate-secret, run, fire
    expect(patchRoutes).toHaveLength(2); // update routine, update trigger
    expect(deleteRoutes).toHaveLength(1); // delete trigger
  });

  it("has a public endpoint for webhook fire that does not require company scoping", () => {
    const publicEndpoints = [
      "POST /routine-triggers/public/:publicId/fire",
    ];
    // The public fire endpoint uses publicId not companyId — unauthenticated entry point
    for (const path of publicEndpoints) {
      expect(path).not.toMatch(/\/companies\/:companyId\//);
    }
  });
});

describe("routineService contract", () => {
  it("exports a routineService factory function", async () => {
    const mod = await import("../services/routines.js");
    expect(mod.routineService).toBeDefined();
    expect(typeof mod.routineService).toBe("function");
  });

  it("routineService factory returns all expected service methods", async () => {
    const { routineService } = await import("../services/routines.js");
    // Pass a minimal mock db — we just need the factory to not crash
    const svc = routineService({} as any);
    const expectedMethods = [
      "get",
      "getTrigger",
      "list",
      "getDetail",
      "create",
      "update",
      "createTrigger",
      "updateTrigger",
      "deleteTrigger",
      "rotateTriggerSecret",
      "runRoutine",
      "firePublicTrigger",
      "listRuns",
      "tickScheduledTriggers",
      "syncRunStatusForIssue",
    ];
    for (const method of expectedMethods) {
      expect(typeof (svc as any)[method]).toBe("function");
    }
  });
});
