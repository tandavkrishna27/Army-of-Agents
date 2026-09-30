import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExecutionWorkspace, Issue, WorkspaceOperation } from "@armyofagents/shared";

import { ApiError } from "../api/client";

const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockListOps = vi.fn();

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    get: (...args: unknown[]) => mockGet(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    listWorkspaceOperations: (...args: unknown[]) => mockListOps(...args),
  },
}));

const mockIssuesList = vi.fn();
let workspacePermissionState = {
  canEditDepartmentWorkspaceSettings: true,
  canConfigureRuntimeCommands: true,
};
vi.mock("../api/issues", () => ({
  issuesApi: {
    list: (...args: unknown[]) => mockIssuesList(...args),
  },
}));

vi.mock("../hooks/useWorkspacePermissions", () => ({
  useWorkspacePermissions: () => workspacePermissionState,
}));

import { WorkspaceSettingsSheet } from "../components/workspace/WorkspaceSettingsSheet";

function makeWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "ws-1",
    companyId: "comp-1",
    projectId: "proj-1",
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "workspace-one",
    status: "active",
    cwd: "/home/agent/ws-1",
    repoUrl: "https://example.com/repo.git",
    branchName: "feat/one",
    baseRef: "main",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: {
      provisionCommand: "pnpm install",
      teardownCommand: null,
      cleanupCommand: null,
      workspaceRuntime: null,
      desiredState: null,
      serviceStates: null,
    },
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ExecutionWorkspace;
}

function makeOperation(overrides: Partial<WorkspaceOperation> = {}): WorkspaceOperation {
  return {
    id: "op-1",
    companyId: "comp-1",
    executionWorkspaceId: "ws-1",
    heartbeatRunId: null,
    phase: "workspace_provision",
    command: "pnpm install",
    cwd: "/home/agent/ws-1",
    status: "succeeded",
    exitCode: 0,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    metadata: null,
    startedAt: new Date(),
    finishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "iss-1",
    companyId: "comp-1",
    projectId: "proj-1",
    identifier: "ISS-1",
    title: "Linked task",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    parentId: null,
    reporterId: null,
    executionWorkspaceId: "ws-1",
    labels: [],
    dueDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Issue;
}

function renderSheet(props: Partial<{ open: boolean; onOpenChange: (v: boolean) => void }> = {}) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const onOpenChange = props.onOpenChange ?? vi.fn();
  return {
    onOpenChange,
    queryClient: qc,
    ...render(
      <QueryClientProvider client={qc}>
        <WorkspaceSettingsSheet
          workspaceId="ws-1"
          companyId="comp-1"
          open={props.open ?? true}
          onOpenChange={onOpenChange}
        />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  workspacePermissionState = {
    canEditDepartmentWorkspaceSettings: true,
    canConfigureRuntimeCommands: true,
  };
  mockListOps.mockResolvedValue([]);
  mockIssuesList.mockResolvedValue([]);
});

describe("WorkspaceSettingsSheet", () => {
  it("renders loading state while query pending", () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    renderSheet();
    expect(screen.getByTestId("workspace-settings-loading")).toBeInTheDocument();
  });

  it("renders 3 section headings when data loaded", async () => {
    mockGet.mockResolvedValue(makeWorkspace());
    renderSheet();

    await waitFor(() => {
      expect(screen.getByText("Configuration")).toBeInTheDocument();
    });
    expect(screen.getByText("Runtime logs")).toBeInTheDocument();
    expect(screen.getByText("Linked tasks")).toBeInTheDocument();
  });

  it("populates name field from workspace", async () => {
    mockGet.mockResolvedValue(makeWorkspace({ name: "my-ws" }));
    renderSheet();

    await waitFor(() => {
      const input = screen.getByTestId("workspace-settings-field-name") as HTMLInputElement;
      expect(input.value).toBe("my-ws");
    });
  });

  it("editing name and clicking Save triggers updateMutation with {name}", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(makeWorkspace({ name: "old-name" }));
    mockUpdate.mockResolvedValue(makeWorkspace({ name: "new-name" }));

    renderSheet();

    const nameInput = await screen.findByTestId("workspace-settings-field-name");
    await user.clear(nameInput);
    await user.type(nameInput, "new-name");

    const saveBtn = screen.getByTestId("workspace-settings-save");
    await user.click(saveBtn);

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("ws-1", { name: "new-name" });
    });
  });

  it("save invalidates detail query on success", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(makeWorkspace({ name: "old" }));
    mockUpdate.mockResolvedValue(makeWorkspace({ name: "new" }));

    const { queryClient } = renderSheet();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const nameInput = await screen.findByTestId("workspace-settings-field-name");
    await user.clear(nameInput);
    await user.type(nameInput, "new");
    await user.click(screen.getByTestId("workspace-settings-save"));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalled();
    });
  });

  it("403 response shows forbidden banner and disables inputs", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(makeWorkspace({ name: "old" }));
    mockUpdate.mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));

    renderSheet();
    const nameInput = (await screen.findByTestId("workspace-settings-field-name")) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "new");
    await user.click(screen.getByTestId("workspace-settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-settings-forbidden-banner")).toBeInTheDocument();
    });
    expect(
      (screen.getByTestId("workspace-settings-field-name") as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows read-only configuration when current user cannot edit workspace settings", async () => {
    workspacePermissionState.canEditDepartmentWorkspaceSettings = false;
    mockGet.mockResolvedValue(makeWorkspace({ name: "locked" }));

    renderSheet();

    const nameInput = (await screen.findByTestId("workspace-settings-field-name")) as HTMLInputElement;
    expect(nameInput.disabled).toBe(true);
    expect(screen.getByTestId("workspace-settings-forbidden-banner")).toHaveTextContent(
      /don't have permission/i,
    );
    expect(screen.queryByTestId("workspace-settings-save")).not.toBeInTheDocument();
  });

  it("disables runtime command fields for non-founder users while allowing safe fields", async () => {
    workspacePermissionState.canConfigureRuntimeCommands = false;
    mockGet.mockResolvedValue(makeWorkspace({ name: "lead-editable" }));

    renderSheet();

    const nameInput = (await screen.findByTestId("workspace-settings-field-name")) as HTMLInputElement;
    expect(nameInput.disabled).toBe(false);
    expect((screen.getByTestId("workspace-settings-field-provisionCommand") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("workspace-settings-field-teardownCommand") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("workspace-settings-field-cleanupCommand") as HTMLInputElement).disabled).toBe(true);
  });

  it("invalid repo URL shows error banner and does not call mutation", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(makeWorkspace({ repoUrl: "https://example.com/a.git" }));

    renderSheet();
    const repo = await screen.findByTestId("workspace-settings-field-repoUrl");
    await user.clear(repo);
    await user.type(repo, "not-a-url");
    await user.click(screen.getByTestId("workspace-settings-save"));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-settings-error-banner")).toBeInTheDocument();
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("runtime logs renders operations list with limit=50 param", async () => {
    mockGet.mockResolvedValue(makeWorkspace());
    mockListOps.mockResolvedValue([makeOperation()]);

    renderSheet();
    await waitFor(() => {
      expect(screen.getByTestId("workspace-settings-operation-op-1")).toBeInTheDocument();
    });
    expect(mockListOps).toHaveBeenCalledWith("ws-1", { limit: 50 });
  });

  it("runtime logs empty state when zero operations", async () => {
    mockGet.mockResolvedValue(makeWorkspace());
    mockListOps.mockResolvedValue([]);

    renderSheet();
    await waitFor(() => {
      expect(screen.getByTestId("workspace-settings-operations-empty")).toBeInTheDocument();
    });
  });

  it("linked issues filters by executionWorkspaceId client-side", async () => {
    mockGet.mockResolvedValue(makeWorkspace());
    mockIssuesList.mockResolvedValue([
      makeIssue({ id: "iss-1", title: "In workspace", executionWorkspaceId: "ws-1" }),
      makeIssue({ id: "iss-2", title: "Different workspace", executionWorkspaceId: "ws-other" }),
      makeIssue({ id: "iss-3", title: "No workspace", executionWorkspaceId: null } as unknown as Partial<Issue>),
    ]);

    renderSheet();
    await waitFor(() => {
      expect(screen.getByText("In workspace")).toBeInTheDocument();
    });
    expect(screen.queryByText("Different workspace")).not.toBeInTheDocument();
    expect(screen.queryByText("No workspace")).not.toBeInTheDocument();
  });

  it("linked issues empty state when none match", async () => {
    mockGet.mockResolvedValue(makeWorkspace());
    mockIssuesList.mockResolvedValue([
      makeIssue({ id: "iss-2", executionWorkspaceId: "ws-other" }),
    ]);

    renderSheet();
    await waitFor(() => {
      expect(screen.getByTestId("workspace-settings-linked-issues-empty")).toBeInTheDocument();
    });
  });

  it("content not in DOM when open=false (conditional mount)", () => {
    mockGet.mockResolvedValue(makeWorkspace());
    renderSheet({ open: false });

    expect(screen.queryByTestId("workspace-settings-sheet")).not.toBeInTheDocument();
  });

  it("Reset button reverts form to initial state", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(makeWorkspace({ name: "original" }));

    renderSheet();
    const nameInput = (await screen.findByTestId("workspace-settings-field-name")) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "changed");
    expect(nameInput.value).toBe("changed");

    await user.click(screen.getByTestId("workspace-settings-reset"));

    await waitFor(() => {
      expect((screen.getByTestId("workspace-settings-field-name") as HTMLInputElement).value).toBe(
        "original",
      );
    });
  });

  it("background refetch does not clobber in-progress edits (dirty-flag guard)", async () => {
    const user = userEvent.setup();
    mockGet.mockResolvedValue(makeWorkspace({ name: "original" }));

    const { queryClient } = renderSheet();
    const nameInput = (await screen.findByTestId("workspace-settings-field-name")) as HTMLInputElement;

    await user.clear(nameInput);
    await user.type(nameInput, "user-edit-in-progress");
    expect(nameInput.value).toBe("user-edit-in-progress");

    // Simulate a background refetch (window focus / polling / mutation invalidation)
    await queryClient.invalidateQueries({
      queryKey: ["executionWorkspaces", "detail", "ws-1"],
    });

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));

    // Dirty-flag guard: the user's in-progress edit must survive the refetch.
    expect(
      (screen.getByTestId("workspace-settings-field-name") as HTMLInputElement).value,
    ).toBe("user-edit-in-progress");
  });
});
