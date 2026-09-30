import { expect, test } from "@playwright/test";

test.describe("workspace git safety", () => {
  test("commit and push safety dialog can cancel or continue when an active run exists", async ({ page }) => {
    test.fixme(
      true,
      "Needs deterministic e2e seeding for an execution workspace with dirty git status, ahead commits, a linked task, and an active heartbeat run.",
    );

    await page.goto("/workspaces/ws-seeded-git-safety");

    await page.getByText("Commit...").click();
    await page.getByTestId("commit-message-input").fill("Commit from e2e");
    await page.getByTestId("commit-btn").click();
    await expect(page.getByTestId("workspace-safety-dialog")).toBeVisible();
    await page.getByRole("button", { name: /cancel/i }).click();
    await expect(page.getByTestId("workspace-safety-dialog")).toBeHidden();

    await page.getByTestId("push-btn").click();
    await expect(page.getByTestId("workspace-safety-dialog")).toBeVisible();
    await page.getByRole("button", { name: /continue anyway/i }).click();
    await expect(page.getByTestId("workspace-safety-dialog")).toBeHidden();
  });

  test("create PR safety dialog appears for an incomplete task and allows continue", async ({ page }) => {
    test.fixme(
      true,
      "Needs deterministic e2e seeding for a GitHub-ready execution workspace linked to a non-terminal task.",
    );

    await page.goto("/workspaces/ws-seeded-git-safety");

    await page.getByTestId("create-pr-btn").click();
    await page.getByTestId("pr-submit").click();
    await expect(page.getByTestId("workspace-safety-dialog")).toBeVisible();
    await expect(page.getByText(/task is not complete/i)).toBeVisible();
    await page.getByRole("button", { name: /continue anyway/i }).click();
    await expect(page.getByTestId("workspace-safety-dialog")).toBeHidden();
  });

  test("existing PR state shows the PR link instead of a second create flow", async ({ page }) => {
    test.fixme(
      true,
      "Needs deterministic e2e seeding for an execution workspace whose metadata already contains pr metadata.",
    );

    await page.goto("/workspaces/ws-seeded-existing-pr");

    await expect(page.getByTestId("pr-link")).toBeVisible();
    await expect(page.getByTestId("create-pr-btn")).toBeHidden();
    await page.getByTestId("pr-link").click();
  });
});
