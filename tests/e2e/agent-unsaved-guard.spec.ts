import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * E2E — Global unsaved-changes guard (Follow-up #1).
 *
 * Proves the ONE global UnsavedChangesProvider/useBlocker in a real browser:
 *  - dirty + sidebar <Link> → "Discard unsaved changes?" dialog; Cancel stays, Discard leaves
 *  - dirty + browser Back (history.back) → the same dialog (the jsdom-impossible case)
 *  - clean nav → no dialog, navigates immediately
 *
 * Self-skips on Windows-without-DATABASE_URL via the config's testMatch
 * (embedded-postgres can't start as runneradmin). Required gate on Linux CI.
 */

async function seedWorkerAgent(request: APIRequestContext, companyId: string) {
  const res = await request.post(`/api/companies/${companyId}/agents`, {
    data: {
      name: "Guard E2E Agent",
      role: "general",
      title: "Guard E2E Agent",
      adapterType: "claude_local",
    },
  });
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`seedWorkerAgent failed: ${res.status()} ${body}`);
  }
  return (await res.json()) as { id: string; urlKey?: string };
}

async function openDirtyConfig(page: Page, request: APIRequestContext) {
  const company = await seedCompany(request, `E2E-Guard-${Date.now()}`);
  const agent = await seedWorkerAgent(request, company.id);
  const ref = agent.urlKey ?? agent.id;
  await page.goto(`/${company.issuePrefix}/agents/${ref}/configure`);
  const nameInput = page.getByTestId("agent-config-name-input");
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  // Make the Config form dirty (immediate commit on each keystroke).
  await nameInput.fill("Guard E2E Agent EDITED");
  // Wait until the unsaved-changes state has armed (the action bar reflects
  // configDirty via data-dirty) before any navigation — the dirty flag
  // propagates through a React effect that registers the global guard, so a
  // navigation fired before it settles would slip past unblocked.
  await expect(page.getByTestId("agent-detail-action-bar")).toHaveAttribute("data-dirty", "true");
  return { company, ref, nameInput };
}

test.describe("global unsaved-changes guard", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Guard-/);
  });

  test("dirty + sidebar <Link> + Cancel → stays on the agent page, edit intact", async ({ page, request }) => {
    const { ref, nameInput } = await openDirtyConfig(page, request);
    await page.getByRole("link", { name: /^Tasks$/ }).click();
    // Global confirm dialog appears; URL has NOT changed.
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/agents/${ref}/configure`));
    await expect(nameInput).toHaveValue("Guard E2E Agent EDITED");
  });

  test("dirty + sidebar <Link> + Discard → navigation proceeds, edit gone", async ({ page, request }) => {
    const { ref } = await openDirtyConfig(page, request);
    await page.getByRole("link", { name: /^Tasks$/ }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole("button", { name: "Discard & leave" }).click();
    // Navigated away from the agent page to /issues (Tasks).
    await expect(page).toHaveURL(/\/issues(\b|\/|\?|$)/, { timeout: 5_000 });
    await expect(page).not.toHaveURL(new RegExp(`/agents/${ref}/configure`));
  });

  test("dirty + browser Back → the confirm dialog appears (jsdom can't prove this)", async ({ page, request }) => {
    // Arrive at /configure from a real prior history entry so Back has a target.
    const company = await seedCompany(request, `E2E-Guard-${Date.now()}`);
    const agent = await seedWorkerAgent(request, company.id);
    const ref = agent.urlKey ?? agent.id;
    await page.goto(`/${company.issuePrefix}/agents/${ref}`); // Overview (history entry #1)
    await page.getByRole("tab", { name: "Config" }).click(); // → /configure (history entry #2)
    const nameInput = page.getByTestId("agent-config-name-input");
    await expect(nameInput).toBeVisible({ timeout: 15_000 });
    await nameInput.fill("Back-button dirty edit");
    // Wait until the guard is armed before navigating (the dirty flag registers
    // through a React effect; see openDirtyConfig).
    await expect(page.getByTestId("agent-detail-action-bar")).toHaveAttribute("data-dirty", "true");
    // Simulate the browser BACK BUTTON via history.back(): it fires the same
    // History-API popstate traversal the real button does, which the SPA's
    // single useBlocker intercepts. Playwright's page.goBack() instead drives a
    // CDP-level navigation that bypasses the popstate path, so the in-app blocker
    // never sees it. Verified live via /browse against a real instance:
    // history.back() raises the dialog AND holds the URL on /configure;
    // page.goBack() does neither. (Cancel keeps the edit; "Discard & leave"
    // proceeds to Overview — both confirmed live.)
    await page.evaluate(() => window.history.back());
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(dialog.getByText("Discard unsaved changes?")).toBeVisible();
    // Cancel keeps us on /configure with the edit intact.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${ref}/configure`));
    await expect(nameInput).toHaveValue("Back-button dirty edit");

    // Now exercise the popstate-PROCEED path (proceeding a POP is handled
    // differently by React Router than a PUSH, and is where the historical
    // duplicate-entry bug interacted). The edit is still dirty, so a second
    // browser Back re-raises the dialog; "Discard & leave" must traverse Back to
    // Overview.
    await page.evaluate(() => window.history.back());
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole("button", { name: "Discard & leave" }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${ref}(?:$|\\?)`), { timeout: 5_000 });
    await expect(page).not.toHaveURL(/\/configure/);
  });

  test("clean (no edits) + sidebar nav → no dialog, navigates immediately", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Guard-${Date.now()}`);
    const agent = await seedWorkerAgent(request, company.id);
    const ref = agent.urlKey ?? agent.id;
    await page.goto(`/${company.issuePrefix}/agents/${ref}/configure`);
    await expect(page.getByTestId("agent-config-name-input")).toBeVisible({ timeout: 15_000 });
    // Do NOT edit anything — form is clean.
    await page.getByRole("link", { name: /^Tasks$/ }).click();
    await expect(page).toHaveURL(/\/issues(\b|\/|\?|$)/, { timeout: 5_000 });
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  });

  test("agent-detail tab nav pushes ONE history entry (browser Back returns in a single press)", async ({ page, request }) => {
    // Regression: Radix Tabs' default activationMode="automatic" fired the tab's
    // onValueChange on BOTH focus and click, so the tab's navigate() ran twice →
    // a duplicate history entry → the browser Back button was a no-op on the first
    // press (the unsaved-guard dialog only fired on the 2nd press). Fixed with
    // activationMode="manual" on the agent-detail <Tabs>. Verified live via /browse.
    // No unsaved edits here — this isolates the history-entry count from the guard.
    const company = await seedCompany(request, `E2E-Guard-${Date.now()}`);
    const agent = await seedWorkerAgent(request, company.id);
    const ref = agent.urlKey ?? agent.id;
    await page.goto(`/${company.issuePrefix}/agents/${ref}`); // Overview
    await page.getByRole("tab", { name: "Config" }).click(); // → /configure (must be ONE entry)
    await expect(page).toHaveURL(new RegExp(`/agents/${ref}/configure`));
    // A single browser Back must return to Overview — not stay on a duplicate /configure.
    await page.evaluate(() => window.history.back());
    await expect(page).toHaveURL(new RegExp(`/agents/${ref}(?:$|\\?)`), { timeout: 5_000 });
    await expect(page).not.toHaveURL(/\/configure/);
  });
});
