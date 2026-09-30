/**
 * Plan 3 Task 6 — real cost accounting for crew SDK calls.
 *
 * Rates are in cents per million tokens (inputCentsPerM / outputCentsPerM).
 * Unknown models fall back to Sonnet pricing (conservative estimate).
 * CLI subscription runs cost $0 per-token — handled by the caller with a
 * comment; this module does the arithmetic only.
 */

const RATES: Record<string, { inputCentsPerM: number; outputCentsPerM: number }> = {
  // Anthropic — Claude 4 family (canonical IDs from api-common.ts)
  "claude-sonnet-4-6": { inputCentsPerM: 300, outputCentsPerM: 1500 },
  "claude-opus-4-6": { inputCentsPerM: 1500, outputCentsPerM: 7500 },
  "claude-haiku-4-5-20251001": { inputCentsPerM: 80, outputCentsPerM: 400 },
  // Anthropic — Claude 4 family (dated aliases kept for rows written before canonical IDs settled)
  "claude-sonnet-4-20250514": { inputCentsPerM: 300, outputCentsPerM: 1500 },
  "claude-opus-4-20250514": { inputCentsPerM: 1500, outputCentsPerM: 7500 },
  "claude-haiku-4-20251001": { inputCentsPerM: 80, outputCentsPerM: 400 },
  // Anthropic — Claude 3.x (legacy)
  "claude-3-5-sonnet-20241022": { inputCentsPerM: 300, outputCentsPerM: 1500 },
  "claude-3-5-haiku-20241022": { inputCentsPerM: 80, outputCentsPerM: 400 },
  "claude-3-opus-20240229": { inputCentsPerM: 1500, outputCentsPerM: 7500 },
  // OpenAI
  "gpt-4o": { inputCentsPerM: 250, outputCentsPerM: 1000 },
  "gpt-4o-mini": { inputCentsPerM: 15, outputCentsPerM: 60 },
  "gpt-4.1": { inputCentsPerM: 200, outputCentsPerM: 800 },
  // Google
  "gemini-1.5-pro": { inputCentsPerM: 350, outputCentsPerM: 1050 },
  "gemini-1.5-flash": { inputCentsPerM: 35, outputCentsPerM: 105 },
};

/** Fallback when model is not in the rate table. */
const DEFAULT_RATE = { inputCentsPerM: 300, outputCentsPerM: 1500 };

/**
 * JOB-012 — the closed set of models the versioned rate schedule KNOWS a real rate
 * for (the exact keys of RATES). The authoritative-cost bridge gates on this BEFORE
 * pricing so it can FAIL CLOSED on an unknown model instead of silently falling back
 * to DEFAULT_RATE (`computeCostCents`'s fail-OPEN behavior is intentionally preserved
 * for the legacy heartbeat/one-shot callers and must NOT change).
 */
export const KNOWN_RATE_MODELS: ReadonlySet<string> = new Set(Object.keys(RATES));

/** True iff `model` maps to a KNOWN rate (RATES key). Used only by the JOB-012
 * fail-closed authoritative-cost resolver; `computeCostCents` stays fail-open. */
export function isKnownRateModel(model: string): boolean {
  return KNOWN_RATE_MODELS.has(model);
}

/**
 * Compute cost in cents for a given provider + model + token counts.
 * Provider is accepted for future per-provider overrides but is currently
 * unused in lookups (model name is already globally unique across providers).
 * Returns 0 for zero tokens. Never throws — unknown models use DEFAULT_RATE.
 */
export function computeCostCents(
  _provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (inputTokens === 0 && outputTokens === 0) return 0;
  const rate = RATES[model] ?? DEFAULT_RATE;
  const cents =
    (inputTokens / 1_000_000) * rate.inputCentsPerM +
    (outputTokens / 1_000_000) * rate.outputCentsPerM;
  return Math.round(cents);
}
