import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unified Org Tree Tests (T7)
 *
 * Tests orgForCompany (unified agent+user tree) and getChainOfCommand (mixed chain walking).
 * Uses pure-function extraction and sequence-based mock DB pattern.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };

  return {
    agents: makeTable("agents"),
    agentConfigRevisions: makeTable("agent_config_revisions"),
    agentApiKeys: makeTable("agent_api_keys"),
    agentRuntimeState: makeTable("agent_runtime_state"),
    agentTaskSessions: makeTable("agent_task_sessions"),
    agentWakeupRequests: makeTable("agent_wakeup_requests"),
    heartbeatRunEvents: makeTable("heartbeat_run_events"),
    heartbeatRuns: makeTable("heartbeat_runs"),
    authUsers: makeTable("auth_users"),
    companyMemberships: makeTable("company_memberships"),
    userRoles: makeTable("user_roles"),
    projects: makeTable("projects"),
  };
});

vi.mock("@armyofagents/shared", () => ({
  isUuidLike: (s: string) => /^[0-9a-f-]{36}$/i.test(s),
  normalizeAgentUrlKey: (name: string) => name.toLowerCase().replace(/\s+/g, "-"),
}));

vi.mock("../errors.js", () => ({
  conflict: (msg: string) => new Error(msg),
  notFound: (msg: string) => new Error(msg),
  unprocessable: (msg: string) => new Error(msg),
}));

vi.mock("../services/agent-permissions.js", () => ({
  normalizeAgentPermissions: (perms: unknown) => perms ?? {},
}));

vi.mock("../services/agent-shortnames.js", () => ({
  deduplicateAgentName: vi.fn((name: string) => name),
  hasAgentShortnameCollision: vi.fn(() => false),
}));

vi.mock("../redaction.js", () => ({
  REDACTED_EVENT_VALUE: "[REDACTED]",
  sanitizeRecord: (r: unknown) => r,
}));

import { agentService } from "../services/agents.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of [
      "from", "where", "set", "values", "returning",
      "innerJoin", "leftJoin", "orderBy", "limit",
    ]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => []),
  };
}

function makeAgent(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent One",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    parentType: null,
    parentId: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Unified Org Tree (T7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── orgForCompany ─────────────────────────────────────────────────────────

  describe("orgForCompany", () => {
    it("returns empty array for company with no agents or users", async () => {
      const db = createSequenceDb({
        selects: [
          [], // agents query
          [], // users query
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.orgForCompany("company-1");
      expect(result).toEqual([]);
    });

    it("builds agent-only tree using reportsTo fallback", async () => {
      const ceo = makeAgent({ id: "a-ceo", name: "CEO Agent", role: "cxo", reportsTo: null });
      const worker = makeAgent({ id: "a-worker", name: "Worker", reportsTo: "a-ceo" });

      const db = createSequenceDb({
        selects: [
          [ceo, worker], // agents query
          [],            // users query (no users)
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.orgForCompany("company-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("a-ceo");
      expect(result[0].nodeType).toBe("agent");
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].id).toBe("a-worker");
      expect(result[0].children[0].nodeType).toBe("agent");
    });

    it("builds user-only tree", async () => {
      const db = createSequenceDb({
        selects: [
          [], // agents query (no agents)
          [   // users query
            {
              userId: "user-1",
              email: "founder@example.com",
              displayName: "Founder",
              avatarUrl: null,
              name: "Founder Name",
              parentType: null,
              parentId: null,
              role: "founder",
              departmentId: null,
              departmentName: null,
            },
            {
              userId: "user-2",
              email: "lead@example.com",
              displayName: "Team Lead",
              avatarUrl: null,
              name: "Lead Name",
              parentType: "user",
              parentId: "user-1",
              role: "team_lead",
              departmentId: "dept-1",
              departmentName: "Engineering",
            },
          ],
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.orgForCompany("company-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("user-1");
      expect(result[0].nodeType).toBe("user");
      expect(result[0].userRole).toBe("founder");
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].id).toBe("user-2");
      expect(result[0].children[0].nodeType).toBe("user");
      expect(result[0].children[0].departmentName).toBe("Engineering");
    });

    it("builds mixed tree with agents reporting to users", async () => {
      const agent = makeAgent({
        id: "a-dev",
        name: "Dev Agent",
        parentType: "user",
        parentId: "user-lead",
      });

      const db = createSequenceDb({
        selects: [
          [agent], // agents query
          [        // users query
            {
              userId: "user-lead",
              email: "lead@example.com",
              displayName: "Lead",
              avatarUrl: null,
              name: "Lead",
              parentType: null,
              parentId: null,
              role: "team_lead",
              departmentId: null,
              departmentName: null,
            },
          ],
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.orgForCompany("company-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("user-lead");
      expect(result[0].nodeType).toBe("user");
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].id).toBe("a-dev");
      expect(result[0].children[0].nodeType).toBe("agent");
    });

    it("deduplicates users by highest role (founder > team_lead > team_member)", async () => {
      const db = createSequenceDb({
        selects: [
          [], // agents query
          [   // users query — same user appears with multiple roles
            {
              userId: "user-multi",
              email: "multi@example.com",
              displayName: "Multi Role User",
              avatarUrl: null,
              name: "Multi",
              parentType: null,
              parentId: null,
              role: "team_member",
              departmentId: "dept-a",
              departmentName: "Design",
            },
            {
              userId: "user-multi",
              email: "multi@example.com",
              displayName: "Multi Role User",
              avatarUrl: null,
              name: "Multi",
              parentType: null,
              parentId: null,
              role: "team_lead",
              departmentId: "dept-b",
              departmentName: "Engineering",
            },
          ],
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.orgForCompany("company-1");

      expect(result).toHaveLength(1);
      expect(result[0].userRole).toBe("team_lead");
    });

    it("includes pending_approval agents (D5)", async () => {
      const pending = makeAgent({ id: "a-pending", name: "Pending Agent", status: "pending_approval" });

      const db = createSequenceDb({
        selects: [
          [pending], // agents query (terminated already excluded by WHERE)
          [],        // users query
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.orgForCompany("company-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("a-pending");
      expect(result[0].status).toBe("pending_approval");
    });

    it("promotes orphaned nodes to root when parent is missing", async () => {
      // Agent reports to a terminated (excluded) agent
      const orphan = makeAgent({
        id: "a-orphan",
        name: "Orphan",
        parentType: "agent",
        parentId: "a-terminated",
      });

      const db = createSequenceDb({
        selects: [
          [orphan], // agents query (terminated parent not in results)
          [],       // users query
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.orgForCompany("company-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("a-orphan");
    });

    it("prefers parentType/parentId over reportsTo", async () => {
      const ceo = makeAgent({ id: "a-ceo", name: "CEO" });
      const lead = makeAgent({
        id: "a-lead",
        name: "Lead",
        reportsTo: "a-ceo", // old field
        parentType: "user",
        parentId: "user-founder", // new field takes priority
      });

      const db = createSequenceDb({
        selects: [
          [ceo, lead], // agents query
          [            // users query
            {
              userId: "user-founder",
              email: "founder@example.com",
              displayName: "Founder",
              avatarUrl: null,
              name: "Founder",
              parentType: null,
              parentId: null,
              role: "founder",
              departmentId: null,
              departmentName: null,
            },
          ],
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.orgForCompany("company-1");

      // CEO is root, Founder is root, Lead is child of Founder (not CEO)
      const roots = result.map((n) => n.id).sort();
      expect(roots).toEqual(["a-ceo", "user-founder"]);

      const founder = result.find((n) => n.id === "user-founder")!;
      expect(founder.children).toHaveLength(1);
      expect(founder.children[0].id).toBe("a-lead");

      const ceoNode = result.find((n) => n.id === "a-ceo")!;
      expect(ceoNode.children).toHaveLength(0);
    });

    it("uses displayName for user nodes, falls back to name", async () => {
      const db = createSequenceDb({
        selects: [
          [], // agents
          [
            {
              userId: "u1",
              email: "a@b.com",
              displayName: null,
              avatarUrl: null,
              name: "Fallback Name",
              parentType: null,
              parentId: null,
              role: "founder",
              departmentId: null,
              departmentName: null,
            },
          ],
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.orgForCompany("company-1");

      expect(result[0].name).toBe("Fallback Name");
    });
  });

  // ── getChainOfCommand ───────────────────────────────────────────────────────

  describe("getChainOfCommand", () => {
    it("returns empty chain when agent has no parent", async () => {
      const agent = makeAgent({ id: "a-root", reportsTo: null });
      const db = createSequenceDb({
        selects: [
          [agent], // getById for start agent
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.getChainOfCommand("a-root", "company-1");
      expect(result).toEqual([]);
    });

    it("walks agent-only chain via reportsTo fallback", async () => {
      const worker = makeAgent({ id: "a-worker", reportsTo: "a-manager" });
      const manager = makeAgent({ id: "a-manager", name: "Manager", reportsTo: "a-ceo", role: "manager" });
      const ceo = makeAgent({ id: "a-ceo", name: "CEO", role: "cxo", reportsTo: null });

      const db = createSequenceDb({
        selects: [
          [worker],  // getById for start agent
          [manager], // getById for manager
          [ceo],     // getById for CEO
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.getChainOfCommand("a-worker", "company-1");

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: "a-manager", name: "Manager", nodeType: "agent" });
      expect(result[1]).toMatchObject({ id: "a-ceo", name: "CEO", nodeType: "agent" });
    });

    it("walks mixed chain (agent → user)", async () => {
      const agent = makeAgent({
        id: "a-dev",
        parentType: "user",
        parentId: "user-lead",
        reportsTo: null,
      });
      const userRow = {
        principalId: "user-lead",
        parentType: null,
        parentId: null,
        displayName: "Team Lead",
        name: "Lead Name",
      };
      const userRoleRow = { role: "team_lead" };

      const db = createSequenceDb({
        selects: [
          [agent],       // getById for start agent
          [userRow],     // company_memberships lookup for user
          [userRoleRow], // user_roles lookup for role
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.getChainOfCommand("a-dev", "company-1");

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "user-lead",
        name: "Team Lead",
        role: "team_lead",
        nodeType: "user",
      });
    });

    it("returns nodeType for each chain entry", async () => {
      const agent = makeAgent({
        id: "a-dev",
        parentType: "agent",
        parentId: "a-mgr",
      });
      const mgr = makeAgent({
        id: "a-mgr",
        name: "Manager",
        parentType: "user",
        parentId: "user-cto",
      });
      const userRow = {
        principalId: "user-cto",
        parentType: null,
        parentId: null,
        displayName: "CTO",
        name: "CTO",
      };
      const userRoleRow = { role: "founder" };

      const db = createSequenceDb({
        selects: [
          [agent],       // getById start
          [mgr],         // getById manager (agent)
          [userRow],     // company_memberships lookup (user)
          [userRoleRow], // user_roles lookup
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.getChainOfCommand("a-dev", "company-1");

      expect(result).toHaveLength(2);
      expect(result[0].nodeType).toBe("agent");
      expect(result[1].nodeType).toBe("user");
    });

    it("stops at root (null parent)", async () => {
      const agent = makeAgent({ id: "a-1", reportsTo: "a-2" });
      const parent = makeAgent({ id: "a-2", name: "Root", reportsTo: null });

      const db = createSequenceDb({
        selects: [
          [agent],  // getById start
          [parent], // getById parent
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.getChainOfCommand("a-1", "company-1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("a-2");
    });

    it("enforces 50-step limit", async () => {
      // Create a chain of 60 agents
      const allAgents: MockRow[] = [];
      for (let i = 0; i < 60; i++) {
        allAgents.push(
          makeAgent({
            id: `a-${i}`,
            name: `Agent ${i}`,
            reportsTo: i < 59 ? `a-${i + 1}` : null,
          }),
        );
      }

      const selects = allAgents.map((a) => [a]);
      const db = createSequenceDb({ selects });
      const svc = agentService(db as any);
      const result = await svc.getChainOfCommand("a-0", "company-1");

      expect(result.length).toBeLessThanOrEqual(50);
    });

    it("stops walking when user lookup requires companyId but none provided", async () => {
      const agent = makeAgent({
        id: "a-dev",
        parentType: "user",
        parentId: "user-1",
      });

      const db = createSequenceDb({
        selects: [
          [agent], // getById start
        ],
      });
      const svc = agentService(db as any);
      // No companyId — should stop at user boundary
      const result = await svc.getChainOfCommand("a-dev");

      expect(result).toEqual([]);
    });

    it("returns empty chain when start agent not found", async () => {
      const db = createSequenceDb({
        selects: [
          [], // getById returns null
        ],
      });
      const svc = agentService(db as any);
      const result = await svc.getChainOfCommand("nonexistent", "company-1");

      expect(result).toEqual([]);
    });
  });
});
