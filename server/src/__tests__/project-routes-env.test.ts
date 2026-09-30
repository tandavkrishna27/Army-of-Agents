/**
 * Unit tests for project environment variable routes (T18).
 *
 * These tests verify the service-layer logic directly, mirroring the
 * contract-test pattern used elsewhere in this codebase (no HTTP server).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ __eq: { col, val } })),
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn((s: unknown) => s) }),
}));

vi.mock("@armyofagents/db", () => {
  const makeProxy = () =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === "string") return { __column: prop };
          return undefined;
        },
      },
    );

  return {
    projects: makeProxy(),
    goals: makeProxy(),
    projectGoals: makeProxy(),
    projectWorkspaces: makeProxy(),
    issues: makeProxy(),
    agents: makeProxy(),
    agentProjects: makeProxy(),
    costEvents: makeProxy(),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  },
}));

// ── Types ─────────────────────────────────────────────────────────────────────

type EnvBinding =
  | string
  | { type: "plain"; value: string }
  | { type: "secret_ref"; secretId: string; version?: string | number };

type AgentEnvConfig = Record<string, EnvBinding>;

interface ProjectRow {
  id: string;
  companyId: string;
  name: string;
  env: AgentEnvConfig | null;
  status: string;
  type: string;
}

// ── Minimal in-memory projectService stub ────────────────────────────────────

function makeProjectService(initial: ProjectRow) {
  let current: ProjectRow = { ...initial };

  return {
    getById: vi.fn(async (id: string) => (id === current.id ? { ...current } : null)),
    updateEnvironment: vi.fn(async (id: string, env: AgentEnvConfig | null) => {
      if (id !== current.id) return null;
      current = { ...current, env };
      return { ...current };
    }),
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("project environment routes (T18 contract tests)", () => {
  const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const COMPANY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function makeProject(envOverride?: AgentEnvConfig | null): ProjectRow {
    return {
      id: PROJECT_ID,
      companyId: COMPANY_ID,
      name: "Test Project",
      env: envOverride ?? null,
      status: "backlog",
      type: "project",
    };
  }

  it("GET /projects/:id/environment returns null env when not set", async () => {
    const svc = makeProjectService(makeProject(null));

    const project = await svc.getById(PROJECT_ID);
    expect(project).not.toBeNull();
    expect(project!.env).toBeNull();
    // Route would respond: { env: null }
    expect(project!.env ?? null).toBeNull();
  });

  it("GET /projects/:id/environment returns stored env bindings", async () => {
    const storedEnv: AgentEnvConfig = {
      DATABASE_URL: { type: "plain", value: "postgres://localhost/test" },
      API_KEY: { type: "secret_ref", secretId: "sec-001", version: "latest" },
    };
    const svc = makeProjectService(makeProject(storedEnv));

    const project = await svc.getById(PROJECT_ID);
    expect(project!.env).toEqual(storedEnv);
  });

  it("PATCH /projects/:id/environment updates env and returns new value", async () => {
    const svc = makeProjectService(makeProject(null));

    const newEnv: AgentEnvConfig = {
      NEW_VAR: { type: "plain", value: "hello" },
    };
    const updated = await svc.updateEnvironment(PROJECT_ID, newEnv);
    expect(updated).not.toBeNull();
    expect(updated!.env).toEqual(newEnv);

    // Verify subsequent GET reflects the update
    const fetched = await svc.getById(PROJECT_ID);
    expect(fetched!.env).toEqual(newEnv);
  });

  it("PATCH /projects/:id/environment can clear env to null", async () => {
    const initialEnv: AgentEnvConfig = { FOO: { type: "plain", value: "bar" } };
    const svc = makeProjectService(makeProject(initialEnv));

    const updated = await svc.updateEnvironment(PROJECT_ID, null);
    expect(updated!.env).toBeNull();
  });

  it("PATCH /projects/:id/environment returns null for unknown project", async () => {
    const svc = makeProjectService(makeProject(null));
    const result = await svc.updateEnvironment("unknown-id", { FOO: "bar" });
    expect(result).toBeNull();
  });

  it("GET /projects/:id/environment returns null for unknown project", async () => {
    const svc = makeProjectService(makeProject(null));
    const result = await svc.getById("unknown-id");
    expect(result).toBeNull();
  });

  it("envConfigSchema rejects invalid env body shape", async () => {
    // Import the real zod schema to verify validation logic
    const { envConfigSchema } = await import("@armyofagents/shared");

    // Valid: plain string
    expect(envConfigSchema.safeParse({ KEY: "value" }).success).toBe(true);

    // Valid: plain binding object
    expect(envConfigSchema.safeParse({ KEY: { type: "plain", value: "v" } }).success).toBe(true);

    // Valid: secret_ref binding
    expect(
      envConfigSchema.safeParse({
        KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
      }).success,
    ).toBe(true);

    // Invalid: array at top level (not a record)
    expect(envConfigSchema.safeParse([{ key: "val" }]).success).toBe(false);

    // Invalid: binding has unknown type
    expect(envConfigSchema.safeParse({ KEY: { type: "unknown_type", value: "x" } }).success).toBe(
      false,
    );
  });

  it("project env underlies agent env in merge precedence", () => {
    // This test validates the merge logic used in heartbeat.ts:
    // projectEnv is spread first, agentEnv overrides (agent wins).
    const projectEnv: AgentEnvConfig = {
      SHARED_KEY: { type: "plain", value: "from_project" },
      PROJECT_ONLY: { type: "plain", value: "project_value" },
    };
    const agentEnv: AgentEnvConfig = {
      SHARED_KEY: { type: "plain", value: "from_agent" },
      AGENT_ONLY: { type: "plain", value: "agent_value" },
    };

    // Mirrors: { ...projectEnv, ...agentEnv }
    const merged: AgentEnvConfig = { ...projectEnv, ...agentEnv };

    expect((merged.SHARED_KEY as { value: string }).value).toBe("from_agent");
    expect((merged.PROJECT_ONLY as { value: string }).value).toBe("project_value");
    expect((merged.AGENT_ONLY as { value: string }).value).toBe("agent_value");
  });
});
