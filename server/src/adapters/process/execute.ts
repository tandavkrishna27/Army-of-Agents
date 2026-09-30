import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { runAdapterExecutionTargetProcess } from "@armyofagents/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildAoaEnv,
  redactEnvForLogs,
} from "../utils.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, onLog, onMeta, authToken, onSpawn } = ctx;
  const executionTarget = ctx.executionTarget ?? { type: "local" as const };
  const command = asString(config.command, "");
  if (!command) throw new Error("Process adapter missing command");

  const args = asStringArray(config.args);
  const workspaceContext = parseObject(ctx.context?.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const cwd = (useConfiguredInsteadOfAgentHome ? "" : workspaceCwd) || configuredCwd || process.cwd();
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildAoaEnv(agent) };
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
  const hasExplicitApiKey =
    typeof envConfig.AOA_API_KEY === "string" && envConfig.AOA_API_KEY.trim().length > 0;
  env.AOA_RUN_ID = runId;
  const contextObject = parseObject(ctx.context);
  const contextIssue = parseObject(contextObject.issue);
  const wakeTaskId =
    asString(contextObject.taskId, "") ||
    asString(contextObject.issueId, "") ||
    asString(contextIssue.id, "");
  if (wakeTaskId) env.AOA_TASK_ID = wakeTaskId;
  if (!hasExplicitApiKey && authToken) {
    env.AOA_API_KEY = authToken;
  }

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 15);

  if (onMeta) {
    await onMeta({
      adapterType: "process",
      command,
      cwd,
      commandArgs: args,
      commandNotes: [`Execution target: ${executionTarget.type}`],
      env: redactEnvForLogs(env),
    });
  }

  const proc = await runAdapterExecutionTargetProcess(executionTarget, {
    runId,
    command,
    args,
    cwd,
    env,
    authToken: env.AOA_API_KEY ?? authToken ?? null,
    apiBaseUrl: env.AOA_API_URL ?? null,
    runtimeCommandSpec: ctx.runtimeCommandSpec ?? null,
    timeoutSec,
    graceSec,
    onLog,
    onSpawn,
  });

  if (proc.timedOut) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: true,
      errorMessage: `Timed out after ${timeoutSec}s`,
      executionCwd: cwd,
    };
  }

  if ((proc.exitCode ?? 0) !== 0) {
    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: `Process exited with code ${proc.exitCode ?? -1}`,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
      executionCwd: cwd,
    };
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: false,
    resultJson: {
      stdout: proc.stdout,
      stderr: proc.stderr,
    },
    executionCwd: cwd,
  };
}
