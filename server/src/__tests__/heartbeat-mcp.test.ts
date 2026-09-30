import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ORG_HEARTBEAT_ENABLED_CAPABILITIES,
  ORG_HEARTBEAT_TOOL_ALLOWLIST,
  prepareHeartbeatMcpDelivery,
  resolveHeartbeatEffectiveAutonomy,
} from "../services/heartbeat-mcp.js";
import {
  adapterSupportsConnectors,
  buildConnectorSpecs,
  CONNECTOR_CAPABLE_ADAPTERS,
  type ResolvedConnectorRow,
} from "../services/mcp-connectors.js";

vi.mock("node:fs/promises", () => ({
  default: {
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

const params = {
  companyId: "company-1",
  userId: "agent-1",
  userRole: "team_member",
  enabledCapabilities: ["system_actions"],
  bridgeEntrypoint: "C:/aoa/mcp-bridge.js",
  agentKind: "org",
  toolAllowlist: [...ORG_HEARTBEAT_TOOL_ALLOWLIST],
  actorType: "agent",
  agentId: "agent-1",
  runId: "run-1",
  effectiveAutonomy: 1,
} as const;

describe("heartbeat effective autonomy", () => {
  it("uses the source Discussion override before the company dial", () => {
    expect(resolveHeartbeatEffectiveAutonomy({
      companyAutonomyLevel: 2,
      discussionAutonomyLevel: 1,
    })).toBe(1);
  });

  it("falls back to the company dial and fails closed for invalid values", () => {
    expect(resolveHeartbeatEffectiveAutonomy({
      companyAutonomyLevel: 2,
      discussionAutonomyLevel: null,
    })).toBe(2);
    expect(resolveHeartbeatEffectiveAutonomy({
      companyAutonomyLevel: 9,
      discussionAutonomyLevel: undefined,
    })).toBe(0);
  });
});

describe("heartbeat MCP delivery", () => {
  it("exposes only the organization-agent task-work surface", () => {
    expect(ORG_HEARTBEAT_TOOL_ALLOWLIST).toEqual(expect.arrayContaining([
      "get_task",
      "get_heartbeat_context",
      "post_task_comment",
      "attach_task_artifact",
      "set_task_status",
      "ask_human",
      // Read-only memory retrieval (internal-agent registry tool) — the primary
      // ORG memory-delivery path.
      "query_memory",
    ]));
    expect(ORG_HEARTBEAT_TOOL_ALLOWLIST).not.toEqual(expect.arrayContaining([
      "create_task",
      "assign_task",
      "update_task",
      "create_approval",
    ]));
  });

  // Wave 1 review, FIX A: this constant was extracted from an inline literal
  // in heartbeat.ts's `heartbeatMcpParams` so the broker's ToolContext
  // resolver (broker-tool-context.ts) can import the SAME set instead of
  // hardcoding a second copy that could drift.
  it("exposes the organization-agent coarse capability gate (discussion_processing/system_actions/memory_management)", () => {
    expect(ORG_HEARTBEAT_ENABLED_CAPABILITIES).toEqual([
      "discussion_processing",
      "system_actions",
      "memory_management",
    ]);
  });

  it("passes a provider-neutral bridge to Codex without Claude-only arguments", async () => {
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "codex_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"] },
      params,
    });

    expect(delivery.config).toEqual({ args: ["--existing"] });
    expect(delivery.mcpBridge).toMatchObject({
      command: "node",
      args: ["C:/aoa/mcp-bridge.js"],
      env: {
        AOA_SESSION_COMPANY_ID: "company-1",
        AOA_ACTOR_TYPE: "agent",
        AOA_AGENT_ID: "agent-1",
        AOA_RUN_ID: "run-1",
        AOA_EFFECTIVE_AUTONOMY: "1",
      },
    });
    await delivery.cleanup();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it("serializes only an explicitly declared human-question capability", async () => {
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "deterministic_test",
      agentId: "agent-1",
      runId: "run-1",
      config: {},
      params: {
        ...params,
        humanQuestionCapabilities: {
          mode: "live_relay",
          preservesProducerInvocationId: true,
          pauseDeadline: true,
          resumeSession: true,
          cancelWait: true,
        },
      },
    });

    expect(JSON.parse(delivery.mcpBridge.env.AOA_HUMAN_QUESTION_CAPABILITIES)).toEqual({
      mode: "live_relay",
      preservesProducerInvocationId: true,
      pauseDeadline: true,
      resumeSession: true,
      cancelWait: true,
    });
  });

  it("adds and removes the Claude MCP config while retaining the neutral bridge", async () => {
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"] },
      params,
    });

    expect(delivery.config.args).toEqual([
      "--mcp-config",
      expect.stringMatching(/aoa-heartbeat-mcp-agent-1-run-1\.json$/),
      "--strict-mcp-config",
      "--existing",
    ]);
    expect(delivery.mcpBridge.env.AOA_RUN_ID).toBe("run-1");
    expect(fs.writeFile).toHaveBeenCalledOnce();

    await delivery.cleanup();
    expect(fs.unlink).toHaveBeenCalledWith(expect.stringMatching(/aoa-heartbeat-mcp-agent-1-run-1\.json$/));
  });

  it("uses extraArgs when present because the Claude adapter gives them precedence", async () => {
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--ignored"], extraArgs: ["--allowedTools", "mcp__aoa__ask_human"] },
      params,
    });

    expect(delivery.config.args).toEqual(["--ignored"]);
    expect(delivery.config.extraArgs).toEqual([
      "--mcp-config",
      expect.stringMatching(/aoa-heartbeat-mcp-agent-1-run-1\.json$/),
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__aoa__ask_human",
    ]);
  });
});

describe("heartbeat MCP delivery: user --mcp-config escape hatch is closed (Task 12)", () => {
  it("strips a user-injected --mcp-config from extraArgs while keeping AoA's own config", async () => {
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      // Founder tries to smuggle an external MCP server through the Extra args box.
      config: {
        extraArgs: ["--mcp-config", "C:/evil.json", "--strict-mcp-config", "--allowedTools", "mcp__aoa__ask_human"],
      },
      params,
    });

    const args = delivery.config.extraArgs as string[];
    // Property 1 — the hole is closed: the user injection is gone.
    expect(args).not.toContain("C:/evil.json");
    expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1); // only AoA's own
    expect(args.filter((a) => a === "--strict-mcp-config")).toHaveLength(1); // only AoA's own

    // Property 2 — AoA's own injection SURVIVES (the anti-regression trap).
    expect(args[0]).toBe("--mcp-config");
    expect(args[1]).toMatch(/aoa-heartbeat-mcp-agent-1-run-1\.json$/);
    expect(args[2]).toBe("--strict-mcp-config");
    // The user's benign, unrelated args are preserved.
    expect(args).toContain("--allowedTools");
    expect(args).toContain("mcp__aoa__ask_human");
  });

  it("strips a user-injected --mcp-config from args (no extraArgs present)", async () => {
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--mcp-config=C:/evil.json", "--model", "opus"] },
      params,
    });

    const args = delivery.config.args as string[];
    // Hole closed.
    expect(args).not.toContain("--mcp-config=C:/evil.json");
    expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1); // only AoA's own
    // AoA config survives + benign args preserved.
    expect(args[0]).toBe("--mcp-config");
    expect(args[2]).toBe("--strict-mcp-config");
    expect(args).toContain("--model");
    expect(args).toContain("opus");
  });
});

/** Parse the JSON that was written to the last `--mcp-config` file. */
function lastWrittenMcpConfig(): { mcpServers: Record<string, unknown> } {
  const writeFile = fs.writeFile as unknown as ReturnType<typeof vi.fn>;
  const lastCall = writeFile.mock.calls.at(-1);
  if (!lastCall) throw new Error("fs.writeFile was never called");
  return JSON.parse(lastCall[1] as string);
}

describe("heartbeat MCP delivery with connectors (Plan 1, claude_local)", () => {
  // Faithful end-to-end shape: a resolved connector row -> buildConnectorSpecs
  // -> prepareHeartbeatMcpDelivery. Proves placeholder substitution and the
  // secret-only-in-env boundary through the real chain, not a hand-built spec.
  const httpRow: ResolvedConnectorRow = {
    serverName: "slack",
    transport: "http",
    url: "https://slack.example/mcp",
    command: null,
    args: [],
    headerTemplate: { Authorization: "Bearer ${TOKEN}" },
    envTemplate: {},
    secretValue: "xoxb-super-secret",
  };

  it("splices connector servers into the config FILE with placeholders and NO plaintext secret", async () => {
    const { specs, env } = buildConnectorSpecs([httpRow]);
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"], env: { PRE_EXISTING: "keep" } },
      params,
      extraMcpServers: specs,
      connectorEnv: env,
    });

    const written = lastWrittenMcpConfig();
    // aoa is always present; the connector rides alongside it.
    expect(written.mcpServers.aoa).toBeDefined();
    expect(written.mcpServers.slack).toEqual({
      type: "http",
      url: "https://slack.example/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_SLACK_TOKEN}" },
    });
    // The real secret MUST NOT appear anywhere in the config file.
    expect(JSON.stringify(written)).not.toContain("xoxb-super-secret");

    // The delivered config.env carries the REAL token, merged over pre-existing env.
    expect(delivery.config.env).toEqual({
      PRE_EXISTING: "keep",
      AOA_MCP_SLACK_TOKEN: "xoxb-super-secret",
    });
  });

  it("merges connector tokens AFTER config.env so a same-named key cannot shadow the token", async () => {
    const { specs, env } = buildConnectorSpecs([httpRow]);
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      // Adversarial: host config already carries a stale value under the token key.
      config: { args: ["--existing"], env: { AOA_MCP_SLACK_TOKEN: "STALE" } },
      params,
      extraMcpServers: specs,
      connectorEnv: env,
    });

    expect((delivery.config.env as Record<string, string>).AOA_MCP_SLACK_TOKEN).toBe(
      "xoxb-super-secret",
    );
  });

  it("stdio connector: substitutes ${TOKEN} in args and env, secret only in delivered env", async () => {
    const stdioRow: ResolvedConnectorRow = {
      serverName: "gh-cli",
      transport: "stdio",
      url: null,
      command: "gh-mcp",
      args: ["--token", "${TOKEN}"],
      headerTemplate: {},
      envTemplate: { GH_TOKEN: "${TOKEN}" },
      secretValue: "ghp_secret_value",
    };
    const { specs, env } = buildConnectorSpecs([stdioRow]);
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: {},
      params,
      extraMcpServers: specs,
      connectorEnv: env,
    });

    const written = lastWrittenMcpConfig();
    expect(written.mcpServers["gh-cli"]).toEqual({
      command: "gh-mcp",
      args: ["--token", "${AOA_MCP_GH_CLI_TOKEN}"],
      env: { GH_TOKEN: "${AOA_MCP_GH_CLI_TOKEN}" },
    });
    expect(JSON.stringify(written)).not.toContain("ghp_secret_value");
    expect(delivery.config.env).toEqual({ AOA_MCP_GH_CLI_TOKEN: "ghp_secret_value" });
  });

  it("REGRESSION: no connectors produces output identical to before this task", async () => {
    // Baseline: the pre-task call shape (no connector fields at all).
    const baseline = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"] },
      params,
    });
    const baselineWritten = lastWrittenMcpConfig();

    // Same call, now passing EMPTY connector maps (an agent with no connectors).
    const withEmpty = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"] },
      params,
      extraMcpServers: {},
      connectorEnv: {},
    });
    const emptyWritten = lastWrittenMcpConfig();

    // The delivered config must be deep-equal, and crucially must NOT gain an
    // `env` key (spreading an absent config.env would coerce it to `{}`).
    expect(withEmpty.config).toEqual(baseline.config);
    expect("env" in withEmpty.config).toBe(false);
    // The written config FILE must be byte-identical.
    expect(emptyWritten).toEqual(baselineWritten);
  });

  it("an unauthenticated connector (no secret) adds a server but no env key", async () => {
    const noSecretRow: ResolvedConnectorRow = {
      serverName: "public-http",
      transport: "http",
      url: "https://public.example/mcp",
      command: null,
      args: [],
      headerTemplate: {},
      envTemplate: {},
      secretValue: null,
    };
    const { specs, env } = buildConnectorSpecs([noSecretRow]);
    expect(Object.keys(env)).toHaveLength(0); // no token minted
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"] },
      params,
      extraMcpServers: specs,
      connectorEnv: env,
    });

    const written = lastWrittenMcpConfig();
    expect(written.mcpServers["public-http"]).toBeDefined();
    // connectorEnv is empty -> the regression guard leaves config.env untouched.
    expect("env" in delivery.config).toBe(false);
  });
});

describe("connector-capable adapter predicate (Plan 2b Task 3)", () => {
  it("covers exactly the four CLI adapters that can host external MCP servers", () => {
    expect([...CONNECTOR_CAPABLE_ADAPTERS].sort()).toEqual([
      "claude_local",
      "codex_local",
      "gemini_local",
      "opencode_local",
    ]);
  });

  it("admits the CLI adapters and rejects everything without an MCP runtime", () => {
    for (const t of ["claude_local", "codex_local", "gemini_local", "opencode_local"]) {
      expect(adapterSupportsConnectors(t)).toBe(true);
    }
    // These have no MCP client at all — they must never trigger a connector DB read.
    for (const t of ["process", "http", "cursor", "hermes_local", "deterministic_test"]) {
      expect(adapterSupportsConnectors(t)).toBe(false);
    }
    expect(adapterSupportsConnectors(undefined)).toBe(false);
    expect(adapterSupportsConnectors(null)).toBe(false);
  });
});

describe("heartbeat MCP delivery to NON-claude adapters (Plan 2b Task 3)", () => {
  const httpRow: ResolvedConnectorRow = {
    serverName: "slack",
    transport: "http",
    url: "https://slack.example/mcp",
    command: null,
    args: [],
    headerTemplate: { Authorization: "Bearer ${TOKEN}" },
    envTemplate: {},
    secretValue: "xoxb-super-secret",
  };

  /** How many `--mcp-config` files have been written so far (mock is module-scoped). */
  function writeCount(): number {
    return (fs.writeFile as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
  }

  it("merges connectorEnv into the delivered config.env and exposes extraMcpServers", async () => {
    const { specs, env } = buildConnectorSpecs([httpRow]);
    const before = writeCount();
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "codex_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"], env: { PRE_EXISTING: "keep" } },
      params,
      extraMcpServers: specs,
      connectorEnv: env,
    });

    // (a) the REAL token reaches the child: every adapter copies config.env into
    // its spawn env, so no new plumbing is needed beyond this merge.
    expect(delivery.config.env).toEqual({
      PRE_EXISTING: "keep",
      AOA_MCP_SLACK_TOKEN: "xoxb-super-secret",
    });
    // (b) the specs ride the carrier for the per-adapter writers (Tasks 4-6).
    expect(delivery.extraMcpServers).toEqual(specs);
    expect(delivery.extraMcpServers?.slack).toBeDefined();
    // (c) NO claude-only delivery leaks in: args untouched, no config FILE written.
    expect(delivery.config.args).toEqual(["--existing"]);
    expect(writeCount()).toBe(before);
    await delivery.cleanup();
  });

  it("merges connector tokens AFTER config.env so a same-named key cannot shadow the token", async () => {
    const { specs, env } = buildConnectorSpecs([httpRow]);
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "opencode_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { env: { AOA_MCP_SLACK_TOKEN: "STALE" } },
      params,
      extraMcpServers: specs,
      connectorEnv: env,
    });

    expect((delivery.config.env as Record<string, string>).AOA_MCP_SLACK_TOKEN).toBe(
      "xoxb-super-secret",
    );
  });

  it("REGRESSION: a non-claude adapter with NO connectors is byte-identical to before this task", async () => {
    const baseline = await prepareHeartbeatMcpDelivery({
      adapterType: "codex_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"] },
      params,
    });
    const before = writeCount();
    const withEmpty = await prepareHeartbeatMcpDelivery({
      adapterType: "codex_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"] },
      params,
      extraMcpServers: {},
      connectorEnv: {},
    });

    expect(withEmpty.config).toEqual(baseline.config);
    expect(withEmpty.config).toEqual({ args: ["--existing"] });
    // Spreading an absent config.env would coerce it to `{}` — it must stay absent.
    expect("env" in withEmpty.config).toBe(false);
    expect(writeCount()).toBe(before);
  });

  it("the claude branch also exposes extraMcpServers on the delivery", async () => {
    const { specs, env } = buildConnectorSpecs([httpRow]);
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: {},
      params,
      extraMcpServers: specs,
      connectorEnv: env,
    });
    expect(delivery.extraMcpServers).toEqual(specs);
    await delivery.cleanup();
  });
});

// ---------------------------------------------------------------------------
// U4b (S7 blocker): org heartbeat's brokered MCP delivery. heartbeat.ts sets
// `heartbeatMcpParams.brokered` from the run's acquired sandbox lease
// (`orgAcquired.sandbox?.environment.driver === "sandbox"`) BEFORE calling
// prepareHeartbeatMcpDelivery — these tests exercise THAT function directly
// with brokered params (the real "org honoring" boundary: this same function
// call is the one heartbeat.ts makes), proving neither the staged claude
// `--mcp-config` file NOR the non-claude `ctx.mcpBridge` ever carries
// DATABASE_URL for a brokered run, while a non-brokered (desktop) run stays
// byte-identical to every test above.
// ---------------------------------------------------------------------------
describe("heartbeat MCP delivery: brokered org sandbox dispatch (U4b, S7)", () => {
  const brokeredParams = {
    ...params,
    brokered: true,
    apiBaseUrl: "https://cp.example.test",
  } as const;

  it("claude_local: the staged --mcp-config file carries an HTTP aoa entry, no DATABASE_URL, no postgres://", async () => {
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "claude_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"] },
      params: brokeredParams,
    });

    const written = lastWrittenMcpConfig();
    expect(written.mcpServers.aoa).toMatchObject({
      type: "http",
      url: "https://cp.example.test/companies/company-1/mcp",
    });
    expect((written.mcpServers.aoa as { command?: unknown }).command).toBeUndefined();
    const raw = JSON.stringify(written);
    expect(raw).not.toContain("DATABASE_URL");
    expect(raw).not.toMatch(/postgres(ql)?:\/\//);

    // The non-claude carrier (delivery.mcpBridge) is ALSO brokered-shaped —
    // heartbeat.ts hands this straight to ctx.mcpBridge for every adapter.
    expect(delivery.mcpBridge).toMatchObject({
      kind: "http",
      url: "https://cp.example.test/companies/company-1/mcp",
      authTokenEnvVar: "AOA_API_KEY",
    });
    expect(JSON.stringify(delivery.mcpBridge)).not.toContain("DATABASE_URL");

    await delivery.cleanup();
  });

  it("codex_local (non-claude): ctx.mcpBridge is the HTTP spec, no config file written, no DATABASE_URL anywhere", async () => {
    const delivery = await prepareHeartbeatMcpDelivery({
      adapterType: "codex_local",
      agentId: "agent-1",
      runId: "run-1",
      config: { args: ["--existing"] },
      params: brokeredParams,
    });

    expect(delivery.mcpBridge).toEqual({
      kind: "http",
      url: "https://cp.example.test/companies/company-1/mcp",
      headers: {},
      authTokenEnvVar: "AOA_API_KEY",
    });
    expect(JSON.stringify(delivery.mcpBridge)).not.toContain("DATABASE_URL");
    // Non-claude branch never writes a config file — confirm no leak there either.
    expect(delivery.config).toEqual({ args: ["--existing"] });
  });

  it("desktop (brokered:false / omitted): stdio delivery is byte-identical — DATABASE_URL still present when set", async () => {
    const savedDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://should-be-present:5432/db";
    try {
      const claudeDelivery = await prepareHeartbeatMcpDelivery({
        adapterType: "claude_local",
        agentId: "agent-1",
        runId: "run-1",
        config: { args: ["--existing"] },
        params, // no `brokered` field — undefined/falsy, exactly today's shape
      });
      const written = lastWrittenMcpConfig();
      expect(written.mcpServers.aoa).toMatchObject({
        command: "node",
        env: expect.objectContaining({ DATABASE_URL: "postgres://should-be-present:5432/db" }),
      });
      expect((written.mcpServers.aoa as { type?: unknown }).type).toBeUndefined();
      await claudeDelivery.cleanup();

      const codexDelivery = await prepareHeartbeatMcpDelivery({
        adapterType: "codex_local",
        agentId: "agent-1",
        runId: "run-1",
        config: {},
        params,
      });
      expect(codexDelivery.mcpBridge).toMatchObject({
        command: "node",
        env: expect.objectContaining({ DATABASE_URL: "postgres://should-be-present:5432/db" }),
      });
    } finally {
      if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDbUrl;
    }
  });
});

// U11 (Wave 5 task 3): org heartbeat's `resolveAgentConnectors` call must read
// `sandboxTarget` from the SAME S5 acquisition signal `mcpParams.brokered`
// already uses (`orgAcquired.sandbox?.environment.driver === "sandbox"` —
// never a top-level `orgAcquired.driver`, which is undefined on the real
// `EnvironmentAcquisitionResult` shape).
//
// Structural pinning (reading the source), NOT a driven end-to-end run: this
// repo's established pattern for a caller with no unit harness (see
// provider-key-callers.test.ts and services/internal-agent/aoa-agents/
// __tests__/runner-binding-resolution.test.ts) — heartbeat.ts's org `wakeup()`
// is 5000+ lines and spawns a real adapter subprocess; no existing suite
// drives it end-to-end (every heartbeat*.test.ts here tests pure extracted
// helpers). The crew equivalent (`aoa-runner-brokered-mcp.test.ts`) DOES have
// a harness and asserts the same claim behaviourally, since `runAoaAgent` is
// small enough to mock end-to-end.
describe("U11: org heartbeat sources sandboxTarget from the resolved run driver (S5)", () => {
  const heartbeatSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "services", "heartbeat.ts"),
    "utf8",
  );

  it("derives runTargetsSandbox from orgAcquired.sandbox?.environment.driver (never a top-level orgAcquired.driver)", () => {
    expect(heartbeatSrc).toContain(
      'const runTargetsSandbox = orgAcquired.sandbox?.environment.driver === "sandbox";',
    );
    // S5 anti-drift: a top-level `orgAcquired.driver` READ (as executable
    // code, not prose in a comment) would silently always be undefined (the
    // field lives on `.sandbox.environment`, not the acquisition result
    // itself) and sandboxTarget would be permanently false.
    expect(heartbeatSrc).not.toMatch(/orgAcquired\.driver\s*===/);
  });

  it("threads that SAME variable into the resolveAgentConnectors call's sandboxTarget (not a stray literal)", () => {
    const callIndex = heartbeatSrc.indexOf("const resolved = await resolveAgentConnectors(db, {");
    expect(callIndex).toBeGreaterThan(-1);
    const callEnd = heartbeatSrc.indexOf("});", callIndex);
    expect(callEnd).toBeGreaterThan(callIndex);
    const callBlock = heartbeatSrc.slice(callIndex, callEnd);
    expect(callBlock).toContain("sandboxTarget: runTargetsSandbox,");
  });

  it("mcpParams.brokered (the proven U4b signal) reads the exact same variable — brokered and connector delivery cannot drift apart", () => {
    expect(heartbeatSrc).toContain("brokered: runTargetsSandbox,");
  });
});

// U11 (Wave 5 task 4): the PRE-acquire egress-hosts estimate must be computed
// and threaded into the SAME acquireExecutionContext call whose result later
// feeds sandboxTarget — ordering-driven (loadConnectorEgressHosts' own
// doc-comment): the sandbox is requested before the real, post-acquire
// resolveAgentConnectors call could ever know the final connector set.
// Structural pinning — same rationale as the sandboxTarget suite above.
describe("U11: org heartbeat feeds the pre-acquire egress-hosts estimate into acquireExecutionContext", () => {
  const heartbeatSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "services", "heartbeat.ts"),
    "utf8",
  );

  it("computes orgEgressHosts via loadConnectorEgressHosts, gated on adapterSupportsConnectors", () => {
    expect(heartbeatSrc).toContain(
      "const orgEgressHosts = adapterSupportsConnectors(agent.adapterType)",
    );
    expect(heartbeatSrc).toContain(
      "await loadConnectorEgressHosts(db, { companyId: agent.companyId, agentId: agent.id })",
    );
  });

  it("threads orgEgressHosts into the acquireExecutionContext call's egressAllowlist", () => {
    const callIndex = heartbeatSrc.indexOf("const orgAcquired = await acquireExecutionContext(db, {");
    expect(callIndex).toBeGreaterThan(-1);
    const callEnd = heartbeatSrc.indexOf("});", callIndex);
    expect(callEnd).toBeGreaterThan(callIndex);
    const callBlock = heartbeatSrc.slice(callIndex, callEnd);
    expect(callBlock).toContain("egressAllowlist: orgEgressHosts,");
  });
});
