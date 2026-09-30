import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { seedHubItem } from "./helpers/seed-hub-item";
import { clickHubAction } from "./helpers/hub-actions";
import { expectActiveHubTab, expectHubTabBody, hubTabBody } from "./helpers/hub-tabs";

test.describe("Inbox Hub final operator flow", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-HUB-OP-/);
  });

  test("founder clears the Inbox Hub operator flow", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-HUB-OP-${Date.now()}`);
    const approvalRes = await request.post(`/api/companies/${company.id}/approvals`, {
      data: {
        type: "hire_agent",
        payload: { name: "Operator Scout" },
        issueIds: [],
      },
    });
    expect(approvalRes.ok(), await approvalRes.text()).toBeTruthy();
    const approval = (await approvalRes.json()) as { id: string };

    await page.goto(`/${company.issuePrefix}/inbox`);
    await expect(page.getByText(/Autopilot/i)).toBeVisible();
    await page.getByRole("navigation", { name: /hub lanes/i })
      .getByRole("button", { name: /waiting on you/i })
      .click();
    await expect(page.getByRole("button", { name: /Review hire agent approval/i })).toBeVisible();

    // Opening the item marks it read (PATCH …/state), which invalidates + remounts
    // the list/viewer; settle it before asserting the viewer opened.
    await clickHubAction(
      page,
      page.getByRole("button", { name: /Review hire agent approval/i }),
      "state",
    );
    await expectHubTabBody(page);
    await expectActiveHubTab(page, /Review hire agent approval/i);
    await expect(
      page.locator(`[role="tab"][data-tab-id="approval:${approval.id}"]`),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: /^approve$/i }).click();
    await page.getByRole("button", { name: /^resolved$/i }).click();
    await expect(page.getByRole("button", { name: /Review hire agent approval/i })).toBeVisible();
  });

  test("approval canonical routes remain available", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-HUB-OP-${Date.now()}`);
    const approvalRes = await request.post(`/api/companies/${company.id}/approvals`, {
      data: {
        type: "hire_agent",
        payload: { name: "Route Scout" },
        issueIds: [],
      },
    });
    expect(approvalRes.ok(), await approvalRes.text()).toBeTruthy();
    const approval = (await approvalRes.json()) as { id: string };
    const main = page.getByRole("main");

    await page.goto(`/${company.issuePrefix}/approvals/pending`);
    // 30s: the first navigation compiles the Approvals route chunk under vite-dev
    // on a cold CI runner (~8s), well past the default 5s assertion timeout.
    await expect(main.getByRole("heading", { name: /Approvals/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.goto(`/${company.issuePrefix}/approvals/all`);
    // 30s: the first navigation compiles the Approvals route chunk under vite-dev
    // on a cold CI runner (~8s), well past the default 5s assertion timeout.
    await expect(main.getByRole("heading", { name: /Approvals/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.goto(`/${company.issuePrefix}/approvals/${approval.id}`);
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/approvals/${approval.id}`));
  });

  test("mobile Inbox Hub navigation has no overlap", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-HUB-OP-${Date.now()}`);
    await seedHubItem({
      companyId: company.id,
      semanticType: "run_failed",
      sourceType: "operator-mobile",
      sourceId: "notification-1",
      title: "Mobile failed run notification",
      ownerPool: "board",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${company.issuePrefix}/inbox`);
    await page.getByRole("button", { name: /open hub lanes/i }).click();
    const drawer = page.getByRole("dialog", { name: /hub lanes/i });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: /notifications/i }).click();
    await expect(page.getByRole("button", { name: /Mobile failed run notification/i })).toBeVisible();

    await page.getByRole("button", { name: /Mobile failed run notification/i }).click();
    const body = hubTabBody(page);
    await expect(body).toBeVisible();
    const box = await body.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(250);
  });
});
