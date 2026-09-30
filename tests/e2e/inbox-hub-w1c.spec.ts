import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { bumpHubItemVersionForTest, seedHubItem } from "./helpers/seed-hub-item";
import { hubActionBar, hubTabBody } from "./helpers/hub-tabs";

type SeededHubItem = Awaited<ReturnType<typeof seedHubItem>>;

async function act(
  request: APIRequestContext,
  companyId: string,
  item: Pick<SeededHubItem, "id" | "version">,
  action: "resolve" | "archive" | "claim" | "release",
) {
  const res = await request.post(`/api/companies/${companyId}/hub-items/${item.id}/action`, {
    data: { action, expectedVersion: item.version },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { item: SeededHubItem; auditId: string };
}

async function expandGroupIfNeeded(page: Page, rowName: RegExp, groupName: RegExp) {
  const row = hubRow(page, rowName);
  try {
    await expect(row).toBeVisible({ timeout: 2_000 });
    return row;
  } catch {
    // W1d grouping can hide W1c's rows behind a collapsed group; expand it only
    // after giving the flat row path a moment to load.
  }

  const group = page.getByRole("button", { name: groupName }).first();
  await expect(group).toBeVisible();
  if ((await group.getAttribute("aria-expanded")) === "false") {
    await group.click();
  }
  await expect(row).toBeVisible();
  return row;
}

function hubRow(page: Page, rowName: RegExp) {
  return page.locator("button[data-hub-row-id]").filter({ hasText: rowName });
}

test.describe("Inbox Hub W1c lifecycle", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-HUB-W1C-/);
  });

  test("operator can triage, undo, claim/release, and inspect history audit", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-W1C-${Date.now()}`);

    await seedHubItem({
      companyId: company.id,
      semanticType: "join_request",
      sourceType: "w1c",
      sourceId: "read-toggle",
      title: "Read toggle approval",
    });
    await seedHubItem({
      companyId: company.id,
      semanticType: "join_request",
      sourceType: "w1c",
      sourceId: "snooze",
      title: "Snooze deployment approval",
    });
    await seedHubItem({
      companyId: company.id,
      semanticType: "join_request",
      sourceType: "w1c",
      sourceId: "dismiss",
      title: "Dismiss noisy approval",
    });
    await seedHubItem({
      companyId: company.id,
      semanticType: "suggestion",
      sourceType: "w1c",
      sourceId: "resolve",
      title: "Resolve launch suggestion",
      ownerPool: "board",
    });
    const historySeed = await seedHubItem({
      companyId: company.id,
      semanticType: "join_request",
      sourceType: "w1c",
      sourceId: "history",
      title: "Resolved history approval",
    });
    await act(request, company.id, historySeed, "resolve");
    const claimSeed = await seedHubItem({
      companyId: company.id,
      semanticType: "suggestion",
      sourceType: "w1c",
      sourceId: "claim",
      title: "Claim board-pool stale work",
      ownerPool: "board",
    });

    await page.goto(`/${company.issuePrefix}/inbox/waiting`);
    const readRow = await expandGroupIfNeeded(page, /Read toggle approval/i, /w1c/i);

    await readRow.click();
    await expect(hubActionBar(page).getByRole("button", { name: /mark unread/i })).toBeVisible();
    await hubActionBar(page).getByRole("button", { name: /mark unread/i }).click();
    await expect(hubActionBar(page).getByRole("button", { name: /mark unread/i })).toBeHidden();

    await hubRow(page, /Snooze deployment approval/i).click();
    await hubActionBar(page).getByRole("button", { name: /^snooze$/i }).click();
    await expect(page.getByRole("button", { name: /^Snooze deployment approval$/i })).toBeHidden();

    await hubRow(page, /Dismiss noisy approval/i).click();
    await hubActionBar(page).getByRole("button", { name: /^dismiss$/i }).click();
    await expect(page.getByRole("button", { name: /^Dismiss noisy approval$/i })).toBeHidden();

    await page.goto(`/${company.issuePrefix}/inbox/suggestions`);
    await hubRow(page, /Resolve launch suggestion/i).click();
    await hubActionBar(page).getByRole("button", { name: /^resolve$/i }).click();
    await expect(page.getByRole("button", { name: /undo resolve/i })).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/hub-items/") &&
        response.url().includes("/undo") &&
        response.status() === 200,
      ),
      page.getByRole("button", { name: /undo resolve/i }).click(),
    ]);
    await page.goto(`/${company.issuePrefix}/inbox/suggestions`);
    const restoredResolveRow = await expandGroupIfNeeded(page, /Resolve launch suggestion/i, /w1c/i);
    await expect(restoredResolveRow).toBeVisible({
      timeout: 10_000,
    });

    await page.goto(`/${company.issuePrefix}/inbox/suggestions/${claimSeed.id}`);
    await expect(hubActionBar(page).getByRole("button", { name: /^claim$/i })).toBeVisible();
    await hubActionBar(page).getByRole("button", { name: /^claim$/i }).click();
    await expect(hubActionBar(page).getByRole("button", { name: /^release$/i })).toBeVisible();
    await hubActionBar(page).getByRole("button", { name: /^release$/i }).click();
    await expect(hubActionBar(page).getByRole("button", { name: /^claim$/i })).toBeVisible();

    await page.goto(`/${company.issuePrefix}/inbox/waiting`);
    await page.getByRole("button", { name: /^resolved$/i }).click();
    const resolvedHistoryRow = await expandGroupIfNeeded(page, /Resolved history approval/i, /w1c/i);
    await expect(page.getByText("Resolved history approval")).toBeVisible();
    await resolvedHistoryRow.click();
    await expect(hubTabBody(page)).toContainText("Resolved history approval");
  });

  test("bulk archive reports partial stale-version failure", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-HUB-W1C-${Date.now()}`);
    await seedHubItem({
      companyId: company.id,
      semanticType: "stale_work",
      sourceType: "w1c",
      sourceId: "bulk-fresh",
      title: "Bulk fresh stale work",
      ownerPool: "board",
    });
    const changed = await seedHubItem({
      companyId: company.id,
      semanticType: "stale_work",
      sourceType: "w1c",
      sourceId: "bulk-changed",
      title: "Bulk changed stale work",
      ownerPool: "board",
    });

    await page.goto(`/${company.issuePrefix}/inbox/suggestions`);
    await page.getByRole("checkbox", { name: /select bulk fresh stale work/i }).check();
    await page.getByRole("checkbox", { name: /select bulk changed stale work/i }).check();

    await bumpHubItemVersionForTest(changed);

    await page.getByRole("button", { name: /archive selected/i }).click();
    await expect(page.locator('[role="status"]').filter({ hasText: /1 succeeded, 1 failed/i })).toBeVisible();
    await expect(page.getByText("Bulk changed stale work")).toBeVisible();
  });
});
