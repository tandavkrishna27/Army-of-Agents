import fs from "node:fs/promises";
import path from "node:path";
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
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildAoaEnv,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  redactEnvForLogs,
  renderTemplate,
  applyAoaWorkspaceEnv,
} from "@armyofagents/adapter-utils/server-utils";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "../index.js";
import {
  describeGeminiFailure,
  detectGeminiAuthRequired,
  isGeminiTurnLimitResult,
  isGeminiUnknownSessionError,
  parseGeminiJsonl,
} from "./parse.js";
import { firstNonEmptyLine } from "./utils.js";
import { writeGeminiMcpSettingsJson } from "./gemini-settings-json.js";
import {
  detectGeminiFolderTrust,
  geminiFolderTrustWarning,
} from "./gemini-folder-trust.js";

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveGeminiBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "GEMINI_API_KEY") || hasNonEmptyEnvValue(env, "GOOGLE_API_KEY")
    ? "api"
    : "subscription";
}

function renderAoaEnvNote(env: Record<string, string>): string {
  const aoaKeys = Object.keys(env)
    .filter((key) => key.startsWith("AOA_"))
    .sort();
  if (aoaKeys.length === 0) return "";
  return [
    "AoA runtime note:",
    `The following AOA_* environment variables are available in this run: ${aoaKeys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
    "",
    "",
  ].join("\n");
}

function renderApiAccessNote(env: Record<string, string>): string {
  if (!hasNonEmptyEnvValue(env, "AOA_API_URL") || !hasNonEmptyEnvValue(env, "AOA_API_KEY")) return "";
  return [
    "AoA API access note:",
    "Use run_shell_command with curl to make AoA API requests.",
    "GET example:",
    `  run_shell_command({ command: "curl -s -H \\"Authorization: Bearer $AOA_API_KEY\\" \\"$AOA_API_URL/api/agents/me\\"" })`,
    "POST/PATCH example:",
    `  run_shell_command({ command: "curl -s -X POST -H \\"Authorization: Bearer $AOA_API_KEY\\" -H 'Content-Type: application/json' -H \\"X-Aoa-Run-Id: $AOA_RUN_ID\\" -d '{...}' \\"$AOA_API_URL/api/issues/{id}/checkout\\"" })`,
    "",
    "",
  ].join("\n");
}

function joinPromptSections(sections: string[]): string {
  return sections.filter(Boolean).join("\n\n").trim();
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, authToken, onSpawn } = ctx;
  const executionTarget = ctx.executionTarget ?? { type: "local" as const };
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your AoA work.",
  );
  const command = asString(config.command, "gemini");
  const model = asString(config.model, DEFAULT_GEMINI_LOCAL_MODEL).trim();
  const sandbox = asBoolean(config.sandbox, false);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
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

  // T2.2: deliver the internal-agent MCP bridge to gemini via its native
  // discovery mechanism — a `mcpServers.aoa` block in .gemini/settings.json
  // inside the workspace cwd. Pre-T2.2, gemini crew agents spawned with no
  // MCP tools (same failure mode codex had pre-MX2 and opencode had
  // pre-T2.1): the LLM ran 30s, exited without calling any tool, wakeup
  // logged "succeeded" while having done nothing. Writing to the WORKSPACE-
  // scope `.gemini/` (not user-global `~/.gemini/`) bounds the pollution
  // radius to the adapter-controlled workspace. Idempotent, preserves
  // unrelated keys, strips prior aoa block before splicing — see
  // gemini-settings-json.ts header.
  //
  // External connectors (Plan 2b Task 6) ride along in the SAME write.
  //
  // C2 — the gate tests PRESENCE, not truthiness/emptiness: a run that delivers
  // `mcpServers: {}` (every connector deleted or disabled) MUST still reach the
  // writer, because the writer's sweep is what REMOVES the entries a previous
  // run wrote. Gating on non-emptiness would leave a revoked connector in
  // settings.json forever and the agent would keep the tool. Same reason
  // `ctx.mcpBridge` alone no longer guards this: the day the bridge becomes
  // conditional, cleanup must not stop with it.
  if (ctx.mcpBridge !== undefined || ctx.mcpServers !== undefined) {
    const result = await writeGeminiMcpSettingsJson(cwd, ctx.mcpBridge ?? null, {
      externalServers: ctx.mcpServers ?? {},
      // Scopes the ownership manifest, which lives under the AoA instance root
      // rather than in this workspace.
      companyId: agent.companyId,
      agentId: agent.id,
    });
    if (executionTargetIsRemote) {
      await syncAdapterExecutionTargetFile({
        runId,
        target: executionTarget,
        localPath: path.join(cwd, ".gemini", "settings.json"),
        remotePath: `${effectiveExecutionCwd}/.gemini/settings.json`,
        cwd: effectiveExecutionCwd,
        env: {},
        timeoutSec: 30,
        graceSec: 5,
        onLog,
      });
    }
    const connectorCount = Object.keys(ctx.mcpServers ?? {}).length;
    await onLog(
      "stdout",
      `[aoa] Wired gemini MCP config via .gemini/settings.json (${ctx.mcpBridge ? "bridge + " : ""}${connectorCount} external connector${connectorCount === 1 ? "" : "s"})\n`,
    );
    // Never let a connector vanish silently — the founder would believe the
    // agent has a tool it does not have. stderr, matching codex and opencode:
    // a skip is a diagnostic, and splitting them across streams makes the three
    // adapters impossible to grep uniformly (M7).
    for (const skip of result.skipped) {
      await onLog(
        "stderr",
        `[aoa] gemini MCP connector "${skip.serverName}" skipped: ${skip.reason}\n`,
      );
    }

    // B7 (corrected): everything above is moot if gemini folder trust is on —
    // it disables EVERY MCP server, including the bridge we just wrote, and
    // still exits 0. There is no known programmatic remedy (`--skip-trust` and
    // per-server `trust` were both empirically disproven), so the least-bad
    // behaviour is to make it loud. Best-effort: detection never fails the run.
    const folderTrust = await detectGeminiFolderTrust(cwd).catch(() => ({
      enabled: false,
      source: null,
    }));
    if (folderTrust.enabled) {
      await onLog("stderr", geminiFolderTrustWarning(folderTrust.source));
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
    agentHome: agentHome || null,
  });
  if (workspaceHints.length > 0) env.AOA_WORKSPACES_JSON = JSON.stringify(workspaceHints);

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!hasExplicitApiKey && authToken) {
    env.AOA_API_KEY = authToken;
  }
  // FU-23: scrub AoA's ambient secrets from the spawn env when this run hosts
  // external MCP connectors, so a stdio connector child gemini spawns can't
  // inherit them. gemini passes the OVERLAY-only `env` to the spawn (below), so
  // mergeChildEnv strips the ambient secrets from the inherited process.env while
  // preserving the connector's own `${AOA_MCP_*_TOKEN}` (overlay-set). The `aoa`
  // bridge keeps working from .gemini/settings.json's `mcpServers.aoa.env`
  // (buildMcpBridgeSpec re-supplies DATABASE_URL + secrets config). No-connector
  // runs keep the full env, byte-identical.
  // F4 — http connectors inherit nothing; env isolation is stdio-only. A stdio
  // connector spawns a local child that inherits gemini's env, so it is the only
  // transport whose presence justifies scrubbing ambient secrets, stripping the
  // run bearer, and nulling authToken. An http-only run reaches a remote server
  // that inherits no env, so isolating it would wrongly strip the agent's own
  // AOA_API_KEY and 401 its REST calls (Codex F4). Connector CONFIG delivery via
  // .gemini/settings.json is unchanged for all transports — this gate is
  // env-isolation only.
  const hasStdioConnector =
    ctx.mcpServers != null &&
    Object.values(ctx.mcpServers).some((s) => (s as { kind?: string } | null)?.kind === "stdio");
  const connectorScrubKeys = hasStdioConnector ? aoaAmbientSecretEnvKeys() : undefined;
  // WS1 — keep the run bearer out of connector children (gemini has no runtime
  // hook token; only AOA_API_KEY to strip). No-op without stdio connectors.
  stripConnectorRunBearers(env, { connectorsPresent: hasStdioConnector, secretValues: [authToken] });
  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveGeminiBillingType(effectiveEnv);
  const runtimeEnv = ensurePathInEnv(effectiveEnv);
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
      "stdout",
      `[aoa] Gemini session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${sessionCwd}".\n`,
    );
  }

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[aoa] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const commandNotes: string[] = ["Prompt is passed to Gemini via --prompt for non-interactive execution."];
  commandNotes.push(`Execution target: ${executionTarget.type}`);
  commandNotes.push("Added --approval-mode yolo for unattended execution.");
  if (instructionsFilePath && instructionsPrefix.length > 0) {
    commandNotes.push(
      `Loaded agent instructions from ${instructionsFilePath}`,
      `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
    );
  }

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(
    context.aoaSessionHandoffMarkdown ?? context.paperclipSessionHandoffMarkdown,
    "",
  ).trim();
  const aoaEnvNote = renderAoaEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);
  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    sessionHandoffNote,
    aoaEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    instructionsChars: instructionsPrefix.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    runtimeNoteChars: aoaEnvNote.length + apiAccessNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildArgs = (resumeSessionId: string | null) => {
    const args = ["--output-format", "stream-json"];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model && model !== DEFAULT_GEMINI_LOCAL_MODEL) args.push("--model", model);
    args.push("--approval-mode", "yolo");
    if (sandbox) {
      args.push("--sandbox");
    } else {
      args.push("--sandbox=none");
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("--prompt", prompt);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "gemini_local",
        command,
        cwd,
        commandNotes,
        commandArgs: args.map((value, index) => (
          index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
        )),
        env: redactEnvForLogs(env),
        prompt,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(executionTarget, {
      runId,
      command,
      args,
      cwd,
      env,
      ...(connectorScrubKeys ? { unsetEnvKeys: connectorScrubKeys } : {}),
      authToken: hasStdioConnector ? null : (env.AOA_API_KEY ?? authToken ?? null),
      apiBaseUrl: env.AOA_API_URL ?? null,
      runtimeCommandSpec: ctx.runtimeCommandSpec ?? null,
      timeoutSec,
      graceSec,
      onLog,
      onSpawn,
      // U5 fix (Wave 2 review — this adapter was the confirmed regression):
      // gemini-local always runs against Google, so GEMINI_API_KEY/
      // GOOGLE_API_KEY are the only provider auth keys admissible in a
      // sandboxed run. Pre-fix this was omitted entirely, so
      // buildSandboxEnvAllowlist saw provider:"" and dropped the agent's own
      // key on every cloud sandbox run.
      sandboxProvider: "gemini",
    });
    return {
      proc,
      parsed: parseGeminiJsonl(proc.stdout),
    };
  };

  const toResult = (
    attempt: {
      proc: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      };
      parsed: ReturnType<typeof parseGeminiJsonl>;
    },
    clearSessionOnMissingSession = false,
    isRetry = false,
  ): AdapterExecutionResult => {
    const authMeta = detectGeminiAuthRequired({
      parsed: attempt.parsed.resultEvent,
      stdout: attempt.proc.stdout,
      stderr: attempt.proc.stderr,
    });

    if (attempt.proc.timedOut) {
      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: authMeta.requiresAuth ? "gemini_auth_required" : null,
        clearSession: clearSessionOnMissingSession,
        executionCwd: sessionCwd,
      };
    }

    const clearSessionForTurnLimit = isGeminiTurnLimitResult(attempt.parsed.resultEvent, attempt.proc.exitCode);

    const canFallbackToRuntimeSession = !isRetry;
    const resolvedSessionId = attempt.parsed.sessionId
      ?? (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
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
    const structuredFailure = attempt.parsed.resultEvent
      ? describeGeminiFailure(attempt.parsed.resultEvent)
      : null;
    const fallbackErrorMessage =
      parsedError ||
      structuredFailure ||
      stderrLine ||
      `Gemini exited with code ${attempt.proc.exitCode ?? -1}`;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage: (attempt.proc.exitCode ?? 0) === 0 ? null : fallbackErrorMessage,
      errorCode: clearSessionForTurnLimit
        ? "max_turns_exhausted"
        : (attempt.proc.exitCode ?? 0) !== 0 && authMeta.requiresAuth
          ? "gemini_auth_required"
          : null,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: "google",
      model,
      billingType,
      costUsd: attempt.parsed.costUsd,
      executionCwd: sessionCwd,
      resultJson: attempt.parsed.resultEvent ?? {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: clearSessionForTurnLimit || Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  const initial = await runAttempt(sessionId);
  if (
    sessionId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isGeminiUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[aoa] Gemini resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true, true);
  }

  return toResult(initial);
}
