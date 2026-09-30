import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

async function seedThread(
  request: APIRequestContext,
  companyId: string,
): Promise<{ id: string; title: string }> {
  const title = `E2E crew cycle ${Date.now()}`;
  const threadRes = await request.post(`/api/companies/${companyId}/discussions`, {
    data: { title },
  });
  if (!threadRes.ok()) {
    const body = await threadRes.text().catch(() => "(no body)");
    throw new Error(`seedThread failed: ${threadRes.status()} ${body}`);
  }
  const thread = (await threadRes.json()) as { id: string; title: string };

  const patchRes = await request.patch(`/api/companies/${companyId}/discussions/${thread.id}`, {
    data: { autonomyLevel: 1 },
  });
  if (!patchRes.ok()) {
    const body = await patchRes.text().catch(() => "(no body)");
    throw new Error(`patchThread failed: ${patchRes.status()} ${body}`);
  }

  return { id: thread.id, title };
}

async function patchCompanyAutonomy(
  request: APIRequestContext,
  companyId: string,
  autonomyLevel: number,
): Promise<void> {
  const res = await request.patch(`/api/companies/${companyId}/internal-agent/config`, {
    // D18: crew flows read the crew dial, not Commander's.
    data: { crewAutonomyLevel: autonomyLevel },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`patchCompanyAutonomy failed: ${res.status()} ${body}`);
  }
}

async function sendThreadMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId("entry-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.fill(text);
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect(
    page.locator('[data-testid^="entry-row-"]').filter({ hasText: text }).first(),
  ).toBeVisible({ timeout: 10_000 });
}

async function waitForAgentEntry(page: Page, agentName: string, text: RegExp): Promise<void> {
  const entry = page
    .locator('[data-testid^="entry-row-"][data-entry-type="agent"]')
    .filter({ hasText: agentName })
    .filter({ hasText: text })
    .first();
  await expect(entry).toBeVisible({ timeout: 75_000 });
}

test.describe("thread crew response cycle", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Crew-/);
  });

  test("shows proactive Adjutant, direct Scout response, and scope proposal task cycle", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Crew-${Date.now()}`);
    await patchCompanyAutonomy(request, company.id, 1);
    const thread = await seedThread(request, company.id);

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByRole("heading", { name: thread.title }).first()).toBeVisible({
      timeout: 10_000,
    });

    await sendThreadMessage(
      page,
      "We need to discuss the central panel experience and decide how agents should help. Decision rule: preserve the chosen agent-help behavior as durable memory.",
    );
    await waitForAgentEntry(page, "Adjutant", /move this forward/i);

    await sendThreadMessage(
      page,
      "@Scout please check the user need and constraints before we make this tracked work.",
    );
    await waitForAgentEntry(page, "Scout", /validate the user need/i);

    await sendThreadMessage(
      page,
      "Adjutant, please scope this into tracked tasks now.",
    );

    await page.getByTestId("center-tab-scope").click();
    await page.getByRole("button", { name: /^create scope draft$/i }).click();
    await expect(page.getByTestId("scope-version-package")).toContainText("Scope v1", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("scope-version-package")).toContainText("Task proposals");
    await expect(page.getByTestId("scope-version-package")).toContainText("Memory candidates");
    // The scope-proposal card persists as an audit trail; the "Scoped" badge
    // confirms the proposal has been acted on (scope draft created).
    await page.getByTestId("center-tab-thread").click();
    await expect(page.getByTestId("scope-proposal-card")).toHaveCount(1);
    await expect(page.getByTestId("scope-proposal-scoped-badge")).toBeVisible();
  });
});
