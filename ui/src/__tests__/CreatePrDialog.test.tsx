import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

import { ApiError } from "../api/client";

const mockGetIssue = vi.fn();
const mockCreatePR = vi.fn();
const mockSyncWorkspacePR = vi.fn();
const mockGetCollaborators = vi.fn();
const mockGetLabels = vi.fn();
const mockGetMilestones = vi.fn();
const mockGetBranches = vi.fn();
const mockPushToast = vi.fn();
const mockSafety = vi.fn();

vi.mock("../api/issues", () => ({
  issuesApi: { get: (...args: unknown[]) => mockGetIssue(...args) },
}));

vi.mock("../api/github-integration", () => ({
  githubIntegrationApi: {
    createPR: (...args: unknown[]) => mockCreatePR(...args),
    syncWorkspacePR: (...args: unknown[]) => mockSyncWorkspacePR(...args),
    getCollaborators: (...args: unknown[]) => mockGetCollaborators(...args),
    getLabels: (...args: unknown[]) => mockGetLabels(...args),
    getMilestones: (...args: unknown[]) => mockGetMilestones(...args),
    getBranches: (...args: unknown[]) => mockGetBranches(...args),
  },
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    safety: (...args: unknown[]) => mockSafety(...args),
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

import { CreatePrDialog } from "../components/workspace/CreatePrDialog";

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    companyId: "co-1",
    projectId: "proj-1",
    projectWorkspaceId: null,
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "ENG-99",
    status: "active",
    cwd: "/tmp/ws/ENG-99",
    repoUrl: "https://github.com/acme/repo",
    baseRef: "main",
    branchName: "feature/x",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

function renderDialog(props: Partial<React.ComponentProps<typeof CreatePrDialog>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const onOpenChange = vi.fn();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MemoryRouter>
    );
  }
  const result = render(
    <CreatePrDialog
      issueId="issue-1"
      workspace={makeWorkspace()}
      open={true}
      onOpenChange={onOpenChange}
      {...props}
    />,
    { wrapper: Wrapper },
  );
  return { ...result, onOpenChange, queryClient };
}

describe("CreatePrDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafety.mockResolvedValue({
      task: null,
      activeRun: null,
      requiresConfirmation: { commit: false, push: false, createPr: false },
      warnings: [],
    });
    mockSyncWorkspacePR.mockResolvedValue({
      workspaceId: "ws-1",
      repoUrl: "https://github.com/acme/repo",
      branchName: "feature/x",
      baseRef: "main",
      pr: null,
      githubLastSyncedAt: "2026-05-16T00:00:00.000Z",
      githubSyncError: null,
      cached: false,
    });
    mockGetCollaborators.mockResolvedValue([]);
    mockGetLabels.mockResolvedValue([]);
    mockGetMilestones.mockResolvedValue([]);
    mockGetBranches.mockResolvedValue([{ name: "main", sha: "abc" }]);
  });

  it("prefills title/body from the linked task + base from workspace.baseRef", async () => {
    mockGetIssue.mockResolvedValue({
      id: "issue-1",
      title: "Fix auth bug",
      description: "Users cannot log in.",
    });

    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId("pr-title-input")).toHaveValue("Fix auth bug"),
    );
    expect(screen.getByTestId("pr-body-input")).toHaveValue("Users cannot log in.");
    // Base branch is now a Radix Select trigger (a button), not a text input.
    // It defaults to workspace.baseRef ?? "main" and renders the value as text.
    await waitFor(() =>
      expect(screen.getByTestId("pr-base-input")).toHaveTextContent("main"),
    );
  });

  it("renders head branch as read-only from workspace.branchName", async () => {
    mockGetIssue.mockResolvedValue({
      id: "issue-1",
      title: "Title",
      description: "",
    });

    renderDialog();

    const head = await screen.findByTestId("pr-head-readonly");
    expect(head).toHaveTextContent("feature/x");
  });

  it("draft checkbox toggles", async () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "" });

    const user = userEvent.setup();
    renderDialog();

    const checkbox = await screen.findByTestId("pr-draft-checkbox");
    expect(checkbox).toHaveAttribute("data-state", "unchecked");
    await user.click(checkbox);
    expect(checkbox).toHaveAttribute("data-state", "checked");
  });

  it("submit calls createPR with correct payload, shows toast, closes dialog on success", async () => {
    mockGetIssue.mockResolvedValue({
      id: "issue-1",
      title: "T",
      description: "B",
    });
    mockCreatePR.mockResolvedValue({
      url: "https://github.com/acme/repo/pull/42",
      number: 42,
      state: "open",
      draft: false,
    });
    const onCreated = vi.fn();

    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ onCreated });

    await waitFor(() =>
      expect(screen.getByTestId("pr-title-input")).toHaveValue("T"),
    );
    await user.click(screen.getByTestId("pr-submit"));

    await waitFor(() => {
      expect(mockCreatePR).toHaveBeenCalledWith("issue-1", {
        workspaceId: "ws-1",
        title: "T",
        body: "B",
        base: "main",
        draft: false,
        head: "feature/x",
      });
    });
    expect(mockSyncWorkspacePR).toHaveBeenCalledWith("ws-1", { force: true });
    await waitFor(() => {
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("#42"),
          tone: "success",
        }),
      );
    });
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ number: 42 }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders 'GitHub not connected' banner + Settings link on 412 error", async () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "" });
    mockCreatePR.mockRejectedValue(
      new ApiError("GitHub PAT not configured", 412, {
        error: "GitHub PAT not configured",
        hint: "Go to Settings → Integrations",
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId("pr-title-input")).toHaveValue("T"),
    );
    await user.click(screen.getByTestId("pr-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("pr-error-412")).toBeInTheDocument(),
    );
    expect(screen.getByText(/GitHub not connected/i)).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: /open settings → integrations/i,
    });
    expect(link).toHaveAttribute("href", "/settings?tab=integrations");
  });

  it("renders scope hint banner on 403 error", async () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "" });
    mockCreatePR.mockRejectedValue(
      new ApiError("PAT lacks required permissions", 403, {
        error: "PAT lacks required permissions",
        hint: "Reconnect with pull_requests:write scope",
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId("pr-title-input")).toHaveValue("T"),
    );
    await user.click(screen.getByTestId("pr-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("pr-error-scope")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/reconnect with pull_requests:write scope/i),
    ).toBeInTheDocument();
  });

  it("renders backend hint text for generic PR creation failures", async () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "" });
    mockCreatePR.mockRejectedValue(
      new ApiError("Failed to push branch \"feature/x\" to remote before creating PR", 400, {
        error: "Failed to push branch \"feature/x\" to remote before creating PR",
        hint: "remote: Write access to repository not granted.",
      }),
    );

    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId("pr-title-input")).toHaveValue("T"),
    );
    await user.click(screen.getByTestId("pr-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("pr-error-generic")).toBeInTheDocument(),
    );
    expect(screen.getByText(/write access to repository not granted/i)).toBeInTheDocument();
  });

  it("does NOT render DialogContent when open=false (conditional mount)", () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "" });
    renderDialog({ open: false });
    expect(screen.queryByTestId("create-pr-dialog")).not.toBeInTheDocument();
  });

  it("shows 'PR already created' banner + link when workspace.metadata.pr exists, hides form", async () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "" });
    const workspaceWithPr = makeWorkspace({
      metadata: {
        pr: {
          url: "https://github.com/acme/repo/pull/42",
          number: 42,
          state: "open",
        },
      },
    });

    renderDialog({ workspace: workspaceWithPr });

    const banner = await screen.findByTestId("pr-already-exists");
    expect(banner).toBeInTheDocument();
    const link = screen.getByTestId("pr-already-exists-link");
    expect(link).toHaveAttribute("href", "https://github.com/acme/repo/pull/42");
    expect(link).toHaveTextContent(/View PR #42/i);
    // Form is not rendered
    expect(screen.queryByTestId("pr-title-input")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pr-submit")).not.toBeInTheDocument();
  });

  it("shows the create form (no banner) when workspace has no existing PR", async () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "" });

    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId("pr-title-input")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("pr-already-exists")).not.toBeInTheDocument();
  });

  it("invalidates both executionWorkspaces.detail and .list query keys on PR create success", async () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "B" });
    mockCreatePR.mockResolvedValue({
      url: "https://github.com/acme/repo/pull/42",
      number: 42,
      state: "open",
      draft: false,
    });

    const user = userEvent.setup();
    const { queryClient } = renderDialog();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await waitFor(() =>
      expect(screen.getByTestId("pr-title-input")).toHaveValue("T"),
    );
    await user.click(screen.getByTestId("pr-submit"));

    await waitFor(() => expect(mockCreatePR).toHaveBeenCalled());

    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: readonly unknown[] }).queryKey,
    );
    // Workspace detail (existing behavior)
    expect(invalidatedKeys).toContainEqual(["executionWorkspaces", "detail", "ws-1"]);
    // Workspace list for the company (new in Task 15 — prevents stale /workspaces page)
    expect(invalidatedKeys).toContainEqual(["executionWorkspaces", "co-1"]);
  });

  it("warns before creating a PR when task is not complete and an agent run is active", async () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "B" });
    mockSafety.mockResolvedValue({
      task: { id: "issue-1", title: "Build checkout", status: "in_review", identifier: "ENG-99" },
      activeRun: { id: "run-1", status: "running", startedAt: "2026-05-15T10:00:00Z" },
      requiresConfirmation: { commit: true, push: true, createPr: true },
      warnings: ["Task is not complete.", "An agent run is currently active."],
    });
    mockCreatePR.mockResolvedValue({
      url: "https://github.com/acme/repo/pull/42",
      number: 42,
      state: "open",
      draft: false,
    });

    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("pr-title-input")).toHaveValue("T"));
    await user.click(screen.getByTestId("pr-submit"));

    expect(mockSafety).toHaveBeenCalledWith("ws-1");
    expect(mockCreatePR).not.toHaveBeenCalled();
    expect(await screen.findByText(/workspace safety check/i)).toBeInTheDocument();
    expect(screen.getByText(/Build checkout/i)).toBeInTheDocument();
    expect(screen.getByText(/in_review/i)).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /continue anyway/i }));

    await waitFor(() => expect(mockCreatePR).toHaveBeenCalledWith("issue-1", {
      workspaceId: "ws-1",
      title: "T",
      body: "B",
      base: "main",
      draft: false,
      head: "feature/x",
    }));
  });

  it("populates the base-branch dropdown and submits with the selected base", async () => {
    // Radix Select needs these jsdom shims to open + select.
    const proto = window.HTMLElement.prototype;
    proto.scrollIntoView = vi.fn();
    proto.hasPointerCapture = vi.fn(() => false);
    proto.setPointerCapture = vi.fn();
    proto.releasePointerCapture = vi.fn();

    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "B" });
    mockGetBranches.mockResolvedValue([
      { name: "main", sha: "a" },
      { name: "dev", sha: "b" },
    ]);
    mockCreatePR.mockResolvedValue({
      url: "https://github.com/acme/repo/pull/55",
      number: 55,
      state: "open",
      draft: false,
    });

    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId("pr-title-input")).toHaveValue("T"),
    );
    // Wait for the branches query to resolve so both options exist.
    await waitFor(() => expect(mockGetBranches).toHaveBeenCalledWith("ws-1"));

    // Open the Radix Select via its trigger.
    const trigger = screen.getByTestId("pr-base-input");
    await user.click(trigger);

    // Both branch options are present in the open listbox.
    const mainOption = await screen.findByRole("option", { name: "main" });
    const devOption = await screen.findByRole("option", { name: "dev" });
    expect(mainOption).toBeInTheDocument();
    expect(devOption).toBeInTheDocument();

    // Select "dev".
    await user.click(devOption);

    await waitFor(() =>
      expect(screen.getByTestId("pr-base-input")).toHaveTextContent("dev"),
    );

    // Submit the form and assert createPR carried base: "dev".
    await user.click(screen.getByTestId("pr-submit"));

    await waitFor(() =>
      expect(mockCreatePR).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ base: "dev" }),
      ),
    );
  });

  it("uses checking copy while only the safety preflight is running", async () => {
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "T", description: "B" });
    mockCreatePR.mockResolvedValue({
      url: "https://github.com/acme/repo/pull/42",
      number: 42,
      state: "open",
      draft: false,
    });
    let resolveSafety: (value: unknown) => void = () => {};
    mockSafety.mockReturnValue(new Promise((resolve) => {
      resolveSafety = resolve;
    }));

    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("pr-title-input")).toHaveValue("T"));
    await user.click(screen.getByTestId("pr-submit"));

    expect(screen.getByTestId("pr-submit")).toHaveTextContent(/checking/i);
    expect(screen.getByTestId("pr-submit")).not.toHaveTextContent(/creating/i);

    await act(async () => resolveSafety({
      task: null,
      activeRun: null,
      requiresConfirmation: { commit: false, push: false, createPr: false },
      warnings: [],
    }));
    await waitFor(() => expect(mockCreatePR).toHaveBeenCalled());
  });
});

describe("CreatePrDialog — enhanced fields (reviewers / labels / milestone)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSafety.mockResolvedValue({
      task: null,
      activeRun: null,
      requiresConfirmation: { commit: false, push: false, createPr: false },
      warnings: [],
    });
    mockSyncWorkspacePR.mockResolvedValue({
      workspaceId: "ws-1",
      repoUrl: "https://github.com/acme/repo",
      branchName: "feature/x",
      baseRef: "main",
      pr: null,
      githubLastSyncedAt: "2026-05-16T00:00:00.000Z",
      githubSyncError: null,
      cached: false,
    });
    mockGetIssue.mockResolvedValue({ id: "issue-1", title: "My Task", description: "" });
    mockGetCollaborators.mockResolvedValue([
      { login: "alice", avatarUrl: "https://avatars.githubusercontent.com/alice" },
      { login: "bob", avatarUrl: "https://avatars.githubusercontent.com/bob" },
    ]);
    mockGetLabels.mockResolvedValue([
      { id: 1, name: "bug", color: "d73a4a" },
      { id: 2, name: "enhancement", color: "a2eeef" },
    ]);
    mockGetMilestones.mockResolvedValue([
      { number: 1, title: "v1.0", openIssues: 3, dueOn: null },
    ]);
    mockGetBranches.mockResolvedValue([{ name: "main", sha: "abc" }]);
    mockCreatePR.mockResolvedValue({
      url: "https://github.com/acme/repo/pull/99",
      number: 99,
      state: "open",
      draft: false,
    });
  });

  it("fetches and renders collaborators in reviewer section", async () => {
    renderDialog();
    await waitFor(() => expect(mockGetCollaborators).toHaveBeenCalledWith("ws-1"));
    expect(await screen.findByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("includes selected reviewers in createPR call", async () => {
    const user = userEvent.setup();
    renderDialog();

    // Select alice as reviewer
    const aliceCheckbox = await screen.findByRole("checkbox", { name: /alice/i });
    await user.click(aliceCheckbox);

    // Submit
    await user.click(screen.getByTestId("pr-submit"));

    await waitFor(() =>
      expect(mockCreatePR).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ reviewers: ["alice"] }),
      ),
    );
  });

  it("fetches and renders labels", async () => {
    renderDialog();
    expect(await screen.findByText("bug")).toBeInTheDocument();
    expect(screen.getByText("enhancement")).toBeInTheDocument();
  });

  it("includes selected labels in createPR call", async () => {
    const user = userEvent.setup();
    renderDialog();

    const bugCheckbox = await screen.findByRole("checkbox", { name: /^bug$/i });
    await user.click(bugCheckbox);

    await user.click(screen.getByTestId("pr-submit"));

    await waitFor(() =>
      expect(mockCreatePR).toHaveBeenCalledWith(
        "issue-1",
        expect.objectContaining({ labels: ["bug"] }),
      ),
    );
  });

  it("fetches and renders milestones in select", async () => {
    renderDialog();
    expect(await screen.findByText(/v1\.0/)).toBeInTheDocument();
  });

  it("does not send reviewers/labels/milestone when none selected", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByText("alice"); // wait for data to load

    await user.click(screen.getByTestId("pr-submit"));

    await waitFor(() => expect(mockCreatePR).toHaveBeenCalled());
    const callArg = mockCreatePR.mock.calls[0][1] as Record<string, unknown>;
    expect((callArg.reviewers as string[] | undefined) ?? []).toHaveLength(0);
    expect((callArg.labels as string[] | undefined) ?? []).toHaveLength(0);
    expect(callArg.milestoneNumber).toBeUndefined();
  });
});
