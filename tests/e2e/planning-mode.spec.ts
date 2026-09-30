import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * E2E: Planning mode dispatch gate (SKIP_LLM mode).
 *
 * AoA's Planning mode tasks are not dispatched to the heartbeat system
 * on creation. They are added to the board in "todo" status, awaiting
 * explicit user action (e.g., "Start working" → transitions to "in_progress").
 *
 * This smoke validates:
 * 1. Creating a task with "Planning" work mode shows the Planning pill
 * 2. Planning-mode task does NOT trigger an automatic heartbeat run
 *    (status remains "todo" instead of auto-advancing to "in_progress")
 *
 * The second test is LLM-dependent because it must wait for a heartbeat
 * that should NOT occur. Set AOA_E2E_SKIP_LLM=false to enable this assertion
 * (requires ANTHROPIC_API_KEY and a running heartbeat system).
 */

const SKIP_LLM = process.env.AOA_E2E_SKIP_LLM !== "false";

test.describe("planning mode dispatch gate", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Planning-/);
  });

  async function openSeededIssues(page: Page, request: APIRequestContext) {
    const company = await seedCompany(request, `E2E-Planning-${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/issues`);
  }

  function taskTitleText(page: Page, title: string) {
    return page.locator("span", { hasText: title }).first();
  }

  async function createPlanningTask(page: Page, title: string) {
    await expect(page).toHaveTitle(/\w+/);

    const newTaskButton = page.getByRole("button", { name: /^new task$/i }).first();
    await expect(newTaskButton).toBeVisible({ timeout: 5_000 });
    await newTaskButton.click();

    const dialog = page.getByRole("dialog", { name: /^new task$/i });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const titleInput = dialog.getByRole("textbox", { name: /^task title$/i });
    await expect(titleInput).toBeVisible({ timeout: 5_000 });
    await titleInput.fill(title);

    const modeButton = dialog.getByRole("button", { name: /^standard$/i });
    await expect(modeButton).toBeVisible({ timeout: 5_000 });
    await modeButton.click();

    const planningOption = page.getByRole("button", { name: /^planning$/i }).last();
    await expect(planningOption).toBeVisible({ timeout: 5_000 });
    await planningOption.click();
    await expect(dialog.getByRole("button", { name: /^planning$/i })).toBeVisible({ timeout: 5_000 });

    const createButton = dialog.getByRole("button", { name: /^create task$/i });
    await expect(createButton).toBeVisible({ timeout: 5_000 });
    await expect(createButton).toBeEnabled({ timeout: 5_000 });
    await createButton.click();

    const taskTitle = taskTitleText(page, title);
    await expect(taskTitle).toBeVisible({ timeout: 5_000 });

    // Verify the "Planning" pill is visible (indicating the work mode was set).
    // This may be rendered as a badge, chip, or label near the task title.
    await expect(page.getByText("Planning").first()).toBeVisible({ timeout: 5_000 });
  }

  test("creating a planning-mode task shows Planning pill", async ({ page, request }) => {
    await openSeededIssues(page, request);
    await createPlanningTask(page, "Planning review: architecture");
  });

  test("planning-mode task does not trigger a heartbeat run", async ({ page, request }) => {
    test.skip(SKIP_LLM, "skipped unless AOA_E2E_SKIP_LLM=false");

    await openSeededIssues(page, request);
    const title = "Planning review: heartbeat gate";
    await createPlanningTask(page, title);

    const taskTitle = taskTitleText(page, title);
    await expect(taskTitle).toBeVisible({ timeout: 5_000 });

    // Locate the task row and check its status is "todo" (not "in_progress").
    // The status may be shown as a badge, label, or column in a list/board view.
    const taskRow = page
      .locator(`text=${title}`)
      .locator("..")
      .locator("..");
    const statusElement = taskRow.locator("text=todo");
    await expect(statusElement).toBeVisible({ timeout: 5_000 });

    // Wait briefly to ensure no heartbeat dispatch was triggered.
    // If a heartbeat run occurred, the task would transition to "in_progress".
    // This sleep is a simple heuristic; in production, monitor the heartbeat
    // run event log or query the task history.
    await page.waitForTimeout(2000);

    // Re-check the status — it should still be "todo".
    await expect(statusElement).toBeVisible({ timeout: 5_000 });
  });
});

// Keep the SKIP_LLM branch referenced so future specs can gate heartbeat
// assertions off it without re-introducing the import.
void SKIP_LLM;
