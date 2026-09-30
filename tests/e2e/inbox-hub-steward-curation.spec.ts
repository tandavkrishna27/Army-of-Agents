import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { seedHubItem } from "./helpers/seed-hub-item";
import { hubActionBar, hubTabBody } from "./helpers/hub-tabs";

test.describe("Inbox Hub Steward curation", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-HUB-W4-/);
  });

  test("operator reviews curated grouping, explanation, and normal lifecycle actions", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-W4-${Date.now()}`);
    const groupKey = `w4-release-risk-${Date.now()}`;
    const curatedAt = new Date("2026-07-01T10:00:00.000Z");

    for (const [index, title] of [
      "Release risk: failing smoke suite",
      "Release risk: blocked deploy lane",
      "Release risk: stale approval",
    ].entries()) {
      await seedHubItem({
        companyId: company.id,
        semanticType: "legacy_other",
        sourceType: "steward_curation",
        sourceId: `w4-group-${index}`,
        title,
        summary: "Steward grouped this with related release blockers.",
        ownerPool: "board",
        groupKey,
        curationGroupLabel: "Release risk cluster",
        curationGroupSummary: "Three release blockers point at the same launch lane.",
        curationReason: "Steward grouped this with related launch-lane blockers.",
        curationRevision: 1,
        curatedAt,
      });
    }

    const priorityItem = await seedHubItem({
      companyId: company.id,
      semanticType: "legacy_other",
      sourceType: "steward_curation",
      sourceId: "w4-priority",
      title: "Urgent launch run failed",
      summary: "The launch verification run failed after the release branch was cut.",
      ownerPool: "board",
      priority: "high",
      curationGroupLabel: "Launch run follow-up",
      curationReason: "Steward grouped this with the launch lane because it blocks today's release review.",
      curationPriorityReason: "High priority is set on this hub item.",
      curationRevision: 2,
      curatedAt,
    });

    await page.goto(`/${company.issuePrefix}/inbox/notifications`);
    await expect(page.getByRole("navigation", { name: /hub lanes/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /3 Release risk cluster/i })).toBeVisible();
    await expect(page.getByText("Three release blockers point at the same launch lane.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Urgent launch run failed/i })).toBeVisible();

    await page.getByRole("button", { name: /Urgent launch run failed/i }).click();
    const body = hubTabBody(page);
    await expect(body).toBeVisible();
    await expect(body).toContainText("Urgent launch run failed");
    await expect(body).toContainText("launch verification run failed");

    await expect(page.getByText(/runtime prompt|permission prompt|allow always/i)).toHaveCount(0);
    await expect(page.getByText(/draft email|mail draft|compose email/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Mail reserved/i })).toBeDisabled();

    await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes(`/hub-items/${priorityItem.id}/action`) &&
        response.request().method() === "POST" &&
        response.status() === 200,
      ),
      hubActionBar(page).getByRole("button", { name: /^resolve$/i }).click(),
    ]);

    const itemRes = await request.get(`/api/companies/${company.id}/hub-items/${priorityItem.id}`);
    expect(itemRes.ok(), await itemRes.text()).toBeTruthy();
    const resolved = (await itemRes.json()) as { status: string };
    expect(resolved.status).toBe("resolved");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${company.issuePrefix}/inbox/notifications`);
    await page.getByRole("button", { name: /3 Release risk cluster/i }).click();
    await page.getByRole("button", { name: /Release risk: failing smoke suite/i }).click();
    const mobileBody = hubTabBody(page);
    await expect(mobileBody).toContainText("Release risk: failing smoke suite");
    const bodyBox = await mobileBody.boundingBox();
    expect(bodyBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((bodyBox?.x ?? 0) + (bodyBox?.width ?? 0)).toBeLessThanOrEqual(390);
  });
});
