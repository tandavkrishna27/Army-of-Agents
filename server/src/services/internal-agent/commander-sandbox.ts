import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import type { Db } from "@armyofagents/db";
import { showRefSchema, type ShowRef } from "@armyofagents/shared";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterExecutionTarget,
  McpBridgeSpec,
  McpHttpServerSpec,
  McpServerSpec,
} from "@armyofagents/adapter-utils";
import { tenantIsolationEnforced } from "../../config/deployment-mode.js";
import {
  acquireExecutionContext,
  type AcquiredExecutionContext,
} from "../acquire-execution-context.js";
import { resolveWarmSandboxPreference } from "../warm-sandbox-policy.js";
import { createCommanderRunJwt } from "../../agent-auth-jwt.js";
import { logger } from "../../middleware/logger.js";
import { StreamJsonParser } from "./parse-stream-json.js";
// NOTE: cli-mode.ts imports from THIS module too (resolveCommanderSandboxContext /
// runCommanderAdapterTurn). The cycle is function-level only — neither module reads
// the other's exports at module-init — so it is ESM-safe (mirrors many sibling
// cycles in this codebase). buildMcpConfig / buildCodexAoaMcpSpec are the SAME
// brokered-MCP builders the crew runner and the host cli-mode path use.
import { buildMcpConfig, buildCodexAoaMcpSpec, type McpConfigParams } from "./cli-mode.js";
import type { AgentStreamChunk } from "./agent-loop.js";

// ── Context resolution (Task 1: acquire + JWT + brokered params + release) ─────

export interface CommanderSandboxContext {
  /** provider-sandbox target with `.runner` — handed straight to `adapter.execute`. */
  executionTarget: AdapterExecutionTarget;
  /** Commander run-JWT → `AOA_API_KEY` in the VM (brokered identity). */
  authToken: string;
  /** Control-plane base URL the brokered `aoa` HTTP entry is built against. */
  apiBaseUrl: string;
  /**
   * Tail of the ATOMIC acquire+brokered+release triad. cli-mode MUST call this in
   * a `finally` on EVERY turn exit (normal return, early return, guard-refuse,
   * throw) or the warm VM leaks. Best-effort + idempotent-safe to await once.
   */
  release: () => Promise<void>;
}

export interface ResolveCommanderSandboxInput {
  companyId: string;
  userId: string;
  userRole: string;
  conversationId: string;
  /** internal_agent_runs id for THIS turn. */
  turnId: string;
  apiBaseUrl: string;
  /** "claude_local" | "codex_local" — provider family the adapter passes to the env allowlist (F4). */
  adapterType: string;
  /** Injected so cli-mode does not import the settings service directly (testability). */
  getExperimental: () => Promise<{ warmCommanderConversations?: boolean }>;
  /** Test-only DI for the leak-prevention release probe. */
  releaseLeaseOverride?: (db: Db, acquired: AcquiredExecutionContext) => Promise<void>;
}

/**
 * Cloud-only: acquire the warm per-conversation sandbox for a Commander turn,
 * mint the Commander run-JWT, and return the execution target + release fn.
 *
 * Returns `null` on self-hosted (tenant isolation not enforced) OR when no
 * platform-default environment resolves — in both cases cli-mode falls back to
 * its byte-identical host-direct spawn.
 *
 * On a resolved sandbox with NO JWT secret the freshly-acquired lease is released
 * and the turn hard-fails (a brokered VM with no token cannot reach the control
 * plane) — never a silent leak.
 */
export async function resolveCommanderSandboxContext(
  db: Db,
  input: ResolveCommanderSandboxInput,
): Promise<CommanderSandboxContext | null> {
  // Self-hosted / local_trusted: the D1 guard is a no-op and Commander spawns
  // host-direct exactly as today. NO acquire happens here (proven by the inverted
  // enforcing test's desktop block).
  if (!tenantIsolationEnforced()) return null;

  const experimental = await input
    .getExperimental()
    .catch(() => ({} as { warmCommanderConversations?: boolean }));
  const warm = resolveWarmSandboxPreference({
    runType: "commander",
    functionType: null,
    agentWarmOverride: null,
    instanceDefaultWarmForSoftwareDev: true, // unused for the commander branch (SC6)
    warmCommanderConversations: experimental.warmCommanderConversations,
  });

  const acquired = await acquireExecutionContext(db, {
    runIdentity: {
      companyId: input.companyId,
      agentId: null, // Commander has no agent row (SC6)
      runId: input.turnId,
      adapterType: input.adapterType,
    },
    functionType: null, // Commander → no functionType (SC6)
    warmPreference: warm.warm,
    worktree: null,
    environmentId: null, // platform default (U1)
    commanderConversationId: input.conversationId,
  });

  const releaseLease = input.releaseLeaseOverride ?? defaultReleaseLease;

  if (!acquired.sandbox) {
    // No platform default (desktop path) — nothing was acquired, host fallback.
    return null;
  }
  if (!acquired.sandbox.configPatch.executionTarget) {
    // A lease WAS acquired but yielded no usable execution target (a malformed
    // platform-default env). Release it so the VM does not leak, then fall back
    // to the host path. (W7.5d review F1.)
    await releaseLease(db, acquired).catch(() => undefined);
    return null;
  }

  // ★ N-2 (security): every JWT claim is derived from the SERVER-SIDE resolved
  // input (the same session-trusted companyId/userId/userRole/conversationId the
  // in-process actor uses), NEVER from a client-supplied request body. user_role
  // gates the commander tool policy — a client-forgeable role would be privilege
  // escalation.
  const authToken = createCommanderRunJwt({
    companyId: input.companyId,
    userId: input.userId,
    userRole: input.userRole,
    conversationId: input.conversationId,
    turnId: input.turnId,
  });
  if (!authToken) {
    // No JWT secret ⇒ the VM cannot reach the broker. Fail loud, and release the
    // lease we just acquired so it does not leak.
    logger.error(
      { companyId: input.companyId, conversationId: input.conversationId },
      "Commander-in-sandbox: JWT secret missing; cannot broker — releasing lease",
    );
    await releaseLease(db, acquired).catch(() => undefined);
    throw new Error(
      "Commander sandbox requires a run-JWT secret (AOA_AGENT_JWT_SECRET/BETTER_AUTH_SECRET).",
    );
  }

  return {
    executionTarget: acquired.sandbox.configPatch.executionTarget,
    authToken,
    apiBaseUrl: input.apiBaseUrl,
    release: () => releaseLease(db, acquired),
  };
}

/**
 * Default lease release — MIRRORS the crew runner's `finally` release
 * (`runner.ts:1794-1804`): a warm (`reuse_by_agent`) Commander lease PAUSES, an
 * ephemeral lease KILLS, both via `releaseRunLease`. Best-effort — a release
 * failure must never mask the turn's own error. No-op when the acquire returned
 * no sandbox (desktop) or a shape without the lease record (the unit-test mock).
 */
async function defaultReleaseLease(db: Db, acquired: AcquiredExecutionContext): Promise<void> {
  const sandbox = acquired?.sandbox;
  if (!sandbox?.lease || !sandbox?.environment) return;
  const { environmentRuntimeService } = await import("../environment-runtime.js");
  await environmentRuntimeService(db)
    .releaseRunLease({
      environment: sandbox.environment,
      lease: sandbox.lease,
      status: "released",
    })
    .catch(() => undefined);
}

// ── Adapter-turn delegation (Task 2: run the in-sandbox CLI via adapter.execute) ─

export interface RunCommanderAdapterTurnInput {
  adapterType: string; // "claude_local" | "codex_local"
  executionTarget: AdapterExecutionTarget; // provider-sandbox
  companyId: string;
  userId: string;
  userRole: string;
  conversationId: string;
  turnId: string;
  authToken: string; // commander JWT → AOA_API_KEY
  apiBaseUrl: string;
  /** The user's message (→ the adapter's rendered prompt / stdin). */
  content: string;
  /** Assembled Commander system context (→ instructionsFilePath, adapter-staged). */
  systemContext: string | null;
  model: string | null;
  /** brokered:true + apiBaseUrl set — used to build the aoa MCP config/spec. */
  mcpParams: McpConfigParams;
  /** External MCP connector specs (→ ctx.mcpServers). */
  connectorSpecs: Record<string, McpServerSpec>;
  connectorEnv: Record<string, string>;
  /** claude → true (stream-json); codex/opencode → false (buffer + parse). */
  useStreamJson: boolean;
}

/** Yielded stream: incremental chunks, then one terminal buffered result. */
export type CommanderAdapterTurnEvent =
  | { kind: "chunk"; chunk: AgentStreamChunk }
  | { kind: "result"; result: AdapterExecutionResult };

/** Minimal adapter surface — the real adapter or a test fake. */
export interface CommanderTurnAdapter {
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
}

/**
 * Delegate the in-sandbox CLI execution to the SAME `adapter.execute` path
 * org/crew use (mirrors `aoa-agents/runner.ts:1134-1163`): the adapter stages
 * the brokered `--mcp-config` (claude) / `config.toml` (codex) into the VM +
 * rewrites arg paths (F3, W7.4) and passes the correct `sandboxProvider` family
 * ("anthropic"/"openai", NOT the E2B infra id — F4). cli-mode never touches MCP
 * staging or the env allowlist.
 *
 * This is an async generator: the adapter's `onLog` stdout is fed into the SAME
 * parser cli-mode's host path uses (StreamJsonParser for claude; codex JSONL
 * buffered + `parseCodexJsonl` on completion — host `runCodexTurn` parity), and
 * `AgentStreamChunk`s are yielded incrementally (SC4 streaming). The buffered
 * `AdapterExecutionResult` is the terminal event (cost/session continuity).
 */
export async function* runCommanderAdapterTurn(
  adapter: CommanderTurnAdapter,
  input: RunCommanderAdapterTurnInput,
): AsyncGenerator<CommanderAdapterTurnEvent> {
  const parser = input.useStreamJson ? new StreamJsonParser() : null;

  // onLog→chunk pump. onLog fires DURING execute; buffer into `pending` and wake
  // the consumer loop. Same shape as streamProcessOutput's pending/notify loop.
  const pending: AgentStreamChunk[] = [];
  let notify: (() => void) | null = null;
  const wake = () => {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  };
  const push = (chunk: AgentStreamChunk) => {
    pending.push(chunk);
    wake();
  };

  // codex: buffer raw JSONL stdout and parse AFTER execute (host runCodexTurn
  // parity — codex streaming is deferred polish; v1 emits the full summary).
  let codexStdout = "";

  const onLog = async (stream: "stdout" | "stderr", chunk: string): Promise<void> => {
    if (stream !== "stdout") return;
    if (parser) {
      for (const c of parser.push(chunk)) push(c);
    } else {
      codexStdout += chunk;
    }
  };

  const { config, mcpBridge, mcpServers, tempFiles } = await buildSandboxAdapterConfig(input);

  const syntheticAgent = {
    id: input.conversationId, // Commander has no agent row — synthesize (SC6)
    companyId: input.companyId,
    name: "Commander",
    adapterType: input.adapterType,
    adapterConfig: config,
  };

  let done = false;
  const resultPromise = (async () => {
    try {
      return await adapter.execute({
        runId: input.turnId,
        agent: syntheticAgent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config,
        context: { currentTaskMarkdown: input.content },
        // provider-sandbox → the adapter passes sandboxProvider:"anthropic"/"openai" (F4).
        executionTarget: input.executionTarget,
        // codex consumes this → config.toml (staged into the VM by W7.4). claude
        // ignores it (uses --mcp-config in extraArgs). Passed to both, mirroring crew.
        mcpBridge,
        mcpServers, // external connectors
        authToken: input.authToken, // → AOA_API_KEY in the VM (brokered identity)
        onLog,
        onMeta: async () => {},
        onSpawn: () => {},
      });
    } finally {
      done = true;
      wake();
    }
  })();
  // Prevent an unhandled rejection if the consumer abandons this generator
  // (.return()) before the `await resultPromise` below — the real error still
  // surfaces via that await on the normal path. (W7.5d review F2.)
  void resultPromise.catch(() => undefined);

  // Consumer loop: yield buffered chunks as they arrive until execute resolves.
  // The `finally` unlinks the host temp files (system-prompt + --mcp-config) that
  // buildSandboxAdapterConfig wrote — on normal completion, a throw, OR consumer
  // abandonment (.return()) — so nothing accumulates on the control-plane host. (W7.5d review F3)
  try {
    while (!done || pending.length > 0) {
      while (pending.length > 0) yield { kind: "chunk", chunk: pending.shift()! };
      if (done) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }

    const result = await resultPromise;

    if (parser) {
      for (const c of parser.flush()) yield { kind: "chunk", chunk: c };
    } else {
      for (const c of await parseCodexBufferedChunks(codexStdout)) {
        yield { kind: "chunk", chunk: c };
      }
    }

    yield { kind: "result", result };
  } finally {
    for (const f of tempFiles) await unlink(f).catch(() => undefined);
  }
}

/**
 * Parse a buffered codex `exec --json` stdout stream into `AgentStreamChunk`s —
 * a faithful reproduction of the host `runCodexTurn` chunk loop
 * (`cli-mode.ts:1706-1790`): per-chunk output-ref revalidation to `ShowRef[]`,
 * the assistant `summary` as a single text delta, and a real-usage `done`.
 */
async function parseCodexBufferedChunks(stdout: string): Promise<AgentStreamChunk[]> {
  const out: AgentStreamChunk[] = [];
  if (!stdout.trim()) return out;
  const { parseCodexJsonl } = await import("@armyofagents/adapter-codex-local/server");
  const parsed = parseCodexJsonl(stdout);

  const toolsCalled = Array.from(
    new Set(
      (parsed.chunks ?? [])
        .filter((chunk) => chunk.type === "tool_call" || chunk.type === "tool_result")
        .map((chunk) => chunk.name)
        .filter(Boolean),
    ),
  );

  for (const chunk of parsed.chunks ?? []) {
    if (chunk.type === "tool_result") {
      const refs: ShowRef[] = (Array.isArray(chunk.refs) ? chunk.refs : []).flatMap((r) => {
        const parsedRef = showRefSchema.safeParse(r);
        return parsedRef.success ? [parsedRef.data] : [];
      });
      out.push({ ...chunk, refs });
    } else {
      out.push(chunk);
    }
  }

  if (parsed.summary) out.push({ type: "text", delta: parsed.summary });

  out.push({
    type: "done",
    summary: {
      runId: "",
      toolsCalled,
      durationMs: 0,
      costCents: 0,
      tokenUsage: {
        inputTokens: parsed.usage?.inputTokens ?? 0,
        outputTokens: parsed.usage?.outputTokens ?? 0,
        cachedInputTokens: parsed.usage?.cachedInputTokens ?? 0,
      },
    },
  });
  return out;
}

/**
 * Build the adapter-shaped config for an in-sandbox Commander turn. The brokered
 * `aoa` MCP is delivered via the SAME channels org/crew use — claude:
 * `buildMcpConfig` → host temp `--mcp-config` file injected into `extraArgs`
 * (the adapter stages it into the VM + rewrites the arg, W7.4); codex:
 * `buildCodexAoaMcpSpec` as `mcpBridge` (the adapter writes + stages config.toml,
 * W7.4). NO bespoke cli-mode MCP staging, NO inline-mcp-config fallback.
 */
async function buildSandboxAdapterConfig(input: RunCommanderAdapterTurnInput): Promise<{
  config: Record<string, unknown>;
  mcpBridge: McpBridgeSpec | McpHttpServerSpec | undefined;
  mcpServers: Record<string, McpServerSpec>;
  tempFiles: string[]; // host temp files the caller must unlink after the turn (F3)
}> {
  // System context → a HOST temp file passed as config.instructionsFilePath. The
  // adapter reads it, stages it into the VM, and rewrites the arg to the remote
  // path (F3 fix for the system prompt, for free). NOTE: the adapter emits
  // --append-system-prompt-file (APPEND to claude's default) where the host
  // cli-mode path used --system-prompt-file (REPLACE) to shield the user's global
  // CLAUDE.md; in a clean VM there is no user global CLAUDE.md so append is
  // acceptable/safer. [flagged for review]
  const tempFiles: string[] = [];
  let instructionsFilePath: string | undefined;
  if (input.systemContext && input.systemContext.trim().length > 0) {
    instructionsFilePath = join(
      tmpdir(),
      `aoa-commander-sys-${sanitize(input.companyId)}-${sanitize(input.turnId)}.md`,
    );
    await writeFile(instructionsFilePath, input.systemContext, "utf8");
    tempFiles.push(instructionsFilePath);
  }

  const baseConfig: Record<string, unknown> = {
    command: input.adapterType === "codex_local" ? "codex" : "claude",
    ...(input.model ? { model: input.model } : {}),
    dangerouslySkipPermissions: true, // Commander runs skip-permissions (host parity)
    promptTemplate: "{{context.currentTaskMarkdown}}",
    ...(instructionsFilePath ? { instructionsFilePath } : {}),
    // Connector secrets ride the delivered config.env (never the config FILE).
    ...(Object.keys(input.connectorEnv).length > 0 ? { env: { ...input.connectorEnv } } : {}),
  };

  // Provider-neutral brokered aoa spec (HTTP form when brokered — no DATABASE_URL).
  const bridgeSpec = buildCodexAoaMcpSpec(input.mcpParams);

  if (input.adapterType === "codex_local") {
    // codex has no --mcp-config flag; it discovers MCP from CODEX_HOME/config.toml.
    // The adapter writes [mcp_servers.aoa] from ctx.mcpBridge and (W7.4) stages the
    // managed config.toml into the remote CODEX_HOME.
    return { config: baseConfig, mcpBridge: bridgeSpec, mcpServers: input.connectorSpecs, tempFiles };
  }

  // claude: write the brokered aoa --mcp-config JSON to a host temp file and inject
  // `--mcp-config <path> --strict-mcp-config` into extraArgs — EXACTLY the crew
  // pattern (runner.ts:794-811). The adapter (W7.4) stages the file into the VM +
  // rewrites the arg to the remote path. Re-add --include-partial-messages for
  // partial-token streaming fidelity (the adapter's buildClaudeArgs omits it).
  const mcpConfigPath = join(
    tmpdir(),
    `aoa-commander-mcp-${sanitize(input.companyId)}-${sanitize(input.turnId)}.json`,
  );
  await writeFile(mcpConfigPath, JSON.stringify(buildMcpConfig(input.mcpParams), null, 2), "utf8");
  tempFiles.push(mcpConfigPath);
  return {
    config: {
      ...baseConfig,
      extraArgs: [
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
        "--include-partial-messages",
      ],
    },
    // Harmless for claude (the adapter ignores mcpBridge, uses --mcp-config);
    // passed for parity with the crew call site.
    mcpBridge: bridgeSpec,
    mcpServers: input.connectorSpecs,
    tempFiles,
  };
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
