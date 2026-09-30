import { expect, test, type APIRequestContext } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "../e2e/helpers/seed-company";

type ScopeVersionDetail = {
  id: string;
  items: Array<{
    id: string;
    kind: string;
    title: string;
    description: string | null;
    payload: Record<string, unknown>;
    resultMemoryId: string | null;
  }>;
};

type RunForIssue = { runId: string; status: string; promptSnapshot?: string | null };
type MemoryRetrieval = { itemId: string | null; itemTitle: string | null; triggeredBy: string };

const FINAL_RUN_STATUSES = new Set(["completed", "succeeded", "failed", "cancelled", "timed_out"]);

async function jsonOrThrow<T>(
  res: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<T> },
  label: string,
): Promise<T> {
  if (!res.ok()) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`${label} failed: ${res.status()} ${body}`);
  }
  return res.json();
}

async function poll<T>(
  producer: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const startedAt = Date.now();
  let latest: T;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await producer();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${label}`);
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

async function hireProcessAgent(request: APIRequestContext, companyId: string, outputToken: string) {
  const script = "console.log(process.env.AOA_LIVE_SCOPE_TOKEN)";
  const body = await jsonOrThrow<{ agent: { id: string; name: string } }>(
    await request.post(`/api/companies/${companyId}/agent-hires`, {
      data: {
        name: `E2E Scope Memory Process Agent ${Date.now()}`,
        role: "general",
        title: "E2E Scope Memory Process Agent",
        adapterType: "process",
        runtimeConfig: {
          injectCompanyContext: true,
          contextMode: "standard",
          autoRunSummary: true,
        },
        adapterConfig: {
          command: "node",
          args: ["-e", script],
          env: { AOA_LIVE_SCOPE_TOKEN: outputToken },
          timeoutSec: 20,
        },
      },
    }),
    "hire process agent",
  );
  return body.agent;
}

async function assignAgentToDepartment(
  request: APIRequestContext,
  companyId: string,
  departmentId: string,
  agentId: string,
) {
  await jsonOrThrow(
    await request.post(`/api/projects/${departmentId}/agents?companyId=${companyId}`, {
      data: { agentId },
    }),
    "assign process agent to department",
  );
}

async function createAssignedIssue(
  request: APIRequestContext,
  companyId: string,
  departmentId: string,
  agentId: string,
  title: string,
  description: string,
) {
  return jsonOrThrow<{ id: string; identifier: string | null }>(
    await request.post(`/api/companies/${companyId}/issues`, {
      data: {
        projectId: departmentId,
        title,
        description,
        status: "backlog",
        priority: "medium",
        workMode: "standard",
        assigneeAgentId: agentId,
      },
    }),
    "create assigned live scope issue",
  );
}

async function wakeAgentForIssue(
  request: APIRequestContext,
  companyId: string,
  agentId: string,
  issueId: string,
) {
  return jsonOrThrow<{ id?: string; runId?: string; status: string }>(
    await request.post(`/api/agents/${agentId}/wakeup?companyId=${companyId}`, {
      data: {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "scope_memory_live_agent_smoke",
        payload: { issueId },
      },
    }),
    "wake live scope process agent",
  );
}

async function waitForCompletedRun(request: APIRequestContext, issueId: string) {
  return poll(
    async () => {
      const runs = await jsonOrThrow<RunForIssue[]>(
        await request.get(`/api/issues/${issueId}/runs`),
        "list live scope issue runs",
      );
      return runs[0] ?? null;
    },
    (run): run is RunForIssue => Boolean(run && FINAL_RUN_STATUSES.has(run.status)),
    "live scope task-agent run to finish",
    60_000,
  );
}

async function waitForMemoryRetrievals(
  request: APIRequestContext,
  companyId: string,
  issueId: string,
  expectedMemoryId: string,
) {
  return poll(
    async () =>
      jsonOrThrow<MemoryRetrieval[]>(
        await request.get(`/api/companies/${companyId}/issues/${issueId}/memory-retrievals?limit=100`),
        "list live scope memory retrievals",
      ),
    (rows) => rows.some((row) => row.itemId === expectedMemoryId && row.triggeredBy === "auto"),
    "approved scoped memory auto retrieval",
    60_000,
  );
}

test.describe("scope memory workbench", () => {
  test.beforeAll(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Memory-/);
  });

  test("includes approved scoped memory and excludes pending scoped memory from task context package", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Memory-${Date.now()}`);
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
      description: `/${company.issuePrefix}/issues?selected=${issue.id}`,
    });
  });

  test("retrieves approved scoped memory during a real task-agent run", async ({ request }) => {
    const company = await seedCompany(request, `E2E-Memory-${Date.now()}`);
    const department = await createDepartment(request, company.id, `Software Live Context ${Date.now()}`);
    const unique = Date.now();
    const approvedToken = `APPROVED_LIVE_AGENT_SCOPE_MEMORY_${unique}`;
    const pendingToken = `PENDING_LIVE_AGENT_SCOPE_MEMORY_${unique}`;
    const outputToken = `LIVE_SCOPE_PROCESS_AGENT_${unique}`;

    const approvedMemory = await saveScopeMemory(
      request,
      company.id,
      "approved",
      "Approved live agent context rule",
      `Approved live task agents must retrieve ${approvedToken}.`,
      department.id,
    );
    const pendingMemory = await saveScopeMemory(
      request,
      company.id,
      "pending",
      "Pending live agent context rule",
      `Pending live task agents must not retrieve ${pendingToken}.`,
      department.id,
    );

    const agent = await hireProcessAgent(request, company.id, outputToken);
    await assignAgentToDepartment(request, company.id, department.id, agent.id);
    const issue = await createAssignedIssue(
      request,
      company.id,
      department.id,
      agent.id,
      "Run live scope memory retrieval proof",
      `Use the approved scoped memory token ${approvedToken}. Do not use pending token ${pendingToken}.`,
    );

    const wake = await wakeAgentForIssue(request, company.id, agent.id, issue.id);
    expect(wake.runId || wake.id).toBeTruthy();

    const completedRun = await waitForCompletedRun(request, issue.id);
    expect(["completed", "succeeded"]).toContain(completedRun.status);

    const retrievals = await waitForMemoryRetrievals(request, company.id, issue.id, approvedMemory.memoryId);
    expect(retrievals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemId: approvedMemory.memoryId, triggeredBy: "auto" }),
      ]),
    );
    expect(retrievals.some((row) => row.itemId === pendingMemory.memoryId)).toBe(false);

    test.info().annotations.push({
      type: "live-agent-proof",
      description: `/${company.issuePrefix}/issues?selected=${issue.id}`,
    });
  });

  test("saves an approved scoped memory candidate from the discussion viewer", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Memory-${Date.now()}`);
    const folderPath = `Scope Smoke ${Date.now()}`;
    const folder = await jsonOrThrow<{ path: string; displayName: string }>(
      await request.post(`/api/companies/${company.id}/memory/folders`, {
        data: {
          departmentId: null,
          path: folderPath,
          displayName: "Scope Smoke Folder",
        },
      }),
      "create memory folder",
    );
    const thread = await jsonOrThrow<{ id: string; title: string }>(
      await request.post(`/api/companies/${company.id}/discussions`, {
        data: { title: `Watched scope memory E2E ${Date.now()}` },
      }),
      "create discussion",
    );

    await jsonOrThrow(
      await request.post(`/api/companies/${company.id}/discussions/${thread.id}/entries`, {
        data: {
          inputType: "write",
          rawContent:
            "Decision: accepted scope versions are the durable handoff source of truth. Save this as scoped memory so future task agents can retrieve it before execution.",
        },
      }),
      "post discussion entry",
    );

    const draft = await jsonOrThrow<{ version: { id: string } }>(
      await request.post(`/api/companies/${company.id}/discussions/${thread.id}/scope-versions/draft`, {
        data: { mode: "generate" },
      }),
      "create scope draft",
    );
    const scope = await getScopeVersion(request, company.id, thread.id, draft.version.id);
    const memoryItem = scope.items.find((item) => item.kind === "memory_candidate");
    expect(memoryItem, "scope draft should contain a memory candidate").toBeTruthy();

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByRole("heading", { name: thread.title }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("center-tab-scope").click();
    await page.getByTestId(`scope-version-card-${memoryItem!.id}`).click();

    const viewer = page.getByTestId("thread-draft-memory-viewer");
    await expect(viewer).toBeVisible({ timeout: 10_000 });
    await expect(viewer).toContainText("Draft memory candidate");
    await expect(page.getByLabel("Category")).toBeVisible();
    await expect(page.getByLabel("Layer")).toBeVisible();
    await expect(page.getByLabel("Folder")).toBeVisible();

    await page.getByLabel("Draft memory title").fill("Accepted scope is the handoff source of truth");
    await page
      .getByLabel("Draft memory content")
      .fill("Agents should retrieve the accepted discussion scope before starting task execution.");
    await page.getByLabel("Category").selectOption({ label: "Decision" });
    await page.getByLabel("Layer").selectOption({ label: "Domain" });
    await page.getByLabel("Folder").selectOption(folder.path);
    await page.getByLabel("Memory priority").fill("3");
    await page.getByLabel("Memory tags").fill("scope, handoff, e2e");

    await page.getByRole("button", { name: /Save approved/i }).click();

    await expect(page.getByTestId("thread-viewer-memory")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("thread-viewer-memory")).toContainText("Decision");
    await expect(page.getByTestId("thread-viewer-memory")).toContainText("Domain (domain)");
    await expect(page.getByTestId("thread-viewer-memory")).toContainText(folder.displayName);

    const updatedScope = await getScopeVersion(request, company.id, thread.id, draft.version.id);
    const updatedItem = updatedScope.items.find((item) => item.id === memoryItem!.id);
    expect(updatedItem?.resultMemoryId, "scope item should point at the persisted memory").toBeTruthy();

    const memory = await jsonOrThrow<{
      title: string;
      status: string;
      category: string | null;
      layer: string | null;
      folderPath?: string | null;
      priority?: number | null;
      tags?: string[] | null;
    }>(
      await request.get(`/api/companies/${company.id}/memory/${updatedItem!.resultMemoryId}`),
      "get persisted memory",
    );
    expect(memory).toMatchObject({
      title: "Accepted scope is the handoff source of truth",
      status: "approved",
      category: "decision",
      layer: "domain",
      folderPath: folder.path,
      priority: 3,
    });
    expect(memory.tags).toEqual(expect.arrayContaining(["scope", "handoff", "e2e"]));

    test.info().annotations.push({ type: "thread-url", description: `/${company.issuePrefix}/discussions/${thread.id}` });
  });

  test("saves pending scoped memory and approves it from the viewer", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Memory-${Date.now()}`);
    const thread = await jsonOrThrow<{ id: string; title: string }>(
      await request.post(`/api/companies/${company.id}/discussions`, {
        data: { title: `Watched pending memory E2E ${Date.now()}` },
      }),
      "create discussion",
    );

    await jsonOrThrow(
      await request.post(`/api/companies/${company.id}/discussions/${thread.id}/entries`, {
        data: {
          inputType: "write",
          rawContent:
            "Decision: accepted scope versions are the durable handoff source of truth. Save this as scoped memory so future task agents can retrieve it before execution.",
        },
      }),
      "post discussion entry",
    );

    const draft = await jsonOrThrow<{ version: { id: string } }>(
      await request.post(`/api/companies/${company.id}/discussions/${thread.id}/scope-versions/draft`, {
        data: { mode: "generate" },
      }),
      "create scope draft",
    );
    const scope = await getScopeVersion(request, company.id, thread.id, draft.version.id);
    const memoryItem = scope.items.find((item) => item.kind === "memory_candidate");
    expect(memoryItem, "scope draft should contain a memory candidate").toBeTruthy();

    await page.goto(`/${company.issuePrefix}/discussions/${thread.id}`);
    await expect(page.getByRole("heading", { name: thread.title }).first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("center-tab-scope").click();
    await page.getByTestId(`scope-version-card-${memoryItem!.id}`).click();

    await expect(page.getByTestId("thread-draft-memory-viewer")).toBeVisible({ timeout: 10_000 });
    await page.getByLabel("Draft memory title").fill("Pending scope memory can be reviewed");
    await page
      .getByLabel("Draft memory content")
      .fill("Pending scope memory should stay out of trusted agent context until approved.");
    await page.getByLabel("Category").selectOption({ label: "Decision" });
    await page.getByLabel("Layer").selectOption({ label: "Domain" });

    await page.getByRole("button", { name: /Save pending/i }).click();
    await expect(page.getByTestId("thread-viewer-memory")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("thread-viewer-memory")).toContainText("Pending memory");

    const updatedScope = await getScopeVersion(request, company.id, thread.id, draft.version.id);
    const updatedItem = updatedScope.items.find((item) => item.id === memoryItem!.id);
    expect(updatedItem?.resultMemoryId, "scope item should point at the persisted memory").toBeTruthy();

    const pendingMemory = await jsonOrThrow<{ status: string }>(
      await request.get(`/api/companies/${company.id}/memory/${updatedItem!.resultMemoryId}`),
      "get pending memory",
    );
    expect(pendingMemory.status).toBe("pending");

    await page.getByRole("button", { name: /^Approve$/i }).click();
    await expect.poll(async () => {
      const memory = await jsonOrThrow<{ status: string }>(
        await request.get(`/api/companies/${company.id}/memory/${updatedItem!.resultMemoryId}`),
        "get approved memory",
      );
      return memory.status;
    }).toBe("approved");

    test.info().annotations.push({ type: "thread-url", description: `/${company.issuePrefix}/discussions/${thread.id}` });
  });
});
