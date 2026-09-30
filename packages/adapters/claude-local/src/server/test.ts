import {
  runAuthStatusAndBranch,
  type AdapterEnvironmentCheck,
  type AdapterEnvironmentTestContext,
  type AdapterEnvironmentTestResult,
} from "@armyofagents/adapter-utils";
import {
  asString,
  asBoolean,
  asNumber,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@armyofagents/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsRemote,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@armyofagents/adapter-utils/execution-target";
import path from "node:path";
import { detectClaudeLoginRequired, parseClaudeStreamJson } from "./parse.js";
import { parseClaudeAuthStatus, CLAUDE_AUTH_STATUS_ARGS } from "./auth-status.js";
import { isBedrockAuth } from "./execute.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Ambient env keys stripped from the diagnostic probe so it authenticates from
 * the SAME source a real run does.
 *
 * A crew run strips the whole `CLAUDE_`/`ANTHROPIC_` ambient class and then
 * copies the operator's `~/.claude/.credentials.json` into an isolated config
 * home (ambient-config.ts, D9/T3). This probe cannot copy-and-isolate, so it
 * strips only the ambient AUTH key and deliberately KEEPS `CLAUDE_CONFIG_DIR`:
 * that variable is the credential SOURCE a crew run resolves from
 * (`resolveClaudeConfigHome(process.env)`), so leaving it inherited makes the
 * probe read the very file T3 would copy. Stripping the ambient
 * `ANTHROPIC_API_KEY` stops the probe from going green via a key a crew run
 * strips and never sees (mirrors codex's `unsetEnvKeys: ["OPENAI_API_KEY"]`,
 * codex-local/src/server/test.ts). An adapter-config (overlay) `ANTHROPIC_API_KEY`
 * survives — `mergeChildEnv` keeps overlay-set keys, and a crew run honours that
 * same overlay auth (`hasOverlayConfiguredClaudeAuth`). Local targets only; a
 * remote child never inherits the host env, so the strip is a harmless no-op there.
 */
const PROBE_UNSET_ENV_KEYS: readonly string[] = ["ANTHROPIC_API_KEY"];

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function describeStaleApiKey(
  env: Record<string, string>,
): { code: string; level: "warn"; message: string; hint: string } | null {
  if (isBedrockAuth(env) && isNonEmpty(env.ANTHROPIC_API_KEY)) {
    return {
      code: "claude_bedrock_api_key_ignored",
      level: "warn",
      message: "ANTHROPIC_API_KEY is set but will be ignored because AWS Bedrock auth is active.",
      hint: "Unset ANTHROPIC_API_KEY to avoid confusion.",
    };
  }
  return null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claude");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = adapterExecutionTargetIsRemote(target);
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `claude-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "claude_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "claude_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = ensurePathInEnv({ ...(targetIsRemote ? {} : process.env), ...env });
  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv, {
      installCommand: SANDBOX_INSTALL_COMMAND,
    });
    checks.push({
      code: "claude_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const effectiveEnv = { ...env } as Record<string, string>;
  if (isBedrockAuth(effectiveEnv)) {
    checks.push({
      code: "claude_bedrock_auth_detected",
      level: "info",
      message: "AWS Bedrock auth detected. Claude will use Bedrock for inference.",
    });
    const staleKeyCheck = describeStaleApiKey(effectiveEnv);
    if (staleKeyCheck) checks.push(staleKeyCheck);
  }

  // The adapter-config (overlay) key is a real, run-visible auth source: it
  // survives the ambient strip (PROBE_UNSET_ENV_KEYS) by mergeChildEnv's
  // overlay-wins rule, and a crew run honours it too (hasOverlayConfiguredClaudeAuth).
  // The ambient server-process key is NOT: a crew run strips ANTHROPIC_ before
  // spawning and authenticates from the copied .credentials.json instead, and
  // this probe now strips it too. So the two must be reported differently — an
  // ambient-only key described as "Claude will use API-key auth" would be a green
  // light for a path no real run takes. (The codex probe draws the same
  // config-vs-server-env distinction, codex-local/src/server/test.ts.)
  const configApiKey = env.ANTHROPIC_API_KEY;
  const hostApiKey = targetIsRemote ? undefined : process.env.ANTHROPIC_API_KEY;
  if (!isBedrockAuth(effectiveEnv) && isNonEmpty(configApiKey)) {
    checks.push({
      code: "claude_anthropic_api_key_overrides_subscription",
      level: "warn",
      message:
        "ANTHROPIC_API_KEY is set in the adapter config. Claude will use API-key auth instead of subscription credentials.",
      detail: "Detected in adapter config env.",
      hint: "Unset ANTHROPIC_API_KEY if you want subscription-based Claude login behavior.",
    });
  } else if (!isBedrockAuth(effectiveEnv) && isNonEmpty(hostApiKey)) {
    checks.push({
      code: "claude_anthropic_api_key_server_env_only",
      level: "warn",
      message:
        "ANTHROPIC_API_KEY is set only in the server environment; agent runs do not use it. Crew runs strip it, and this probe does too — both authenticate from your `claude auth login` credentials instead.",
      hint: "Set a per-agent ANTHROPIC_API_KEY in the adapter config, or run `claude auth login`, so runs authenticate from a source they actually use.",
    });
  } else if (!isBedrockAuth(effectiveEnv)) {
    checks.push({
      code: "claude_subscription_mode_possible",
      level: "info",
      message: "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if Claude is logged in.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "claude_cwd_invalid" && check.code !== "claude_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "claude")) {
      checks.push({
        code: "claude_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claude`.",
        detail: command,
        hint: "Use the `claude` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const effort = asString(config.effort, "").trim();
      const chrome = asBoolean(config.chrome, false);
      const maxTurns = asNumber(config.maxTurnsPerRun, 0);
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
      if (chrome) args.push("--chrome");
      if (model && !isBedrockAuth(effectiveEnv)) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runAdapterExecutionTargetProcess(
        target ?? { type: "local" },
        {
          runId,
          command,
          args,
          cwd,
          env,
          // Strip the ambient server ANTHROPIC_API_KEY so the probe uses the SAME
          // auth a real run does — see PROBE_UNSET_ENV_KEYS. An overlay key in
          // `env` survives; only the inherited process.env key is dropped.
          unsetEnvKeys: [...PROBE_UNSET_ENV_KEYS],
          runtimeCommandSpec: targetIsRemote
            ? { command, installCommand: SANDBOX_INSTALL_COMMAND }
            : null,
          timeoutSec: 45,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
          // U5 — the hello probe must authenticate the SAME way a real claude
          // run does, so the sandbox env allowlist needs to admit ANTHROPIC_API_KEY.
          sandboxProvider: "anthropic",
        },
      );

      const parsedStream = parseClaudeStreamJson(probe.stdout);
      const parsed = parsedStream.resultJson;
      const loginMeta = detectClaudeLoginRequired({
        parsed,
        stdout: probe.stdout,
        stderr: probe.stderr,
        exitCode: probe.exitCode,
      });
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr);

      if (probe.timedOut) {
        checks.push({
          code: "claude_hello_probe_timed_out",
          level: "warn",
          message: "Claude hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Claude can run `Respond with hello` from this directory manually.",
        });
      } else if (loginMeta.requiresLogin) {
        // The hello probe failed with an auth signal, but that alone can't
        // distinguish "never signed in" from "signed in, token revoked" —
        // both fail the same way from the probe's point of view. Ask
        // `claude auth status`, which reports whether credentials EXIST
        // locally (not whether they still work), to pick the right recovery
        // copy. Best-effort: an older CLI without `auth status`, a spawn
        // error, or a timeout must all degrade to the auth_required branch
        // rather than throw out of the probe or block on this extra step —
        // `runAuthStatusAndBranch` (adapter-utils) owns that degrade/branch
        // shape so codex-local's probe can reuse it with its own status
        // command and copy instead of pasting this block.
        checks.push(
          await runAuthStatusAndBranch({
            runStatus: async () => {
              const statusProbe = await runAdapterExecutionTargetProcess(
                target ?? { type: "local" },
                {
                  runId,
                  command,
                  args: [...CLAUDE_AUTH_STATUS_ARGS],
                  cwd,
                  env,
                  // Same strip as the hello probe: read the SAME credential store
                  // a real run authenticates against, never the ambient key crew
                  // discards (PROBE_UNSET_ENV_KEYS). Mirrors codex's status probe.
                  unsetEnvKeys: [...PROBE_UNSET_ENV_KEYS],
                  runtimeCommandSpec: null,
                  timeoutSec: 10,
                  graceSec: 2,
                  onLog: async () => {},
                  sandboxProvider: "anthropic",
                },
              );
              return parseClaudeAuthStatus(statusProbe.stdout);
            },
            codes: { expired: "claude_hello_probe_auth_expired", required: "claude_hello_probe_auth_required" },
            copy: {
              expiredWithAccount: (account) =>
                `Signed in as ${account}, but that session has expired or been revoked.`,
              expiredNoAccount: "Your Claude sign-in has expired or been revoked.",
              required: "Claude CLI is installed, but you're not signed in yet.",
            },
            hints: {
              expired: "Sign in again — paste an API key below, or run `claude login` in a terminal and we'll detect it.",
              required: loginMeta.loginUrl
                ? `Run \`claude login\` and complete sign-in at ${loginMeta.loginUrl}, then retry.`
                : "Run `claude login` in this environment, then retry the probe.",
            },
            detail,
          }),
        );
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsedStream.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "claude_hello_probe_passed" : "claude_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Claude hello probe succeeded."
            : "Claude probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`claude --print - --output-format stream-json --verbose`) and prompt `Respond with hello`.",
              }),
        });
      } else {
        checks.push({
          code: "claude_hello_probe_failed",
          level: "error",
          message: "Claude hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `claude --print - --output-format stream-json --verbose` manually in this directory and prompt `Respond with hello` to debug.",
        });
      }
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
