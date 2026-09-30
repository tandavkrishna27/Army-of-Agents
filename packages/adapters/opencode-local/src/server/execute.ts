import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  runAdapterExecutionTargetProcess,
  syncAdapterExecutionTargetFile,
  aoaAmbientSecretEnvKeys,
  stripConnectorRunBearers,
  type AdapterExecutionContext,
  type AdapterExecutionResult,
} from "@armyofagents/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildAoaEnv,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  applyAoaWorkspaceEnv,
} from "@armyofagents/adapter-utils/server-utils";
import { isOpenCodeUnknownSessionError, parseOpenCodeJsonl } from "./parse.js";
import { ensureOpenCodeModelConfiguredAndAvailable } from "./models.js";
import { writeOpenCodeMcpConfigJson } from "./opencode-config-json.js";
import { prepareOpenCodeRuntimeConfig } from "./runtime-config.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
const AOA_SKILLS_CANDIDATES = [
  path.resolve(__moduleDir, "../../skills"),
  path.resolve(__moduleDir, "../../../../../skills"),
];

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function parseModelProvider(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed.includes("/")) return null;
  return trimmed.slice(0, trimmed.indexOf("/")).trim() || null;
}

function claudeSkillsHome(): string {
  return path.join(os.homedir(), ".claude", "skills");
}

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of AOA_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

async function ensureOpenCodeSkillsInjected(onLog: AdapterExecutionContext["onLog"]) {
  const skillsDir = await resolvePaperclipSkillsDir();
  if (!skillsDir) return;

  const skillsHome = claudeSkillsHome();
  await fs.mkdir(skillsHome, { recursive: true });
  const entries = await fs.readdir(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(skillsDir, entry.name);
    const target = path.join(skillsHome, entry.name);
    const existing = await fs.lstat(target).catch(() => null);
    if (existing) continue;

    try {
      await fs.symlink(source, target);
      await onLog(
        "stderr",
        `[aoa] Injected OpenCode skill "${entry.name}" into ${skillsHome}\n`,
      );
    } catch (err) {
      await onLog(
        "stderr",
        `[aoa] Failed to inject OpenCode skill "${entry.name}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken, onSpawn } = ctx;
  const executionTarget = ctx.executionTarget ?? { type: "local" as const };
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your AoA work.",
  );
  const command = asString(config.command, "opencode");
  const model = asString(config.model, "").trim();
  const variant = asString(config.variant, "").trim();

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  await ensureOpenCodeSkillsInjected(onLog);

  // T2.1: deliver the internal-agent MCP bridge to opencode via its native
  // discovery mechanism — a `mcp.aoa` block in opencode.json in the CWD.
  // Pre-T2.1, opencode crew agents spawned with no MCP tools (same failure
  // mode codex had pre-MX2): the LLM ran 30s, exited without calling any
  // tool, and the wakeup logged "succeeded" while having done nothing.
  // writeOpenCodeMcpConfigJson is idempotent and preserves any unrelated
  // top-level config (theme, model, other mcp servers) — see its header.
  //
  // External connectors (Plan 2b Task 6) ride along in the SAME write.
  //
  // C2 — the gate tests PRESENCE, not truthiness/emptiness: a run that delivers
  // `mcpServers: {}` (every connector deleted or disabled) MUST still reach the
  // writer, because the writer's sweep is what REMOVES the entries a previous
  // run wrote. Gating on non-emptiness would leave a revoked connector in
  // opencode.json forever and the agent would keep the tool. Same reason
  // `ctx.mcpBridge` alone no longer guards this: the day the bridge becomes
  // conditional, cleanup must not stop with it.
  if (ctx.mcpBridge !== undefined || ctx.mcpServers !== undefined) {
    const result = await writeOpenCodeMcpConfigJson(cwd, ctx.mcpBridge ?? null, {
      externalServers: ctx.mcpServers ?? {},
      // Scopes the ownership manifest, which lives under the AoA instance root
      // rather than in this repo.
      companyId: agent.companyId,
      agentId: agent.id,
    });
    if (executionTargetIsRemote) {
      await syncAdapterExecutionTargetFile({
        runId,
        target: executionTarget,
        localPath: path.join(cwd, "opencode.json"),
        remotePath: `${effectiveExecutionCwd}/opencode.json`,
        cwd: effectiveExecutionCwd,
        env: {},
        timeoutSec: 30,
        graceSec: 5,
        onLog,
      });
    }
    const connectorCount = Object.keys(ctx.mcpServers ?? {}).length;
    await onLog(
      "stderr",
      `[aoa] Wired opencode MCP config via opencode.json (${ctx.mcpBridge ? "bridge + " : ""}${connectorCount} external connector${connectorCount === 1 ? "" : "s"})\n`,
    );
    // A connector that vanishes without a word is the worst failure mode for a
    // security-adjacent feature — the founder believes the agent has the tool.
    for (const skip of result.skipped) {
      await onLog(
        "stderr",
        `[aoa] opencode MCP connector "${skip.serverName}" skipped: ${skip.reason}\n`,
      );
    }
  }

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
  if (wakeTaskId) env.AOA_TASK_ID = wakeTaskId;
  if (wakeReason) env.AOA_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.AOA_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.AOA_APPROVAL_ID = approvalId;
  if (approvalStatus) env.AOA_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.AOA_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
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
  if (workspaceHints.length > 0) env.AOA_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.AOA_API_KEY = authToken;
  }
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...process.env, ...env })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const baseExecutionEnv = executionTarget.type === "local" ? runtimeEnv : env;
  const preparedRuntimeConfig = await prepareOpenCodeRuntimeConfig({
    env: baseExecutionEnv,
    config,
    targetIsRemote: executionTarget.type !== "local",
  });
  const preparedRuntimeEnv = preparedRuntimeConfig.env;

  // FU-23: opencode is the outlier — for local targets it composes its spawn env
  // as `{ ...process.env, ...env }` (baseExecutionEnv above) and passes THAT to
  // the spawn, so AoA's ambient secrets sit in the spawn OVERLAY. mergeChildEnv
  // exempts overlay-set keys from `unsetEnvKeys`, so unsetEnvKeys ALONE cannot
  // remove them here — the ambient secrets must also be dropped from the overlay
  // we pass. When this run hosts external MCP connectors, compute the ambient
  // secrets present in the prepared env, EXCLUDING the adapter's own overlay keys
  // (`env`: the connector's `${AOA_MCP_*_TOKEN}`, AOA_RUN_ID/AOA_API_KEY, and any
  // agent-configured key), then (1) strip them from the spawn env and (2) also
  // pass them as `unsetEnvKeys` so spawnTrackedChild's own re-merge of
  // process.env drops them too. The `aoa` bridge keeps working from
  // opencode.json's `mcp.aoa.environment` (buildMcpBridgeSpec re-supplies
  // DATABASE_URL + secrets config). No-connector runs are byte-identical.
  // F4 — http connectors inherit nothing; env isolation is stdio-only. Only a
  // STDIO connector spawns a local child that inherits the CLI env, so all three
  // isolation concerns below (bearer strip, ambient scrub, authToken:null) gate
  // on a stdio connector being present. An http-only run inherits nothing local,
  // so isolating it has zero benefit and would wrongly strip the agent's own
  // AOA_API_KEY → its REST calls 401 in authenticated mode. Connector delivery
  // (opencode.json --mcp-config) is unchanged for every transport — this gate is
  // env-isolation only.
  const hasStdioConnector =
    ctx.mcpServers != null &&
    Object.values(ctx.mcpServers).some((s) => (s as { kind?: string } | null)?.kind === "stdio");
  // WS1 — strip the run bearer from the overlay BEFORE the scrub computes its
  // `keep` list from Object.keys(env); otherwise AOA_API_KEY is kept + spread
  // back onto the spawn env. opencode has no runtime hook token.
  stripConnectorRunBearers(env, { connectorsPresent: hasStdioConnector, secretValues: [authToken] });
  const connectorScrubKeys = hasStdioConnector
    ? aoaAmbientSecretEnvKeys(preparedRuntimeEnv, { keep: Object.keys(env) })
    : [];
  const spawnEnv =
    connectorScrubKeys.length > 0
      ? Object.fromEntries(
          Object.entries(preparedRuntimeEnv).filter(
            ([key]) => !connectorScrubKeys.includes(key),
          ),
        )
      : preparedRuntimeEnv;

  if (executionTarget.type === "local") {
    await ensureCommandResolvable(command, cwd, preparedRuntimeEnv);
    await ensureOpenCodeModelConfiguredAndAvailable({
      model,
      command,
      cwd,
      env: preparedRuntimeEnv,
    });
  } else if (!model) {
    throw new Error("OpenCode requires `adapterConfig.model` in provider/model format.");
  }

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
  const sessionCwd = executionTargetIsRemote ? effectiveExecutionCwd : cwd;
  const sessionTargetMatches = adapterExecutionTargetSessionMatches(runtimeRemoteExecution, executionTarget);
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || (
      executionTargetIsRemote
        ? runtimeSessionCwd === sessionCwd
        : path.resolve(runtimeSessionCwd) === path.resolve(sessionCwd)
    )) &&
    sessionTargetMatches;
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stderr",
      `[aoa] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${sessionCwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const resolvedInstructionsFilePath = instructionsFilePath
    ? path.resolve(cwd, instructionsFilePath)
    : "";
  const instructionsDir = resolvedInstructionsFilePath ? `${path.dirname(resolvedInstructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (resolvedInstructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(resolvedInstructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${resolvedInstructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      await onLog(
        "stderr",
        `[aoa] Loaded agent instructions file: ${resolvedInstructionsFilePath}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[aoa] Warning: could not read agent instructions file "${resolvedInstructionsFilePath}": ${reason}\n`,
      );
    }
  }

  const commandNotes = (() => {
    const notes = [`Execution target: ${executionTarget.type}`, ...preparedRuntimeConfig.notes];
    if (!resolvedInstructionsFilePath) return notes;
    if (instructionsPrefix.length > 0) {
      return [
        ...notes,
        `Loaded agent instructions from ${resolvedInstructionsFilePath}`,
        `Prepended instructions + path directive to stdin prompt (relative references from ${instructionsDir}).`,
      ];
    }
    return [
      ...notes,
      `Configured instructionsFilePath ${resolvedInstructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    ];
  })();

  const renderedPrompt = renderTemplate(promptTemplate, {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  });
  const prompt = `${instructionsPrefix}${renderedPrompt}`;

  // U5 fix (Wave 2 review): opencode is genuinely multi-provider — `model` is
  // required in `provider/model` format (see index.ts's doc + models.ts's
  // requireOpenCodeModelId) and toResult below already derives the run's
  // `provider` field the same way. Resolve it HERE too so the sandbox spawn
  // admits the correct provider auth key instead of dropping it (pre-fix, no
  // sandboxProvider was passed at all → provider:"" → every key stripped).
  const resolvedModelProvider = parseModelProvider(model || null);

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["run", "--format", "json"];
    if (resumeSessionId) args.push("--session", resumeSessionId);
    if (model) args.push("--model", model);
    if (variant) args.push("--variant", variant);
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "opencode_local",
        command,
        cwd,
        commandNotes,
        commandArgs: [...args, `<stdin prompt ${prompt.length} chars>`],
        env: redactEnvForLogs(preparedRuntimeEnv),
        prompt,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(executionTarget, {
      runId,
      command,
      args,
      cwd,
      env: spawnEnv,
      ...(connectorScrubKeys.length > 0 ? { unsetEnvKeys: connectorScrubKeys } : {}),
      stdin: prompt,
      authToken: hasStdioConnector ? null : (preparedRuntimeEnv.AOA_API_KEY ?? authToken ?? null),
      apiBaseUrl: preparedRuntimeEnv.AOA_API_URL ?? null,
      runtimeCommandSpec: ctx.runtimeCommandSpec ?? null,
      timeoutSec,
      graceSec,
      onLog,
      onSpawn,
      // U5 fix (Wave 2 review) — see resolvedModelProvider comment above.
      // "" (unresolved) still fails closed, matching the documented default.
      sandboxProvider: resolvedModelProvider ?? "",
    });
    return {
      proc,
      rawStderr: proc.stderr,
      parsed: parseOpenCodeJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: { exitCode: number | null; signal: string | null; timedOut: boolean; stdout: string; stderr: string };
      rawStderr: string;
      parsed: ReturnType<typeof parseOpenCodeJsonl>;
    },
    clearSessionOnMissingSession = false,
  ): AdapterExecutionResult => {
    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        clearSession: clearSessionOnMissingSession,
        executionCwd: sessionCwd,
      };
    }

    const resolvedSessionId =
      attempt.parsed.sessionId ??
      (clearSessionOnMissingSession ? null : runtimeSessionId ?? runtime.sessionId ?? null);
    const resolvedSessionParams = resolvedSessionId
      ? ({
          sessionId: resolvedSessionId,
          cwd: sessionCwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(executionTargetIsRemote
            ? { remoteExecution: adapterExecutionTargetSessionIdentity(executionTarget) }
            : {}),
        } as Record<string, unknown>)
      : null;

    const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
    const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
    const rawExitCode = attempt.proc.exitCode;
    const synthesizedExitCode = parsedError && (rawExitCode ?? 0) === 0 ? 1 : rawExitCode;
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `OpenCode exited with code ${synthesizedExitCode ?? -1}`;
    const modelId = model || null;

    return {
      exitCode: synthesizedExitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (synthesizedExitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      usage: {
        inputTokens: attempt.parsed.usage.inputTokens,
        outputTokens: attempt.parsed.usage.outputTokens,
        cachedInputTokens: attempt.parsed.usage.cachedInputTokens,
      },
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: parseModelProvider(modelId),
      model: modelId,
      billingType: "unknown",
      costUsd: attempt.parsed.costUsd,
      executionCwd: sessionCwd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !attempt.parsed.sessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId);
    const initialFailed =
      !initial.proc.timedOut && ((initial.proc.exitCode ?? 0) !== 0 || Boolean(initial.parsed.errorMessage));
    if (
      sessionId &&
      initialFailed &&
      isOpenCodeUnknownSessionError(initial.proc.stdout, initial.rawStderr)
    ) {
      await onLog(
        "stderr",
        `[aoa] OpenCode session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true);
    }

    return toResult(initial);
  } finally {
    await preparedRuntimeConfig.cleanup();
  }
}
