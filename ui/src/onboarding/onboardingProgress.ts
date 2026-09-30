import { FOUNDER_PHASE1_STATES, type OnboardingJourney } from "@armyofagents/shared";
import type { StepContext, StepDefinition } from "./registry";

/**
 * Continuous onboarding step model (WS9 counter fix).
 *
 * Onboarding runs in two render paths: the `FlowEngine` SPINE (registry steps)
 * and the post-spine Home first-run (the Map, then the In-flight tail). Only the
 * spine used to render the "Step N of M" counter, so it vanished at the Map
 * onward. These pure helpers give both paths ONE continuous count.
 *
 * The founder count is: `BASE = visible spine steps + 1` (the Map is one step),
 * and picking the In-flight door extends the total by the in-flight surfaces.
 * Explorer ends at the Map. Invited has no Map, so `BASE = spine steps`.
 */

export type OnboardingPhase = "spine" | "map" | "inflight";

/** Only the founder journey has the post-spine Map fork; invited does not. */
export function journeyHasFirstRunMap(journey: OnboardingJourney): boolean {
  return journey === "founder";
}

/**
 * Number of spine steps that apply to this journey — the SAME filter
 * `FlowEngine` uses to build `applicableSteps` (journey membership +
 * `shouldInclude`), so the counter's denominator matches what the spine renders.
 */
export function countVisibleSpineSteps(registry: StepDefinition[], ctx: StepContext): number {
  return registry.filter((s) => s.journeys.includes(ctx.journey) && s.shouldInclude(ctx)).length;
}

/** BASE = visible spine steps (+1 for the Map on journeys that have it). */
export function computeOnboardingBase(registry: StepDefinition[], ctx: StepContext): number {
  return countVisibleSpineSteps(registry, ctx) + (journeyHasFirstRunMap(ctx.journey) ? 1 : 0);
}

/**
 * BASE for the post-spine Home first-run surfaces (the Map + In-flight tail),
 * which don't have a live `StepContext`. The spine is finished by the time these
 * render, so every founder spine step is applicable — evaluate the registry
 * against a fully-complete founder context. Equals the `BASE` the spine's last
 * step displayed, so the count is continuous across the handoff.
 */
export function computeFounderMapBase(
  registry: StepDefinition[],
  companyId: string | null,
): number {
  const ctx: StepContext = {
    userId: "",
    companyId,
    journey: "founder",
    completedStates: FOUNDER_PHASE1_STATES,
    // No live organizationId here (post-spine, synthetic fully-complete
    // context) — harmless: countVisibleSpineSteps/computeOnboardingBase only
    // filter on journeys/shouldInclude, never isComplete, so this field isn't
    // read for the count.
    organizationId: null,
  };
  return computeOnboardingBase(registry, ctx);
}

/**
 * The continuous "Step N of M" position, or `null` when the counter should not
 * show (single-step journeys, or Explorer once past the Map).
 *
 * - `spine`   → `spineIndex+1 of BASE` (so the last spine step is `BASE-1 of BASE`).
 * - `map`     → `BASE of BASE`.
 * - `inflight`→ In-flight only: `BASE+inflightIndex+1 of BASE+inflightApplicable`.
 *   Explorer (or zero applicable surfaces) → `null`.
 */
export function computeOnboardingPosition(input: {
  phase: OnboardingPhase;
  base: number;
  spineIndex?: number;
  persona?: "in_flight" | "explorer" | null;
  inflightIndex?: number;
  inflightApplicable?: number;
}): { current: number; total: number } | null {
  const { phase, base } = input;
  if (base <= 1) return null;

  if (phase === "spine") {
    return { current: (input.spineIndex ?? 0) + 1, total: base };
  }
  if (phase === "map") {
    return { current: base, total: base };
  }
  // inflight
  if (input.persona !== "in_flight") return null; // Explorer exits at the Map.
  const applicable = input.inflightApplicable ?? 0;
  if (applicable <= 0) return null;
  return { current: base + (input.inflightIndex ?? 0) + 1, total: base + applicable };
}
