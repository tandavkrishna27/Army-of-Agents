import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import {
  asString,
  parseObject,
  ensurePathInEnv,
} from "../utils.js";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
} from "@armyofagents/adapter-utils/execution-target";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "");
  const target = ctx.executionTarget ?? null;
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = target ? ctx.environmentName ?? describeAdapterExecutionTarget(target) : null;

  if (targetLabel) {
    checks.push({
      code: "process_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  if (!command) {
    checks.push({
      code: "process_command_missing",
      level: "error",
      message: "Process adapter requires a command.",
      hint: "Set adapterConfig.command to an executable command.",
    });
  } else {
    checks.push({
      code: "process_command_present",
      level: "info",
      message: `Configured command: ${command}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(
      `process-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      target,
      cwd,
      {
        cwd,
        env: {},
        createIfMissing: true,
      },
    );
    checks.push({
      code: "process_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "process_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  if (command) {
    const envConfig = parseObject(config.env);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(envConfig)) {
      if (typeof value === "string") env[key] = value;
    }
    const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
    try {
      await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
      checks.push({
        code: "process_command_resolvable",
        level: "info",
        message: `Command is executable: ${command}`,
      });
    } catch (err) {
      checks.push({
        code: "process_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command is not executable",
        detail: command,
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
