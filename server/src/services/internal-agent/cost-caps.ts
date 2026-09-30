/**
 * Plan 3 Task 9 — per-role model + extract/classify cost-caps + run-rate brake.
 *
 * Three pure helpers:
 *  - capExceeded: compare an estimated cost against a per-call cap
 *  - resolveRoleModel: pick the model for a crew role (role config > company default)
 *  - runRateExceeded: D3 run-rate brake for CLI-subscription runs (no per-token cost)
 *
 * Wire these into dispatcher.ts before invoking a crew role:
 *  1. Estimate cost with computeCostCents on prompt size; skip if capExceeded.
 *  2. Count crew runs in the rolling window; skip if runRateExceeded.
 *  3. Use resolveRoleModel to pick the model for each role.
 */

/**
 * Returns true if the estimated cost exceeds the configured cap.
 * Returns false if no cap is configured (null = unlimited).
 */
export function capExceeded(estimatedCents: number, capCents: number | null): boolean {
  if (capCents == null) return false;
  return estimatedCents > capCents;
}

/**
 * Resolve the model to use for a crew role.
 * Prefers the role's own configured model; falls back to the company default.
 */
export function resolveRoleModel(input: {
  roleModel: string | null;
  companyDefault: string;
}): string {
  return input.roleModel ?? input.companyDefault;
}

/**
 * D3: CLI subscription runs cost $0 per-token, so capExceeded() cannot brake
 * a runaway crew loop. Cap crew runs per thread/company per rolling window instead.
 *
 * Returns true (caller should skip the run) when runsInWindow >= maxRunsPerWindow.
 * Default cap: 10 runs per 10 minutes (configurable on internal_agent_config).
 */
export function runRateExceeded(runsInWindow: number, maxRunsPerWindow: number): boolean {
  return runsInWindow >= maxRunsPerWindow;
}

/** Default crew run-rate limits (configurable via internal_agent_config). */
export const DEFAULT_CREW_RATE_LIMIT = {
  maxRunsPerWindow: 10,
  windowMinutes: 10,
} as const;

// A5: run-COUNT brake (the never-built T1.9). Counts ALL crew runs — the cost-only
// brake is blind to $0 CLI runs, exactly what a runaway crew loop produces.
export const DEFAULT_CREW_RUN_COUNT_LIMIT = { windowMinutes: 5, maxRunsPerWindow: 40 };
