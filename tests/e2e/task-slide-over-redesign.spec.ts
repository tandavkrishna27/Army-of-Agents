import { test, expect, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

async function createIssue(
  request: APIRequestContext,
  companyId: string,
  data: { title: string; description?: string; status?: string; priority?: string },
) {
  const res = await request.post(`/api/companies/${companyId}/issues`, { data });
  if (!res.ok()) throw new Error(`createIssue failed: ${res.status()} ${await res.text()}`);
  return (await res.json()) as { id: string; identifier?: string | null };
}

async function seedRedesignTask(request: APIRequestContext, companyId: string) {
  const blocker = await createIssue(request, companyId, {
    title: "Publish dependency brief",
    status: "todo",
    priority: "medium",
  });
  const task = await createIssue(request, companyId, {
    title: "Compact slide-over redesign seed task",
    description: "Long brief that should stay editable near the top without crowding metadata.",
    status: "blocked",
    priority: "high",
  });

  const dependency = await request.post(`/api/companies/${companyId}/issues/${task.id}/dependencies`, {
    data: { dependencyIssueId: blocker.id },
  });
  if (!dependency.ok()) throw new Error(`dependency seed failed: ${dependency.status()}`);

  const comment = await request.post(`/api/issues/${task.id}/comments`, {
    data: { body: "Seeded design comment for the overview preview." },
  });
  if (!comment.ok()) throw new Error(`comment seed failed: ${comment.status()}`);

  const upload = await request.post(`/api/companies/${companyId}/issues/${task.id}/attachments`, {
    multipart: {
      file: {
        name: "slide-over-proof.png",
        mimeType: "image/png",
        buffer: Buffer.from(PNG_BASE64, "base64"),
      },
    },
  });
  if (!upload.ok()) throw new Error(`attachment seed failed: ${upload.status()}`);

  return { taskId: task.id, blockerTitle: "Publish dependency brief" };
}

test.describe("Task slide-over compact redesign", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  let companyPrefix: string;
  let taskId: string;
  let blockerTitle: string;

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request);
    const company = await seedCompany(request);
    companyPrefix = company.issuePrefix;
    const seeded = await seedRedesignTask(request, company.id);
    taskId = seeded.taskId;
    blockerTitle = seeded.blockerTitle;
  });

  test("opens on Overview and keeps work artifacts behind the Work tab", async ({ page }) => {
    await page.goto(`/${companyPrefix}/issues/${taskId}`);

    const slideOver = page.locator('[data-slot="sheet-content"]');
    await expect(slideOver).toBeVisible({ timeout: 8_000 });
    const compactBox = await slideOver.boundingBox();
    expect(compactBox?.width ?? 0).toBeGreaterThan(680);

    await slideOver.getByRole("button", { name: /expand task panel/i }).click();
    await expect(slideOver).toHaveAttribute("data-size-mode", "wide");
    await expect
      .poll(async () => (await slideOver.boundingBox())?.width ?? 0)
      .toBeGreaterThan((compactBox?.width ?? 0) + 20);

    await expect(slideOver.getByRole("tab", { name: /overview/i })).toHaveAttribute("aria-selected", "true");
    await expect(slideOver.getByRole("tab", { name: /artifacts/i })).toHaveCount(0);
    await expect(slideOver.getByTestId("task-overview-tab")).toBeVisible();
    await expect(slideOver.getByTestId("task-overview-properties")).toBeVisible();
    await expect(slideOver.getByText(/latest comment/i)).toBeVisible();
    await expect(slideOver.getByText(/Seeded design comment/)).toBeVisible();
    await expect(slideOver.getByText(/waiting for 1 dependency task/i)).toBeVisible();

    await slideOver.getByRole("tab", { name: /work/i }).click();
    await expect(slideOver.getByTestId("task-work-tab")).toBeVisible();
    await expect(slideOver.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expect(slideOver.getByRole("heading", { name: "Workspace" })).toBeVisible();
    await expect(slideOver.getByRole("heading", { name: "Dependencies" })).toBeVisible();
    await expect(slideOver.getByRole("heading", { name: "Artifacts & outputs" })).toBeVisible();
    await expect(slideOver.getByText(blockerTitle)).toBeVisible();
    await expect(slideOver.getByText("Attachments")).toBeVisible();

    const galleryTrigger = slideOver.getByRole("button", { name: /open .* in gallery/i });
    await expect(galleryTrigger).toBeVisible();
    await galleryTrigger.click();
    await expect(page.getByRole("dialog").filter({ hasText: /\(1 \/ 1\)/ })).toBeVisible();
    await page.keyboard.press("Escape");

    await slideOver.getByRole("tab", { name: /comments/i }).click();
    await expect(slideOver.getByText("Seeded design comment for the overview preview.")).toBeVisible();
  });
});
