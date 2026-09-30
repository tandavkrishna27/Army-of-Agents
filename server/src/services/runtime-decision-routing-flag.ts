/**
 * Pure flag resolver for the W5b/W5c runtime-decision routing bridge.
 *
 * ALL four conditions must hold to return true:
 *   1. AOA_RUNTIME_DECISION_ROUTING=1  (instance-wide kill-switch — anything else → false)
 *   2. adapterType ∈ RUNTIME_DECISION_ADAPTERS  (allow-list; everything else → false)
 *   3. executionTargetType === "local" (docker/remote sandboxes can't reach 127.0.0.1)
 *   4. agentRuntimeConfig?.runtimeDecisionRoutingEnabled === true  (per-agent opt-in)
 *
 * Adapter allow-list: both `claude_local` (via out-of-process PreToolUse hooks,
 * W5b) and `codex_local` (via the in-process app-server JSON-RPC approval
 * callback, W5c) support runtime-decision routing. Both are gated identically by
 * the env kill-switch + local-target + per-agent flag, and both default OFF.
 *
 * Intentionally has zero side-effects and zero I/O so it is trivially testable
 * without mocking.
 */

const RUNTIME_DECISION_ADAPTERS = new Set(["claude_local", "codex_local"]);

export interface ResolveRuntimeDecisionRoutingInput {
  agentRuntimeConfig: unknown;
  instanceEnv: NodeJS.ProcessEnv | Record<string, string | undefined>;
  adapterType: string;
  executionTargetType: string;
}

export function resolveRuntimeDecisionRoutingEnabled(
  input: ResolveRuntimeDecisionRoutingInput,
): boolean {
  const { agentRuntimeConfig, instanceEnv, adapterType, executionTargetType } = input;

  // 1. Instance kill-switch — MUST be exactly "1"
  if (instanceEnv.AOA_RUNTIME_DECISION_ROUTING !== "1") return false;

  // 2. Adapter guard — allow-list of adapters that support runtime-decision routing
  if (!RUNTIME_DECISION_ADAPTERS.has(adapterType)) return false;

  // 3. Execution-target guard — remote/sandbox targets can't reach loopback
  if (executionTargetType !== "local") return false;

  // 4. Per-agent opt-in — null-safe access on the opaque JSON blob
  const config = agentRuntimeConfig != null && typeof agentRuntimeConfig === "object"
    ? (agentRuntimeConfig as Record<string, unknown>)
    : null;
  if (config?.runtimeDecisionRoutingEnabled !== true) return false;

  return true;
}
