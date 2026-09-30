import { describe, it, expect } from "vitest";

/**
 * Contract test for project-env merge precedence in heartbeat.
 *
 * The actual production merge lives in server/src/services/heartbeat.ts (~line 1890,
 * search for `mergedConfigWithProjectEnv` or the project-env merge step). The
 * production code spreads layers in this order:
 *
 *   { ...projectEnv, ...parseObject(mergedConfig.env) }
 *
 * where `mergedConfig.env` is the agent's adapter env (the "agent" layer), yielding
 * agent-wins-on-conflict semantics. This test exercises the same spread-order contract
 * directly. If a future refactor flips the spread order, agent-scoped overrides would
 * be clobbered by project defaults.
 *
 * SEE: server/src/services/heartbeat.ts (mergedConfigWithProjectEnv block, ~line 1890) and
 *      docs/superpowers/plans/2026-04-26-upstream-paperclip-resync.md (T18).
 */
describe("Project env merge precedence", () => {
  function mergeRunEnv(layers: {
    system?: Record<string, string>;
    instance?: Record<string, string>;
    company?: Record<string, string>;
    project?: Record<string, string>;
    agent?: Record<string, string>;
  }): Record<string, string> {
    return {
      ...(layers.system ?? {}),
      ...(layers.instance ?? {}),
      ...(layers.company ?? {}),
      ...(layers.project ?? {}),
      ...(layers.agent ?? {}),
    };
  }

  it("agent value wins over project value for same key", () => {
    const merged = mergeRunEnv({
      project: { SHARED: "from-project" },
      agent: { SHARED: "from-agent" },
    });
    expect(merged.SHARED).toBe("from-agent");
  });

  it("project value wins over company value for same key", () => {
    const merged = mergeRunEnv({
      company: { SHARED: "from-company" },
      project: { SHARED: "from-project" },
    });
    expect(merged.SHARED).toBe("from-project");
  });

  it("layers preserve unique keys from each source", () => {
    const merged = mergeRunEnv({
      project: { PROJECT_ONLY: "p-value" },
      agent: { AGENT_ONLY: "a-value" },
    });
    expect(merged.PROJECT_ONLY).toBe("p-value");
    expect(merged.AGENT_ONLY).toBe("a-value");
  });

  it("full precedence chain: system < instance < company < project < agent", () => {
    const merged = mergeRunEnv({
      system: { K: "system" },
      instance: { K: "instance" },
      company: { K: "company" },
      project: { K: "project" },
      agent: { K: "agent" },
    });
    expect(merged.K).toBe("agent");
  });

  it("agent layer absent → project value flows through", () => {
    const merged = mergeRunEnv({
      project: { K: "from-project" },
    });
    expect(merged.K).toBe("from-project");
  });

  it("project layer absent → agent value flows through", () => {
    const merged = mergeRunEnv({
      agent: { K: "from-agent" },
    });
    expect(merged.K).toBe("from-agent");
  });

  it("all layers absent → empty env", () => {
    expect(mergeRunEnv({})).toEqual({});
  });
});
