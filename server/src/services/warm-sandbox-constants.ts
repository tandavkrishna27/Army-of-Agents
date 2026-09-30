/**
 * Warm-sandbox operator constants (Wave 6 / U7.3).
 *
 * Sibling of D5's HEARTBEAT_MAX_CONCURRENT_RUNS_* clamp: a permanent bound
 * that keeps warm-sandbox accumulation cheap regardless of instance config.
 */

// Bounds live+paused sandboxes per company. Acquiring past this cap evicts
// the oldest paused sandbox rather than blocking a run (see U7.5/U7.6).
export const WARM_SANDBOX_MAX_PER_COMPANY_DEFAULT = 5;

// Default idle TTL (minutes) before the reaper destroys a paused sandbox.
export const WARM_SANDBOX_IDLE_TTL_MINUTES_DEFAULT = 30;

/**
 * Normalizes an instance-configured warm idle TTL (minutes). Falsy/invalid
 * input falls back to the default; valid input is clamped to [1, 1440] (24h).
 */
export function normalizeWarmIdleTtlMinutes(v: unknown): number {
  const n = Math.floor(typeof v === "number" ? v : Number(v));
  if (!Number.isFinite(n) || n <= 0) return WARM_SANDBOX_IDLE_TTL_MINUTES_DEFAULT;
  return Math.max(1, Math.min(1440, n));
}
