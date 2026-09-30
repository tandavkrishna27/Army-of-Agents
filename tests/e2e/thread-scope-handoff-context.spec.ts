import { test, expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

const ARTIFACT_TYPES = ["document", "presentation", "code", "design", "report", "other"] as const;

type ArtifactType = (typeof ARTIFACT_TYPES)[number];

type ScopeVersionDetail = {
  id: string;
  versionNumber: number;
  status: string;
  items: Array<{
    id: string;
    kind: string;
    title: string;
    description: string | null;
    payload: Record<string, unknown>;
    sourceEntryIds: string[];
    resultIssueId: string | null;
    resultMemoryId: string | null;
    artifactId: string | null;
    artifactVersionId: string | null;
  }>;
};

async function jsonOrThrow<T>(res: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<T> }, label: string): Promise<T> {
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`${label} failed: ${res.status()} ${body}`);
  }
  return res.json();
}

async function getWithTransientRetry(
  request: APIRequestContext,
  url: string,
  label: string,
): Promise<APIResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await request.get(url);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/(ECONNRESET|socket hang up|connection reset)/i.test(message) || attempt === 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new Error(`${label} failed after retries: ${String(lastError)}`);
}

async function createArtifact(
  request: APIRequestContext,
  companyId: string,
  artifactType: ArtifactType,
): Promise<{ id: string; currentVersionId: string | null; title: string; type: ArtifactType }> {
  const title = `${artifactType} reference`;
  const res = await request.post(`/api/companies/${companyId}/artifacts`, {
    data: {
      title,
      description: `${artifactType} handoff fixture`,
      type: artifactType,
      source: "founder",
      sourceDetail: "E2E scope handoff fixture",
      content: `# ${title}\n\nUse this ${artifactType} artifact as selected scope evidence.`,
    },
  });
  return jsonOrThrow(res, `create ${artifactType} artifact`);
}

async function uploadAsset(
  request: APIRequestContext,
  companyId: string,
): Promise<{ assetId: string; originalFilename: string; contentType: string }> {
  // Upload through the COMPOSER namespace ("discussion-entries") exactly like the
  // real thread composer (ThreadTab.handleUpload) — so the asset is stamped
  // composer_validated=true and can legitimately be bound as a discussion-entry
  // attachment. A namespace=files upload is composer_validated=false and the
  // binding boundary (addEntry) rejects it (PR #291 round-6 D provenance guard).
  // The bytes must be a real PDF so the composer byte-sniff accepts them.
  const res = await request.post(`/api/companies/${companyId}/assets/files`, {
    multipart: {
      namespace: "discussion-entries",
      file: {
        name: "interview-notes.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\nInterview notes: preserve source evidence in created tasks.\n%%EOF"),
      },
    },
  });
  return jsonOrThrow(res, "upload handoff asset");
}

async function seedThread(
  request: APIRequestContext,
  companyId: string,
): Promise<{ id: string; title: string; artifactIdsByType: Record<ArtifactType, string> }> {
  const title = `E2E scope handoff ${Date.now()}`;
  const thread = await jsonOrThrow<{ id: string; title: string }>(
    await request.post(`/api/companies/${companyId}/discussions`, { data: { title } }),
    "create handoff thread",
  );

  const artifacts = Object.fromEntries(
    await Promise.all(
      ARTIFACT_TYPES.map(async (artifactType) => {
        const artifact = await createArtifact(request, companyId, artifactType);
        return [artifactType, artifact] as const;
      }),
    ),
  ) as Record<ArtifactType, { id: string; currentVersionId: string | null; title: string; type: ArtifactType }>;
  const asset = await uploadAsset(request, companyId);

  const messages = [
    {
      rawContent:
        "We need to turn this whole conversation into one scoped implementation task. Accepted scope should be the source of truth for the agent handoff.",
      attachments: [],
    },
    {
      rawContent:
        "Keep this URL as evidence for the task handoff: https://example.com/scope-reference. Memory should be retrievable by the worker agent.",
      attachments: [{ assetId: asset.assetId }],
    },
    // Attach every generated artifact across entries of at most
    // COMPOSER_MAX_ATTACHMENTS (5) — the server caps a single entry's attachment
    // array at 5 (PR #291 round-6 E). All artifacts still land on the thread as
    // scope artifact_links, which the assertions below verify per type.
    ...(() => {
      const artifactRefs = ARTIFACT_TYPES.map((artifactType) => ({ artifactId: artifacts[artifactType].id }));
      const chunks: Array<{ rawContent: string; attachments: Array<{ artifactId: string }> }> = [];
      for (let i = 0; i < artifactRefs.length; i += 5) {
        chunks.push({
          rawContent: "Attach all generated artifacts so the task can carry only the selected handoff references.",
          attachments: artifactRefs.slice(i, i + 5),
        });
      }
      return chunks;
    })(),
  ];

  for (const message of messages) {
    await jsonOrThrow(
      await request.post(`/api/companies/${companyId}/discussions/${thread.id}/entries`, {
        data: {
          inputType: "write",
          rawContent: message.rawContent,
          attachments: message.attachments,
        },
      }),
      "post handoff discussion entry",
    );
  }

  return {
    id: thread.id,
    title,
    artifactIdsByType: Object.fromEntries(
      ARTIFACT_TYPES.map((artifactType) => [artifactType, artifacts[artifactType].id]),
    ) as Record<ArtifactType, string>,
  };
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
  return getScopeVersion(request, companyId, threadId, draft.version.id);
}

async function createDepartment(
  request: APIRequestContext,
  companyId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  return jsonOrThrow(
    await request.post(`/api/companies/${companyId}/projects`, {
      data: {
        name,
        type: "department",
        status: "in_progress",
        description: "Scope memory context proof department",
      },
    }),
    "create context proof department",
  );
}

async function saveScopeMemory(
  request: APIRequestContext,
  companyId: string,
  memoryStatus: "approved" | "pending",
  title: string,
  content: string,
  departmentId: string,
): Promise<{ threadId: string; memoryId: string }> {
  const thread = await jsonOrThrow<{ id: string; title: string }>(
    await request.post(`/api/companies/${companyId}/discussions`, {
      data: { title: `E2E scoped memory ${memoryStatus} ${Date.now()}` },
    }),
    "create memory proof discussion",
  );

  await jsonOrThrow(
    await request.post(`/api/companies/${companyId}/discussions/${thread.id}/entries`, {
      data: {
        inputType: "write",
        rawContent:
          `Decision: accepted scope versions are the durable handoff source of truth. ${content} ` +
          "Save this as scoped memory so future task agents can retrieve it before execution.",
      },
    }),
    "post memory proof discussion entry",
  );

  const scope = await createScopeDraft(request, companyId, thread.id);
  const memoryItem = scope.items.find((item) => item.kind === "memory_candidate");
  expect(memoryItem, "scope draft should include a memory candidate").toBeTruthy();

  await jsonOrThrow(
    await request.patch(
      `/api/companies/${companyId}/discussions/${thread.id}/scope-versions/${scope.id}/items/${memoryItem!.id}`,
      {
        data: {
          title,
          description: content,
          payload: {
            category: "decision",
            layer: "domain",
            departmentId,
            visibility: "scoped",
            priority: 100,
            tags: ["scope-memory-context-proof"],
          },
        },
      },
    ),
    "update scoped memory item",
  );

  await jsonOrThrow(
    await request.post(
      `/api/companies/${companyId}/discussions/${thread.id}/scope-versions/${scope.id}/items/${memoryItem!.id}/create`,
      { data: { memoryStatus } },
    ),
    "save scoped memory item",
  );

  const updated = await getScopeVersion(request, companyId, thread.id, scope.id);
  const saved = updated.items.find((item) => item.id === memoryItem!.id);
  expect(saved?.resultMemoryId, "saved memory should link to resultMemoryId").toBeTruthy();

  return { threadId: thread.id, memoryId: saved!.resultMemoryId! };
}

async function getScopeVersion(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  scopeVersionId: string,
): Promise<ScopeVersionDetail> {
  return jsonOrThrow(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions/${scopeVersionId}`),
    "get scope version",
  );
}

async function waitForCreatedTask(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  scopeVersionId: string,
  itemId: string,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const detail = await getScopeVersion(request, companyId, threadId, scopeVersionId);
    const item = detail.items.find((candidate) => candidate.id === itemId);
    if (item?.resultIssueId) return item.resultIssueId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("scope task was not created");
}

async function openDraftTaskWorkbench(page: Page, taskItemId: string) {
  await page.getByTestId("center-tab-scope").click();
  const taskCard = page.getByTestId(`scope-version-card-${taskItemId}`);
  await expect(taskCard).toBeVisible({ timeout: 10_000 });
  await taskCard.click();
  await expect(page.getByTestId("thread-draft-task-workbench")).toBeVisible({ timeout: 10_000 });
}

async function openScopeEvidenceCard(page: Page, itemId: string) {
  await page.getByTestId("center-tab-scope").click();
  const card = page.getByTestId(`scope-version-card-${itemId}`);
  if ((await card.count()) === 0) {
    const sourceNotes = page.getByTestId("scope-version-accordion-source-notes");
    if ((await sourceNotes.count()) > 0) {
      await sourceNotes.click();
    }
  }
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.click();
}

test.describe("thread scope handoff context", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Handoff-/);
  });

  test("shows the no-scope state before any scope draft exists", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Handoff-${Date.now()}`);
    const thread = await seedThread(request, company.id);

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByRole("heading", { name: thread.title }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("center-tab-scope").click();

    await expect(page.getByTestId("scope-draft-cta")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("scope-draft-cta")).toContainText("No draft");
    await expect(page.getByRole("button", { name: /create scope draft/i })).toBeVisible();
    await expect(page.getByText("Ready to scope")).toHaveCount(0);
  });

  test("includes approved scoped memory and excludes pending scoped memory from task context package", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Handoff-${Date.now()}`);
    const department = await createDepartment(request, company.id, `Software Context Proof ${Date.now()}`);
    const unique = Date.now();
    const approvedToken = `APPROVED_SCOPE_MEMORY_${unique}`;
    const pendingToken = `PENDING_SCOPE_MEMORY_${unique}`;

    const approvedMemory = await saveScopeMemory(
      request,
      company.id,
      "approved",
      "Approved scope context rule",
      `Approved task context must include ${approvedToken}.`,
      department.id,
    );
    const pendingMemory = await saveScopeMemory(
      request,
      company.id,
      "pending",
      "Pending scope context rule",
      `Pending task context must not include ${pendingToken}.`,
      department.id,
    );

    const approvedRecord = await jsonOrThrow<{ status: string }>(
      await request.get(`/api/companies/${company.id}/memory/${approvedMemory.memoryId}`),
      "get approved proof memory",
    );
    const pendingRecord = await jsonOrThrow<{ status: string }>(
      await request.get(`/api/companies/${company.id}/memory/${pendingMemory.memoryId}`),
      "get pending proof memory",
    );
    expect(approvedRecord.status).toBe("approved");
    expect(pendingRecord.status).toBe("pending");

    const issue = await jsonOrThrow<{ id: string }>(
      await request.post(`/api/companies/${company.id}/issues`, {
        data: {
          projectId: department.id,
          title: "Use approved scoped memory",
          description: "Context package should include only approved scoped memory.",
          status: "backlog",
          priority: "medium",
          workMode: "standard",
        },
      }),
      "create context proof issue",
    );

    const contextPackage = await jsonOrThrow<{ markdown: string }>(
      await request.get(`/api/companies/${company.id}/issues/${issue.id}/context-package`),
      "get context proof package",
    );

    expect(contextPackage.markdown).toContain(approvedToken);
    expect(contextPackage.markdown).not.toContain(pendingToken);

    test.info().annotations.push({
      type: "context-proof",
      description: `approved=${approvedMemory.threadId}/${approvedMemory.memoryId} pending=${pendingMemory.threadId}/${pendingMemory.memoryId}`,
    });
  });

  test("selects scope evidence, creates a task, and carries selected context to viewer and LLM package", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Handoff-${Date.now()}`);
    const thread = await seedThread(request, company.id);
    const scope = await createScopeDraft(request, company.id, thread.id);
    const taskItem = scope.items.find((item) => item.kind === "task_proposal");
    expect(taskItem, "scope draft should include a task proposal").toBeTruthy();
    const memoryItem = scope.items.find((item) => item.kind === "memory_candidate");
    expect(memoryItem, "scope draft should include a memory candidate").toBeTruthy();

    for (const artifactType of ARTIFACT_TYPES) {
      expect(
        scope.items.some(
          (item) => item.kind === "artifact_link" && item.artifactId === thread.artifactIdsByType[artifactType],
        ),
        `${artifactType} artifact should be compiled into scope`,
      ).toBe(true);
    }
    expect(scope.items.some((item) => item.kind === "source_signal" && item.payload?.assetId)).toBe(true);
    expect(scope.items.some((item) => item.kind === "source_signal" && item.payload?.url)).toBe(true);

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByRole("heading", { name: thread.title }).first()).toBeVisible({ timeout: 10_000 });

    for (const artifactType of ARTIFACT_TYPES) {
      const artifactItem = scope.items.find(
        (item) => item.kind === "artifact_link" && item.artifactId === thread.artifactIdsByType[artifactType],
      );
      expect(artifactItem, `${artifactType} scope card should exist`).toBeTruthy();
      await openScopeEvidenceCard(page, artifactItem!.id);
      const artifactViewer = page.getByTestId("thread-artifact-viewer");
      await expect(artifactViewer).toBeVisible({ timeout: 10_000 });
      await expect(artifactViewer).toContainText(`${artifactType} reference`);
      await expect(artifactViewer).toContainText(`Use this ${artifactType} artifact as selected scope evidence.`);
    }

    const assetSignal = scope.items.find((item) => item.kind === "source_signal" && item.payload?.assetId);
    expect(assetSignal, "uploaded asset source signal should exist").toBeTruthy();
    await openScopeEvidenceCard(page, assetSignal!.id);
    await expect(page.getByTestId("thread-asset-viewer")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("thread-asset-viewer")).toContainText("interview-notes.pdf");

    const urlSignal = scope.items.find((item) => item.kind === "source_signal" && item.payload?.url);
    expect(urlSignal, "URL source signal should exist").toBeTruthy();
    await openScopeEvidenceCard(page, urlSignal!.id);
    await expect(page.getByTestId("thread-browser-viewer")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("link", { name: /Open browser preview externally/i }),
    ).toHaveAttribute("href", "https://example.com/scope-reference");

    await page.getByTestId("center-tab-scope").click();
    await page
      .getByTestId(`scope-version-card-${memoryItem!.id}`)
      .getByRole("button", { name: /^review memory$/i })
      .click();
    await expect(page.getByTestId("thread-draft-memory-viewer")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /Save approved/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Save pending/i })).toBeVisible();

    const createRequests: string[] = [];
    page.on("request", (requestEvent) => {
      if (
        requestEvent.url().includes(`/scope-versions/${scope.id}/items/${taskItem!.id}/create`) &&
        requestEvent.method() === "POST"
      ) {
        createRequests.push(requestEvent.url());
      }
    });

    await page.getByTestId("center-tab-scope").click();
    await page
      .getByTestId(`scope-version-card-${taskItem!.id}`)
      .getByRole("button", { name: /^review task$/i })
      .click();

    const workbench = page.getByTestId("thread-draft-task-workbench");
    await expect(workbench).toBeVisible({ timeout: 10_000 });
    expect(createRequests).toHaveLength(0);
    await expect(workbench).toContainText("Scope handoff");
    await expect(workbench).toContainText("Documents");
    await expect(workbench).toContainText("Workspace");
    await expect(workbench.getByRole("checkbox", { name: /Message 1 - You/i })).toBeChecked();
    await expect(workbench.getByRole("checkbox", { name: /document reference/i })).toBeChecked();
    await expect(workbench.getByRole("checkbox", { name: /presentation reference/i })).toBeChecked();
    await expect(workbench.getByRole("checkbox", { name: /code reference/i })).toBeChecked();
    await expect(workbench.getByRole("checkbox", { name: /design reference/i })).toBeChecked();
    await expect(workbench.getByRole("checkbox", { name: /report reference/i })).toBeChecked();
    await expect(workbench.getByRole("checkbox", { name: /other reference/i })).toBeChecked();
    await expect(workbench.getByRole("checkbox", { name: /interview-notes\.pdf/i })).toBeChecked();
    await expect(workbench.getByRole("checkbox", { name: /Source: https:\/\/example\.com\/scope-reference/i })).toBeChecked();

    await workbench.getByRole("checkbox", { name: /other reference/i }).click();
    const createResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/scope-versions/${scope.id}/items/${taskItem!.id}/create`) &&
        response.request().method() === "POST",
    );
    await workbench.getByRole("button", { name: /^create task$/i }).click();
    const createResponse = await createResponsePromise;
    expect(createResponse.ok(), await createResponse.text()).toBe(true);

    const createdTaskId = await waitForCreatedTask(request, company.id, thread.id, scope.id, taskItem!.id);

    await page.reload();
    await page.getByTestId("center-tab-scope").click();
    await expect(page.getByTestId("scope-version-package")).toContainText("Partially applied", { timeout: 10_000 });
    await expect(page.getByTestId("scope-version-package")).toContainText("1 created output");
    await expect(page.getByTestId("scope-version-package")).toContainText(/\d+ draft items?/);
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).click();
    const taskPanel = page.getByTestId("task-detail-panel");
    await expect(taskPanel).toBeVisible({ timeout: 10_000 });
    const openTaskWorkHandoff = async () => {
      await expect(taskPanel).toBeVisible({ timeout: 10_000 });
      await taskPanel.getByRole("tab", { name: /^work$/i }).click();
      const handoff = taskPanel.getByTestId("task-scope-handoff");
      await expect(taskPanel.getByTestId("task-work-tab")).toBeVisible({ timeout: 10_000 });
      await expect(handoff).toBeVisible({ timeout: 10_000 });
      return handoff;
    };
    let handoff = await openTaskWorkHandoff();
    await expect(handoff).toContainText("Scope handoff", { timeout: 10_000 });
    await expect(handoff).toContainText("document reference");
    await expect(handoff).toContainText("presentation reference");
    await expect(handoff).toContainText("code reference");
    await expect(handoff).toContainText("design reference");
    await expect(handoff).toContainText("report reference");
    await expect(handoff).toContainText("interview-notes.pdf");
    await expect(handoff).toContainText("https://example.com/scope-reference");
    await expect(handoff).not.toContainText("other reference");
    await expect(handoff).toContainText("Included refs are passed to agents.");
    await expect(handoff.getByText("In context").first()).toBeVisible();
    await expect(handoff.getByText("Included in agent context")).toHaveCount(0);

    await handoff.getByRole("button", { name: /Exclude document reference from agent context/i }).click();
    await expect(handoff.getByText("Excluded").first()).toBeVisible();
    await handoff.getByRole("button", { name: /Include document reference in agent context/i }).click();
    await expect(handoff.getByText("In context").first()).toBeVisible();

    await handoff.getByRole("button", { name: /Open handoff item: document reference/i }).click();
    await expect(page.getByTestId("thread-artifact-viewer")).toContainText("document reference");
    await expect(page.getByTestId("thread-artifact-viewer")).toContainText("Use this document artifact as selected scope evidence.");

    await page.getByTestId("center-tab-scope").click();
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).scrollIntoViewIfNeeded();
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).click();
    handoff = await openTaskWorkHandoff();
    await handoff.getByRole("button", { name: /Open handoff item: interview-notes\.pdf/i }).click();
    await expect(page.getByTestId("thread-asset-viewer")).toContainText("interview-notes.pdf");

    await page.getByTestId("center-tab-scope").click();
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).scrollIntoViewIfNeeded();
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).click();
    handoff = await openTaskWorkHandoff();
    await handoff.getByRole("button", { name: /Open handoff item: Source: https:\/\/example\.com\/scope-reference/i }).click();
    await expect(
      page.getByRole("link", { name: /Open browser preview externally/i }),
    ).toHaveAttribute("href", "https://example.com/scope-reference");

    await page.getByTestId("center-tab-scope").click();
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).scrollIntoViewIfNeeded();
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).click();

    const bundles = await jsonOrThrow<
      Array<{
        sourceKind: string;
        items: Array<{
          itemType: string;
          sourceId: string | null;
          label: string | null;
          metadata: Record<string, unknown> | null;
        }>;
      }>
    >(
      await getWithTransientRetry(request, `/api/issues/${createdTaskId}/context-bundles`, "list created task context bundles"),
      "list created task context bundles",
    );
    const scopeBundle = bundles.find((bundle) => bundle.sourceKind === "discussion_scope");
    expect(scopeBundle).toBeTruthy();
    const documentArtifact = scope.items.find(
      (item) => item.kind === "artifact_link" && item.artifactId === thread.artifactIdsByType.document,
    );
    expect(documentArtifact, "document artifact should be represented in scope").toBeTruthy();
    expect(scopeBundle!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemType: "artifact",
          sourceId: documentArtifact!.artifactId,
          metadata: expect.objectContaining({
            artifactVersionId: documentArtifact!.artifactVersionId,
            artifactType: "document",
            scopeItemId: documentArtifact!.id,
          }),
        }),
        expect.objectContaining({
          itemType: "asset",
          sourceId: assetSignal!.payload.assetId,
          metadata: expect.objectContaining({
            contentType: "application/pdf",
            scopeItemId: assetSignal!.id,
          }),
        }),
        expect.objectContaining({
          itemType: "url",
          sourceId: null,
          metadata: expect.objectContaining({
            url: "https://example.com/scope-reference",
            scopeItemId: urlSignal!.id,
          }),
        }),
      ]),
    );
    expect(scopeBundle!.items.map((item) => item.label)).toEqual(
      expect.arrayContaining([
        "document reference",
        "presentation reference",
        "code reference",
        "design reference",
        "report reference",
        "interview-notes.pdf",
        "Source: https://example.com/scope-reference",
      ]),
    );
    expect(scopeBundle!.items.map((item) => item.label)).not.toContain("other reference");

    const contextPackage = await jsonOrThrow<{ markdown: string }>(
      await request.get(`/api/companies/${company.id}/issues/${createdTaskId}/context-package`),
      "get created task context package",
    );
    expect(contextPackage.markdown).toContain("## Scope Handoff");
    expect(contextPackage.markdown).toContain("document reference");
    expect(contextPackage.markdown).toContain("presentation reference");
    expect(contextPackage.markdown).toContain("code reference");
    expect(contextPackage.markdown).toContain("design reference");
    expect(contextPackage.markdown).toContain("report reference");
    expect(contextPackage.markdown).toContain("https://example.com/scope-reference");
    expect(contextPackage.markdown).not.toContain("other reference");

    await page.getByTestId("center-tab-scope").click();
    await page
      .getByTestId(`scope-version-card-${memoryItem!.id}`)
      .getByRole("button", { name: /^review memory$/i })
      .click();
    await expect(page.getByTestId("thread-draft-memory-viewer")).toBeVisible({ timeout: 10_000 });
    const savePendingResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/scope-versions/${scope.id}/items/${memoryItem!.id}/create`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /Save pending/i }).click();
    const savePendingResponse = await savePendingResponsePromise;
    expect(savePendingResponse.ok(), await savePendingResponse.text()).toBe(true);

    await page.reload();
    await page.getByTestId("center-tab-scope").click();
    await page.getByTestId(`scope-version-card-${memoryItem!.id}`).click();
    await expect(page.getByTestId("thread-viewer-memory")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("thread-viewer-linked-memory-actions")).toContainText("Approve");
    await expect(page.getByTestId("thread-viewer-linked-memory-actions")).toContainText("Reject");

    await page.getByTestId("center-tab-scope").click();
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).scrollIntoViewIfNeeded();
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).click();
    const resizeHandle = page.getByRole("separator", { name: /resize viewer/i });
    const resizeBox = await resizeHandle.boundingBox();
    expect(resizeBox, "viewer resize handle should be measurable").toBeTruthy();
    await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBox!.x - 520, resizeBox!.y + resizeBox!.height / 2);
    await page.mouse.up();
    await expect
      .poll(async () => Number((await page.getByTestId("thread-right-viewer").getAttribute("data-width")) ?? "0"))
      .toBeGreaterThan(680);

    await page.screenshot({
      path: `tests/e2e/test-results/thread-scope-handoff-${createdTaskId}.png`,
      fullPage: true,
    });
  });

  test("saves a draft memory candidate as approved through the discussion viewer", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Handoff-${Date.now()}`);
    const thread = await seedThread(request, company.id);
    const scope = await createScopeDraft(request, company.id, thread.id);
    const memoryItem = scope.items.find((item) => item.kind === "memory_candidate");
    expect(memoryItem, "scope draft should include a memory candidate").toBeTruthy();

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByRole("heading", { name: thread.title }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("center-tab-scope").click();
    await page
      .getByTestId(`scope-version-card-${memoryItem!.id}`)
      .getByRole("button", { name: /^review memory$/i })
      .click();

    const viewer = page.getByTestId("thread-draft-memory-viewer");
    await expect(viewer).toBeVisible({ timeout: 10_000 });
    await expect(viewer).toContainText("Save approved");
    await expect(viewer).toContainText("Save pending");

    const saveApprovedResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/scope-versions/${scope.id}/items/${memoryItem!.id}/create`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /Save approved/i }).click();
    const saveApprovedResponse = await saveApprovedResponsePromise;
    expect(saveApprovedResponse.ok(), await saveApprovedResponse.text()).toBe(true);

    const updated = await getScopeVersion(request, company.id, thread.id, scope.id);
    const savedMemoryItem = updated.items.find((item) => item.id === memoryItem!.id);
    expect(savedMemoryItem?.resultMemoryId, "approved UI save should link the scope item to memory").toBeTruthy();
    const memory = await jsonOrThrow<{ status: string }>(
      await request.get(`/api/companies/${company.id}/memory/${savedMemoryItem!.resultMemoryId}`),
      "get UI-approved memory",
    );
    expect(memory.status).toBe("approved");

    await page.reload();
    await page.getByTestId("center-tab-scope").click();
    await page.getByTestId(`scope-version-card-${memoryItem!.id}`).click();
    await expect(page.getByTestId("thread-viewer-memory")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("thread-viewer-linked-memory-actions")).toContainText("Edit memory");
    await page.getByRole("button", { name: /Edit memory/i }).click();
    await page.getByLabel("Memory title").fill("Approved scoped memory rule");
    await expect(page.getByRole("button", { name: /Save memory/i })).toBeVisible();
  });

  test("allows background agent entries after draft, blocks newer human entries, and preserves fallback handoff context", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Handoff-${Date.now()}`);

    const backgroundThread = await seedThread(request, company.id);
    const backgroundScope = await createScopeDraft(request, company.id, backgroundThread.id);
    const backgroundTask = backgroundScope.items.find((item) => item.kind === "task_proposal");
    expect(backgroundTask, "background draft should include a task proposal").toBeTruthy();

    await jsonOrThrow(
      await request.post(`/api/companies/${company.id}/discussions/${backgroundThread.id}/entries`, {
        data: {
          inputType: "agent",
          rawContent: "Adjutant internal routing note after the draft. This should not make the user's scope stale.",
        },
      }),
      "post background agent entry",
    );

    const createdResponse = await request.post(
      `/api/companies/${company.id}/discussions/${backgroundThread.id}/scope-versions/${backgroundScope.id}/items/${backgroundTask!.id}/create`,
      { data: {} },
    );
    expect(createdResponse.ok(), await createdResponse.text()).toBe(true);

    const createdTaskId = await waitForCreatedTask(
      request,
      company.id,
      backgroundThread.id,
      backgroundScope.id,
      backgroundTask!.id,
    );

    const bundles = await jsonOrThrow<Array<{ sourceKind: string; items: Array<{ label: string | null }> }>>(
      await getWithTransientRetry(request, `/api/issues/${createdTaskId}/context-bundles`, "list background-created task context bundles"),
      "list background-created task context bundles",
    );
    const scopeBundle = bundles.find((bundle) => bundle.sourceKind === "discussion_scope");
    expect(scopeBundle, "created task should have a discussion scope context bundle").toBeTruthy();
    expect(scopeBundle!.items.map((item) => item.label)).toEqual(
      expect.arrayContaining([
        "Source: https://example.com/scope-reference",
        "interview-notes.pdf",
        "document reference",
      ]),
    );

    const contextPackage = await jsonOrThrow<{ markdown: string }>(
      await request.get(`/api/companies/${company.id}/issues/${createdTaskId}/context-package`),
      "get background-created task context package",
    );
    expect(contextPackage.markdown).toContain("## Scope Handoff");
    expect(contextPackage.markdown).toContain("https://example.com/scope-reference");
    expect(contextPackage.markdown).toContain("document reference");

    const humanThread = await seedThread(request, company.id);
    const humanScope = await createScopeDraft(request, company.id, humanThread.id);
    const humanTask = humanScope.items.find((item) => item.kind === "task_proposal");
    expect(humanTask, "human-stale draft should include a task proposal").toBeTruthy();

    await jsonOrThrow(
      await request.post(`/api/companies/${company.id}/discussions/${humanThread.id}/entries`, {
        data: {
          inputType: "write",
          rawContent: "Human changed the requested scope after the draft, so the old draft must not create a task.",
        },
      }),
      "post human entry after draft",
    );

    const staleResponse = await request.post(
      `/api/companies/${company.id}/discussions/${humanThread.id}/scope-versions/${humanScope.id}/items/${humanTask!.id}/create`,
      { data: {} },
    );
    expect(staleResponse.status()).toBe(409);
    const staleBody = (await staleResponse.json()) as { error?: string };
    expect(staleBody.error).toBe("Scope draft is stale because the thread has newer human entries");
  });
});
