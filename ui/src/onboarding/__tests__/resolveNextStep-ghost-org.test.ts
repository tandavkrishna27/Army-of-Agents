import { describe, it, expect } from "vitest";
import { resolveNextStep, type StepContext } from "../registry";
import { ONBOARDING_STEPS } from "../steps";

// Round-4 regression guard: the founder wizard must NOT re-offer the
// "organization" step after a company already exists. `ctx.organizationId` is
// ephemeral React state (FlowEngine holds it in `useState(null)` and never
// re-seeds it from memberships), and the company step clears the persisted
// pending tenant on success. So after a founder creates org THEN company and
// then hard-reloads, `organizationId` is null but COMPANY_CREATED is durable.
// `resolveNextStep` returns the FIRST incomplete applicable step by order, so a
// still-incomplete org step (order 1.5) would win over the complete company
// step (order 2) — minting a DUPLICATE empty org (a ghost tenant). Since a
// persisted company necessarily has an org (companies.organization_id is NOT
// NULL), COMPANY_CREATED implies the org step is done.

const ctx = (over: Partial<StepContext>): StepContext => ({
  userId: "u1",
  companyId: null,
  journey: "founder",
  completedStates: ["AUTHENTICATED", "PROFILE_SET"],
  organizationId: null,
  ...over,
});

describe("resolveNextStep — no ghost org after company exists (round-4)", () => {
  it("skips the org step and returns 'environment' when a company already exists but organizationId is null (reload)", () => {
    const next = resolveNextStep(
      ONBOARDING_STEPS,
      ctx({
        completedStates: ["AUTHENTICATED", "PROFILE_SET", "COMPANY_CREATED"],
        organizationId: null,
      }),
    );
    expect(next?.id).toBe("environment");
  });

  it("still offers the org step to a fresh founder (no company, no org id yet)", () => {
    const next = resolveNextStep(
      ONBOARDING_STEPS,
      ctx({ completedStates: ["AUTHENTICATED", "PROFILE_SET"], organizationId: null }),
    );
    expect(next?.id).toBe("organization");
  });

  it("advances to the company step once the org id is set (in-session, pre-company)", () => {
    const next = resolveNextStep(
      ONBOARDING_STEPS,
      ctx({ completedStates: ["AUTHENTICATED", "PROFILE_SET"], organizationId: "org1" }),
    );
    expect(next?.id).toBe("company");
  });
});
