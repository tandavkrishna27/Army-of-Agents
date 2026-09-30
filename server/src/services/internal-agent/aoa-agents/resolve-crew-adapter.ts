import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { internalAgentConfig } from "@armyofagents/db";
import { readEnvBindingValue, cliToolToProvider } from "@armyofagents/shared";
import { DEFAULT_CODEX_CHAT_MODEL, isCodexCompatibleModel, isShellSafeModel, SAFE_MODEL_RE } from "../codex-model.js";

/**
 * Resolves the right CLI adapter for AoA crew agents based on the company's
 * configured provider. Earlier, every ensure-*.ts file hardcoded
 * `adapterType: "process"` with no `command`, which made the crew unrunnable
 * (the process adapter throws "Process adapter missing command" — see
 * server/src/adapters/process/execute.ts:16). Scribe worked only because its
 * row was later mutated to `codex_local` (the only crew row ever fixed).
 *
 * Surfaced during the threads-crew E2E UAT:
 *   .gstack/qa-reports/uat-threads-crew-v1-findings.md (P1-B).
 *
 * Decision #91 removed api-mode adapters, so the choice is which CLI to invoke.
 * Mapping mirrors what each CLI's adapter expects (model + bypass-approvals so
 * the crew can run headless without prompting).
 *
 * Returns `{adapterType, adapterConfig}`. Caller merges into the agents row.
 * Backfill callers should preserve any existing `instructions*` fields in
 * adapter_config — those are seeded separately by seedRoleInstructionBundle.
 */
export interface CrewAdapter {
  adapterType: "codex_local" | "claude_local" | "gemini_local" | "opencode_local";
  adapterConfig: Record<string, unknown>;
}

export function resolveCrewAdapterFor(
  provider: string | null | undefined,
  modelOverride?: string | null,
): CrewAdapter {
  const ov = modelOverride?.trim() || "";
  switch (provider) {
    case "anthropic":
      return {
        adapterType: "claude_local",
        adapterConfig: {
          model: SAFE_MODEL_RE.test(ov) ? ov : "claude-sonnet-4-5-20250929",
          // UAT iteration-2 root cause (P0): claude_local CLI in --print
          // (non-interactive) mode hits a permission gate on every MCP tool
          // call. With no TTY to answer the prompt, claude silently skips
          // the tool call and completes the run "successfully" — producing
          // a clean wakeup row but ZERO actual work (no post_entry, no
          // create_artifact, etc.). codex_local has the equivalent
          // `dangerouslyBypassApprovalsAndSandbox: true` (line ~63) and
          // works correctly; claude_local needs the matching flag for
          // crew runs. The bridge's D2 default-deny allowlist remains the
          // real security gate — this flag only bypasses the local CLI's
          // interactive prompt, not AoA's authz.
          dangerouslySkipPermissions: true,
        },
      };
    case "google":
      return {
        adapterType: "gemini_local",
        adapterConfig: {
          model: SAFE_MODEL_RE.test(ov) ? ov : "gemini-2.5-pro",
        },
      };
    // T2.0: opencode is its own first-class CLI (uses OpenAI under the hood
    // but with its own subprocess + MCP wiring via opencode.json, NOT codex's
    // config.toml — see Task 2.1 for the MCP writer). Pre-T2.0 a company
    // configured with provider='opencode' silently fell through to
    // codex_local — wrong CLI, wrong MCP delivery path, broken crew runs.
    case "opencode":
      return {
        adapterType: "opencode_local",
        adapterConfig: {
          // opencode uses a `provider/model` slash id. gpt-5.3-codex was a bare
          // codex id (API-key-only) that 400s on a ChatGPT login — replaced
          // with the correct slash format for subscription accounts.
          //
          // opencode ids are slash-format `provider/model`; require a slash so a
          // bare codex id can't reach opencode. isShellSafeModel validates each segment.
          model: ov.includes("/") && isShellSafeModel(ov) ? ov : "openai/gpt-5.2-codex",
        },
      };
    case "openai":
    default:
      return {
        adapterType: "codex_local",
        adapterConfig: {
          // gpt-5.3-codex was an API-key-only model that 400s on ChatGPT
          // subscription logins. Use DEFAULT_CODEX_CHAT_MODEL (gpt-5.5) which
          // is verified-safe for subscription accounts (Test C in codex-model.ts).
          //
          // codex models must pass isCodexCompatibleModel (rejects *-codex ids and
          // non-OpenAI-family models; gpt-4o IS accepted). At dispatch the value is
          // re-validated by resolveModel — see the note after this task.
          model: isCodexCompatibleModel(ov) ? ov : DEFAULT_CODEX_CHAT_MODEL,
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      };
  }
}

/**
 * Look up the company's internalAgentConfig.provider and resolve the crew
 * adapter for it. Falls back to the openai/codex default if the config row
 * is missing or has no provider set.
 */
export async function resolveCrewAdapterForCompany(db: Db, companyId: string): Promise<CrewAdapter> {
  const rows = await db
    .select({ provider: internalAgentConfig.provider, crewModel: internalAgentConfig.crewModel })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  return resolveCrewAdapterFor(rows[0]?.provider, rows[0]?.crewModel);
}

/**
 * Resolve the COMMANDER agent row's adapter from its cliTool + model — NOT the
 * crew provider. Reuses resolveCrewAdapterFor (so the per-adapter bypass flags and
 * model validation are identical to the crew), keyed on the Commander surface via
 * cliToolToProvider. So Commander's non-chat runs use the CLI the founder picked
 * for Commander, independent of the crew provider.
 */
export function resolveCommanderAdapterFor(
  cliTool: string | null | undefined,
  modelOverride?: string | null,
): CrewAdapter {
  return resolveCrewAdapterFor(cliToolToProvider(cliTool), modelOverride);
}

export async function resolveCommanderAdapterForCompany(db: Db, companyId: string): Promise<CrewAdapter> {
  const rows = await db
    .select({ cliTool: internalAgentConfig.cliTool, model: internalAgentConfig.model })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);
  return resolveCommanderAdapterFor(rows[0]?.cliTool, rows[0]?.model);
}

/**
 * Decide whether an existing agent row needs an adapter backfill.
 *
 * Returns true in three cases:
 *
 * 1) **Legacy unrunnable `process` rows** (the original P1-B trigger):
 *    `adapter_type='process'` with no `command`. The legacy ensure-*.ts
 *    seeds wrote this exact shape; the process adapter throws on dispatch.
 *    Genuine process-with-command agents (generic shell processes) are
 *    left alone.
 *
 * 2) **claude_local crew agents missing `dangerouslySkipPermissions`**
 *    (UAT iteration-2 fix): the pre-fix resolveCrewAdapterFor for
 *    provider='anthropic' didn't set this flag, so claude crew runs
 *    silently no-op on every MCP tool call (permission gate hangs in
 *    --print mode). Backfill upgrades existing rows on startup so we
 *    don't need to manually edit every agent's adapterConfig.
 *
 * 3) **codex_local crew agents pinned to a ChatGPT-incompatible model**
 *    (provider-switching fix): an API-key-only Codex model (e.g.
 *    `gpt-5.3-codex`) persisted on a row 400s on a ChatGPT/subscription
 *    login. Backfill rewrites it to the validated default (`gpt-5.5`) so
 *    existing rows self-heal on boot. An empty model on a ChatGPT/subscription
 *    run is treated identically (codex falls back to the incompatible
 *    gpt-5.3-codex without one).
 *
 * 4) **opencode_local crew agents pinned to the legacy bare codex model**
 *    (provider-switching fix): the previous opencode crew default seeded a
 *    BARE `gpt-5.3-codex` (an API-key-only id that 400s on a ChatGPT login).
 *    OpenCode ids are slash-format `provider/model`; the corrected default is
 *    `openai/gpt-5.2-codex`. Without a backfill case these legacy rows keep the
 *    broken bare model after upgrade and never self-heal. Flag bare (no-slash)
 *    ChatGPT-incompatible models; leave valid slash-format / founder models be.
 */
/**
 * Does the adapter config carry an agent-set OPENAI_API_KEY? The save path
 * normalizes env entries to binding objects, so accept a raw string (legacy),
 * a `{ type: "plain", value }` with a non-blank value, or a `{ type: "secret_ref",
 * secretId }`. A blank/absent value is NOT a key.
 */
function hasOwnOpenAiKey(env: unknown): boolean {
  if (typeof env !== "object" || env === null) return false;
  // Binding-aware (string / {type:"plain"} / {type:"secret_ref"}) via the shared
  // helper, the same one codex auth-mode detection uses (provider-status).
  return readEnvBindingValue((env as Record<string, unknown>).OPENAI_API_KEY) != null;
}

export function needsAdapterBackfill(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown> | null | undefined,
  opts?: { isApiKeyAuth?: boolean },
): boolean {
  // Case 1: legacy process rows without a command.
  if (adapterType === "process") {
    const cmd = adapterConfig?.command;
    if (typeof cmd === "string" && cmd.trim().length > 0) return false;
    return true;
  }
  // Case 2: claude_local crew rows missing the permission-skip flag.
  if (adapterType === "claude_local") {
    return adapterConfig?.dangerouslySkipPermissions !== true;
  }
  // Case 3: codex_local rows with an incompatible model (e.g. gpt-5.3-codex,
  // an API-key-only model that 400s on ChatGPT subscription accounts). The
  // consumer rewrite path (resolveCrewAdapterForCompany + mergeAdapterConfig)
  // now yields DEFAULT_CODEX_CHAT_MODEL (gpt-5.5) for codex rows.
  if (adapterType === "codex_local") {
    // A founder may intentionally run codex_local in api-key mode, where models
    // like gpt-5.3-codex / codex-mini-latest are valid (see resolveModel's apikey
    // branch) — don't "self-heal" (rewrite) such rows. Api-key auth comes from
    // EITHER a per-agent OPENAI_API_KEY (hasOwnOpenAiKey; persisted env is
    // normalized to binding objects, handled) OR the shared ~/.codex/auth.json,
    // which only the caller can detect via getProviderStatus → opts.isApiKeyAuth
    // (Codex P2: shared-apikey codex models were wrongly rewritten to gpt-5.5).
    if (opts?.isApiKeyAuth || hasOwnOpenAiKey(adapterConfig?.env)) return false;
    const model = typeof adapterConfig?.model === "string" ? adapterConfig.model : "";
    // A persisted codex model that a ChatGPT login would reject needs rewriting.
    // An EMPTY model also needs healing on a ChatGPT/subscription run: with no
    // model, codex 0.130 falls back to gpt-5.3-codex and 400s → empty turn
    // (BUG-6). isCodexCompatibleModel("") is false, so dropping the length gate
    // heals both the empty and the non-empty-incompatible case; a compatible
    // model (gpt-5.5, gpt-4o) still returns false. api-key/own-key runs already
    // returned above, so gpt-5.3-codex stays valid there.
    return !isCodexCompatibleModel(model);
  }
  // Case 4: opencode_local rows pinned to the legacy BARE codex model. OpenCode
  // ids are slash-format `provider/model`; the previous crew default seeded a
  // bare `gpt-5.3-codex` (API-key-only, 400s on a ChatGPT login). Flag bare
  // (no-slash) ChatGPT-incompatible models so they self-heal to the corrected
  // slash default (`openai/gpt-5.2-codex`); leave valid slash-format ids and
  // ChatGPT-safe bare models (e.g. a founder's `gpt-5.5`) untouched.
  if (adapterType === "opencode_local") {
    const model = typeof adapterConfig?.model === "string" ? adapterConfig.model : "";
    return model.length > 0 && !model.includes("/") && !isCodexCompatibleModel(model);
  }
  return false;
}

/**
 * Decide whether a crew agent row must be rewritten to the company's CURRENTLY
 * resolved crew adapter. Two triggers:
 *
 *  1. **Provider switch** — the company changed `internal_agent_config.provider`,
 *     so `resolveCrewAdapterForCompany` now yields a DIFFERENT CLI adapter than
 *     the row uses. A perfectly "healthy" old-provider row (e.g. `claude_local`
 *     with `dangerouslySkipPermissions`, or `codex_local` with `gpt-5.5`) passes
 *     needsAdapterBackfill, so without this check provider switching would never
 *     migrate existing Commander/crew/Scribe agents — they'd keep running the old
 *     CLI (Codex P1).
 *  2. **Same-adapter model drift** — the company kept its provider but changed the
 *     model (provider/crewModel or cliTool/model). The resolved target adapter type
 *     matches the row, but the resolved model differs, so the new model would never
 *     land on existing rows (review P0). Rewrite so dispatch reads the new model.
 *  3. **Broken/stale same-provider row** — delegates to needsAdapterBackfill.
 */
export function shouldRewriteCrewAdapter(
  currentAdapterType: string | null | undefined,
  currentAdapterConfig: Record<string, unknown> | null | undefined,
  targetAdapterType: string,
  targetAdapterConfig: Record<string, unknown>,
  opts?: { isApiKeyAuth?: boolean },
): boolean {
  if (currentAdapterType !== targetAdapterType) return true;
  // Same adapter, but the resolved model changed (a model-only switch) — rewrite so
  // the new model lands. mergeCrewAdapterConfig's same-adapter branch overrides model.
  const cur = typeof currentAdapterConfig?.model === "string" ? currentAdapterConfig.model : "";
  const tgt = typeof targetAdapterConfig?.model === "string" ? targetAdapterConfig.model : "";
  if (tgt && tgt !== cur) return true;
  return needsAdapterBackfill(currentAdapterType, currentAdapterConfig, opts);
}

/**
 * Merge a resolved crew adapter into an existing adapter_config. Preserve ALL of
 * the founder's existing per-agent config (env, cwd, command, extraArgs,
 * instructions*, …) and override only the fields the resolved adapter sets (model
 * + bypass/skip flags). Previously this kept only `instructions*` and dropped the
 * rest, clobbering valid per-agent settings on a backfill rewrite (Codex P2).
 */
export function mergeAdapterConfig(
  existing: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const base = existing ?? {};
  return { ...base, ...next };
}

// NEUTRAL adapterConfig keys — the only fields that survive a PROVIDER SWITCH.
// This is an ALLOWLIST, not a denylist: each adapter's execute.ts reads its own
// set of provider-specific keys (command, extraArgs, model, dangerouslyBypass*,
// dangerouslySkipPermissions, modelReasoningEffort, reasoningEffort, search,
// fastMode, sandbox, effort, chrome, maxTurnsPerRun, maxTurns, permissionMode,
// alwaysApprove, disableWebSearch, thinking, variant, …). A denylist always lags
// the adapters — a new provider-specific key would silently carry into the wrong
// CLI on a switch (the exact bug class of the earlier rounds). So on a switch we
// keep ONLY these provider-neutral fields and let the resolved adapter (`next`)
// re-provide everything else. `instructions*` are role-based (re-seeded after the
// rewrite by seedRoleInstructionBundle), and `env` is preserved then scrubbed of
// the source provider's auth keys. (Codex P1/P2.)
const NEUTRAL_CREW_CONFIG_KEYS = [
  "cwd",
  "env",
  "instructionsFilePath",
  "agentsMdPath",
  "instructions",
];

// The provider-specific AUTH env credential(s) each adapter reads. Used on a
// provider SWITCH to drop the SOURCE provider's key while KEEPING any key the
// TARGET provider still needs — e.g. opencode_local → codex_local both use
// OPENAI_API_KEY, so it must survive the switch (Codex P2). opencode is
// multi-provider, so it can use any of them. Adapters not listed (cursor, pi,
// hermes, process, http) don't read these keys → all are dropped on a switch
// into them. Matched case-insensitively (Windows env names are case-insensitive).
const CLAUDE_AUTH_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL"];
const ADAPTER_AUTH_ENV_KEYS: Record<string, string[]> = {
  codex_local: ["OPENAI_API_KEY"],
  opencode_local: ["OPENAI_API_KEY", ...CLAUDE_AUTH_ENV_KEYS, "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  claude_local: CLAUDE_AUTH_ENV_KEYS,
  gemini_local: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  grok_local: ["XAI_API_KEY", "GROK_API_KEY"],
};
// The union — any of these is a provider-specific auth credential.
const PROVIDER_AUTH_ENV_KEYS = Array.from(new Set(Object.values(ADAPTER_AUTH_ENV_KEYS).flat()));

// Drop the SOURCE provider's auth keys from env while preserving (a) any key the
// TARGET adapter still reads and (b) all neutral (non-provider-auth) vars.
function stripSourceProviderAuthEnv(
  env: Record<string, unknown>,
  targetAdapterType: string,
): Record<string, unknown> {
  const keep = new Set((ADAPTER_AUTH_ENV_KEYS[targetAdapterType] ?? []).map((k) => k.toLowerCase()));
  const out = { ...env };
  for (const envKey of Object.keys(out)) {
    const lower = envKey.toLowerCase();
    const isProviderAuth = PROVIDER_AUTH_ENV_KEYS.some((k) => k.toLowerCase() === lower);
    if (isProviderAuth && !keep.has(lower)) delete out[envKey];
  }
  return out;
}

/**
 * Build the adapter_config to persist when migrating a crew row to `next`.
 *
 * - Same adapter (`currentAdapterType === targetAdapterType`): preserve ALL of
 *   the founder's existing fields (mergeAdapterConfig) — the CLI is unchanged.
 * - Provider switch: keep ONLY the provider-neutral fields (NEUTRAL_CREW_CONFIG_KEYS
 *   — allowlist, so no provider-specific key can leak into the wrong CLI), scrub
 *   the SOURCE provider's auth env keys (keeping any the TARGET still needs), then
 *   apply the resolved adapter's fields (`next`) on top. (Codex P1/P2.)
 */
export function mergeCrewAdapterConfig(
  existing: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
  currentAdapterType: string | null | undefined,
  targetAdapterType: string,
): Record<string, unknown> {
  if (currentAdapterType === targetAdapterType) return mergeAdapterConfig(existing, next);
  const existingCfg = existing ?? {};
  const neutral: Record<string, unknown> = {};
  for (const key of NEUTRAL_CREW_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(existingCfg, key)) neutral[key] = existingCfg[key];
  }
  if (neutral.env && typeof neutral.env === "object" && !Array.isArray(neutral.env)) {
    neutral.env = stripSourceProviderAuthEnv(neutral.env as Record<string, unknown>, targetAdapterType);
  }
  return { ...neutral, ...next };
}
