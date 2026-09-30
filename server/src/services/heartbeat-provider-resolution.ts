import { applyModelResolutionToConfig } from "./internal-agent/aoa-agents/runner-model-resolution.js";
import type { ResolveModelStatus } from "./internal-agent/model-resolution.js";

/**
 * Heartbeat/org-path model resolution. The CALLER must invoke this on the
 * already-budget-swapped runScopedConfig (edge #5) — this helper is pure and
 * only resolves the config it is handed. Reuses the exact crew helper so org
 * and crew resolution can never diverge.
 */
export function resolveRunScopedModel(
  adapterType: string,
  runScopedConfig: Record<string, unknown>,
  status: ResolveModelStatus,
  opts: { inheritedEnvOpenAiKey?: string | null } = {},
): Record<string, unknown> {
  return applyModelResolutionToConfig(adapterType, runScopedConfig, status, opts);
}
