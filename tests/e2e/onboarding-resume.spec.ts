import { test, expect } from "@playwright/test";
import { freshOnboardingState, fillFounderProfileStep } from "./helpers/onboarding-e2e";

test.beforeEach(async ({ request }) => {
  await freshOnboardingState(request);
});

test("leaving after the profile step and returning resumes past profile (not re-shown)", async ({ page }) => {
  await page.goto("/onboarding");

  // Complete PROFILE_SET (rich Human Operating Profile step).
  await fillFounderProfileStep(page, "Resumer");
  await page.getByRole("button", { name: /continue/i }).click();
  // The step after profile is now the Phase-2 Organization (tenant) step.
  await expect(page.getByRole("heading", { name: /your organization/i })).toBeVisible();

  // Abandon, then return.
  await page.goto("/");
  await page.goto("/onboarding");

  // Resumes past profile at the organization step — profile is NOT shown again
  // (PROFILE_SET persisted; organizationId is ephemeral, so the org step, whose
  // isComplete reads it, is correctly the resume point).
  await expect(page.getByRole("heading", { name: /your organization/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("heading", { name: /first,\s*you/i })).toHaveCount(0);
});
