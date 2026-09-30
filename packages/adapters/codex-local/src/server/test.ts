import {
  runAuthStatusAndBranch,
  detectAuthFailure,
  type AdapterEnvironmentCheck,
  type AdapterEnvironmentTestContext,
  type AdapterEnvironmentTestResult,
} from "@armyofagents/adapter-utils";
import {
  asString,
  asBoolean,
  asStringArray,
  parseObject,
  ensurePathInEnv,
} from "@armyofagents/adapter-utils/server-utils";
import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@armyofagents/adapter-utils/execution-target";
import fs from "node:fs/promises";
import path from "node:path";
import { parseCodexJsonl } from "./parse.js";
import { parseCodexAuthStatus, CODEX_AUTH_STATUS_ARGS } from "./auth-status.js";
import {
  prepareManagedCodexHome,
  resolveSharedCodexHomeDir,
  CODEX_ENV_TEST_AGENT_ID,
} from "./codex-home.js";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

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

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "codex");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = adapterExecutionTargetIsRemote(target);
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `codex-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "codex_environment_target",
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
      code: "codex_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_cwd_invalid",
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
      code: "codex_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "codex_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  // Auth-presence assessment MUST mirror what a real run uses (Codex finding 3 /
  // env-strip): a per-agent OPENAI_API_KEY in adapter config env, else the shared
  // Codex auth.json. The ambient server process.env.OPENAI_API_KEY is STRIPPED
  // from agent runs, so it must NOT be reported as usable auth — otherwise the
  // probe passes while the saved agent immediately runs without auth.
  const configOpenAiKey = env.OPENAI_API_KEY;
  const hostOpenAiKey = targetIsRemote ? undefined : process.env.OPENAI_API_KEY;
  const authSourceEnv = {
    ...process.env,
    ...(isNonEmpty(env.CODEX_HOME) ? { CODEX_HOME: env.CODEX_HOME } : {}),
  };
  const sharedAuthPath = path.join(resolveSharedCodexHomeDir(authSourceEnv), "auth.json");
  const sharedAuthReady = await fs.stat(sharedAuthPath).then((stat) => stat.isFile()).catch(() => false);
  if (isNonEmpty(configOpenAiKey)) {
    checks.push({
      code: "codex_openai_api_key_present",
      level: "info",
      message: "OPENAI_API_KEY is set for Codex authentication.",
      detail: "Detected in adapter config env.",
    });
  } else if (sharedAuthReady) {
    checks.push({
      code: "codex_auth_json_present",
      level: "info",
      message: "Codex auth.json is available for local authentication.",
    });
  } else if (isNonEmpty(hostOpenAiKey)) {
    checks.push({
      code: "codex_openai_api_key_server_env_only",
      level: "warn",
      message: "OPENAI_API_KEY is set only in the server environment; agent runs do not use it.",
      hint: "Set a per-agent OPENAI_API_KEY in the adapter config, or run `codex login`, so agent runs can authenticate.",
    });
  } else {
    checks.push({
      code: "codex_openai_api_key_missing",
      level: "warn",
      message: "OPENAI_API_KEY is not set. Codex runs may fail until authentication is configured.",
      hint: "Set a per-agent OPENAI_API_KEY in the adapter config, or run `codex login`.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "codex_cwd_invalid" && check.code !== "codex_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "codex")) {
      checks.push({
        code: "codex_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `codex`.",
        detail: command,
        hint: "Use the `codex` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const model = asString(config.model, "").trim();
      const modelReasoningEffort = asString(
        config.modelReasoningEffort,
        asString(config.reasoningEffort, ""),
      ).trim();
      const search = asBoolean(config.search, false);
      const bypass = asBoolean(
        config.dangerouslyBypassApprovalsAndSandbox,
        asBoolean(config.dangerouslyBypassSandbox, false),
      );
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();

      // Environment probes commonly run from the packaged application directory
      // (`/app` in Docker), which is intentionally not a Git checkout. Codex
      // rejects `exec` outside a trusted repository unless this explicit flag is
      // present, so omitting it makes a healthy installation look broken.
      const args = ["exec", "--json", "--skip-git-repo-check"];
      if (search) args.unshift("--search");
      if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
      if (model) args.push("--model", model);
      if (modelReasoningEffort) {
        args.push("-c", `model_reasoning_effort=${JSON.stringify(modelReasoningEffort)}`);
      }
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("-");

      // Codex CLI 0.122+ reads auth from $CODEX_HOME/auth.json rather than env.
      // Materialize auth.json into a managed per-company home dir before the probe.
      // On Windows, the shell trap variant is not supported (Issue #114); we fall back
      // to a bare probe — API-key auth may return 401 on Codex 0.122+ in that case.
      //
      // AUTH ALIGNMENT (env-strip / Codex finding 3): use the SAME auth inputs a
      // real run uses (execute.ts) — the per-agent OPENAI_API_KEY in adapter config
      // env, else the shared Codex auth.json that prepareManagedCodexHome copies in.
      // Do NOT fall back to the ambient process.env.OPENAI_API_KEY: agent runs strip
      // that key, so materializing it here would let "Test environment" report a
      // passing connection while the saved agent immediately runs without auth.
      const configuredOpenAiApiKey =
        typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim().length > 0
          ? env.OPENAI_API_KEY.trim()
          : null;

      const managedCodexHome = targetIsRemote
        ? `${adapterExecutionTargetRemoteCwd(target, cwd).replace(/\/+$/, "")}/.aoa-codex-home`
        : await prepareManagedCodexHome(
            authSourceEnv,
            () => {},
            ctx.companyId,
            // AdapterEnvironmentTestContext carries no agent id (the probe can
            // run against unsaved config), and managed homes are per-AGENT now.
            // Use the reserved probe id so this never writes into — or reads a
            // stale config.toml from — a real agent's home. Auth is provisioned
            // through the identical path a run uses.
            CODEX_ENV_TEST_AGENT_ID,
            { apiKey: configuredOpenAiApiKey },
          );
      const probeEnv = { ...env, CODEX_HOME: managedCodexHome };
      const runtimeCommandSpec = targetIsRemote
        ? {
            command,
            installCommand: [
              `mkdir -p ${shellDoubleQuote(managedCodexHome)}`,
              SANDBOX_INSTALL_COMMAND,
              `if [ -n "$OPENAI_API_KEY" ]; then printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key; fi`,
            ].join("\n"),
          }
        : null;

      const probe = await runAdapterExecutionTargetProcess(
        target ?? { type: "local" },
        {
          runId,
          command,
          args,
          cwd,
          env: probeEnv,
          // Strip the ambient server OPENAI_API_KEY from the probe child too, so
          // the diagnostic uses the SAME auth a real run does (per-agent key in
          // probeEnv survives — mergeChildEnv keeps overlay-set keys; only the
          // inherited process.env key is removed). Without this the probe could
          // authenticate with the ambient key and pass while real runs strip it
          // and fail (Codex P2). Matches execute.ts' unsetEnvKeys.
          unsetEnvKeys: ["OPENAI_API_KEY"],
          runtimeCommandSpec,
          timeoutSec: 45,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
          // U5 — the hello probe must authenticate the SAME way a real codex
          // run does, so the sandbox env allowlist needs to admit OPENAI_API_KEY.
          sandboxProvider: "openai",
        },
      );
      const parsed = parseCodexJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      // probe.stdout is deliberately EXCLUDED from auth evidence: it is the
      // full JSONL transcript, including agent_message text the model wrote
      // itself. Feeding that to the shared detector violates its documented
      // input contract (auth-failure-detector.ts: "never transcript or
      // agent-authored content") — prose that merely *discusses* an auth
      // error (e.g. "I added a handler returning 401 Unauthorized") would
      // then misclassify an unrelated failure as an auth failure. The real
      // signal for a revoked/expired token is the structured `error` /
      // `turn.failed` JSONL event, which parseCodexJsonl already isolates
      // into `parsed.errorMessage` — that plus stderr is genuine process
      // failure output.
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "codex_hello_probe_timed_out",
          level: "warn",
          message: "Codex hello probe timed out.",
          hint: "Retry the probe. If this persists, verify Codex can run `Respond with hello` from this directory manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "codex_hello_probe_passed" : "codex_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Codex hello probe succeeded."
            : "Codex probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try the probe manually (`codex exec --json --skip-git-repo-check -` then prompt: Respond with hello) to inspect full output.",
              }),
        });
      } else if (detectAuthFailure(authEvidence).kind !== "none") {
        // The hello probe failed with an auth signal, but that alone can't
        // distinguish "never signed in" from "signed in, token revoked" —
        // both fail the same way from the probe's point of view. Ask `codex
        // login status`, which reports whether credentials EXIST locally
        // (not whether they still work), to pick the right recovery copy.
        // Best-effort: an older CLI without `login status`, a spawn error,
        // or a timeout must all degrade to the auth_required branch rather
        // than throw out of the probe or block on this extra step —
        // `runAuthStatusAndBranch` (adapter-utils) owns that degrade/branch
        // shape, shared with claude-local's probe.
        checks.push(
          await runAuthStatusAndBranch({
            runStatus: async () => {
              // Must read the SAME credential store the hello probe just
              // failed against — probeEnv (CODEX_HOME pointed at the
              // managed per-company home), not the bare `env`. A bare `env`
              // spawn resolves against the founder's personal ~/.codex,
              // which is a different store entirely once a per-agent
              // OPENAI_API_KEY is configured, and reports on the WRONG
              // credentials. Mirror the hello probe's unsetEnvKeys too, so
              // an ambient server-process OPENAI_API_KEY can't leak in here
              // either.
              //
              // runtimeCommandSpec is deliberately NOT mirrored for remote
              // targets: the hello probe's install command is
              // `npm install -g @openai/codex` (SANDBOX_INSTALL_COMMAND),
              // which routinely takes far longer than this status probe's
              // 10s timeout/2s grace. Re-running it here would make the
              // status probe time out on every remote check (degrading to
              // auth_required, the wrong branch) instead of actually
              // reading status. The managed CODEX_HOME directory and any
              // API-key login the hello probe just performed already
              // persist on the same target/lease, so the directory exists
              // by the time this runs — no bootstrap needed.
              const statusProbe = await runAdapterExecutionTargetProcess(
                target ?? { type: "local" },
                {
                  runId,
                  command,
                  args: [...CODEX_AUTH_STATUS_ARGS],
                  cwd,
                  env: probeEnv,
                  unsetEnvKeys: ["OPENAI_API_KEY"],
                  runtimeCommandSpec: null,
                  timeoutSec: 10,
                  graceSec: 2,
                  onLog: async () => {},
                  sandboxProvider: "openai",
                },
              );
              return parseCodexAuthStatus(statusProbe.stdout);
            },
            codes: { expired: "codex_hello_probe_auth_expired", required: "codex_hello_probe_auth_required" },
            copy: {
              expiredWithAccount: (account) =>
                `Codex is signed in using ${account}, but that session has expired or been rejected.`,
              expiredNoAccount: "Your Codex sign-in has expired or been rejected.",
              required: "Codex CLI is installed, but you're not signed in yet.",
            },
            hints: {
              expired: "Sign in again — paste an API key below, or run `codex login` in a terminal and we'll detect it.",
              required: "Configure OPENAI_API_KEY in adapter env/shell or run `codex login`, then retry the probe.",
            },
            detail,
          }),
        );
      } else {
        checks.push({
          code: "codex_hello_probe_failed",
          level: "error",
          message: "Codex hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `codex exec --json --skip-git-repo-check -` manually in this working directory and prompt `Respond with hello` to debug.",
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
