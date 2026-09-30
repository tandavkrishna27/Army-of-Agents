import { test, expect } from "@playwright/test";

/**
 * E2E: Sign-out flow (T6) + local_trusted gate (P1 fix, 2026-04-28).
 *
 * The Sign out section is hidden when deploymentMode === 'local_trusted'
 * (the e2e webServer mode). In 'authenticated' mode the section renders
 * and the button calls Better-Auth.
 *
 * Phase B audit: docs/superpowers/plans/2026-04-27-resync-verification.md (Task 6)
 * P1 follow-up:  docs/superpowers/plans/2026-04-28-resync-followup-fixes.md
 */

test.describe("Sign-out flow (T6 + P1 gate)", () => {
  test(
    "Sign out section is hidden in local_trusted mode (P1 gate)",
    async ({ page }) => {
      // The e2e webServer runs in AOA_DEPLOYMENT_MODE=local_trusted.
      // Pin the gate-input resolution explicitly: the section only hides
      // after healthQuery returns, so wait for that response before the
      // absence assertions to remove the race against generalQuery.
      const healthResponse = page.waitForResponse(
        (r) => r.url().endsWith("/api/health") && r.status() === 200,
      );
      await page.goto("/instance/settings");
      await healthResponse;

      const generalTab = page.getByRole("tab", { name: /general/i });
      if (await generalTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const isSelected = await generalTab.getAttribute("aria-selected");
        if (isSelected !== "true") {
          await generalTab.click();
        }
      }

      // Wait for the general tab body to render so we know the page settled.
      await expect(
        page.getByRole("heading", { name: /keyboard shortcuts/i }),
      ).toBeVisible({ timeout: 10_000 });

      // The Sign out section must NOT be present in local_trusted mode.
      await expect(
        page.getByRole("heading", { name: "Sign out", level: 2 }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /sign out/i }),
      ).toHaveCount(0);
    },
  );

  test(
    "/api/health reports deploymentMode='local_trusted' for the e2e env",
    async ({ request }) => {
      // Pair check so a future env change doesn't silently break the gate test.
      const res = await request.get("/api/health");
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { deploymentMode?: string };
      expect(body.deploymentMode).toBe("local_trusted");
    },
  );
});
