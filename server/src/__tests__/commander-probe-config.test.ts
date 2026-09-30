import { describe, it, expect, vi, beforeEach } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  agents: makeTableProxy("agents"),
}));
const resolveAdapterConfigForRuntime = vi.hoisted(() =>
  vi.fn(async (_c: string, cfg: Record<string, unknown>) => ({ ...cfg, env: { ANTHROPIC_API_KEY: "resolved" } })),
);
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ resolveAdapterConfigForRuntime }),
}));

import {
  commanderProbeUsesApiKey,
  resolveCommanderProbeConfig,
} from "../services/commander-verify.js";

/** db.select().from().where().limit() → next configured result. */
function db(results: unknown[][]) {
  let i = 0;
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => results[i++] ?? [] }) }) }),
  } as never;
}

describe("resolveCommanderProbeConfig (Plan 3 T1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("distinguishes API-key probes from subscription-home probes", () => {
    expect(
      commanderProbeUsesApiKey(
        { env: { OPENAI_API_KEY: "company-key", CODEX_HOME: "/scoped" } },
        "codex_local",
      ),
    ).toBe(true);
    expect(
      commanderProbeUsesApiKey({ env: { CODEX_HOME: "/scoped" } }, "codex_local"),
    ).toBe(false);
    expect(
      commanderProbeUsesApiKey(
        { env: { ANTHROPIC_API_KEY: "company-key" } },
        "claude_local",
      ),
    ).toBe(true);
  });

  it("loads the Commander agent's adapterConfig and returns the RESOLVED config", async () => {
    const d = db([
      [{ agentId: "cmd-agent" }], // internal_agent_config
      [{ adapterConfig: { env: { ANTHROPIC_API_KEY: { type: "secret_ref", id: "s1" } } } }], // agents
    ]);
    const cfg = await resolveCommanderProbeConfig(d, "c1", "claude_local", "u1");
    expect(resolveAdapterConfigForRuntime).toHaveBeenCalledWith(
      "c1",
      "claude_local",
      expect.objectContaining({ env: expect.anything() }),
      expect.objectContaining({ consumerId: "cmd-agent" }),
    );
    expect(cfg).toMatchObject({ env: { ANTHROPIC_API_KEY: "resolved" } });
  });

  it("uses the caller-scoped CLI home when there is no linked Commander agent", async () => {
    const d = db([[]]); // no internal_agent_config agent link
    const cfg = await resolveCommanderProbeConfig(d, "c1", "claude_local", "u1");
    expect(cfg).toMatchObject({
      env: { CLAUDE_CONFIG_DIR: expect.stringMatching(/[\\/]anthropic$/) },
    });
    expect(resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
  });
});
