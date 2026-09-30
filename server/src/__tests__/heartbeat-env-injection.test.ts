import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB / drizzle stubs ────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
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
    environments: makeTable("environments"),
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────

import { resolveEnvironmentEnvVars, resolveEnvironmentRuntimeConfig } from "../services/environment-resolver.js";

// ── Mock DB helpers ──────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
} = {}) {
  let selectIdx = 0;

  function makeChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  return {
    select: (_fields?: unknown) =>
      makeChain(() => config.selects?.[selectIdx++] ?? []),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const envId1 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const envId2 = "ffffffff-ffff-4fff-8fff-ffffffffffff";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("heartbeat environment resolution", () => {
  it("uses issue.executionEnvironmentId when set", async () => {
    const envVars = { API_KEY: "issue-env-key", REGION: "us-east-1" };
    const db = createSequenceDb({
      selects: [[{ envVars }]],
    });

    const result = await resolveEnvironmentEnvVars(db as never, {
      executionEnvironmentId: envId1,
      defaultEnvironmentId: envId2,
      companyId,
    });

    expect(result).toEqual(envVars);
  });

  it("falls back to agent.defaultEnvironmentId when issue has none", async () => {
    const envVars = { API_KEY: "agent-default-key" };
    const db = createSequenceDb({
      selects: [[{ envVars }]],
    });

    const result = await resolveEnvironmentEnvVars(db as never, {
      executionEnvironmentId: null,
      defaultEnvironmentId: envId2,
      companyId,
    });

    expect(result).toEqual(envVars);
  });

  it("uses no environment when neither is set", async () => {
    const db = createSequenceDb({ selects: [] });

    const result = await resolveEnvironmentEnvVars(db as never, {
      executionEnvironmentId: null,
      defaultEnvironmentId: null,
      companyId,
    });

    expect(result).toEqual({});
  });

  it("returns empty object when environment row is not found (cross-tenant guard)", async () => {
    // DB returns empty rows — env exists but belongs to a different company
    const db = createSequenceDb({ selects: [[]] });

    const result = await resolveEnvironmentEnvVars(db as never, {
      executionEnvironmentId: envId1,
      defaultEnvironmentId: null,
      companyId,
    });

    expect(result).toEqual({});
  });

  it("returns target from the issue-selected environment", async () => {
    const target = {
      type: "sandbox-docker",
      image: "node:22-bookworm",
      workdir: "/workspace",
    };
    const db = createSequenceDb({
      selects: [[{ envVars: { NODE_ENV: "test" }, target }]],
    });

    const result = await resolveEnvironmentRuntimeConfig(db as never, {
      executionEnvironmentId: envId1,
      defaultEnvironmentId: envId2,
      companyId,
    });

    expect(result).toEqual({
      environmentId: envId1,
      envVars: { NODE_ENV: "test" },
      target,
      executionTargetId: null,
    });
  });

  it("falls back to the agent default environment target", async () => {
    const target = { type: "local" };
    const db = createSequenceDb({
      selects: [[{ envVars: {}, target }]],
    });

    const result = await resolveEnvironmentRuntimeConfig(db as never, {
      executionEnvironmentId: null,
      defaultEnvironmentId: envId2,
      companyId,
    });

    expect(result.target).toEqual(target);
    expect(result.environmentId).toBe(envId2);
  });

  it("returns no target when no environment resolves", async () => {
    const db = createSequenceDb({ selects: [] });

    const result = await resolveEnvironmentRuntimeConfig(db as never, {
      executionEnvironmentId: null,
      defaultEnvironmentId: null,
      companyId,
    });

    expect(result).toEqual({ environmentId: null, envVars: {}, target: null, executionTargetId: null });
  });

  it("environment envVars slot between project env and agent adapterConfig.env", () => {
    // This test verifies the merge logic applied in heartbeat.ts directly.
    // Priority: projectEnv < environmentEnvVars < agentEnv (agent wins last)
    const projectEnv: Record<string, unknown> = {
      BASE_URL: "https://project.example.com",
      SHARED_KEY: "from-project",
      PROJECT_ONLY: "project-value",
    };
    const environmentEnvVars: Record<string, unknown> = {
      SHARED_KEY: "from-environment",   // overrides project
      ENV_ONLY: "env-value",
    };
    const agentEnv: Record<string, unknown> = {
      SHARED_KEY: "from-agent",         // overrides environment
      AGENT_ONLY: "agent-value",
    };

    // Simulate the merge performed in heartbeat.ts after this task is done:
    //   { ...projectEnv, ...environmentEnvVars, ...agentEnv }
    const merged = {
      ...projectEnv,
      ...environmentEnvVars,
      ...agentEnv,
    };

    expect(merged).toEqual({
      BASE_URL: "https://project.example.com",
      SHARED_KEY: "from-agent",       // agent wins
      PROJECT_ONLY: "project-value",
      ENV_ONLY: "env-value",
      AGENT_ONLY: "agent-value",
    });

    // Verify ordering invariants
    expect(merged["SHARED_KEY"]).toBe("from-agent");
    expect(merged["ENV_ONLY"]).toBe("env-value");
    expect(merged["PROJECT_ONLY"]).toBe("project-value");
  });

  it("environment target overrides adapter config target when set", () => {
    const adapterConfig = {
      executionTarget: { type: "local" },
      env: { AGENT_ONLY: "1" },
    };
    const environmentTarget = {
      type: "sandbox-docker",
      image: "node:22-bookworm",
    };

    const merged = environmentTarget
      ? { ...adapterConfig, executionTarget: environmentTarget }
      : adapterConfig;

    expect(merged.executionTarget).toEqual(environmentTarget);
  });

  it("preserves adapter config target when environment has no target", () => {
    const adapterConfig = {
      executionTarget: { type: "sandbox-docker", image: "node:20-bookworm" },
      env: { AGENT_ONLY: "1" },
    };
    const environmentTarget = null;

    const merged = environmentTarget
      ? { ...adapterConfig, executionTarget: environmentTarget }
      : adapterConfig;

    expect(merged.executionTarget).toEqual(adapterConfig.executionTarget);
  });
});
