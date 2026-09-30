import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { GitPanel } from "../components/workspace/tools/GitPanel";

const mockGetIssue = vi.fn();
const mockCreatePR = vi.fn();
const mockSyncWorkspacePR = vi.fn();
const mockPushToast = vi.fn();
const mockGetGitStatus = vi.fn();
const mockSafety = vi.fn();
const mockGitCommit = vi.fn();
const mockGitPush = vi.fn();
const mockMergePr = vi.fn();
const mockClosePr = vi.fn();
const mockReopenPr = vi.fn();
const mockRequestReview = vi.fn();
let canMutateGit = true;

vi.mock("../api/issues", () => ({
  issuesApi: { get: (...args: unknown[]) => mockGetIssue(...args) },
}));

vi.mock("../api/github-integration", () => ({
  githubIntegrationApi: {
    createPR: (...args: unknown[]) => mockCreatePR(...args),
    syncWorkspacePR: (...args: unknown[]) => mockSyncWorkspacePR(...args),
    getCollaborators: vi.fn().mockResolvedValue([]),
    getLabels: vi.fn().mockResolvedValue([]),
    getMilestones: vi.fn().mockResolvedValue([]),
    mergePr: (...args: unknown[]) => mockMergePr(...args),
    closePr: (...args: unknown[]) => mockClosePr(...args),
    reopenPr: (...args: unknown[]) => mockReopenPr(...args),
    requestReview: (...args: unknown[]) => mockRequestReview(...args),
  },
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    getGitStatus: (...args: unknown[]) => mockGetGitStatus(...args),
    getGitLog: vi.fn().mockResolvedValue({ gitAvailable: true, entries: [] }),
    safety: (...args: unknown[]) => mockSafety(...args),
    gitCommit: (...args: unknown[]) => mockGitCommit(...args),
    gitPush: (...args: unknown[]) => mockGitPush(...args),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    toasts: [],
    pushToast: (...args: unknown[]) => mockPushToast(...args),
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
  }),
}));

vi.mock("../hooks/useWorkspacePermissions", () => ({
  useWorkspacePermissions: () => ({
    canEditDepartmentWorkspaceSettings: true,
    canOverrideTaskWorkspace: true,
    canControlRuntimeServices: true,
    canConfigureRuntimeCommands: true,
    canMutateGit,
  }),
}));

// Mock clipboard API
const writeText = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, { clipboard: { writeText } });

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    companyId: "comp-1",
    projectId: "proj-1",
    projectWorkspaceId: null,
    sourceIssueId: "issue-1",
    mode: "isolated_workspace" as const,
    strategyType: "git_worktree" as const,
    name: "ENG-99-fix-auth",
    status: "active" as const,
    cwd: "/tmp/ws/ENG-99",
    repoUrl: "https://github.com/acme/repo",
    baseRef: "main",
    branchName: "ENG-99-fix-auth",
    providerType: "git_worktree" as const,
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof GitPanel>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
  }
  // Distinguish explicit null/undefined in `issueId` from "not passed":
  const issueIdProp: string | null | undefined =
    "issueId" in props ? props.issueId : "issue-1";
  return render(
    <GitPanel
      workspace={(props.workspace ?? makeWorkspace()) as any}
      issueId={issueIdProp}
      isExpanded={props.isExpanded}
    />,
    { wrapper: Wrapper },
  );
}

describe("GitPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canMutateGit = true;
    // Default git status: git available, clean tree, branch matches workspace.branchName
    mockGetGitStatus.mockResolvedValue({
      gitAvailable: true,
      branch: "ENG-99-fix-auth",
      detachedHead: false,
      remote: null,
      ahead: null,
      behind: null,
      files: [],
      clean: true,
    });
    mockSafety.mockResolvedValue({
      task: null,
      activeRun: null,
      requiresConfirmation: { commit: false, push: false, createPr: false },
      warnings: [],
    });
    mockGitCommit.mockResolvedValue({ hash: "abc", message: "", filesCommitted: [], skippedFiles: [] });
    mockGitPush.mockResolvedValue({ pushed: true, remote: "origin", branch: "main" });
    mockSyncWorkspacePR.mockResolvedValue({
      workspaceId: "ws-1",
      repoUrl: "https://github.com/acme/repo",
      branchName: "ENG-99-fix-auth",
      baseRef: "main",
      pr: null,
      githubLastSyncedAt: "2026-05-16T00:00:00.000Z",
      githubSyncError: null,
      cached: false,
    });
  });

  it("syncs GitHub PR metadata when the expanded panel has a repo and branch", async () => {
    renderPanel();

    await waitFor(() =>
      expect(mockSyncWorkspacePR).toHaveBeenCalledWith("ws-1", { force: false }),
    );
  });

  it("does not auto-sync GitHub PR metadata when the panel is collapsed", async () => {
    renderPanel({ isExpanded: false });

    await screen.findByText("No PR created");
    expect(mockSyncWorkspacePR).not.toHaveBeenCalled();
  });

  it("offers manual GitHub PR refresh from Git actions", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /open git actions/i }));
    await user.click(await screen.findByText("Refresh GitHub PR"));

    await waitFor(() =>
      expect(mockSyncWorkspacePR).toHaveBeenCalledWith("ws-1", { force: true }),
    );
  });

  it("keeps manual GitHub PR refresh available after a sync failure", async () => {
    // Background sync is silent — a failing background sync no longer toasts.
    // The manual "Refresh GitHub PR" action stays available and DOES toast on failure.
    mockSyncWorkspacePR.mockRejectedValue(new Error("Repository not found"));
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /open git actions/i }));

    const refreshItem = await screen.findByText("Refresh GitHub PR");
    expect(refreshItem.closest('[role="menuitem"]')).not.toHaveAttribute("data-disabled");

    await user.click(refreshItem);

    await waitFor(() =>
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "GitHub sync failed" }),
      ),
    );
  });

  it("renders branch name, base ref, and repository link", async () => {
    renderPanel();

    expect((await screen.findAllByText("ENG-99-fix-auth")).length).toBeGreaterThan(0);
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open github repository/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo",
    );
  });

  it("copy button copies branch name to clipboard", async () => {
    const user = userEvent.setup();
    const spy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /open git actions/i }));
    await user.click(await screen.findByText("Copy branch"));

    expect(spy).toHaveBeenCalledWith("ENG-99-fix-auth");
    spy.mockRestore();
  });

  it("falls back when clipboard write fails and confirms branch copy", async () => {
    const user = userEvent.setup();
    const writeSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("clipboard blocked"));
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(),
      configurable: true,
    });
    const execSpy = vi.spyOn(document, "execCommand").mockReturnValue(true);
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /open git actions/i }));
    await user.click(await screen.findByText("Copy branch"));

    expect(writeSpy).toHaveBeenCalledWith("ENG-99-fix-auth");
    expect(execSpy).toHaveBeenCalledWith("copy");
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: "success",
        title: "Branch copied",
      }),
    );
    writeSpy.mockRestore();
    execSpy.mockRestore();
  });

  it("renders local branch, base, worktree, commit sync, and remote status", async () => {
    mockGetGitStatus.mockResolvedValue({
      gitAvailable: true,
      branch: "ENG-99-fix-auth",
      detachedHead: false,
      remote: { name: "origin", fetchUrl: "git@example.com:acme/repo.git", pushUrl: "git@example.com:acme/repo.git" },
      ahead: 2,
      behind: 0,
      files: [
        { path: "src/auth.ts", status: "modified", staged: false },
        { path: "workspace-summary.md", status: "added", staged: false },
      ],
      clean: false,
    });

    renderPanel();

    expect(screen.queryByTestId("git-worktree-section")).not.toBeInTheDocument();
    expect(await screen.findByTestId("git-local-section")).toHaveTextContent("Isolated workspace");
    expect(screen.getByTestId("git-local-section")).toHaveTextContent("ENG-99-fix-auth");
    expect(screen.getByTestId("git-local-section")).toHaveTextContent("from main");
    expect(screen.getByTestId("git-local-section")).toHaveTextContent("2 changed files");
    expect(screen.getByTestId("git-local-section")).toHaveTextContent("src/auth.ts");
    expect(screen.getByTestId("git-local-section")).toHaveTextContent("2 commits ahead");
    expect(screen.getByTestId("git-remote-section")).toHaveTextContent("origin / ENG-99-fix-auth");
    expect(screen.getByTestId("git-remote-section")).toHaveTextContent("ahead 2");
    expect(screen.queryByText("github.com/acme/repo")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open github repository/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo",
    );
  });

  it("uses a compact primary action row for PR, git actions, and IDE opening", async () => {
    renderPanel();

    const createPr = await screen.findByTestId("create-pr-btn");
    expect(createPr).toHaveTextContent("Create PR");
    expect(createPr).toHaveAttribute("data-variant", "default");
    expect(screen.getByRole("button", { name: /open git actions/i })).toHaveClass("border-border/70");
    expect(screen.getByRole("button", { name: /open workspace in editor/i })).toHaveClass("border-border/70");
    expect(screen.queryByText("Branch, local, remote, PR")).not.toBeInTheDocument();
    expect(screen.getByText("Local")).toHaveClass("bg-brand/[0.08]");
    expect(screen.getByText("Remote")).toHaveClass("border-brand/[0.25]");
    expect(
      screen.getByTestId("git-remote-section").compareDocumentPosition(screen.getByTestId("git-action-row")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("hides the base ref row when the workspace has no base ref", async () => {
    renderPanel({ workspace: makeWorkspace({ baseRef: null }) as any });

    expect(await screen.findByTestId("branch-row")).toHaveTextContent("ENG-99-fix-auth");
    expect(screen.queryByTestId("base-ref-row")).not.toBeInTheDocument();
    expect(screen.queryByText("current ref")).not.toBeInTheDocument();
  });

  it("shows 'No PR created' when metadata.pr is absent", async () => {
    renderPanel();
    expect(await screen.findByText("No PR created")).toBeInTheDocument();
  });

  it("renders PR badge and link when metadata.pr has new {url, number, state} shape", async () => {
    const ws = makeWorkspace({
      metadata: {
        pr: {
          url: "https://github.com/acme/repo/pull/42",
          number: 42,
          state: "open",
          createdAt: "2026-04-22T12:00:00Z",
          draft: false,
        },
      },
    });
    renderPanel({ workspace: ws as any });

    expect(await screen.findByText("#42")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
    // For an open PR, the action row shows the Merge split button plus an
    // icon-only link to the PR (no visible "View PR #N" text on the link).
    const viewPrLink = screen.getByTestId("pr-link");
    expect(viewPrLink).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/pull/42",
    );
    expect(screen.getByTestId("pr-merge-btn")).toBeInTheDocument();
  });

  it("labels the header as merged when the pull request is merged", async () => {
    const ws = makeWorkspace({
      metadata: {
        pr: {
          url: "https://github.com/acme/repo/pull/42",
          number: 42,
          state: "merged",
          createdAt: "2026-04-22T12:00:00Z",
          draft: false,
        },
      },
    });
    renderPanel({ workspace: ws as any });

    // Merged state renders a purple chip link reading "Merged #42".
    expect(await screen.findByTestId("pr-link")).toHaveTextContent("Merged #42");
    expect(screen.getByTestId("git-remote-section")).toHaveTextContent("PR #42 merged");
  });

  it("hides repo link when repoUrl is null", async () => {
    renderPanel({ workspace: makeWorkspace({ repoUrl: null }) as any });
    await screen.findByText("No PR created");
    expect(screen.queryByRole("link", { name: /open github repository/i })).not.toBeInTheDocument();
  });

  it("shows local-only remote state when no remote is configured", async () => {
    renderPanel({ workspace: makeWorkspace({ repoUrl: null }) as any });

    expect(await screen.findByTestId("git-remote-section")).toHaveTextContent("No remote configured");
    expect(screen.getByTestId("git-remote-section")).toHaveTextContent("No remote configured");
    expect(screen.queryByTestId("push-btn")).not.toBeInTheDocument();
  });

  it("hides branch row when branchName is null", async () => {
    // Override status to return no branch (workspace has no branch provisioned yet)
    mockGetGitStatus.mockResolvedValue({
      gitAvailable: true,
      branch: null,
      detachedHead: false,
      remote: null,
      ahead: null,
      behind: null,
      files: [],
      clean: true,
    });
    renderPanel({ workspace: makeWorkspace({ branchName: null }) as any });
    // Wait for status to load, then confirm branch-row is absent
    await screen.findByText("No PR created");
    expect(screen.queryByTestId("branch-row")).not.toBeInTheDocument();
  });

  it("Create PR button enabled when issueId provided and no PR exists", async () => {
    renderPanel();

    const btn = await screen.findByTestId("create-pr-btn");
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent(/create pr/i);
  });

  it("Create PR button disabled with helper tooltip when issueId is null", async () => {
    renderPanel({ issueId: null });

    const btn = await screen.findByTestId("create-pr-btn");
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute(
      "title",
      "Link a task to this workspace to create a PR",
    );
  });

  it("clicking Create PR opens the dialog", async () => {
    mockGetIssue.mockResolvedValue({
      id: "issue-1",
      title: "Task title",
      description: "",
    });
    const user = userEvent.setup();
    renderPanel();

    // Wait for the git status to load so the Create PR button is rendered
    const createPrBtn = await screen.findByTestId("create-pr-btn");
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();

    await user.click(createPrBtn);

    await waitFor(() =>
      expect(screen.getByTestId("create-pr-dialog")).toBeInTheDocument(),
    );
  });

  it("disables Git mutation actions when the current user cannot mutate Git", async () => {
    canMutateGit = false;
    mockGetGitStatus.mockResolvedValue({
      gitAvailable: true,
      branch: "ENG-99-fix-auth",
      detachedHead: false,
      remote: { name: "origin", fetchUrl: "git@example.com:acme/repo.git", pushUrl: "git@example.com:acme/repo.git" },
      ahead: 2,
      behind: 0,
      files: [{ path: "src/auth.ts", status: "modified", staged: false }],
      clean: false,
    });

    const user = userEvent.setup();
    renderPanel();

    const createPrBtn = await screen.findByTestId("create-pr-btn");
    expect(createPrBtn).toBeDisabled();
    expect(createPrBtn).toHaveAttribute("title", "Your role can view Git state but cannot mutate it");

    await user.click(await screen.findByRole("button", { name: /open git actions/i }));

    const commitItem = screen.getByText("Commit changes").closest('[role="menuitem"]');
    const pushItem = screen.getByText("Push 2 commits").closest('[role="menuitem"]');
    expect(commitItem).toHaveAttribute("data-disabled");
    expect(pushItem).toHaveAttribute("data-disabled");
  });

  it("asks for confirmation before committing when a run is active", async () => {
    mockGetGitStatus.mockResolvedValue({
      gitAvailable: true,
      branch: "ENG-99-fix-auth",
      detachedHead: false,
      remote: { name: "origin", fetchUrl: "git@example.com:acme/repo.git", pushUrl: "git@example.com:acme/repo.git" },
      ahead: 0,
      behind: 0,
      files: [{ path: "src/auth.ts", status: "modified", staged: false }],
      clean: false,
    });
    mockSafety.mockResolvedValue({
      task: { id: "issue-1", title: "Fix auth bug", status: "in_progress", identifier: "ENG-99" },
      activeRun: { id: "run-1", status: "running", startedAt: "2026-05-15T10:00:00Z" },
      requiresConfirmation: { commit: true, push: true, createPr: true },
      warnings: ["An agent run is currently active."],
    });

    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /open git actions/i }));
    await user.click(await screen.findByText("Commit changes"));
    await user.type(screen.getByTestId("commit-message-input"), "Fix auth");
    expect(screen.getByTestId("commit-btn")).toHaveTextContent("Commit 1 file");

    await user.click(screen.getByTestId("commit-btn"));

    expect(mockSafety).toHaveBeenCalledWith("ws-1");
    expect(mockGitCommit).not.toHaveBeenCalled();
    expect(await screen.findByText(/workspace safety check/i)).toBeInTheDocument();
    expect(screen.getByText(/Fix auth bug/i)).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /continue anyway/i }));

    await waitFor(() => expect(mockGitCommit).toHaveBeenCalledWith("ws-1", {
      message: "Fix auth",
      files: ["src/auth.ts"],
    }));
  });

  it("asks for confirmation before pushing when a run is active, cancel prevents push, and continue performs it", async () => {
    mockGetGitStatus.mockResolvedValue({
      gitAvailable: true,
      branch: "ENG-99-fix-auth",
      detachedHead: false,
      remote: { name: "origin", fetchUrl: "git@example.com:acme/repo.git", pushUrl: "git@example.com:acme/repo.git" },
      ahead: 2,
      behind: 0,
      files: [],
      clean: true,
    });
    mockSafety.mockResolvedValue({
      task: { id: "issue-1", title: "Fix auth bug", status: "in_progress", identifier: "ENG-99" },
      activeRun: { id: "run-1", status: "running", startedAt: "2026-05-15T10:00:00Z", agentName: "Builder" },
      requiresConfirmation: { commit: true, push: true, createPr: true },
      warnings: ["An agent run is currently active."],
    });

    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /open git actions/i }));
    await user.click(await screen.findByText("Push 2 commits"));

    expect(mockSafety).toHaveBeenCalledWith("ws-1");
    expect(mockGitPush).not.toHaveBeenCalled();
    expect(await screen.findByTestId("workspace-safety-dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByTestId("workspace-safety-dialog")).not.toBeInTheDocument());
    expect(mockGitPush).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /open git actions/i }));
    await user.click(await screen.findByText("Push 2 commits"));
    await user.click(await screen.findByRole("button", { name: /continue anyway/i }));

    await waitFor(() => expect(mockGitPush).toHaveBeenCalledWith("ws-1"));
  });

  it("labels push with the number of commits ahead", async () => {
    mockGetGitStatus.mockResolvedValue({
      gitAvailable: true,
      branch: "ENG-99-fix-auth",
      detachedHead: false,
      remote: { name: "origin", fetchUrl: "git@example.com:acme/repo.git", pushUrl: "git@example.com:acme/repo.git" },
      ahead: 2,
      behind: 0,
      files: [],
      clean: true,
    });

    renderPanel();

    await userEvent.setup().click(await screen.findByRole("button", { name: /open git actions/i }));
    expect(await screen.findByText("Push 2 commits")).toBeInTheDocument();
  });

  it("does not show pushed when remote exists but upstream tracking is unknown", async () => {
    mockGetGitStatus.mockResolvedValue({
      gitAvailable: true,
      branch: "ENG-99-fix-auth",
      detachedHead: false,
      remote: { name: "origin", fetchUrl: "git@example.com:acme/repo.git", pushUrl: "git@example.com:acme/repo.git" },
      ahead: null,
      behind: null,
      files: [],
      clean: true,
    });

    renderPanel();

    await userEvent.setup().click(await screen.findByRole("button", { name: /open git actions/i }));
    expect(await screen.findByText("Push branch")).toBeInTheDocument();
    expect(screen.queryByText("Pushed")).not.toBeInTheDocument();
  });

  it("shows pushed state when the remote is up to date", async () => {
    mockGetGitStatus.mockResolvedValue({
      gitAvailable: true,
      branch: "ENG-99-fix-auth",
      detachedHead: false,
      remote: { name: "origin", fetchUrl: "git@example.com:acme/repo.git", pushUrl: "git@example.com:acme/repo.git" },
      ahead: 0,
      behind: 0,
      files: [],
      clean: true,
    });

    renderPanel();

    expect(await screen.findByTestId("git-local-section")).toHaveTextContent("No unpushed commits");
    expect(screen.queryByTestId("push-btn")).not.toBeInTheDocument();
  });

  describe("PR action buttons", () => {
    const openPrWorkspace = makeWorkspace({
      repoUrl: "https://github.com/myorg/myrepo",
      branchName: "feat/my-task",
      baseRef: "main",
      metadata: {
        pr: {
          url: "https://github.com/myorg/myrepo/pull/42",
          number: 42,
          state: "open",
          createdAt: "2026-01-01T00:00:00Z",
          draft: false,
        },
      },
    });

    const closedPrWorkspace = makeWorkspace({
      ...openPrWorkspace,
      metadata: {
        pr: {
          url: "https://github.com/myorg/myrepo/pull/42",
          number: 42,
          state: "closed",
          createdAt: "2026-01-01T00:00:00Z",
          draft: false,
        },
      },
    });

    beforeEach(() => {
      vi.clearAllMocks();
      mockGetGitStatus.mockResolvedValue({
        gitAvailable: true,
        branch: "feat/my-task",
        detachedHead: false,
        remote: null,
        ahead: null,
        behind: null,
        files: [],
        clean: true,
      });
      mockSyncWorkspacePR.mockResolvedValue({
        workspaceId: "ws-1",
        repoUrl: "https://github.com/myorg/myrepo",
        branchName: "feat/my-task",
        baseRef: "main",
        pr: null,
        githubLastSyncedAt: "2026-05-16T00:00:00.000Z",
        githubSyncError: null,
        cached: false,
      });
      mockMergePr.mockResolvedValue({ success: true, prState: "merged", prUrl: "https://github.com/myorg/myrepo/pull/42" });
      mockClosePr.mockResolvedValue({ success: true, prState: "closed", prUrl: "https://github.com/myorg/myrepo/pull/42" });
      mockReopenPr.mockResolvedValue({ success: true, prState: "open", prUrl: "https://github.com/myorg/myrepo/pull/42" });
    });

    it("shows Merge, Close PR, and Request Review actions when PR is open", async () => {
      const user = userEvent.setup();
      renderPanel({ workspace: openPrWorkspace as any });

      // Merge is a direct split-button.
      expect(await screen.findByTestId("pr-merge-btn")).toBeInTheDocument();

      // Close PR and Request Review are now menuitems inside the merge dropdown.
      await user.click(screen.getByTestId("pr-merge-dropdown-trigger"));
      expect(
        await screen.findByRole("menuitem", { name: /close pr/i }),
      ).toBeInTheDocument();
      expect(
        await screen.findByRole("menuitem", { name: /request review/i }),
      ).toBeInTheDocument();
    });

    it("shows Reopen button when PR is closed, hides Merge and Close", async () => {
      renderPanel({ workspace: closedPrWorkspace as any });
      expect(await screen.findByRole("button", { name: /reopen/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /close pr/i })).not.toBeInTheDocument();
    });

    it("calls mergePr with squash method on the primary Merge click", async () => {
      const user = userEvent.setup();
      renderPanel({ workspace: openPrWorkspace as any });

      // The primary Merge button squashes directly (squash is the default).
      // Use the testid — /merge/i is ambiguous now (the chevron is labelled
      // "More merge options").
      await user.click(await screen.findByTestId("pr-merge-btn"));

      await waitFor(() =>
        expect(mockMergePr).toHaveBeenCalledWith("ws-1", { mergeMethod: "squash" }),
      );
    });

    it("calls mergePr with rebase method from the merge dropdown", async () => {
      const user = userEvent.setup();
      renderPanel({ workspace: openPrWorkspace as any });

      await user.click(await screen.findByTestId("pr-merge-dropdown-trigger"));
      await user.click(
        await screen.findByRole("menuitem", { name: /rebase and merge/i }),
      );

      await waitFor(() =>
        expect(mockMergePr).toHaveBeenCalledWith("ws-1", { mergeMethod: "rebase" }),
      );
    });

    it("calls closePr on Close PR click", async () => {
      const user = userEvent.setup();
      renderPanel({ workspace: openPrWorkspace as any });
      // Close PR is now a menuitem inside the merge dropdown.
      await user.click(await screen.findByTestId("pr-merge-dropdown-trigger"));
      await user.click(await screen.findByRole("menuitem", { name: /close pr/i }));
      await waitFor(() => expect(mockClosePr).toHaveBeenCalledWith("ws-1"));
    });

    it("calls reopenPr on Reopen click", async () => {
      const user = userEvent.setup();
      renderPanel({ workspace: closedPrWorkspace as any });
      await user.click(await screen.findByRole("button", { name: /reopen/i }));
      await waitFor(() => expect(mockReopenPr).toHaveBeenCalledWith("ws-1"));
    });

    it("does not show PR action buttons when no PR linked", async () => {
      const noprWorkspace = makeWorkspace({
        repoUrl: "https://github.com/myorg/myrepo",
        branchName: "feat/my-task",
        metadata: {},
      });
      renderPanel({ workspace: noprWorkspace as any });
      await screen.findByRole("button", { name: /create pr/i }); // wait for render
      expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /close pr/i })).not.toBeInTheDocument();
    });
  });

  describe("review fixes — silent background sync, request review, draft, terminal polling", () => {
    const openPrWorkspace = makeWorkspace({
      repoUrl: "https://github.com/myorg/myrepo",
      branchName: "feat/my-task",
      baseRef: "main",
      metadata: {
        pr: {
          url: "https://github.com/myorg/myrepo/pull/42",
          number: 42,
          state: "open",
          createdAt: "2026-01-01T00:00:00Z",
          draft: false,
        },
      },
    });

    // 1) Background sync failure emits NO toast (silent-flag guarantee).
    it("does not toast when the silent background sync fails", async () => {
      mockSyncWorkspacePR.mockRejectedValue(new Error("boom"));
      // No PR + repoUrl + branch → the background effect runs an immediate
      // silent sync on mount.
      renderPanel();

      // Let the rejected background mutation settle.
      await waitFor(() =>
        expect(mockSyncWorkspacePR).toHaveBeenCalledWith("ws-1", { force: false }),
      );
      // Give the rejection a tick to flow through onError.
      await waitFor(() => {
        expect(mockPushToast).not.toHaveBeenCalledWith(
          expect.objectContaining({ title: "GitHub sync failed" }),
        );
      });
    });

    // 2) Request Review interaction → calls requestReview + success toast.
    it("requests a review with the entered reviewers and toasts on success", async () => {
      mockRequestReview.mockResolvedValue(undefined);
      const user = userEvent.setup();
      renderPanel({ workspace: openPrWorkspace as any });

      await user.click(await screen.findByTestId("pr-merge-dropdown-trigger"));
      await user.click(await screen.findByRole("menuitem", { name: /request review/i }));

      // RequestReviewInline renders an input + "Send" button.
      const input = await screen.findByLabelText(/reviewer logins/i);
      await user.type(input, "alice, bob");
      await user.click(screen.getByRole("button", { name: /^send$/i }));

      await waitFor(() =>
        expect(mockRequestReview).toHaveBeenCalledWith("ws-1", ["alice", "bob"]),
      );
      await waitFor(() =>
        expect(mockPushToast).toHaveBeenCalledWith(
          expect.objectContaining({ title: "Review requested" }),
        ),
      );
    });

    // 3) Draft PR disables merge + relabels primary button to "Draft".
    it("disables merge and labels the button 'Draft' for a draft PR", async () => {
      const draftPrWorkspace = makeWorkspace({
        repoUrl: "https://github.com/myorg/myrepo",
        branchName: "feat/my-task",
        baseRef: "main",
        metadata: {
          pr: {
            url: "https://github.com/myorg/myrepo/pull/42",
            number: 42,
            state: "open",
            createdAt: "2026-01-01T00:00:00Z",
            draft: true,
          },
        },
      });
      const user = userEvent.setup();
      renderPanel({ workspace: draftPrWorkspace as any });

      const mergeBtn = await screen.findByTestId("pr-merge-btn");
      expect(mergeBtn).toBeDisabled();
      expect(mergeBtn).toHaveTextContent("Draft");
      expect(mergeBtn).not.toHaveTextContent("Merge");

      // The dropdown menu items are also disabled when draft.
      await user.click(screen.getByTestId("pr-merge-dropdown-trigger"));
      const squashItem = await screen.findByRole("menuitem", { name: /squash and merge/i });
      expect(squashItem).toHaveAttribute("data-disabled");
    });

    // 4) Terminal PR (merged) → effect early-returns, no background sync runs.
    it("does not auto-sync when the PR is in a terminal (merged) state", async () => {
      const mergedPrWorkspace = makeWorkspace({
        repoUrl: "https://github.com/myorg/myrepo",
        branchName: "feat/my-task",
        baseRef: "main",
        metadata: {
          pr: {
            url: "https://github.com/myorg/myrepo/pull/42",
            number: 42,
            state: "merged",
            createdAt: "2026-01-01T00:00:00Z",
            draft: false,
          },
        },
      });
      renderPanel({ workspace: mergedPrWorkspace as any });

      // Wait for the panel to render the merged chip link, then confirm no sync ran.
      // (Button uses asChild, so the inner <a> keeps its own data-testid="pr-link".)
      expect(await screen.findByTestId("pr-link")).toHaveTextContent("Merged #42");
      expect(mockSyncWorkspacePR).not.toHaveBeenCalled();
    });
  });
});
