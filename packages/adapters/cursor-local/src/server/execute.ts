import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  adapterExecutionTargetUsesManagedHome,
  prepareWorkspaceForExecutionTarget,
  prepareAdapterExecutionTargetRuntime,
  runAdapterExecutionTargetProcess,
  syncAdapterExecutionTargetDirectory,
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
import { DEFAULT_CURSOR_LOCAL_MODEL } from "../index.js";
import { parseCursorJsonl, isCursorUnknownSessionError } from "./parse.js";
import { normalizeCursorStreamLine } from "../shared/stream.js";
import { hasCursorTrustBypassArg } from "../shared/trust.js";

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

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveCursorBillingType(env: Record<string, string>): "api" | "subscription" {
  return hasNonEmptyEnvValue(env, "CURSOR_API_KEY") || hasNonEmptyEnvValue(env, "OPENAI_API_KEY")
    ? "api"
    : "subscription";
}

function resolveProviderFromModel(model: string): string | null {
  const trimmed = model.trim().toLowerCase();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash > 0) return trimmed.slice(0, slash);
  if (trimmed.includes("sonnet") || trimmed.includes("claude")) return "anthropic";
  if (trimmed.startsWith("gpt") || trimmed.startsWith("o")) return "openai";
  return null;
}

function normalizeMode(rawMode: string): "plan" | "ask" | null {
  const mode = rawMode.trim().toLowerCase();
  if (mode === "plan" || mode === "ask") return mode;
  return null;
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

function cursorSkillsHome(): string {
  return path.join(os.homedir(), ".cursor", "skills");
}

async function resolvePaperclipSkillsDir(): Promise<string | null> {
  for (const candidate of AOA_SKILLS_CANDIDATES) {
    const isDir = await fs.stat(candidate).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) return candidate;
  }
  return null;
}

type EnsureCursorSkillsInjectedOptions = {
  skillsDir?: string | null;
  skillsHome?: string;
  linkSkill?: (source: string, target: string) => Promise<void>;
  dbSkills?: Array<{ key: string; name: string; markdown: string; files?: Array<{ path: string; content: string }> }>;
};

export async function ensureCursorSkillsInjected(
  onLog: AdapterExecutionContext["onLog"],
  options: EnsureCursorSkillsInjectedOptions = {},
): Promise<string[]> {
  const injectedDbDirs: string[] = [];
  const skillsDir = options.skillsDir ?? await resolvePaperclipSkillsDir();
  const dbSkills = options.dbSkills ?? [];

  // Nothing to inject
  if (!skillsDir && dbSkills.length === 0) return injectedDbDirs;

  const skillsHome = options.skillsHome ?? cursorSkillsHome();
  try {
    await fs.mkdir(skillsHome, { recursive: true });
  } catch (err) {
    await onLog(
      "stderr",
      `[aoa] Failed to prepare Cursor skills directory ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return injectedDbDirs;
  }

  // Symlink bundled skills when a local skills directory exists
  if (skillsDir) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch (err) {
      await onLog(
        "stderr",
        `[aoa] Failed to read AoA skills from ${skillsDir}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      entries = [];
    }

    const linkSkill = options.linkSkill ?? ((source: string, target: string) => fs.symlink(source, target, process.platform === "win32" ? "junction" : undefined));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const source = path.join(skillsDir, entry.name);
      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (existing) continue;

      try {
        await linkSkill(source, target);
        await onLog(
          "stderr",
          `[aoa] Injected Cursor skill "${entry.name}" into ${skillsHome}\n`,
        );
      } catch (err) {
        await onLog(
          "stderr",
          `[aoa] Failed to inject Cursor skill "${entry.name}" into ${skillsHome}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  // Write DB-backed company skills
  for (const skill of dbSkills) {
    const skillFolderName = skill.key.replace(/\//g, "--");
    const target = path.join(skillsHome, skillFolderName);
    try {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, "SKILL.md"), skill.markdown, "utf-8");
      for (const file of skill.files ?? []) {
        const fullPath = path.join(target, file.path);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, file.content, "utf-8");
      }
      injectedDbDirs.push(target);
    } catch (err) {
      await onLog?.(
        "stderr",
        `[aoa] Failed to write DB skill "${skill.key}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return injectedDbDirs;
}

async function cleanupDbSkillDirs(
  dirs: string[],
  onLog: AdapterExecutionContext["onLog"],
) {
  for (const dir of dirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      await onLog?.(
        "stderr",
        `[aoa] Failed to cleanup DB skill dir "${dir}": ${err instanceof Error ? err.message : String(err)}\n`,
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
  const command = asString(config.command, "agent");
  const model = asString(config.model, DEFAULT_CURSOR_LOCAL_MODEL).trim();
  const mode = normalizeMode(asString(config.mode, ""));

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
  const dbSkills = (context.skills as Array<{ key: string; name: string; markdown: string; files?: Array<{ path: string; content: string }> }> | undefined) ?? [];
  let injectedDbDirs: string[] = [];
  let remoteSkillsTempRoot: string | null = null;
  let remoteRuntimeRootDir: string | null = null;

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
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  if (!hasExplicitApiKey && authToken) {
    env.AOA_API_KEY = authToken;
  }

  if (executionTargetIsRemote) {
    const preparedRemoteRuntime = await prepareAdapterExecutionTargetRuntime({
      runId,
      target: executionTarget,
      adapterKey: "cursor",
      workspaceLocalDir: cwd,
      timeoutSec: asNumber(config.timeoutSec, 0),
      installCommand: ctx.runtimeCommandSpec?.installCommand ?? null,
      detectCommand: command,
    });
    remoteRuntimeRootDir = preparedRemoteRuntime.runtimeRootDir;
    if (adapterExecutionTargetUsesManagedHome(executionTarget) && remoteRuntimeRootDir) {
      env.HOME = remoteRuntimeRootDir;
    }

    if (remoteRuntimeRootDir) {
      remoteSkillsTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-cursor-remote-skills-"));
      const localSkillsHome = path.join(remoteSkillsTempRoot, "skills");
      await ensureCursorSkillsInjected(onLog, {
        dbSkills: dbSkills.length > 0 ? dbSkills : undefined,
        skillsHome: localSkillsHome,
        linkSkill: async (source, target) => {
          await fs.cp(source, target, { recursive: true, force: true });
        },
      });
      if (await fs.stat(localSkillsHome).then((stat) => stat.isDirectory()).catch(() => false)) {
        await syncAdapterExecutionTargetDirectory({
          runId,
          target: executionTarget,
          localDir: localSkillsHome,
          remoteDir: `${remoteRuntimeRootDir}/.cursor/skills`,
          cwd: prepareWorkspaceForExecutionTarget(executionTarget, cwd).executionCwd,
          env,
          timeoutSec: 30,
          graceSec: 5,
          followSymlinks: true,
          onLog,
        });
      }
    }
  } else {
    injectedDbDirs = await ensureCursorSkillsInjected(onLog, { dbSkills: dbSkills.length > 0 ? dbSkills : undefined });
  }

  const billingType = resolveCursorBillingType(env);
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
  const autoTrustEnabled = !hasCursorTrustBypassArg(extraArgs);

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
      `[aoa] Cursor session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${sessionCwd}".\n`,
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
      await onLog(
        "stderr",
        `[aoa] Loaded agent instructions file: ${instructionsFilePath}\n`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[aoa] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
    }
  }
  const commandNotes = (() => {
    const notes: string[] = [`Execution target: ${executionTarget.type}`];
    if (autoTrustEnabled) {
      notes.push("Auto-added --yolo to bypass interactive prompts.");
    }
    notes.push("Prompt is piped to Cursor via stdin.");
    if (!instructionsFilePath) return notes;
    if (instructionsPrefix.length > 0) {
      notes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      );
      return notes;
    }
    notes.push(
      `Configured instructionsFilePath ${instructionsFilePath}, but file could not be read; continuing without injected instructions.`,
    );
    return notes;
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
  const aoaEnvNote = renderAoaEnvNote(env);
  const prompt = `${instructionsPrefix}${aoaEnvNote}${renderedPrompt}`;

  const buildArgs = (resumeSessionId: string | null) => {
    const executionWorkspace = prepareWorkspaceForExecutionTarget(executionTarget, cwd).executionCwd;
    const args = ["-p", "--output-format", "stream-json", "--workspace", executionWorkspace];
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (model) args.push("--model", model);
    if (mode) args.push("--mode", mode);
    if (autoTrustEnabled) args.push("--yolo");
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "cursor",
        command,
        cwd,
        commandNotes,
        commandArgs: args,
        env: redactEnvForLogs(env),
        prompt,
        context,
      });
    }

    let stdoutLineBuffer = "";
    const emitNormalizedStdoutLine = async (rawLine: string) => {
      const normalized = normalizeCursorStreamLine(rawLine);
      if (!normalized.line) return;
      await onLog(normalized.stream ?? "stdout", `${normalized.line}\n`);
    };
    const flushStdoutChunk = async (chunk: string, finalize = false) => {
      const combined = `${stdoutLineBuffer}${chunk}`;
      const lines = combined.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";

      for (const line of lines) {
        await emitNormalizedStdoutLine(line);
      }

      if (finalize) {
        const trailing = stdoutLineBuffer.trim();
        stdoutLineBuffer = "";
        if (trailing) {
          await emitNormalizedStdoutLine(trailing);
        }
      }
    };

    const proc = await runAdapterExecutionTargetProcess(executionTarget, {
      runId,
      command,
      args,
      cwd,
      env,
      timeoutSec,
      graceSec,
      stdin: prompt,
      authToken: env.AOA_API_KEY ?? authToken ?? null,
      apiBaseUrl: env.AOA_API_URL ?? null,
      runtimeCommandSpec: ctx.runtimeCommandSpec ?? null,
      // U5 fix (Wave 2 review): the cursor-agent CLI authenticates with ITS
      // OWN account key (CURSOR_API_KEY) regardless of which underlying
      // model (gpt/opus/sonnet/gemini/grok/kimi — see index.ts's model
      // catalog) is selected — resolveCursorBillingType above and the
      // readiness probe (test.ts) both treat CURSOR_API_KEY as the canonical
      // auth signal, so "cursor" (not a per-model provider) is the correct
      // sandboxProvider.
      sandboxProvider: "cursor",
      onLog: async (stream, chunk) => {
        if (stream !== "stdout") {
          await onLog(stream, chunk);
          return;
        }
        await flushStdoutChunk(chunk);
      },
      onSpawn,
    });
    await flushStdoutChunk("", true);

    return {
      proc,
      parsed: parseCursorJsonl(proc.stdout),
    };
  };

  const providerFromModel = resolveProviderFromModel(model);

  const toResult = (
    attempt: {
      proc: {
        exitCode: number | null;
        signal: string | null;
        timedOut: boolean;
        stdout: string;
        stderr: string;
      };
      parsed: ReturnType<typeof parseCursorJsonl>;
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

    const resolvedSessionId = attempt.parsed.sessionId ?? runtimeSessionId ?? runtime.sessionId ?? null;
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
    const fallbackErrorMessage =
      parsedError ||
      stderrLine ||
      `Cursor exited with code ${attempt.proc.exitCode ?? -1}`;

    return {
      exitCode: attempt.proc.exitCode,
      signal: attempt.proc.signal,
      timedOut: false,
      errorMessage:
        (attempt.proc.exitCode ?? 0) === 0
          ? null
          : fallbackErrorMessage,
      usage: attempt.parsed.usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: providerFromModel,
      model,
      billingType,
      costUsd: attempt.parsed.costUsd,
      executionCwd: sessionCwd,
      resultJson: {
        stdout: attempt.proc.stdout,
        stderr: attempt.proc.stderr,
      },
      summary: attempt.parsed.summary,
      clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      isCursorUnknownSessionError(initial.proc.stdout, initial.proc.stderr)
    ) {
      await onLog(
        "stderr",
        `[aoa] Cursor resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toResult(retry, true);
    }

    return toResult(initial);
  } finally {
    if (injectedDbDirs.length > 0) {
      await cleanupDbSkillDirs(injectedDbDirs, onLog);
    }
    if (remoteSkillsTempRoot) {
      await fs.rm(remoteSkillsTempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
