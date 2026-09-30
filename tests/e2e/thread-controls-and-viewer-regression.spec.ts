import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

type Company = { id: string; name: string; issuePrefix: string };
type ScopeVersionDetail = {
  id: string;
  items: Array<{ id: string; kind: string; title: string }>;
};

test.describe("thread controls and viewer regressions", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Thread-Controls-/);
  });

  test("archives and unarchives a thread through the user-facing controls", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Thread-Controls-${Date.now()}`);
    const threadTitle = `Archive control ${Date.now()}`;

    await page.goto(`/${company.issuePrefix}/discussions`);
    await createThreadFromUi(page, threadTitle, "Archive and unarchive this thread from the visible UI.");
    const threadId = page.url().match(/\/discussions\/([^/?#]+)/)?.[1];
    expect(threadId).toBeTruthy();

    await page.getByRole("button", { name: `${threadTitle} actions` }).click({ force: true });
    await page.getByRole("menuitem", { name: /^archive thread$/i }).click();
    const archiveDialog = page.getByRole("dialog", { name: /^archive thread$/i });
    await expect(archiveDialog).toBeVisible({ timeout: 10_000 });
    await archiveDialog.getByRole("button", { name: /^archive$/i }).click();
    await expect(archiveDialog).toBeHidden({ timeout: 10_000 });

    await page.goto(`/${company.issuePrefix}/discussions`);
    const threadRailRow = page.getByTestId(`thread-rail-row-${threadId}`);
    await expect(threadRailRow.getByRole("link", { name: threadTitle })).toBeVisible({ timeout: 10_000 });
    await threadRailRow.getByRole("button", { name: `${threadTitle} actions` }).click({ force: true });
    await page.getByRole("menuitem", { name: /^unarchive thread$/i }).click();
    await expect(threadRailRow.getByRole("link", { name: threadTitle })).toBeVisible({ timeout: 10_000 });
  });

  test("updates autonomy dropdown and closes it on outside click", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Thread-Controls-${Date.now()}`);
    const thread = await seedThreadWithEntries(request, company.id, `Autonomy control ${Date.now()}`);

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByRole("heading", { name: thread.title }).first()).toBeVisible({ timeout: 10_000 });

    const header = page.getByTestId("thread-center-header");
    const autonomyButton = header.getByRole("button", { name: /change autonomy/i });
    await autonomyButton.click();
    await expect(page.getByText("Autonomy", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("menuitem", { name: /Manual/i }).click();
    await expect(header.getByRole("button", { name: /change autonomy/i })).toContainText("Manual", { timeout: 10_000 });

    await autonomyButton.click();
    await expect(page.getByText("Autonomy", { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.mouse.click(8, 8);
    await expect(page.getByRole("menu")).toBeHidden({ timeout: 10_000 });
  });

  test("keeps draft task viewer actions visible after common desktop resize states", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Thread-Controls-${Date.now()}`);
    const thread = await seedThreadWithEntries(request, company.id, `Viewer resize ${Date.now()}`);
    const scope = await createScopeDraft(request, company.id, thread.id);
    const taskItem = scope.items.find((item) => item.kind === "task_proposal");
    expect(taskItem, "scope draft should include a task proposal").toBeTruthy();

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByRole("heading", { name: thread.title }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("center-tab-scope").click();
    await page
      .getByTestId(`scope-version-card-${taskItem!.id}`)
      .getByRole("button", { name: /^review task$/i })
      .click();
    await expect(page.getByTestId("thread-draft-task-workbench")).toBeVisible({ timeout: 10_000 });

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("button", { name: /^create task$/i })).toBeVisible();
    await expect(page.getByText("Scope handoff")).toBeVisible();

    const resizeHandle = page.getByRole("separator", { name: /resize viewer/i });
    const resizeBox = await resizeHandle.boundingBox();
    expect(resizeBox, "viewer resize handle should be measurable").toBeTruthy();
    await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBox!.x - 360, resizeBox!.y + resizeBox!.height / 2);
    await page.mouse.up();
    await expect(page.getByRole("button", { name: /^create task$/i })).toBeVisible();
    await expect(page.getByText("Scope handoff")).toBeVisible();

    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.getByRole("button", { name: /^create task$/i })).toBeVisible();
    await expect(page.getByText("Scope handoff")).toBeVisible();
  });
});

async function createThreadFromUi(page: Page, title: string, firstMessage: string) {
  await page.getByRole("button", { name: /^new thread$/i }).first().click();
  const dialog = page.getByRole("dialog", { name: /^new thread$/i });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.locator("#thread-title").fill(title);
  await dialog.locator("#thread-description").fill(firstMessage);
  await dialog.getByRole("button", { name: /^create thread$/i }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });
  await page.getByText(title).first().click();
  await expect(page.getByRole("heading", { name: title }).first()).toBeVisible({ timeout: 10_000 });
}

async function seedThreadWithEntries(
  request: APIRequestContext,
  companyId: string,
  title: string,
): Promise<{ id: string; title: string }> {
  const thread = await jsonOrThrow<{ id: string; title: string }>(
    await request.post(`/api/companies/${companyId}/discussions`, { data: { title } }),
    "create thread",
  );
  for (const rawContent of [
    "Scope should cover the whole conversation before work is assigned.",
    "Create a task proposal and memory candidate that preserve the decision.",
  ]) {
    await jsonOrThrow(
      await request.post(`/api/companies/${companyId}/discussions/${thread.id}/entries`, {
        data: { inputType: "write", rawContent },
      }),
      "post thread entry",
    );
  }
  return thread;
}

async function createScopeDraft(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
): Promise<ScopeVersionDetail> {
  const draft = await jsonOrThrow<{ version: { id: string } }>(
    await request.post(`/api/companies/${companyId}/discussions/${threadId}/scope-versions/draft`, {
      data: { mode: "generate" },
    }),
    "create scope draft",
  );
  return jsonOrThrow(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions/${draft.version.id}`),
    "get scope draft",
  );
}

async function jsonOrThrow<T = unknown>(res: APIResponse, label: string): Promise<T> {
  if (!res.ok()) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`${label} failed: ${res.status()} ${text}`);
  }
  return (await res.json()) as T;
}
