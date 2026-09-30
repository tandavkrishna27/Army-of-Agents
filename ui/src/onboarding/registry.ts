import type { ComponentType } from "react";
import {
  orderedStatesFor,
  type OnboardingJourney,
  type OnboardingState,
} from "@armyofagents/shared";

export type StepContext = {
  userId: string;
  companyId: string | null;
  journey: OnboardingJourney;
  completedStates: OnboardingState[];
  deploymentMode?: "local_trusted" | "authenticated" | "cloud_auth";
  /**
   * The id of the Organization (multi-tenant account) created by
   * `CreateOrganizationStep` (Phase 2 Task 12), forwarded into the following
   * company step's `createCompany` call. Ephemeral — FlowEngine holds this in
   * memory (not derived from `onboarding_progress`, since Organizations sit
   * above the per-company progress row); it does not survive a hard reload.
   */
  organizationId: string | null;
  setOrganizationId?: (id: string) => void;
};

export type StepProps = {
  ctx: StepContext;
  /** Called after the step's server write succeeds; the engine advances + re-reads. */
  onComplete: () => void;
  onBack: () => void;
};

/**
 * A declarative onboarding step (revB §1.5). The engine walks the registry —
 * never a hardcoded switch — so future journeys insert/skip/branch by data.
 * `shouldInclude` (is this step APPLICABLE?) is distinct from `isComplete`
 * (is it already DONE?), and `order` makes sequencing explicit (not array index).
 */
export type StepDefinition = {
  id: string;
  order: number;
  state: OnboardingState;
  journeys: OnboardingJourney[];
  dependsOn: OnboardingState[];
  canSkip: boolean;
  shouldInclude: (ctx: StepContext) => boolean;
  isComplete: (ctx: StepContext) => boolean;
  // Accepts a plain or React.lazy component (a LazyExoticComponent IS a
  // ComponentType); the FlowEngine wraps rendering in <Suspense>.
  Component: ComponentType<StepProps>;
  title: string;
};

/**
 * The next step to render: first (by `order`) step in the current journey that
 * is applicable, whose dependencies are met, and that isn't already complete.
 * Returns null when the journey is finished.
 */
export function resolveNextStep(
  registry: StepDefinition[],
  ctx: StepContext,
): StepDefinition | null {
  const candidates = registry
    .filter((s) => s.journeys.includes(ctx.journey))
    .filter((s) => s.shouldInclude(ctx))
    .filter((s) => s.dependsOn.every((d) => ctx.completedStates.includes(d)))
    .filter((s) => !s.isComplete(ctx))
    .sort((a, b) => a.order - b.order);
  return candidates[0] ?? null;
}

export type RegistryValidationError = { code: string; message: string };

/**
 * Startup/test guard (revC RC-P2): reject duplicate ids, duplicate `order`
 * within a journey, dependencies on states not in the step's journey, and any
 * dependency that does not strictly precede the step's own state (which would
 * be forward/cyclic). Call at boot and in a test so a malformed registry fails
 * loudly rather than silently mis-ordering onboarding.
 */
export function validateRegistry(registry: StepDefinition[]): RegistryValidationError[] {
  const errors: RegistryValidationError[] = [];
  const ids = new Set<string>();
  const orderByJourney = new Map<OnboardingJourney, Set<number>>();

  for (const s of registry) {
    if (ids.has(s.id)) errors.push({ code: "dup_id", message: `duplicate step id: ${s.id}` });
    ids.add(s.id);

    for (const j of s.journeys) {
      const seen = orderByJourney.get(j) ?? new Set<number>();
      if (seen.has(s.order)) {
        errors.push({ code: "dup_order", message: `duplicate order ${s.order} in journey ${j}` });
      }
      seen.add(s.order);
      orderByJourney.set(j, seen);

      const seq = orderedStatesFor(j);
      const stateIdx = seq.indexOf(s.state);
      if (stateIdx < 0) {
        errors.push({ code: "state_not_in_journey", message: `step ${s.id} state ${s.state} not in journey ${j}` });
      }
      for (const dep of s.dependsOn) {
        const depIdx = seq.indexOf(dep);
        if (depIdx < 0) {
          errors.push({ code: "dep_not_in_journey", message: `step ${s.id} depends on ${dep} not in journey ${j}` });
        } else if (stateIdx >= 0 && depIdx >= stateIdx) {
          errors.push({ code: "dep_not_before_state", message: `step ${s.id} dependency ${dep} does not precede ${s.state}` });
        }
      }
    }
  }
  return errors;
}

/** Real steps are registered by Stage C. Empty for now. */
export const ONBOARDING_REGISTRY: StepDefinition[] = [];
