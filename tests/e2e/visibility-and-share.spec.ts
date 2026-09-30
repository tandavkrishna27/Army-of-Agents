import { test, expect, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * E2E: Thread visibility — Company → Private flips persist + chip updates.
 *
 * The OriginCard (ui/src/components/threads/OriginCard.tsx) renders a 3-option
 * dropdown (Private / Department / Company). Selecting "Private" patches
 * `/api/companies/:cid/discussions/:id` with `{ visibility: "private" }` and
 * the chip label flips immediately.
 *
 * ── A note on the second-context check ──
 * The plan asks: "open the same thread URL in an anonymous incognito context
 * and assert a 401/403/404." That assertion is unfortunately a no-op against
 * AoA's e2e webServer because the playwright.config.ts boots the server in
 * `local_trusted` mode (AOA_DEPLOYMENT_MODE=local_trusted). In that mode:
 *
 *   - Every request from loopback is implicitly authenticated as
 *     `local-board` (server/src/routes/authz.ts:assertCompanyAccess returns
 *     immediately for `source === "local_implicit"`).
 *   - `local-board` is effectively founder (server/src/services/threads.ts:
 *     `canViewThread` returns true unconditionally for founders).
 *   - GET /companies/:cid/discussions/:id therefore returns 200 even for a
 *     private thread the "viewer" never participated in.
 *
 * In `authenticated` mode (multi-user) the assertion would hold — a fresh
 * browser context has no session cookie, /api/* would 401, and even after
 * sign-in a non-founder non-participant viewer would get a 404 (hide-don't-
 * 403 per the thread visibility rules). But Phase 1 ships local_trusted
 * deployment by default and the e2e harness mirrors that, so the test
 * verifies the persistence + chip flip and documents the access-control
 * gap as deferred to a multi-user e2e suite (tests/e2e/multi-user.spec.ts
 * is the placeholder).
 *
 * The "share token" toggle is a separate flow (founder-only share-link
 * generation). The plan doesn't strictly ask us to exercise it, but the
 * spec file is named "visibility-and-share" so we touch the
 * generate-share-link button as a smoke check that the
 * OriginCard share block renders without error.
 */

async function seedThread(
  request: APIRequestContext,
  companyId: string,
): Promise<{ id: string }> {
  const res = await request.post(`/api/companies/${companyId}/discussions`, {
    data: { title: `E2E visibility ${Date.now()}` },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`seedThread failed: ${res.status()} ${body}`);
  }
  return (await res.json()) as { id: string };
}

test.describe("Thread visibility + share", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Visibility-/);
  });

  test("changes visibility from Company to Private; chip updates", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(
      request,
      `E2E-Visibility-${Date.now()}`,
    );
    const thread = await seedThread(request, company.id);

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);

    // OriginCard should mount with default visibility "company".
    const visibilitySelector = page.getByTestId("visibility-selector").first();
    await expect(visibilitySelector).toBeVisible({ timeout: 10_000 });
    await expect(visibilitySelector).toHaveText(/company/i);

    // ── Open the dropdown, pick Private ──
    await visibilitySelector.click();
    const privateOption = page.getByTestId("visibility-option-private");
    await expect(privateOption).toBeVisible({ timeout: 5_000 });
    await privateOption.click();

    // ── Chip label updates after the optimistic mutation + server ack ──
    await expect(visibilitySelector).toHaveText(/private/i, { timeout: 10_000 });

    // ── Persisted in the DB: GET the thread row and verify visibility ──
    const res = await request.get(
      `/api/companies/${company.id}/discussions/${thread.id}`,
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { visibility: string };
    expect(body.visibility).toBe("private");

    // ── Second-context access check (documented gap) ──
    // In authenticated mode this would 401/404; in local_trusted (the e2e
    // default) loopback = trust boundary so a fresh browser context is also
    // founder. We assert what the runtime actually returns — 200 — and
    // record the gap. A future multi-user e2e suite (tests/e2e/multi-user.spec.ts,
    // already deferred in playwright.config.ts:testIgnore) is the right home
    // for the real RBAC assertion.
    const browser = page.context().browser();
    if (browser) {
      const fresh = await browser.newContext();
      try {
        const freshPage = await fresh.newPage();
        const freshRes = await freshPage.request.get(
          `/api/companies/${company.id}/discussions/${thread.id}`,
        );
        // In local_trusted the implicit local-board actor passes the founder
        // visibility check, so we expect 200 here. Documented gap above.
        expect(freshRes.status()).toBe(200);
      } finally {
        await fresh.close();
      }
    }
  });

  test("share-link block renders on OriginCard", async ({ page, request }) => {
    const company = await seedCompany(
      request,
      `E2E-Visibility-Share-${Date.now()}`,
    );
    const thread = await seedThread(request, company.id);

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);

    // The share block is part of OriginCard. We don't actually generate the
    // token here (that's an outbound network operation with no client-side
    // visible side-effect besides the URL update); we just smoke that the
    // founder-only CTA renders.
    await expect(page.getByTestId("share-link-block")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("generate-share-token")).toBeVisible();
  });
});
