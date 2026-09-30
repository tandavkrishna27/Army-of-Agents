/**
 * Package-local mirror of the codex chat-model resolver.
 *
 * CANONICAL SOURCE: server/src/services/internal-agent/codex-model.ts
 * (resolveCodexChatModel / isCodexCompatibleModel / the family+incompatible
 * regexes). The codex-local adapter package has no dependency on the server
 * package and there is no shared re-export, so this is an INTENTIONAL, faithful
 * duplication — keep the two in sync. Mirrors the existing codex-model.ts ↔
 * packages/shared/src/validators/agent.ts duplication pattern.
 *
 * Why it exists: a supervised `codex app-server` run with no model falls back to
 * the compiled-in gpt-5.3-codex, which a ChatGPT/subscription account rejects
 * with HTTP 400 → empty turn (BUG-6). We resolve a compatible model and deliver
 * it via config.toml.
 */
import { DEFAULT_CODEX_LOCAL_MODEL } from "../index.js"; // "gpt-5.5"

// Shell-safe identifier (argv interpolation guard). Full-string anchor.
const SAFE_MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;
// OpenAI/Codex naming families: gpt-*, o<N>*, chatgpt*, codex-*.
const CODEX_FAMILY_RE = /^(gpt-|o\d|chatgpt|codex)/i;
// GPT-Codex variants (…-codex / codex-…) are API-key-only → 400 on a ChatGPT
// login. Deny so a stray config/shared value can never reintroduce the 400.
const CODEX_INCOMPATIBLE_RE = /codex/i;

export function isCodexCompatibleModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.trim();
  return SAFE_MODEL_RE.test(m) && CODEX_FAMILY_RE.test(m) && !CODEX_INCOMPATIBLE_RE.test(m);
}

/**
 * Layered, validated resolution: config → shared ~/.codex/config.toml → the safe
 * default (gpt-5.5). Every source is validated so a claude default, a GPT-Codex
 * model, or a shell-unsafe string can never reach codex.
 */
export function resolveCodexChatModel(
  configModel: string | null | undefined,
  sharedModel: string | null | undefined,
): string {
  if (isCodexCompatibleModel(configModel)) return configModel!.trim();
  if (isCodexCompatibleModel(sharedModel)) return sharedModel!.trim();
  return DEFAULT_CODEX_LOCAL_MODEL;
}
