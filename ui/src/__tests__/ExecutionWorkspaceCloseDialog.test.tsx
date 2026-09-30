import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionWorkspaceCloseReadiness } from "@armyofagents/shared";

import { ApiError } from "../api/client";

const mockGetCloseReadiness = vi.fn();
const mockUpdate = vi.fn();

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    getCloseReadiness: (...args: unknown[]) => mockGetCloseReadiness(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

import { ExecutionWorkspaceCloseDialog } from "../components/workspace/ExecutionWorkspaceCloseDialog";

function makeReadiness(overrides: Partial<ExecutionWorkspaceCloseReadiness> = {}): ExecutionWorkspaceCloseReadiness {
  return {
    workspaceId: "ws-1",
    state: "ready",
    blockingReasons: [],
    warnings: [],
    linkedIssues: [],
    plannedActions: [
      {
        kind: "archive_record",
        label: "Archive workspace record",
        description: "Keep the execution workspace history and task linkage.",
        command: null,
      },
    ],
    isDestructiveCloseAllowed: true,
    isSharedWorkspace: false,
    isProjectPrimaryWorkspace: false,
    git: null,
    runtimeServices: [],
    ...overrides,
  };
}

function renderDialog(onArchived = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  return {
    onArchived,
    onOpenChange: vi.fn(),
    ...render(
      <QueryClientProvider client={queryClient}>
        <ExecutionWorkspaceCloseDialog
          workspaceId="ws-1"
          open
          onOpenChange={vi.fn()}
          onArchived={onArchived}
        />
      </QueryClientProvider>,
    ),
  };
}

describe("ExecutionWorkspaceCloseDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading placeholder while readiness loads", () => {
    mockGetCloseReadiness.mockReturnValue(new Promise(() => {}));
    renderDialog();
    expect(screen.getByTestId("workspace-close-loading")).toBeInTheDocument();
  });

  it("renders planned actions with label, description, and command", async () => {
    mockGetCloseReadiness.mockResolvedValue(
      makeReadiness({
        plannedActions: [
          {
            kind: "archive_record",
            label: "Archive workspace record",
            description: "Keep the execution workspace history.",
            command: null,
          },
          {
            kind: "git_worktree_remove",
            label: "Remove git worktree",
            description: "We will run git worktree cleanup.",
            command: "git worktree remove --force /tmp/ws",
          },
        ],
      }),
    );
    renderDialog();

    expect(await screen.findByText("Archive workspace record")).toBeInTheDocument();
    expect(screen.getByText("Remove git worktree")).toBeInTheDocument();
    expect(screen.getByText("git worktree remove --force /tmp/ws")).toBeInTheDocument();
  });

  it("disables the action button when state is blocked", async () => {
    mockGetCloseReadiness.mockResolvedValue(
      makeReadiness({
        state: "blocked",
        blockingReasons: ["This workspace is still linked to an open task."],
        isDestructiveCloseAllowed: false,
      }),
    );
    renderDialog();

    // Wait for blockers section to render (signals readiness loaded)
    await screen.findByTestId("workspace-close-blockers");
    const action = screen.getByTestId("confirm-archive-workspace");
    expect(action).toBeDisabled();
    expect(action).toHaveTextContent(/cannot archive/i);
    expect(screen.getByText(/still linked to an open task/i)).toBeInTheDocument();
  });

  it("renders warnings for ready_with_warnings state", async () => {
    mockGetCloseReadiness.mockResolvedValue(
      makeReadiness({
        state: "ready_with_warnings",
        warnings: ["The workspace has 2 modified tracked files."],
      }),
    );
    renderDialog();

    expect(await screen.findByTestId("workspace-close-warnings")).toBeInTheDocument();
    expect(screen.getByText(/2 modified tracked files/i)).toBeInTheDocument();
  });

  it("uses shared-workspace language when isSharedWorkspace is true", async () => {
    mockGetCloseReadiness.mockResolvedValue(
      makeReadiness({
        isSharedWorkspace: true,
      }),
    );
    renderDialog();

    const action = await screen.findByTestId("confirm-archive-workspace");
    await waitFor(() => {
      expect(action).toHaveTextContent(/detach and close/i);
    });
  });

  it("renders linked issues with terminal vs active styling", async () => {
    mockGetCloseReadiness.mockResolvedValue(
      makeReadiness({
        linkedIssues: [
          { id: "i-1", identifier: "FOO-1", title: "Completed task", status: "done", isTerminal: true },
          { id: "i-2", identifier: "FOO-2", title: "Open task", status: "todo", isTerminal: false },
        ],
      }),
    );
    renderDialog();

    const terminal = await screen.findByTestId("workspace-close-linked-issue-i-1");
    const active = screen.getByTestId("workspace-close-linked-issue-i-2");

    expect(terminal).toHaveAttribute("data-variant", "secondary");
    expect(active).toHaveAttribute("data-variant", "outline");
    expect(terminal).toHaveTextContent("FOO-1: Completed task");
    expect(active).toHaveTextContent("FOO-2: Open task");
  });

  it("calls mutation and onArchived on success", async () => {
    const user = userEvent.setup();
    mockGetCloseReadiness.mockResolvedValue(makeReadiness());
    mockUpdate.mockResolvedValue({ id: "ws-1", status: "archived" });

    const { onArchived } = renderDialog();

    const action = await screen.findByTestId("confirm-archive-workspace");
    await waitFor(() => {
      expect(action).not.toBeDisabled();
    });

    await user.click(action);

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("ws-1", { status: "archived" });
    });
    await waitFor(() => {
      expect(onArchived).toHaveBeenCalled();
    });
  });

  it("refetches readiness on 409 error from mutation", async () => {
    const user = userEvent.setup();
    mockGetCloseReadiness
      .mockResolvedValueOnce(makeReadiness())
      .mockResolvedValueOnce(
        makeReadiness({
          state: "blocked",
          blockingReasons: ["Now blocked — linked task became open."],
          isDestructiveCloseAllowed: false,
        }),
      );
    mockUpdate.mockRejectedValueOnce(
      new ApiError("Workspace cannot be archived", 409, { error: "Blocked" }),
    );

    renderDialog();

    const action = await screen.findByTestId("confirm-archive-workspace");
    await user.click(action);

    // After 409, readiness should refetch → blockers appear
    await waitFor(() => {
      expect(mockGetCloseReadiness).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText(/now blocked/i)).toBeInTheDocument();
  });

  it("renders runtime services when present", async () => {
    mockGetCloseReadiness.mockResolvedValue(
      makeReadiness({
        runtimeServices: [
          {
            id: "svc-1",
            companyId: "co-1",
            projectId: null,
            projectWorkspaceId: null,
            executionWorkspaceId: "ws-1",
            issueId: null,
            scopeType: "execution_workspace",
            scopeId: "ws-1",
            serviceName: "api",
            status: "running",
            lifecycle: "shared",
            reuseKey: null,
            command: null,
            cwd: null,
            port: null,
            url: null,
            provider: "local_process",
            providerRef: null,
            ownerAgentId: null,
            startedByRunId: null,
            lastUsedAt: new Date(),
            startedAt: new Date(),
            stoppedAt: null,
            stopPolicy: null,
            healthStatus: "healthy",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      }),
    );
    renderDialog();

    expect(await screen.findByTestId("workspace-close-services")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
  });
});
