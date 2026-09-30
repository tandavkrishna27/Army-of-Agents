import { expect, type Locator, type Page } from "@playwright/test";

export function hubTabBody(page: Page): Locator {
  return page.getByRole("tabpanel");
}

export function hubActionBar(page: Page): Locator {
  return page.getByTestId("hub-action-bar");
}

export async function expectHubTabBody(page: Page) {
  await expect(hubTabBody(page)).toBeVisible();
}

export async function expectActiveHubTab(page: Page, name: RegExp | string) {
  await expect(page.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
}
