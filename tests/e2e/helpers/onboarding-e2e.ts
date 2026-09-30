import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Clear the local-board user's onboarding progress so a spec starts clean. */
export async function resetOnboarding(request: APIRequestContext): Promise<void> {
  const res = await request.delete("/api/test/onboarding-progress");
  if (!res.ok()) {
    throw new Error(`resetOnboarding failed: ${res.status()} ${await res.text().catch(() => "")}`);
  }
}

/**
 * Strict pre-spec isolation (Plan 1 P2 #12): reset progress + delete any
 * E2E-prefixed companies + assert ZERO remain, so a stale company can't be
 * reused instead of proving organization creation.
 */
export async function freshOnboardingState(request: APIRequestContext): Promise<void> {
  await resetOnboarding(request);
  const list = async () =>
    ((await (await request.get("/api/companies")).json()) as Array<{ id: string; name: string }>) ?? [];
  for (const c of await list()) {
    if (/^E2E-/i.test(c.name)) await request.delete(`/api/companies/${c.id}`).catch(() => {});
  }
  const remaining = (await list()).filter((c) => /^E2E-/i.test(c.name));
  expect(remaining, "stale E2E companies must be cleared before the spec").toHaveLength(0);
}

/** Click a step's primary control and wait for the next heading. */
export async function advanceStep(page: Page, buttonName: RegExp, nextHeading: RegExp): Promise<void> {
  await page.getByRole("button", { name: buttonName }).click();
  await page.getByRole("heading", { name: nextHeading }).waitFor({ state: "visible", timeout: 15_000 });
}

/**
 * Drive the founder's Human Operating Profile step (the same rich step the
 * invited journey uses): Name + Title + Timezone are required before Continue
 * enables. Does NOT click Continue — callers advance so they can screenshot
 * or assert first.
 */
export async function fillFounderProfileStep(page: Page, name = "E2E Founder"): Promise<void> {
  await expect(page.getByRole("heading", { name: /first,\s*you/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Title", { exact: true }).selectOption("Founder");
  await page.getByLabel("Timezone", { exact: true }).selectOption("UTC");
}

/**
 * Drive the founder's Create-Organization step (Phase 2 multi-tenant "tenant"
 * step, inserted between profile and the renamed company step): assert the
 * "Your organization" heading, fill the org name, and Continue. The company
 * step ("Your company") follows. Callers that only need to *reach* the org
 * step should assert the heading directly instead.
 */
export async function fillOrganizationStep(page: Page, name: string): Promise<void> {
  await expect(page.getByRole("heading", { name: /your organization/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("textbox").first().fill(name);
  await page.getByRole("button", { name: /continue/i }).click();
}
