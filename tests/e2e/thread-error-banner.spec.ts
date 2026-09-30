import { expect, test } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * PR-A2 — the thread error banner.
 *
 * A healthy thread (no orchestration error) must NOT show the banner, and the thread page must load
 * with the new banner code wired into the header. The POSITIVE case (banner appears when the thread's
 * `lastError` is set) is an INTERNAL field with no API to seed — so it is covered instead by the
 * component unit test (`ui/src/components/threads/ThreadErrorBanner.test.tsx`, which renders the banner
 * for a given error) + the backend integration test (`discussion-detail-lasterror.integration.test.ts`,
 * which proves `getById` surfaces `lastError`). Together they cover the same wiring this e2e would,
 * without needing to forge an internal error state the product never exposes through an API.
 */
test.describe("thread error banner (PR-A2)", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-ThreadErr-/);
  });

  test("a healthy thread loads and shows no error banner", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-ThreadErr-${Date.now()}`);

    const res = await request.post(`/api/companies/${company.id}/discussions`, {
      data: { title: `Healthy thread ${Date.now()}` },
    });
    expect(res.ok()).toBeTruthy();
    const thread = (await res.json()) as { id: string };

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByTestId("thread-center-header")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("thread-error-banner")).toHaveCount(0);
  });
});
