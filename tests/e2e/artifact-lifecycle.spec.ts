import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * Artifact Lifecycle Phase 1 (P1) e2e coverage.
 *
 * Exercises the shipped thread-level artifact surface:
 *  - An asset-backed artifact attached to a discussion entry renders an inline
 *    file chip (InlineArtifactCard → `artifact-file-chip`) with a working
 *    download link and a founder-gated archive/unarchive control.
 *  - Mock v2 (2026-07-16): the composer's File-artifact control was REMOVED —
 *    📎 plain attach is the only composer upload entry, and a guard test below
 *    asserts the control stays gone. Artifact creation lives outside composers
 *    (agents / MCP / API), covered by the chip test above.
 *
 * Founder gating note (load-bearing for the archive control): the e2e webServer
 * boots in local_trusted mode, where `ensureLocalTrustedBoardPrincipal`
 * (server/src/index.ts) seeds the `local-board` user as an `instance_admin`.
 * The team summary derives `instance_admin → founder`, so `useTeamAccess().role`
 * is "founder" and `canManageArtifacts` is true — the archive/unarchive testids
 * render. The server archive/unarchive routes additionally short-circuit on the
 * synthetic `local_implicit` actor, so the mutation succeeds.
 */

async function jsonOrThrow<T = unknown>(res: APIResponse, label: string): Promise<T> {
  if (!res.ok()) throw new Error(`${label} failed: ${res.status()} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}

/**
 * Seed an asset-backed artifact attached to a fresh thread entry. Mirrors the
 * `uploadFileArtifact` client composition: upload an asset, create an
 * asset-backed artifact, then post an entry that attaches the artifact.
 */
async function seedFileArtifactThread(request: APIRequestContext, companyId: string, title: string) {
  const asset = await jsonOrThrow<{ assetId: string }>(
    await request.post(`/api/companies/${companyId}/assets/files`, {
      multipart: { file: { name: "deck.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 test") } },
    }),
    "upload asset",
  );
  const artifact = await jsonOrThrow<{ id: string }>(
    await request.post(`/api/companies/${companyId}/artifacts`, {
      data: {
        title: "Brand deck",
        type: "design",
        source: "founder",
        storageKind: "asset",
        assetId: asset.assetId,
        filename: "deck.pdf",
        contentType: "application/pdf",
        extension: "pdf",
        byteSize: 12,
      },
    }),
    "create artifact",
  );
  await jsonOrThrow(
    await request.patch(`/api/artifacts/${artifact.id}`, {
      data: { status: "active" },
    }),
    "activate artifact",
  );
  const thread = await jsonOrThrow<{ id: string }>(
    await request.post(`/api/companies/${companyId}/discussions`, { data: { title } }),
    "create thread",
  );
  await jsonOrThrow(
    await request.post(`/api/companies/${companyId}/discussions/${thread.id}/entries`, {
      data: { inputType: "write", rawContent: "Here is the brand deck.", attachments: [{ artifactId: artifact.id }] },
    }),
    "post entry with artifact attachment",
  );
  return { threadId: thread.id, artifactId: artifact.id };
}

test.describe("artifact lifecycle (Discussions)", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Artifact-Life-/);
  });

  test("renders a file chip for an asset-backed artifact and archives it (founder)", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Artifact-Life-${Date.now()}`);
    const { threadId } = await seedFileArtifactThread(request, company.id, `File artifact ${Date.now()}`);

    await page.goto(`/${company.issuePrefix}/discussions/${threadId}`);

    const chip = page.getByTestId("artifact-file-chip").first();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("deck.pdf").first()).toBeVisible();
    await expect(page.getByTestId("artifact-download").first()).toHaveAttribute("href", /\/api\/assets\/.+\/content/);

    await page.screenshot({ path: "artifact-file-chip-live.png", fullPage: false });

    await page.getByTestId("artifact-archive").first().click();
    await expect(page.getByTestId("artifact-unarchive").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("artifact-action-error")).toHaveCount(0);
  });

  // Mock v2 (2026-07-16): the composer's File-artifact button was REMOVED — 📎
  // plain attach is the only composer upload entry. Artifact creation moved out
  // of composers (agents/MCP/API paths keep their own coverage above). The
  // composer upload flow itself is covered by composer-gaps.spec.ts.
  test("composer offers plain attach only — no file-artifact control", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Artifact-Life-${Date.now()}`);
    const thread = await jsonOrThrow<{ id: string }>(
      await request.post(`/api/companies/${company.id}/discussions`, { data: { title: `Upload ${Date.now()}` } }),
      "create thread",
    );
    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByTestId("entry-composer-attach-button")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("file-artifact-upload")).toHaveCount(0);
  });
});
