import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpHttpServerSpec, McpServerSpec } from "@armyofagents/adapter-utils";
import {
  buildCodexAoaMcpSpec,
  buildMcpConfig,
  type McpBridgeSpec,
  type McpConfigParams,
} from "./internal-agent/cli-mode.js";
import { stripUserMcpArgs } from "./mcp-arg-sanitize.js";

export interface HeartbeatMcpDelivery {
  config: Record<string, unknown>;
  /**
   * U4b (S7): brokered (E2B-sandboxed) org heartbeat runs get the HTTP-shaped
   * `aoa` server (no DATABASE_URL) here instead of the stdio
   * `McpBridgeSpec` — see `buildCodexAoaMcpSpec`. Non-brokered runs are
   * byte-identical to before.
   */
  mcpBridge: McpBridgeSpec | McpHttpServerSpec;
  /**
   * The resolved connector specs, echoed back for the caller to hand to the
   * adapter on `AdapterExecutionContext.mcpServers`. `claude_local` does NOT
   * need this (it already gets the servers through the generated
   * `--mcp-config` file), but every other CLI adapter has its own config
   * surface and must receive the specs structurally. Passed through unchanged —
   * this function never mutates or filters it.
   */
  extraMcpServers?: Record<string, McpServerSpec>;
  cleanup: () => Promise<void>;
}

/**
 * Merge connector tokens into a delivered adapter config's `env`.
 *
 * REGRESSION GUARD: only touch `config.env` when connectors actually exist. The
 * no-connectors path must deliver a config byte-identical to before connectors
 * existed — spreading an absent/undefined `config.env` would coerce it to `{}`
 * and change the shape. Connector secrets ride in the spawn env (each adapter
 * copies `config.env` into the child process env), NOT in any config FILE,
 * which only holds `${AOA_MCP_*_TOKEN}` placeholders. The connector map is
 * merged AFTER `config.env` so a connector token can never be shadowed by an
 * existing key of the same name.
 */
function connectorEnvMergeFor(
  config: Record<string, unknown>,
  connectorEnv: Record<string, string> | undefined,
): { env: Record<string, string> } | Record<string, never> {
  if (!connectorEnv || Object.keys(connectorEnv).length === 0) return {};
  return {
    env: {
      ...(config.env as Record<string, string> | undefined),
      ...connectorEnv,
    },
  };
}

/**
 * Minimum task-work surface exposed to an organization-agent heartbeat run.
 *
 * Includes the read-only memory-retrieval tool `query_memory` so a running org
 * agent can actually RETRIEVE company memory — the enterprise-memory model's
 * primary ORG delivery path (context.memory is not read by the live CLI template;
 * agents fetch on demand). NOTE the name: agents talk to the **internal-agent**
 * tool registry (`createToolRegistry` → `query_memory`, `requiredRole:team_member`,
 * no confirmation), NOT the external MCP-server registry (`memory.search`). Without
 * this the agent's session has no memory tool at all and it cannot answer a
 * "recall X from memory" task.
 */
export const ORG_HEARTBEAT_TOOL_ALLOWLIST = [
  "get_task",
  "get_heartbeat_context",
  "post_task_comment",
  "attach_task_artifact",
  "set_task_status",
  "ask_human",
  "ask_founder",
  "query_memory",
] as const;

/**
 * Coarse capability gate for organization-agent heartbeat runs. Paired with
 * `ORG_HEARTBEAT_TOOL_ALLOWLIST` above — the allowlist is the fine per-tool
 * gate, this is the second-line-of-defense category gate
 * (`authorize-tool.ts` `CAPABILITY_TO_CATEGORY`). Extracted to a named export
 * (Wave 1 E2B broker review, FIX A) so the broker's ToolContext resolver
 * (`server/src/mcp/broker-tool-context.ts`) can import the SAME set an org
 * agent gets on the stdio heartbeat path instead of re-deriving or
 * hardcoding a second copy.
 */
export const ORG_HEARTBEAT_ENABLED_CAPABILITIES = [
  "discussion_processing",
  "system_actions",
  "memory_management",
] as const;

export function resolveHeartbeatEffectiveAutonomy(input: {
  companyAutonomyLevel: number | null | undefined;
  discussionAutonomyLevel: number | null | undefined;
}): number {
  const resolved = input.discussionAutonomyLevel ?? input.companyAutonomyLevel ?? 0;
  return resolved === 1 || resolved === 2 ? resolved : 0;
}

export async function prepareHeartbeatMcpDelivery(input: {
  adapterType: string;
  agentId: string;
  runId: string;
  config: Record<string, unknown>;
  params: McpConfigParams;
  /**
   * External MCP connector specs (server name -> spec), built by
   * `buildConnectorSpecs` at the heartbeat call site. For `claude_local` these
   * are spliced into the generated `--mcp-config` file alongside `aoa`
   * (reserved-name + null-prototype safe: the actual merge is
   * `mergeExternalMcpServers` inside `buildMcpConfig`). For every other
   * connector-capable adapter they are echoed on the result as
   * `extraMcpServers` for delivery via `ctx.mcpServers`.
   */
  extraMcpServers?: Record<string, McpServerSpec>;
  /**
   * `AOA_MCP_<NAME>_TOKEN -> real secret` map from `buildConnectorSpecs`. Merged
   * into the DELIVERED `config.env` (never into any config FILE) for EVERY
   * adapter, so the spawned CLI's process env carries the tokens that the
   * connector specs reference as `${AOA_MCP_*_TOKEN}` placeholders.
   */
  connectorEnv?: Record<string, string>;
}): Promise<HeartbeatMcpDelivery> {
  // U4b: buildCodexAoaMcpSpec is the brokered-aware selector (despite the
  // name, provider-neutral — see its JSDoc). `input.params.brokered` is set
  // by the heartbeat call site from the org run's acquired sandbox lease
  // (heartbeat.ts). A brokered run gets the HTTP `aoa` spec (no
  // DATABASE_URL) here for every non-claude adapter's `ctx.mcpBridge`;
  // non-brokered falls through to the unchanged stdio buildMcpBridgeSpec
  // bridge, byte-identical to before this wave.
  const mcpBridge = buildCodexAoaMcpSpec(input.params);
  if (input.adapterType !== "claude_local") {
    // Non-`claude_local` path. These adapters do NOT understand claude's
    // `--mcp-config <file>`, so no config file is written and argv is left
    // untouched. What they DO get (Plan 2b Task 3) is both halves of the
    // connector delivery:
    //   - `connectorEnv` merged into `config.env`, which every adapter copies
    //     into its child's spawn env (codex/opencode/gemini execute.ts), so the
    //     real `AOA_MCP_*_TOKEN` values reach the CLI; and
    //   - `extraMcpServers` echoed on the result, for the caller to place on
    //     `AdapterExecutionContext.mcpServers`.
    // The env is only merged when connectors exist, so an agent with none gets
    // a byte-identical delivery to before connectors existed.
    return {
      config: { ...input.config, ...connectorEnvMergeFor(input.config, input.connectorEnv) },
      mcpBridge,
      extraMcpServers: input.extraMcpServers,
      cleanup: async () => undefined,
    };
  }

  const configPath = path.join(
    tmpdir(),
    `aoa-heartbeat-mcp-${input.agentId}-${input.runId}.json`,
  );
  await fs.writeFile(
    configPath,
    JSON.stringify(
      buildMcpConfig({ ...input.params, extraMcpServers: input.extraMcpServers }),
      null,
      2,
    ),
    "utf8",
  );
  const argKey = Array.isArray(input.config.extraArgs) ? "extraArgs" : "args";
  const existingArgs = Array.isArray(input.config[argKey])
    ? input.config[argKey].filter((value): value is string => typeof value === "string")
    : [];

  const deliveredConfig: Record<string, unknown> = {
    ...input.config,
    // Strip any user-typed --mcp-config/--strict-mcp-config from the user tail
    // ONLY (Task 12). AoA's own flags below are prepended AFTER the strip and
    // must never pass through stripUserMcpArgs — doing so would delete AoA's own
    // config and break every claude_local MCP run.
    [argKey]: ["--mcp-config", configPath, "--strict-mcp-config", ...stripUserMcpArgs(existingArgs)],
  };

  // Same gated shape as the non-claude branch above — see connectorEnvMergeFor.
  Object.assign(deliveredConfig, connectorEnvMergeFor(input.config, input.connectorEnv));

  return {
    config: deliveredConfig,
    mcpBridge,
    // Echoed for the caller's `ctx.mcpServers`. claude_local's own delivery is
    // the `--mcp-config` file written above; this is purely additive.
    extraMcpServers: input.extraMcpServers,
    cleanup: async () => {
      await fs.unlink(configPath).catch(() => undefined);
    },
  };
}
