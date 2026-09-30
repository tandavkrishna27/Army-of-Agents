import { test, expect, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import {
  markRuntimeDecisionRelayed,
  seedRuntimePermissionDecision,
} from "./helpers/seed-runtime-decision";
import { expectHubTabBody } from "./helpers/hub-tabs";

const PREFIX = /^E2E-HUB-W5-/;
const TITLE = "Allow deploy smoke command?";

function runtimeDecisionRow(page: Page) {
  return page.locator("button[data-hub-row-id]").filter({ hasText: TITLE });
}

test.describe("Inbox Hub W5 runtime decisions", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, PREFIX);
  });

  test("operator answers a runtime permission prompt and the hub item resolves after relay", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-W5-${Date.now()}`);
    const agentRes = await request.post(`/api/companies/${company.id}/agents`, {
      data: { name: "Runtime Bridge Agent" },
    });
    expect(agentRes.status(), await agentRes.text()).toBe(201);
    const agent = (await agentRes.json()) as { id: string };

    const seeded = await seedRuntimePermissionDecision({
      companyId: company.id,
      agentId: agent.id,
      title: TITLE,
      promptText: "The agent wants permission to run the deploy smoke command.",
      command: "pnpm test:run server/src/__tests__/agent-runtime-decisions.test.ts",
    });

    await page.goto(`/${company.issuePrefix}/inbox/waiting`);
    await expect(runtimeDecisionRow(page)).toBeVisible({
      timeout: 15_000,
    });

    await runtimeDecisionRow(page).click();
    await expectHubTabBody(page);
    await expect(page.getByRole("region", { name: /runtime decision/i })).toContainText(
      "created",
    );
    await expect(page.getByText("pnpm test:run server/src/__tests__/agent-runtime-decisions.test.ts")).toBeVisible();

    const answerResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(
        `/agent-runtime-decisions/${seeded.decision.id}/answer`,
      ),
    );
    await page.getByRole("button", { name: /^allow once$/i }).click();
    expect((await answerResponse).status()).toBe(200);
    await expect(page.getByRole("region", { name: /runtime decision/i })).toContainText(
      "answered",
      { timeout: 10_000 },
    );
    await expect(page.getByRole("button", { name: /^allow once$/i })).toBeDisabled();

    await markRuntimeDecisionRelayed({
      runId: seeded.run.id,
      decisionId: seeded.decision.id,
    });
    await page.goto(`/${company.issuePrefix}/inbox/waiting`);
    await expect(runtimeDecisionRow(page)).toBeHidden({
      timeout: 10_000,
    });
  });
});
