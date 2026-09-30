import { test, expect, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

async function seedThreadWithEntry(
  request: APIRequestContext,
  companyId: string,
): Promise<{ id: string; title: string }> {
  const title = `E2E scope thread ${Date.now()}`;
  const threadRes = await request.post(`/api/companies/${companyId}/discussions`, {
    data: { title },
  });
  if (!threadRes.ok()) {
    const body = await threadRes.text().catch(() => "(no body)");
    throw new Error(`seedThread failed: ${threadRes.status()} ${body}`);
  }
  const thread = (await threadRes.json()) as { id: string; title: string };

  const messages = [
    "Scope should be deliberate and should consider the whole conversation before assigning work.",
    "Accepted scope v1 should become the source of truth for tasks instead of silently changing history.",
    "Memory candidates should only be saved when agents can retrieve them during execution with source evidence from https://example.com/scope-notes.",
  ];
  for (const rawContent of messages) {
    const entryRes = await request.post(`/api/companies/${companyId}/discussions/${thread.id}/entries`, {
      data: { inputType: "write", rawContent },
    });
    if (!entryRes.ok()) {
      const body = await entryRes.text().catch(() => "(no body)");
      throw new Error(`seedEntry failed: ${entryRes.status()} ${body}`);
    }
  }

  return { id: thread.id, title };
}

async function latestScopeVersion(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
): Promise<{ id: string; status: string; versionNumber: number; sourceStartSeq: number; sourceEndSeq: number }> {
  const versionsRes = await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions`);
  expect(versionsRes.ok()).toBe(true);
  const versionsBody = (await versionsRes.json()) as {
    versions: Array<{ id: string; status: string; versionNumber: number; sourceStartSeq: number; sourceEndSeq: number }>;
  };
  const latest = versionsBody.versions[0];
  expect(latest).toBeTruthy();
  return latest;
}

async function getScopeVersionDetail(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  scopeVersionId: string,
): Promise<{
  id: string;
  versionNumber: number;
  status: string;
  sourceStartSeq: number;
  sourceEndSeq: number;
  summary: string;
  decisions: unknown[];
  openQuestions: unknown[];
  items: Array<{
    id: string;
    kind: string;
    title: string;
    status: string;
    sourceEntryIds: string[];
    resultIssueId: string | null;
    resultMemoryId: string | null;
  }>;
}> {
  const detailRes = await request.get(
    `/api/companies/${companyId}/discussions/${threadId}/scope-versions/${scopeVersionId}`,
  );
  expect(detailRes.ok()).toBe(true);
  return detailRes.json();
}

async function waitForScopeVersionDetail(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  scopeVersionId: string,
  predicate: (detail: Awaited<ReturnType<typeof getScopeVersionDetail>>) => boolean,
): Promise<Awaited<ReturnType<typeof getScopeVersionDetail>>> {
  const startedAt = Date.now();
  let last = await getScopeVersionDetail(request, companyId, threadId, scopeVersionId);
  while (Date.now() - startedAt < 10_000) {
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await getScopeVersionDetail(request, companyId, threadId, scopeVersionId);
  }
  throw new Error(`scope version did not reach expected state: ${JSON.stringify(last)}`);
}

test.describe("thread scope version flow", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Scope-/);
  });

  test("creates a multi-message scope draft, reviews cards, applies accepted outputs, then creates v2", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Scope-${Date.now()}`);
    const thread = await seedThreadWithEntry(request, company.id);

    await page.goto(`/${company.issuePrefix}/discussions`);
    const threadRow = page.getByText(thread.title).first();
    await expect(threadRow).toBeVisible({ timeout: 10_000 });
    await threadRow.click();

    await expect(page.getByRole("heading", { name: thread.title }).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.getByTestId("center-tab-scope").click();
    const createDraft = page.getByRole("button", { name: /^create scope draft$/i });
    await expect(createDraft).toBeVisible({ timeout: 10_000 });
    await createDraft.click();

    await expect(page.getByTestId("scope-version-package")).toContainText("Scope v1", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("scope-version-package")).toContainText("source of truth");
    await expect(page.getByTestId("scope-version-package")).toContainText("Task proposals");
    await expect(page.getByTestId("scope-version-package")).toContainText("Memory candidates");
    await expect(page.locator('[data-testid^="scope-version-card-"]').first()).toContainText(/source/i);
    await expect(page.getByTestId("scope-version-package")).toContainText("Memory candidate");

    const v1 = await latestScopeVersion(request, company.id, thread.id);
    // sourceEndSeq is 4, not 3: new threads run the orchestration controller path
    // (discussions.useControllerPath), so creating the scope draft routes through
    // the Adjutant, which posts its proposal as a `scope_proposal` entry (seq 4)
    // into the thread. The draft correctly ranges over the 3 human writes + that
    // agent entry. (Pre-controller-path this was a direct compile over seq 1-3.)
    expect(v1).toMatchObject({ status: "draft", versionNumber: 1, sourceStartSeq: 1, sourceEndSeq: 4 });
    const v1Detail = await getScopeVersionDetail(request, company.id, thread.id, v1.id);
    expect(v1Detail.summary).toContain("whole conversation");
    expect(v1Detail.decisions.length).toBeGreaterThan(0);
    expect(v1Detail.openQuestions.length).toBeGreaterThan(0);
    expect(v1Detail.items.map((item) => item.kind)).toEqual(
      expect.arrayContaining(["task_proposal", "memory_candidate", "source_signal"]),
    );
    expect(v1Detail.items.some((item) => item.sourceEntryIds.length > 1)).toBe(true);

    const taskItem = v1Detail.items.find((item) => item.kind === "task_proposal");
    const memoryItem = v1Detail.items.find((item) => item.kind === "memory_candidate");
    const sourceSignal = v1Detail.items.find((item) => item.kind === "source_signal");
    expect(taskItem).toBeTruthy();
    expect(memoryItem).toBeTruthy();
    expect(sourceSignal).toBeTruthy();

    await page.getByRole("button", { name: `Edit in viewer: ${taskItem!.title}` }).click();
    await expect(page.getByTestId("thread-draft-task-workbench")).toBeVisible({ timeout: 10_000 });
    await page.getByLabel("Task title").fill("E2E accepted scoped implementation task");
    await page.getByRole("button", { name: /^save draft$/i }).click();
    await waitForScopeVersionDetail(
      request,
      company.id,
      thread.id,
      v1.id,
      (detail) => detail.items.some((item) => item.id === taskItem!.id && item.title === "E2E accepted scoped implementation task"),
    );

    await page.getByRole("button", { name: /^Reject signals$/i }).click();
    await waitForScopeVersionDetail(
      request,
      company.id,
      thread.id,
      v1.id,
      (detail) => detail.items.some((item) => item.id === sourceSignal!.id && item.status === "rejected"),
    );
    await page.getByRole("button", { name: /^Accept all$/i }).click();
    await expect(page.getByRole("button", { name: /^Apply accepted$/i })).toBeEnabled({ timeout: 10_000 });

    await waitForScopeVersionDetail(
      request,
      company.id,
      thread.id,
      v1.id,
      (detail) =>
        detail.items.some((item) => item.id === taskItem!.id && item.status === "accepted") &&
        detail.items.some((item) => item.id === memoryItem!.id && item.status === "accepted") &&
        detail.items.some((item) => item.id === sourceSignal!.id && item.status === "rejected"),
    );
    await page.getByRole("button", { name: /^Apply accepted$/i }).click();

    const appliedV1 = await waitForScopeVersionDetail(
      request,
      company.id,
      thread.id,
      v1.id,
      (detail) =>
        detail.status === "accepted" &&
        detail.items.some((item) => item.kind === "task_proposal" && item.resultIssueId) &&
        detail.items.some((item) => item.kind === "memory_candidate" && item.resultMemoryId),
    );
    const appliedTask = appliedV1.items.find((item) => item.kind === "task_proposal" && item.resultIssueId);
    const appliedMemory = appliedV1.items.find((item) => item.kind === "memory_candidate" && item.resultMemoryId);
    const rejectedSignal = appliedV1.items.find((item) => item.id === sourceSignal!.id);
    expect(appliedTask?.title).toBe("E2E accepted scoped implementation task");
    expect(appliedMemory?.resultMemoryId).toBeTruthy();
    expect(rejectedSignal).toMatchObject({ status: "rejected", resultIssueId: null, resultMemoryId: null });

    await page.reload();
    await expect(page.getByTestId("thread-derived-stage")).toContainText(/Scoped v1|Assigned v1/, {
      timeout: 10_000,
    });
    await page.getByTestId("center-tab-scope").click();
    await expect(page.getByTestId("scope-version-package")).toContainText("Scope v1", {
      timeout: 10_000,
    });
    const acceptedTaskCard = page.getByTestId(`scope-version-card-${appliedTask!.id}`);
    await expect(acceptedTaskCard).toContainText(/Task /, { timeout: 10_000 });
    await expect(acceptedTaskCard).toContainText("E2E accepted scoped implementation task");
    await acceptedTaskCard.click();
    const taskPanel = page.getByTestId("task-detail-panel");
    await expect(taskPanel).toBeVisible({ timeout: 10_000 });
    await expect(taskPanel).toContainText("E2E accepted scoped implementation task");
    await taskPanel.getByRole("tab", { name: /^work$/i }).click();
    await expect(taskPanel.getByTestId("task-work-tab")).toBeVisible({ timeout: 10_000 });
    await expect(taskPanel.getByTestId("task-scope-handoff")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`scope-version-card-${appliedMemory!.id}`).click();
    await expect(page.getByTestId("thread-viewer-memory")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("tab", { name: /^thread$/i }).click();
    const composer = page.getByTestId("entry-composer-textarea");
    await expect(composer).toBeVisible({ timeout: 10_000 });
    await composer.fill("After review, include analytics instrumentation in this same handoff.");
    await page.getByRole("button", { name: /^send$/i }).click();

    await expect(
      page.locator('[data-testid^="entry-row-"]').filter({
        hasText: "After review, include analytics instrumentation",
      }).first(),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId("thread-derived-stage")).toContainText("Discussing v2", {
      timeout: 10_000,
    });
    // Count-agnostic: the controller path posts an async agent reply entry, so the
    // unscoped-entry badge can read "1 new message" or "2 new messages" depending
    // on whether that reply landed before the badge rendered. We only need the
    // badge to be present, not its exact count.
    await expect(page.getByText(/\d+ new messages?/i).first()).toBeVisible({ timeout: 10_000 });

    await page.getByTestId("center-tab-scope").click();
    const rescope = page.getByRole("button", { name: /^re-scope$/i });
    await expect(rescope).toBeVisible({
      timeout: 10_000,
    });
    await rescope.click();

    await expect(page.getByTestId("scope-version-package")).toContainText("Scope v2", {
      timeout: 10_000,
    });
    const v2 = await latestScopeVersion(request, company.id, thread.id);
    // sourceStartSeq is deterministically 5 (the first entry after v1's accepted
    // range, which ended at seq 4 — v1's agent scope_proposal). sourceEndSeq is
    // 5 OR 6: the re-scope posts an async agent reply (seq 6) that lands inside
    // the compiled range only when it beats the compile (a CI-timing race). The
    // meaningful guarantee is that v2 captures the new "analytics" message
    // (asserted via the summary below), not the exact range boundary.
    expect(v2).toMatchObject({ status: "draft", versionNumber: 2, sourceStartSeq: 5 });
    expect(v2.sourceEndSeq).toBeGreaterThanOrEqual(5);
    const v2Detail = await getScopeVersionDetail(request, company.id, thread.id, v2.id);
    // Same async-reply race as the range boundary above: the item sources from the
    // new "analytics" message (seq 5) and MAY also pick up the controller's agent
    // reply (seq 6) when it lands before the compile — so 1 or 2 source entries.
    // The meaningful guarantee (v2 captures the analytics message) is the summary
    // assertion below; here we only require the item to have a source entry.
    expect((v2Detail.items[0]?.sourceEntryIds ?? []).length).toBeGreaterThanOrEqual(1);
    expect(v2Detail.summary).toContain("analytics instrumentation");
  });
});
