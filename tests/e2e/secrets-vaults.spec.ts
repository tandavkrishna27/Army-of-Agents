import { expect, test } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

test.describe("secrets vaults", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request);
  });

  test("creates an AWS vault and imports an external reference", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Test-Secrets-${Date.now()}`);

    await page.goto(`/${company.issuePrefix}/secrets`);
    await expect(page.getByRole("heading", { level: 2, name: /^Secrets\.$/ })).toBeVisible();

    await page.getByRole("button", { name: /^configure vault$/i }).first().click();
    await expect(page.getByRole("tab", { name: "Vault providers" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: /^configure aws vault$/i }).click();
    const vaultDialog = page.getByRole("dialog", { name: "AWS Secrets Manager" });
    await expect(vaultDialog).toBeVisible();
    await vaultDialog.getByRole("button", { name: /^save aws vault$/i }).click();
    await expect(page.getByText("Production AWS").first()).toBeVisible();

    await page.getByRole("tab", { name: "Inventory" }).click();
    await page.getByRole("button", { name: /^import from vault$/i }).click();
    await page.getByRole("button", { name: /^preview remote secrets$/i }).click();
    const row = page.getByRole("row").filter({ hasText: "OPENAI_API_KEY" });
    await expect(row).toBeVisible();
    await row.getByRole("checkbox").click();
    await page.getByRole("button", { name: /^import$/i }).last().click();

    const importDialog = page.getByRole("dialog", { name: "Import from vault" });
    await expect(importDialog.getByText("imported", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^done$/i }).click();
    await expect(page.getByText("OPENAI_API_KEY").first()).toBeVisible();
    await expect(page.getByText("External reference").first()).toBeVisible();
  });
});
