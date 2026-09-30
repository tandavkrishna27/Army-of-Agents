import { test, expect } from "@playwright/test";
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";

/**
 * E2E: Keyboard shortcut cheatsheet (T7).
 *
 * T7 of the upstream resync added a Radix Dialog cheatsheet that opens on
 * `?` keypress (outside text inputs). Component-level tests at
 * `ui/src/__tests__/KeyboardShortcutsCheatsheet.test.tsx` cover modal
 * rendering in isolation; this spec covers the user-visible flow.
 *
 * Architecture note — URL strategy:
 *   The keyboard hook (`useKeyboardShortcuts`) is mounted inside Layout.tsx,
 *   which wraps all routes under `/:companyPrefix/*`. The e2e webServer boots
 *   via `pnpm aoa onboard --yes --run` (playwright.config.ts), which leaves
 *   the instance EMPTY — no auto-seeded company. We seed one in beforeEach
 *   and navigate directly to `/{issuePrefix}/home` to land inside the
 *   Layout where the hook is active. (App.tsx's index route is `<Lobby />`
 *   which does not auto-redirect; CompanyRootRedirect exists but is unwired.)
 *
 * Section heading names are taken verbatim from SECTION_ORDER in
 * KeyboardShortcutsCheatsheet.tsx: ["Inbox", "Task detail", "Global"].
 * The DialogTitle text is "Keyboard shortcuts" (exact, lowercase 's').
 *
 * Phase B audit: docs/superpowers/plans/2026-04-27-resync-verification.md (Task 7)
 */

test.describe("Keyboard shortcut cheatsheet (T7)", () => {
  let companyPrefix: string;
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request);
    const company = await seedCompany(request);
    companyPrefix = company.issuePrefix;
  });

  test("? opens the cheatsheet from the home page (not in input)", async ({ page }) => {
    await page.goto(`/${companyPrefix}/home`);

    // Click a neutral spot to ensure no input has focus.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("?");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    await expect(
      dialog.getByRole("heading", { name: /keyboard shortcuts/i }),
    ).toBeVisible();
  });

  test("Escape closes the cheatsheet", async ({ page }) => {
    await page.goto(`/${companyPrefix}/home`);

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("?");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0, { timeout: 2_000 });
  });

  test("? does not open cheatsheet when typing in a textarea", async ({ page }) => {
    await page.goto(`/${companyPrefix}/home`);

    const composer = page.locator("textarea").first();
    const composerVisible = await composer
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    test.skip(
      !composerVisible,
      "No textarea visible on home — test data dependency, skipping",
    );

    await composer.focus();
    await page.keyboard.press("?");

    // The cheatsheet must NOT open when the user typed `?` in a textarea —
    // the keyboard hook bails on input targets (isKeyboardShortcutTextInputTarget).
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Cheatsheet shows all 3 sections (Inbox, Task detail, Global)", async ({ page }) => {
    await page.goto(`/${companyPrefix}/home`);

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("?");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    // Section headings from SECTION_ORDER in KeyboardShortcutsCheatsheet.tsx.
    await expect(dialog.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Task detail" }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Global" }),
    ).toBeVisible();
  });
});
