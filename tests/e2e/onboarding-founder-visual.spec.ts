import { test, expect } from "@playwright/test";
import { freshOnboardingState, fillFounderProfileStep } from "./helpers/onboarding-e2e";

test.beforeEach(async ({ request }) => {
  await freshOnboardingState(request);
});

// QUARANTINED (onboarding redesign resync): this visual spec still walks the
// OLD linear founder flow (profile → org → env → commander → verify →
// department → agent → review) and asserts pre-redesign headings, so it fails
// at the first step. The redesign inserted the Map fork after the spine and
// replaced the tail surfaces (departments → integrations → braindump →
// librarian → agents → first_job). The win32-only screenshot baseline
// (founder-review.png) is also stale post-redesign. Re-enable once the flow is
// rewritten and a fresh baseline is pinned. Tracked as a follow-up.
// eslint-disable-next-line playwright/no-skipped-test
test.skip("captures each founder onboarding step + pins the review screen baseline", async ({ page }) => {
  const shot = (name: string) =>
    page.screenshot({ path: `test-results/onboarding/founder-${name}.png`, fullPage: true });

  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: /set up your profile/i })).toBeVisible({ timeout: 15_000 });
  await shot("01-profile");
  await fillFounderProfileStep(page, "Visual Founder");
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByRole("heading", { name: /create your organization/i })).toBeVisible();
  await shot("02-org");
  await page.getByRole("textbox").first().fill(`E2E-Test-Vis-${Date.now()}`);
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByRole("heading", { name: /set up your environment/i })).toBeVisible();
  await shot("03-environment");
  await page.getByRole("button", { name: /verify & continue/i }).click();

  await expect(page.getByRole("heading", { name: /choose your commander/i })).toBeVisible();
  await shot("04-commander");
  await page.getByText("Claude", { exact: true }).click();
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByRole("heading", { name: /verify your tooling/i })).toBeVisible();
  await shot("05-verify");
  await page.getByRole("button", { name: /^verify$/i }).click();

  await expect(page.getByRole("heading", { name: /create your first department/i })).toBeVisible({ timeout: 20_000 });
  await shot("06-department");
  await expect(page.getByTestId("department-local-folder")).toHaveValue(/[\\/]engineering$/i, {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /create department/i }).click();

  await expect(page.getByRole("heading", { name: /create your first agent/i })).toBeVisible({ timeout: 20_000 });
  await shot("07-agent");
  await page.getByRole("button", { name: /create & assign/i }).click();

  await expect(page.getByRole("heading", { name: /you're set up/i })).toBeVisible({ timeout: 20_000 });
  await shot("08-review");

  // Visual-regression baseline for the stable review screen. Mask the summary
  // rows (org/dept/agent names + generated ids vary run to run).
  //
  // win32 baseline only — Linux baseline generation needs a CI-side
  // update-snapshots pass (a Windows-generated PNG won't match the ubuntu
  // runner's font rendering, and a missing platform baseline fails the
  // REQUIRED Linux e2e job deterministically). Until then the pin runs where
  // a baseline exists; the structural assertions above run on all platforms.
  if (process.platform === "win32") {
    await expect(page).toHaveScreenshot("founder-review.png", {
      maxDiffPixelRatio: 0.02,
      mask: [page.locator("[data-testid='review-summary']")],
    });
  }
});
