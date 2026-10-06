import { expect, test } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

test.describe("discussion title lifecycle", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Discussion-Titles-/);
  });

  test("creates from the UI with a derived title, opens from Recently active, and can be renamed", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Discussion-Titles-${Date.now()}`);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(`/${company.issuePrefix}/discussions/legacy`);
    await page.getByRole("button", { name: "New Discussion" }).click();
    await page.getByPlaceholder(/Paste meeting notes/).fill("\n  Launch   the next product  \nExtra context");
    await page.getByRole("button", { name: "Start Discussion" }).click();

    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/discussions/[0-9a-f-]+$`));
    const discussionId = page.url().split("/").at(-1)!;
    const detail = page.getByTestId("thread-detail");
    await expect(detail.getByRole("heading", { name: "Launch the next product" }).first()).toBeVisible();
    await expect(detail.getByText("Extra context")).toBeVisible();

    await page.goto(`/${company.issuePrefix}/discussions`);
    const recentLink = page.getByTestId("threads-home-overview").getByRole("link", { name: /Launch the next product/ });
    await expect(recentLink).toBeVisible();
    await recentLink.click();
    await expect(page).toHaveURL(new RegExp(`/discussions/${discussionId}$`));
    await expect(page.getByTestId("thread-detail").getByText("Extra context")).toBeVisible();

    await page.getByTestId("thread-center-header").locator("h2").click();
    const renameInput = page.getByPlaceholder("Thread title");
    await expect(renameInput).toBeVisible();
    await renameInput.fill("Product launch plan");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("thread-center-header").getByRole("heading", { name: "Product launch plan" })).toBeVisible();

    await page.goto(`/${company.issuePrefix}/discussions`);
    await expect(page.getByTestId("threads-home-overview").getByRole("link", { name: /Product launch plan/ })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("renders and opens a legacy null-title discussion, then allows renaming it", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Discussion-Titles-${Date.now()}`);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const createResponse = await request.post(`/api/companies/${company.id}/discussions`, {
      data: {
        title: "Legacy discussion name",
        entry: { inputType: "paste", rawContent: "Legacy discussion body for the viewer." },
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    const created = await createResponse.json() as { id: string };
    const updateResponse = await request.patch(
      `/api/companies/${company.id}/discussions/${created.id}`,
      { data: { title: null } },
    );
    expect(updateResponse.ok()).toBeTruthy();
    expect((await updateResponse.json()).title).toBe("Untitled discussion");

    await page.goto(`/${company.issuePrefix}/discussions`);
    const recentLink = page.getByTestId("threads-home-overview").getByRole("link", { name: /Untitled discussion/ });
    await expect(recentLink).toBeVisible();
    await recentLink.click();
    await expect(page.getByTestId("thread-detail").getByText("Legacy discussion body for the viewer.")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("thread-center-header").getByRole("heading", { name: "Untitled discussion" })).toBeVisible();

    await page.getByTestId("thread-center-header").locator("h2").click();
    await page.getByPlaceholder("Thread title").fill("Recovered discussion");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("thread-center-header").getByRole("heading", { name: "Recovered discussion" })).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test("normalizes a blank API title consistently in create, list, and detail responses", async ({ request }) => {
    const company = await seedCompany(request, `E2E-Discussion-Titles-${Date.now()}`);
    const createResponse = await request.post(`/api/companies/${company.id}/discussions`, {
      data: { title: "   " },
    });
    expect(createResponse.ok()).toBeTruthy();
    const created = await createResponse.json() as { id: string; title: string };
    expect(created.title).toBe("Untitled discussion");

    const listResponse = await request.get(`/api/companies/${company.id}/discussions`);
    expect(listResponse.ok()).toBeTruthy();
    const listed = await listResponse.json() as { discussions: Array<{ id: string; title: string }> };
    expect(listed.discussions.find((discussion) => discussion.id === created.id)?.title)
      .toBe("Untitled discussion");

    const detailResponse = await request.get(`/api/companies/${company.id}/discussions/${created.id}`);
    expect(detailResponse.ok()).toBeTruthy();
    expect((await detailResponse.json()).title).toBe("Untitled discussion");
  });

  test("uses the fallback for an attachment-only opening entry", async ({ request }) => {
    const company = await seedCompany(request, `E2E-Discussion-Titles-${Date.now()}`);
    const assetResponse = await request.post(`/api/companies/${company.id}/assets/files`, {
      multipart: {
        file: {
          name: "notes.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("attachment-only discussion title test"),
        },
      },
    });
    expect(assetResponse.ok()).toBeTruthy();
    const asset = await assetResponse.json() as { assetId: string };

    const createResponse = await request.post(`/api/companies/${company.id}/discussions`, {
      data: {
        entry: {
          inputType: "write",
          rawContent: "",
          attachments: [{ assetId: asset.assetId }],
        },
      },
    });
    expect(createResponse.ok()).toBeTruthy();
    expect((await createResponse.json()).title).toBe("Untitled discussion");
  });

  test("shows a graceful create error and keeps the form usable", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Discussion-Titles-${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/discussions/legacy`);
    await page.getByRole("button", { name: "New Discussion" }).click();
    await page.getByPlaceholder(/Paste meeting notes/).fill("Content for a failed create");
    await page.route(`**/api/companies/${company.id}/discussions`, async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "test failure" }) });
      } else {
        await route.continue();
      }
    });

    await page.getByRole("button", { name: "Start Discussion" }).click();
    await expect(page.getByText("Failed to create discussion")).toBeVisible();
    await expect(page.getByPlaceholder(/Paste meeting notes/)).toHaveValue("Content for a failed create");
  });
});
