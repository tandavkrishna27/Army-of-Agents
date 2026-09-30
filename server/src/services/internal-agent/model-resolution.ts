/**
 * Generalized model resolution for all adapter types (Unit B core).
 * Reuses the proven helpers from codex-model.ts for shell-safety validation
 * and Codex-specific compatibility checks.
 *
 * See docs/aoa/plans/ Phase 1 provider-switching engine.
 */
import {
  isShellSafeModel,
  isCodexCompatibleModel,
  isOpenAiFamilyModel,
  resolveCodexChatModel,
  DEFAULT_CODEX_CHAT_MODEL,
} from "./codex-model.js";

export class ShellUnsafeModelError extends Error {
  constructor(model: string) {
    super(`Unsafe model identifier: ${JSON.stringify(model)}`);
    this.name = "ShellUnsafeModelError";
  }
}

export interface ResolveModelStatus {
  authMode: "subscription" | "chatgpt" | "apikey" | "unknown";
  defaultModelResolved: string | null;
}

export interface ResolvedModel {
  model?: string;
  omitModelFlag: boolean;
  /** Operator-facing reason a model was corrected. Caller must wrap before surfacing to the UI (never forward raw). */
  note?: string;
}

/**
 * Resolve the model identifier to pass to an adapter's CLI invocation.
 *
 * Tier order:
 *   1. Shell-safety gate — throws `ShellUnsafeModelError` for any non-empty
 *      model that contains shell-special characters. This is always first,
 *      regardless of adapter.
 *   2. Adapter-specific logic:
 *      - `codex_local`: delegates to `resolveCodexChatModel` (validates
 *        compatibility, falls back to gpt-5.5).
 *      - `gemini_local`: "auto" (or empty) → omit the model flag entirely so
 *        Gemini CLI applies its own default.
 *      - All others (claude_local, opencode_local, …): empty → omit; else
 *        pass through verbatim (adapter applies its own default when omitted).
 */
export function resolveModel(
  adapterType: string,
  requested: string | null | undefined,
  status: ResolveModelStatus,
): ResolvedModel {
  const m = (requested ?? "").trim();

  // Shell-safety is the unconditional first gate.
  if (m && !isShellSafeModel(m)) throw new ShellUnsafeModelError(m);

  if (adapterType === "codex_local") {
    // In apikey mode, codex-family/API-key-only models (e.g. gpt-5.3-codex) are
    // valid — pass the (already shell-safe-checked) model through; no correction.
    if (status.authMode === "apikey") {
      // An EXPLICIT api-key model must still be an OpenAI/Codex-family identifier
      // (incl. gpt-*-codex). `m` was shell-safety-checked at the top, but a
      // shell-safe NON-OpenAI value — a slash/opencode-style id (openai/gpt-5.5),
      // a claude-…/gemini-… alias, or an unknown alias — must NOT be passed to
      // `codex --model`; correct it to the safe default (Codex P2).
      if (m) {
        if (isOpenAiFamilyModel(m)) return { model: m, omitModelFlag: false };
        return {
          model: DEFAULT_CODEX_CHAT_MODEL,
          omitModelFlag: false,
          note: `"${m}" is not an OpenAI/Codex model; using ${DEFAULT_CODEX_CHAT_MODEL}.`,
        };
      }
      // No explicit model: the fallback comes from the shared ~/.codex/config.toml,
      // which is untrusted. (a) Reject a shell-unsafe value loudly, surfacing the
      // broken config rather than running it. (b) Constrain to an OpenAI/Codex-family
      // model — a shell-safe NON-OpenAI alias (e.g. claude-…, gemini-…) must NOT be
      // passed to `codex --model` with an OpenAI key (it would fail); fall back to
      // the safe default instead (Codex P2).
      const shared = (status.defaultModelResolved ?? "").trim();
      if (shared && !isShellSafeModel(shared)) throw new ShellUnsafeModelError(shared);
      return { model: isOpenAiFamilyModel(shared) ? shared : DEFAULT_CODEX_CHAT_MODEL, omitModelFlag: false };
    }
    // Otherwise (chatgpt/subscription/unknown): validate against ChatGPT
    // compatibility and fall back to the safe default, with a note if corrected.
    const resolved = resolveCodexChatModel(m || null, status.defaultModelResolved);
    const note = (m && !isCodexCompatibleModel(m))
      ? `"${m}" is not supported on a ChatGPT Codex login; using ${resolved}.` : undefined;
    return { model: resolved, omitModelFlag: false, note };
  }

  if (adapterType === "gemini_local") {
    // Gemini CLI picks its own best model when no flag is passed; "auto" is
    // the canonical AoA signal for "let the CLI decide".
    return !m || m === "auto"
      ? { omitModelFlag: true }
      : { model: m, omitModelFlag: false };
  }

  // claude_local / opencode_local / openclaw / process / http / others:
  // empty → omit (adapter applies its own default); non-empty → pass through.
  return m ? { model: m, omitModelFlag: false } : { omitModelFlag: true };
}
