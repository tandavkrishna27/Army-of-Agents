import { getProviderStatus } from "../../../adapters/provider-status.js";
import { realProviderStatusDeps } from "../../../adapters/provider-status-deps.js";

/**
 * Best-effort: is the codex auth for this company in api-key mode? True when the
 * agent has its own per-agent OPENAI_API_KEY OR the shared ~/.codex/auth.json is
 * api-key mode (the same source the run + provider-status detection use). Used by
 * crew backfill callers so an explicit api-key-only codex model (gpt-*-codex /
 * codex-mini-latest) is NOT self-healed to gpt-5.5 (Codex P2).
 *
 * NEVER throws — a detection hiccup must not abort crew seeding; defaults to
 * false (the conservative "treat as subscription, may self-heal" path).
 */
export async function isCodexApiKeyAuth(
  companyId: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): Promise<boolean> {
  try {
    const status = await getProviderStatus(
      "codex_local",
      { companyId, adapterConfig: adapterConfig ?? {} },
      realProviderStatusDeps,
    );
    return status.authMode === "apikey";
  } catch {
    return false;
  }
}
