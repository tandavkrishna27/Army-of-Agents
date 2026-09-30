import { validateRegistry, type StepDefinition } from "../registry";
import { HumanProfileStep } from "./HumanProfileStep";
import { CreateOrganizationStep } from "./CreateOrganizationStep";
import { OrgStep } from "./OrgStep";
import { CommanderStep } from "./CommanderStep";
import { CloudAwareEnvironmentStep, CloudAwareVerifyStep } from "./CloudDeferredStep";
import { SpineCompleteStep } from "./SpineCompleteStep";

/**
 * The real onboarding steps, assembled here (registry.ts stays pure logic).
 *
 * WS0c: the founder wizard is the SPINE ONLY — Profile → Organization →
 * Company → Environment → Commander → Verify → terminal (SETUP_COMPLETE).
 * Department, Agent, and Review are no longer wizard steps; the
 * persona-driven In-flight tail (department/agent/first-job) moves to Home's
 * first-run experience (WS4–8/WS9), doing its own domain writes rather than
 * gated OnboardingState advances. `DepartmentStep`/`AgentStep` components
 * still exist (for later Home reuse, extracted of their onboarding-advance
 * calls) but are no longer registered here; `ReviewStep` is fully replaced by
 * `SpineCompleteStep`. See
 * docs/aoa/plans/2026-07-18-ws0c-onboarding-state-machine-design.md.
 *
 * Phase 2 Task 2/3/12 (naming-collision fix + org-first signup): the wizard
 * historically had ONE step ("organization") whose state/copy actually meant
 * COMPANY. That step is renamed to id "company" / state COMPANY_CREATED
 * (`OrgStep.tsx`), and a NEW "organization" step (`CreateOrganizationStep`,
 * the real multi-tenant Organization/tenant) is inserted immediately before
 * it at a fractional order (1.5) so no other step's `order` needed
 * renumbering. `CreateOrganizationStep` does not participate in the
 * `onboarding_progress` state machine (Organizations sit above the
 * per-company progress row — see Task 9's org-first journey resolver); its
 * `isComplete` instead reads the ephemeral `ctx.organizationId` FlowEngine
 * sets after the step completes, OR treats the step done once COMPANY_CREATED
 * is durable (a persisted company necessarily has an org — no ghost tenant on
 * reload; see the step's own comment). `state: "COMPANY_CREATED"` here is a
 * structural placeholder only (validateRegistry requires a real, in-sequence
 * `OnboardingState`) — this step never advances or reads completedStates for
 * that value; the "company" step below owns COMPANY_CREATED for real.
 */
export const ONBOARDING_STEPS: StepDefinition[] = [
  {
    id: "human-profile",
    order: 1,
    state: "PROFILE_SET",
    // Founders and invitees share the rich Human Operating Profile step; the
    // bare name-only ProfileStep it superseded was removed.
    journeys: ["founder", "invited"],
    dependsOn: ["AUTHENTICATED"],
    canSkip: false,
    shouldInclude: () => true,
    isComplete: (ctx) => ctx.completedStates.includes("PROFILE_SET"),
    Component: HumanProfileStep,
    title: "Set up your profile",
  },
  {
    id: "organization",
    order: 1.5,
    state: "COMPANY_CREATED",
    journeys: ["founder"],
    dependsOn: ["PROFILE_SET"],
    canSkip: false,
    shouldInclude: () => true,
    // Complete once the ephemeral org id is set (in-session) OR a company
    // already exists. `ctx.organizationId` is ephemeral FlowEngine state
    // (`useState(null)`, never re-seeded from memberships) and the company step
    // clears the persisted pending tenant on success, so after a founder
    // creates org → company then hard-reloads, `organizationId` is null. Without
    // the COMPANY_CREATED clause `resolveNextStep` (first incomplete step by
    // order) would re-offer this order-1.5 step over the complete order-2
    // company step and mint a DUPLICATE empty org. A persisted company
    // necessarily has an org (companies.organization_id is NOT NULL), so
    // COMPANY_CREATED implies this step is done.
    isComplete: (ctx) => Boolean(ctx.organizationId) || ctx.completedStates.includes("COMPANY_CREATED"),
    Component: CreateOrganizationStep,
    title: "Create your organization",
  },
  {
    id: "company",
    order: 2,
    state: "COMPANY_CREATED",
    journeys: ["founder"],
    dependsOn: ["PROFILE_SET"],
    canSkip: false,
    shouldInclude: () => true,
    isComplete: (ctx) => ctx.completedStates.includes("COMPANY_CREATED"),
    Component: OrgStep,
    title: "Create your company",
  },
  {
    id: "environment",
    order: 3,
    state: "ENVIRONMENT_READY",
    journeys: ["founder"],
    dependsOn: ["COMPANY_CREATED"],
    canSkip: false,
    shouldInclude: () => true,
    isComplete: (ctx) => ctx.completedStates.includes("ENVIRONMENT_READY"),
    Component: CloudAwareEnvironmentStep,
    title: "Set up environment",
  },
  {
    id: "commander",
    order: 4,
    state: "COMMANDER_SELECTED",
    journeys: ["founder"],
    dependsOn: ["ENVIRONMENT_READY"],
    canSkip: false,
    shouldInclude: () => true,
    isComplete: (ctx) => ctx.completedStates.includes("COMMANDER_SELECTED"),
    Component: CommanderStep,
    title: "Choose Commander",
  },
  {
    id: "verify",
    order: 5,
    state: "COMMANDER_VERIFIED",
    journeys: ["founder"],
    dependsOn: ["COMMANDER_SELECTED"],
    canSkip: false,
    shouldInclude: () => true,
    isComplete: (ctx) => ctx.completedStates.includes("COMMANDER_VERIFIED"),
    Component: CloudAwareVerifyStep,
    title: "Verify tooling",
  },
  {
    id: "spine-complete",
    order: 6,
    state: "SETUP_COMPLETE",
    journeys: ["founder"],
    dependsOn: ["COMMANDER_VERIFIED"],
    canSkip: false,
    shouldInclude: () => true,
    isComplete: (ctx) => ctx.completedStates.includes("SETUP_COMPLETE"),
    Component: SpineCompleteStep,
    title: "Bringing you to your control room",
  },
];

export const ONBOARDING_REGISTRY_VALIDATION_ERRORS = validateRegistry(ONBOARDING_STEPS);
if (ONBOARDING_REGISTRY_VALIDATION_ERRORS.length > 0) {
  throw new Error(
    `Invalid onboarding registry: ${ONBOARDING_REGISTRY_VALIDATION_ERRORS.map((error) => error.message).join("; ")}`,
  );
}
