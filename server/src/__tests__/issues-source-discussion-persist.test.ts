/**
 * P1-T1 — Contract: `issues.create()` must persist `sourceDiscussionId`.
 *
 * The field exists in `packages/db/src/schema/issues.ts` (FK → discussions,
 * ON DELETE SET NULL).  `create()` spreads its input into `issueInsertData` and
 * then explicitly deletes the three workspace fields before the INSERT.
 * `sourceDiscussionId` must NOT be in that delete list.
 *
 * Two complementary tests:
 *  1. Source-level contract — reads the service source and asserts
 *     `sourceDiscussionId` is never passed to `delete`.
 *  2. Behaviour test — builds a minimal stub db, calls
 *     `issueService(db).create(…)` with `sourceDiscussionId` set, and
 *     verifies the value reaches `db.insert().values()`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const createIssueContextBundleSpy = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "bundle-1" }));

vi.mock("../services/agent-completion-policy.js", () => ({
  resolveAgentCompletionPolicy: vi.fn().mockResolvedValue({
    policy: "review_required",
    source: "company",
    sourceId: "company-1",
    guardrailApplied: false,
    resolvedAt: new Date("2026-07-11T00:00:00.000Z"),
  }),
}));

// ─── 1. Source-level contract (no mocks needed) ────────────────────────────────

describe("issues.ts source contract — sourceDiscussionId is not stripped before INSERT", () => {
  it("does not delete sourceDiscussionId from issueInsertData", () => {
    const src = readFileSync(
      resolve(
        import.meta.dirname ?? __dirname,
        "../services/issues.ts",
      ),
      "utf8",
    );

    // The service explicitly deletes three workspace fields before INSERT.
    // Any future accidental addition of sourceDiscussionId to that block
    // would break the contract.
    expect(src).not.toMatch(/delete issueInsertData\.sourceDiscussionId/);
  });

  it("references sourceDiscussionId via the $inferInsert spread (Omit type)", () => {
    const src = readFileSync(
      resolve(
        import.meta.dirname ?? __dirname,
        "../services/issues.ts",
      ),
      "utf8",
    );

    // The create() signature uses Omit<typeof issues.$inferInsert, "companyId">
    // which includes sourceDiscussionId automatically.
    expect(src).toMatch(/Omit<typeof issues\.\$inferInsert/);
  });
});

// ─── 2. Behaviour test — db stub captures the values passed to INSERT ─────────

// Heavy mocks needed for imports that pull in drizzle internals.

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => ({ and: args })),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  inArray: vi.fn((col: any, vals: any) => ({ inArray: [col, vals] })),
  isNotNull: vi.fn((col: any) => ({ isNotNull: col })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
  or: vi.fn((...args: any[]) => ({ or: args })),
  desc: vi.fn((col: any) => ({ desc: col })),
  asc: vi.fn((col: any) => ({ asc: col })),
  sql: Object.assign(
    vi.fn((_s: any) => {
      const tag: any = { as: vi.fn().mockReturnThis(), mapWith: vi.fn().mockReturnThis() };
      return tag;
    }),
    {
      raw: vi.fn((s: any) => s),
      placeholder: vi.fn((s: any) => s),
    },
  ),
}));

// Proxy-based table stub — every column access returns a stable string key.
function tableProxy(name: string) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        return `${name}_${String(prop)}`;
      },
    },
  );
}

vi.mock("@armyofagents/db", () => ({
  issues: tableProxy("issues"),
  companies: tableProxy("companies"),
  discussions: tableProxy("discussions"),
  agents: tableProxy("agents"),
  agentWakeupRequests: tableProxy("awr"),
  companyMemberships: tableProxy("cm"),
  activityLog: tableProxy("al"),
  assets: tableProxy("assets"),
  authUsers: tableProxy("au"),
  executionWorkspaces: tableProxy("ew"),
  goals: tableProxy("goals"),
  heartbeatRuns: tableProxy("hr"),
  issueAttachments: tableProxy("ia"),
  issueLabels: tableProxy("il"),
  issueComments: tableProxy("ic"),
  issueMonitors: tableProxy("im"),
  issueReadStates: tableProxy("irs"),
  labels: tableProxy("labels"),
  projectWorkspaces: tableProxy("pw"),
  projects: tableProxy("projects"),
  taskDependencies: tableProxy("td"),
  userRoles: tableProxy("ur"),
  // Additional tables pulled in transitively
  memoryItems: tableProxy("mi"),
  discussionExtractedItems: tableProxy("dei"),
  artifacts: tableProxy("art"),
  artifactVersions: tableProxy("av"),
  instanceSettings: tableProxy("is"),
  instanceExperimentalSettings: tableProxy("ies"),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: false }),
  })),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/issue-context-bundles.js", () => ({
  createIssueContextBundle: createIssueContextBundleSpy,
}));

vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => Object.assign(new Error(msg), { status: 400 }),
  notFound: (msg: string) => Object.assign(new Error(msg), { status: 404 }),
  unprocessable: (msg: string) => Object.assign(new Error(msg), { status: 422 }),
  forbidden: (msg: string) => Object.assign(new Error(msg), { status: 403 }),
}));

import { issueService } from "../services/issues.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID  = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID    = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/**
 * Build a minimal stub db that:
 *  - runs transactions inline
 *  - returns a fake company row from every `update(...).set(...).where(...).returning()`
 *  - captures whatever is passed to `insert(...).values(...)` for assertion
 *  - returns an empty array from every `select(…)`
 */
function makeDb() {
  let capturedInsertValues: Record<string, unknown> | null = null;

  const db: any = {
    transaction: vi.fn((fn: (tx: any) => Promise<any>) => fn(db)),
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) => Promise.resolve(fn([]))),
    })),
    update: vi.fn(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([
        { issueCounter: 1, issuePrefix: "TASK" },
      ]),
    })),
    insert: vi.fn((_table: any) => ({
      values: vi.fn((vals: Record<string, unknown>) => {
        capturedInsertValues = vals;
        return {
          returning: vi.fn().mockResolvedValue([
            {
              ...vals,
              id: "new-issue-id",
              identifier: "TASK-1",
              issueNumber: 1,
              labels: [],
            },
          ]),
          onConflictDoNothing: vi.fn().mockReturnThis(),
          onConflictDoUpdate: vi.fn().mockReturnThis(),
        };
      }),
    })),
    getCaptured: () => capturedInsertValues,
  };

  return db;
}

describe("issueService.create — sourceDiscussionId flows through to INSERT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists sourceDiscussionId on the row when provided", async () => {
    const db = makeDb();
    const svc = issueService(db);

    await svc.create(COMPANY_ID, {
      title: "Deliverable task from thread",
      status: "todo",
      sourceDiscussionId: THREAD_ID,
      createdByUserId: USER_ID,
    } as any);

    const captured = db.getCaptured();
    expect(captured).not.toBeNull();
    expect(captured).toMatchObject({ sourceDiscussionId: THREAD_ID });
  });

  it("leaves sourceDiscussionId absent (falsy) when caller omits it", async () => {
    const db = makeDb();
    const svc = issueService(db);

    await svc.create(COMPANY_ID, {
      title: "Plain task without thread",
      status: "todo",
      createdByUserId: USER_ID,
    } as any);

    const captured = db.getCaptured();
    expect(captured).not.toBeNull();
    expect(captured?.sourceDiscussionId ?? null).toBeNull();
  });

  it("forwards discussion-origin context bundle fields when creating the task", async () => {
    const db = makeDb();
    const svc = issueService(db);

    await svc.create(COMPANY_ID, {
      title: "Task with accepted scope handoff",
      status: "todo",
      createdByUserId: USER_ID,
      contextBundle: {
        sourceDiscussionId: THREAD_ID,
        sourceScopeVersionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        sourceScopeItemId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        sourceKind: "discussion_scope",
        brief: "Use selected scope evidence.",
        items: [
          { type: "discussion_entry", id: "ffffffff-ffff-4fff-8fff-ffffffffffff", label: "Founder request" },
          { type: "url", label: "Reference", metadata: { url: "https://example.com/ref" } },
        ],
      },
    } as any);

    expect(createIssueContextBundleSpy).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        companyId: COMPANY_ID,
        sourceIssueId: null,
        sourceDiscussionId: THREAD_ID,
        sourceScopeVersionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        sourceScopeItemId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        sourceKind: "discussion_scope",
        targetIssueId: "new-issue-id",
        brief: "Use selected scope evidence.",
        items: expect.arrayContaining([
          expect.objectContaining({ type: "discussion_entry", label: "Founder request" }),
          expect.objectContaining({ type: "url", label: "Reference" }),
        ]),
      }),
    );
  });
});
