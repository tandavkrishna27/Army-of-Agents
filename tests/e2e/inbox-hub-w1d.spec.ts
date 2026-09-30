import { test, expect, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { seedHubItem } from "./helpers/seed-hub-item";
import { hubTabBody } from "./helpers/hub-tabs";

test.describe("Inbox Hub W1d grouping, settings, and mobile", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-HUB-W1D-/);
  });

  test("founder searches, groups, changes settings, and uses keyboard navigation", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-W1D-${Date.now()}`);

    for (let index = 1; index <= 6; index += 1) {
      await seedHubItem({
        companyId: company.id,
        semanticType: "join_request",
        sourceType: "w1d-alpha",
        sourceId: `alpha-${index}`,
        title: index === 3 ? "W1d unique deploy approval" : `W1d alpha approval ${index}`,
      });
      await seedHubItem({
        companyId: company.id,
        semanticType: "join_request",
        sourceType: "w1d-beta",
        sourceId: `beta-${index}`,
        title: `W1d beta approval ${index}`,
      });
    }
    await seedHubItem({
      companyId: company.id,
      semanticType: "suggestion",
      sourceType: "w1d-mobile",
      sourceId: "mobile-target",
      title: "W1d mobile stale work",
      ownerPool: "board",
    });

    // Hub settings now live in Settings → Inbox (the in-hub gear was removed —
    // single home). Each change persists to /hub-items/preferences/me and the
    // hub re-reads it, so we round-trip: set in Settings, verify in the hub.
    const gotoInboxSettings = () => page.goto(`/${company.issuePrefix}/settings?tab=inbox`);
    const waitPrefsPatch = () =>
      page.waitForResponse((response) =>
        response.url().includes("/hub-items/preferences/me") &&
        response.request().method() === "PATCH" &&
        response.status() === 200,
      );

    // Group by source.
    await gotoInboxSettings();
    const groupingSelect = page.getByRole("combobox", { name: /grouping/i });
    if ((await groupingSelect.inputValue()) !== "source") {
      await Promise.all([waitPrefsPatch(), groupingSelect.selectOption("source")]);
    }

    // Grouping is applied in the hub.
    await page.goto(`/${company.issuePrefix}/inbox/waiting`);
    const alphaGroup = page.getByRole("button", { name: /w1d-alpha/i });
    await expect(alphaGroup).toBeVisible();
    await expect(alphaGroup).toHaveAttribute("aria-expanded", "false");

    // Default landing → suggestions.
    await gotoInboxSettings();
    await Promise.all([
      waitPrefsPatch(),
      page.getByRole("combobox", { name: /default landing/i }).selectOption("suggestions"),
    ]);
    await page.goto(`/${company.issuePrefix}/inbox`);
    await expect(page).toHaveURL(new RegExp("/inbox/suggestions$"));

    await page.goto(`/${company.issuePrefix}/inbox/waiting`);
    await page.getByRole("searchbox", { name: /search hub/i }).fill("unique deploy");
    await expect(page.getByText("W1d unique deploy approval")).toBeVisible();
    await expect(page.getByText("W1d beta approval 1")).toBeHidden();

    await page.getByRole("searchbox", { name: /search hub/i }).fill("");
    await expect(alphaGroup).toHaveAttribute("aria-expanded", "false");
    await alphaGroup.click();
    await expect(alphaGroup).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: /W1d alpha approval 1/i })).toBeVisible();

    const visibleRows = page.locator("[data-hub-row-id]");
    await expect(visibleRows.first()).toBeVisible();
    const firstTitle = firstLine(await visibleRows.nth(0).innerText());
    const secondTitle = firstLine(await visibleRows.nth(1).innerText());

    await page.keyboard.press("j");
    await expectActiveTabTitle(page, firstTitle);
    await page.keyboard.press("j");
    await expectActiveTabTitle(page, secondTitle);
    await page.keyboard.press("k");
    await expectActiveTabTitle(page, firstTitle);

    // Hide the Notifications lane. Use a single click (not `uncheck()`): the
    // lane checkbox is server-controlled and only flips once its PATCH resolves,
    // so `uncheck()`'s re-click-until-unchecked loop races the round-trip in CI.
    // We assert the starting state, click once, await the PATCH, and let the
    // downstream hub assertion confirm the effect.
    await gotoInboxSettings();
    const notificationsLaneToggle = page.getByRole("checkbox", { name: "Notifications" });
    await expect(notificationsLaneToggle).toBeChecked();
    await Promise.all([waitPrefsPatch(), notificationsLaneToggle.click()]);
    await page.goto(`/${company.issuePrefix}/inbox/waiting`);
    await expect(
      page.getByRole("navigation", { name: /hub lanes/i }).getByRole("button", {
        name: /notifications/i,
      }),
    ).toBeHidden();
  });

  test("mobile drawer switches lanes and opens a tab without overlap", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-W1D-${Date.now()}`);
    await seedHubItem({
      companyId: company.id,
      semanticType: "suggestion",
      sourceType: "w1d-mobile",
      sourceId: "mobile-target",
      title: "W1d mobile stale work",
      ownerPool: "board",
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${company.issuePrefix}/inbox/waiting`);

    await page.getByRole("button", { name: /open hub lanes/i }).click();
    const drawer = page.getByRole("dialog", { name: /hub lanes/i });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: /suggestions/i }).click();
    await expect(page).toHaveURL(new RegExp("/inbox/suggestions$"));
    await expect(page.getByRole("button", { name: /W1d mobile stale work/i })).toBeVisible();

    await page.getByRole("button", { name: /W1d mobile stale work/i }).click();
    const body = hubTabBody(page);
    await expect(body).toBeVisible();
    const viewerBox = await body.boundingBox();
    expect(viewerBox?.width ?? 0).toBeGreaterThan(250);
    await expect(page.getByRole("tab", { name: /W1d mobile stale work/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

function firstLine(value: string) {
  return value.split(/\r?\n/)[0]?.trim() ?? "";
}

async function expectActiveTabTitle(page: Page, title: string) {
  await expect(page.getByRole("tab", { name: new RegExp(escapeRegExp(title)) })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
