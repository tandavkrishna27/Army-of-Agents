import { test, expect } from "@playwright/test";

/**
 * E2E: Backups tab in Instance Settings (T23).
 *
 * T23 of the upstream resync re-enabled the Backups section in
 * InstanceSettingsPage by adding it back to the settings nav and removing
 * the v1.0 unmount comment. BackupsTab.tsx was already complete with a
 * RetentionPresetGroup UI for Daily / Weekly / Monthly retention selectors.
 *
 * Phase B test-gap audit found no e2e coverage for this. Component-level
 * tests (ui/src/__tests__/BackupsTab.test.tsx) cover the component in
 * isolation; this spec covers the user-visible flow: the nav item appears in
 * the sidebar, is clickable, and all three RetentionPresetGroup panels render
 * with correct headings and preset button labels.
 *
 * Architecture note — UI overhaul (May 2026):
 *   InstanceSettingsPage was refactored to use SecondarySidebar navigation
 *   instead of a <Tabs> component with <TabsTrigger> elements. The sidebar
 *   items are <button type="button"> elements, not role="tab". Active section
 *   is driven by the ?tab= URL search param. Tests that just need the Backups
 *   content visible navigate directly to /instance/settings?tab=backups.
 *
 * Rendering notes from BackupsTab.tsx:
 *   - Each RetentionPresetGroup renders a <div role="radiogroup" aria-label="X retention">
 *     where X is "Daily" / "Weekly" / "Monthly".
 *   - Individual preset values are rendered as <button role="radio"> children
 *     containing a <div> with text produced by formatLabel:
 *       Daily:   "${n} days"     (n in [3, 7, 14])
 *       Weekly:  "1 week" | "${n} weeks"   (n in [1, 2, 4])
 *       Monthly: "1 month" | "${n} months" (n in [1, 3, 6])
 *   - The outer <h4> labels use uppercase CSS but text content is "Daily" /
 *     "Weekly" / "Monthly" (mixed case in source).
 *
 * Architecture note:
 *   e2e server runs in AOA_DEPLOYMENT_MODE=local_trusted — no auth barrier.
 *   InstanceSettingsPage is not company-scoped (route /instance/settings,
 *   no useCompany call, BackupsTab consumes only generalQuery.data), so no
 *   company seed is needed in beforeEach.
 *
 * Phase B audit: docs/superpowers/plans/2026-04-27-resync-verification.md (Task 9)
 */

test.describe("Backups tab in Instance Settings (T23)", () => {
  test("Backups tab is visible in Instance Settings nav and is selectable", async ({ page }) => {
    await page.goto("/instance/settings");

    // The Backups nav item is a sidebar button (SecondarySidebar), not role="tab".
    const backupsItem = page.getByRole("button", { name: /^backups$/i });
    await expect(backupsItem).toBeVisible({ timeout: 10_000 });

    // Clicking should navigate to the Backups section (URL updates to ?tab=backups).
    await backupsItem.click();
    await expect(page).toHaveURL(/[?&]tab=backups/, { timeout: 5_000 });
  });

  test("BackupsTab renders the 'Backup retention' section heading after selecting the tab", async ({ page }) => {
    await page.goto("/instance/settings?tab=backups");

    // The BackupsTab renders an <h2> "Backups" and an <h3> "Backup retention".
    // The h3 is inside a card section and is a reliable content anchor.
    await expect(
      page.getByRole("heading", { name: /backup retention/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Daily, Weekly, Monthly radiogroup panels all render after selecting the tab", async ({ page }) => {
    await page.goto("/instance/settings?tab=backups");

    // RetentionPresetGroup renders:
    //   <div role="radiogroup" aria-label="Daily retention"> ... </div>
    //   <div role="radiogroup" aria-label="Weekly retention"> ... </div>
    //   <div role="radiogroup" aria-label="Monthly retention"> ... </div>
    await expect(
      page.getByRole("radiogroup", { name: /daily retention/i }),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      page.getByRole("radiogroup", { name: /weekly retention/i }),
    ).toBeVisible();

    await expect(
      page.getByRole("radiogroup", { name: /monthly retention/i }),
    ).toBeVisible();
  });

  test("Daily retention preset buttons show '3 days', '7 days', '14 days'", async ({ page }) => {
    await page.goto("/instance/settings?tab=backups");

    const dailyGroup = page.getByRole("radiogroup", { name: /daily retention/i });
    await expect(dailyGroup).toBeVisible({ timeout: 5_000 });

    // DAILY_RETENTION_PRESETS = [3, 7, 14] as const
    // formatLabel = (n) => `${n} days`
    await expect(dailyGroup.getByRole("radio", { name: /3 days/i })).toBeVisible();
    await expect(dailyGroup.getByRole("radio", { name: /7 days/i })).toBeVisible();
    await expect(dailyGroup.getByRole("radio", { name: /14 days/i })).toBeVisible();
  });

  test("Weekly retention preset buttons show '1 week', '2 weeks', '4 weeks'", async ({ page }) => {
    await page.goto("/instance/settings?tab=backups");

    const weeklyGroup = page.getByRole("radiogroup", { name: /weekly retention/i });
    await expect(weeklyGroup).toBeVisible({ timeout: 5_000 });

    // WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const
    // formatLabel = (n) => n === 1 ? "1 week" : `${n} weeks`
    await expect(weeklyGroup.getByRole("radio", { name: /^1 week$/i })).toBeVisible();
    await expect(weeklyGroup.getByRole("radio", { name: /^2 weeks$/i })).toBeVisible();
    await expect(weeklyGroup.getByRole("radio", { name: /^4 weeks$/i })).toBeVisible();
  });

  test("Monthly retention preset buttons show '1 month', '3 months', '6 months'", async ({ page }) => {
    await page.goto("/instance/settings?tab=backups");

    const monthlyGroup = page.getByRole("radiogroup", { name: /monthly retention/i });
    await expect(monthlyGroup).toBeVisible({ timeout: 5_000 });

    // MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const
    // formatLabel = (n) => n === 1 ? "1 month" : `${n} months`
    await expect(monthlyGroup.getByRole("radio", { name: /^1 month$/i })).toBeVisible();
    await expect(monthlyGroup.getByRole("radio", { name: /^3 months$/i })).toBeVisible();
    await expect(monthlyGroup.getByRole("radio", { name: /^6 months$/i })).toBeVisible();
  });

  test("Default selected preset (7 days) shows aria-checked='true' on the Daily group", async ({ page }) => {
    await page.goto("/instance/settings?tab=backups");

    const dailyGroup = page.getByRole("radiogroup", { name: /daily retention/i });
    await expect(dailyGroup).toBeVisible({ timeout: 5_000 });

    // DEFAULT_BACKUP_RETENTION.dailyDays = 7
    // The active button has aria-checked="true" (set directly on the <button role="radio">).
    const sevenDayButton = dailyGroup.getByRole("radio", { name: /7 days/i });
    await expect(sevenDayButton).toHaveAttribute("aria-checked", "true");

    // The non-default presets must be unchecked.
    await expect(dailyGroup.getByRole("radio", { name: /3 days/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await expect(dailyGroup.getByRole("radio", { name: /14 days/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });
});
