import { expect, test } from "@playwright/test";

const COMPANY_NAME = process.env.AOA_LOCAL_TRIAL_COMPANY_NAME ?? `AoA Local Trial ${Date.now()}`;
const PROFILE_NAME = `Local Trial Operator ${Date.now()}`;
const ORGANIZATION_NAME = `Local Trial Org ${Date.now()}`;

test.describe("login-free local Docker trial onboarding", () => {
  test("reaches provider setup without Google and exposes both provider sign-in options", async ({ page, request }) => {
    test.setTimeout(300_000);

    await page.goto("/");
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "First, you." })).toBeVisible();
    await page.getByRole("textbox", { name: "Name" }).fill(PROFILE_NAME);
    await page.getByLabel("Title").selectOption("Founder");
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Your organization" })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("textbox", { name: "Organization name" }).fill(ORGANIZATION_NAME);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Your company" })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole("textbox", { name: "Company name" }).fill(COMPANY_NAME);
    const createStartedAt = Date.now();
    const createResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/companies",
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: "Continue" }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok(), await createResponse.text()).toBe(true);
    // Company creation commits before the onboarding resolver advances. Reload
    // once from server-backed progress so a recovery surface can safely adopt
    // the same company rather than attempting to create a duplicate.
    await expect.poll(async () => {
      const response = await request.get("/api/companies");
      if (!response.ok()) return false;
      const companies = (await response.json()) as Array<{ name: string }>;
      return companies.some((entry) => entry.name === COMPANY_NAME);
    }, { timeout: 60_000 }).toBe(true);
    test.info().annotations.push({
      type: "cold-company-create-ms",
      description: String(Date.now() - createStartedAt),
    });
    await page.reload();
    if (await page.getByText("Your company is already created — continue to pick up where you left off.").isVisible()) {
      await page.getByRole("button", { name: "Continue" }).click();
    }
    await expect(page.getByRole("heading", { name: /environment/i })).toBeVisible({ timeout: 30_000 });

    const companiesResponse = await request.get("/api/companies");
    expect(companiesResponse.ok()).toBe(true);
    const companies = (await companiesResponse.json()) as Array<{
      id: string;
      name: string;
      issuePrefix: string;
    }>;
    const company = companies.find((entry) => entry.name === COMPANY_NAME);
    expect(company?.id).toBeTruthy();
    expect(company?.issuePrefix).toBeTruthy();

    await expect.poll(async () => {
      const response = await request.get(`/api/companies/${company!.id}/agents?kind=aoa`);
      if (!response.ok()) throw new Error(`Could not read company agents: HTTP ${response.status()} ${await response.text()}`);
      const body = await response.json();
      const agents = (Array.isArray(body) ? body : body.agents) as Array<{ name?: string }>;
      return agents.map((agent) => agent.name ?? "(unnamed)");
    }, { timeout: 60_000 }).toContain("Reviewer");

    const capabilitiesResponse = await request.get(
      `/api/companies/${company!.id}/internal-agent/commander-login/capabilities`,
    );
    expect(capabilitiesResponse.ok()).toBe(true);
    const capabilities = await capabilitiesResponse.json();
    expect(capabilities.topology).toMatchObject({
      installProfile: "local_single_user",
      networkLocation: "local",
      trustBoundary: "single_user",
      executionOwnership: "user_hosted",
    });
    expect(capabilities.providers.openai).toMatchObject({ enabled: true, mode: "device_code" });
    expect(capabilities.providers.anthropic).toMatchObject({ enabled: true, mode: "paste_code" });

    await page.getByLabel("Root folder").fill(`/aoa/instances/default/workspaces/local-trial-${Date.now()}`);
    await page.getByRole("button", { name: "Verify & continue" }).click();
    await expect(page.getByRole("heading", { name: /Bring your engine online/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Codex" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Verify your tooling" })).toBeVisible();
    const codexVerifyResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST" && /\/internal-agent\/verify$/.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: "Verify" }).click();
    const codexVerifyResponse = await codexVerifyResponsePromise;
    expect(codexVerifyResponse.status()).toBe(422);
    expect(await codexVerifyResponse.json()).toMatchObject({ outcome: "needs_auth" });
    await expect(page.getByRole("button", { name: "Sign in with Codex" })).toBeVisible({
      timeout: 30_000,
    });

    const switchToClaude = await request.patch(
      `/api/companies/${company!.id}/internal-agent/config`,
      { data: { cliTool: "claude_cli", provider: "anthropic", model: null, crewModel: null } },
    );
    expect(switchToClaude.ok()).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Verify your tooling" })).toBeVisible();
    const claudeVerifyResponsePromise = page.waitForResponse(
      (response) => response.request().method() === "POST" && /\/internal-agent\/verify$/.test(new URL(response.url()).pathname),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: "Verify" }).click();
    const claudeVerifyResponse = await claudeVerifyResponsePromise;
    expect(claudeVerifyResponse.status()).toBe(422);
    expect(await claudeVerifyResponse.json()).toMatchObject({ outcome: "needs_auth" });
    await expect(page.getByRole("button", { name: "Sign in with Claude" })).toBeVisible({
      timeout: 30_000,
    });

    // This proves the provider login entry points are available, not that either
    // vendor account is signed in. Do not launch an external sign-in in CI.
  });

  test("health reports local_trusted", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
    const health = await response.json();
    expect(health.deploymentMode).toBe("local_trusted");
  });
});
