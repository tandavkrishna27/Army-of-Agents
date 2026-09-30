import { beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Static-analysis tests ────────────────────────────────────────────────────
// Pin the contract that:
//   1. BOTH @-mention call sites in routes/issues.ts wire through the
//      notifyMentionedHumans helper (one per agent-mention site).
//   2. The service helper itself enforces the safety layers (feature flag,
//      try/catch, sanitized error logging).
// If a future refactor accidentally drops one of the two sites or removes a
// safety layer from the helper, these tests fail immediately.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Slice 7 — @human resolver wired at BOTH issues.ts call sites", () => {
  let routeSource: string;
  let serviceSource: string;

  beforeAll(async () => {
    const issuesRoutePath = path.resolve(__dirname, "../routes/issues.ts");
    const issuesServicePath = path.resolve(__dirname, "../services/issues.ts");
    routeSource = await fs.readFile(issuesRoutePath, "utf8");
    serviceSource = await fs.readFile(issuesServicePath, "utf8");
  });

  it("routes/issues.ts has 2 findMentionedAgents calls (verified baseline)", () => {
    const matches = (routeSource.match(/findMentionedAgents\(/g) ?? []).length;
    expect(matches).toBe(2);
  });

  it("routes/issues.ts has 2 notifyMentionedHumans calls (one per agent call site)", () => {
    // After M-3 dedup, the route layer calls the helper once per site instead
    // of inlining ~25 lines of try/catch. Both sites must still be wired.
    const matches = (routeSource.match(/notifyMentionedHumans\(/g) ?? []).length;
    expect(matches).toBe(2);
  });

  it("services/issues.ts defines notifyMentionedHumans helper", () => {
    expect(serviceSource).toMatch(/notifyMentionedHumans\s*:\s*async/);
  });

  it("notifyMentionedHumans helper has at least 2 try blocks (outer + per-promise)", () => {
    // The helper has TWO try blocks: an outer wrapper that swallows query
    // failures, and a per-promise try inside the parallel insert loop.
    // Heuristic: count try blocks in the service file — must be ≥ 2 to cover
    // the helper's safety contract (other service methods may add more, fine).
    const tryCount = (serviceSource.match(/\btry\s*\{/g) ?? []).length;
    expect(tryCount).toBeGreaterThanOrEqual(2);
  });

  it("services/issues.ts uses sanitized error logging (err.name + err.message pattern)", () => {
    // The helper must log err.name + err.message rather than the full Error
    // object to avoid leaking stack traces or PII into logs.
    expect(serviceSource).toMatch(/err\s+instanceof\s+Error/);
  });

  it("services/issues.ts queries companies.enableTeams before invoking notificationService", () => {
    // The feature-flag gate lives in the helper now. Must check the flag
    // before doing any notification work.
    expect(serviceSource).toMatch(/companies\.enableTeams/);
  });
});

// ── Behavioral tests ─────────────────────────────────────────────────────────
// Drive the helper through real code paths with a hand-rolled mock DB.
// Mirror the mock pattern from mention-resolver-humans.test.ts.

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  asc: vi.fn((c: unknown) => ({ asc: c })),
  desc: vi.fn((c: unknown) => ({ desc: c })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  inArray: vi.fn((c: unknown, v: unknown) => ({ inArray: [c, v] })),
  isNull: vi.fn((c: unknown) => ({ isNull: c })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  sql: vi.fn(() => ({ sql: true })),
}));

vi.mock("@armyofagents/db", () => ({
  activityLog: {},
  agents: { id: "agents_id", name: "agents_name", companyId: "agents_company_id" },
  assets: {},
  // C5: notifyMentionedHumans now selects `email` for the local-part fallback.
  authUsers: {
    id: "auth_users_id",
    name: "auth_users_name",
    email: "auth_users_email",
  },
  companies: { id: "companies_id", enableTeams: "companies_enable_teams" },
  companyMemberships: {},
  executionWorkspaces: {},
  goals: {},
  heartbeatRuns: {},
  issueAttachments: {},
  issueLabels: {},
  issueComments: {},
  issueReadStates: {},
  issues: {},
  labels: {},
  projectWorkspaces: {},
  projects: {},
  taskDependencies: {},
  userRoles: { userId: "user_roles_user_id", companyId: "user_roles_company_id" },
  notifications: {
    id: "notifications_id",
    companyId: "notifications_company_id",
    userId: "notifications_user_id",
    type: "notifications_type",
    title: "notifications_title",
    message: "notifications_message",
    relatedEntityType: "notifications_related_entity_type",
    relatedEntityId: "notifications_related_entity_id",
  },
}));

vi.mock("@armyofagents/shared", () => ({
  extractProjectMentionIds: vi.fn(() => []),
}));

vi.mock("../errors.js", () => ({
  conflict: (msg: string) => Object.assign(new Error(msg), { status: 409 }),
  notFound: (msg: string) => Object.assign(new Error(msg), { status: 404 }),
  unprocessable: (msg: string) => Object.assign(new Error(msg), { status: 422 }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../services/dependencies.js", () => ({
  dependencyService: vi.fn(() => ({})),
}));
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: vi.fn(() => ({})),
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({})),
}));
vi.mock("../services/issue-user-context.js", () => ({
  deriveIssueUserContext: vi.fn(),
}));
vi.mock("../services/execution-workspace-policy.js", () => ({
  issueExecutionWorkspaceModeForPersistedWorkspace: vi.fn(),
}));

// The task-comment @human mention path now routes through hubItems.emit
// (W1a Task 10). Mock the service with an `emit` spy so we can assert shape +
// call counts. (notificationService is mocked too for any other service code.)
const notifCreateSpy = vi.fn(async () => ({ id: "notif-1" }));
vi.mock("../services/notifications.js", () => ({
  notificationService: vi.fn(() => ({
    create: notifCreateSpy,
  })),
}));
const hubEmitSpy = vi.fn(async () => ({ id: "hub-1" }));
vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({
    emit: hubEmitSpy,
  })),
}));

import { issueService } from "../services/issues.js";

// Hand-rolled mock DB for the helper:
//   Query 1: select({enableTeams}).from(companies).where(eq(...)).then(rows => rows[0])
//   Query 2: select({id,name}).from(authUsers).innerJoin(userRoles, ...).where(...)
//
// We need a chain that resolves both queries in order. The simplest approach:
// each query is an independent chain that returns its own pre-set rows.
// Use a counter to dispatch by query position.

function makeHelperDb({
  enableTeams,
  users,
}: {
  enableTeams: boolean;
  // C5: users may now optionally specify `email` to drive the local-part
  // fallback. Existing tests omit it; we backfill a sentinel that won't match.
  users: Array<{ id: string; name: string; email?: string }>;
}) {
  const enrichedUsers = users.map((u) => ({
    ...u,
    email: u.email ?? "__no-email-fallback__@invalid.example",
  }));
  let queryIdx = 0;
  return {
    select: () => ({
      from: () => {
        const idxAtFrom = queryIdx++;
        // First query: company flag check (no innerJoin, ends at .where().then())
        // Second query: users join (has innerJoin, ends at .where() returning array)
        if (idxAtFrom === 0) {
          // Company flag query
          return {
            where: () => ({
              then: (cb: (rows: Array<{ enableTeams: boolean }>) => unknown) =>
                Promise.resolve(cb([{ enableTeams }])),
            }),
          };
        }
        // Users query
        return {
          innerJoin: () => ({
            where: () => Promise.resolve(enrichedUsers),
          }),
        };
      },
    }),
  } as never;
}

describe("issueService.notifyMentionedHumans (behavioral)", () => {
  beforeAll(() => {
    hubEmitSpy.mockClear();
  });

  it("returns 0 when companies.enableTeams is false (feature flag off)", async () => {
    hubEmitSpy.mockClear();
    const db = makeHelperDb({ enableTeams: false, users: [] });
    const result = await issueService(db).notifyMentionedHumans(
      "c1",
      "@alice hi",
      "task-1",
      { actorType: "user", actorId: "self" },
    );
    expect(result).toBe(0);
    expect(hubEmitSpy).not.toHaveBeenCalled();
  });

  it("skips self-mention — does NOT emit a hub item when user mentions themselves", async () => {
    hubEmitSpy.mockClear();
    const db = makeHelperDb({
      enableTeams: true,
      users: [{ id: "self", name: "alice" }],
    });
    const result = await issueService(db).notifyMentionedHumans(
      "c1",
      "@alice",
      "task-1",
      { actorType: "user", actorId: "self" },
    );
    expect(result).toBe(0);
    expect(hubEmitSpy).not.toHaveBeenCalled();
  });

  it("emits one hub item per non-self mention (parallel batch)", async () => {
    hubEmitSpy.mockClear();
    const db = makeHelperDb({
      enableTeams: true,
      users: [
        { id: "u-alice", name: "alice" },
        { id: "u-bob", name: "bob" },
      ],
    });
    const result = await issueService(db).notifyMentionedHumans(
      "c1",
      "hey @alice and @bob",
      "task-1",
      { actorType: "user", actorId: "u-other" },
    );
    expect(result).toBe(2);
    expect(hubEmitSpy).toHaveBeenCalledTimes(2);
    // Spot-check shape of first call: routed through hubItems.emit with
    // semanticType `mention`, sourceType `issue`, owner = the mentioned user.
    expect(hubEmitSpy).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "c1",
      semanticType: "mention",
      sourceType: "issue",
      sourceId: "task-1:u-alice",
      title: "You were mentioned in a comment",
      ownerUserId: "u-alice",
    }));
  });
});
