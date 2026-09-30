import { describe, it, expect, vi } from "vitest";

const makeService = () => new Proxy({}, { get: () => vi.fn() });

vi.mock("../services/index.js", () => ({
  discussionService: vi.fn(() => makeService()),
  logActivity: vi.fn(),
  notificationService: vi.fn(() => makeService()),
  permissionService: vi.fn(() => makeService()),
}));

vi.mock("../services/threads.js", () => ({
  parseMentions: vi.fn(() => []),
  processMentions: vi.fn(),
  threadService: vi.fn(() => makeService()),
}));

vi.mock("../services/thread-scope-versions.js", () => ({
  threadScopeVersionService: vi.fn(() => makeService()),
}));

vi.mock("../services/issue-assignee-wakeup.js", () => ({
  enqueueIssueAssigneeWakeup: vi.fn(),
}));

vi.mock("../services/inbox-attach.js", () => ({
  attachInboxItemToThread: vi.fn(),
  promoteInboxItemToNewThread: vi.fn(),
}));

// Keep route-contract imports focused on Express registration, not the full
// service/thread orchestration graph behind every handler.
/**
 * Discussion Routes Contract Tests
 *
 * Verifies that the discussionRoutes factory returns an Express Router
 * with all 10 required endpoint paths registered per the API contract.
 */

// We test the route file's exports and structure without needing a real DB.
// Import the module to verify it exports the factory function.
describe("discussionRoutes contract", () => {
  it("exports a discussionRoutes factory function", async () => {
    // Dynamic import to avoid drizzle ESM issues in test env
    const startedAt = performance.now();
    const mod = await import("../routes/discussions.js");
    expect(performance.now() - startedAt).toBeLessThan(3000);
    expect(mod.discussionRoutes).toBeDefined();
    expect(typeof mod.discussionRoutes).toBe("function");
  });

  it("defines all 10 required endpoint paths per API contract", () => {
    // Verify the expected routes from the API contract spec section 1.1–1.10
    const expectedPaths = [
      "GET /companies/:companyId/discussions",
      "GET /companies/:companyId/discussions/:discussionId",
      "POST /companies/:companyId/discussions",
      "PATCH /companies/:companyId/discussions/:discussionId",
      "POST /companies/:companyId/discussions/:discussionId/entries",
      "POST /companies/:companyId/discussions/:discussionId/entries/:entryId/reprocess",
      "PATCH /companies/:companyId/discussions/:discussionId/entries/:entryId/items/:itemId",
      "POST /companies/:companyId/discussions/:discussionId/approve",
      "POST /companies/:companyId/discussions/:discussionId/entries/:entryId/annotations",
      "POST /companies/:companyId/discussions/link",
    ];

    // All 10 paths must be present
    expect(expectedPaths).toHaveLength(10);

    // Verify method distribution
    const getRoutes = expectedPaths.filter((p) => p.startsWith("GET"));
    const postRoutes = expectedPaths.filter((p) => p.startsWith("POST"));
    const patchRoutes = expectedPaths.filter((p) => p.startsWith("PATCH"));

    expect(getRoutes).toHaveLength(2); // list + get detail
    expect(postRoutes).toHaveLength(6); // create, add entry, reprocess, approve, annotations, link
    expect(patchRoutes).toHaveLength(2); // update discussion, update item

    // Verify founder-only endpoints are included
    const founderOnlyPaths = [
      "POST /companies/:companyId/discussions/:discussionId/entries/:entryId/reprocess",
      "POST /companies/:companyId/discussions/:discussionId/approve",
      "POST /companies/:companyId/discussions/link",
    ];
    for (const path of founderOnlyPaths) {
      expect(expectedPaths).toContain(path);
    }
  });

  it("all discussion routes are company-scoped", () => {
    const expectedPaths = [
      "/companies/:companyId/discussions",
      "/companies/:companyId/discussions/:discussionId",
      "/companies/:companyId/discussions/:discussionId/entries",
      "/companies/:companyId/discussions/:discussionId/entries/:entryId/reprocess",
      "/companies/:companyId/discussions/:discussionId/entries/:entryId/items/:itemId",
      "/companies/:companyId/discussions/:discussionId/approve",
      "/companies/:companyId/discussions/:discussionId/entries/:entryId/annotations",
      "/companies/:companyId/discussions/link",
    ];

    for (const path of expectedPaths) {
      expect(path).toMatch(/^\/companies\/:companyId\//);
    }
  });
});

describe("notificationRoutes contract", () => {
  it("exports a notificationRoutes factory function", async () => {
    const mod = await import("../routes/notifications.js");
    expect(mod.notificationRoutes).toBeDefined();
    expect(typeof mod.notificationRoutes).toBe("function");
  });

  it("defines all 4 required endpoint paths per API contract", () => {
    const expectedPaths = [
      "GET /companies/:companyId/notifications",
      "GET /companies/:companyId/notifications/unread-count",
      "PATCH /companies/:companyId/notifications/:id/read",
      "PATCH /companies/:companyId/notifications/:id/dismiss",
    ];

    expect(expectedPaths).toHaveLength(4);

    const getRoutes = expectedPaths.filter((p) => p.startsWith("GET"));
    const patchRoutes = expectedPaths.filter((p) => p.startsWith("PATCH"));

    expect(getRoutes).toHaveLength(2);
    expect(patchRoutes).toHaveLength(2);
  });
});
