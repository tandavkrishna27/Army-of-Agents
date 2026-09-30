import { beforeEach, describe, expect, it, vi } from "vitest";

// B-H1: resolveUserScope must board-gate founder escalation. An agent actor
// resolves to its agent_projects scope (never founder); any other source
// (mcp/commander/unknown) resolves to an empty scoped set (least privilege).

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "$inferSelect" || prop === "$inferInsert") return {};
          return Symbol(String(prop));
        },
      },
    );
  return {
    userRoles: makeTable(),
    agentProjects: makeTable(),
    issues: makeTable(),
    projectGoals: makeTable(),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (left: unknown, right: unknown) => ({ op: "eq", left, right }),
  inArray: (left: unknown, values: unknown) => ({ op: "inArray", left, values }),
}));

import {
  resolveMcpOwnerArtifactScope,
  resolveUserScope,
} from "../mcp/tools/scope.js";

/**
 * Sequence-based mock db: each `.select().from().where()` chain resolves to the
 * next pre-configured result array. The order of `from()` calls in
 * resolveUserScope determines which result a query receives.
 */
function makeDb(results: unknown[][]) {
  let index = 0;
  const fromCalls: unknown[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        fromCalls.push(table);
        return {
          where: () => Promise.resolve(results[index++] ?? []),
        };
      },
    }),
  } as any;
  return { db, fromCalls, queryCount: () => index };
}

describe("resolveUserScope board-gate (B-H1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) agent actor with zero user_roles → scoped to its agent_projects, NOT founder", async () => {
    // Even if user_roles WOULD return a founder row (it never matches an agentId
    // FK, but guard against accidental escalation), the agent branch must not
    // consult user_roles at all — it queries agent_projects only.
    const { db, queryCount } = makeDb([
      [{ projectId: "proj-a" }, { projectId: "proj-b" }],
    ]);
    const scope = await resolveUserScope(db, "company-1", {
      source: "agent",
      userId: "agent-1",
    });
    expect(scope.kind).toBe("scoped");
    if (scope.kind !== "scoped") throw new Error("expected scoped");
    expect([...scope.projectIds].sort()).toEqual(["proj-a", "proj-b"]);
    expect(scope.userId).toBe("agent-1");
    // Only one query (agent_projects), and never founder.
    expect(queryCount()).toBe(1);
  });

  it("(a') agent actor with no agent_projects → scoped with empty projectIds", async () => {
    const { db } = makeDb([[]]);
    const scope = await resolveUserScope(db, "company-1", {
      source: "agent",
      userId: "agent-orphan",
    });
    expect(scope.kind).toBe("scoped");
    if (scope.kind !== "scoped") throw new Error("expected scoped");
    expect([...scope.projectIds]).toEqual([]);
  });

  it("(b) generic mcp scope stays empty and never resolves owner roles", async () => {
    const { db, queryCount } = makeDb([[{ role: "founder", projectId: null }]]);
    const scope = await resolveUserScope(db, "company-1", {
      source: "mcp",
      userId: "mcp-user",
    });
    expect(scope.kind).toBe("scoped");
    if (scope.kind !== "scoped") throw new Error("expected scoped");
    expect([...scope.projectIds]).toEqual([]);
    expect(scope.userId).toBe("mcp-user");
    expect(queryCount()).toBe(0);
  });

  it("(b') unknown/commander source → scoped with empty projectIds, no DB query", async () => {
    const { db, queryCount } = makeDb([[{ role: "founder", projectId: null }]]);
    const scope = await resolveUserScope(db, "company-1", {
      source: "commander",
      userId: "commander-1",
    });
    expect(scope.kind).toBe("scoped");
    if (scope.kind !== "scoped") throw new Error("expected scoped");
    expect([...scope.projectIds]).toEqual([]);
    expect(queryCount()).toBe(0);
  });

  it("(c) board actor with a founder role → founder scope", async () => {
    const { db, queryCount } = makeDb([[{ role: "founder", projectId: null }]]);
    const scope = await resolveUserScope(db, "company-1", {
      source: "board",
      userId: "founder-1",
    });
    expect(scope.kind).toBe("founder");
    expect(scope.userId).toBe("founder-1");
    // Board sessions DO consult user_roles.
    expect(queryCount()).toBe(1);
  });

  it("(c') board actor with zero roles → founder scope (loopback/local-board fallback preserved)", async () => {
    const { db } = makeDb([[]]);
    const scope = await resolveUserScope(db, "company-1", {
      source: "board",
      userId: "local-board",
    });
    expect(scope.kind).toBe("founder");
  });

  it("(d) board actor with a team_member role → scoped with that project", async () => {
    const { db } = makeDb([[{ role: "team_member", projectId: "dept-eng" }]]);
    const scope = await resolveUserScope(db, "company-1", {
      source: "board",
      userId: "member-1",
    });
    expect(scope.kind).toBe("scoped");
    if (scope.kind !== "scoped") throw new Error("expected scoped");
    expect([...scope.projectIds]).toEqual(["dept-eng"]);
    expect(scope.userId).toBe("member-1");
  });
});

describe("resolveMcpOwnerArtifactScope", () => {
  it("grants founder scope only for the artifact-version operation", async () => {
    const { db } = makeDb([[{ role: "founder", projectId: null }]]);
    const scope = await resolveMcpOwnerArtifactScope(db, "company-1", "founder-1");
    expect(scope).toEqual({ kind: "founder", userId: "founder-1" });
  });

  it("scopes a key owner to role projects and fails closed with zero roles", async () => {
    const { db } = makeDb([
      [
        { role: "team_lead", projectId: "dept-eng" },
        { role: "team_member", projectId: "dept-design" },
      ],
      [],
    ]);
    const leadScope = await resolveMcpOwnerArtifactScope(db, "company-1", "lead-1");
    expect(leadScope.kind).toBe("scoped");
    if (leadScope.kind !== "scoped") throw new Error("expected scoped");
    expect([...leadScope.projectIds].sort()).toEqual(["dept-design", "dept-eng"]);

    const rolelessScope = await resolveMcpOwnerArtifactScope(db, "company-1", "roleless-1");
    expect(rolelessScope.kind).toBe("scoped");
    if (rolelessScope.kind !== "scoped") throw new Error("expected scoped");
    expect([...rolelessScope.projectIds]).toEqual([]);
  });
});
