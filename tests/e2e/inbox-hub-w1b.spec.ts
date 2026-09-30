import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { seedHubItem } from "./helpers/seed-hub-item";
import { clickHubAction } from "./helpers/hub-actions";
import { expectActiveHubTab, expectHubTabBody } from "./helpers/hub-tabs";

test.describe("Inbox Hub W1b", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-HUB-/);
  });

  test("founder opens hub, switches lanes, opens item, and deep-links its tab", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-${Date.now()}`);

    const approvalRes = await request.post(`/api/companies/${company.id}/approvals`, {
      data: {
        type: "hire_agent",
        payload: { name: "Scout" },
        issueIds: [],
      },
    });
    expect(approvalRes.ok(), await approvalRes.text()).toBeTruthy();
    const approval = (await approvalRes.json()) as { id: string };

    await page.goto(`/${company.issuePrefix}/inbox`);
    const laneNav = page.getByRole("navigation", { name: /hub lanes/i });
    await expect(laneNav).toBeVisible();
    await laneNav.getByRole("button", { name: /waiting on you/i }).click();
    await expect(page.getByRole("button", { name: /Review hire agent approval/i })).toBeVisible();

    // Opening the item marks it read (PATCH …/state) → list invalidation + remount;
    // settle it so the viewer/URL assertions and the deep-link goto below don't race
    // the refetch.
    await clickHubAction(
      page,
      page.getByRole("button", { name: /Review hire agent approval/i }),
      "state",
    );
    await expectHubTabBody(page);
    await expectActiveHubTab(page, /Review hire agent approval/i);
    await expect(page).toHaveURL(new RegExp(`/inbox/waiting/.+`));

    const selectedUrl = page.url();
    await page.goto(selectedUrl);
    await expectHubTabBody(page);
    await expectActiveHubTab(page, /Review hire agent approval/i);
    await expect(
      page.locator(`[role="tab"][data-tab-id="approval:${approval.id}"]`),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("canonical route exposes notifications and suggestions lanes with legacy redirects", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-${Date.now()}`);

    await seedHubItem({
      companyId: company.id,
      semanticType: "agent_error",
      sourceType: "test_notification",
      sourceId: "n-1",
      title: "Agent failed to finish run",
      ownerPool: "board",
    });
    await seedHubItem({
      companyId: company.id,
      semanticType: "suggestion",
      sourceType: "test_suggestion",
      sourceId: "s-1",
      title: "Review stale project risk",
      ownerPool: "board",
    });

    await page.goto(`/${company.issuePrefix}/inbox/notifications`);
    await expect(page.getByText("Agent failed to finish run")).toBeVisible();

    const laneNav = page.getByRole("navigation", { name: /hub lanes/i });
    await laneNav.getByRole("button", { name: /suggestions/i }).click();
    await expect(page).toHaveURL(new RegExp(`/inbox/suggestions`));
    await expect(page.getByText("Review stale project risk")).toBeVisible();

    await page.goto(`/${company.issuePrefix}/inbox/new`);
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/inbox/waiting$`));
    await expect(page.getByRole("navigation", { name: /hub lanes/i })).toBeVisible();
  });
});
