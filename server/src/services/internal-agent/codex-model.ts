/**
 * Codex chat model + reasoning-effort resolution for the Commander cli-mode
 * path. See docs/aoa/plans/2026-06-16-commander-codex-model-pin-plan.md.
 *
 * Why: the per-session CODEX_HOME/config.toml has no `model` line, so codex
 * falls back to its compiled-in default (gpt-5.3-codex), which a
 * ChatGPT/subscription codex account rejects with HTTP 400 → empty turn.
 * We pin a subscription-supported model + effort=high (effort is required
 * for codex to emit reasoning summaries at all).
 */

/** Proven-on-this-account safe default (Test C). */
export const DEFAULT_CODEX_CHAT_MODEL = "gpt-5.5";

/**
 * effort=high is REQUIRED for codex reasoning summaries (medium emits none —
 * A/B proven). INTENTIONAL hardcode (not a config bypass): mirrors the
 * COMMANDER_MAX_THINKING_TOKENS constant; a Settings field is a future
 * enhancement. NOTE: reasoning is still best-effort per model — like the
 * Claude path, some models emit none; the founder accepted "model-dependent".
 */
export const COMMANDER_CODEX_REASONING_EFFORT = "high";

// Shell-safe charset (spawn uses shell:true on Windows — REVIEW FIX C10/S5):
// the resolved model is interpolated into argv, so reject anything that isn't
// a plain model identifier. Full-string anchor (NOT a prefix test).
// `:` is permitted as a shell-safe tag separator — OpenCode/Pi discover
// ollama-style tagged ids (e.g. `ollama/llama3.1:8b`) and `:` is not a shell
// metacharacter mid-argument (Codex P2).
// Mirrored (intentionally duplicated) in packages/shared/src/validators/agent.ts — keep in sync.
export const SAFE_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
// OpenAI/Codex NAMING families: gpt-*, o<N>*, chatgpt*, AND codex-* (the latter
// are API-key-only — see CODEX_INCOMPATIBLE_RE). This is the broad "is this an
// OpenAI/Codex identifier" gate used by isOpenAiFamilyModel; ChatGPT-subscription
// compatibility is further restricted by CODEX_INCOMPATIBLE_RE in
// isCodexCompatibleModel (which still excludes every codex-* / *-codex value).
const CODEX_FAMILY_RE = /^(gpt-|o\d|chatgpt|codex)/i;
// GPT-Codex variants (…-codex / codex-…) require an API key, NOT a ChatGPT
// login → they 400 on subscription accounts (this is the exact bug). Deny
// them so a stray config/shared value can never reintroduce the 400.
// REVIEW FIX C2: `gpt-5.3-codex` previously passed the naive /^gpt-/ prefix.
const CODEX_INCOMPATIBLE_RE = /codex/i;

export function isCodexCompatibleModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.trim();
  return (
    SAFE_MODEL_RE.test(m) &&
    CODEX_FAMILY_RE.test(m) &&
    !CODEX_INCOMPATIBLE_RE.test(m)
  );
}

/**
 * OpenAI/Codex-FAMILY model (gpt-*, o<N>-*, chatgpt-*), shell-safe. UNLIKE
 * {@link isCodexCompatibleModel} this INCLUDES the API-key-only GPT-Codex
 * variants (…-codex), because they are valid for API-key codex users. Used to
 * constrain the API-key-mode fallback so a shell-safe NON-OpenAI alias from a
 * shared ~/.codex/config.toml (e.g. `claude-…`, `gemini-…`) is never passed to
 * `codex --model` with an OpenAI key.
 */
export function isOpenAiFamilyModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.trim();
  return SAFE_MODEL_RE.test(m) && CODEX_FAMILY_RE.test(m);
}

/** True when `model` is non-empty and contains only shell-safe characters.
 * opencode uses a `provider/model` slash format; each segment is validated
 * individually (NO segment-count cap) against {@link SAFE_MODEL_RE}. */
export function isShellSafeModel(model: string | null | undefined): boolean {
  if (!model) return false;
  // opencode uses a provider/model slash id, possibly with a nested provider
  // namespace (e.g. openrouter/anthropic/claude-sonnet-4) — validate EACH segment
  // for shell-safety, NO segment-count cap. Keep in sync with agent.ts isShellSafeModelId.
  const segments = model.trim().split("/");
  return segments.every((s) => SAFE_MODEL_RE.test(s));
}

/**
 * Layered, VALIDATED resolution (enterprise-grade — explicit product config
 * over ambient host state). Every source is run through
 * {@link isCodexCompatibleModel} so a claude default, a GPT-Codex model, or a
 * shell-unsafe string can never reach codex (REVIEW FIX C1):
 *   1. `internal_agent_config.model` when codex-compatible (it defaults to a
 *      claude string for every company, so validation is mandatory).
 *   2. the user's shared `~/.codex/config.toml` model, ALSO validated (it may
 *      hold a claude/OpenRouter alias or a GPT-Codex model).
 *   3. the safe default `gpt-5.5`, so it can NEVER 400 on an empty/bad config.
 */
export function resolveCodexChatModel(
  configModel: string | null | undefined,
  sharedModel: string | null | undefined,
): string {
  if (isCodexCompatibleModel(configModel)) return configModel!.trim();
  if (isCodexCompatibleModel(sharedModel)) return sharedModel!.trim();
  return DEFAULT_CODEX_CHAT_MODEL;
}
