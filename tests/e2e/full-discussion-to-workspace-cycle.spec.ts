import { expect, test, type APIRequestContext, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

type Company = { id: string; name: string; issuePrefix: string };
type Project = { id: string; name: string };
type Agent = { id: string; name: string };
type Issue = { id: string; identifier: string | null; title: string };
type ScopeVersionDetail = {
  id: string;
  versionNumber: number;
  status: string;
  summary: string;
  items: Array<{
    id: string;
    kind: string;
    title: string;
    description: string | null;
    payload: Record<string, unknown>;
    resultIssueId: string | null;
    resultMemoryId: string | null;
  }>;
};
type ExecutionWorkspace = { id: string; cwd: string | null; name: string; branchName?: string | null };
type RunForIssue = { runId?: string; id?: string; status: string };
type MemoryRetrieval = { itemId: string | null; itemTitle: string | null; triggeredBy: string; shownToAgent?: boolean };
type DetectedOutput = {
  runId: string;
  outputIndex: number;
  path: string;
  filename: string;
  status: string;
  assetId: string | null;
};
type GitStatus = {
  gitAvailable: boolean;
  clean: boolean;
  branch: string | null;
  ahead: number | null;
  files: Array<{ path: string; status: string }>;
};

const FINAL_RUN_STATUSES = new Set(["completed", "succeeded", "failed", "cancelled", "timed_out"]);

test.describe("full discussion to workspace cycle", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Full-Cycle-/);
  });

  test("drives a fresh discussion through crew discussion, scope, task, memory, workspace, artifact, branch, and context", async ({
    page,
    request,
  }, testInfo) => {
    const company = await seedCompany(request, `E2E-Full-Cycle-${Date.now()}`);
    await patchCompanyAutonomy(request, company.id, 1);
    const repo = await createTemporaryRepo(testInfo);
    const outputToken = `AOA_FULL_CYCLE_OUTPUT_${Date.now()}`;
    const department = await createSoftwareDepartment(request, company, repo.worktreeRoot);
    const processAgent = await hireProcessAgent(request, company.id, outputToken);
    await assignAgentToProject(request, company.id, department.id, processAgent.id);

    await page.goto(`/${company.issuePrefix}/discussions`);
    await expect(page.getByRole("heading", { name: /Discussions/i }).first()).toBeVisible({ timeout: 10_000 });

    const threadTitle = `Full cycle scope ${Date.now()}`;
    // W2: the compiler's fallback task title derives from the LONGEST non-empty entry
    // in the scoped range (derivedTitleFromEntries: first sentence, word-truncated to
    // 80 chars). The scoped range also contains fake-crew agent replies (~150 chars)
    // and the scope_proposal JSON entry (~320 chars), so this seeded opener is
    // deliberately padded to stay the longest entry — the derived task title is its
    // first sentence, regardless of how the server pool is filtered.
    const scopeOpener =
      "We need to plan a small software task from this messy discussion. " +
      "The final handoff must include memory, evidence, and a workspace artifact. " +
      "The crew should read the entire back and forth before anything is dispatched, " +
      "confirm the user need against the captured evidence, and keep the handoff deliberate. " +
      "Nothing should move until the review is finished, the constraints are understood, " +
      "and the founder has approved the draft in full. " +
      "That inspection pass, not speed, is what makes this pipeline trustworthy for the whole founding team.";
    // firstSentence(scopeOpener) — 64 chars, so no "..." truncation.
    const derivedTaskTitle = "We need to plan a small software task from this messy discussion";
    await createThreadFromUi(page, threadTitle, scopeOpener);
    const threadId = page.url().match(/\/discussions\/([^/?#]+)/)?.[1];
    expect(threadId).toBeTruthy();

    await patchThreadAutonomy(request, company.id, threadId!, 1);
    await page.reload();
    await expect(page.getByRole("heading", { name: threadTitle }).first()).toBeVisible({ timeout: 10_000 });

    await sendThreadMessage(
      page,
      "The user wants the central discussion to become real work only after we inspect the thread and approve the draft.",
    );
    await waitForAgentEntry(page, "Adjutant", /move this forward/i);

    await sendThreadMessage(
      page,
      "@Scout please validate the user need, constraints, and evidence before we create tracked work.",
    );
    await waitForAgentEntry(page, "Scout", /validate the user need/i);

    // Round-13 #2 regression guard: a MULTI-WORD crew agent ("Memory Keeper", an
    // auto-seeded Command Staff role) must be summonable from the composer. The
    // outbox enqueue (the sole summon path) previously ran the naive \w+ tokenizer,
    // truncating "@Memory Keeper" → "Memory", so the worker never resolved it and
    // the agent was silently never summoned. The single-word "@Scout" above did
    // NOT catch this. Kept SHORT so this never becomes the longest scoped entry
    // (which would change the derived task title asserted below).
    await sendThreadMessage(page, "@Memory Keeper note the constraints.");
    await waitForAgentEntry(page, "Memory Keeper", /reviewed the thread context|contribute/i);

    await sendThreadMessage(
      page,
      "Please keep the summary current, then scope this into a task and memory candidate.",
    );

    const proposalCard = page.getByTestId("scope-proposal-card").first();
    await expect(proposalCard).toBeVisible({ timeout: 75_000 });
    await expect(proposalCard.getByRole("button", { name: /^start scoping$/i })).toBeVisible();

    await page.getByTestId("center-tab-scope").click();
    await expect(page.getByTestId("scope-draft-cta")).toContainText(/Conversation summary|Scope/i);
    await page.getByRole("button", { name: /^create scope draft$/i }).click();
    await expect(page.getByTestId("scope-version-package")).toContainText("Scope v1", { timeout: 10_000 });
    await expect(page.getByTestId("scope-version-package")).toContainText(/small software task|real work/i);
    await expect(page.getByTestId("scope-version-package")).toContainText("Task proposals");
    await expect(page.getByTestId("scope-version-package")).toContainText("Memory candidates");

    const scope = await latestScopeVersionDetail(request, company.id, threadId!);
    expect(scope).toMatchObject({ versionNumber: 1, status: "draft" });
    expect(scope.summary).toMatch(/small software task|real work/i);
    const taskItem = scope.items.find((item) => item.kind === "task_proposal");
    const memoryItem = scope.items.find((item) => item.kind === "memory_candidate");
    expect(taskItem, "scope draft should include a task proposal").toBeTruthy();
    expect(memoryItem, "scope draft should include a memory candidate").toBeTruthy();
    expect(taskItem!.payload).toMatchObject({ priority: expect.any(String) });
    expect(memoryItem!.payload).toMatchObject({ layer: expect.any(String), category: expect.any(String) });
    // W2 contract: the fallback task title is the first sentence of the longest
    // scoped entry (the padded opener above) — the keyword stubs are dead.
    expect(taskItem!.title).toBe(derivedTaskTitle);

    await page
      .getByTestId(`scope-version-card-${taskItem!.id}`)
      .getByRole("button", { name: /^review task$/i })
      .click();
    await expect(page.getByTestId("thread-draft-task-workbench")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("thread-draft-task-workbench")).toContainText(/Task draft|Task setup/i);
    await expect(page.getByTestId("thread-draft-task-workbench")).toContainText("Scope handoff");

    await page.getByTestId("center-tab-scope").click();
    await page
      .getByTestId(`scope-version-card-${memoryItem!.id}`)
      .getByRole("button", { name: /^review memory$/i })
      .click();
    await expect(page.getByTestId("thread-draft-memory-viewer")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("thread-draft-memory-viewer")).toContainText(/Draft memory candidate|Memory placement/i);
    await expect(page.getByRole("button", { name: /Save approved/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Save pending/i })).toBeVisible();

    const saveMemoryResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/scope-versions/${scope.id}/items/${memoryItem!.id}/create`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /Save approved/i }).click();
    expect((await saveMemoryResponse).ok()).toBe(true);

    await page.getByTestId("center-tab-scope").click();
    await page
      .getByTestId(`scope-version-card-${taskItem!.id}`)
      .getByRole("button", { name: /^review task$/i })
      .click();
    const createTaskResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/scope-versions/${scope.id}/items/${taskItem!.id}/create`) &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /^create task$/i }).click();
    expect((await createTaskResponse).ok()).toBe(true);

    const created = await waitForScopeResults(request, company.id, threadId!, scope.id, taskItem!.id, memoryItem!.id);

    await page.reload();
    await page.getByTestId("center-tab-scope").click();
    await expect(page.getByTestId("scope-version-package")).toContainText(/applied|Applied|Partially applied/, {
      timeout: 10_000,
    });
    await page.getByTestId(`scope-version-card-${taskItem!.id}`).click();
    await expect(page.getByTestId("task-detail-panel")).toBeVisible({ timeout: 10_000 });

    await jsonOrThrow<Issue>(
      await request.patch(`/api/issues/${created.issueId}?companyId=${company.id}`, {
        data: {
          projectId: department.id,
          assigneeAgentId: processAgent.id,
          status: "backlog",
          workMode: "standard",
          description: `Run the full-cycle task and create workspace-summary.md containing ${outputToken}.`,
        },
      }),
      "assign UI-created task to process agent",
    );

    await jsonOrThrow(
      await request.post(`/api/agents/${processAgent.id}/wakeup?companyId=${company.id}`, {
        data: {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "full_discussion_cycle_e2e",
          payload: { issueId: created.issueId },
        },
      }),
      "wake process agent",
    );

    const run = await waitForCompletedRun(request, created.issueId);
    expect(["completed", "succeeded"]).toContain(run.status);

    const workspace = await waitForExecutionWorkspace(request, company.id, created.issueId);
    expect(workspace.cwd).toBeTruthy();
    await expectFileContains(workspace.cwd!, "workspace-summary.md", outputToken);
    await expectFileContains(workspace.cwd!, path.join("src", "app.ts"), outputToken);

    const contextPackage = await jsonOrThrow<{ markdown: string }>(
      await request.get(`/api/companies/${company.id}/issues/${created.issueId}/context-package`),
      "get context package",
    );
    expect(contextPackage.markdown).toContain("## Scope Handoff");
    expect(contextPackage.markdown).toContain("Source message");
    const retrievals = await waitForMemoryRetrieval(request, company.id, created.issueId, created.memoryId);
    expect(
      retrievals.some(
        (row) => row.itemTitle === memoryItem!.title && row.triggeredBy === "auto" && row.shownToAgent !== false,
      ),
    ).toBe(true);

    const outputs = await waitForDetectedOutput(request, created.issueId, "workspace-summary.md");
    const summaryOutput = outputs.find((output) => output.path === "workspace-summary.md")!;
    expect(summaryOutput.assetId).toBeTruthy();

    const confirmedArtifact = await jsonOrThrow<{ artifactId: string; versionId: string; status: string }>(
      await request.post(`/api/heartbeat-runs/${summaryOutput.runId}/detected-outputs/${summaryOutput.outputIndex}/confirm`, {
        data: {
          title: "workspace-summary.md",
          type: "document",
          changelog: "Confirmed by full discussion cycle e2e",
        },
      }),
      "confirm detected output",
    );
    expect(confirmedArtifact.artifactId).toBeTruthy();

    await page.goto(`/${company.issuePrefix}/workspaces/${workspace.id}`);
    await page.getByRole("button", { name: derivedTaskTitle }).click();
    await expect(page.getByTestId("workspace-right-panel-expanded")).toBeVisible({ timeout: 10_000 });
    await expandSection(page, "process");
    await expect(page.getByTestId("process-section")).toContainText(processAgent.name);
    await expandSection(page, "git");
    await expect(page.getByTestId("git-panel")).toContainText("workspace-summary.md", { timeout: 10_000 });
    await expandSection(page, "artifacts");
    await expect(page.getByTestId("artifacts-list")).toContainText("workspace-summary.md", { timeout: 10_000 });

    await jsonOrThrow(
      await request.post(`/api/execution-workspaces/${workspace.id}/git/commit`, {
        data: {
          message: "test: commit full discussion cycle output",
          files: ["workspace-summary.md", "src/app.ts"],
        },
      }),
      "commit workspace files",
    );

    const cleanStatus = await waitForGitStatus(request, workspace.id, (status) => status.gitAvailable && status.clean);
    expect(cleanStatus.branch).toBeTruthy();

    await jsonOrThrow(
      await request.post(`/api/execution-workspaces/${workspace.id}/git/push`, { data: {} }),
      "push workspace branch",
    );
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

async function sendThreadMessage(page: Page, text: string): Promise<void> {
  const composer = page.getByTestId("entry-composer-textarea");
  await expect(composer).toBeVisible({ timeout: 10_000 });
  await composer.fill(text);
  await page.getByTestId("entry-composer-submit").click();
  await expect(page.locator('[data-testid^="entry-row-"]').filter({ hasText: text }).first()).toBeVisible({
    timeout: 10_000,
  });
}

async function waitForAgentEntry(page: Page, agentName: string, text: RegExp): Promise<void> {
  await expect(
    page
      .locator('[data-testid^="entry-row-"][data-entry-type="agent"]')
      .filter({ hasText: agentName })
      .filter({ hasText: text })
      .first(),
  ).toBeVisible({ timeout: 75_000 });
}

async function patchThreadAutonomy(request: APIRequestContext, companyId: string, threadId: string, autonomyLevel: number) {
  await jsonOrThrow(
    await request.patch(`/api/companies/${companyId}/discussions/${threadId}`, {
      data: { autonomyLevel },
    }),
    "set thread autonomy",
  );
}

async function patchCompanyAutonomy(request: APIRequestContext, companyId: string, autonomyLevel: number) {
  await jsonOrThrow(
    await request.patch(`/api/companies/${companyId}/internal-agent/config`, {
      // D18: crew/thread flows read `crewAutonomyLevel`; Commander's
      // `autonomyLevel` is a separate dial and would not move this test.
      data: { crewAutonomyLevel: autonomyLevel },
    }),
    "set company crew autonomy",
  );
}

async function latestScopeVersionDetail(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
): Promise<ScopeVersionDetail> {
  const versions = await jsonOrThrow<{ versions: Array<{ id: string; versionNumber: number; status: string }> }>(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions`),
    "list scope versions",
  );
  const latest = versions.versions[0];
  expect(latest).toBeTruthy();
  return jsonOrThrow(
    await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions/${latest.id}`),
    "get latest scope version",
  );
}

async function waitForScopeResults(
  request: APIRequestContext,
  companyId: string,
  threadId: string,
  scopeVersionId: string,
  taskItemId: string,
  memoryItemId: string,
) {
  return poll(
    async () => {
      const detail = await jsonOrThrow<ScopeVersionDetail>(
        await request.get(`/api/companies/${companyId}/discussions/${threadId}/scope-versions/${scopeVersionId}`),
        "poll scope results",
      );
      const task = detail.items.find((item) => item.id === taskItemId);
      const memory = detail.items.find((item) => item.id === memoryItemId);
      return {
        issueId: task?.resultIssueId ?? null,
        memoryId: memory?.resultMemoryId ?? null,
      };
    },
    (result): result is { issueId: string; memoryId: string } => Boolean(result.issueId && result.memoryId),
    "scope items to create task and memory",
    15_000,
  );
}

async function createTemporaryRepo(testInfo: TestInfo) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aoa-full-cycle-${testInfo.workerIndex}-`));
  const worktreeRoot = path.join(root, "repo");
  const remoteRoot = path.join(root, "remote.git");
  await fs.mkdir(path.join(worktreeRoot, "src"), { recursive: true });
  git(worktreeRoot, ["init"]);
  git(worktreeRoot, ["checkout", "-B", "main"]);
  git(worktreeRoot, ["config", "user.email", "e2e@example.test"]);
  git(worktreeRoot, ["config", "user.name", "AoA E2E"]);
  await fs.writeFile(path.join(worktreeRoot, "README.md"), "# AoA Full Cycle E2E\n");
  await fs.writeFile(path.join(worktreeRoot, "src", "app.ts"), "export const appName = 'AoA Full Cycle E2E';\n");
  await fs.writeFile(
    path.join(worktreeRoot, "package.json"),
    JSON.stringify({ scripts: { test: "node -e \"console.log('ok')\"" } }, null, 2),
  );
  git(worktreeRoot, ["add", "."]);
  git(worktreeRoot, ["commit", "-m", "initial full cycle e2e repo"]);
  execFileSync("git", ["init", "--bare", remoteRoot], { stdio: "pipe" });
  git(worktreeRoot, ["remote", "add", "origin", remoteRoot]);
  git(worktreeRoot, ["push", "-u", "origin", "main"]);
  return { worktreeRoot, remoteRoot };
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function createSoftwareDepartment(request: APIRequestContext, company: Company, cwd: string): Promise<Project> {
  return jsonOrThrow<Project>(
    await request.post(`/api/companies/${company.id}/projects`, {
      data: {
        name: "Software Full Cycle",
        type: "department",
        status: "in_progress",
        description: "Full discussion-to-workspace E2E department",
        functionType: "software_development",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "isolated_workspace",
          allowIssueOverride: true,
          workspaceStrategy: {
            type: "git_worktree",
            baseRef: "main",
            branchTemplate: "{{issue.identifier}}-full-cycle-e2e",
          },
        },
        workspace: {
          name: "Full cycle e2e repo",
          cwd,
          repoRef: "main",
          isPrimary: true,
        },
      },
    }),
    "create software department",
  );
}

async function hireProcessAgent(request: APIRequestContext, companyId: string, outputToken: string): Promise<Agent> {
  const script =
    "f=require('fs');p=require('path');nl=String.fromCharCode(10);t=process.env.AOA_OUTPUT_TOKEN;" +
    "f.mkdirSync('src',{recursive:true});" +
    "f.appendFileSync(p.join('src','app.ts'),nl+'//full-cycle:'+t+nl);" +
    "f.writeFileSync('workspace-summary.md',['#FullCycleHandoff','',t,''].join(nl));" +
    "console.log('created_workspace-summary.md_'+t)";

  const body = await jsonOrThrow<{ agent: Agent }>(
    await request.post(`/api/companies/${companyId}/agent-hires`, {
      data: {
        name: "E2E Full Cycle Process Agent",
        role: "general",
        title: "E2E Full Cycle Process Agent",
        adapterType: "process",
        runtimeConfig: {
          injectCompanyContext: true,
          contextMode: "standard",
          autoRunSummary: true,
        },
        adapterConfig: {
          command: "node",
          args: ["-e", script],
          env: { AOA_OUTPUT_TOKEN: outputToken },
          timeoutSec: 20,
        },
      },
    }),
    "hire process agent",
  );
  return body.agent;
}

async function assignAgentToProject(
  request: APIRequestContext,
  companyId: string,
  projectId: string,
  agentId: string,
) {
  await jsonOrThrow(
    await request.post(`/api/projects/${projectId}/agents?companyId=${companyId}`, {
      data: { agentId },
    }),
    "assign agent to project",
  );
}

async function waitForCompletedRun(request: APIRequestContext, issueId: string) {
  return poll(
    async () => {
      const runs = await jsonOrThrow<RunForIssue[]>(await request.get(`/api/issues/${issueId}/runs`), "list issue runs");
      return runs[0] ?? null;
    },
    (run): run is RunForIssue => Boolean(run && FINAL_RUN_STATUSES.has(run.status)),
    "process run completion",
    120_000,
  );
}

async function waitForExecutionWorkspace(request: APIRequestContext, companyId: string, issueId: string) {
  return poll(
    async () => {
      const workspaces = await jsonOrThrow<ExecutionWorkspace[]>(
        await request.get(`/api/companies/${companyId}/execution-workspaces?issueId=${issueId}`),
        "list execution workspaces",
      );
      const taskOwnedWorkspace = workspaces.find((candidate) => candidate.cwd) ?? null;
      if (taskOwnedWorkspace) return taskOwnedWorkspace;

      const issue = await jsonOrThrow<Issue & { executionWorkspaceId?: string | null }>(
        await request.get(`/api/issues/${issueId}`),
        "get issue workspace link",
      );
      if (!issue.executionWorkspaceId) return null;
      return jsonOrThrow<ExecutionWorkspace>(
        await request.get(`/api/execution-workspaces/${issue.executionWorkspaceId}`),
        "get linked execution workspace",
      );
    },
    (workspace): workspace is ExecutionWorkspace => Boolean(workspace),
    "execution workspace",
    60_000,
  );
}

async function waitForMemoryRetrieval(
  request: APIRequestContext,
  companyId: string,
  issueId: string,
  memoryItemId: string,
) {
  return poll(
    async () =>
      jsonOrThrow<MemoryRetrieval[]>(
        await request.get(`/api/companies/${companyId}/issues/${issueId}/memory-retrievals?limit=100`),
        "list memory retrievals",
      ),
    (rows) => rows.some((row) => row.itemId === memoryItemId && row.triggeredBy === "auto"),
    "memory retrieval audit row",
    60_000,
  );
}

async function waitForDetectedOutput(request: APIRequestContext, issueId: string, pathToFind: string) {
  return poll(
    async () =>
      jsonOrThrow<DetectedOutput[]>(
        await request.get(`/api/issues/${issueId}/detected-outputs`),
        "list detected outputs",
      ),
    (rows) => rows.some((row) => row.path === pathToFind && row.status === "pending"),
    "detected output",
    60_000,
  );
}

async function waitForGitStatus(
  request: APIRequestContext,
  workspaceId: string,
  predicate: (status: GitStatus) => boolean,
) {
  return poll(
    async () =>
      jsonOrThrow<GitStatus>(
        await request.get(`/api/execution-workspaces/${workspaceId}/git/status`),
        "get git status",
      ),
    predicate,
    "git status",
    60_000,
  );
}

async function expandSection(page: Page, id: string) {
  await page.getByTestId(`cockpit-section-trigger-${id}`).click();
}

async function expectFileContains(cwd: string, relativePath: string, token: string) {
  const content = await fs.readFile(path.join(cwd, relativePath), "utf8");
  expect(content).toContain(token);
}

async function jsonOrThrow<T = unknown>(res: APIResponse, label: string): Promise<T> {
  if (!res.ok()) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`${label} failed: ${res.status()} ${text}`);
  }
  return (await res.json()) as T;
}

async function poll<T, S extends T>(
  fn: () => Promise<T>,
  predicate: (value: T) => value is S,
  label: string,
  timeoutMs: number,
): Promise<S>;
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number,
): Promise<T>;
async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number,
) {
  const startedAt = Date.now();
  let lastValue: T | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await fn();
    if (predicate(lastValue)) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}
