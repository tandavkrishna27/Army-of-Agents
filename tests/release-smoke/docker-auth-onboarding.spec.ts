import { expect, test } from "@playwright/test";

/**
 * Release smoke against a published AoA Docker image. CI cannot automate a
 * real Google account, so the harness runs local_trusted with the explicit
 * local identity hatch. Real Google OAuth remains covered by live/manual QA;
 * this suite proves the image boots and the current founder flow can mutate
 * state through the same board APIs.
 *
 * The smoke stops at the environment step because the next action performs a
 * real filesystem probe inside the container. The expanded release-smoke lane
 * can own that container-specific setup separately.
 */

const PROFILE_NAME = `Release Smoke ${Date.now()}`;
const COMPANY_NAME = `Release-Smoke-${Date.now()}`;

test.describe("Docker local-trusted onboarding smoke", () => {
  test("opens onboarding, saves a profile, and creates an organization", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/onboarding$/);

    await expect(page.getByRole("heading", { name: "Your profile" })).toBeVisible();
    await page.locator("input").first().fill(PROFILE_NAME);
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Create your organization" })).toBeVisible({
      timeout: 20_000,
    });
    await page.locator("input").first().fill(COMPANY_NAME);
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Set up your environment" })).toBeVisible({
      timeout: 20_000,
    });

    const companiesRes = await page.request.get("/api/companies");
    expect(companiesRes.ok()).toBe(true);
    const companies = (await companiesRes.json()) as Array<{
      id: string;
      name: string;
      issuePrefix: string;
    }>;
    const company = companies.find((entry) => entry.name === COMPANY_NAME);
    expect(company).toBeTruthy();
    expect(company!.issuePrefix).toBeTruthy();
  });

  test("health endpoint reports local_trusted mode", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(body.deploymentMode).toBe("local_trusted");
  });
});
