import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetProcess,
  syncAdapterExecutionTargetDirectory,
  syncAdapterExecutionTargetFile,
  aoaAmbientSecretEnvKeys,
  stripConnectorRunBearers,
  type AdapterBillingType,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@armyofagents/adapter-utils";
import type { RunProcessResult } from "@armyofagents/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildAoaEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  foldEnvKey,
  renderTemplate,
  runChildProcess,
  applyAoaWorkspaceEnv,
} from "@armyofagents/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import {
  buildPreToolUseSettings,
  writeRuntimeHookSettingsFile,
  writeRuntimeHookTokenFile,
} from "./runtime-hook-settings.js";
import {
  CLAUDE_AMBIENT_CONFIG_UNSET_PREFIXES,
  CLAUDE_SESSION_IDENTITY_UNSET_KEYS,
  ClaudeCredentialsMissingError,
  claudeCredentialChangedSinceProvisioning,
  createIsolatedClaudeConfigDir,
  hasOverlayConfiguredClaudeAuth,
  provisionClaudeConfigHome,
  releaseIsolatedClaudeConfigDir,
} from "./ambient-config.js";
import { resolveClaudeConfigHome } from "./login.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const AOA_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills"),         // published: <pkg>/dist/server/ -> <pkg>/skills/
  path.resolve(__moduleDir, "../../../../../skills"), // dev: src/server/ -> repo root/skills/
];

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of AOA_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

/**
 * Create a tmpdir with `.claude/skills/` containing symlinks to skills from
 * the repo's `skills/` directory, so `--add-dir` makes Claude Code discover
 * them as proper registered skills.
 */
async function buildSkillsDir(
  dbSkills?: Array<{ key: string; name: string; markdown: string; files?: Array<{ path: string; content: string }> }>,
): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const skillsDir = await resolvePaperclipSkillsDir();
  if (skillsDir) {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const src = path.join(skillsDir, entry.name);
        const dest = path.join(target, entry.name);
        try {
          await fs.symlink(src, dest, process.platform === "win32" ? "junction" : undefined);
        } catch {
          // Fallback to copy if symlink/junction fails (Windows without admin)
          await fs.cp(src, dest, { recursive: true });
        }
      }
    }
  }
  // Write DB-backed company skills
  if (dbSkills) {
    for (const skill of dbSkills) {
      const skillFolderName = skill.key.replace(/\//g, "--");
      const skillDir = path.join(target, skillFolderName);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skill.markdown, "utf-8");
      for (const file of skill.files ?? []) {
        const fullPath = path.join(skillDir, file.path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, file.content, "utf-8");
      }
    }
  }
  return tmp;
}

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
  executionTarget?: AdapterExecutionContext["executionTarget"];
}

interface ClaudeRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

export function isBedrockAuth(env: Record<string, string>): boolean {
  if (env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_BEDROCK === "true") return true;
  if (hasNonEmptyEnvValue(env, "ANTHROPIC_BEDROCK_BASE_URL")) return true;
  return false;
}

export function resolveClaudeBillingType(env: Record<string, string>): AdapterBillingType {
  if (isBedrockAuth(env)) return "metered_api";
  // Claude uses API-key auth when ANTHROPIC_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;
  const executionTarget = input.executionTarget ?? { type: "local" as const };

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.AOA_API_KEY === "string" && envConfig.AOA_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildAoaEnv(agent) };
  env.AOA_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) {
    env.AOA_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.AOA_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.AOA_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.AOA_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.AOA_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.AOA_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  applyAoaWorkspaceEnv(env, {
    workspaceCwd: effectiveWorkspaceCwd || null,
    workspaceSource: workspaceSource || null,
    workspaceStrategy: asString(workspaceContext.strategy, "") || null,
    workspaceId: workspaceId || null,
    workspaceRepoUrl: workspaceRepoUrl || null,
    workspaceRepoRef: workspaceRepoRef || null,
    workspaceBranch: asString(workspaceContext.branchName, "") || null,
    workspaceWorktreePath: asString(workspaceContext.worktreePath, "") || null,
    agentHome: asString(workspaceContext.agentHome, "") || null,
  });
  if (workspaceHints.length > 0) {
    env.AOA_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.AOA_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  if (executionTarget.type === "local") {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
  }

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
    exitCode: proc.exitCode,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken, onSpawn, runtimeHookBridge, runtimeHookToken } = ctx;
  const executionTarget = ctx.executionTarget ?? { type: "local" as const };
  const isRemoteExecutionTarget = adapterExecutionTargetIsRemote(executionTarget);

  // FU-23: when THIS run hosts external MCP connectors, claude spawns each stdio
  // connector's child (`npx -y <pkg>`) with claude's inherited env. Scrub AoA's
  // ambient secrets (DB creds, embeddings OPENAI_API_KEY, auth signing secret,
  // master key, GitHub PAT) from that env so a third-party package can't read
  // them. The `aoa` bridge is unaffected: it is spawned from the generated
  // --mcp-config file whose `mcpServers.aoa.env` re-supplies DATABASE_URL + the
  // secrets-provider config (buildMcpBridgeSpec). The connector's own
  // `${AOA_MCP_*_TOKEN}` lives in the spawn OVERLAY (`env` below), which
  // mergeChildEnv preserves through the strip. No-connector runs keep the full
  // env, byte-identical (empty list → no strip).
  // F4 — connector ENV ISOLATION (ambient scrub + bearer strip + authToken:null)
  // applies only when a STDIO connector will spawn a local child that inherits the
  // CLI env. HTTP connectors are remote: they inherit nothing, so an http-only run
  // must stay byte-identical to a no-connector run. Otherwise merely enabling an
  // HTTP connector would strip the agent's own AOA_API_KEY and 401 its REST calls
  // (Codex F4). The connector CONFIG (--mcp-config) is still built from
  // ctx.mcpServers regardless of transport — this gate is env-isolation only.
  const hasStdioConnector =
    ctx.mcpServers != null &&
    Object.values(ctx.mcpServers).some((s) => (s as { kind?: string } | null)?.kind === "stdio");
  const connectorScrubKeys = hasStdioConnector ? aoaAmbientSecretEnvKeys() : undefined;

  const promptTemplate = asString(
    config.promptTemplate,
    [
      "You are agent {{agent.id}} ({{agent.name}}). Continue your AoA work.",
      "{{context.currentTaskMarkdown}}",
    ].join("\n\n"),
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const commandNotes = [
    ...(instructionsFilePath
      ? [
          `Configured agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended for local target)`,
        ]
      : []),
    `Execution target: ${executionTarget.type}`,
  ];

  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
    executionTarget,
  });
  const {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  const billingType = resolveClaudeBillingType(env);
  const dbSkills = (context.skills as Array<{ key: string; name: string; markdown: string; files?: Array<{ path: string; content: string }> }> | undefined) ?? [];
  const skillsDir = await buildSkillsDir(dbSkills.length > 0 ? dbSkills : undefined);

  // ── Reclaim scope ──────────────────────────────────────────────────────────
  // Everything from here to the `finally` runs INSIDE the try, so any throw —
  // not just a provisioning failure — reclaims whatever was already created.
  // These three are declared outside it purely so the `finally` can see them.
  //
  // 🚨 This is why the try opens HERE and not at the run. It used to open just
  // before `runAttempt`, which left a window where provisioning had SUCCEEDED
  // (a live credential on disk) and an ordinary later failure — an ENOENT on a
  // mistyped instructionsFilePath, a bridged-mode mkdtemp — escaped past it. The
  // credential then sat on disk until the next sweep. One reclaim site, no
  // window, and no invariant of the form "nothing between these two lines can
  // throw" for a future edit to quietly break.
  let isolatedConfigDir: string | null = null;
  let hookSettingsTmpDir: string | null = null;
  let provisionedCredential: { path: string; fingerprint: string } | null = null;

  try {
    // --- Ambient Claude-config isolation (D9, crew-only) ---
    // Opt-in per run via ctx.isolateAmbientConfig — set by the crew runner, never
    // by heartbeat, so org runs keep inheriting the operator's environment exactly
    // as before. When on: pin CLAUDE_CONFIG_DIR to a per-run directory (an
    // overlay-set key survives the strip by mergeChildEnv's "overlay wins" rule)
    // and strip the ambient CLAUDE_*/ANTHROPIC_* classes at the spawn.
    //
    // LOCAL TARGETS ONLY. A remote child (docker / provider-sandbox) never sees
    // the host env, so it is isolated by construction and the strip is moot —
    // while a pinned HOST path forwarded into the container is actively
    // wrong (a `C:\…` path inside Linux) AND would override the managed
    // `env.HOME = runtimeRootDir` below, which is how the CLI finds a correct
    // in-container ~/.claude. Same short-circuit as opencode-local's
    // runtime-config.ts on `targetIsRemote`.
    const isolateAmbientConfig = ctx.isolateAmbientConfig === true && !isRemoteExecutionTarget;
    // Find an agent-configured CLAUDE_CONFIG_DIR using the SAME case-folding the
    // strip uses — literally `foldEnvKey`, the function mergeChildEnv's strip
    // calls, rather than a third private copy of the rule. On Windows
    // `Claude_Config_Dir` IS `CLAUDE_CONFIG_DIR`; a direct property read would
    // miss that spelling and mint a per-run dir as well, leaving the overlay
    // carrying two spellings of ONE Windows variable with different values, both
    // surviving the strip (both are overlay keys), and which one the child ends
    // up with is not decided here. An empty/whitespace value counts as
    // unconfigured (pinning "" helps nobody).
    const configuredConfigDirKey = Object.keys(env).find(
      (key) => foldEnvKey(key) === foldEnvKey("CLAUDE_CONFIG_DIR") && env[key].trim().length > 0,
    );
    // 🚨 T3 ORDERING. Resolve the OPERATOR's config home from `process.env` — the
    // ambient environment, exactly as it is BEFORE the pin below rewrites the
    // overlay's CLAUDE_CONFIG_DIR to the (empty) per-run directory. Read the
    // OVERLAY instead, or read it after the pin, and `resolveClaudeConfigHome`
    // hands back the copy TARGET: provisioning then "succeeds" having copied
    // nothing, and the agent dies deep inside the CLI with an opaque auth error.
    // `provisionClaudeConfigHome` re-asserts source !== target so an inversion is
    // a loud throw rather than a silent no-op, and the crew integration test
    // asserts the child actually SEES the credential.
    const operatorConfigHome = isolateAmbientConfig ? resolveClaudeConfigHome(process.env) : null;
    // U12: the operator ~/.claude provisioning below must NEVER run for a
    // sandbox (cloud) target — the operator login is the platform's, not the
    // tenant's. `isolateAmbientConfig` is already forced false for a remote
    // target (`&& !isRemoteExecutionTarget` above), so `operatorConfigHome` is
    // null and `provisionClaudeConfigHome` (below) never runs. Assert it so a
    // future edit to that line cannot silently re-open the path. No throw in
    // the normal path — a remote target legitimately authenticates via the
    // injected provider key from U5's allowlist, never the operator's CLI login.
    if (isRemoteExecutionTarget && operatorConfigHome !== null) {
      throw new Error("invariant: operator ~/.claude provisioning must be disabled for a remote/sandbox target");
    }
    if (isolateAmbientConfig && !configuredConfigDirKey) {
      // Only mint a per-run dir when the agent did NOT configure one. An operator
      // pointing crew at a dedicated, already-logged-in config home via
      // adapterConfig.env is a supported way to give a crew run working
      // credentials — clobbering it would silently break that escape hatch, and
      // every other provider-auth variable set that way survives.
      isolatedConfigDir = await createIsolatedClaudeConfigDir();
      env.CLAUDE_CONFIG_DIR = isolatedConfigDir;

      // T3: the minted directory is empty, which makes the run unauthenticated.
      // Copy in the credential file — and ONLY the credential file. The other 19
      // entries of a real `~/.claude` (CLAUDE.md, settings.json, plugins/, skills/,
      // sessions/, …) are precisely the contamination D9 exists to stop.
      //
      // NOTE this branch deliberately does NOT run for an agent-configured
      // CLAUDE_CONFIG_DIR: that directory is the operator's own logged-in home, so
      // writing into it would overwrite their credential with ours.
      try {
        const provisioned = await provisionClaudeConfigHome({
          sourceConfigHome: operatorConfigHome!,
          targetDir: isolatedConfigDir,
        });
        // Kept so teardown can tell whether the CLI rewrote its private copy —
        // see the rotation note on provisionClaudeConfigHome.
        provisionedCredential = { path: provisioned.credentialPath, fingerprint: provisioned.fingerprint };
        // 🚨 RAW path here, deliberately — the opposite of what
        // ClaudeCredentialsMissingError does. The two strings have different
        // audiences: that error is persisted to `internal_agent_runs.errorMessage`
        // and RENDERS ON THE CREW CARD, where the operator's account name would be
        // broadcast to every teammate with thread access, so it is home-relativised.
        // These commandNotes are run diagnostics, shown beside the redacted env to
        // whoever is debugging this run, and a `~`-collapsed path there costs
        // debuggability for no privacy gain. Do not "finish" the M11 fix by
        // relativising these, and do not assume they are already sanitised.
        commandNotes.push(`Claude credentials provisioned into the per-run config home from ${operatorConfigHome}`);
      } catch (err) {
        // The escape hatch T2 documented: an operator whose Claude access is
        // env-based (Bedrock / Vertex / a gateway / an explicit key on
        // adapterConfig.env) has no credential file and never needed one. Turning
        // their working configuration into a hard failure would be a regression,
        // so a missing credential is only fatal when nothing else can authenticate.
        if (err instanceof ClaudeCredentialsMissingError && hasOverlayConfiguredClaudeAuth(env)) {
          await onLog("stderr", `[aoa] ${err.message}\n`);
          commandNotes.push(
            `Isolated config home left empty: no Claude credential file at ${operatorConfigHome} — ` +
              `this run authenticates from the env-based auth configured on the agent instead`,
          );
        } else {
          // Fail BEFORE the spawn. The alternative is an unauthenticated `--print`
          // run that dies somewhere inside the CLI with a message the founder
          // cannot act on; this message lands verbatim on the run row and the crew
          // failure card. No manual reclaim here — this throw is inside the try,
          // so the `finally` removes the minted directory and skillsDir like any
          // other failure.
          throw err;
        }
      }
    }
    if (isolateAmbientConfig) {
      // Surfaced through onMeta next to the redacted env. A crew run reads its
      // config from somewhere other than the host `~/.claude` that Settings →
      // Providers probes, so naming the directory here is what makes an auth
      // failure self-explaining instead of a dead end. (Threading the isolation
      // into the readiness probe itself is a separate task.) The
      // "(agent-configured)" marker matters: without it the note reads as though
      // AoA overrode the operator's own setting, which is the opposite of what
      // happened.
      const effectiveConfigDir = isolatedConfigDir ?? env[configuredConfigDirKey!];
      commandNotes.push(
        `Ambient Claude config isolated (crew run); CLAUDE_CONFIG_DIR pinned to ${effectiveConfigDir}${
          isolatedConfigDir === null ? " (agent-configured)" : ""
        }`,
      );
    }
    const unsetEnvPrefixes = isolateAmbientConfig
      ? [...CLAUDE_AMBIENT_CONFIG_UNSET_PREFIXES]
      : undefined;
    // --- Parent session-identity strip (T3c, ALWAYS-ON: org AND crew) ---
    // The parent Claude Code session's identity/process vars bleed into every
    // child when AoA's server is started from inside a Claude Code session (how
    // AoA is developed, QA'd and live-verified). Unlike the operator's ~/.claude
    // login — which an org agent legitimately inherits — these keys declare the
    // child a continuation of a specific live session (the most plausible
    // live-hijack input), carry NO credential, and are never legitimate to pass
    // on. So they are stripped for EVERY claude_local run via mergeChildEnv's
    // exact-key unsetEnvKeys. Crew already drops them under the CLAUDE_ prefix
    // strip above (redundant-but-harmless); org gains exactly this. Both feed the
    // one mergeChildEnv, and overlay-wins still applies: an agent that explicitly
    // sets one of these on adapterConfig.env keeps its own value.
    const unsetEnvKeys = [
      ...CLAUDE_SESSION_IDENTITY_UNSET_KEYS,
      // Connectors present → also scrub AoA ambient secrets so a third-party
      // MCP server never sees DATABASE_URL / provider keys (Decision #116, FU-23).
      ...(connectorScrubKeys ?? []),
    ];
    // ------------------------------------------------------

    // --- Runtime hook bridge (Task 6) ---
    // bridged = true when caller explicitly sets runtimeHookBridge.enabled
    const bridged = runtimeHookBridge?.enabled === true;
    // forwarderPath: hook-forward.mjs lives alongside execute.ts/execute.js in src/server or dist/server
    const forwarderPath = path.resolve(__moduleDir, "hook-forward.mjs");
    let hookSettingsFilePath: string | null = null;
    if (bridged) {
      const endpointUrl = runtimeHookBridge!.selfBaseUrl + runtimeHookBridge!.path;
      hookSettingsTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-runtime-hooks-"));
      // F1 — deliver the bearer token via a FILE whose path is a hook-command arg,
      // NOT via AOA_RUNTIME_HOOK_TOKEN in the child env. The Claude CLI passes its
      // full env to every stdio connector child, so an env token would leak there;
      // and `stripConnectorRunBearers` (below) removes it on connector runs, which
      // would break the fail-closed hook — denying Bash/Write/Edit/WebFetch for the
      // whole run (Codex F1). The connector child never sees the hook's argv, so the
      // token-file path stays out of its reach. Only the non-secret URL rides in env.
      let hookTokenFilePath: string | undefined;
      if (runtimeHookToken) {
        hookTokenFilePath = await writeRuntimeHookTokenFile(hookSettingsTmpDir, runtimeHookToken);
      }
      const hookSettings = buildPreToolUseSettings({
        endpointUrl,
        timeoutSec: runtimeHookBridge!.timeoutSec,
        forwarderPath,
        tokenFilePath: hookTokenFilePath,
      });
      hookSettingsFilePath = await writeRuntimeHookSettingsFile(hookSettingsTmpDir, hookSettings);
      // AOA_RUNTIME_HOOK_URL is a plain non-secret URL; redacted by value in onMeta
      // only if it looks like a secret (it doesn't). The token is NOT injected here.
      env.AOA_RUNTIME_HOOK_URL = endpointUrl;
    }
    // ------------------------------------

    // WS1 — with the run bearers now assembled, remove them from the
    // connector-facing env: the vendor CLI passes its FULL env to every stdio
    // connector child (empirically confirmed), so a connector would otherwise
    // inherit AOA_API_KEY (call AoA as the agent) or AOA_RUNTIME_HOOK_TOKEN
    // (forge runtime permission prompts). No-op without connectors → no-connector
    // runs stay byte-identical.
    stripConnectorRunBearers(env, {
      connectorsPresent: hasStdioConnector,
      secretValues: [authToken, runtimeHookToken],
    });

    const executionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
    const preparedRuntime = await prepareAdapterExecutionTargetRuntime({
      target: executionTarget,
      workspaceLocalDir: cwd,
      adapterKey: "claude",
      runId,
      timeoutSec,
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? command,
    });
    const runtimeRootDir = preparedRuntime.runtimeRootDir;
    if (runtimeRootDir && adapterExecutionTargetUsesManagedHome(executionTarget)) {
      env.HOME = runtimeRootDir;
    }

    // When instructionsFilePath is configured, create a combined temp file that
    // includes both the file content and the path directive, so we only need
    // --append-system-prompt-file (Claude CLI forbids using both flags together).
    let effectiveInstructionsFilePath = instructionsFilePath;
    if (instructionsFilePath) {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const pathDirective = `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
      const combinedPath = path.join(skillsDir, "agent-instructions.md");
      await fs.writeFile(combinedPath, instructionsContent + pathDirective, "utf-8");
      effectiveInstructionsFilePath = combinedPath;
    }
    let effectiveRemoteInstructionsFilePath: string | null = null;
    let effectiveRemoteSkillsDir: string | null = null;
    let effectiveRemoteMcpConfigPath: string | null = null;
    if (isRemoteExecutionTarget && runtimeRootDir) {
      effectiveRemoteSkillsDir = `${runtimeRootDir}/.claude/skills`;
      await syncAdapterExecutionTargetDirectory({
        runId: `${runId}-claude-skills`,
        target: executionTarget,
        localDir: path.join(skillsDir, ".claude", "skills"),
        remoteDir: effectiveRemoteSkillsDir,
        cwd: executionCwd,
        env,
        timeoutSec,
        graceSec,
        followSymlinks: true,
        onLog,
      });
      if (effectiveInstructionsFilePath) {
        effectiveRemoteInstructionsFilePath = `${runtimeRootDir}/agent-instructions.md`;
        await syncAdapterExecutionTargetFile({
          runId: `${runId}-claude-instructions`,
          target: executionTarget,
          localPath: effectiveInstructionsFilePath,
          remotePath: effectiveRemoteInstructionsFilePath,
          cwd: executionCwd,
          env,
          timeoutSec,
          graceSec,
          onLog,
        });
      }
      // W7.4 — stage the brokered `aoa` MCP config into the sandbox VM. The
      // runner writes it to a HOST tmp path and threads
      // `--mcp-config <hostPath> --strict-mcp-config` through extraArgs (see
      // runner.ts / heartbeat-mcp.ts). In a remote sandbox that host path does
      // not exist, so without this the in-VM `claude --mcp-config <hostPath>`
      // finds nothing and the agent spawns with ZERO broker tools — the whole
      // point of the config. Mirror opencode-local: sync the file into the
      // runtime root, then rewrite the `--mcp-config` value to the remote path
      // in buildClaudeArgs below. Detection matches the space-separated pair
      // AoA emits (same form the `hasManagedMcpConfig` check reads). An
      // unbridged/desktop run carries no such pair → left null → the arg
      // rewrite is a no-op and the pushed args stay byte-identical.
      const mcpConfigFlagIndex = extraArgs.indexOf("--mcp-config");
      const localMcpConfigPath =
        mcpConfigFlagIndex >= 0 && mcpConfigFlagIndex + 1 < extraArgs.length
          ? extraArgs[mcpConfigFlagIndex + 1]
          : null;
      if (localMcpConfigPath) {
        effectiveRemoteMcpConfigPath = `${runtimeRootDir}/aoa-mcp-config.json`;
        await syncAdapterExecutionTargetFile({
          runId: `${runId}-claude-mcp-config`,
          target: executionTarget,
          localPath: localMcpConfigPath,
          remotePath: effectiveRemoteMcpConfigPath,
          cwd: executionCwd,
          env,
          timeoutSec,
          graceSec,
          onLog,
        });
      }
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const sessionCwdMatches = runtimeSessionCwd.length === 0 || (
      isRemoteExecutionTarget
        ? runtimeSessionCwd === executionCwd
        : path.resolve(runtimeSessionCwd) === path.resolve(executionCwd)
    );
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      sessionCwdMatches &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, executionTarget);
    const sessionId = canResumeSession ? runtimeSessionId : null;
    if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stderr",
        `[aoa] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${executionCwd}".\n`,
      );
    }
    const renderedPrompt = renderTemplate(promptTemplate, {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    });
    const currentTaskMarkdown = typeof context.currentTaskMarkdown === "string"
      ? context.currentTaskMarkdown.trim()
      : "";
    const prompt = currentTaskMarkdown && !/{{\s*context\.currentTaskMarkdown\s*}}/.test(promptTemplate)
      ? `${renderedPrompt.trimEnd()}\n\n${currentTaskMarkdown}`
      : renderedPrompt;

    const buildClaudeArgs = async (resumeSessionId: string | null) => {
      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      if (hookSettingsFilePath) {
        // Bridged mode: wire the PreToolUse hook via --settings.
        // --dangerously-skip-permissions and --settings must never coexist: skip-permissions bypasses
        // all tool approval, defeating the permission bridge entirely.
        args.push("--settings", hookSettingsFilePath);
      } else if (dangerouslySkipPermissions) {
        // Unbridged: honor config.dangerouslySkipPermissions as before.
        args.push("--dangerously-skip-permissions");
      }
      // MCP tools are NOT governed by the PreToolUse hook (its matcher covers only
      // built-in tools — Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch), so a headless
      // agent run would otherwise be denied every `mcp__aoa__*` call (e.g. query_memory)
      // with no human to grant it. The MCP bridge already restricts EXPOSURE to the run's
      // curated allowlist (ORG_HEARTBEAT_TOOL_ALLOWLIST / Commander surface), so permitting
      // the whole `mcp__aoa` server here is bounded by that allowlist. Skip when
      // skip-permissions already allows everything.
      const hasManagedMcpConfig =
        extraArgs.includes("--mcp-config") && extraArgs.includes("--strict-mcp-config");
      if (!dangerouslySkipPermissions && hasManagedMcpConfig) {
        args.push("--allowedTools", "mcp__aoa");
      }
      if (chrome) args.push("--chrome");
      if (model && !isBedrockAuth(env)) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      const instructionsArg = isRemoteExecutionTarget
        ? effectiveRemoteInstructionsFilePath
        : effectiveInstructionsFilePath;
      const skillsArg = isRemoteExecutionTarget ? effectiveRemoteSkillsDir : skillsDir;
      if (instructionsArg) {
        args.push("--append-system-prompt-file", instructionsArg);
      }
      if (skillsArg) {
        args.push("--add-dir", skillsArg);
      }
      // W7.4 — when the mcp-config was staged into the VM (remote target), the
      // pushed `--mcp-config <hostPath>` must point at the REMOTE copy instead;
      // otherwise the in-VM claude reads a host path that does not exist there
      // and loses every broker tool. Applied to WHICHEVER branch pushes the
      // extra args (bridged filteredArgs OR unbridged extraArgs). Null on a
      // local/desktop run → identity (byte-identical to before).
      const rewriteMcpConfigArg = (argList: string[]): string[] => {
        if (!effectiveRemoteMcpConfigPath) return argList;
        const idx = argList.indexOf("--mcp-config");
        if (idx < 0 || idx + 1 >= argList.length) return argList;
        const rewritten = [...argList];
        rewritten[idx + 1] = effectiveRemoteMcpConfigPath;
        return rewritten;
      };
      if (extraArgs.length > 0) {
        if (hookSettingsFilePath) {
          // Bridged mode: strip bypass flags that defeat the PreToolUse hook.
          // These flags would re-enable Claude's permission bypass, making the
          // hook's deny decisions ineffective.
          const BYPASS_FLAGS = new Set([
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
          ]);
          const BYPASS_PERMISSION_MODE_VALUES = new Set(["bypassPermissions", "dontAsk"]);
          const stripped: string[] = [];
          const filteredArgs: string[] = [];
          let i = 0;
          while (i < extraArgs.length) {
            const arg = extraArgs[i];
            if (BYPASS_FLAGS.has(arg)) {
              stripped.push(arg);
              i++;
            } else if (arg === "--permission-mode" && i + 1 < extraArgs.length) {
              const value = extraArgs[i + 1];
              if (BYPASS_PERMISSION_MODE_VALUES.has(value)) {
                stripped.push(`${arg} ${value}`);
                i += 2;
              } else {
                filteredArgs.push(arg, value);
                i += 2;
              }
            } else if (arg.startsWith("--permission-mode=")) {
              const value = arg.slice("--permission-mode=".length);
              if (BYPASS_PERMISSION_MODE_VALUES.has(value)) {
                stripped.push(arg);
                i++;
              } else {
                filteredArgs.push(arg);
                i++;
              }
            } else {
              filteredArgs.push(arg);
              i++;
            }
          }
          if (stripped.length > 0) {
            await onLog(
              "stderr",
              `[aoa] WARNING: bridged mode — stripped bypass flag(s) from extraArgs that would defeat the PreToolUse permission hook: ${stripped.join(", ")}\n`,
            );
          }
          if (filteredArgs.length > 0) args.push(...rewriteMcpConfigArg(filteredArgs));
        } else {
          args.push(...rewriteMcpConfigArg(extraArgs));
        }
      }
      return args;
    };

    const parseFallbackErrorMessage = (proc: RunProcessResult) => {
      const stderrLine =
        proc.stderr
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? "";

      if ((proc.exitCode ?? 0) === 0) {
        return "Failed to parse claude JSON output";
      }

      return stderrLine
        ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
        : `Claude exited with code ${proc.exitCode ?? -1}`;
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      const args = await buildClaudeArgs(resumeSessionId);
      if (onMeta) {
        await onMeta({
          adapterType: "claude_local",
          command,
          cwd: executionCwd,
          commandArgs: args,
          commandNotes,
          env: redactEnvForLogs(env),
          prompt,
          context,
        });
      }

      const proc = await runAdapterExecutionTargetProcess(executionTarget, {
        runId,
        command,
        args,
        cwd: executionCwd,
        env,
        stdin: prompt,
        // Stdio-connector runs: null the token param too — some execution targets
        // (sandbox-docker) forward it into a host callback bridge, so leaving it
        // would reintroduce the credential the env-strip just removed. HTTP-only
        // runs keep the bearer (F4 — no local child inherits it).
        authToken: hasStdioConnector ? null : (env.AOA_API_KEY ?? authToken ?? null),
        apiBaseUrl: env.AOA_API_URL ?? null,
        runtimeCommandSpec: ctx.runtimeCommandSpec ?? null,
        timeoutSec,
        graceSec,
        onLog,
        onSpawn,
        unsetEnvKeys,
        ...(unsetEnvPrefixes ? { unsetEnvPrefixes } : {}),
        // U5 — resolved provider for the sandbox env allowlist: claude-local
        // always runs against Anthropic, so ANTHROPIC_API_KEY/BASE_URL/MODEL
        // are the only provider auth keys admissible in a sandboxed run.
        sandboxProvider: "anthropic",
      });

      const parsedStream = parseClaudeStreamJson(proc.stdout);
      const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
      return { proc, parsedStream, parsed };
    };

    const toAdapterResult = (
      attempt: {
        proc: RunProcessResult;
        parsedStream: ReturnType<typeof parseClaudeStreamJson>;
        parsed: Record<string, unknown> | null;
      },
      opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
    ): AdapterExecutionResult => {
      const { proc, parsedStream, parsed } = attempt;
      const loginMeta = detectClaudeLoginRequired({
        parsed,
        stdout: proc.stdout,
        stderr: proc.stderr,
        exitCode: proc.exitCode,
      });
      const errorMeta =
        loginMeta.loginUrl != null
          ? {
              loginUrl: loginMeta.loginUrl,
            }
          : undefined;

      if (proc.timedOut) {
        return {
          exitCode: proc.exitCode,
          signal: proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          errorCode: "timeout",
          errorMeta,
          clearSession: Boolean(opts.clearSessionOnMissingSession),
          executionCwd,
        };
      }

      if (!parsed) {
        return {
          exitCode: proc.exitCode,
          signal: proc.signal,
          timedOut: false,
          errorMessage: parseFallbackErrorMessage(proc),
          errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
          errorMeta,
          resultJson: {
            stdout: proc.stdout,
            stderr: proc.stderr,
          },
          clearSession: Boolean(opts.clearSessionOnMissingSession),
          executionCwd,
        };
      }

      const usage =
        parsedStream.usage ??
        (() => {
          const usageObj = parseObject(parsed.usage);
          return {
            inputTokens: asNumber(usageObj.input_tokens, 0),
            cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
            outputTokens: asNumber(usageObj.output_tokens, 0),
          };
        })();

      const resolvedSessionId =
        parsedStream.sessionId ??
        (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
      const resolvedSessionParams = resolvedSessionId
        ? ({
          sessionId: resolvedSessionId,
          cwd: executionCwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(isRemoteExecutionTarget
            ? { remoteExecution: adapterExecutionTargetSessionIdentity(executionTarget) }
            : {}),
        } as Record<string, unknown>)
        : null;
      const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage:
          (proc.exitCode ?? 0) === 0
            ? null
            : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
        errorCode: clearSessionForMaxTurns
          ? "max_turns_exhausted"
          : loginMeta.requiresLogin
            ? "claude_auth_required"
            : null,
        errorMeta,
        usage,
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: isBedrockAuth(env) ? "aws_bedrock" : "anthropic",
        model: parsedStream.model || asString(parsed.model, model),
        billingType,
        costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
        executionCwd,
        resultJson: parsed,
        summary: parsedStream.summary || asString(parsed.result, ""),
        clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
      };
    };

    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await onLog(
        "stderr",
        `[aoa] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});
    if (hookSettingsTmpDir) {
      fs.rm(hookSettingsTmpDir, { recursive: true, force: true }).catch(() => {});
    }
    if (isolatedConfigDir) {
      // Did the CLI rewrite its private copy of the credential? If it did, it
      // refreshed the OAuth token into a file we are about to delete — and if
      // Anthropic rotates refresh tokens on use, the operator's host
      // `~/.claude` may have just been invalidated by a crew run. That is an
      // OPEN question (see provisionClaudeConfigHome's rotation note); this
      // warning exists so the first real occurrence is observed instead of
      // disappearing with the directory. Awaited — it must read the file before
      // the removal below — but fully best-effort.
      //
      // Wrapped whole: a throw here would replace the run's real result (or its
      // real error) with a teardown diagnostic, which is the opposite of what a
      // diagnostic is for. `.catch` alone would not cover an `onLog` that throws
      // synchronously.
      if (provisionedCredential) {
        try {
          const rotated = await claudeCredentialChangedSinceProvisioning(
            provisionedCredential.path,
            provisionedCredential.fingerprint,
          );
          if (rotated) {
            await onLog(
              "stderr",
              "[aoa] WARNING: the Claude CLI rewrote the per-run credential copy during this run " +
                "(likely an OAuth refresh). That refreshed token is being discarded with the per-run " +
                "config home. If Anthropic rotates refresh tokens on use, the host login at " +
                "~/.claude may now be stale — re-run `claude auth login` if the CLI starts asking " +
                "for auth. Please report this: it decides whether AoA must copy the credential back.\n",
            );
          }
        } catch {
          /* teardown diagnostics are never worth failing a run over */
        }
      }
      // Release BEFORE removing: if the rm fails (a Windows handle held a moment
      // longer), the directory must still be sweepable rather than pinned live
      // for the lifetime of the process.
      releaseIsolatedClaudeConfigDir(isolatedConfigDir);
      // AWAITED, unlike the two fire-and-forget removals above. This directory
      // holds a credential, so "gone by the time execute returns" is a stronger
      // and more testable guarantee than "gone eventually" — and it is one rm of
      // a two-entry directory. Still fully best-effort: a failure leaves it for
      // the sweep, which the release above has already made possible.
      await fs.rm(isolatedConfigDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
