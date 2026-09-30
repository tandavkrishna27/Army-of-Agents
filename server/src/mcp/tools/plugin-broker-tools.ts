// server/src/mcp/tools/plugin-broker-tools.ts
//
// U10 (Cloud Execution Isolation / E2B, Wave 5) — plugin tool descriptors +
// dispatch for the HTTP MCP broker (mcp/server.ts).
//
// Plugin tools run on a HOST-resident worker process — a forked child
// process on the control-plane host, never inside an E2B-sandboxed VM. A
// sandboxed (or any other) agent run discovers them (tools/list) and calls
// them (tools/call) ONLY through this broker's authz-gated path: a
// company-scoped registry lookup (`pluginToolDispatcher.getTool(name,
// companyId)`) plus a belt-and-suspenders `registered.companyId ===
// companyId` assertion, and strictly agent-actor-only (board/mcp/commander
// cannot call plugin tools over the broker). Only the JSON result of
// `executeTool` crosses back over the broker's HTTP response — the worker
// itself never enters the VM.
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agentProjects, issues } from "@armyofagents/db";
import type { ToolRunContext } from "@armyofagents/plugin-sdk";
import type { AgentToolDescriptor, PluginToolDispatcher } from "../../services/plugin-tool-dispatcher.js";
import {
  TOOL_NAMESPACE_SEPARATOR,
  type RegisteredTool,
  type ToolExecutionResult,
} from "../../services/plugin-tool-registry.js";
import {
  CLOUD_PLUGIN_BLOCK_MESSAGE,
  isCloudPluginExecutionBlocked,
} from "../../services/cloud-plugin-execution.js";
import { recordCloudPluginDispatchDenial } from "../../services/cloud-plugin-dispatch-denial-audit.js";
import { logger } from "../../middleware/logger.js";

const log = logger.child({ service: "plugin-broker-tools" });

function readPluginDispatcher(): PluginToolDispatcher | undefined {
  return (globalThis as { __paperclipPluginToolDispatcher?: PluginToolDispatcher })
    .__paperclipPluginToolDispatcher;
}

/**
 * A plugin tool's namespaced name always contains the
 * `TOOL_NAMESPACE_SEPARATOR` (`":"`), e.g. `"acme.linear:search-issues"`
 * (plugin-tool-registry.ts `buildName`). No internal/outbound MCP tool name
 * used by this broker does — the static `TOOL_DEFINITIONS` list uses dotted
 * names (`"memory.search"`) and the internal `brokerRegistry`
 * (services/internal-agent/tool-registry.ts) uses bare/dashed names — so
 * this is an unambiguous, shared predicate for both the broker's dispatch
 * branch and the §5 anti-drift test (an unrecognized name must still fall
 * through to the existing `-32601` handling, never a silent no-op).
 */
export function isPluginToolName(name: string): boolean {
  return name.includes(TOOL_NAMESPACE_SEPARATOR);
}

/**
 * List a company's plugin tools in MCP tool-definition shape, for the
 * broker's `tools/list` response.
 *
 * Best-effort — mirrors the existing plugin-tool-injection try/catch in
 * heartbeat.ts (~4494-4511): a dispatcher error degrades the tool list
 * (yields `[]`), it never breaks the broker's `tools/list` response.
 */
export function readPluginToolDefinitions(
  companyId: string,
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  try {
    const dispatcher = readPluginDispatcher();
    if (!dispatcher) return [];
    const descriptors: AgentToolDescriptor[] = dispatcher.listToolsForAgent({ companyId });
    return descriptors.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parametersSchema,
    }));
  } catch (err) {
    log.warn(
      { companyId, err },
      "failed to read plugin tool definitions for broker tools/list; continuing without plugin tools",
    );
    return [];
  }
}

/**
 * Best-effort resolution of "the project this run is working in", to
 * satisfy the plugin SDK's `ToolRunContext.projectId` (required — the
 * sandbox never supplies it; it must be resolved host-side).
 *
 * Two-step, most-specific first:
 *   1. The task currently locked to this run: `issues.executionRunId ===
 *      runId` (scoped to `companyId`). `issueService.checkout`
 *      (services/issues.ts ~2196) sets `executionRunId = checkoutRunId` for
 *      BOTH crew ('aoa') and org runs, so this is accurate for the
 *      overwhelming majority of plugin tool calls — an agent mid-task.
 *   2. Falls back to the agent's first assigned project (`agent_projects`)
 *      when no task is currently locked to this run (e.g. a between-tasks
 *      call).
 *   3. `""` if neither resolves.
 *
 * Never throws — a DB hiccup here degrades context enrichment (the plugin
 * tool call itself still proceeds), it must never fail the call outright.
 */
export async function resolvePluginRunProjectId(
  db: Db,
  companyId: string,
  agentId: string,
  runId: string,
): Promise<string> {
  try {
    const [lockedTask] = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.executionRunId, runId)))
      .limit(1);
    if (lockedTask?.projectId) return lockedTask.projectId;

    const [assignment] = await db
      .select({ projectId: agentProjects.projectId })
      .from(agentProjects)
      .where(and(eq(agentProjects.companyId, companyId), eq(agentProjects.agentId, agentId)))
      .limit(1);
    return assignment?.projectId ?? "";
  } catch (err) {
    log.warn(
      { companyId, agentId, runId, err },
      "failed to resolve plugin run projectId; falling back to empty string",
    );
    return "";
  }
}

export type PluginToolCallOutcome =
  | { kind: "forbidden"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "ok"; result: ToolExecutionResult };

/**
 * Dispatch a plugin tool call from the broker to the host-resident worker.
 *
 * Caller (mcp/server.ts) must already have confirmed `isPluginToolName(name)`
 * before calling this — it does not re-check the name shape itself.
 *
 * Ownership is registry data, not a cross-module call: `getTool(name,
 * companyId)` (plugin-tool-dispatcher.ts -> plugin-tool-registry.ts
 * `getTool`) is ALREADY company-scoped — a tool registered under a
 * different company's scope key never matches. The explicit
 * `registered.companyId !== companyId` check is belt-and-suspenders on top
 * of that scoped lookup. This deliberately does NOT import
 * `routes/plugins.ts`'s `resolvePluginInCompany` — that function is a
 * non-exported nested `async function(pluginId, companyId)` closing over
 * route-scoped `registry`/`db` (wrong arity, uncallable from here).
 *
 * companyId/agentId/runId are the caller's responsibility to source from
 * the VERIFIED run-JWT (`ProtocolActor`) — this function trusts whatever
 * it is handed and never reads the request body itself.
 */
export async function dispatchPluginToolCall(input: {
  db: Db;
  companyId: string;
  actorSource: string;
  agentId: string | null;
  runId: string | null;
  name: string;
  args: unknown;
}): Promise<PluginToolCallOutcome> {
  const { db, companyId, actorSource, agentId, runId, name, args } = input;

  // FND-008 (Decision #103 CP-003): plugin tools run on a HOST-resident worker,
  // which is not a tenant boundary. On `cloud_auth` no host-process plugin
  // worker may run (FND-006 composes none), so the broker must fail closed with
  // the typed denial BEFORE resolving the dispatcher, reading the registry, or
  // dispatching to a worker — the earliest possible point, independent of actor.
  // The broker maps `forbidden` to its JSON-RPC denial (mcp/server.ts: 403 /
  // -32003); the message is the stable Decision #103 block reason. In the real
  // hosted parent the dispatcher is also never set, so this is defense-in-depth
  // that holds even if a stale dispatcher were present.
  if (isCloudPluginExecutionBlocked()) {
    // ★ DE-16 dispatch-conjunct, the MCP-agent i-GAP. Record the block durably
    // and attributably ONLY for the fully-attributable agent-run case (real
    // FK-valid company + verified agent + live run) — the exact shape the
    // register names. A non-agent / run-less blocked call is this service's own
    // actor-gate refusal (rejected next, below) and records nothing. Best-effort
    // and on the pool handle (no tenant tx here): the recorder never throws, so
    // it cannot turn the 403 block into a 500. See cloud-plugin-dispatch-denial-audit.ts.
    if (actorSource === "agent" && agentId && runId) {
      await recordCloudPluginDispatchDenial(db, {
        companyId,
        agentId,
        runId,
        toolName: name,
        control: "server/src/mcp/tools/plugin-broker-tools.ts:dispatchPluginToolCall",
      });
    }
    return { kind: "forbidden", message: CLOUD_PLUGIN_BLOCK_MESSAGE };
  }

  // Plugin tools are agent-facing only. board/mcp actors over the broker
  // cannot call them. ("commander" never reaches this route as
  // actorType==="commander" — protocolAuthActor in mcp/server.ts only ever
  // emits "mcp" | "board" | "agent"; see its doc comment.)
  if (actorSource !== "agent") {
    return {
      kind: "forbidden",
      message: `Tool ${name} is not available for ${actorSource} actors`,
    };
  }
  // An agent actor without a live run (e.g. a standalone agent-API-key
  // caller) has no run to attribute execution/cost/audit to and no
  // `ToolRunContext` to build — fail closed rather than pass a null
  // agentId/runId through to the worker.
  if (!agentId || !runId) {
    return {
      kind: "forbidden",
      message: `Tool ${name} requires an active agent run`,
    };
  }

  const dispatcher = readPluginDispatcher();
  const registered: RegisteredTool | null | undefined = dispatcher?.getTool(name, companyId);
  if (!dispatcher || !registered || registered.companyId !== companyId) {
    return { kind: "not_found", message: `Tool ${name} not found` };
  }

  const projectId = await resolvePluginRunProjectId(db, companyId, agentId, runId);
  const runContext: ToolRunContext = { agentId, runId, companyId, projectId };
  // The worker runs HOST-side (plugin-worker-manager.ts); only the JSON
  // result below crosses back over this broker's HTTP response — the
  // worker process never enters the sandboxed VM.
  const result = await dispatcher.executeTool(name, args, runContext);
  return { kind: "ok", result };
}
