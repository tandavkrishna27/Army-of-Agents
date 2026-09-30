import type { Db } from "@armyofagents/db";
import { internalAgentConfig, agents } from "@armyofagents/db";
import { eq } from "drizzle-orm";
import type { AdapterEnvironmentTestResult } from "@armyofagents/shared";
import { detectAuthFailure } from "@armyofagents/adapter-utils";
import { secretService } from "./secrets.js";
import { resolveScopedCliAuthHome } from "./cli-auth-topology.js";

/**
 * Matches the `<adapter>_hello_probe_auth_expired` / `<adapter>_hello_probe_auth_required`
 * check codes emitted by the shared `runAuthStatusAndBranch` helper (claude-local,
 * codex-local, and future adapters that adopt it). A suffix regex is used instead
 * of a per-adapter hardcoded list so new adapters don't require an edit here.
 */
const HELLO_PROBE_AUTH_CODE_RE = /_hello_probe_auth_(?:expired|required)$/;

export type CommanderVerifyOutcome = "verified" | "needs_auth" | "not_installed" | "failed";

export function commanderProbeUsesApiKey(
  config: Record<string, unknown>,
  adapterType: string,
): boolean {
  const env =
    config.env != null && typeof config.env === "object" && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const value =
    adapterType === "codex_local"
      ? env.OPENAI_API_KEY
      : adapterType === "claude_local"
        ? env.ANTHROPIC_API_KEY
        : null;
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Resolve the config Commander verify should probe with (Plan 3 / §6.1, Codex
 * P1 #8). Loads the Commander AGENT via internal_agent_config.agent_id (the
 * executable config lives on agents.adapterConfig, NOT internal_agent_config)
 * and resolves its env `secret_ref` bindings for runtime — so a saved API key
 * (§6.2) actually unblocks the re-probe. Falls back to `{}` (CLI defaults /
 * subscription-login path) when no Commander agent is linked.
 */
export async function resolveCommanderProbeConfig(
  db: Db,
  companyId: string,
  // Supplied by the caller, which already resolved it via
  // `resolveCommanderAdapterType`. This helper has no cliTool of its own, and
  // re-resolving here would risk probing one adapter while resolving another
  // adapter's credential.
  adapterType: string,
  actorId: string | null,
): Promise<Record<string, unknown>> {
  const [cfg] = await db
    .select({ agentId: internalAgentConfig.agentId })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  let resolved: Record<string, unknown> = {};
  if (cfg?.agentId) {
    const [agent] = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.id, cfg.agentId))
      .limit(1);
    const adapterConfig = (agent?.adapterConfig as Record<string, unknown> | null) ?? {};
    resolved = await secretService(db).resolveAdapterConfigForRuntime(
      companyId,
      adapterType,
      adapterConfig,
      {
        consumerType: "agent",
        consumerId: cfg.agentId,
        actorType: "user",
        actorId: actorId ?? "board",
      },
    );
  }

  const provider =
    adapterType === "codex_local" ? "openai" : adapterType === "claude_local" ? "anthropic" : null;
  if (!provider) return resolved;
  const authHome = resolveScopedCliAuthHome({
    executionTargetId: process.env.AOA_EXECUTION_TARGET_ID ?? "control-plane",
    companyId,
    userId: actorId ?? "board",
    provider,
  });
  const env = {
    ...((resolved.env as Record<string, unknown> | undefined) ?? {}),
    ...(provider === "openai"
      ? { CODEX_HOME: authHome }
      : { CLAUDE_CONFIG_DIR: authHome }),
  };
  return { ...resolved, env };
}

/** Commander cliTool → agent adapter type (mirror UI AgentStep). */
export function cliToolToAdapterType(cliTool: string | null | undefined): string {
  switch (cliTool) {
    case "claude_cli":
      return "claude_local";
    case "codex":
      return "codex_local";
    case "opencode":
      return "opencode_local";
    default:
      return "claude_local"; // safe default; Commander defaults to claude_cli
  }
}

/**
 * Classify the shared adapter probe into a recovery outcome (revA R14, Auth T6).
 * The auth signal lives in check *codes*, not a structured field:
 *   *_hello_probe_passed → verified ·
 *   *_hello_probe_auth_expired / *_hello_probe_auth_required (suffix match) /
 *     *auth_required* / *login* (substring, back-compat) → needs_auth ·
 *   *_command_unresolvable / *not_installed* / *install* → not_installed.
 * Both `auth_expired` (credentials exist but were rejected — e.g. a revoked
 * token) and `auth_required` (no credentials) are recoverable in-app, so both
 * map to `needs_auth` — the founder is offered sign-in either way.
 *
 * Defence in depth: if no code matches (an adapter that hasn't adopted the
 * shared auth-code convention), scan check `message`/`detail` text with the
 * shared `detectAuthFailure` classifier. Without this, such an adapter would
 * dead-end the founder on a bare `failed` with no recovery offer — the exact
 * bug this workstream exists to fix.
 *
 * A non-error `warn` with no auth/install signal is treated as verified so the
 * founder is not hard-blocked on a cosmetic mismatch (scope §8).
 */
export function classifyCommanderProbe(result: AdapterEnvironmentTestResult): {
  outcome: CommanderVerifyOutcome;
  result: AdapterEnvironmentTestResult;
} {
  if (result.status === "pass") return { outcome: "verified", result };
  const codes = result.checks.map((c) => c.code);
  const anyCode = (needle: string) => codes.some((c) => c.includes(needle));
  if (codes.some((c) => HELLO_PROBE_AUTH_CODE_RE.test(c)) || anyCode("auth_required") || anyCode("login")) {
    return { outcome: "needs_auth", result };
  }
  if (anyCode("command_unresolvable") || anyCode("not_installed") || anyCode("install")) {
    return { outcome: "not_installed", result };
  }
  const hasTextAuthSignal = result.checks.some(
    (c) => detectAuthFailure(c.message).kind !== "none" || detectAuthFailure(c.detail).kind !== "none",
  );
  if (hasTextAuthSignal) return { outcome: "needs_auth", result };
  if (result.status === "warn") return { outcome: "verified", result };
  return { outcome: "failed", result };
}

/** Resolve the Commander's adapter type from its configured cliTool. */
export async function resolveCommanderAdapterType(db: Db, companyId: string): Promise<string> {
  const [cfg] = await db
    .select({ cliTool: internalAgentConfig.cliTool })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  return cliToolToAdapterType(cfg?.cliTool ?? "claude_cli");
}
