import { test, expect, type APIRequestContext } from "@playwright/test";
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";

/**
 * E2E: Image gallery navigation in TaskSlideOver (T8).
 *
 * T8 of the upstream resync added ImageGalleryModal.tsx and wired it into
 * TaskSlideOver.tsx so clicking an image attachment opens a fullscreen gallery.
 * Component-level tests (ui/src/__tests__/ImageGalleryModal.test.tsx) cover the
 * modal in isolation; this spec covers the full user-visible flow against
 * seeded data.
 *
 * Architecture note - seeding strategy:
 *   pnpm aoa onboard --yes --run leaves the instance EMPTY. We seed a
 *   company + a task + N image attachments in beforeEach via /api/companies/...
 *   /attachments (multipart). The task URL is /{issuePrefix}/issues/{id}
 *   (App.tsx:153), which opens the TaskSlideOver directly - no inbox detour
 *   needed.
 *
 * TaskSlideOver landmark:
 *   TaskSlideOver renders as role="dialog" with data-slot="sheet-content".
 *   ImageGalleryModal also uses role="dialog" - we filter the gallery dialog
 *   on the "(N / total)" counter text only present in its top bar.
 *
 * Image trigger:
 *   Per TaskSlideOver.tsx:1297, the trigger button has aria-label
 *   "Open <filename> in gallery".
 *
 * Phase B audit: docs/superpowers/plans/2026-04-27-resync-verification.md (Task 8)
 * P5c follow-up: docs/superpowers/plans/2026-04-28-resync-followup-fixes.md
 */

// 1x1 red PNG, base64
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

async function seedTaskWithImages(
  request: APIRequestContext,
  companyId: string,
  imageCount = 3,
): Promise<{ taskId: string }> {
  const issueRes = await request.post(`/api/companies/${companyId}/issues`, {
    data: { title: "E2E image gallery test task" },
  });
  if (!issueRes.ok()) {
    throw new Error(`seedTaskWithImages create issue failed: ${issueRes.status()}`);
  }
  const issue = (await issueRes.json()) as { id: string };

  for (let i = 1; i <= imageCount; i++) {
    const buffer = Buffer.from(PNG_BASE64, "base64");
    const upload = await request.post(
      `/api/companies/${companyId}/issues/${issue.id}/attachments`,
      {
        multipart: {
          file: {
            name: `e2e-image-${i}.png`,
            mimeType: "image/png",
            buffer,
          },
        },
      },
    );
    if (!upload.ok()) {
      throw new Error(`seedTaskWithImages upload ${i} failed: ${upload.status()}`);
    }
  }

  return { taskId: issue.id };
}

test.describe("Image gallery in TaskSlideOver (T8)", () => {
  let companyPrefix: string;
  let taskId: string;

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request);
    const company = await seedCompany(request);
    companyPrefix = company.issuePrefix;
    const seeded = await seedTaskWithImages(request, company.id, 3);
    taskId = seeded.taskId;
  });

  test("clicking an image attachment opens fullscreen gallery", async ({ page }) => {
    await page.goto(`/${companyPrefix}/issues/${taskId}`);

    // TaskSlideOver opens automatically on the issue route.
    const slideOver = page.locator('[data-slot="sheet-content"]');
    await expect(slideOver).toBeVisible({ timeout: 8_000 });
    await slideOver.getByRole("tab", { name: /work/i }).click();

    // Click the first image attachment to open the gallery.
    const galleryTrigger = slideOver
      .getByRole("button", { name: /open .* in gallery/i })
      .first();
    await expect(galleryTrigger).toBeVisible({ timeout: 5_000 });
    await galleryTrigger.click();

    // Gallery opens (Radix dialog with the "(N / total)" counter).
    const gallery = page
      .getByRole("dialog")
      .filter({ hasText: /\(\d+ \/ \d+\)/ });
    await expect(gallery).toBeVisible({ timeout: 3_000 });
    await expect(gallery.getByText(/\(1 \/ 3\)/)).toBeVisible();

    // ArrowRight advances to image 2.
    await page.keyboard.press("ArrowRight");
    await expect(gallery.getByText(/\(2 \/ 3\)/)).toBeVisible({ timeout: 2_000 });

    // ArrowLeft returns to image 1.
    await page.keyboard.press("ArrowLeft");
    await expect(gallery.getByText(/\(1 \/ 3\)/)).toBeVisible({ timeout: 2_000 });

    // Escape closes the gallery; the underlying TaskSlideOver stays open.
    await page.keyboard.press("Escape");
    await expect(gallery).toHaveCount(0, { timeout: 2_000 });
    await expect(slideOver).toBeVisible({ timeout: 2_000 });
  });

  test("clicking the curtain (outside the image) closes the gallery", async ({ page }) => {
    await page.goto(`/${companyPrefix}/issues/${taskId}`);

    const slideOver = page.locator('[data-slot="sheet-content"]');
    await expect(slideOver).toBeVisible({ timeout: 8_000 });
    await slideOver.getByRole("tab", { name: /work/i }).click();

    const galleryTrigger = slideOver
      .getByRole("button", { name: /open .* in gallery/i })
      .first();
    await expect(galleryTrigger).toBeVisible({ timeout: 5_000 });
    await galleryTrigger.click();

    const gallery = page
      .getByRole("dialog")
      .filter({ hasText: /\(\d+ \/ \d+\)/ });
    await expect(gallery).toBeVisible({ timeout: 3_000 });

    // Per ImageGalleryModal.tsx, the curtain div (data-testid="image-gallery-curtain")
    // calls onOpenChange(false) on click. Click near the top-left corner so we miss
    // the image (which stops propagation at the image element).
    const curtain = gallery.locator('[data-testid="image-gallery-curtain"]');
    await expect(curtain).toBeVisible({ timeout: 2_000 });
    await curtain.click({ position: { x: 10, y: 10 } });

    await expect(gallery).toHaveCount(0, { timeout: 2_000 });
  });
});
