import { expect, test, type APIRequestContext, type APIResponse, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanupTestCompanies, seedCompany } from "../helpers/seed-company";

type Company = { id: string; name: string; issuePrefix: string };
type Project = { id: string; name: string };
type Agent = { id: string; name: string };
type Issue = { id: string; identifier: string | null; title: string };
type RunForIssue = { id?: string; runId?: string; status: string };
type ExecutionWorkspace = {
  id: string;
  cwd: string | null;
  name: string;
  branchName?: string | null;
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
type WorkspaceMutationSafety = {
  task: { id: string; title: string; status: string; identifier?: string | null } | null;
  activeRun: { id: string; status: string; startedAt: string | null } | null;
  requiresConfirmation: { commit: boolean; push: boolean; createPr: boolean };
  warnings: string[];
};
type GitCommitResponse = { filesCommitted: string[]; activeRunWarning?: boolean };
type GitPushResponse = { pushed: boolean; remote: string; branch: string; activeRunWarning?: boolean };

const COMPANY_PREFIX = /^E2E-Persona-Workspace-Safety-/;
const FINAL_RUN_STATUSES = new Set(["completed", "succeeded", "failed", "cancelled", "timed_out"]);

test.describe("persona: workspace developer safety lifecycle", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, COMPANY_PREFIX);
  });

  test("founder sees safety gates before committing, pushing, or opening a PR while agent work is active", async ({
    page,
    request,
  }, testInfo) => {
    const repo = await createTemporaryRepo(testInfo);
    const company = await seedCompany(request, `E2E-Persona-Workspace-Safety-${Date.now()}`);
    const project = await createSoftwareDepartment(request, company, repo.worktreeRoot);
    const token = `AOA_WORKSPACE_SAFETY_${Date.now()}`;
    const agent = await hireLongRunningProcessAgent(request, company.id, token);
    await assignAgentToProject(request, company.id, project.id, agent.id);
    const issue = await createSoftwareIssue(request, company.id, project.id, agent.id, token);

    await wakeAgentForIssue(request, company.id, agent.id, issue.id);
    const runningRun = await waitForRun(request, issue.id, (run) => run.status === "running");
    const workspace = await waitForExecutionWorkspace(request, company.id, issue.id);

    ensureWorkspaceBranchTracksRemote(workspace);
    await seedWorkspaceSafetyFiles(workspace, token);
    await waitForGitStatus(request, workspace.id, (status) =>
      status.gitAvailable &&
      !status.clean &&
      status.files.some((file) => file.path === "workspace-safety.md") &&
      remoteName(status.remote) === "origin",
    );

    const safety = await getWorkspaceSafety(request, workspace.id);
    expect(safety.task).toMatchObject({ id: issue.id, title: issue.title });
    if (safety.activeRun) {
      expect(safety.activeRun).toMatchObject({ id: runId(runningRun) });
      expect(safety.requiresConfirmation).toEqual({
        commit: true,
        push: true,
        createPr: true,
      });
      expect(safety.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/task is not complete/i),
          expect.stringMatching(/agent run/i),
        ]),
      );
    } else {
      expect(safety.requiresConfirmation.createPr).toBe(true);
      expect(safety.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/task is not complete/i),
        ]),
      );
    }

    await openWorkspaceGitPanel(page, company, workspace);
    await openCommitForm(page);
    await page.getByTestId("commit-message-input").fill("test: commit workspace safety output");
    await expect(page.getByTestId("commit-btn")).toBeEnabled();

    if (safety.activeRun) {
      await page.getByTestId("commit-btn").click();
      await expectSafetyDialog(page, {
        taskTitle: issue.title,
        warning: /agent run/i,
      });
      await page.getByRole("button", { name: /^cancel$/i }).click();
      await expect(page.getByTestId("workspace-safety-dialog")).toBeHidden();
    }

    const commitResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(`/execution-workspaces/${workspace.id}/git/commit`),
    );
    await page.getByTestId("commit-btn").click();
    if (safety.activeRun) {
      await expectSafetyDialog(page, {
        taskTitle: issue.title,
        warning: /agent run/i,
      });
      await page.getByRole("button", { name: /^continue anyway$/i }).click();
    }
    const commitResult = await commitResponse;
    expect(commitResult.ok()).toBe(true);
    const commitBody = await commitResult.json() as GitCommitResponse;
    expect(commitBody.filesCommitted).toContain("workspace-safety.md");
    if (safety.activeRun) {
      expect(commitBody.activeRunWarning).toBe(true);
    }

    await waitForGitStatus(request, workspace.id, (status) =>
      status.gitAvailable && status.clean && (status.ahead ?? 0) > 0,
    );
    await expect(page.getByTestId("local-sync-row")).toContainText(/1 commit ahead|1 commits ahead/i, {
      timeout: 15_000,
    });

    const pushResponse = page.waitForResponse((response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith(`/execution-workspaces/${workspace.id}/git/push`),
    );
    await openGitActions(page);
    await page.getByRole("menuitem", { name: /^push 1 commit$/i }).click();
    if (safety.activeRun) {
      await expectSafetyDialog(page, {
        taskTitle: issue.title,
        warning: /agent run/i,
      });
      await page.getByRole("button", { name: /^continue anyway$/i }).click();
    }
    const pushResult = await pushResponse;
    expect(pushResult.ok()).toBe(true);
    const pushBody = await pushResult.json() as GitPushResponse;
    expect(pushBody).toMatchObject({ pushed: true, remote: "origin" });
    if (safety.activeRun) {
      expect(pushBody.activeRunWarning).toBe(true);
    }

    await waitForGitStatus(request, workspace.id, (status) =>
      status.gitAvailable && status.clean && (status.ahead ?? 0) === 0,
    );

    await page.getByTestId("create-pr-btn").click();
    await expect(page.getByTestId("create-pr-dialog")).toBeVisible({ timeout: 10_000 });
    await ensurePrTitle(page, issue.title);
    await expect(page.getByTestId("pr-submit")).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId("pr-submit").click();
    if (safety.activeRun) {
      await expectSafetyDialog(page, {
        taskTitle: issue.title,
        warning: /agent run/i,
      });
      await page.getByRole("button", { name: /^continue anyway$/i }).click();
    }
    if (safety.activeRun) {
      await expect(page.getByTestId("workspace-safety-dialog")).toBeHidden();
    }
  });
});

async function createTemporaryRepo(testInfo: TestInfo) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aoa-workspace-safety-${testInfo.workerIndex}-`));
  const worktreeRoot = path.join(root, "repo");
  const remoteRoot = path.join(root, "remote.git");
  await fs.mkdir(path.join(worktreeRoot, "src"), { recursive: true });
  git(worktreeRoot, ["init"]);
  git(worktreeRoot, ["checkout", "-B", "main"]);
  git(worktreeRoot, ["config", "user.email", "e2e@example.test"]);
  git(worktreeRoot, ["config", "user.name", "AoA E2E"]);
  await fs.writeFile(path.join(worktreeRoot, "README.md"), "# AoA Workspace Safety Persona E2E\n");
  await fs.writeFile(path.join(worktreeRoot, "src", "app.ts"), "export const appName = 'AoA Workspace Safety';\n");
  git(worktreeRoot, ["add", "."]);
  git(worktreeRoot, ["commit", "-m", "initial workspace safety repo"]);
  execFileSync("git", ["init", "--bare", remoteRoot], { stdio: "pipe" });
  git(worktreeRoot, ["remote", "add", "origin", remoteRoot]);
  git(worktreeRoot, ["push", "-u", "origin", "main"]);
  return { worktreeRoot, remoteRoot };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString("utf8").trim();
}

function ensureWorkspaceBranchTracksRemote(workspace: ExecutionWorkspace) {
  const cwd = workspaceCwd(workspace);
  git(cwd, ["push", "-u", "origin", "HEAD"]);
}

async function seedWorkspaceSafetyFiles(workspace: ExecutionWorkspace, token: string) {
  const cwd = workspaceCwd(workspace);
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.appendFile(path.join(cwd, "src", "app.ts"), `\n// founder-review-safety:${token}\n`);
  await fs.writeFile(path.join(cwd, "workspace-safety.md"), `# Workspace Safety\n\n${token}\n`);
}

function workspaceCwd(workspace: ExecutionWorkspace) {
  if (!workspace.cwd) {
    throw new Error(`Execution workspace ${workspace.id} does not have a cwd`);
  }
  return workspace.cwd;
}

async function createSoftwareDepartment(
  request: APIRequestContext,
  company: Company,
  cwd: string,
): Promise<Project> {
  return jsonOrThrow<Project>(
    await request.post(`/api/companies/${company.id}/projects`, {
      data: {
        name: "Workspace Safety Engineering",
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
            branchTemplate: "{{issue.identifier}}-workspace-safety-e2e",
          },
        },
        workspace: {
          name: "Workspace safety repo",
          cwd,
          repoRef: "main",
          isPrimary: true,
        },
      },
    }),
    "create software department",
  );
}

async function hireLongRunningProcessAgent(
  request: APIRequestContext,
  companyId: string,
  token: string,
): Promise<Agent> {
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const token = process.env.AOA_WORKSPACE_SAFETY_TOKEN || '';",
    "fs.mkdirSync('src', { recursive: true });",
    "fs.appendFileSync(path.join('src', 'app.ts'), '\\n// workspace-safety:' + token + '\\n');",
    "fs.writeFileSync('workspace-safety.md', '# Workspace Safety\\n\\n' + token + '\\n');",
    "console.log('workspace-safety-ready:' + token);",
    "setTimeout(() => process.exit(0), Number(process.env.AOA_HOLD_MS || 180000));",
  ].join(" ");

  const body = await jsonOrThrow<{ agent: Agent }>(
    await request.post(`/api/companies/${companyId}/agent-hires`, {
      data: {
        name: "E2E Workspace Safety Agent",
        role: "general",
        title: "E2E Workspace Safety Agent",
        adapterType: "process",
        runtimeConfig: {
          injectCompanyContext: true,
          contextMode: "standard",
          autoRunSummary: true,
        },
        adapterConfig: {
          command: "node",
          args: ["-e", script],
          env: {
            AOA_WORKSPACE_SAFETY_TOKEN: token,
            AOA_HOLD_MS: "180000",
          },
          timeoutSec: 240,
        },
      },
    }),
    "hire workspace safety process agent",
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

async function createSoftwareIssue(
  request: APIRequestContext,
  companyId: string,
  projectId: string,
  agentId: string,
  token: string,
): Promise<Issue> {
  return jsonOrThrow<Issue>(
    await request.post(`/api/companies/${companyId}/issues`, {
      data: {
        projectId,
        title: "Review active workspace safety gates",
        description: `Write workspace-safety.md with ${token} and keep the run active while the founder reviews git actions.`,
        status: "backlog",
        priority: "medium",
        workMode: "standard",
        assigneeAgentId: agentId,
      },
    }),
    "create workspace safety issue",
  );
}

async function wakeAgentForIssue(
  request: APIRequestContext,
  companyId: string,
  agentId: string,
  issueId: string,
) {
  await jsonOrThrow(
    await request.post(`/api/agents/${agentId}/wakeup?companyId=${companyId}`, {
      data: {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "workspace_safety_persona_e2e",
        payload: { issueId },
      },
    }),
    "wake workspace safety agent",
  );
}

async function waitForRun(
  request: APIRequestContext,
  issueId: string,
  predicate: (run: RunForIssue) => boolean,
) {
  return poll(
    async () => {
      const runs = await jsonOrThrow<RunForIssue[]>(
        await request.get(`/api/issues/${issueId}/runs`),
        "list issue runs",
      );
      return runs[0] ?? null;
    },
    (run): run is RunForIssue => Boolean(run && predicate(run)),
    "matching issue run",
    60_000,
  );
}

async function waitForExecutionWorkspace(
  request: APIRequestContext,
  companyId: string,
  issueId: string,
) {
  return poll(
    async () => {
      const workspaces = await jsonOrThrow<ExecutionWorkspace[]>(
        await request.get(`/api/companies/${companyId}/execution-workspaces?issueId=${issueId}`),
        "list execution workspaces",
      );
      return workspaces.find((workspace) => workspace.cwd) ?? null;
    },
    (workspace): workspace is ExecutionWorkspace => Boolean(workspace),
    "execution workspace",
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
        "read git status",
      ),
    predicate,
    "git status expectation",
    60_000,
  );
}

async function getWorkspaceSafety(
  request: APIRequestContext,
  workspaceId: string,
) {
  return jsonOrThrow<WorkspaceMutationSafety>(
    await request.get(`/api/execution-workspaces/${workspaceId}/git/safety`),
    "read workspace mutation safety",
  );
}

async function openWorkspaceGitPanel(page: Page, company: Company, workspace: ExecutionWorkspace) {
  await page.goto(`/${company.issuePrefix}/workspaces/${workspace.id}`);
  await expect(page.getByTestId("workspace-right-panel-expanded")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("cockpit-section-trigger-git").click();
  await expect(page.getByTestId("git-panel")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("git-panel")).toContainText("workspace-safety.md", { timeout: 15_000 });
}

async function openGitActions(page: Page) {
  await page.getByRole("button", { name: /^open git actions$/i }).click();
}

async function openCommitForm(page: Page) {
  await openGitActions(page);
  await page.getByRole("menuitem", { name: /^commit changes$/i }).click();
  await expect(page.getByTestId("commit-form")).toBeVisible({ timeout: 10_000 });
}

async function expectSafetyDialog(
  page: Page,
  expected: { taskTitle: string; warning: RegExp },
) {
  const dialog = page.getByTestId("workspace-safety-dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText(expected.taskTitle);
  await expect(dialog).toContainText(expected.warning);
}

async function ensurePrTitle(page: Page, fallbackTitle: string) {
  const titleInput = page.getByTestId("pr-title-input");
  await expect(titleInput).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(async () => (await titleInput.inputValue()).trim(), {
      timeout: 10_000,
    })
    .not.toEqual("");
  if ((await titleInput.inputValue()).trim() === "") {
    await titleInput.fill(fallbackTitle);
  }
}

function remoteName(remote: GitStatus["remote"]) {
  return typeof remote === "string" ? remote : remote?.name ?? null;
}

function runId(run: RunForIssue) {
  return run.runId ?? run.id ?? "";
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
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(lastValue)}`);
}
