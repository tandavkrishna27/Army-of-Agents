import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { jsonOrThrow, poll } from "./real-crew";

export type ScopeVersionDetail = {
  id: string;
  versionNumber: number;
  status: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  summary: string;
  items: Array<{
    id: string;
    kind: string;
    title: string;
    description?: string | null;
    status?: string | null;
    payload?: Record<string, unknown>;
    resultIssueId?: string | null;
    resultMemoryId?: string | null;
    artifactId?: string | null;
    artifactVersionId?: string | null;
  }>;
};

export async function createScopeDraftFromUi(
  page: Page,
  existingDraft?: { request: APIRequestContext; companyId: string; threadId: string },
) {
  await page.getByTestId("center-tab-scope").click();
  if (existingDraft) {
    const versions = await jsonOrThrow<{ versions: Array<{ status: string }> }>(
      await existingDraft.request.get(
        `/api/companies/${existingDraft.companyId}/discussions/${existingDraft.threadId}/scope-versions`,
      ),
      "list scope versions before creating draft",
    );
    if (versions.versions.some((version) => version.status === "draft")) {
      return;
    }
  }
  const existingDraftHeading = page.getByRole("heading", { name: /^Scope v\d+ draft$/i }).first();
  if (await existingDraftHeading.isVisible()) {
    return;
  }
  const createButton = page.getByRole("button", { name: /^(create scope draft|re-scope)$/i });
  await expect(createButton).toBeVisible({ timeout: 15_000 });
  await createButton.click();
  await expect(page.getByRole("heading", { name: /^Scope v\d+ draft$/i }).first()).toBeVisible({ timeout: 45_000 });
}

export async function latestScopeVersionDetail(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
): Promise<ScopeVersionDetail> {
  const versions = await jsonOrThrow<{ versions: Array<{ id: string; versionNumber: number; status: string }> }>(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions`),
    "list scope versions",
  );
  const latest = versions.versions[0];
  expect(latest, "latest scope version").toBeTruthy();
  return jsonOrThrow(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions/${latest.id}`),
    "get latest scope version",
  );
}

export async function openDraftTaskWorkbench(page: Page, itemId: string) {
  await page.getByTestId("center-tab-scope").click();
  const card = page.getByTestId(`scope-version-card-${itemId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: /^review task$/i }).click();
  await expect(page.getByTestId("thread-draft-task-workbench")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("thread-draft-task-workbench")).toContainText("Scope handoff");
}

export async function openDraftMemoryViewer(page: Page, itemId: string) {
  await page.getByTestId("center-tab-scope").click();
  const card = page.getByTestId(`scope-version-card-${itemId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: /^review memory$/i }).click();
  await expect(page.getByTestId("thread-draft-memory-viewer")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Save approved/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Save pending/i })).toBeVisible();
}

export async function saveMemoryFromUi(page: Page, scopeVersionId: string, itemId: string, status: "approved" | "pending") {
  const label = status === "approved" ? /Save approved/i : /Save pending/i;
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes(`/scope-versions/${scopeVersionId}/items/${itemId}/create`) &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: label }).click();
  expect((await response).ok()).toBe(true);
}

export async function createTaskFromUi(page: Page, scopeVersionId: string, itemId: string) {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes(`/scope-versions/${scopeVersionId}/items/${itemId}/create`) &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^create task$/i }).click();
  expect((await response).ok()).toBe(true);
}

export async function linkArtifactFromUi(page: Page, scopeVersionId: string, itemId: string) {
  await page.getByTestId("center-tab-scope").click();
  const card = page.getByTestId(`scope-version-card-${itemId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes(`/scope-versions/${scopeVersionId}/items/${itemId}/create`) &&
      candidate.request().method() === "POST",
  );
  await card.getByRole("button", { name: /^link artifact$/i }).click();
  expect((await response).ok()).toBe(true);
}

export async function rejectScopeItemFromUi(page: Page, scopeVersionId: string, itemId: string) {
  await page.getByTestId("center-tab-scope").click();
  const card = page.getByTestId(`scope-version-card-${itemId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().includes(`/scope-versions/${scopeVersionId}/items/review`) &&
      candidate.request().method() === "POST",
  );
  await card.getByRole("button", { name: /^reject$/i }).click();
  expect((await response).ok()).toBe(true);
  await expect(card).toHaveAttribute("data-review-status", "rejected", { timeout: 15_000 });
}

export async function createScopeOutputViaApi(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  scopeVersionId: string,
  itemId: string,
  options?: { memoryStatus?: "approved" | "pending" },
) {
  return jsonOrThrow(
    await request.post(
      `/api/companies/${companyId}/discussions/${threadId}/scope-versions/${scopeVersionId}/items/${itemId}/create`,
      { data: options ?? {} },
    ),
    "create scope output",
  );
}

export async function waitForAcceptedScopeAfterDirectCreate(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  scopeVersionId: string,
  timeoutMs = 30_000,
) {
  return poll(
    async () =>
      jsonOrThrow<ScopeVersionDetail>(
        await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions/${scopeVersionId}`),
        "get scope after create",
      ),
    (scope) =>
      scope.status === "accepted" &&
      scope.items
        .filter((item) => ["task_proposal", "memory_candidate", "artifact_link"].includes(item.kind))
        .every((item) => ["applied", "rejected"].includes(String(item.status))),
    "accepted scope after direct-create",
    timeoutMs,
  );
}

export async function assertScopeHasArtifactEvidence(scope: ScopeVersionDetail) {
  const artifactItems = scope.items.filter((item) => item.kind === "artifact_link");
  expect(artifactItems.length, "scope should include at least one artifact_link").toBeGreaterThan(0);
  for (const item of artifactItems) {
    expect(item.artifactId, `artifact item ${item.id} should carry artifactId`).toBeTruthy();
    expect(item.artifactVersionId, `artifact item ${item.id} should carry artifactVersionId`).toBeTruthy();
    expect(JSON.stringify(item.payload ?? {}), `artifact item ${item.id} payload`).toMatch(
      /artifact|document|markdown|handoff|discussion-scope-notes/i,
    );
  }
}
