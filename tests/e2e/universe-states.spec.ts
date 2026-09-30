import { expect, test, type APIResponse } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

async function jsonOrThrow<T>(response: APIResponse, label: string): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

test.describe("Universe task panel host journey", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Universe-/);
  });

  test("opens one canonical task panel and preserves the complete panel lifecycle", async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const company = await seedCompany(request, `E2E-Universe-${Date.now()}`);
    const conversation = await jsonOrThrow<{ id: string }>(
      await request.post(`/api/companies/${company.id}/internal-agent/conversations`, {
        data: { title: "Universe acceptance" },
      }),
      "create Commander conversation",
    );
    const issue = await jsonOrThrow<{ id: string; title: string }>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          title: "Universe lifecycle task",
          description: "Exercise the real task panel through the dedicated Universe host.",
          status: "todo",
          priority: "medium",
          workMode: "standard",
        },
      }),
      "create task",
    );

    const attention = await jsonOrThrow<{
      checkpoint: { revision: number; lastAcknowledgedAt: string | null };
      checkpointToken: string;
    }>(await request.get(`/api/companies/${company.id}/universe/attention`), "read attention snapshot");
    expect(attention.checkpoint).toEqual({ revision: 0, lastAcknowledgedAt: null });
    const acknowledged = await jsonOrThrow<{ revision: number; lastAcknowledgedAt: string | null }>(
      await request.post(`/api/companies/${company.id}/universe/attention/checkpoint`, {
        data: { baseRevision: attention.checkpoint.revision, through: attention.checkpointToken },
      }),
      "finish attention review",
    );
    expect(acknowledged.revision).toBe(1);
    expect(acknowledged.lastAcknowledgedAt).not.toBeNull();

    await page.goto(
      `/${company.issuePrefix}/universe?conversation=${encodeURIComponent(conversation.id)}`,
    );
    await expect(page.getByRole("main", { name: "Universe canvas" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toHaveCount(0);

    await page.getByRole("button", { name: "Work" }).click();
    await page.getByRole("dialog", { name: "Work" }).getByRole("button", { name: issue.title }).click();
    const panel = page.getByRole("region", { name: issue.title });
    await expect(panel).toBeVisible();

    const beforeDrag = await panel.boundingBox();
    const header = page.getByLabel(`${issue.title} panel controls`);
    const headerBox = await header.boundingBox();
    if (!beforeDrag || !headerBox) throw new Error("Task panel did not expose measurable geometry");
    await page.mouse.move(headerBox.x + 32, headerBox.y + 16);
    await page.mouse.down();
    await page.mouse.move(headerBox.x + 92, headerBox.y + 56, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await panel.boundingBox())?.x).not.toBe(beforeDrag.x);

    const beforeResize = await panel.boundingBox();
    if (!beforeResize) throw new Error("Task panel did not expose resizable geometry");
    await header.focus();
    await header.press("Alt+Shift+ArrowRight");
    await expect.poll(async () => (await panel.boundingBox())?.width).toBeGreaterThan(beforeResize.width);

    await panel.getByRole("button", { name: "Pin panel" }).click();
    await expect(panel.getByRole("button", { name: "Unpin panel" })).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", { name: "Maximize panel" }).click();
    await expect(panel.getByRole("button", { name: "Restore panel" })).toBeVisible();
    await panel.getByRole("button", { name: "Restore panel" }).click();
    await panel.getByRole("button", { name: "Minimize panel" }).click();
    await expect(panel).toBeHidden();

    await page.getByRole("button", { name: "Open panels" }).click();
    await page.getByRole("dialog", { name: "Open panels" }).getByRole("button", { name: new RegExp(issue.title) }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close panel" }).click();
    await expect(panel).toHaveCount(0);

    await page.goto(
      `/${company.issuePrefix}/universe?conversation=${encodeURIComponent(conversation.id)}&task=${encodeURIComponent(issue.id)}`,
    );
    await expect(page.getByRole("region", { name: issue.title })).toBeVisible();
  });
});
