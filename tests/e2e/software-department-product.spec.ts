import { expect, test, type APIRequestContext, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

type Company = { id: string; name: string; issuePrefix: string };
type Project = { id: string; name: string };
type Agent = { id: string; name: string };
type Issue = { id: string; identifier: string | null; title: string };
type MemoryItem = { id: string; title: string };
type RunForIssue = { runId: string; status: string; detectedOutputs?: unknown };
type ExecutionWorkspace = { id: string; cwd: string | null; name: string; branchName?: string | null };
type MemoryRetrieval = { itemId: string | null; itemTitle: string | null; triggeredBy: string };
type RuntimeService = {
  id: string;
  serviceName: string;
  status: string;
  url: string | null;
  previewUrl: string | null;
  localTargetUrl: string | null;
  provider?: string | null;
  command?: string | null;
};
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
  remote: { name: string; fetchUrl: string | null; pushUrl: string | null } | string | null;
  ahead: number | null;
  behind: number | null;
  files: Array<{ path: string; status: string }>;
};
type WorkspaceRuntimeConfig = Record<string, unknown>;

const FINAL_RUN_STATUSES = new Set(["completed", "succeeded", "failed", "cancelled", "timed_out"]);

test.describe("software department product workspace journey", () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Test-Software-Product-/);
  });

  test("runs a real agent task and shows memory, artifacts, and git in the workspace sidebar", async ({
    page,
    request,
  }, testInfo) => {
    const repo = await createTemporaryRepo(testInfo);
    const company = await seedCompany(request, `E2E-Test-Software-Product-${Date.now()}`);
    const unique = Date.now();
    const memoryToken = `AOA_MEMORY_PRODUCT_E2E_${unique}`;
    const outputToken = `AOA_OUTPUT_PRODUCT_E2E_${unique}`;

    const project = await createSoftwareDepartment(request, company, repo.worktreeRoot, productWorkspaceRuntime());
    const memory = await createDepartmentMemory(request, company.id, project.id, memoryToken);
    const agent = await hireProcessAgent(request, company.id, outputToken);
    await assignAgentToProject(request, company.id, project.id, agent.id);
    const issue = await createSoftwareIssue(request, company.id, project.id, agent.id, memoryToken, outputToken);

    const wakeRun = await wakeAgentForIssue(request, company.id, agent.id, issue.id);
    expect(wakeRun.runId || wakeRun.id).toBeTruthy();

    const completedRun = await waitForCompletedRun(request, issue.id);
    expect(["completed", "succeeded"]).toContain(completedRun.status);

    const workspace = await waitForExecutionWorkspace(request, company.id, issue.id);
    expect(workspace.cwd).toBeTruthy();
    await expectFileContains(workspace.cwd!, "workspace-summary.md", outputToken);
    await expectFileContains(workspace.cwd!, path.join("src", "app.ts"), outputToken);

    const retrievals = await waitForMemoryRetrieval(request, company.id, issue.id, memory.id);
    expect(retrievals.some((row) => row.itemTitle === memory.title && row.triggeredBy === "auto")).toBe(true);

    const outputs = await waitForDetectedOutput(request, issue.id, "workspace-summary.md");
    const summaryOutput = outputs.find((output) => output.path === "workspace-summary.md");
    expect(summaryOutput?.status).toBe("pending");
    expect(summaryOutput?.assetId).toBeTruthy();

    const confirmedArtifact = await confirmDetectedOutput(request, summaryOutput!);
    expect(confirmedArtifact.artifactId).toBeTruthy();

    const service = await waitForRuntimeService(request, workspace.id, (candidate) => candidate.provider === "local_process");
    expect(service.command).toBeTruthy();
    expect(service.url).toBeTruthy();

    const dirtyStatus = await waitForGitStatus(request, workspace.id, (status) =>
      status.gitAvailable &&
      !status.clean &&
      status.files.some((file) => file.path === "workspace-summary.md") &&
      status.files.some((file) => file.path === "src/app.ts"),
    );
    expect(remoteName(dirtyStatus.remote)).toBe("origin");

    await assertWorkspaceSidebar(page, company, workspace, {
      agentName: agent.name,
      memoryTitle: memory.title,
      outputFilename: "workspace-summary.md",
      serviceName: service.serviceName,
    });
    await assertWorkspaceViewers(page, company, workspace, {
      artifactTitle: "workspace-summary.md",
      outputToken,
      serviceName: service.serviceName,
      // UI shows the AoA-origin proxy path, not the raw loopback URL.
      serviceUrl: service.previewUrl!,
    });

    const stopServiceRes = await request.post(`/api/execution-workspaces/${workspace.id}/runtime-services/stop`, {
      data: { runtimeServiceId: service.id },
    });
    await jsonOrThrow(stopServiceRes, "stop e2e runtime service");

    const commitRes = await request.post(`/api/execution-workspaces/${workspace.id}/git/commit`, {
      data: {
        message: "test: commit software product e2e output",
        files: ["workspace-summary.md", "src/app.ts"],
      },
    });
    const commit = await jsonOrThrow<{ filesCommitted: string[] }>(commitRes, "commit workspace changes");
    expect(commit.filesCommitted).toEqual(expect.arrayContaining(["workspace-summary.md", "src/app.ts"]));

    const aheadStatus = await waitForGitStatus(request, workspace.id, (status) =>
      status.gitAvailable && status.clean,
    );
    expect(aheadStatus.clean).toBe(true);

    const pushRes = await request.post(`/api/execution-workspaces/${workspace.id}/git/push`, { data: {} });
    await jsonOrThrow(pushRes, "push workspace branch");

    const pushedStatus = await waitForGitStatus(request, workspace.id, (status) =>
      status.gitAvailable && status.clean,
    );
    expect(pushedStatus.clean).toBe(true);
  });

  test("detects a real agent-created localhost app as an open-only workspace preview", async ({
    page,
    request,
  }, testInfo) => {
    const repo = await createTemporaryRepo(testInfo);
    const company = await seedCompany(request, `E2E-Test-Software-Product-${Date.now()}`);
    const unique = Date.now();
    const previewPort = await allocateLoopbackPort();
    const previewToken = `AOA_APP_PREVIEW_E2E_${unique}`;

    const project = await createSoftwareDepartment(request, company, repo.worktreeRoot);
    const agent = await hireProcessPreviewAgent(request, company.id, previewPort, previewToken);
    await assignAgentToProject(request, company.id, project.id, agent.id);
    const issue = await createPreviewIssue(request, company.id, project.id, agent.id, previewToken);

    const wakeRun = await wakeAgentForIssue(request, company.id, agent.id, issue.id);
    expect(wakeRun.runId || wakeRun.id).toBeTruthy();

    const completedRun = await waitForCompletedRun(request, issue.id);
    expect(["completed", "succeeded"]).toContain(completedRun.status);

    const workspace = await waitForExecutionWorkspace(request, company.id, issue.id);
    const previewUrl = `http://127.0.0.1:${previewPort}/`;
    const service = await waitForRuntimeService(request, workspace.id, (candidate) =>
      candidate.url === previewUrl && candidate.provider === "adapter_managed",
    );
    expect(service.command).toBeNull();

    const response = await page.request.get(previewUrl);
    expect(await response.text()).toContain(previewToken);

    await assertPreviewOnlyServiceOpensBrowser(page, company, workspace, service, previewUrl);
  });
});

async function createTemporaryRepo(testInfo: TestInfo) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aoa-sw-e2e-${testInfo.workerIndex}-`));
  const worktreeRoot = path.join(root, "repo");
  const remoteRoot = path.join(root, "remote.git");
  await fs.mkdir(path.join(worktreeRoot, "src"), { recursive: true });
  git(worktreeRoot, ["init"]);
  git(worktreeRoot, ["checkout", "-B", "main"]);
  git(worktreeRoot, ["config", "user.email", "e2e@example.test"]);
  git(worktreeRoot, ["config", "user.name", "AoA E2E"]);
  await fs.writeFile(
    path.join(worktreeRoot, "package.json"),
    JSON.stringify({ scripts: { test: "node -e \"console.log('ok')\"" } }, null, 2),
  );
  await fs.writeFile(path.join(worktreeRoot, "README.md"), "# AoA Software Product E2E\n");
  await fs.writeFile(path.join(worktreeRoot, "src", "app.ts"), "export const appName = 'AoA E2E';\n");
  await fs.writeFile(
    path.join(worktreeRoot, "service-server.js"),
    "require('http').createServer((_req,res)=>res.end('AoA software e2e service')).listen(process.env.PORT);\n",
  );
  await fs.writeFile(
    path.join(worktreeRoot, "preview-child-server.js"),
    [
      "const http = require('http');",
      "const port = Number(process.env.AOA_PREVIEW_PORT);",
      "const token = process.env.AOA_PREVIEW_TOKEN || '';",
      "const server = http.createServer((_req, res) => {",
      "  res.writeHead(200, { 'content-type': 'text/plain' });",
      "  res.end(token);",
      "});",
      "server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`));",
      "setTimeout(() => server.close(() => process.exit(0)), 120000);",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(worktreeRoot, "preview-runner.js"),
    [
      "const cp = require('child_process');",
      "const http = require('http');",
      "const path = require('path');",
      "const port = Number(process.env.AOA_PREVIEW_PORT);",
      "const url = `http://127.0.0.1:${port}/`;",
      "const child = cp.spawn(process.execPath, [path.join(__dirname, 'preview-child-server.js')], {",
      "  detached: true,",
      "  stdio: 'ignore',",
      "  env: process.env,",
      "});",
      "child.unref();",
      "const deadline = Date.now() + 20000;",
      "function probe() {",
      "  const req = http.get(url, (res) => {",
      "    res.resume();",
      "    console.log(`AOA_PREVIEW_URL=${url}`);",
      "    process.exit(0);",
      "  });",
      "  req.on('error', () => {",
      "    if (Date.now() < deadline) setTimeout(probe, 100);",
      "    else process.exit(1);",
      "  });",
      "  req.setTimeout(500, () => req.destroy());",
      "}",
      "probe();",
      "",
    ].join("\n"),
  );
  git(worktreeRoot, ["add", "."]);
  git(worktreeRoot, ["commit", "-m", "initial software e2e repo"]);
  execFileSync("git", ["init", "--bare", remoteRoot], { stdio: "pipe" });
  git(worktreeRoot, ["remote", "add", "origin", remoteRoot]);
  git(worktreeRoot, ["push", "-u", "origin", "main"]);
  return { worktreeRoot, remoteRoot };
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function createSoftwareDepartment(
  request: APIRequestContext,
  company: Company,
  cwd: string,
  workspaceRuntime?: WorkspaceRuntimeConfig,
) {
  const res = await request.post(`/api/companies/${company.id}/projects`, {
    data: {
      name: "Engineering Product E2E",
      type: "department",
      status: "in_progress",
      functionType: "software_development",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace",
        allowIssueOverride: true,
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "main",
          branchTemplate: "{{issue.identifier}}-product-e2e",
        },
        ...(workspaceRuntime ? { workspaceRuntime } : {}),
      },
      workspace: {
        name: "Local software product repo",
        cwd,
        repoRef: "main",
        isPrimary: true,
      },
    },
  });
  return jsonOrThrow<Project>(res, "create software department");
}

function productWorkspaceRuntime(): WorkspaceRuntimeConfig {
  return {
    services: [
      {
        name: "web",
        command: "node service-server.js",
        lifecycle: "shared",
        reuseScope: "execution_workspace",
        port: { type: "auto", envKey: "PORT" },
        expose: { urlTemplate: "http://127.0.0.1:{{port}}" },
        readiness: {
          type: "http",
          urlTemplate: "http://127.0.0.1:{{port}}",
          timeoutSec: 10,
          intervalMs: 250,
        },
        stopPolicy: { type: "manual" },
      },
    ],
  };
}

async function createDepartmentMemory(
  request: APIRequestContext,
  companyId: string,
  departmentId: string,
  token: string,
) {
  const res = await request.post(`/api/companies/${companyId}/memory`, {
    data: {
      title: `Software product E2E memory ${token}`,
      content: `When running the software product E2E task, remember ${token}.`,
      category: "reference",
      source: "founder",
      status: "approved",
      departmentId,
      layer: "domain",
      visibility: "scoped",
      priority: 100,
      tags: ["software-product-e2e"],
    },
  });
  return jsonOrThrow<MemoryItem>(res, "create department memory");
}

async function hireProcessAgent(request: APIRequestContext, companyId: string, outputToken: string) {
  const script =
    "f=require('fs');p=require('path');t=process.env.AOA_OUTPUT_TOKEN;" +
    "f.mkdirSync('src',{recursive:true});" +
    "f.appendFileSync(p.join('src','app.ts'),'\\n//'+t+'\\n');" +
    "f.writeFileSync('workspace-summary.md',t+'\\n');" +
    "console.log(t)";

  const res = await request.post(`/api/companies/${companyId}/agent-hires`, {
    data: {
      name: "E2E Process Software Agent",
      role: "general",
      title: "E2E Process Software Agent",
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
        timeoutSec: 60,
      },
    },
  });
  const body = await jsonOrThrow<{ agent: Agent }>(res, "hire process agent");
  return body.agent;
}

async function hireProcessPreviewAgent(
  request: APIRequestContext,
  companyId: string,
  previewPort: number,
  previewToken: string,
) {
  const res = await request.post(`/api/companies/${companyId}/agent-hires`, {
    data: {
      name: "E2E Process Preview Agent",
      role: "general",
      title: "E2E Process Preview Agent",
      adapterType: "process",
      runtimeConfig: {
        aoaAppPreviews: true,
        autoRunSummary: true,
      },
      adapterConfig: {
        command: "node",
        args: ["preview-runner.js"],
        env: {
          AOA_PREVIEW_PORT: String(previewPort),
          AOA_PREVIEW_TOKEN: previewToken,
        },
        timeoutSec: 60,
      },
    },
  });
  const body = await jsonOrThrow<{ agent: Agent }>(res, "hire process preview agent");
  return body.agent;
}

async function assignAgentToProject(
  request: APIRequestContext,
  companyId: string,
  projectId: string,
  agentId: string,
) {
  const res = await request.post(`/api/projects/${projectId}/agents?companyId=${companyId}`, {
    data: { agentId },
  });
  await jsonOrThrow(res, "assign agent to project");
}

async function createSoftwareIssue(
  request: APIRequestContext,
  companyId: string,
  projectId: string,
  agentId: string,
  memoryToken: string,
  outputToken: string,
) {
  const res = await request.post(`/api/companies/${companyId}/issues`, {
    data: {
      projectId,
      title: "Run software product E2E task",
      description:
        `Use the software department memory containing ${memoryToken}. ` +
        `Create workspace-summary.md and update src/app.ts with ${outputToken}.`,
      status: "backlog",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    },
  });
  return jsonOrThrow<Issue>(res, "create software issue");
}

async function createPreviewIssue(
  request: APIRequestContext,
  companyId: string,
  projectId: string,
  agentId: string,
  previewToken: string,
) {
  const res = await request.post(`/api/companies/${companyId}/issues`, {
    data: {
      projectId,
      title: "Run software app preview E2E task",
      description: `Start a localhost preview app that serves ${previewToken}.`,
      status: "backlog",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    },
  });
  return jsonOrThrow<Issue>(res, "create app preview issue");
}

async function wakeAgentForIssue(
  request: APIRequestContext,
  companyId: string,
  agentId: string,
  issueId: string,
) {
  const res = await request.post(`/api/agents/${agentId}/wakeup?companyId=${companyId}`, {
    data: {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "software_product_e2e",
      payload: { issueId },
    },
  });
  return jsonOrThrow<{ id?: string; runId?: string; status: string }>(res, "wake process agent");
}

async function waitForCompletedRun(request: APIRequestContext, issueId: string) {
  return poll(
    async () => {
      const res = await request.get(`/api/issues/${issueId}/runs`);
      const runs = await jsonOrThrow<RunForIssue[]>(res, "list issue runs");
      return runs[0] ?? null;
    },
    (run): run is RunForIssue => Boolean(run && FINAL_RUN_STATUSES.has(run.status)),
    "heartbeat run to finish",
    120_000,
  );
}

async function waitForExecutionWorkspace(request: APIRequestContext, companyId: string, issueId: string) {
  return poll(
    async () => {
      const res = await request.get(`/api/companies/${companyId}/execution-workspaces?issueId=${issueId}`);
      const workspaces = await jsonOrThrow<ExecutionWorkspace[]>(res, "list execution workspaces");
      return workspaces.find((workspace) => workspace.cwd) ?? null;
    },
    (workspace): workspace is ExecutionWorkspace => Boolean(workspace),
    "execution workspace to be realized",
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
    async () => {
      const res = await request.get(`/api/companies/${companyId}/issues/${issueId}/memory-retrievals?limit=100`);
      return jsonOrThrow<MemoryRetrieval[]>(res, "list memory retrievals");
    },
    (rows) => rows.some((row) => row.itemId === memoryItemId && row.triggeredBy === "auto"),
    "memory retrieval audit row",
    60_000,
  );
}

async function waitForDetectedOutput(request: APIRequestContext, issueId: string, pathToFind: string) {
  return poll(
    async () => {
      const res = await request.get(`/api/issues/${issueId}/detected-outputs`);
      return jsonOrThrow<DetectedOutput[]>(res, "list detected outputs");
    },
    (outputs) => outputs.some((output) => output.path === pathToFind && output.status === "pending"),
    "detected workspace output",
    60_000,
  );
}

async function confirmDetectedOutput(request: APIRequestContext, output: DetectedOutput) {
  const res = await request.post(`/api/heartbeat-runs/${output.runId}/detected-outputs/${output.outputIndex}/confirm`, {
    data: {
      title: output.filename,
      type: "document",
      changelog: "Confirmed by software product e2e viewer test",
    },
  });
  return jsonOrThrow<{ artifactId: string; versionId: string; status: string }>(res, "confirm detected output");
}

async function waitForRuntimeService(
  request: APIRequestContext,
  workspaceId: string,
  predicate: (service: RuntimeService) => boolean = (service) => service.status === "running" && Boolean(service.url),
) {
  return poll(
    async () => {
      const res = await request.get(`/api/execution-workspaces/${workspaceId}/runtime-services`);
      const services = await jsonOrThrow<RuntimeService[]>(res, "list workspace runtime services");
      return services.find((service) => service.status === "running" && Boolean(service.url) && predicate(service)) ?? null;
    },
    (service): service is RuntimeService => Boolean(service),
    "running workspace runtime service",
    60_000,
  );
}

async function assertPreviewOnlyServiceOpensBrowser(
  page: Page,
  company: Company,
  workspace: ExecutionWorkspace,
  service: RuntimeService,
  previewUrl: string,
) {
  await page.goto(`/${company.issuePrefix}/workspaces/${workspace.id}`);
  await expandSection(page, "services");
  const row = page.getByTestId(`service-row-${service.id}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Preview");
  await expect(row).toContainText(`:${new URL(previewUrl).port}`);
  await expect(page.getByTestId(`service-open-${service.id}`)).toBeVisible();
  await expect(page.getByTestId(`service-stop-${service.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`service-restart-${service.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`service-start-${service.id}`)).toHaveCount(0);

  await page.getByTestId(`service-open-${service.id}`).click();
  await expect(page.getByTestId("workspace-preview-tabs")).toBeVisible();
  // Previews route through an AoA-origin proxy; the UI shows service.previewUrl
  // (/preview/services/<id>/), not the raw loopback URL.
  const uiPreviewUrl = service.previewUrl!;
  await expect(page.getByTestId("preview-browser-url-input")).toHaveValue(uiPreviewUrl);
  await expect(page.getByTestId("preview-browser-iframe")).toHaveAttribute("src", uiPreviewUrl);
}

async function waitForGitStatus(
  request: APIRequestContext,
  workspaceId: string,
  predicate: (status: GitStatus) => boolean,
) {
  return poll(
    async () => {
      const res = await request.get(`/api/execution-workspaces/${workspaceId}/git/status`);
      return jsonOrThrow<GitStatus>(res, "read git status");
    },
    predicate,
    "git status expectation",
    60_000,
  );
}

async function assertWorkspaceSidebar(
  page: Page,
  company: Company,
  workspace: ExecutionWorkspace,
  expected: { agentName: string; memoryTitle: string; outputFilename: string; serviceName: string },
) {
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`/${company.issuePrefix}/workspaces/${workspace.id}`);
  const panel = page.getByTestId("workspace-right-panel-expanded");
  await expect(panel).toBeVisible();

  await expectSidebarSections(page, ["process", "git", "services", "artifacts", "memory", "context", "access"]);

  await expandSection(page, "process");
  await expect(page.getByTestId("process-section")).toContainText(expected.agentName);
  await expect(page.getByTestId("process-section")).toContainText(/1 run|runs/);

  await expandSection(page, "git");
  await expect(page.getByTestId("git-panel")).toContainText("workspace-summary.md");
  await expect(page.getByTestId("git-panel")).toContainText("src/app.ts");

  await expandSection(page, "services");
  await expect(page.getByTestId("section-services-body")).toBeVisible();
  await expect(page.getByTestId("section-services-body")).toContainText(expected.serviceName);

  await expandSection(page, "artifacts");
  await expect(page.getByTestId("artifacts-list")).toContainText(expected.outputFilename);
  await expect(page.getByTestId("artifact-row").filter({ hasText: expected.outputFilename })).toBeVisible();

  await expandSection(page, "memory");
  await expect(page.getByTestId("memory-section")).toContainText(expected.memoryTitle);
  await expect(page.getByTestId("memory-group-auto")).toBeVisible();

  await expandSection(page, "context");
  await expandSection(page, "access");

  const overflow = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector) as HTMLElement | null;
      if (!element) return null;
      return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    return {
      panel: read('[data-testid="workspace-right-panel-expanded"]'),
      viewport: read('[data-slot="scroll-area-viewport"]'),
      sections: read('[data-testid="workspace-right-sections"]'),
      cards: Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="cockpit-section-"]'))
        .filter((element) => {
          const id = element.dataset.testid ?? "";
          // Skip trigger buttons (structural, not layout containers).
          // Skip summary spans — they carry the `truncate` class
          // (text-overflow:ellipsis) so scrollWidth > clientWidth is by design,
          // not a layout break.
          return !id.includes("trigger") && !id.includes("summary");
        })
        .map((element) => ({
          id: element.dataset.testid,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
        })),
    };
  });
  expect(overflow.panel).not.toBeNull();
  expect(overflow.viewport).not.toBeNull();
  expect(overflow.sections).not.toBeNull();
  for (const entry of [overflow.panel, overflow.viewport, overflow.sections, ...overflow.cards]) {
    expect(entry!.scrollWidth, `${entry === overflow.panel ? "panel" : entry === overflow.viewport ? "viewport" : entry === overflow.sections ? "sections" : entry!.id} overflows`).toBeLessThanOrEqual(entry!.clientWidth + 1);
  }
}

async function assertWorkspaceViewers(
  page: Page,
  company: Company,
  workspace: ExecutionWorkspace,
  expected: { artifactTitle: string; outputToken: string; serviceName: string; serviceUrl: string },
) {
  await page.goto(`/${company.issuePrefix}/workspaces/${workspace.id}`);
  await page.getByTestId("workspace-preview-toggle").click();
  await expect(page.getByTestId("workspace-preview-tabs")).toBeVisible();
  await expect(page.getByTestId("viewer-home")).toBeVisible();

  const serviceRow = page.locator('[data-testid^="viewer-home-service-"]').filter({ hasText: expected.serviceName });
  await expect(serviceRow).toBeVisible();
  await serviceRow.click();
  await expect(page.getByTestId("preview-browser-url-input")).toHaveValue(expected.serviceUrl);
  await expect(page.getByTestId("preview-browser-iframe")).toHaveAttribute("src", expected.serviceUrl);

  await page.getByRole("tab", { name: "Viewer" }).click();
  const artifactRow = page.locator('[data-testid^="viewer-home-artifact-"]').filter({ hasText: expected.artifactTitle });
  await expect(artifactRow).toBeVisible();
  await artifactRow.click();
  await expect(page.getByRole("tab", { name: expected.artifactTitle })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("preview-artifact-tab")).toBeVisible();
  await expect(page.getByTestId("work-product-markdown")).toContainText(expected.outputToken);

  await page.getByRole("tab", { name: "Viewer" }).click();
  await page.getByTestId("viewer-home-logs").click();
  await expect(page.getByRole("tab", { name: "Logs" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("logs-view")).toContainText("AOA_OUTPUT_PRODUCT_E2E_");
}

async function expectSidebarSections(page: Page, expectedIds: string[]) {
  const sections = page.locator(
    expectedIds.map((id) => `[data-testid="cockpit-section-${id}"]`).join(", "),
  );
  await expect(sections).toHaveCount(expectedIds.length);
  await expect.poll(async () => sections.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")))).toEqual(
    expectedIds.map((id) => `cockpit-section-${id}`),
  );
}

async function expandSection(page: Page, id: string) {
  const section = page.getByTestId(`cockpit-section-${id}`);
  await expect(section).toBeVisible();
  await page.getByTestId(`cockpit-section-trigger-${id}`).click();
}

async function expectFileContains(cwd: string, relativePath: string, token: string) {
  const content = await fs.readFile(path.join(cwd, relativePath), "utf8");
  expect(content).toContain(token);
}

async function allocateLoopbackPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (!address || typeof address === "string") throw new Error("Failed to allocate loopback port");
  return address.port;
}

async function jsonOrThrow<T = unknown>(res: APIResponse, label: string): Promise<T> {
  if (!res.ok()) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`${label} failed: ${res.status()} ${text}`);
  }
  return (await res.json()) as T;
}

function remoteName(remote: GitStatus["remote"]) {
  return typeof remote === "string" ? remote : remote?.name ?? null;
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}
