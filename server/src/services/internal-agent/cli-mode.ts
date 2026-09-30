import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@armyofagents/db";
import { showRefSchema } from "@armyofagents/shared";
import type { HumanQuestionRuntimeCapabilities } from "@armyofagents/adapter-utils";
import {
  mergeExternalMcpServers,
  withSynthesizedBearerHeader,
  aoaSecretPlaceholderFor,
  brokeredAoaHttpEntry,
  type McpHttpServerSpec,
  type McpServerSpec,
} from "@armyofagents/adapter-utils";
import type { AgentTool } from "./types.js";
import type { AgentStreamChunk, ChatInput } from "./agent-loop.js";
import { createCLISessionStore } from "./cli-session-store.js";
import type { CLISession } from "./cli-session-store.js";
import {
  normalizeCommanderContextScope,
  type NormalizedCommanderContextScope,
} from "./context-scope.js";
import { StreamJsonParser } from "./parse-stream-json.js";
import { COMMANDER_MAX_THINKING_TOKENS } from "./thinking-config.js";
import {
  resolveCodexChatModel,
  COMMANDER_CODEX_REASONING_EFFORT,
  SAFE_MODEL_RE,
} from "./codex-model.js";
import { logger } from "../../middleware/logger.js";
import { redactSecretsInString } from "../../redaction.js";
import { resolveAgentConnectors } from "../mcp-connectors-loader.js";
import { buildScrubbedCliEnv } from "../cli-spawn-safety.js";
import { mergeConnectorEnv } from "../mcp-connectors-env.js";
import { tenantIsolationEnforced } from "../../config/deployment-mode.js";
import { assertUnsandboxedMultitenantAllowed } from "../unsandboxed-multitenant-guard.js";
import { getServerAdapter } from "../../adapters/registry.js";
import { instanceSettingsService } from "../instance-settings.js";
import { resolveCommanderSandboxContext, runCommanderAdapterTurn } from "./commander-sandbox.js";
import type { CommanderSandboxContext } from "./commander-sandbox.js";
import { recordDistributedShadow, type ShadowSinkInput } from "../distributed-shadow-port.js";

const require = createRequire(import.meta.url);

/** Control-plane base URL the brokered `aoa` HTTP entry is built against inside
 *  a Commander sandbox VM. The control plane's own address is the platform's,
 *  read straight off the server process env (mirrors the crew runner's
 *  `mcpParams.apiBaseUrl = process.env.AOA_API_URL`). */
function resolveCommanderApiBaseUrl(): string {
  return process.env.AOA_API_URL ?? "";
}

/** The single-`done` fallback chunk used when a rerouted sandbox turn produced
 *  no real `done` (mirrors the inline host-path fallbacks). */
function commanderDoneFallback(): AgentStreamChunk {
  return {
    type: "done",
    summary: {
      runId: "",
      toolsCalled: [],
      durationMs: 0,
      costCents: 0,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
    },
  };
}

/**
 * Decide what to do when Commander's per-session provider-credential resolution
 * throws. Pure (matches the repo's pure-function test pattern) so the fail-closed
 * decision can be unit-tested directly.
 *
 * Returns `{}` (degrade to the operator's ambient host login) ONLY on a
 * self-hosted single-tenant install. Throws (fail closed) when:
 *   - tenant isolation is enforced (cloud_auth / multi_tenant) — EVERY error
 *     rethrows so Commander NEVER borrows the operator's `~/.claude` / `~/.codex`
 *     login on a shared host; or
 *   - the error is `provider_unavailable` — self-hosted still surfaces an explicit
 *     provider-unavailable failure rather than silently borrowing the host login.
 *
 * The caller logs the "using host login" warning only on the return-`{}` path
 * (this helper rethrows before that point on the fail-closed path).
 */
export function handleCommanderResolveError(
  err: unknown,
  opts: { tenantIsolationEnforced: boolean },
): Record<string, string> {
  const isProviderUnavailable =
    !!err &&
    typeof err === "object" &&
    (err as { code?: string }).code === "provider_unavailable";
  if (opts.tenantIsolationEnforced || isProviderUnavailable) {
    throw err;
  }
  return {};
}

/** claude CLI: pass --model only for a shell-safe non-empty model; else nothing,
 *  so the default path's argv stays byte-identical. */
export function claudeModelArgs(model: string | null | undefined): string[] {
  const m = model?.trim() ?? "";
  return m && SAFE_MODEL_RE.test(m) ? ["--model", m] : [];
}

function normalizeCliContextScope(
  scope: ChatInput["contextScope"] | undefined,
): NormalizedCommanderContextScope | null {
  return scope ? normalizeCommanderContextScope({ contextScope: scope }) : null;
}

// ── Session ID Validation ─────────────────────────────────────────────────────

// Validate session IDs from external process output before using them as spawn args.
// On Windows, spawn uses shell:true so metacharacters in args execute as shell commands.
const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function validateSessionId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return SAFE_SESSION_ID_RE.test(raw) ? raw : null;
}

// ── CLI Detection ─────────────────────────────────────────────────────────────

// Maps config values (from DB/constants) to binary names
const CLI_BINARY_MAP: Record<string, string> = {
  claude_cli: "claude",
  codex: "codex",
  opencode: "opencode",
};

export interface CLIDetectionResult {
  available: boolean;
  path?: string;
  error?: string;
}

export async function detectCliTool(tool: string): Promise<CLIDetectionResult> {
  const binary = CLI_BINARY_MAP[tool];
  if (!binary) {
    return {
      available: false,
      error: `Unsupported CLI tool: '${tool}'. Supported: ${Object.keys(CLI_BINARY_MAP).join(", ")}`,
    };
  }

  const cmd = platform() === "win32" ? `where ${binary}` : `which ${binary}`;

  try {
    const result = execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim();
    const firstLine = result.split("\n")[0].trim();
    return { available: true, path: firstLine };
  } catch {
    return {
      available: false,
      error: `CLI tool '${tool}' (binary: '${binary}') not found in PATH. Install the CLI and ensure it's on your PATH, then try again.`,
    };
  }
}

// ── MCP Config Builder ────────────────────────────────────────────────────────

export interface McpConfigParams {
  companyId: string;
  userId: string;
  userRole: string;
  enabledCapabilities: readonly string[];
  bridgeEntrypoint: string;
  /** D2: kind of the calling agent ('aoa' triggers tool allowlist gate) */
  agentKind?: string;
  /** D2: explicit tool allowlist for AoA agents (comma-separated when passed via env) */
  toolAllowlist?: readonly string[];
  /**
   * Actor type threaded into the bridge (→ AOA_ACTOR_TYPE): "commander" via
   * Commander, "agent" for crew ('aoa')/org runs, else the bridge default
   * "board". Only "commander" receives the Commander tool-policy layer.
   */
  actorType?: string;
  /** Agent DB ID — set as AOA_AGENT_ID in the bridge so tools can stamp authorAgentId. */
  agentId?: string;
  runId?: string | null;
  humanQuestionCapabilities?: HumanQuestionRuntimeCapabilities;
  discussionRunMode?: "direct" | "controller_action_gate" | null;
  threadFreshness?: {
    startEpoch?: number;
    latestHumanSeq?: number;
    entrySeq?: number;
    latestScopeVersionId?: string | null;
    latestScopeVersionStatus?: string | null;
  } | null;
  /** Resolved effective autonomy (D10: threadLevel ?? companyLevel). Absent → bridge uses null. */
  effectiveAutonomy?: number | null;
  /** Normalized structured Commander scope for memory/tool policy. */
  contextScope?: NormalizedCommanderContextScope | null;
  /** External connectors, keyed by server name. Reserved names are filtered. */
  extraMcpServers?: Record<string, McpServerSpec>;
  /**
   * U2d: when true, the reserved `aoa` entry in `buildMcpConfig` is an HTTP
   * entry pointing at the control-plane broker (U2c) instead of the stdio
   * `buildMcpBridgeSpec` bridge. A brokered (E2B-sandboxed) run's CLI must
   * reach the DB ONLY through that HTTP broker — the stdio bridge injects
   * `DATABASE_URL` into the subprocess env, a secret that must never enter
   * the VM. Defaults to false (desktop/unsandboxed stdio bridge, unchanged).
   * This wave only plumbs the flag; no call site sets it yet (S7/U4).
   */
  brokered?: boolean;
  /**
   * U2d: control-plane base URL the brokered `aoa` HTTP entry is built
   * against (`${apiBaseUrl}/companies/${companyId}/mcp`). Only consulted
   * when `brokered` is true.
   */
  apiBaseUrl?: string;
}

/**
 * Serialized MCP config handed to a CLI. `aoa` is always present (AoA's own
 * loopback bridge). `playwright` is capability-gated. Any other key is an
 * external connector (see McpServerSpec).
 */
interface McpConfigServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: "http";
  url?: string;
  headers?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpConfigServerEntry>;
}

export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.75";

/**
 * Provider-neutral inner MCP server spec ({command,args,env}). This shape is
 * already provider-agnostic; later milestones reuse it to wire codex/opencode
 * MCP bridges without going through claude's mcpServers.aoa envelope.
 */
export interface McpBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Build the provider-neutral MCP bridge spec. The env construction is the
 * canonical AoA bridge contract (session identity + capability gate + D2
 * tool allowlist + DATABASE_URL inheritance). buildMcpConfig wraps this in
 * the claude-shaped {mcpServers:{aoa:...}} envelope.
 *
 * In dev mode (tsx, no compiled output) getBridgeEntrypoint returns a .ts
 * file. Plain `node` cannot execute TypeScript, so we use `tsx` as the
 * runner. In production the .js is used with plain node (unchanged behavior).
 */
export function buildMcpBridgeSpec(params: McpConfigParams): McpBridgeSpec {
  const isTsBridge = params.bridgeEntrypoint.endsWith(".ts");
  const tsxCliPath = isTsBridge
    ? join(dirname(require.resolve("tsx/package.json")), "dist", "cli.mjs")
    : null;
  return {
    command: isTsBridge ? process.execPath : "node",
    args: isTsBridge && tsxCliPath
      ? [tsxCliPath, params.bridgeEntrypoint]
      : [params.bridgeEntrypoint],
    env: {
      // The bridge owns stdout for JSON-RPC frames. Force its pino logger to
      // stderr (see middleware/logger.ts) so a stray log (e.g. the embeddings
      // "OPENAI_API_KEY is not set" WARN fired by createServiceContainer at
      // bridge boot when the key is absent) can never land on stdout ahead of
      // the JSON-RPC initialize response and break the MCP client with
      // "Transport closed". Covers every codex/opencode/gemini bridge spawn.
      AOA_LOG_STDOUT: "0",
      AOA_SESSION_COMPANY_ID: params.companyId,
      AOA_SESSION_USER_ID: params.userId,
      AOA_SESSION_USER_ROLE: params.userRole,
      // C13: thread capability set into the bridge so executeTool can
      // gate on it. Comma-separated; bridge parses on the other side.
      AOA_SESSION_ENABLED_CAPABILITIES: params.enabledCapabilities.join(","),
      // D2: per-agent tool allowlist for AoA agents. agentKind='aoa'
      // activates default-deny; toolAllowlist is the explicit permit set.
      ...(params.agentKind ? { AOA_AGENT_KIND: params.agentKind } : {}),
      ...(params.toolAllowlist && params.toolAllowlist.length > 0
        ? { AOA_TOOL_ALLOWLIST: params.toolAllowlist.join(",") }
        : {}),
      ...(params.actorType ? { AOA_ACTOR_TYPE: params.actorType } : {}),
      ...(params.agentId ? { AOA_AGENT_ID: params.agentId } : {}),
      ...(params.runId ? { AOA_RUN_ID: params.runId } : {}),
      ...(params.humanQuestionCapabilities
        ? { AOA_HUMAN_QUESTION_CAPABILITIES: JSON.stringify(params.humanQuestionCapabilities) }
        : {}),
      ...(params.discussionRunMode ? { AOA_DISCUSSION_RUN_MODE: params.discussionRunMode } : {}),
      ...(params.threadFreshness ? { AOA_THREAD_FRESHNESS: JSON.stringify(params.threadFreshness) } : {}),
      ...(params.effectiveAutonomy != null
        ? { AOA_EFFECTIVE_AUTONOMY: String(params.effectiveAutonomy) }
        : {}),
      ...(params.contextScope
        ? { AOA_COMMANDER_CONTEXT_SCOPE: JSON.stringify(params.contextScope) }
        : {}),
      ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
      // FU-23: the bridge decrypts the per-company embeddings secret IN-PROCESS
      // (service-container `embedSync` → getProviderApiKey → secretService →
      // local-encrypted provider), which reads the secrets-provider CONFIG from
      // env: the provider id, the strict-mode flag, and the master-key FILE PATH
      // (never the key VALUE — that stays in its 0600 file, read off disk by the
      // bridge process). These are re-supplied on the bridge's OWN spec env so it
      // stays self-sufficient once the connector-capable CLI spawns are scrubbed
      // of AoA's ambient env (a third-party stdio connector child inherits that
      // env and must not carry AoA's secrets). Only NON-secret config/paths are
      // copied here; the raw `AOA_SECRETS_MASTER_KEY` / `OPENAI_API_KEY` are
      // deliberately NOT re-injected — doing so would write a secret VALUE into
      // the on-disk MCP config file. Deployments that rely on those raw-value
      // env paths (rather than the default file-based master key + per-company
      // `llm:openai` Settings secret) lose in-bridge embeddings after the scrub.
      ...(process.env.AOA_SECRETS_PROVIDER
        ? { AOA_SECRETS_PROVIDER: process.env.AOA_SECRETS_PROVIDER }
        : {}),
      ...(process.env.AOA_SECRETS_STRICT_MODE
        ? { AOA_SECRETS_STRICT_MODE: process.env.AOA_SECRETS_STRICT_MODE }
        : {}),
      ...(process.env.AOA_SECRETS_MASTER_KEY_FILE
        ? { AOA_SECRETS_MASTER_KEY_FILE: process.env.AOA_SECRETS_MASTER_KEY_FILE }
        : {}),
    },
  };
}

export function buildMcpConfig(params: McpConfigParams): McpConfig {
  // U2d: a brokered (E2B-sandboxed) run's `aoa` entry is HTTP, pointed at the
  // control-plane broker (U2c) — mirroring the exact HTTP shape
  // mergeExternalMcpServers/withSynthesizedBearerHeader already emit for
  // external connectors below (${VAR} placeholder in the file, real value
  // via spawn env only). It carries NO `DATABASE_URL` — that stays confined
  // to the stdio buildMcpBridgeSpec() bridge, which never runs in a brokered
  // config. Falls back to the unchanged stdio bridge when `brokered` is
  // falsy (the default — desktop/unsandboxed runs are byte-identical).
  const aoaEntry: McpConfigServerEntry = params.brokered
    ? brokeredAoaHttpEntry({ apiBaseUrl: params.apiBaseUrl, companyId: params.companyId })
    : buildMcpBridgeSpec(params);
  const reserved: Record<string, McpConfigServerEntry> = { aoa: aoaEntry };
  if (params.enabledCapabilities?.includes("browser_use")) {
    reserved.playwright = {
      command: "npx",
      args: [PLAYWRIGHT_MCP_PACKAGE, "--headless"],
      env: {},
    };
  }

  // mergeExternalMcpServers is the ONLY supported merge path: it couples
  // reserved-name filtering with the null-prototype destination that keeps a
  // connector named `__proto__` an own key instead of the map's prototype.
  const mcpServers = mergeExternalMcpServers(reserved, params.extraMcpServers ?? {}, (spec) =>
    spec.kind === "http"
      ? {
          type: "http" as const,
          url: spec.url,
          // FU-21: claude expands `${VAR}` inside `--mcp-config` headers
          // (verified live against the CLI in Plan 2b), so a credentialed
          // connector whose headerTemplate never references its token gets the
          // conventional bearer header synthesised here. Dropping
          // `authTokenEnvVar` — as this writer used to — emitted
          // `{"Authorization": ""}` for every catalog install (D5 seeds template
          // KEYS with empty values) and the agent authenticated as no-one,
          // silently, on the DEFAULT adapter. Same rule as the opencode and
          // gemini writers, from one shared definition.
          // SECRETS: this writes the `${AOA_MCP_*_TOKEN}` PLACEHOLDER. The real
          // value reaches the CLI only through the spawn env (D5) and must never
          // be written into this file.
          headers: withSynthesizedBearerHeader(
            spec.headers,
            spec.authTokenEnvVar,
            aoaSecretPlaceholderFor,
          ),
        }
      : { command: spec.command, args: spec.args, env: spec.env },
  );

  return { mcpServers };
}

/**
 * U2d-bridge: the codex-shaped counterpart of {@link buildMcpConfig}'s
 * brokered `aoa` branch. codex has no `--mcp-config` flag — it discovers MCP
 * servers from `$CODEX_HOME/config.toml` — so the reserved `aoa` server
 * cannot travel through `buildMcpConfig`'s JSON envelope. This returns the
 * SAME logical decision in the shape `writeCodexMcpConfigToml` already
 * understands: brokered → an `McpHttpServerSpec` pointed at the control-plane
 * broker (U2c) with NO `DATABASE_URL` (the writer renders it through its
 * existing external-connector HTTP path — `url` + `bearer_token_env_var`,
 * mirroring the codex `bearer_token_env_var` convention connectors already
 * use); non-brokered (the default) → the unchanged stdio
 * `buildMcpBridgeSpec` bridge, byte-identical to before this wave.
 *
 * Pure — no fs/child_process access, same as `buildMcpConfig`.
 */
export function buildCodexAoaMcpSpec(
  params: McpConfigParams,
): McpBridgeSpec | McpHttpServerSpec {
  if (!params.brokered) return buildMcpBridgeSpec(params);
  return {
    kind: "http",
    url: `${params.apiBaseUrl}/companies/${params.companyId}/mcp`,
    // No headers: the env-var-NAME indirection below (authTokenEnvVar) is
    // codex's own mechanism for expressing "read the bearer token from this
    // env var" — codex does not expand `${VAR}` placeholders inside header
    // values the way claude does, so a placeholder header here would be
    // written to disk as an inert literal string instead of triggering
    // `bearer_token_env_var`. See renderExternalMcpBlock's `authVar` fallback.
    headers: {},
    authTokenEnvVar: "AOA_API_KEY",
  };
}

export function toolToMcpFormat(tool: AgentTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  };
}

// ── Output Parsing ────────────────────────────────────────────────────────────

const CONFIRM_RE = /⚡CONFIRM:(.*?)⚡/;
const OPTIONS_RE = /⚡OPTIONS:(.*?)⚡/;

export function parseCliOutput(line: string): AgentStreamChunk[] {
  // OPTIONS marker — structured multiple-choice question
  const optMatch = line.match(OPTIONS_RE);
  if (optMatch) {
    try {
      const payload = JSON.parse(optMatch[1]) as {
        question?: string;
        options?: unknown;
      };
      if (
        typeof payload.question !== "string" || payload.question.trim() === "" ||
        !Array.isArray(payload.options) || payload.options.length === 0
      ) {
        throw new Error("invalid OPTIONS payload");
      }
      return [
        {
          type: "options_prompt",
          question: payload.question,
          options: payload.options as string[],
          promptId: crypto.randomUUID(),
        },
      ];
    } catch {
      // Malformed JSON or invalid payload — fall through to plain text
    }
  }

  // CONFIRM marker — action approval gate
  const confirmMatch = line.match(CONFIRM_RE);
  if (confirmMatch) {
    try {
      const payload = JSON.parse(confirmMatch[1]) as { toolName?: string; params?: unknown; confirmId?: string };
      if (typeof payload.toolName !== "string" || payload.toolName.length === 0) {
        // Missing or invalid toolName — treat as malformed marker
        throw new Error("missing toolName");
      }
      return [
        {
          type: "action_confirmation",
          toolName: payload.toolName,
          params: payload.params,
          runId: payload.confirmId ?? crypto.randomUUID(),
        },
      ];
    } catch {
      // Malformed JSON or missing toolName — fall through to plain text
    }
  }

  return [{ type: "text", delta: line }];
}

// ── Constants ───────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min

/**
 * Result of resolving a CLI's chat invocation. Each provider gets its OWN
 * correct wiring: binary + argv + pre-spawn side effects (writing the MCP
 * config in the shape that provider's CLI actually reads) + any extra spawn
 * env. `mcpArtifactPath` is the per-session temp artifact recorded on the
 * session so the existing lifecycle cleanup (cli-session-store.killSession →
 * unlink) reaps it, mirroring the pre-MX4 claude behavior.
 */
interface CliInvocation {
  binary: string;
  args: string[];
  /** Extra env merged over process.env at spawn time (e.g. CODEX_HOME). */
  spawnEnv?: Record<string, string>;
  /** Primary temp artifact to record as session.mcpConfigPath for cleanup. */
  mcpArtifactPath: string;
  /** Resolved model actually used for this invocation (for provenance, not cost). */
  resolvedModel?: string;
  /**
   * RAW (UNESCAPED) user prompt to write to the child's stdin after spawn.
   * stdin does NOT pass through cmd.exe, so this is the unescaped content —
   * the Windows argv-positional path drops the prompt (cmd.exe mangling),
   * while stdin delivers it intact. The spawn block writes this then closes
   * stdin (claude `--print` is one-shot). Absent ⇒ nothing is written.
   */
  stdinPrompt?: string;
}

/**
 * Per-session managed CODEX_HOME directory. Single source of truth so the
 * codex invocation, the config.toml write, and the session's cleanup
 * `mcpConfigPath` all point at the SAME path (MX-chatparse).
 */
function codexHomeDirFor(companyId: string, userId: string): string {
  return join(
    tmpdir(),
    `aoa-codex-chat-${`${companyId}:${userId}`.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
  );
}

/** The config.toml inside the per-session managed CODEX_HOME. */
function codexConfigTomlPath(companyId: string, userId: string): string {
  return join(codexHomeDirFor(companyId, userId), "config.toml");
}

/**
 * Per-CLI chat invocation translator. claude_cli is kept BYTE-IDENTICAL to
 * pre-MX4 (write the {mcpServers:{aoa}} wrapper JSON, spawn `claude
 * --mcp-config <json> -p <msg> --output-format text`). codex gets a correct
 * `codex exec --json -` invocation: codex has no --mcp-config flag and reads
 * `-p` as --profile, so the bridge is delivered via a per-session managed
 * CODEX_HOME/config.toml ([mcp_servers.aoa]) written by the MX3 helper, and
 * the prompt is streamed over stdin (the `-` PROMPT arg) — matching the
 * chat's persistent stdin-piping multi-turn model. opencode's real form
 * (`opencode run …` + its own MCP config) is not yet wired; returning null
 * makes the caller emit an explicit "not yet supported" error instead of
 * spawning a broken `opencode --mcp-config -p` process.
 *
 * Returns null for an unsupported CLI (caller emits the error).
 *
 * `resumeCodexSessionId` (MX-chatparse): codex `exec` is ONE-SHOT — multi-
 * turn continuity is not a persistent process but a re-spawn with `resume
 * <sessionId> -` (mirrors the codex-local adapter convention). null/absent ⇒
 * a fresh turn-1 `codex exec --json -`. Ignored for non-codex CLIs.
 */
/**
 * C-systemsplit args for the claude_cli path.
 * rawSystemContext is written to a temp file and passed via --system-prompt-file
 * to avoid Windows cmd.exe newline-truncation of multi-line inline arg values.
 * rawContent is the RAW (unescaped) user message — delivered to claude over
 * stdin (W1 fix), never as a shell-escaped argv positional.
 */
interface SystemSplitArgs {
  /** Unescaped system context — written to a temp file, never passed inline. */
  rawSystemContext: string;
  /**
   * RAW (UNESCAPED) user message. Delivered to claude over stdin (which does
   * NOT pass through cmd.exe), so it must NOT be shell-escaped. On Windows the
   * argv-positional form silently dropped the prompt — stdin fixes that.
   */
  rawContent: string;
}

export async function resolveCliInvocation(
  cliTool: string,
  params: McpConfigParams,
  safeContent: string,
  resumeCodexSessionId?: string | null,
  // C-systemsplit: when provided, claude_cli uses --system + stdin split
  // instead of the legacy single -p path.  Strings carry raw (unescaped) user
  // text — claude's prompt is delivered over stdin, not argv.
  systemSplitArgs?: SystemSplitArgs,
  vendorCliBypassEnabled = true,
  codexModel?: string | null,
  // RAW (unescaped) user prompt for the claude plain (non-systemSplit) path.
  // Threaded from the caller (params.content). claude delivers the prompt over
  // stdin so it must be the raw text, never the cmd-escaped safeContent.
  rawContent?: string,
  // claude_cli Commander model (internal_agent_config.model). Emitted as a
  // shell-safe `--model <m>` only when set; null/empty keeps the argv
  // byte-identical to the pre-model default path. Threaded from chat(). Kept LAST
  // in the param list so existing positional callers passing `rawContent` are
  // unaffected (string is assignable to the prior commanderModel slot, so a
  // mid-list insert mis-bound rawContent without a typecheck error).
  commanderModel?: string | null,
): Promise<CliInvocation | null> {
  const isWin = platform() === "win32";
  const claudeBypassArgs = vendorCliBypassEnabled
    ? ["--dangerously-skip-permissions"]
    : [];
  const codexBypassArgs = vendorCliBypassEnabled
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : [];
  switch (cliTool) {
    case "claude_cli": {
      // BYTE-UNCHANGED from pre-MX4: claude {mcpServers:{aoa:spec}} wrapper
      // written to a tmp .json, passed via --mcp-config.
      const mcpConfig = buildMcpConfig(params);
      const configPath = join(
        tmpdir(),
        `aoa-mcp-${`${params.companyId}:${params.userId}`.replace(":", "-")}.json`,
      );
      await writeFile(configPath, JSON.stringify(mcpConfig, null, 2));

      // C-systemsplit: when the assembled system context is available, pass it
      // via --system-prompt-file so the model treats it as its system prompt.
      // The raw user input goes over stdin (W1 fix).  This prevents the user's
      // global CLAUDE.md (which may carry gstack routing rules that cause the
      // model to echo skill text) from being applied to what would otherwise
      // look like instruction content inside a user message.  When
      // systemSplitArgs is absent (assembly failed or not applicable) we fall
      // back to the plain path — which also delivers the prompt over stdin.
      //
      // C-systemsplit (corrected): use --system-prompt-file (not inline --system-prompt)
      // to avoid Windows cmd.exe newline-truncation: the system context is multi-line
      // markdown and cmd.exe terminates the argument at the first embedded newline.
      // Writing to a temp file sidesteps the shell quoting problem entirely.
      if (systemSplitArgs) {
        const systemPromptPath = join(
          tmpdir(),
          `aoa-sysprompt-${`${params.companyId}:${params.userId}`.replace(":", "-")}.txt`,
        );
        await writeFile(systemPromptPath, systemSplitArgs.rawSystemContext, "utf8");
        const safeSystemPromptPath = isWin
          ? `"${systemPromptPath.replace(/"/g, '""')}"`
          : systemPromptPath;
        // W1 stdin fix: the user prompt is NO LONGER an argv positional. On
        // Windows the positional rode through cmd.exe and was silently dropped
        // (the "empty/garbage Commander turn" bug). It is delivered over stdin
        // (raw, unescaped) by the spawn block, which then closes stdin —
        // claude `--print` is one-shot. See keyless-cli-spike-findings.md.
        return {
          binary: "claude",
          args: [
            "--mcp-config", configPath,
            "--strict-mcp-config",
            "--system-prompt-file", safeSystemPromptPath,
            ...claudeModelArgs(commanderModel),
            ...claudeBypassArgs,
            "--print",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--verbose",
          ],
          spawnEnv: { MAX_THINKING_TOKENS: String(COMMANDER_MAX_THINKING_TOKENS) },
          mcpArtifactPath: configPath,
          stdinPrompt: systemSplitArgs.rawContent,
        };
      }

      // W1 stdin fix (plain path): same as above — prompt over stdin, not argv.
      return {
        binary: "claude",
        args: [
          "--mcp-config", configPath,
          "--strict-mcp-config",
          ...claudeModelArgs(commanderModel),
          ...claudeBypassArgs,
          "--print",
          "--output-format", "stream-json",
          "--include-partial-messages",
          "--verbose",
        ],
        spawnEnv: { MAX_THINKING_TOKENS: String(COMMANDER_MAX_THINKING_TOKENS) },
        mcpArtifactPath: configPath,
        // Prefer the explicit raw prompt; fall back to safeContent only if the
        // caller didn't thread rawContent (defensive — the chat caller always
        // passes it). safeContent may be win32-escaped, but on the non-win
        // path it equals the raw content anyway.
        stdinPrompt: rawContent ?? safeContent,
      };
    }
    case "codex": {
      // codex discovers MCP from $CODEX_HOME/config.toml [mcp_servers.<name>];
      // it has no --mcp-config flag and treats -p as --profile. Provision a
      // per-session managed CODEX_HOME and write the neutral bridge spec
      // there via the MX3 writer. Prompt is delivered over stdin: `codex
      // exec --json -` reads instructions from stdin (matches the chat's
      // persistent stdin-piping model for multi-turn).
      const { writeCodexMcpConfigToml, ensureCodexAuthInHome, readSharedCodexModel } =
        await import("@armyofagents/adapter-codex-local/server");
      const codexHomeDir = codexHomeDirFor(params.companyId, params.userId);
      // FU-8: deliver EXTERNAL connectors alongside the bridge, exactly the way
      // the codex ADAPTER does (execute.ts) — the SAME writer renders the bridge
      // and every connector into one fenced region. `params.extraMcpServers`
      // carries the Commander-resolved specs (D3 all-active; each with only a
      // `${AOA_MCP_*_TOKEN}` placeholder — the real secret rides the spawn env,
      // never this file). An empty/absent map means "no connectors": the writer
      // treats `{}` and omitted identically (its fence strip still runs), so the
      // no-connectors config.toml stays byte-identical to pre-FU-8. Codex's known
      // limit (a stdio connector carrying a secret is undeliverable — FU-5) is
      // handled INSIDE the writer, which SKIPS those with a reason; we pass all
      // resolved specs and let it filter.
      // U2d-bridge: brokered (E2B-sandboxed) runs get an HTTP-shaped aoa spec
      // (no DATABASE_URL) instead of the stdio buildMcpBridgeSpec bridge —
      // see buildCodexAoaMcpSpec. Non-brokered runs are byte-identical.
      await writeCodexMcpConfigToml(codexHomeDir, buildCodexAoaMcpSpec(params), {
        externalServers: params.extraMcpServers ?? {},
      });
      // MX-chatauth: the per-session CODEX_HOME has config.toml but no
      // credentials, so `codex exec` run with it 401s ("Missing bearer or
      // basic authentication"). Provision auth.json into the SAME dir by
      // copying the user's shared ~/.codex/auth.json (no-op if absent).
      // Session-isolated: this home/config.toml encodes THIS chat
      // session's identity and must not be shared with the agent path.
      await ensureCodexAuthInHome(codexHomeDir);
      // MX-chatmodel: pin a subscription-supported model + effort. The
      // per-session CODEX_HOME has no `model` line, so without --model codex
      // falls back to its default (gpt-5.3-codex), which a ChatGPT-account
      // codex rejects with a 400 → empty turn. effort=high is REQUIRED for
      // codex to emit reasoning summaries (medium emits none). The summary
      // flag stays BARE (quoted emits nothing). See codex-model.ts + the plan.
      const sharedCodexModel = await readSharedCodexModel(); // shared ~/.codex, NOT the per-session home
      const resolvedCodexModel = resolveCodexChatModel(codexModel, sharedCodexModel);
      const modelArgs = ["--model", resolvedCodexModel];
      const reasoningArgs = [
        "-c",
        `model_reasoning_effort=${COMMANDER_CODEX_REASONING_EFFORT}`,
        "-c",
        "model_reasoning_summary=detailed",
      ];
      const codexArgs = resumeCodexSessionId
        ? ["exec", "--json", ...codexBypassArgs, ...modelArgs, ...reasoningArgs, "resume", resumeCodexSessionId, "-"]
        : ["exec", "--json", ...codexBypassArgs, ...modelArgs, ...reasoningArgs, "-"];
      return {
        binary: "codex",
        args: codexArgs,
        spawnEnv: { CODEX_HOME: codexHomeDir },
        // Record the config.toml so the existing best-effort unlink cleanup
        // (cli-session-store.killSession) reaps the primary artifact, the
        // same way it reaps claude's tmp .json. Parity, no new machinery.
        mcpArtifactPath: codexConfigTomlPath(params.companyId, params.userId),
        resolvedModel: resolvedCodexModel,
      };
    }
    default:
      // opencode (and any future/unknown tool): not yet wired.
      return null;
  }
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * MIG-005 — the Commander turn's shadow snapshot, as a pure function.
 *
 * Extracted from the generator so its CONTENT is unit-testable: driving the real
 * `chat` generator far enough to reach the seam needs the whole spawn surface mocked,
 * and a test that heavy tends to assert that the mocks were called rather than that the
 * record is right. Placement (after the target resolves, before the D1 gate) is pinned
 * separately by a source contract test.
 */
export function buildCommanderTurnShadowInput(input: {
  companyId: string;
  userId: string;
  userRole?: string;
  runId: string;
  conversationId: string;
  cliTool: string;
  model: string | null;
  /** The resolved sandbox target, or null when Commander runs host-direct. */
  executionTargetType: string | null;
}): ShadowSinkInput {
  return {
    companyId: input.companyId,
    source: {
      kind: "commander_turn",
      internalAgentRunId: input.runId,
      conversationId: input.conversationId,
    },
    principal: { kind: "user", id: input.userId, role: input.userRole },
    routing: {
      // `local` is what the legacy path actually does on self-hosted, so record that
      // rather than inventing an absence.
      executionTargetType: input.executionTargetType ?? "local",
    },
    policy: {
      model: input.model,
      budgetPolicyId: null,
      // A Commander turn is not a task and has no completion policy to snapshot.
      effectiveCompletionPolicy: "not_applicable",
    },
    workloadCharacterization: {
      command: input.cliTool,
      args: [],
      maxRuntimeSeconds: 600,
      stdinArtifactId: null,
    },
  };
}

export function cliModeService(db: Db) {
  const sessionStore = createCLISessionStore();

  // Idle timeout sweep
  const idleTimer = setInterval(() => {
    const stale = sessionStore.getStale(IDLE_TIMEOUT_MS);
    for (const key of stale) {
      sessionStore.cleanup(key);
    }
  }, IDLE_CHECK_INTERVAL_MS);

  // Unref so it doesn't prevent process exit
  if (idleTimer.unref) idleTimer.unref();

  function getBridgeEntrypoint(): string {
    const thisDir = typeof __dirname !== "undefined"
      ? __dirname
      : fileURLToPath(new URL(".", import.meta.url));
    const jsPath = resolve(thisDir, "mcp-bridge.js");
    // In production (after `pnpm build`), the compiled .js exists and plain
    // node can run it. In dev mode (tsx), only the .ts source exists — return
    // the .ts path so buildMcpBridgeSpec can select tsx as the runner.
    try { statSync(jsPath); return jsPath; } catch { /* dev mode — fall through */ }
    return resolve(thisDir, "mcp-bridge.ts");
  }

  // ── #310 MERGE NOTE ─────────────────────────────────────────────────────────
  // #310 introduces commander-runtime-auth.ts (assertCommanderSubscriptionAgent /
  // subscription_commander_only) which does NOT exist on this branch. At merge,
  // that Commander-only gate MUST be expressed as this resolver's owner_only
  // sharingPolicy (connection.ownerUserId === acting user) — NOT as a parallel
  // Commander credential path. Do not reintroduce a second resolution site.
  //
  // Phase 4: resolve the Commander per-session provider credential through the ONE
  // unified resolver and return the env PATCH to overlay onto the spawn env (before
  // the codex CODEX_HOME / claude CLAUDE_CONFIG_DIR overlay is finalized). Commander
  // has no company-secret key path — it runs on the operator's ambient CLI login —
  // so the legacy fallbacks are inert (identity legacyResolveConfig ⇒ empty patch ⇒
  // host_login_fallback = today's ambient login; the managed CODEX_HOME/auth
  // provisioning stays in resolveCliInvocation ⇒ legacySubscriptionEnv null). An
  // unmigrated company's spawn env is therefore byte-identical. When a founder
  // creates a verified provider_connection + assignment, its patch overlays the
  // spawn env. Cloud (multi_tenant) resolution fails closed (ProviderUnavailableError
  // is re-thrown); every other error degrades to the host login (Commander is
  // always-on). agentId is null here: internal_agent_config.agentId is not threaded
  // into cli-mode's config/params, so agent_override assignments do not target
  // Commander (company_default + personal_execution_default still resolve; owner_only
  // isolation uses the acting user via actorType:"user"). Threading the real
  // internal_agent_config.agentId is a follow-up.
  async function resolveCommanderSpawnEnvPatch(
    companyId: string,
    userId: string,
    cliTool: string,
  ): Promise<Record<string, string>> {
    const providerId =
      cliTool === "codex" ? "openai" : cliTool === "claude_cli" ? "anthropic" : null;
    const adapterType =
      cliTool === "codex" ? "codex_local" : cliTool === "claude_cli" ? "claude_local" : null;
    if (!providerId || !adapterType) return {};
    try {
      const { resolveProviderCredential, applyResolvedCredential } = await import(
        "../provider-resolution.js"
      );
      const { buildResolveDeps } = await import("../provider-resolution-deps.js");
      const { resolveCliAuthTopology } = await import("../cli-auth-topology.js");
      const { loadConfig } = await import("../../config.js");
      const deployConfig = loadConfig();
      const topology = resolveCliAuthTopology({
        deploymentMode: deployConfig.deploymentMode,
        deploymentExposure: deployConfig.deploymentExposure,
      });
      const deps = {
        ...buildResolveDeps(db, topology),
        // Commander has no company-secret key path; ambient login is the default.
        legacyResolveConfig: async (cfg: Record<string, unknown>) => cfg,
        // Managed CODEX_HOME/auth provisioning stays in resolveCliInvocation.
        legacySubscriptionEnv: async () => null,
      };
      const resolved = await resolveProviderCredential(
        db,
        {
          organizationId: null,
          companyId,
          agentId: null, // internal_agent_config.agentId not threaded here (follow-up)
          actorKind: "commander",
          adapterType,
          provider: providerId,
          executionTargetId: process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane",
          // NOT process.env: the server process legitimately carries the ambient
          // embeddings OPENAI_API_KEY (and possibly ANTHROPIC_API_KEY). Passing it
          // as currentEnv would trip Step-0 agent_env_override, which (a) defeats the
          // multi_tenant fail-closed throw (Commander would silently spawn against the
          // operator's shared account) and (b) shadows a founder-configured connection.
          // Commander declares no per-agent key here, so the correct currentEnv is
          // empty; self-hosted still lands on host_login_fallback and uses the ambient
          // login at spawn time exactly as before.
          currentEnv: {},
          context: {
            consumerType: "system",
            consumerId: userId,
            actorType: "user",
            actorId: userId,
          },
        },
        deps,
      );
      const patched = applyResolvedCredential({ env: {} }, resolved) as {
        env?: Record<string, string>;
      };
      return patched.env ?? {};
    } catch (err) {
      // Fail closed on cloud (multi_tenant / cloud_auth): the helper rethrows
      // EVERY error when tenant isolation is enforced, so Commander never borrows
      // the operator's ambient host login on a shared host. It also rethrows
      // provider_unavailable everywhere. Only the self-hosted degrade path falls
      // through to the warning + host-login ({}) below.
      const patch = handleCommanderResolveError(err, {
        tenantIsolationEnforced: tenantIsolationEnforced(),
      });
      logger.warn({ err, companyId }, "Commander provider resolution failed; using host login");
      return patch;
    }
  }

  return {
    async *chat(
      params: ChatInput,
      config: {
        cliTool: string | null;
        executionMode: string;
        vendorCliBypassEnabled?: boolean;
        /** internal_agent_config.model — used (validated) for the codex spawn. */
        model?: string | null;
      },
    ): AsyncGenerator<AgentStreamChunk> {
      // ── W7.5d: acquire-after-early-returns + host-detect bypass + D1 flip ──
      // ORDER MATTERS (F2): the cheap config-validation early-returns run BEFORE
      // the sandbox acquire, so a missing cliTool / conversationId can NEVER
      // orphan a warm VM. The acquire happens only after both pass.

      // 1. Validate CLI tool config (FIRST — before any acquire).
      if (!config.cliTool) {
        yield {
          type: "error",
          message: "No CLI tool configured. Go to Settings → Commander and select a CLI tool (claude, codex, or opencode).",
        };
        return;
      }

      // 2. Conversation context is required (still before any acquire).
      // Provider sessions must follow the persisted Commander conversation.
      // Keying only by company + user resumes the previous provider thread
      // after the user switches conversations, leaking context across chats.
      const conversationId =
        params.conversationId ?? normalizeCliContextScope(params.contextScope)?.conversationId;
      if (!conversationId) {
        yield {
          type: "error",
          message: "Commander conversation context is required for CLI execution.",
        };
        return;
      }

      // 3. Resolve the warm sandbox — cloud only (null on self-hosted, where the
      //    D1 guard is a no-op and Commander spawns host-direct exactly as today).
      //    The acquire happens HERE — AFTER the cheap early-returns above (F2) — so
      //    no early bail can leak a VM. A missing JWT secret (or an acquire fault)
      //    throws from the resolver AFTER it has released any lease it took; surface
      //    it as a clean error chunk and never spawn.
      let commanderSandbox: CommanderSandboxContext | null = null;
      if (params.runId) {
        try {
          commanderSandbox = await resolveCommanderSandboxContext(db, {
            companyId: params.companyId,
            userId: params.userId,
            userRole: params.userRole,
            conversationId,
            turnId: params.runId,
            apiBaseUrl: resolveCommanderApiBaseUrl(),
            adapterType: config.cliTool === "codex" ? "codex_local" : "claude_local",
            getExperimental: () => instanceSettingsService(db).getExperimental(),
          });
        } catch (resolveErr) {
          yield {
            type: "error",
            message: resolveErr instanceof Error ? resolveErr.message : String(resolveErr),
          };
          return;
        }
      }

      // 3b. MIG-005 shadow observation. Placed here because the execution target is
      //     now RESOLVED (so the recorded routing is real) and nothing has been spawned
      //     yet (so the record is the turn's intent, not its outcome).
      //
      //     Skipped without `params.runId`: a `commander_turn` source is identified by
      //     its internal-agent run, and the FROZEN `.strict()` variant will not accept a
      //     substitute. A turn with no run id has no identity to record — recording a
      //     placeholder would be worse than recording nothing.
      //
      //     Inert unless this Organization's rollout is `shadow`. It cannot throw and its
      //     probe is deadline-bounded, so the worst case for a live turn is
      //     SHADOW_PROBE_DEADLINE_MS, never a failure.
      if (params.runId) {
        await recordDistributedShadow(
          buildCommanderTurnShadowInput({
            companyId: params.companyId,
            userId: params.userId,
            userRole: params.userRole,
            runId: params.runId,
            conversationId,
            cliTool: config.cliTool,
            model: config.model ?? null,
            executionTargetType: commanderSandbox?.executionTarget.type ?? null,
          }),
        );
      }

      // 4. D1 multi-tenant unsandboxed execution gate — flipped to the RESOLVED
      //    target, and run BEFORE the host probe so an unsandboxed cloud turn is
      //    refused without wasting a host binary probe. On cloud a provider-sandbox
      //    target is permitted; a null target on cloud still REFUSES (correct when
      //    no platform default resolved). On self-hosted tenantIsolationEnforced()
      //    is false → no-op → byte-identical. The try/catch is NARROW (only the
      //    refusal). Release the lease if the guard throws so a just-acquired VM
      //    never leaks.
      try {
        assertUnsandboxedMultitenantAllowed(
          commanderSandbox?.executionTarget ?? { type: "local" },
          { tenantIsolationEnforced: tenantIsolationEnforced(), sink: "Commander" },
        );
      } catch (guardErr) {
        if (commanderSandbox) await commanderSandbox.release().catch(() => undefined);
        yield {
          type: "error",
          message: guardErr instanceof Error ? guardErr.message : String(guardErr),
        };
        return;
      }

      // 5. Host CLI availability — HOST PATH ONLY. On the sandbox path the VM
      //    image provides the CLI; probing the host binary is both wrong and, on a
      //    failed probe, would abort a turn that would run fine in the VM (F2).
      if (!commanderSandbox) {
        const detection = await detectCliTool(config.cliTool);
        if (!detection.available) {
          yield { type: "error", message: detection.error! };
          return;
        }
      }

      const sessionKey = `${params.companyId}:${params.userId}:${conversationId}`;
      let session = sessionStore.get(sessionKey);

      try {
        let sawRealDone = false;

        // ── W7.5d: cloud sandbox reroute ─────────────────────────────────────
        // On cloud, delegate the in-sandbox CLI (claude AND codex) to the SAME
        // adapter.execute path org/crew use — spawn-per-turn in the warm VM, NO
        // persistent host process, NO host spawn. Every host branch below is
        // reached ONLY when commanderSandbox is null (this block returns first on
        // the cloud path), so self-hosted stays BYTE-IDENTICAL. The `finally`
        // below releases/pauses the warm lease on EVERY exit.
        if (commanderSandbox) {
          const bridgePath = getBridgeEntrypoint();

          // MCP connectors (best-effort; parity with the host branches). The CLI
          // runs inside the provider sandbox, so resolve for a sandbox target.
          let connectorSpecs: Record<string, McpServerSpec> = {};
          let connectorEnv: Record<string, string> = {};
          try {
            const resolved = await resolveAgentConnectors(db, {
              companyId: params.companyId,
              agentId: null, // Commander = all active company connectors (D3)
              logger,
              sandboxTarget: true,
            });
            connectorSpecs = resolved.extraMcpServers;
            connectorEnv = resolved.connectorEnv;
          } catch (err) {
            logger.warn(
              { err, companyId: params.companyId },
              "Commander MCP connector resolution failed; proceeding without connectors",
            );
          }

          if (config.cliTool !== "codex" && config.cliTool !== "claude_cli") {
            // opencode-in-sandbox is out of scope; refuse (the finally still
            // releases the lease — no VM leak).
            yield {
              type: "error",
              message:
                "opencode is not yet supported for the Commander chat (MCP wiring pending — MX-followup). Use claude or codex.",
            };
            return;
          }

          const adapterType = config.cliTool === "codex" ? "codex_local" : "claude_local";
          const mcpParams: McpConfigParams = {
            companyId: params.companyId,
            userId: params.userId,
            userRole: params.userRole,
            enabledCapabilities: params.enabledCapabilities,
            bridgeEntrypoint: bridgePath,
            actorType: "commander",
            runId: params.runId ?? null,
            contextScope: normalizeCliContextScope(params.contextScope),
            extraMcpServers: connectorSpecs,
            // U2d: the sandboxed CLI reaches the DB ONLY through the HTTP broker —
            // never the stdio bridge (which injects DATABASE_URL). buildMcpConfig /
            // buildCodexAoaMcpSpec emit the HTTP form when brokered.
            brokered: true,
            apiBaseUrl: commanderSandbox.apiBaseUrl,
          };

          const adapter = getServerAdapter(adapterType);
          for await (const ev of runCommanderAdapterTurn(adapter, {
            adapterType,
            executionTarget: commanderSandbox.executionTarget,
            companyId: params.companyId,
            userId: params.userId,
            userRole: params.userRole,
            conversationId,
            turnId: params.runId!,
            authToken: commanderSandbox.authToken,
            apiBaseUrl: commanderSandbox.apiBaseUrl,
            // Deliver the raw user message as the prompt and the assembled system
            // context (WITH conversation history) as the instructions file — mirrors
            // the host claude split. Fall back to full content when assembly failed.
            content: params.rawContent ?? params.content,
            systemContext: params.systemContext ?? null,
            model: config.model ?? null,
            mcpParams,
            connectorSpecs,
            connectorEnv,
            useStreamJson: config.cliTool === "claude_cli",
          })) {
            if (ev.kind === "chunk") {
              if (ev.chunk.type === "done") sawRealDone = true;
              yield ev.chunk;
            }
            // ev.kind === "result": buffered AdapterExecutionResult (cost/session
            // continuity). Commander delivers full conversation history in the
            // system context each turn, so no CLI-level session resume is needed;
            // the result is consumed here (no persistent session to update).
          }
          if (!sawRealDone) yield commanderDoneFallback();
          return; // the `finally` releases/pauses the warm lease
        }

        if (config.cliTool === "codex") {
          // ── codex: ONE-SHOT per turn + resume continuity ──────────────
          // codex `exec` is one-shot (runs the turn, exits). So there is
          // NO persistent process: the conversation is carried by the
          // codex sessionId. Each turn re-spawns; turn-N appends `resume
          // <id> -`. stdout is buffered for the whole turn and parsed via
          // parseCodexJsonl on exit (exit == turn end). The assistant text
          // is the parsed `summary` (NOT raw JSONL — the pre-MX-chatparse
          // bug). claude is UNTOUCHED (the else-branch below).
          const isWin = platform() === "win32";
          const bridgePath = getBridgeEntrypoint();

          // MCP connectors (FU-8 — Commander, codex adapter). Parity with the
          // claude_cli path below: Commander is per-USER, not per-agent, so it
          // receives EVERY active company connector — the D3 all-active case →
          // agentId: null. The specs (each carrying only a `${AOA_MCP_*_TOKEN}`
          // placeholder) are threaded into mcpParams.extraMcpServers, which
          // resolveCliInvocation folds into the per-session CODEX_HOME/config.toml
          // via writeCodexMcpConfigToml's externalServers. The real secrets ride
          // ONLY in connectorEnv, merged into the SCRUBBED spawn env inside
          // runCodexTurn → spawnAndCollect — never on disk.
          //
          // Best-effort: Commander is always-on, so a connector resolution
          // failure degrades to "no connectors" (non-silent via the warn log),
          // never breaks the user's turn. Mirrors the claude_cli guard exactly.
          let connectorSpecs: Record<string, McpServerSpec> = {};
          let connectorEnv: Record<string, string> = {};
          try {
            const resolved = await resolveAgentConnectors(db, {
              companyId: params.companyId,
              agentId: null, // Commander = all active company connectors (D3)
              logger,
              // U11: Commander never resolves a sandbox execution target — the
              // D1 gate above (assertUnsandboxedMultitenantAllowed) documents
              // that a Commander turn always spawns its CLI directly on the
              // control-plane host (the Wave 2 adversarial review deleted the
              // dead `acquireExecutionContext` call that used to sit here,
              // enforced by cli-mode-no-sandbox-acquire.test.ts). So
              // sandboxTarget is ALWAYS false for Commander today — explicit,
              // not omitted, so a future reader does not mistake this for an
              // oversight. Revisit only alongside a real Commander-in-sandbox
              // wiring decision (S5: sourced from an actual acquisition, never
              // guessed).
              sandboxTarget: false,
            });
            connectorSpecs = resolved.extraMcpServers;
            connectorEnv = resolved.connectorEnv;
          } catch (err) {
            logger.warn(
              { err, companyId: params.companyId },
              "Commander MCP connector resolution failed; proceeding without connectors",
            );
          }

          // Wave 2 adversarial review (MEDIUM/LOW — dead sandbox acquire): U4
          // used to acquire an ephemeral sandbox lease here, but Commander's
          // spawn below is NOT rerouted through the sandbox (deferred — a
          // persistent-session decision is pending), so the acquired lease was
          // never consumed, `mcpParams.brokered` was never actually set from
          // it, and nothing released it — an orphaned E2B VM per chat turn on
          // the cloud path for zero benefit. Removed. The whole
          // acquire+brokered+release triad belongs together, atomically, at
          // the future milestone that actually reroutes this spawn into the
          // sandbox (mirroring the crew/org pattern) — not added piecemeal.
          const mcpParams: McpConfigParams = {
            companyId: params.companyId,
            userId: params.userId,
            userRole: params.userRole,
            enabledCapabilities: params.enabledCapabilities,
            bridgeEntrypoint: bridgePath,
            actorType: "commander",
            runId: params.runId ?? null,
            contextScope: normalizeCliContextScope(params.contextScope),
            extraMcpServers: connectorSpecs,
          };

          if (session) session.lastMessageAt = new Date();

          // Phase 4 (Task 13): resolve the Commander provider credential and hand
          // its env patch to the codex spawn (overlaid onto CODEX_HOME below).
          // Inert ({}) for unmigrated companies → spawn env byte-identical.
          const codexCredentialEnv = await resolveCommanderSpawnEnvPatch(
            params.companyId,
            params.userId,
            "codex",
          );

          for await (const chunk of runCodexTurn({
            mcpParams,
            connectorEnv,
            credentialEnv: codexCredentialEnv,
            prompt: params.content,
            isWin,
            resumeSessionId: session?.codexSessionId ?? null,
            vendorCliBypassEnabled: config.vendorCliBypassEnabled ?? true,
            codexModel: config.model ?? null,
            onSessionId: (sid) => {
              const existing = sessionStore.get(sessionKey);
              if (existing) {
                // Refresh the codex sessionId from this turn's parse.
                existing.codexSessionId = sid ?? existing.codexSessionId;
                existing.lastMessageAt = new Date();
              } else {
                // First turn: create a PROCESS-LESS session (cliProcess
                // null — codex has no long-lived process; killSession
                // guards on null).
                const fresh: CLISession = {
                  cliProcess: null,
                  mcpProcess: null,
                  cliTool: "codex",
                  ...(sid ? { codexSessionId: sid } : {}),
                  companyId: params.companyId,
                  userId: params.userId,
                  userRole: params.userRole,
                  startedAt: new Date(),
                  lastMessageAt: new Date(),
                  // config.toml path recorded so the existing best-effort
                  // unlink cleanup reaps it (parity with claude's tmp .json).
                  mcpConfigPath: codexConfigTomlPath(params.companyId, params.userId),
                  status: "active",
                  messageQueue: [],
                  processing: false,
                };
                sessionStore.set(sessionKey, fresh);
                session = fresh;
              }
            },
          })) {
            if (chunk.type === "done") sawRealDone = true;
            yield chunk;
          }

          // Fallback only — runCodexTurn now emits a real-usage done.
          if (!sawRealDone) {
            yield {
              type: "done",
              summary: {
                runId: "",
                toolsCalled: [],
                durationMs: 0,
                costCents: 0,
                tokenUsage: { inputTokens: 0, outputTokens: 0 },
              },
            };
          }
          return;
        }

        if (!session) {
          // 3. First message — spawn new session
          const bridgePath = getBridgeEntrypoint();

          // Windows note: CLI tools like `claude`, `codex`, `opencode` are
          // installed as .cmd wrappers. Node's `spawn` can only launch
          // .bat/.cmd files with `shell: true` (direct spawn raises
          // EINVAL). `shell: true` invokes cmd.exe which forwards args to
          // the shell — so any user-controlled content placed in ARGV must
          // be escaped to prevent cmd injection. claude no longer takes the
          // prompt in argv (it rides stdin — see below), but safeContent is
          // still threaded for the non-systemSplit fallback + codex. Other
          // args (config path, flag literals) come from constants and tmpdir.
          const isWin = platform() === "win32";
          const safeContent = isWin
            ? `"${params.content.replace(/"/g, '""').replace(/%/g, "%%").replace(/\^/g, "^^")}"`
            : params.content;

          // Per-CLI wiring: each provider gets its OWN correct invocation.
          // claude_cli stays BYTE-IDENTICAL (mcpServers wrapper JSON +
          // --mcp-config/-p); codex uses `codex exec --json -` with the
          // bridge delivered via a managed CODEX_HOME/config.toml; opencode
          // is not yet wired → explicit error (no broken spawn).
          // C-systemsplit: build args for the --system-prompt-file split when
          // both systemContext and rawContent were assembled by agent-loop.
          // rawSystemContext is written to a temp file by resolveCliInvocation
          // to avoid Windows cmd.exe newline-truncation of multi-line contexts.
          // W1 stdin fix: claude's prompt is delivered over stdin (raw,
          // unescaped) — NOT argv. So rawContent (the raw user message) is
          // threaded straight through; no per-platform argv escaping.
          const systemSplitArgs: SystemSplitArgs | undefined =
            params.systemContext !== undefined && params.rawContent !== undefined
              ? {
                  rawSystemContext: params.systemContext,
                  rawContent: params.rawContent,
                }
              : undefined;

          // MCP connectors (Plan 2 — Commander, claude_cli ONLY). Commander is
          // per-USER, not per-agent, so it receives EVERY active company
          // connector — the D3 all-active case → agentId: null. The specs (each
          // carrying only a `${AOA_MCP_*_TOKEN}` placeholder) are threaded into
          // resolveCliInvocation's params, which already folds them into the
          // --mcp-config FILE via buildMcpConfig. The real secrets ride ONLY in
          // connectorEnv, merged into the spawn env below — never on disk.
          //
          // Gated on claude_cli: codex is handled by the one-shot branch above,
          // and opencode returns a null invocation (never spawns), so resolving
          // for either would be wasted DB I/O + a needless per-turn failure
          // surface (mirrors the heartbeat/crew adapterType gate).
          //
          // Best-effort: Commander is the always-on assistant, so a connector
          // resolution failure must degrade to "no connectors" (non-silent via
          // the warn log — A8/A19), never break the user's turn. The loader
          // already isolates per-connector secret failures; this guard also
          // absorbs a systemic DB error so the chat still answers. The guard is
          // justified by this production-degradation reason ALONE — the unit
          // tests mock resolveAgentConnectors at module level, so they never
          // reach (or depend on) this try/catch.
          let connectorSpecs: Record<string, McpServerSpec> = {};
          let connectorEnv: Record<string, string> = {};
          if (config.cliTool === "claude_cli") {
            try {
              const resolved = await resolveAgentConnectors(db, {
                companyId: params.companyId,
                agentId: null, // Commander = all active company connectors (D3)
                logger,
                // U11: same D1/FIX-2 reasoning as the codex branch above —
                // Commander has no sandbox execution target on this path, so
                // sandboxTarget is explicitly false rather than omitted.
                sandboxTarget: false,
              });
              connectorSpecs = resolved.extraMcpServers;
              connectorEnv = resolved.connectorEnv;
            } catch (err) {
              logger.warn(
                { err, companyId: params.companyId },
                "Commander MCP connector resolution failed; proceeding without connectors",
              );
            }
          }

          // Wave 2 adversarial review (MEDIUM/LOW — dead sandbox acquire):
          // same removal as the codex branch above — Commander's spawn a few
          // lines down (`cliProcess = spawn(...)`) is NOT rerouted through the
          // sandbox, so acquiring a lease here was never consumed, never fed
          // `brokered`, and never released. See the codex branch's comment for
          // the full rationale.
          const invocation = await resolveCliInvocation(
            config.cliTool,
            {
              companyId: params.companyId,
              userId: params.userId,
              userRole: params.userRole,
              enabledCapabilities: params.enabledCapabilities,
              bridgeEntrypoint: bridgePath,
              actorType: "commander",
              runId: params.runId ?? null,
              contextScope: normalizeCliContextScope(params.contextScope),
              extraMcpServers: connectorSpecs,
            },
            safeContent,
            undefined,        // resumeCodexSessionId (N/A for the persistent-claude path)
            systemSplitArgs,
            config.vendorCliBypassEnabled ?? true,
            undefined,        // codexModel (codex routes through runCodexTurn, not here)
            params.content,   // rawContent — raw prompt for claude's stdin (plain-path fallback)
            config.model,     // commanderModel — shell-safe --model for claude_cli (LAST param)
          );
          if (!invocation) {
            yield {
              type: "error",
              message:
                "opencode is not yet supported for the Commander chat (MCP wiring pending — MX-followup). Use claude or codex.",
            };
            return;
          }

          // Phase 4 (Task 13): overlay the resolved Commander provider credential
          // onto invocation.spawnEnv BEFORE the cliEnv overlay is finalized below.
          // Inert ({}) for unmigrated companies (host login) → spawn env unchanged.
          // See the #310 MERGE NOTE + resolveCommanderSpawnEnvPatch above.
          const commanderCredentialEnv = await resolveCommanderSpawnEnvPatch(
            params.companyId,
            params.userId,
            config.cliTool,
          );
          if (Object.keys(commanderCredentialEnv).length > 0) {
            invocation.spawnEnv = { ...(invocation.spawnEnv ?? {}), ...commanderCredentialEnv };
          }

          // Merge the real connector secrets into the spawn env (NOT the config
          // file). Placed after the null guard so it runs only when we actually
          // spawn. Connector tokens layer on TOP of the existing spawnEnv (e.g.
          // MAX_THINKING_TOKENS).
          //
          // LIMITATION (P2N2): connectors are resolved at the FIRST-message
          // spawn of a persistent claude session and the env is fixed at spawn,
          // so a connector added/removed mid-conversation won't take effect
          // until that session recycles. Real debugging gotcha ("I added a
          // connector and Commander still can't see it").
          // P1 (Codex): gate on the resolved SPEC map, not connectorEnv. A
          // secretless connector (stdio filesystem, unauth'd http) yields a
          // nonempty spec map but an EMPTY connectorEnv — gating on connectorEnv
          // would skip the FU-23 scrub below and let that connector's stdio child
          // inherit AoA's ambient secrets. Presence of ANY external spec is what
          // means "a third-party child may spawn → scrub".
          const connectorsPresent = Object.keys(connectorSpecs).length > 0;
          if (Object.keys(connectorEnv).length > 0) {
            invocation.spawnEnv = { ...(invocation.spawnEnv ?? {}), ...connectorEnv };
          }

          // cwd = tmpdir() prevents the CLI from walking up and reading the
          // project's CLAUDE.md (which mentions "Paperclip" — an internal
          // implementation detail that must never surface to users).
          //
          // FU-23: when this turn hosts third-party MCP connectors, the CLI —
          // and every stdio connector child it spawns (`npx -y <pkg>`) — must NOT
          // inherit AoA's ambient secret env (DATABASE_URL, the embeddings
          // OPENAI_API_KEY, the auth signing secret, the secrets master key, the
          // GitHub PAT, sibling connectors are a separate limit — see note).
          // Scrub the CLI base down to PATH/HOME/etc. and re-apply only the
          // trusted overlay: MAX_THINKING_TOKENS + the connector
          // `${AOA_MCP_*_TOKEN}` values the config placeholders expand from.
          // `mergeConnectorEnv` keeps the scrubbed base authoritative (a connector
          // token can never redirect PATH), then the trusted spawnEnv is spread
          // last so MAX_THINKING_TOKENS wins. The `aoa` bridge stays functional
          // because buildMcpBridgeSpec re-supplies DATABASE_URL + the
          // secrets-provider config on `mcpServers.aoa.env` — the bridge does NOT
          // depend on this inherited env. No-connectors turns keep the full env
          // (byte-identical; there is no third-party child to protect).
          // NOTE: sibling-connector-token isolation is NOT reachable here — every
          // token must sit in the one CLI env for `${VAR}` expansion, and the CLI
          // (not AoA) spawns the connector children. This scrub targets AoA's OWN
          // secrets, which is what the module + [ESC-7] cover.
          const cliEnv = connectorsPresent
            ? {
                ...mergeConnectorEnv(buildScrubbedCliEnv(), connectorEnv),
                ...(invocation.spawnEnv ?? {}),
              }
            : { ...process.env, ...invocation.spawnEnv };
          const cliProcess = spawn(invocation.binary, invocation.args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: cliEnv,
            shell: isWin,
            cwd: tmpdir(),
          });

          // Swallow stdin stream errors (P1, Codex): if the CLI exits before
          // reading stdin (auth/flag/config error) and the assembled prompt
          // exceeds the OS pipe buffer, the write below (turn 1 and every
          // subsequent persistent-session turn) raises EPIPE. Without an `error`
          // listener that is an unhandled stream error that crashes the server;
          // the dead process is otherwise handled by the stream-end / cleanup path.
          cliProcess.stdin?.on("error", () => {});

          session = {
            cliProcess,
            mcpProcess: null,
            cliTool: config.cliTool as CLISession["cliTool"],
            companyId: params.companyId,
            userId: params.userId,
            userRole: params.userRole,
            startedAt: new Date(),
            lastMessageAt: new Date(),
            mcpConfigPath: invocation.mcpArtifactPath,
            status: "active",
            messageQueue: [],
            processing: true,
          };

          sessionStore.set(sessionKey, session);

          // Handle crash
          cliProcess.on("exit", () => {
            if (session?.status === "active") {
              sessionStore.delete(sessionKey);
            }
          });

          // Prompt delivery over stdin.
          //
          // claude (W1 stdin fix): the prompt is written to stdin (raw,
          // unescaped — stdin never passes through cmd.exe) and stdin is then
          // CLOSED. claude `--print` is one-shot: it reads the prompt to EOF,
          // answers, and exits. The Windows argv-positional form silently
          // dropped the prompt (the empty/garbage Commander turn). Because the
          // process exits per turn, every claude turn re-spawns here — so this
          // spawn-time stdin write covers all claude turns. (Codex never
          // reaches this branch: it returns earlier via runCodexTurn.)
          //
          // Note: opencode is the only non-claude CLI that could fall through
          // here, and it's rejected above (invocation === null). So in practice
          // this branch runs for claude only — but we key off invocation.stdinPrompt
          // (present iff the provider wants stdin delivery) rather than the CLI
          // name, keeping it provider-neutral.
          if (
            invocation.stdinPrompt !== undefined &&
            cliProcess.stdin?.writable
          ) {
            cliProcess.stdin.write(invocation.stdinPrompt + "\n");
            cliProcess.stdin.end?.();
          }

          // Stream stdout — collect text for persistence.
          // claude_cli uses stream-json; codex/opencode use the text parser.
          const useStreamJson = config.cliTool === "claude_cli";
          for await (const chunk of streamProcessOutput(cliProcess, useStreamJson)) {
            if (chunk.type === "done") sawRealDone = true;
            yield chunk;
          }
        } else {
          // Subsequent message — pipe to existing process stdin.
          // (claude only: codex returned above. cliProcess is non-null on
          // the persistent claude path; the local narrows the now-nullable
          // type — a null process is treated exactly like a dead stdin,
          // i.e. the pre-existing "session ended" path. Runtime behavior
          // for claude is UNCHANGED — MX-chatparse.)
          session.lastMessageAt = new Date();
          const cliProc = session.cliProcess;
          if (cliProc && cliProc.stdin?.writable) {
            // C-systemsplit: for persistent claude sessions, the system context
            // was already set via --system on turn 1.  Subsequent turns should
            // send ONLY the raw user input so the model doesn't see the full
            // assembled context (including history) as a user message — which
            // would cause double-history and re-trigger any CLAUDE.md routing
            // rules.  rawContent is the pre-assembly user text; fall back to
            // params.content when absent (codex or legacy path).
            const turnInput = params.rawContent ?? params.content;
            cliProc.stdin.write(turnInput + "\n");
            const useStreamJsonCont = config.cliTool === "claude_cli";
            for await (const chunk of streamProcessOutput(cliProc, useStreamJsonCont)) {
              if (chunk.type === "done") sawRealDone = true;
              yield chunk;
            }
          } else {
            // Process stdin closed — session is dead, clean up
            sessionStore.cleanup(sessionKey);
            yield {
              type: "error",
              message: "CLI session ended unexpectedly. Please try again.",
            };
          }
        }

        // Fallback only — handleResultEvent emits the real done from the
        // stream-json `result` event. This covers the plain-text MCP-tool turn
        // (no result event) so the route always sees exactly one done.
        if (!sawRealDone) {
          yield {
            type: "done",
            summary: {
              runId: "",
              toolsCalled: [],
              durationMs: 0,
              costCents: 0,
              tokenUsage: { inputTokens: 0, outputTokens: 0 },
            },
          };
        }
      } catch (err: any) {
        sessionStore.cleanup(sessionKey);
        yield {
          type: "error",
          message: `CLI mode error: ${err?.message ?? "Unknown error"}`,
        };
      } finally {
        // ATOMIC triad tail (F2): release/pause the acquired warm lease on EVERY
        // exit of the turn body — normal completion, early return, thrown error,
        // and generator abandonment (consumer break → .return()). No-op when
        // commanderSandbox is null (self-hosted / host fallback), so the host path
        // stays byte-identical. Best-effort — a release failure never masks the
        // turn's own outcome. The guard-refuse early-return above releases before
        // it returns (outside this try), so there is no double-release.
        if (commanderSandbox) await commanderSandbox.release().catch(() => undefined);
      }
    },

    getSessionStore() {
      return sessionStore;
    },

    shutdown() {
      clearInterval(idleTimer);
      sessionStore.shutdownAll();
    },
  };
}

// ── Stream Helper ───────────────────────────────────────────────────────────

/**
 * How long to keep reading stdout after `exit` when `close` never arrives.
 *
 * `close` is the correct terminal signal (it fires only once stdio has
 * drained), but a grandchild that inherited the stdout pipe — an MCP server or
 * a bash tool the CLI spawned — can hold it open indefinitely. This bounds
 * that wait. 2s is far longer than a pipe flush of an already-exited process
 * needs (sub-millisecond in practice) while staying well inside any user's
 * patience for a turn that has, by definition, already failed.
 */
const STDIO_DRAIN_GRACE_MS = 2000;

async function* streamProcessOutput(
  proc: import("node:child_process").ChildProcess,
  useStreamJson = false,
): AsyncGenerator<AgentStreamChunk> {
  const pending: AgentStreamChunk[] = [];
  let done = false;
  let resolve: (() => void) | null = null;
  let leftover = "";
  // Failure surfacing (see `finish` below): a CLI that dies without emitting a
  // parseable result must not render as an empty reply.
  //   sawContent — a real assistant text chunk (non-empty delta) reached the
  //                client, so the turn produced something meaningful.
  //   sawError   — an explicit error chunk was already emitted (e.g. a `result`
  //                event carrying is_error), so don't double-report.
  // Deliberately NOT "any chunk": a system/init/progress chunk followed by
  // exit 1 must still surface an error.
  let sawContent = false;
  let sawError = false;
  let finished = false;
  let graceTimer: NodeJS.Timeout | null = null;

  if (!proc.stdout) {
    // No stdout pipe at all — nothing can ever be parsed, whatever the exit
    // code. Report that specifically: the process was NOT terminated, and
    // guessing at a signal from a null `exitCode` (which is simply what a
    // still-running process reports) would misattribute the cause.
    yield { type: "error", message: "The CLI produced no output stream." };
    return;
  }

  function record(chunk: AgentStreamChunk) {
    if (chunk.type === "text" && chunk.delta.length > 0) sawContent = true;
    else if (chunk.type === "error") sawError = true;
    pending.push(chunk);
  }

  // Branch parser: claude_cli uses the structured stream-json parser;
  // codex / opencode stay on the existing text-format marker-in-prose path.
  const streamParser = useStreamJson ? new StreamJsonParser() : null;
  function processLines(text: string) {
    if (streamParser) {
      // StreamJsonParser handles its own internal buffering — just push text.
      for (const chunk of streamParser.push(text)) {
        record(chunk);
      }
    } else {
      const lines = (leftover + text).split("\n");
      leftover = lines.pop() ?? "";          // last segment is incomplete
      for (const line of lines) {
        for (const chunk of parseCliOutput(line)) {
          record(chunk);
        }
      }
    }
  }

  function flushLeftover() {
    if (streamParser) {
      for (const chunk of streamParser.flush()) {
        record(chunk);
      }
    } else if (leftover.length > 0) {
      for (const chunk of parseCliOutput(leftover)) {
        record(chunk);
      }
      leftover = "";
    }
  }

  function notify() {
    if (resolve) { resolve(); resolve = null; }
  }

  /**
   * Terminal transition. A child can emit BOTH `error` (spawn failure) and
   * `close`, so this is idempotent — a second call would double-flush the parser
   * and could push a second error chunk.
   *
   * This never emits a `done` chunk: the caller owns the single-done invariant
   * (`sawRealDone` + fallback). A failure error chunk here leaves that logic
   * untouched, so the caller still emits exactly one done.
   */
  function finish(code: number | null, signalled: boolean) {
    if (finished) return;
    finished = true;

    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }

    flushLeftover();

    const failed = signalled || (code ?? 0) !== 0;
    if (failed && !sawError && !sawContent) {
      pending.push({
        type: "error",
        message: signalled
          ? "The CLI was terminated before it produced a response."
          : `The CLI exited with code ${code ?? -1} without producing output.`,
      });
    }

    done = true;
    notify();
  }

  proc.stdout.on("data", (data: Buffer) => {
    processLines(data.toString());
    notify();
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const text = data.toString();
    if (text.trim().length > 0) {
      // stderr is raw CLI output and can echo tokens/keys from the environment.
      logger.warn(
        { service: "commander-cli", stderr: redactSecretsInString(text).slice(0, 2000) },
        "CLI subprocess stderr",
      );
    }
  });

  // `exit` fires while stdout may still hold buffered data — Node calls
  // flushStdio() AFTER emitting `exit`. Terminating on `exit` alone destroys
  // output the CLI already wrote, which is the common case for a fast-failing
  // `claude --print --output-format stream-json`: it writes its whole result
  // (including the is_error/auth reason) in one small buffer microseconds
  // before exiting nonzero. `close` fires only once every stdio stream has
  // drained, so it is the correct terminal signal.
  //
  // `close` alone would hang forever if a grandchild (MCP server, bash tool)
  // inherited the stdout pipe and outlives the CLI, so `exit` arms a bounded
  // grace window as a backstop.
  proc.on("exit", (code: number | null) => {
    graceTimer = setTimeout(() => finish(code, code === null), STDIO_DRAIN_GRACE_MS);
    graceTimer.unref?.();
  });
  proc.on("close", (code: number | null) => finish(code, code === null));
  proc.on("error", () => finish(null, true));

  while (true) {
    while (pending.length > 0) {
      yield pending.shift()!;
    }
    if (done) break;
    await new Promise<void>((r) => { resolve = r; });
  }
}

// ── codex one-shot turn helper (MX-chatparse) ───────────────────────────────
//
// `codex exec` is ONE-SHOT: it runs the turn and exits. There is no
// persistent process and no per-line text; codex emits JSONL events on
// stdout. So: spawn fresh, pipe the prompt over stdin, buffer the WHOLE
// turn's stdout+stderr, and on exit run parseCodexJsonl. The assistant
// reply is the parsed `summary` (NOT raw JSON — the pre-MX-chatparse bug).
// Continuity is via codex's `resume <sessionId> -`; an unknown-session
// resume retries once FRESH (mirrors the codex-local adapter). claude is
// NOT routed here — its persistent-process/plain-text path is unchanged.
//
// Token-by-token streaming for codex is an explicit deferred polish: v1
// emits the full `summary` as a single text chunk on turn completion.

interface RunCodexTurnArgs {
  mcpParams: McpConfigParams;
  /**
   * FU-8: real connector secret values keyed by their `${AOA_MCP_*_TOKEN}` env
   * var name. Empty ⇒ no connectors (byte-identical spawn env). When present,
   * the spawn base is scrubbed of AoA's own ambient secrets and these tokens
   * are re-applied — the CLI (and any stdio connector child it spawns) never
   * inherits DATABASE_URL / the embeddings key / the secrets master key / etc.
   */
  connectorEnv: Record<string, string>;
  /**
   * Phase 4 (Task 13): the resolved Commander provider-credential env patch
   * (api-key value / gateway / subscription home). Empty ⇒ host login (byte-
   * identical spawn env). Overlaid LAST so a configured connection wins over the
   * ambient login. NOTE: for a personal_subscription this carries CODEX_HOME (the
   * scoped auth home) which shadows the managed MCP CODEX_HOME from
   * resolveCliInvocation — a known beta limitation for codex + subscription.
   */
  credentialEnv?: Record<string, string>;
  prompt: string;
  isWin: boolean;
  resumeSessionId: string | null;
  vendorCliBypassEnabled: boolean;
  /** internal_agent_config.model (validated downstream) — pins the codex model. */
  codexModel?: string | null;
  /** Called with the parsed codex sessionId so the caller can persist it. */
  onSessionId: (sessionId: string | null) => void;
}

async function* runCodexTurn(
  args: RunCodexTurnArgs,
): AsyncGenerator<AgentStreamChunk> {
  const { parseCodexJsonl, isCodexUnknownSessionError } = await import(
    "@armyofagents/adapter-codex-local/server"
  );

  // Buffer the full stdout+stderr of one codex process to completion.
  // Returns the collected output AND the resolved model string from the
  // invocation (for provenance reporting — F1).
  async function spawnAndCollect(
    resume: string | null,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; resolvedModel: string | undefined }> {
    // Shell-boundary re-validation: validateSessionId() strips metacharacters
    // that would execute as shell commands on Windows (spawn uses shell:true).
    // The primary validation runs at onSessionId (store time); this is
    // defense-in-depth so the shell boundary is safe even if a future write
    // path bypasses the callback.
    const safeResume = resume ? validateSessionId(resume) : null;

    // resolveCliInvocation writes the per-session CODEX_HOME/config.toml
    // (the bridge must be present on EVERY spawn — MX4 parity) and builds
    // the argv (`exec --json [resume <id>] -`).
    const invocation = await resolveCliInvocation(
      "codex",
      args.mcpParams,
      args.prompt, // codex prompt is delivered over stdin, NOT argv
      safeResume,
      undefined,
      args.vendorCliBypassEnabled,
      args.codexModel ?? null,
    );
    if (!invocation) {
      // codex is a wired CLI — resolveCliInvocation never returns null for
      // it. Defensive: surface rather than spawn garbage.
      throw new Error("codex invocation could not be resolved");
    }

    // cwd = tmpdir() — same reasoning as the claude_cli spawn above: keeps
    // the subprocess from reading project CLAUDE.md / AGENTS.md files that
    // contain internal implementation details (e.g. "Paperclip") not meant
    // to surface to users.
    //
    // FU-23 secret scrub (mirrors the claude_cli spawn): when this turn hosts
    // third-party MCP connectors, the CLI — and every stdio connector child it
    // spawns — must NOT inherit AoA's ambient secret env. Scrub the base down to
    // PATH/HOME/etc., re-apply only the connector `${AOA_MCP_*_TOKEN}` values the
    // config placeholders expand from, then overlay codex's CODEX_HOME last (the
    // `aoa` bridge stays functional — buildMcpBridgeSpec re-supplies its own
    // config on the bridge spec env). No-connectors turns keep the full env
    // (byte-identical to pre-FU-8; there is no third-party child to protect).
    // P1 (Codex): gate on the resolved SPEC map, not connectorEnv. A secretless
    // connector yields a nonempty spec map but empty connectorEnv; gating on
    // connectorEnv would skip this scrub and leak AoA's ambient secrets into that
    // connector's stdio child. Presence of ANY external spec means "scrub".
    const connectorsPresent = Object.keys(args.mcpParams.extraMcpServers ?? {}).length > 0;
    // Phase 4 (Task 13): the resolved Commander credential patch overlays LAST so a
    // configured provider_connection wins over the ambient login. Empty ⇒ no-op.
    const credentialEnv = args.credentialEnv ?? {};
    const spawnEnv = connectorsPresent
      ? {
          ...mergeConnectorEnv(buildScrubbedCliEnv(), args.connectorEnv),
          ...(invocation.spawnEnv ?? {}),
          ...credentialEnv,
        }
      : { ...process.env, ...invocation.spawnEnv, ...credentialEnv };
    const proc = spawn(invocation.binary, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      shell: args.isWin,
      cwd: tmpdir(),
    });

    // Swallow stdin stream errors (P1, Codex): an early CLI exit + a prompt
    // larger than the OS pipe buffer makes the write below raise EPIPE; without
    // an `error` listener that's an unhandled stream error that crashes the
    // server. The early exit is captured by the close/exit handling instead.
    proc.stdin?.on("error", () => {});

    // codex reads the prompt from stdin (the `-` PROMPT arg) until EOF, so
    // the stream MUST be closed for the one-shot turn to proceed. Raw
    // content (NOT the win32 argv-escaped form) — codex never sees a shell.
    if (proc.stdin?.writable) {
      proc.stdin.write(args.prompt + "\n");
      proc.stdin.end?.();
    }

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    const exitCode = await new Promise<number | null>((resolveExit) => {
      proc.on("exit", (code) => resolveExit(code));
      proc.on("error", () => resolveExit(-1));
    });

    return { stdout, stderr, exitCode, resolvedModel: invocation.resolvedModel };
  }

  let result = await spawnAndCollect(args.resumeSessionId);

  // Unknown/stale resume session ⇒ retry ONCE fresh (no `resume`), so the
  // turn renders instead of hanging or surfacing "CLI session ended".
  if (
    args.resumeSessionId &&
    (result.exitCode ?? 0) !== 0 &&
    isCodexUnknownSessionError(result.stdout, result.stderr)
  ) {
    result = await spawnAndCollect(null);
  }

  const parsed = parseCodexJsonl(result.stdout);
  const toolsCalled = Array.from(
    new Set(
      (parsed.chunks ?? [])
        .filter((chunk) => chunk.type === "tool_call" || chunk.type === "tool_result")
        .map((chunk) => chunk.name)
        .filter(Boolean),
    ),
  );

  // Persist/refresh the codex sessionId for the NEXT turn's `resume`.
  // Validate against safe-char allowlist before storing — on Windows, spawn
  // uses shell:true so metacharacters in args execute as shell commands (C2).
  args.onSessionId(validateSessionId(parsed.sessionId));

  const errorMessage =
    parsed.errorMessage ??
    ((result.exitCode ?? 0) !== 0 && !parsed.summary
      ? isCodexUnknownSessionError(result.stdout, result.stderr)
        ? "codex session could not be resumed and a fresh attempt failed."
        : `codex exited with code ${result.exitCode ?? -1}`
      : null);

  if (errorMessage) {
    yield { type: "error", message: errorMessage };
    return;
  }

  for (const chunk of parsed.chunks ?? []) {
    // Re-validate the codex LiftedOutputRef[] (v:1|2, structurally looser) to
    // ShowRef[] at this boundary — the widened AgentStreamChunk.refs is ShowRef[]
    // and LiftedOutputRef is not assignable to it. Applies to EVERY tool_result
    // chunk (incl. empty refs) so the raw LiftedOutputRef[] never reaches yield.
    if (chunk.type === "tool_result") {
      const refs = (Array.isArray(chunk.refs) ? chunk.refs : []).flatMap((r) => {
        const parsedRef = showRefSchema.safeParse(r);
        if (parsedRef.success) return [parsedRef.data];
        // P2.4 drop observability: this per-ref revalidation drops silently
        // otherwise, so the founder never sees why a chip vanished. Non-fatal.
        const rec = (r ?? {}) as Record<string, unknown>;
        logger.debug(
          {
            service: "commander-cli",
            toolName: chunk.name,
            droppedKind: typeof rec.kind === "string" ? rec.kind : null,
            droppedId: typeof rec.id === "string" ? rec.id : null,
            zodIssues: parsedRef.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          },
          "Dropped malformed output ref from codex tool_result",
        );
        return [];
      });
      yield { ...chunk, refs };
    } else {
      yield chunk;
    }
  }

  // v1: emit the full parsed assistant reply as a single text chunk
  // (token-by-token codex streaming is a deferred polish). NEVER the raw
  // JSONL — that was the rendered-nothing bug.
  if (parsed.summary) {
    yield { type: "text", delta: parsed.summary };
  }

  // Real-usage done (cost left 0 — codex subscription has no per-run billing;
  // the route estimates from tokens via computeCostCents).
  // Carry the resolved model + provider for F1 provenance columns in the DB.
  yield {
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
      ...(result.resolvedModel
        ? { model: result.resolvedModel, provider: "openai" }
        : {}),
    },
  };
}

// ── Test seam ───────────────────────────────────────────────────────────────
// streamProcessOutput is internal to the chat pipeline; exported here so its
// process-failure handling can be exercised against a fake ChildProcess.
export const __testables = { streamProcessOutput, STDIO_DRAIN_GRACE_MS };
