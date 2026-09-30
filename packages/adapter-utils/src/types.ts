// ---------------------------------------------------------------------------
// Minimal adapter-facing interfaces (no drizzle dependency)
// ---------------------------------------------------------------------------

import type { AdapterModelProfile } from "./model-profiles.js";
import type { McpHttpServerSpec, McpServerSpec } from "./mcp-server-spec.js";

export interface AdapterAgent {
  id: string;
  companyId: string;
  name: string;
  adapterType: string | null;
  adapterConfig: unknown;
}

export interface AdapterRuntime {
  /**
   * Legacy single session id view. Prefer `sessionParams` + `sessionDisplayId`.
   */
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  taskKey: string | null;
}

// ---------------------------------------------------------------------------
// Execution types (moved from server/src/adapters/types.ts)
// ---------------------------------------------------------------------------

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type AdapterBillingType =
  | "api"
  | "subscription"
  | "metered_api"
  | "subscription_included"
  | "subscription_overage"
  | "credits"
  | "fixed"
  | "unknown";

export type AdapterExecutionTargetType = "local" | "sandbox-docker" | "provider-sandbox";

export interface AdapterLocalExecutionTarget {
  type: "local";
}

export interface AdapterDockerIsolation {
  user?: string | null;                 // --user 1000:1000
  readOnlyRootfs?: boolean;             // --read-only
  tmpfs?: string[];                     // --tmpfs entries
  memory?: string | null;              // --memory + --memory-swap
  cpus?: string | null;                // --cpus
  pidsLimit?: number | null;           // --pids-limit
  capDropAll?: boolean;                // --cap-drop=ALL
  noNewPrivileges?: boolean;           // --security-opt no-new-privileges
  seccompProfile?: string | null;      // --security-opt seccomp=<path>
  ulimitNofile?: number | null;        // --ulimit nofile=N:N
  ipcPrivate?: boolean;                // --ipc private
}

export interface AdapterDockerExecutionTarget {
  type: "sandbox-docker";
  image: string;
  workdir?: string | null;
  shell?: "sh" | "bash" | null;
  network?: "bridge" | "host" | "none" | null;
  remove?: boolean;
  env?: Record<string, string>;
  installCommand?: string | null;
  /** gVisor: emit `--runtime=runsc`. Default undefined = runc (unchanged). */
  runtime?: "runc" | "runsc" | null;
  /** Opt-in hardening. Default undefined = legacy args (back-compat). */
  isolation?: AdapterDockerIsolation | null;
  /** When true AND callback bridge is active, emit `--add-host host-gateway`. */
  allowHostGateway?: boolean;
}

export interface AdapterProviderSandboxRunInput {
  runId: string;
  provider: string;
  providerLeaseId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutSec: number;
  graceSec: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (pid: number | null, pgid: number | null, startedAt: Date) => void;
}

export interface AdapterProviderSandboxRunner {
  execute(input: AdapterProviderSandboxRunInput): Promise<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>;
}

export interface AdapterProviderSandboxExecutionTarget {
  type: "provider-sandbox";
  provider: string;
  providerLeaseId: string;
  remoteCwd: string;
  shell?: "sh" | "bash" | null;
  env?: Record<string, string>;
  runner: AdapterProviderSandboxRunner;
}

export type AdapterExecutionTarget =
  | AdapterLocalExecutionTarget
  | AdapterDockerExecutionTarget
  | AdapterProviderSandboxExecutionTarget;

export interface AdapterRuntimeCommandSpec {
  command: string;
  detectCommand?: string | null;
  installCommand?: string | null;
}

export interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorMeta?: Record<string, unknown>;
  usage?: UsageSummary;
  /**
   * Legacy single session id output. Prefer `sessionParams` + `sessionDisplayId`.
   */
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  model?: string | null;
  billingType?: AdapterBillingType | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  runtimeServices?: AdapterRuntimeServiceReport[];
  summary?: string | null;
  clearSession?: boolean;
  /**
   * Absolute local directory the adapter actually used for file operations.
   * Heartbeat uses this for output detection because configured cwd and
   * persisted execution workspace cwd can intentionally differ.
   */
  executionCwd?: string | null;
  /** Adapter-hinted output files (paths relative to workspace) */
  outputFiles?: Array<{
    path: string;
    label?: string;
    artifactType?: string;
  }>;
}

export interface AdapterRuntimeServiceReport {
  id?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  issueId?: string | null;
  scopeType?: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId?: string | null;
  serviceName: string;
  status?: "starting" | "running" | "stopped" | "failed";
  lifecycle?: "shared" | "ephemeral";
  reuseKey?: string | null;
  command?: string | null;
  cwd?: string | null;
  port?: number | null;
  url?: string | null;
  providerRef?: string | null;
  ownerAgentId?: string | null;
  stopPolicy?: Record<string, unknown> | null;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
}

export interface AdapterSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?: (params: Record<string, unknown> | null) => string | null;
}

export interface AdapterInvocationMeta {
  adapterType: string;
  command: string;
  cwd?: string;
  commandArgs?: string[];
  commandNotes?: string[];
  env?: Record<string, string>;
  prompt?: string;
  promptMetrics?: Record<string, number>;
  context?: Record<string, unknown>;
}

export type AdapterModelProfileDefinition = AdapterModelProfile;

/**
 * Provider-neutral MCP bridge spec ({command,args,env}). Local copy of the
 * shape produced by the server's buildMcpBridgeSpec — adapter-utils must not
 * import from the server. Carried optionally on AdapterExecutionContext so a
 * controller can hand adapters a ready-to-spawn MCP server description without
 * the adapter reconstructing claude-specific config. Additive: nothing in this
 * milestone reads it.
 */
export interface McpBridgeSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type AdapterRuntimePermissionDecision = "allow_once" | "allow_always" | "deny";
export type AdapterRuntimeDecisionTimeoutPolicy =
  | "deny"
  | "cancel_run"
  | "park_run"
  | "continue_with_default"
  | "escalate";

export interface AdapterRuntimeDecisionPromptBase {
  nonce?: string;
  title: string;
  summary?: string | null;
  promptText?: string | null;
  toolName?: string | null;
  command?: string | null;
  cwd?: string | null;
  path?: string | null;
  networkTarget?: string | null;
  riskClass?: string | null;
  options?: Array<Record<string, unknown>> | null;
  expiresAt?: Date | string | null;
  timeoutPolicy?: AdapterRuntimeDecisionTimeoutPolicy;
}

export interface AdapterRuntimePermissionPrompt extends AdapterRuntimeDecisionPromptBase {
  kind?: "permission";
}

export interface AdapterRuntimeWorkQuestionPrompt extends AdapterRuntimeDecisionPromptBase {
  kind?: "work_question";
}

export interface AdapterRuntimePermissionAnswer {
  kind: "permission";
  decisionId: string;
  decision: AdapterRuntimePermissionDecision;
  sourceRevision: number;
}

export interface AdapterRuntimeWorkQuestionAnswer {
  kind: "work_question";
  decisionId: string;
  answer: Record<string, unknown>;
  sourceRevision: number;
}

export interface AdapterRuntimeDecisionBroker {
  requestPermission(input: AdapterRuntimePermissionPrompt): Promise<AdapterRuntimePermissionAnswer>;
  /**
   * Timeout-aware permission request. Resolves with the answer when a human
   * responds within `timeoutMs`, or `{ timedOut: true }` when the wait elapses.
   *
   * CRITICAL: On timeout the underlying decision row is NOT marked relayed — a
   * late answer arriving after the CLI hook gave up must never produce a stale
   * "relayed" state. The W5a expiry sweep reconciles the row via its expiresAt.
   * This is why callers MUST use this method (not a naive Promise.race over
   * requestPermission, whose underlying wait polls indefinitely).
   */
  requestPermissionBounded(
    prompt: AdapterRuntimePermissionPrompt,
    timeoutMs: number,
  ): Promise<AdapterRuntimePermissionAnswer | { timedOut: true }>;
  askWorkQuestion(input: AdapterRuntimeWorkQuestionPrompt): Promise<AdapterRuntimeWorkQuestionAnswer>;
}

export type HumanQuestionRuntimeCapabilities =
  | { mode: "ask_and_park"; preservesProducerInvocationId: true }
  | {
      mode: "live_relay";
      preservesProducerInvocationId: true;
      pauseDeadline: true;
      resumeSession: true;
      cancelWait: true;
    };

/**
 * Non-secret configuration the adapter needs to wire up the PreToolUse hook
 * HTTP callback. Contains only plain strings safe to log. The per-run bearer
 * token is injected via env (RUNTIME_HOOK_TOKEN) and MUST NOT appear here —
 * AdapterExecutionContext.context and config fields are persisted into run
 * events, so secrets must never flow through this struct.
 */
export interface RuntimeHookBridgeSpec {
  enabled: boolean;
  selfBaseUrl: string;
  path: string;
  timeoutSec: number;
}

export interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;
  runtime: AdapterRuntime;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  executionTarget?: AdapterExecutionTarget;
  runtimeCommandSpec?: AdapterRuntimeCommandSpec | null;
  /**
   * Optional provider-neutral MCP bridge spec. When present, an adapter may
   * spawn this MCP server instead of building its own. Unset → adapter falls
   * back to existing behavior. Wired by a later milestone.
   *
   * U4b (S7): a brokered (E2B-sandboxed) run's `aoa` server is an
   * {@link McpHttpServerSpec} instead of the stdio {@link McpBridgeSpec} — the
   * stdio shape's `env` carries `DATABASE_URL`, which must never be staged
   * into a sandboxed VM's config file. The caller (runner.ts/heartbeat.ts)
   * selects the shape; adapters that understand only stdio (codex/opencode/
   * gemini writers) branch on `isHttpServerSpec` and render the HTTP form
   * through their existing external-connector HTTP path. Non-brokered runs
   * keep the unchanged stdio shape — byte-identical.
   *
   * External connectors travel separately on `mcpServers` below — this field
   * never carries them.
   */
  mcpBridge?: McpBridgeSpec | McpHttpServerSpec;
  /**
   * Optional external MCP servers (connectors), keyed by server name. Delivered
   * ALONGSIDE `mcpBridge` — `mcpBridge` remains AoA's own loopback server and is
   * never represented here. Adapters that do not understand this field simply
   * ignore it and behave exactly as before.
   *
   * Reserved names `aoa` and `playwright` MUST be filtered before merging — a
   * connector must never shadow them.
   *
   * An adapter that cannot support a given transport (e.g. no HTTP MCP support)
   * MUST skip that entry and continue, rather than failing the run.
   *
   * SECRETS: values may contain `${VAR}` placeholders. Whether these are
   * expanded by the target CLI from process env is per-CLI and not universally
   * verified (verified for claude_local in Task 4) — for a CLI that does not
   * expand them, the connector receives a literal `${VAR}` as its token and
   * fails at connect time. Never place a real secret in this struct — it is
   * persisted into run events (see RuntimeHookBridgeSpec note above).
   */
  mcpServers?: Record<string, McpServerSpec>;
  /**
   * Optional human-decision broker. Adapters can use this to pause a run for a
   * permission prompt or work-question without knowing how the Hub stores,
   * displays, or relays answers. Unset means the adapter falls back to existing
   * local behavior.
   */
  runtimeDecisionBroker?: AdapterRuntimeDecisionBroker;
  /**
   * Provider-declared Ask Human behavior. Missing or malformed capabilities
   * fail closed to ask-and-park; adapters are never inferred by type name.
   */
  humanQuestionCapabilities?: HumanQuestionRuntimeCapabilities;
  /**
   * NON-SECRET plain boolean: whether runtime-decision routing (human approval
   * supervision) is enabled for THIS run, per the Task 6 allow-list resolver
   * (env kill-switch + adapter allow-list + local target + per-agent opt-in).
   *
   * Adapters branch on THIS flag — not on `runtimeDecisionBroker != null`. The
   * broker is passed on EVERY run (so its mere presence says nothing about
   * whether supervision is active); routing on broker-presence is a miswire.
   * codex_local uses this to switch to its in-process app-server approval
   * bridge; claude_local additionally receives the HTTP hook machinery.
   *
   * Safe to include in logged meta (contains no secret). Unset/false → adapter
   * takes its existing, unsupervised path.
   */
  runtimeDecisionRoutingEnabled?: boolean;
  /**
   * Non-secret hook bridge config for wiring the adapter's PreToolUse HTTP
   * callback. Carries only plain strings (base URL, path, timeout) — MUST NOT
   * contain the per-run bearer token. The token is passed to the adapter via
   * env (RUNTIME_HOOK_TOKEN) because context/config are persisted into run events.
   * Unset → adapter runs without the permission bridge (existing behavior).
   */
  runtimeHookBridge?: RuntimeHookBridgeSpec;
  /**
   * Per-run hook bearer token — SECRET. Passed to the spawned child via
   * AOA_RUNTIME_HOOK_TOKEN env var only. Never placed in ctx.context, ctx.config,
   * or logged meta (onMeta logs context + redacted env; the key-name "TOKEN"
   * is caught by redactEnvForLogs). Sibling of authToken, not nested in context.
   */
  runtimeHookToken?: string;
  /**
   * NON-SECRET plain boolean: isolate this run from the HOST machine's ambient
   * agent configuration (D9). Set ONLY by the crew runner (`runAoaAgent`, agents
   * with kind='aoa'); org/heartbeat runs leave it unset and are unaffected.
   *
   * Honoring it is per-adapter opt-in — today claude_local strips the ambient
   * `CLAUDE_*`/`ANTHROPIC_*` classes and pins `CLAUDE_CONFIG_DIR` to a per-run
   * directory, so the operator's `~/.claude` (SessionStart hooks, third-party
   * skills, plugins) and the server's ambient API key cannot bleed into a crew
   * agent. Other adapters currently ignore it.
   *
   * This is env hygiene, NOT process sandboxing: HOME/USERPROFILE/PATH are never
   * relocated (git, SSH and npm resolve through them for the tools the agent
   * launches).
   */
  isolateAmbientConfig?: boolean;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AdapterInvocationMeta) => Promise<void>;
  authToken?: string;
  /**
   * Optional hook called by the adapter immediately after spawning the
   * underlying subprocess. The adapter forwards (pid, pgid, startedAt)
   * so the controller (heartbeat) can persist them for cleanup + watchdog.
   */
  onSpawn?: (pid: number | null, pgid: number | null, startedAt: Date) => void;
}

export interface AdapterModel {
  id: string;
  label: string;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}

export type AdapterSkillSyncMode = "unsupported" | "persistent" | "ephemeral";

export type AdapterSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export type AdapterSkillOrigin =
  | "company_managed"
  | "aoa_required"
  | "user_installed"
  | "external_unknown";

export interface AdapterSkillEntry {
  key: string;
  runtimeName: string | null;
  desired: boolean;
  managed: boolean;
  required?: boolean;
  requiredReason?: string | null;
  state: AdapterSkillState;
  origin?: AdapterSkillOrigin;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface AdapterSkillSnapshot {
  adapterType: string;
  supported: boolean;
  mode: AdapterSkillSyncMode;
  desiredSkills: string[];
  entries: AdapterSkillEntry[];
  warnings: string[];
}

export interface AdapterSkillContext {
  agentId: string;
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

export interface AdapterEnvironmentTestContext {
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
  executionTarget?: AdapterExecutionTarget;
  environmentName?: string | null;
  deployment?: {
    mode?: "local_trusted" | "authenticated" | "cloud_auth";
    exposure?: "private" | "public";
    bindHost?: string | null;
    allowedHostnames?: string[];
  };
}

/** Payload for the onHireApproved adapter lifecycle hook (e.g. join-request or hire_agent approval). */
export interface HireApprovedPayload {
  companyId: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  /** "join_request" | "approval" */
  source: "join_request" | "approval";
  sourceId: string;
  approvedAt: string;
  /** Canonical operator-facing message for cloud adapters to show the user. */
  message: string;
}

/** Result of onHireApproved hook; failures are non-fatal to the approval flow. */
export interface HireApprovedHookResult {
  ok: boolean;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface ServerAdapterModule {
  type: string;
  humanQuestionCapabilities?: HumanQuestionRuntimeCapabilities;
  execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult>;
  listSkills?: (ctx: AdapterSkillContext) => Promise<AdapterSkillSnapshot>;
  syncSkills?: (
    ctx: AdapterSkillContext,
    desiredSkills: string[],
  ) => Promise<AdapterSkillSnapshot>;
  sessionCodec?: AdapterSessionCodec;
  supportsLocalAgentJwt?: boolean;
  models?: AdapterModel[];
  listModels?: () => Promise<AdapterModel[]>;
  modelProfiles?: AdapterModelProfile[];
  listModelProfiles?: () => Promise<AdapterModelProfile[]>;
  getRuntimeCommandSpec?: (config: Record<string, unknown>) => AdapterRuntimeCommandSpec | null;
  agentConfigurationDoc?: string;
  /**
   * Optional lifecycle hook when an agent is approved/hired (join-request or hire_agent approval).
   * adapterConfig is the agent's adapter config so the adapter can e.g. send a callback to a configured URL.
   */
  onHireApproved?: (
    payload: HireApprovedPayload,
    adapterConfig: Record<string, unknown>,
  ) => Promise<HireApprovedHookResult>;

  /**
   * Adapter supports managed instructions bundle (AGENTS.md files).
   * When true, the server uses instructionsPathKey (default "instructionsFilePath")
   * to resolve the instructions config key, and the UI shows the bundle editor.
   */
  supportsInstructionsBundle?: boolean;

  /**
   * The adapterConfig key that holds the instructions file path.
   * Defaults to "instructionsFilePath" when supportsInstructionsBundle is true.
   */
  instructionsPathKey?: string;

  /**
   * Adapter needs runtime skill entries materialized (written to disk)
   * before being passed via config. Used by adapters that scan a directory
   * rather than reading config.aoaRuntimeSkills.
   */
  requiresMaterializedRuntimeSkills?: boolean;
}

// ---------------------------------------------------------------------------
// UI types (moved from ui/src/adapters/types.ts)
// ---------------------------------------------------------------------------

export type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown }
  | { kind: "tool_result"; ts: string; toolUseId: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; subtype: string; isError: boolean; errors: string[] }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

export type StdoutLineParser = (line: string, ts: string) => TranscriptEntry[];

// ---------------------------------------------------------------------------
// CLI types (moved from cli/src/adapters/types.ts)
// ---------------------------------------------------------------------------

export interface CLIAdapterModule {
  type: string;
  formatStdoutEvent: (line: string, debug: boolean) => void;
}

// ---------------------------------------------------------------------------
// UI config form values (moved from ui/src/components/AgentConfigForm.tsx)
// ---------------------------------------------------------------------------

export type AdapterConfigFieldType =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "toggle"
  | "select"
  | "secret"
  | "json"
  | "env";

export interface AdapterConfigFieldSchema {
  key: string;
  type: AdapterConfigFieldType;
  label: string;
  description?: string;
  hint?: string;
  required?: boolean;
  default?: unknown;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
  meta?: Record<string, unknown>;
}

export interface AdapterConfigSchema {
  version: 1;
  fields: AdapterConfigFieldSchema[];
}

export interface CreateConfigValues {
  adapterType: string;
  cwd: string;
  instructionsFilePath?: string;
  promptTemplate: string;
  model: string;
  thinkingEffort: string;
  chrome: boolean;
  dangerouslySkipPermissions: boolean;
  search: boolean;
  fastMode?: boolean;
  dangerouslyBypassSandbox: boolean;
  command: string;
  args: string;
  extraArgs: string;
  envVars: string;
  envBindings: Record<string, unknown>;
  url: string;
  bootstrapPrompt: string;
  maxTurnsPerRun: number;
  heartbeatEnabled: boolean;
  intervalSec: number;
  adapterSchemaValues?: Record<string, unknown>;
  workspaceStrategyType?: string;
  workspaceBaseRef?: string;
  workspaceBranchTemplate?: string;
  worktreeParentDir?: string;
  runtimeServicesJson?: string;
  payloadTemplateJson?: string;
}
