import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@armyofagents/adapter-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  overrideAdapterExecutionTargetRemoteCwd,
  prepareAdapterExecutionTargetRuntime,
  readAdapterExecutionTarget,
  resolveAdapterExecutionTargetCommandForLogs,
  resolveAdapterExecutionTargetTimeoutSec,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  syncAdapterExecutionTargetDirectory,
  syncAdapterExecutionTargetFile,
} from "@armyofagents/adapter-utils/execution-target";
import {
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildAoaEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  joinPromptSections,
  materializeAoaSkillCopy,
  parseObject,
  readAoaIssueWorkModeFromContext,
  readAoaRuntimeSkillEntries,
  renderTemplate,
  renderAoaWakePrompt,
  resolveAoaDesiredSkillNames,
  stringifyAoaWakePayload,
  refreshAoaWorkspaceEnvForExecution,
  DEFAULT_AOA_AGENT_PROMPT_TEMPLATE,
} from "@armyofagents/adapter-utils/server-utils";
import { DEFAULT_GROK_LOCAL_MODEL } from "../index.js";
import { isGrokUnknownSessionError, parseGrokJsonl } from "./parse.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
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
    "Use shell commands with curl to make AoA API requests when needed.",
    "Include X-AoA-Run-Id on mutating requests.",
    "",
    "",
  ].join("\n");
}

type StageCleanup = {
  kind: "file" | "dir";
  path: string;
};

type StagedGrokAssets = {
  cleanup: () => Promise<void>;
  stagedSkillsCount: number;
  stagedInstructionsPath: string | null;
  rulesFilePath: string | null;
};

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function stageGrokProjectAssets(input: {
  cwd: string;
  instructionsFilePath: string;
  skillEntries: Array<{ key: string; runtimeName: string; source: string }>;
  desiredSkillNames: string[];
  onLog: AdapterExecutionContext["onLog"];
}): Promise<StagedGrokAssets> {
  const cleanup: StageCleanup[] = [];
  const ensureCleanupDir = (candidate: string) => {
    cleanup.push({ kind: "dir", path: candidate });
  };
  const ensureCleanupFile = (candidate: string) => {
    cleanup.push({ kind: "file", path: candidate });
  };

  let stagedInstructionsPath: string | null = null;
  let rulesFilePath: string | null = null;
  let stagedSkillsCount = 0;

  const instructionsTarget = path.join(input.cwd, "Agents.md");
  if (input.instructionsFilePath) {
    if (!await pathExists(instructionsTarget)) {
      await fs.copyFile(input.instructionsFilePath, instructionsTarget);
      ensureCleanupFile(instructionsTarget);
      stagedInstructionsPath = instructionsTarget;
    } else if (path.resolve(instructionsTarget) !== path.resolve(input.instructionsFilePath)) {
      rulesFilePath = input.instructionsFilePath;
      await input.onLog(
        "stdout",
        `[AoA] Grok workspace already contains ${instructionsTarget}; using --rules @${input.instructionsFilePath} instead of overwriting it.\n`,
      );
    }
  } else {
    const canonicalAgents = path.join(input.cwd, "AGENTS.md");
    if (!await pathExists(instructionsTarget) && await pathExists(canonicalAgents)) {
      await fs.copyFile(canonicalAgents, instructionsTarget);
      ensureCleanupFile(instructionsTarget);
      stagedInstructionsPath = instructionsTarget;
    }
  }

  const desiredSet = new Set(input.desiredSkillNames);
  const selectedSkills = input.skillEntries.filter((entry) => desiredSet.has(entry.key));
  if (selectedSkills.length > 0) {
    const claudeDir = path.join(input.cwd, ".claude");
    const skillsRoot = path.join(claudeDir, "skills");
    if (!await pathExists(claudeDir)) {
      await fs.mkdir(claudeDir, { recursive: true });
      ensureCleanupDir(claudeDir);
    }
    if (!await pathExists(skillsRoot)) {
      await fs.mkdir(skillsRoot, { recursive: true });
      ensureCleanupDir(skillsRoot);
    }

    for (const skill of selectedSkills) {
      const target = path.join(skillsRoot, skill.runtimeName);
      if (await pathExists(target)) {
        await input.onLog(
          "stdout",
          `[AoA] Grok skill target already exists at ${target}; leaving it unchanged.\n`,
        );
        continue;
      }
      await materializeAoaSkillCopy(skill.source, target);
      ensureCleanupDir(target);
      stagedSkillsCount += 1;
    }
  }

  return {
    stagedSkillsCount,
    stagedInstructionsPath,
    rulesFilePath,
    cleanup: async () => {
      for (const entry of [...cleanup].reverse()) {
        if (entry.kind === "file") {
          await fs.rm(entry.path, { force: true }).catch(() => undefined);
          continue;
        }
        await fs.rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

function resolveBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "XAI_API_KEY") ? "api" : "subscription";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const promptTemplate = asString(
    config.promptTemplate,
    DEFAULT_AOA_AGENT_PROMPT_TEMPLATE,
  );
  const command = asString(config.command, "grok");
  const model = asString(config.model, DEFAULT_GROK_LOCAL_MODEL).trim();
  const permissionMode = asString(config.permissionMode, "dontAsk").trim() || "dontAsk";
  const reasoningEffort = asString(config.reasoningEffort, "").trim();
  const maxTurns = asNumber(config.maxTurns, 0);
  const alwaysApprove = asBoolean(config.alwaysApprove, true);
  const disableWebSearch = asBoolean(config.disableWebSearch, true);

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const agentHome = asString(workspaceContext.agentHome, "");
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  let effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const grokSkillEntries = await readAoaRuntimeSkillEntries(config, __moduleDir);
  const desiredGrokSkillNames = resolveAoaDesiredSkillNames(config, grokSkillEntries);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const stagedAssets = await stageGrokProjectAssets({
    cwd,
    instructionsFilePath,
    skillEntries: grokSkillEntries,
    desiredSkillNames: desiredGrokSkillNames,
    onLog,
  });
  let restoreRemoteWorkspace: (() => Promise<void>) | null = null;
  let remoteRulesFilePath: string | null = null;

  try {
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
      ? context.issueIds.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    const wakePayloadJson = stringifyAoaWakePayload(context.paperclipWake);
    const issueWorkMode = readAoaIssueWorkModeFromContext(context);
    if (wakeTaskId) env.AOA_TASK_ID = wakeTaskId;
    if (issueWorkMode) env.AOA_ISSUE_WORK_MODE = issueWorkMode;
    if (wakeReason) env.AOA_WAKE_REASON = wakeReason;
    if (wakeCommentId) env.AOA_WAKE_COMMENT_ID = wakeCommentId;
    if (approvalId) env.AOA_APPROVAL_ID = approvalId;
    if (approvalStatus) env.AOA_APPROVAL_STATUS = approvalStatus;
    if (linkedIssueIds.length > 0) env.AOA_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
    if (wakePayloadJson) env.AOA_WAKE_PAYLOAD_JSON = wakePayloadJson;
    refreshAoaWorkspaceEnvForExecution({
      env,
      envConfig,
      workspaceCwd: effectiveWorkspaceCwd,
      workspaceSource,
      workspaceId,
      workspaceRepoUrl,
      workspaceRepoRef,
      workspaceHints,
      agentHome,
      executionTargetIsRemote,
      executionCwd: effectiveExecutionCwd,
    });
    if (!hasExplicitApiKey && authToken) {
      env.AOA_API_KEY = authToken;
    }

    const timeoutSec = resolveAdapterExecutionTargetTimeoutSec(
      executionTarget,
      asNumber(config.timeoutSec, 0),
    );
    const graceSec = asNumber(config.graceSec, 20);
    await ensureAdapterExecutionTargetRuntimeCommandInstalled({
      target: executionTarget,
      runtimeCommandSpec: ctx.runtimeCommandSpec ?? null,
      runShellCommand: (installCommand) =>
        runAdapterExecutionTargetShellCommand(runId, executionTarget, installCommand, {
          cwd,
          env,
          timeoutSec,
          graceSec,
          onLog,
        }),
    });

    if (executionTargetIsRemote) {
      await onLog(
        "stdout",
        `[AoA] Syncing Grok workspace to ${describeAdapterExecutionTarget(executionTarget)}.\n`,
      );
      const preparedExecutionTargetRuntime = await prepareAdapterExecutionTargetRuntime({
        runId,
        target: executionTarget,
        adapterKey: "grok",
        workspaceLocalDir: cwd,
        timeoutSec,
        installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
        detectCommand: ctx.runtimeCommandSpec?.detectCommand ?? command,
      });
      restoreRemoteWorkspace = () => preparedExecutionTargetRuntime.restoreWorkspace();
      effectiveExecutionCwd = preparedExecutionTargetRuntime.workspaceRemoteDir ?? effectiveExecutionCwd;
      if (stagedAssets.stagedInstructionsPath) {
        await syncAdapterExecutionTargetFile({
          runId,
          target: executionTarget,
          localPath: stagedAssets.stagedInstructionsPath,
          remotePath: `${effectiveExecutionCwd}/Agents.md`,
          cwd: effectiveExecutionCwd,
          env,
          timeoutSec,
          graceSec,
          onLog,
        });
      }
      if (stagedAssets.stagedSkillsCount > 0) {
        await syncAdapterExecutionTargetDirectory({
          runId,
          target: executionTarget,
          localDir: path.join(cwd, ".claude", "skills"),
          remoteDir: `${effectiveExecutionCwd}/.claude/skills`,
          cwd: effectiveExecutionCwd,
          env,
          timeoutSec,
          graceSec,
          followSymlinks: true,
          onLog,
        });
      }
      if (stagedAssets.rulesFilePath && preparedExecutionTargetRuntime.runtimeRootDir) {
        remoteRulesFilePath = `${preparedExecutionTargetRuntime.runtimeRootDir}/grok-rules/${path.basename(stagedAssets.rulesFilePath)}`;
        await syncAdapterExecutionTargetFile({
          runId,
          target: executionTarget,
          localPath: stagedAssets.rulesFilePath,
          remotePath: remoteRulesFilePath,
          cwd: effectiveExecutionCwd,
          env,
          timeoutSec,
          graceSec,
          onLog,
        });
      }
      refreshAoaWorkspaceEnvForExecution({
        env,
        envConfig,
        workspaceCwd: effectiveWorkspaceCwd,
        workspaceSource,
        workspaceId,
        workspaceRepoUrl,
        workspaceRepoRef,
        workspaceHints,
        agentHome,
        executionTargetIsRemote,
        executionCwd: effectiveExecutionCwd,
      });
    }

    const runtimeExecutionTarget = overrideAdapterExecutionTargetRemoteCwd(executionTarget, effectiveExecutionCwd);
    const effectiveEnv = Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const runtimeEnv = ensurePathInEnv(effectiveEnv);
    await ensureAdapterExecutionTargetCommandResolvable(command, executionTarget, cwd, runtimeEnv, {
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      timeoutSec,
    });
    const resolvedCommand = await resolveAdapterExecutionTargetCommandForLogs(command, executionTarget, cwd, runtimeEnv);
    const loggedEnv = buildInvocationEnvForLogs(env, {
      runtimeEnv,
      includeRuntimeKeys: ["HOME"],
      resolvedCommand,
    });
    const billingType = resolveBillingType(effectiveEnv);

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    const runtimeRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(effectiveExecutionCwd)) &&
      adapterExecutionTargetSessionMatches(runtimeRemoteExecution, runtimeExecutionTarget);
    const sessionId = canResumeSession ? runtimeSessionId : null;
    if (executionTargetIsRemote && runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[AoA] Grok session "${runtimeSessionId}" does not match the current remote execution identity and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh remote session.\n`,
      );
    } else if (runtimeSessionId && !canResumeSession) {
      await onLog(
        "stdout",
        `[AoA] Grok session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${effectiveExecutionCwd}".\n`,
      );
    }

    const commandNotes = (() => {
      const notes: string[] = ["Prompt is passed to Grok via --single in headless mode."];
      if (alwaysApprove) notes.push("Added --always-approve for unattended execution.");
      if (stagedAssets.stagedInstructionsPath) {
        notes.push(`Staged project instructions at ${stagedAssets.stagedInstructionsPath} for native Grok discovery.`);
      }
      if (stagedAssets.rulesFilePath) {
        notes.push(`Applied fallback instructions via --rules @${remoteRulesFilePath ?? stagedAssets.rulesFilePath}.`);
      }
      if (stagedAssets.stagedSkillsCount > 0) {
        notes.push(`Staged ${stagedAssets.stagedSkillsCount} AoA skill(s) into .claude/skills for native Grok discovery.`);
      }
      return notes;
    })();

    const templateData = {
      agentId: agent.id,
      companyId: agent.companyId,
      runId,
      company: { id: agent.companyId },
      agent,
      run: { id: runId, source: "on_demand" },
      context,
    };
    const wakePrompt = renderAoaWakePrompt(context.paperclipWake, { resumedSession: Boolean(sessionId) });
    const shouldUseResumeDeltaPrompt = Boolean(sessionId) && wakePrompt.length > 0;
    const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
    const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const aoaEnvNote = renderAoaEnvNote(env);
    const apiAccessNote = renderApiAccessNote(env);
    const prompt = joinPromptSections([
      wakePrompt,
      sessionHandoffNote,
      aoaEnvNote,
      apiAccessNote,
      renderedPrompt,
    ]);
    const promptMetrics = {
      promptChars: prompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      runtimeNoteChars: aoaEnvNote.length + apiAccessNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    };

    const buildArgs = (resumeSessionId: string | null) => {
      const args = ["--cwd", effectiveExecutionCwd, "--output-format", "streaming-json"];
      if (resumeSessionId) args.push("--resume", resumeSessionId);
      if (model && model !== DEFAULT_GROK_LOCAL_MODEL) args.push("--model", model);
      if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      if (permissionMode) args.push("--permission-mode", permissionMode);
      if (alwaysApprove) args.push("--always-approve");
      if (disableWebSearch) args.push("--disable-web-search");
      if (stagedAssets.rulesFilePath) args.push("--rules", `@${remoteRulesFilePath ?? stagedAssets.rulesFilePath}`);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("--single", prompt);
      return args;
    };

    const runAttempt = async (resumeSessionId: string | null) => {
      const args = buildArgs(resumeSessionId);
      if (onMeta) {
        await onMeta({
          adapterType: "grok_local",
          command: resolvedCommand,
          cwd: effectiveExecutionCwd,
          commandNotes,
          commandArgs: args.map((value, index) => (
            index === args.length - 1 ? `<prompt ${prompt.length} chars>` : value
          )),
          env: loggedEnv,
          prompt,
          promptMetrics,
          context,
        });
      }

      const proc = await runAdapterExecutionTargetProcess(runtimeExecutionTarget, {
        runId,
        command,
        args,
        cwd,
        env,
        timeoutSec,
        graceSec,
        onSpawn,
        onLog,
        // U5 fix (Wave 2 review): grok-local always runs against xAI
        // (resolveBillingType above gates solely on XAI_API_KEY), so
        // XAI_API_KEY is the only provider auth key admissible in a
        // sandboxed run.
        sandboxProvider: "xai",
      });
      return {
        proc,
        parsed: parseGrokJsonl(proc.stdout),
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
        parsed: ReturnType<typeof parseGrokJsonl>;
      },
      clearSessionOnMissingSession = false,
      isRetry = false,
    ): AdapterExecutionResult => {
      if (attempt.proc.timedOut) {
        return {
          exitCode: attempt.proc.exitCode,
          signal: attempt.proc.signal,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          clearSession: clearSessionOnMissingSession,
        };
      }

      const failed = (attempt.proc.exitCode ?? 0) !== 0;
      const parsedError = typeof attempt.parsed.errorMessage === "string" ? attempt.parsed.errorMessage.trim() : "";
      const stderrLine = firstNonEmptyLine(attempt.proc.stderr);
      const fallbackErrorMessage =
        parsedError ||
        stderrLine ||
        `Grok exited with code ${attempt.proc.exitCode ?? -1}`;

      const canFallbackToRuntimeSession = !isRetry;
      const resolvedSessionId = attempt.parsed.sessionId
        ?? (canFallbackToRuntimeSession ? (runtimeSessionId ?? runtime.sessionId ?? null) : null);
      const resolvedSessionParams = resolvedSessionId
        ? ({
          sessionId: resolvedSessionId,
          cwd: effectiveExecutionCwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(executionTargetIsRemote
            ? {
                remoteExecution: adapterExecutionTargetSessionIdentity(runtimeExecutionTarget),
              }
            : {}),
        } as Record<string, unknown>)
        : null;

      return {
        exitCode: attempt.proc.exitCode,
        signal: attempt.proc.signal,
        timedOut: false,
        errorMessage: failed ? fallbackErrorMessage : null,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
        },
        sessionId: resolvedSessionId,
        sessionParams: resolvedSessionParams,
        sessionDisplayId: resolvedSessionId,
        provider: "xai",
        model,
        billingType,
        costUsd: null,
        resultJson: {
          stopReason: attempt.parsed.stopReason,
          requestId: attempt.parsed.requestId,
          ...(failed ? { stderr: attempt.proc.stderr } : {}),
        },
        summary: attempt.parsed.summary,
        clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
      };
    };

    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isGrokUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stdout",
        `[AoA] Grok resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true, true);
    }

    return toResult(initial);
  } finally {
    await Promise.all([
      restoreRemoteWorkspace?.(),
      stagedAssets.cleanup(),
    ]);
  }
}
