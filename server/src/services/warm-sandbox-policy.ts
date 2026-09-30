/**
 * Warm-sandbox decision (Wave 6 / U7.2).
 *
 * A single pure resolver so org, crew, and Commander call sites cannot drift
 * on the warm-vs-ephemeral decision. Per spec §7 / §8:
 *   - Crew (`kind='aoa'`) is ALWAYS ephemeral — never warm, no override.
 *   - Commander (no `functionType`, W7.5c): warm-capable, keyed on its
 *     conversation. Gated by the instance toggle `warmCommanderConversations`
 *     (default-on for cloud); no per-agent override (Commander has no agent).
 *   - Org: a per-agent override (`agents.runtimeConfig.warmWorkspace`) wins
 *     either way over the type default; absent an override, warm defaults on
 *     only for `functionType === "software_development"`, gated by the
 *     instance-wide baseline (`warmSandboxDefaultForSoftwareDev`).
 */

export type WarmRunType = "org" | "crew" | "commander";

export interface WarmSandboxPolicyInput {
  runType: WarmRunType;
  functionType: string | null;
  /** agents.runtimeConfig.warmWorkspace — true/false override, null = unset. */
  agentWarmOverride: boolean | null;
  instanceDefaultWarmForSoftwareDev: boolean;
  /** W7.5c — instance toggle for warm Commander conversations. Absent ⇒ treated
   *  as true (default-on for cloud). Does NOT affect crew/org. */
  warmCommanderConversations?: boolean;
}

export interface WarmSandboxDecision {
  warm: boolean;
  reason: string;
}

export function resolveWarmSandboxPreference(input: WarmSandboxPolicyInput): WarmSandboxDecision {
  // Hard rule first — crew (`kind='aoa'`) can NEVER be warm in v1 (spec §7); no
  // input combination flips it, including the commander toggle below.
  if (input.runType === "crew") return { warm: false, reason: "crew_always_ephemeral" };

  // W7.5c — Commander is warm-capable, keyed on its conversation. Gated only by
  // the instance toggle (Commander has no functionType). Absent ⇒ default-on.
  if (input.runType === "commander") {
    const warm = input.warmCommanderConversations !== false; // default-on
    return warm
      ? { warm: true, reason: "commander_warm_conversation" }
      : { warm: false, reason: "commander_warm_disabled" };
  }

  // Org: per-agent override wins either way.
  if (input.agentWarmOverride === true) return { warm: true, reason: "agent_override_on" };
  if (input.agentWarmOverride === false) return { warm: false, reason: "agent_override_off" };

  // Type default, gated by the instance baseline.
  const typeDefault = input.functionType === "software_development" && input.instanceDefaultWarmForSoftwareDev;
  return {
    warm: typeDefault,
    reason: typeDefault ? "type_default_software_development" : "type_default_ephemeral",
  };
}

/** Reads the per-agent warm override from agents.runtimeConfig (jsonb). */
export function readAgentWarmOverride(runtimeConfig: unknown): boolean | null {
  const rc = runtimeConfig && typeof runtimeConfig === "object" ? (runtimeConfig as Record<string, unknown>) : {};
  return typeof rc.warmWorkspace === "boolean" ? rc.warmWorkspace : null;
}
