import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * E2E — Commander viewer geometry persistence.
 *
 * ── Redesigned layout (Phases 1–8) ────────────────────────────────────────────
 * The viewer no longer has its own rail. It is opened/closed exclusively via:
 *   • The chat-header "Open preview" toggle (data-testid="commander-open-preview").
 *   • Programmatically from chip-clicks, cockpit actions, reply pop-out, and
 *     live refs (all route through openPreview("right-panel")).
 *
 * Persistence: viewerCollapsed state is stored in localStorage under the key
 * "aoa:commander:viewer-collapsed" and restored on page load. Width is stored
 * via react-resizable-panels' own localStorage key (onLayoutChanged).
 *
 * This spec verifies:
 *   1. "Open preview" opens the viewer panel (commander-viewer-panel).
 *   2. The expanded state + panel width persist across reload.
 *   3. "Hide preview" closes the viewer; that collapsed state also persists.
 *   4. Opening preview collapses the Sessions sidebar to its rail (choreography).
 *   5. Closing preview restores the Sessions sidebar to its pre-open state.
 *
 * The component-level choreography logic (open → both rails; close → restore)
 * is unit-tested in openPreviewChoreography.test.ts. This spec covers the
 * persistence layer and full-stack wiring.
 *
 * Note on cockpit default: the cockpit starts collapsed to a rail by default
 * (localStorage key "aoa:commander:cockpit-collapsed" defaults to `true`).
 * To avoid brittleness, the choreography test expands it explicitly before
 * exercising the full collapse/restore round-trip.
 */

test.describe("Commander viewer geometry persistence", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-CmdGeom-/);
  });

  test("open preview + width persist across reload (global, per-user)", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-CmdGeom-${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/commander`);

    // Default state: viewer panel is NOT mounted; "Open preview" toggle is visible.
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("commander-open-preview")).toBeVisible({ timeout: 20_000 });

    // Open the viewer via the chat-header "Open preview" toggle.
    await page.getByTestId("commander-open-preview").click();
    const panel = page.getByTestId("commander-viewer-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // The resize handle is present once the viewer is open.
    await expect(page.locator("[data-separator]")).toBeVisible();

    // Capture the DEFAULT width first, then drag the handle LEFT to widen the
    // viewer panel. The separator is the chat↔viewer divider; dragging left
    // gives more space to the viewer (right panel).
    const widthAtDefault = await panel.evaluate((el) => el.clientWidth);
    const handle = page.locator("[data-separator]");
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
    }
    const widthBefore = await panel.evaluate((el) => el.clientWidth);
    // The drag MUST have materially widened the panel — otherwise the persistence
    // assertion below could pass trivially against an unchanged default width
    // (silent no-op if the handle wasn't hit or the move clamped to ~0).
    expect(widthBefore).toBeGreaterThan(widthAtDefault + 40);

    // Reload: expanded state + width restored from localStorage.
    await page.reload();
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const widthAfter = await panel.evaluate((el) => el.clientWidth);
    expect(Math.abs(widthAfter - widthBefore)).toBeLessThanOrEqual(8); // within a px or two

    // Close the viewer via the chat-header toggle (which now shows "Hide preview").
    // Use data-testid to avoid strict-mode collision with the ViewerTabs collapse button.
    await page.getByTestId("commander-open-preview").click();
    await expect(panel).toHaveCount(0);
    // Confirm no viewer rail (there is none in the new layout).
    await expect(page.getByTestId("commander-viewer-rail")).toHaveCount(0);

    // Reload: collapsed state persists — viewer still closed.
    await page.reload();
    await expect(page.getByTestId("commander-viewer-panel")).toHaveCount(0, {
      timeout: 20_000,
    });
    // "Open preview" toggle is back to its default closed state.
    await expect(page.getByTestId("commander-open-preview")).toBeVisible({ timeout: 20_000 });
  });

  test("choreography: opening preview collapses Sessions sidebar to rail; closing restores it", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-CmdGeom-Choreo-${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/commander`);

    // Wait for the page to settle.
    await expect(page.getByTestId("commander-open-preview")).toBeVisible({ timeout: 20_000 });

    // Sessions header is visible by default (expanded — default collapsed=false).
    await expect(page.getByTestId("commander-sessions-header")).toBeVisible({
      timeout: 10_000,
    });

    // Open preview via the chat-header toggle.
    await page.getByTestId("commander-open-preview").click();
    const panel = page.getByTestId("commander-viewer-panel");
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Sessions sidebar should collapse to its rail.
    await expect(
      page.getByRole("button", { name: "Expand chats sidebar" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("commander-sessions-header")).toHaveCount(0);

    // Close via the "Open preview" toggle (now showing "Hide preview").
    await page.getByTestId("commander-open-preview").click();
    await expect(panel).toHaveCount(0);

    // Sessions sidebar should be restored to expanded state.
    await expect(page.getByTestId("commander-sessions-header")).toBeVisible({
      timeout: 10_000,
    });
  });
});
