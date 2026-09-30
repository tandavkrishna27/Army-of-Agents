import { describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

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
  // Tables accessed by issues.ts — stubs are sufficient because the mock DB
  // intercepts all method calls before drizzle interacts with them.
  activityLog: {},
  agents: { id: "agents_id", name: "agents_name", companyId: "agents_company_id" },
  assets: {},
  // C5: email column is now selected by findMentionedHumans for the
  // local-part fallback. The stub key is sufficient because the mock DB
  // intercepts the chain before drizzle reads it.
  authUsers: {
    id: "auth_users_id",
    name: "auth_users_name",
    email: "auth_users_email",
  },
  companies: {},
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
}));

vi.mock("@armyofagents/shared", () => ({
  extractProjectMentionIds: vi.fn(() => []),
}));

vi.mock("../errors.js", () => ({
  conflict: (msg: string) => Object.assign(new Error(msg), { status: 409 }),
  notFound: (msg: string) => Object.assign(new Error(msg), { status: 404 }),
  unprocessable: (msg: string) => Object.assign(new Error(msg), { status: 422 }),
}));

// issues.ts now imports hub-items.ts (W1a Task 10). Mock it so the real module
// (and its @armyofagents/shared imports) never load — this suite only tests the
// pure findMentionedHumans resolver, not the emit path.
vi.mock("../services/hub-items.js", () => ({
  hubItemsService: vi.fn(() => ({ emit: vi.fn() })),
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

import { issueService } from "../services/issues.js";

// ── Hand-rolled mock DB for innerJoin chain ──────────────────────────────────
//
// The query path is:
//   db.select({...}).from(authUsers).innerJoin(userRoles, ...).where(...)
//
// This is a single-query helper — a hand-rolled chain is more readable than
// the sequence-based factory and keeps each test explicit + self-contained.

// C5: rows may now optionally include `email`. Tests that don't care about
// the email-local-part match supply a sentinel value that won't accidentally
// match any token under test (`__no-email-fallback__@invalid.example`).
type MockUserRow = { id: string; name: string; email?: string };

function makeUsersDb(rows: MockUserRow[]) {
  const enriched = rows.map((r) => ({
    ...r,
    email: r.email ?? "__no-email-fallback__@invalid.example",
  }));
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(enriched),
        }),
      }),
    }),
  } as never;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("issueService.findMentionedHumans", () => {
  it("matches @alice and @bob in body", async () => {
    const db = makeUsersDb([
      { id: "u1", name: "alice" },
      { id: "u2", name: "bob" },
    ]);
    const result = await issueService(db).findMentionedHumans(
      "co-1",
      "hey @alice and @bob can you look at this",
    );
    expect(result.sort()).toEqual(["u1", "u2"]);
  });

  it("returns empty array when body has no @-mentions", async () => {
    const db = makeUsersDb([
      { id: "u1", name: "alice" },
      { id: "u2", name: "bob" },
    ]);
    const result = await issueService(db).findMentionedHumans(
      "co-1",
      "no mentions here at all",
    );
    expect(result).toEqual([]);
  });

  it("strips -h suffix to disambiguate human from agent of the same name", async () => {
    const db = makeUsersDb([{ id: "u1", name: "alice" }]);
    const result = await issueService(db).findMentionedHumans(
      "co-1",
      "@alice-h please review",
    );
    expect(result).toEqual(["u1"]);
  });

  it("filters out users whose names are not mentioned", async () => {
    const db = makeUsersDb([
      { id: "u1", name: "alice" },
      { id: "u2", name: "bob" },
      { id: "u3", name: "charlie" },
    ]);
    const result = await issueService(db).findMentionedHumans(
      "co-1",
      "hi @alice",
    );
    expect(result).toEqual(["u1"]);
  });

  it("stops at trailing punctuation in mentions", async () => {
    const db = makeUsersDb([
      { id: "u1", name: "alice" },
      { id: "u2", name: "bob" },
      { id: "u3", name: "charlie" },
    ]);
    const result = await issueService(db).findMentionedHumans(
      "co-1",
      "thanks @alice. cc @bob, also @charlie!",
    );
    expect(result.sort()).toEqual(["u1", "u2", "u3"]);
  });

  it("matches case-insensitively against authUsers.name", async () => {
    const db = makeUsersDb([{ id: "u1", name: "Alice" }]);
    const result = await issueService(db).findMentionedHumans("c1", "ping @ALICE");
    expect(result).toEqual(["u1"]);
  });

  it("returns unique user IDs even when a user has multiple userRoles entries", async () => {
    // Simulate the join returning the same user 3 times (one per project role)
    const db = makeUsersDb([
      { id: "u1", name: "alice" },
      { id: "u1", name: "alice" },
      { id: "u1", name: "alice" },
    ]);
    const result = await issueService(db).findMentionedHumans("c1", "@alice");
    expect(result).toEqual(["u1"]);
  });

  it("deduplicates the same @-token mentioned twice in body", async () => {
    const db = makeUsersDb([{ id: "u1", name: "alice" }]);
    const result = await issueService(db).findMentionedHumans("c1", "@alice please review @alice");
    expect(result).toEqual(["u1"]);
  });

  it("stops cleanly at trailing punctuation like ; : ) ]", async () => {
    const db = makeUsersDb([
      { id: "u1", name: "alice" },
      { id: "u2", name: "bob" },
      { id: "u3", name: "charlie" },
    ]);
    const body = "ping @alice; cc @bob: also (@charlie)";
    const result = await issueService(db).findMentionedHumans("c1", body);
    expect(result.sort()).toEqual(["u1", "u2", "u3"]);
  });

  // ── C5: email-local-part fallback ─────────────────────────────────────────
  // authUsers.name is a free-form display name like "Alice Smith". `@alice`
  // in a comment body wouldn't match that. The fallback resolves the @-token
  // against the email-local-part too — `alice@example.com` → "alice".

  it("matches @-token against email-local-part when name doesn't match (C5)", async () => {
    const db = makeUsersDb([
      { id: "u1", name: "Alice Smith", email: "alice@example.com" },
    ]);
    const result = await issueService(db).findMentionedHumans(
      "c1",
      "hey @alice can you check this",
    );
    expect(result).toEqual(["u1"]);
  });

  it("dedupes when both name AND email-local-part match (C5)", async () => {
    // User has name "alice" AND email "alice@example.com". Both branches of
    // the OR fire, but the trailing `new Set([...])` collapses to a single id.
    const db = makeUsersDb([
      { id: "u1", name: "alice", email: "alice@example.com" },
    ]);
    const result = await issueService(db).findMentionedHumans("c1", "@alice");
    expect(result).toEqual(["u1"]);
  });

  it("returns empty when neither name nor email-local-part matches (C5)", async () => {
    const db = makeUsersDb([
      { id: "u1", name: "Alice Smith", email: "alice@example.com" },
    ]);
    const result = await issueService(db).findMentionedHumans("c1", "@bob");
    expect(result).toEqual([]);
  });

  it("matches email-local-part case-insensitively (C5)", async () => {
    const db = makeUsersDb([
      { id: "u1", name: "Alice Smith", email: "Alice@Example.COM" },
    ]);
    const result = await issueService(db).findMentionedHumans("c1", "@ALICE");
    expect(result).toEqual(["u1"]);
  });

  it("matches multiple users by email-local-part (C5)", async () => {
    const db = makeUsersDb([
      { id: "u1", name: "Alice Smith", email: "alice@example.com" },
      { id: "u2", name: "Bob Jones", email: "bob@example.com" },
      { id: "u3", name: "Charlie Brown", email: "charlie@example.com" },
    ]);
    const result = await issueService(db).findMentionedHumans(
      "c1",
      "ping @alice and @bob — fyi @charlie",
    );
    expect(result.sort()).toEqual(["u1", "u2", "u3"]);
  });
});
