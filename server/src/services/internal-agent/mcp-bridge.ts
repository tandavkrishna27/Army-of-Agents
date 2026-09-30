import type { AgentTool, ToolContext, ToolResult } from "./types.js";
import type { CommanderToolPermissions, ShowRef } from "@armyofagents/shared";
// Type-only import (erased at compile time → no runtime side effect, preserves
// the side-effect-free module load for consumers of the tool-layer exports).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildOutputRefs } from "./output-refs.js";
import { authorizeToolInvocation, resolveCommanderToolPolicy } from "./authorize-tool.js";
import { parseCommanderContextScopeJson } from "./context-scope.js";
import { filterAuthorizedToolsForContext } from "./tool-registry.js";

// Re-export so consumers (and existing tests) can import this from mcp-bridge
// where the function used to live before it moved to tool-registry.
export { filterAuthorizedToolsForContext };
import { runtimeApprovalService } from "./runtime-approvals.js";
import { createInFlightCounter, startParentWatchdog } from "./bridge-lifecycle.js";

export function parseCommanderContextScopeEnv() {
  return parseCommanderContextScopeJson(process.env.AOA_COMMANDER_CONTEXT_SCOPE);
}

function parseThreadFreshnessEnv() {
  const raw = process.env.AOA_THREAD_FRESHNESS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ToolContext["threadFreshness"]
      : null;
  } catch {
    return null;
  }
}

function parseHumanQuestionCapabilitiesEnv(): ToolContext["humanQuestionCapabilities"] {
  const raw = process.env.AOA_HUMAN_QUESTION_CAPABILITIES;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.mode === "ask_and_park" && parsed.preservesProducerInvocationId === true) {
      return { mode: "ask_and_park", preservesProducerInvocationId: true };
    }
    if (
      parsed.mode === "live_relay"
      && parsed.preservesProducerInvocationId === true
      && parsed.pauseDeadline === true
      && parsed.resumeSession === true
      && parsed.cancelWait === true
    ) {
      return {
        mode: "live_relay",
        preservesProducerInvocationId: true,
        pauseDeadline: true,
        resumeSession: true,
        cancelWait: true,
      };
    }
  } catch {
    // Fail closed below.
  }
  return undefined;
}

// ── Tool Call Handler (pure, testable) ──────────────────────────────────────

interface ToolCallHandlerDeps {
  tools: AgentTool[];
  executeTool: (tool: AgentTool, params: unknown, ctx: ToolContext) => Promise<ToolResult>;
  toolContext: ToolContext;
  runtimeApprovals?: Pick<
    ReturnType<typeof runtimeApprovalService>,
    "createPending" | "findTrustedExact"
  >;
}

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null
    ? (args as Record<string, unknown>)
    : {};
}

// Per-ref ordering allocator. The bridge is a per-turn subprocess (it
// respawns/exits each turn), so this counter is effectively per-turn — an
// ordering hint, not a global key. Resetting on restart is acceptable.
let refSeqCounter = 0;
const nextSeq = (): number => refSeqCounter++;

async function executeAndFormat(
  tool: AgentTool,
  args: unknown,
  deps: ToolCallHandlerDeps,
  toolContext = deps.toolContext,
): Promise<McpToolResult> {
  try {
    const result = await deps.executeTool(tool, args, toolContext);
    let outputRefs: ShowRef[] = [];
    try {
      // Provenance built here where toolContext is in scope. entityId is the
      // Commander conversation; null → the builder emits provenance: null.
      // seq is allocated PER REF inside buildOutputRefs via nextSeq().
      const provenanceBase = {
        surface: "commander" as const,
        entityId: toolContext.contextScope?.conversationId ?? null,
        runId: toolContext.runId ?? null,
        agentId: toolContext.agentId ?? null,
        messageId: null,
        emittedAt: new Date().toISOString(),
      };
      outputRefs = buildOutputRefs(tool.name, args, result, { provenanceBase, nextSeq });
    } catch (err) {
      outputRefs = []; // ref extraction must never fail the tool call
      process.stderr.write(
        `MCP Bridge: buildOutputRefs('${tool.name}') failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: result.success,
            data: result.data,
            summary: result.summary,
            ...(result.error ? { error: result.error } : {}),
            ...(outputRefs.length > 0 ? { outputRefs } : {}),
          }),
        },
      ],
      isError: !result.success,
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Tool execution error: ${err?.message ?? "Unknown"}` }],
      isError: true,
    };
  }
}

export function createToolCallHandler(deps: ToolCallHandlerDeps) {
  return async function handleToolCall(
    name: string,
    args: unknown,
    producerInvocationId?: string,
  ): Promise<McpToolResult> {
    const tool = deps.tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: '${name}'. Available: ${deps.tools.map((t) => t.name).join(", ")}` }],
        isError: true,
      };
    }

    // T8 Defect B: the Commander policy layer (commanderToolPermissions +
    // runtime-approval / ⚡CONFIRM gate) applies ONLY to the Commander actor —
    // mirroring the tools/list gate in filterAuthorizedToolsForContext
    // (tool-registry.ts) so listing and calling agree. Every other actor (crew
    // 'aoa', org) is judged by the base gate (allowlist + role + capability)
    // alone. Crew has no confirm route, so a Commander approval marker would
    // strand the tool; the base gate is exactly the enforcement crew needs.
    const policy = deps.toolContext.actorType === "commander"
      ? resolveCommanderToolPolicy(tool, deps.toolContext)
      : authorizeToolInvocation(
          tool,
          deps.toolContext.userRole,
          deps.toolContext.enabledCapabilities,
          { agentKind: deps.toolContext.agentKind, toolAllowlist: deps.toolContext.toolAllowlist },
        );
    if (!policy.allowed) {
      // Include both the error code (e.g., NOT_IN_ALLOWLIST, FORBIDDEN_ROLE,
      // CAPABILITY_DISABLED) and the human-readable summary so callers/tests
      // can parse the failure type and humans see the explanation. Both denied
      // decision shapes carry required `error`/`summary`, so the access is
      // always type-valid; the `error ? … : summary` else branch is dead
      // (error is always a truthy literal on a denied decision) but kept for
      // defensiveness. Destructured here for readability.
      const { error, summary } = policy;
      return {
        content: [{ type: "text", text: error ? `${error}: ${summary}` : summary }],
        isError: true,
      };
    }

    const invocationContext = producerInvocationId
      ? { ...deps.toolContext, producerInvocationId }
      : deps.toolContext;

    // Runtime approval is a Commander-only path — key it on the SAME actor
    // discriminator as the gate selection above (and the two gates in
    // tool-registry.ts) rather than on the mere absence of a `requiresApproval`
    // field. Crew/org have no confirm route, so this MUST NOT depend on the
    // base decision's shape: if a future refactor added `requiresApproval` to
    // ToolAuthDecision, an `in`-only check would silently re-strand crew tools
    // with no compile error and no failing test.
    const requiresApproval =
      deps.toolContext.actorType === "commander" &&
      "requiresApproval" in policy &&
      policy.requiresApproval;
    if (!requiresApproval) {
      return executeAndFormat(tool, args, deps, invocationContext);
    }

    const params = normalizeToolArgs(args);
    const approvalSvc = deps.runtimeApprovals ?? runtimeApprovalService(deps.toolContext.db);
    const trusted = await approvalSvc.findTrustedExact({
      companyId: deps.toolContext.companyId,
      userId: deps.toolContext.userId,
      toolName: name,
      params,
    });

    if (trusted) {
      return executeAndFormat(tool, args, deps, invocationContext);
    }

    const approval = await approvalSvc.createPending({
      companyId: deps.toolContext.companyId,
      // The Commander conversation id lives on contextScope (same source the
      // non-gated emission uses for provenance at L107). The ToolContext has no
      // top-level `conversationId`, so reading it directly stored null — which
      // left the approved tool's result with no conversation to attach output
      // refs to (the confirm route guards on a non-null conversationId), so
      // approval-gated writes emitted no viewer nav chip.
      conversationId:
        deps.toolContext.contextScope?.conversationId ??
        deps.toolContext.conversationId ??
        null,
      runId: deps.toolContext.runId ?? null,
      userId: deps.toolContext.userId,
      toolName: name,
      params,
    });

    const marker = `⚡CONFIRM:${JSON.stringify({
      toolName: name,
      params,
      confirmId: approval.id,
      action: "runtime_tool_approval",
      description: tool.description,
    })}⚡ This action requires your approval before I can proceed.`;

    return {
      content: [{ type: "text", text: marker }],
      isError: false,
    };
  };
}

export function buildToolListResponse(tools: AgentTool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
}

// ── Stdout Guard ─────────────────────────────────────────────────────────────

/**
 * Reroute console.* (which writes to stdout) to stderr. The SDK StdioServerTransport
 * owns process.stdout for protocol frames; a stray console.log would inject a
 * non-JSON line and corrupt framing. Returns a restore fn (used only in tests;
 * the bridge process keeps the guard for its whole lifetime).
 */
export function installStdoutGuard(): () => void {
  const orig = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  const toErr = (...a: unknown[]) => { process.stderr.write(a.map(String).join(" ") + "\n"); };
  console.log = toErr; console.info = toErr; console.debug = toErr; console.warn = toErr;
  return () => { Object.assign(console, orig); };
}

// ── Main (runs when executed as script) ─────────────────────────────────────

export async function startBridge(): Promise<void> {
  installStdoutGuard();

  // ── Global fatal handlers (loud, not silent) ──────────────────────────────
  // Per-tool errors are already isolated in executeAndFormat — a process-level
  // unhandledRejection or uncaughtException is genuinely unexpected. Log loudly
  // to stderr so it appears in the parent CLI's process log; do NOT swallow it.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`MCP Bridge fatal unhandledRejection: ${String((reason as any)?.stack ?? reason)}\n`);
    // A process-level rejection is genuinely unexpected (per-tool errors are
    // isolated in executeAndFormat). Fail LOUD: exit so the parent CLI sees the
    // bridge die and the loud-failure detector marks the run failed, rather than
    // limping on in an undefined state. Distinct from the watchdog (exit 0).
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`MCP Bridge fatal uncaughtException: ${(err as any)?.stack ?? err}\n`);
    process.exit(1);
  });

  const companyId = process.env.AOA_SESSION_COMPANY_ID;
  const userId = process.env.AOA_SESSION_USER_ID;
  const userRole = process.env.AOA_SESSION_USER_ROLE;
  if (!userRole) {
    process.stderr.write("MCP Bridge: Missing AOA_SESSION_USER_ROLE env var\n");
    process.exit(1);
  }

  if (!companyId || !userId) {
    process.stderr.write("MCP Bridge: Missing AOA_SESSION_COMPANY_ID or AOA_SESSION_USER_ID\n");
    process.exit(1);
  }

  const enabledCapabilities = (process.env.AOA_SESSION_ENABLED_CAPABILITIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const agentKind = process.env.AOA_AGENT_KIND || undefined;
  const toolAllowlist = (process.env.AOA_TOOL_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const actorType = process.env.AOA_ACTOR_TYPE ?? "board";

  // P2.0: Calling agent's ID and effective autonomy level
  const agentId = process.env.AOA_AGENT_ID || undefined;
  const runId = process.env.AOA_RUN_ID || null;
  const humanQuestionCapabilities = parseHumanQuestionCapabilitiesEnv();
  const discussionRunModeRaw = process.env.AOA_DISCUSSION_RUN_MODE;
  const discussionRunMode =
    discussionRunModeRaw === "controller_action_gate" || discussionRunModeRaw === "direct"
      ? discussionRunModeRaw
      : null;
  const threadFreshness = parseThreadFreshnessEnv();
  const effectiveAutonomyRaw = process.env.AOA_EFFECTIVE_AUTONOMY;
  const effectiveAutonomy = effectiveAutonomyRaw ? parseInt(effectiveAutonomyRaw, 10) : null;
  const contextScope = parseCommanderContextScopeEnv();

  const { createDb, internalAgentConfig } = await import("@armyofagents/db");
  const { eq } = await import("drizzle-orm");
  const { createServiceContainer } = await import("./service-container.js");
  const { createToolRegistry, executeTool } = await import("./tool-registry.js");

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    process.stderr.write("MCP Bridge: Missing DATABASE_URL\n");
    process.exit(1);
  }
  const db = createDb(dbUrl);
  const services = createServiceContainer(db);
  const tools = createToolRegistry();

  const config = await db
    .select()
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .then((rows) => rows[0] ?? null);

  const toolContext: ToolContext = {
    companyId,
    userId,
    userRole,
    enabledCapabilities,
    agentKind,
    toolAllowlist,
    actorType,
    agentId,
    runId,
    humanQuestionCapabilities,
    discussionRunMode,
    threadFreshness,
    effectiveAutonomy,
    commanderToolPermissions:
      (config?.commanderToolPermissions as CommanderToolPermissions | null | undefined) ?? null,
    runtimeApprovalsEnabled: config?.runtimeApprovalsEnabled ?? true,
    contextScope,
    db,
    services,
  };
  const handleToolCall = createToolCallHandler({ tools, executeTool, toolContext });

  const inFlight = createInFlightCounter();

  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const server = new Server(
    { name: "aoa-mcp-bridge", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const visibleTools = filterAuthorizedToolsForContext(tools, toolContext);
    return { tools: buildToolListResponse(visibleTools) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    inFlight.enter();
    try {
      // handleToolCall already returns { content, isError } and never throws.
      // That shape IS a valid CallToolResult at runtime (the SDK validates it
      // against CallToolResultSchema). The cast pins it to that union member
      // (vs. the task-creation branch) and bridges the named-interface →
      // index-signature gap; it is sound, not a widening lie.
      const result = await handleToolCall(
        req.params.name,
        req.params.arguments ?? {},
        `mcp:${String(extra.requestId)}`,
      );
      return result as CallToolResult;
    } finally {
      inFlight.leave();
    }
  });

  const transport = new StdioServerTransport();
  // Wire transport-level errors to stderr for observability. These are malformed/
  // partial frames, EPIPE, etc. — not tool errors, which are isolated separately.
  // Do NOT call process.exit here: a parse error carries id:null so a JSON-RPC
  // reply is useless to the client; logging is the right response level.
  transport.onerror = (err) => {
    process.stderr.write(`MCP Bridge transport error: ${(err as any)?.stack ?? String(err)}\n`);
  };
  await server.connect(transport);

  // LIFECYCLE (branch B): do NOT exit on stdin EOF. The parent-liveness watchdog
  // is the SOLE terminator — it fires only when the spawning provider CLI is gone,
  // and never while a tool call is in flight. This survives a client half-closing
  // stdin per request-batch and avoids any SDK "response flushed after handler
  // returns" race: the process stays alive long enough to send the response.
  // Intentionally NO transport.onclose -> process.exit.
  startParentWatchdog({
    getInFlight: () => inFlight.count,
    onDead: () => {
      // inFlight covers handler execution, but the SDK sends the JSON-RPC
      // response AFTER the handler returns (its protocol layer). Flush any
      // pending stdout — a response frame still mid-write — before exiting, so a
      // watchdog fire (esp. a false-dead PPID probe) can't drop an in-flight
      // response. Fallback timeout so we never hang if the reader is truly gone
      // (a dead parent's pipe never drains).
      let exited = false;
      const exit = () => { if (!exited) { exited = true; process.exit(0); } };
      process.stdout.write("", exit);
      setTimeout(exit, 1000).unref();
    },
  });
}

const isMainModule = process.argv[1]?.endsWith("mcp-bridge.js") ||
  process.argv[1]?.endsWith("mcp-bridge.ts");
if (isMainModule) {
  startBridge().catch((err) => {
    process.stderr.write(`MCP Bridge fatal: ${err.message}\n`);
    process.exit(1);
  });
}
