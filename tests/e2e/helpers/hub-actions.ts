import type { Locator, Page } from "@playwright/test";

/**
 * Click a control that triggers a hub-item mutation and wait for that mutation's
 * server response before continuing.
 *
 * Every hub mutation invalidates the ["hub-items", companyId] list query, which
 * rebuilds InboxHub's `accumulatedItems` state and remounts the list + viewer.
 * If the next locator interaction starts before that refetch settles, the remount
 * detaches the element mid-action and the test fast-fails (retries:0) — the
 * dominant inbox-hub flake. Letting the mutation response land shrinks the churn
 * window so the following assertion resolves against a settled tree.
 *
 * Safe against the resolve → undo → archive chain: the "Undo <action>" bar is a
 * standalone control in HubShell (not gated on list membership), so awaiting here
 * never removes a control the test still needs.
 *
 * Endpoints (see ui/src/api/hub-items.ts):
 *   - "state"  → PATCH /companies/:id/hub-items/:id/state  (mark-read, snooze, …)
 *   - "action" → POST  /companies/:id/hub-items/:id/action (resolve, archive, …)
 *   - "undo"   → POST  /companies/:id/hub-items/:id/undo
 */
export async function clickHubAction(
  page: Page,
  control: Locator,
  endpoint: "state" | "action" | "undo",
): Promise<void> {
  const method = endpoint === "state" ? "PATCH" : "POST";
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/hub-items/") &&
        response.url().includes(`/${endpoint}`) &&
        response.request().method() === method &&
        response.ok(),
    ),
    control.click(),
  ]);
}
