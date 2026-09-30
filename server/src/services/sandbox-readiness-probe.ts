/**
 * U13.7 — restore BYO-key adapter readiness verify on AoA Cloud.
 *
 * The three real probe sinks (agents.ts test-environment route, providers.ts
 * `/:providerId/test`, commander-verify.ts) all call `adapter.testEnvironment`,
 * which spawns a REAL `claude --print` / `codex exec` generation directly on
 * the control-plane host — the exact unsandboxed-tenant-code-on-shared-host
 * hazard the D1 guard (`assertUnsandboxedMultitenantAllowed`) exists to
 * refuse. That refusal was unconditional: every probe on `cloud_auth` came
 * back `readiness_unavailable_on_cloud`, even for a company that configured
 * its own provider API key in Settings -> Providers.
 *
 * This module is the sandboxed replacement for the ONE part of that probe a
 * company-key company can actually run safely on cloud: the adapter's
 * "hello-probe" — a one-shot `claude`/`codex` invocation with no tool surface,
 * prompted "Respond with hello." — routed through the SAME ephemeral-sandbox
 * seam every other one-shot CLI family in this wave uses (extraction —
 * U13.2/U13.3; Commander compaction — U13.6): `runOneShotCliInSandbox`
 * (U13.1), authenticated with the COMPANY's own resolved provider credential
 * (U13.0, `resolveCompanyProviderCredential`) — never the shared host's
 * operator login, and never any host-ambient key.
 *
 * Scope: only `claude`/`codex` (adapterType `claude_local`/`codex_local`) have
 * a `resolveCompanyProviderCredential` mapping (codex -> openai,
 * everything else -> anthropic) and a company-level provider key concept
 * (Settings -> Providers `anthropic`/`openai` entries). Every OTHER adapter
 * type (gemini_local, cursor, cursor_cloud, opencode_local, grok_local,
 * pi_local, openclaw, hermes_local, process, http, acpx_local, …) has no
 * sandboxed company-key equivalent yet — callers must keep those on the old
 * unconditional `readiness_unavailable_on_cloud` short-circuit and only route
 * `claude_local`/`codex_local` through this module.
 *
 * Mapping is deliberately simple (exit 0 -> pass; nonzero exit / timeout ->
 * fail) — this restores basic BYO-key reachability verification, NOT the
 * full local-probe diagnostic suite (cwd checks, command-resolvable checks,
 * bedrock/API-key-vs-subscription hints, "did the model actually say hello"
 * content matching). Those checks assume a local/remote execution TARGET
 * (`AdapterExecutionTarget`) this seam does not have — there is no cwd, no
 * `ensureAdapterExecutionTargetCommandResolvable`, and no stream-json summary
 * parser at this layer. A sandbox spawn that exits 0 already proves the
 * strongest signal those checks exist to approximate: the company's own key
 * authenticated and the CLI ran a real turn inside an isolated sandbox.
 */
import type { Db } from "@armyofagents/db";
import type { AdapterEnvironmentCheck, AdapterEnvironmentTestResult } from "@armyofagents/shared";
import { resolveCompanyProviderCredential } from "./one-shot-provider-credential.js";
import { OneShotSandboxError, runOneShotCliInSandbox } from "./one-shot-sandbox-cli.js";

/** Mirrors SANDBOX_SUMMARIZE_TIMEOUT_MS (cli-summarizer.ts, U13.6) — a
 *  sandboxed VM call has no CLI-side default and always needs an explicit
 *  bound, unlike the local hello-probe's 45s timeoutSec + 5s grace. */
const READINESS_PROBE_SANDBOX_TIMEOUT_MS = 60_000;

/** Truncate CLI stderr before it rides in a check `detail` — mirrors the
 *  adapter's own `summarizeProbeDetail` cap (claude-local/src/server/test.ts). */
const MAX_DETAIL_CHARS = 240;

function truncateDetail(text: string): string | undefined {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length > MAX_DETAIL_CHARS ? `${clean.slice(0, MAX_DETAIL_CHARS - 1)}…` : clean;
}

export interface ProbeReadinessInSandboxInput {
  db: Db;
  companyId: string;
  /** "claude" | "codex" — the ONLY two cliTools with a company-key mapping
   *  (`resolveCompanyProviderCredential`). Callers must not invoke this for
   *  any other adapter type. */
  cliTool: "claude" | "codex";
  /** Echoed into the returned result's `adapterType` field (e.g.
   *  "claude_local" / "codex_local") — this module never derives it itself,
   *  so callers stay the single source of truth for the adapter identity. */
  adapterType: string;
}

/**
 * Run the adapter's hello-probe command inside an ephemeral sandbox,
 * authenticated with the company's own resolved provider credential.
 *
 * Resolves the credential FIRST (S3, same double-resolve pattern as
 * `summarizeViaCliSandbox` / `extractViaCliSandbox` — needed here to build the
 * explicit `--model` argv value, since a sandboxed spawn has no persistent
 * CLI login to fall back on). A thrown `ProviderUnavailableError` (no company
 * key configured) propagates UNCHANGED — this module never catches or
 * re-labels it; the caller (each probe route) maps it via
 * `mapCloudProviderKeyError` (U12) to keep the existing
 * `readiness_unavailable_on_cloud` blocking result with copy pointing at
 * provider-key configuration.
 */
export async function probeReadinessInSandbox(
  input: ProbeReadinessInSandboxInput,
): Promise<AdapterEnvironmentTestResult> {
  const credential = await resolveCompanyProviderCredential(input.db, input.companyId, {
    cliTool: input.cliTool,
  });

  const command = input.cliTool === "codex" ? "codex" : "claude";
  const prefix = command;
  const args =
    command === "codex"
      ? ["exec", "--json", "--sandbox", "read-only", "--ask-for-approval", "never", "--model", credential.model, "-"]
      : ["--print", "--tools", "", "--strict-mcp-config", "--output-format", "text", "--model", credential.model];

  const testedAt = new Date().toISOString();

  try {
    await runOneShotCliInSandbox({
      db: input.db,
      companyId: input.companyId,
      cliTool: input.cliTool,
      command,
      args,
      stdinContent: "Respond with hello.",
      timeoutMs: READINESS_PROBE_SANDBOX_TIMEOUT_MS,
      // U13.4: labels the cost_events row so budget/cost reporting can tell
      // readiness spend apart from extraction/compaction spend.
      source: "readiness",
    });

    const check: AdapterEnvironmentCheck = {
      code: `${prefix}_hello_probe_passed`,
      level: "info",
      message: `${prefix === "codex" ? "Codex" : "Claude"} hello probe succeeded in the sandbox.`,
    };
    return { adapterType: input.adapterType, status: "pass", checks: [check], testedAt };
  } catch (err) {
    if (err instanceof OneShotSandboxError) {
      const detail = err.stderr ? truncateDetail(err.stderr) : undefined;
      const check: AdapterEnvironmentCheck =
        err.kind === "timeout"
          ? {
              code: `${prefix}_hello_probe_timed_out`,
              level: "warn",
              message: `${prefix === "codex" ? "Codex" : "Claude"} hello probe timed out inside the sandbox.`,
              ...(detail ? { detail } : {}),
            }
          : err.kind === "sandbox_unavailable"
            ? {
                code: `${prefix}_sandbox_unavailable`,
                level: "error",
                message: err.message,
              }
            : {
                code: `${prefix}_hello_probe_failed`,
                level: "error",
                message: `${prefix === "codex" ? "Codex" : "Claude"} hello probe failed inside the sandbox.`,
                ...(detail ? { detail } : {}),
              };
      return { adapterType: input.adapterType, status: "fail", checks: [check], testedAt };
    }
    // Not a sandbox-classified failure (e.g. a re-thrown ProviderUnavailableError
    // from runOneShotCliInSandbox's own internal S3 resolve, or a genuinely
    // unexpected error) — propagate unchanged, exactly like the credential
    // resolve above.
    throw err;
  }
}

/** The two adapter types with a `resolveCompanyProviderCredential` mapping.
 *  Callers use this to decide whether to attempt the sandbox path at all
 *  before falling back to the unconditional cloud short-circuit. */
export function cliToolForSandboxReadinessProbe(adapterType: string): "claude" | "codex" | null {
  if (adapterType === "codex_local") return "codex";
  if (adapterType === "claude_local") return "claude";
  return null;
}
