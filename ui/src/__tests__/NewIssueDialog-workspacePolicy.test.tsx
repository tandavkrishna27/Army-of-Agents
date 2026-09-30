import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewIssueDialog } from "../components/NewIssueDialog";
import { issuesApi } from "../api/issues";

const project = vi.hoisted(() => ({
  id: "proj-1",
  name: "Engineering",
  description: "",
  color: "#cc3b2f",
  functionType: "software_development",
  executionWorkspacePolicy: {
    enabled: true,
    defaultMode: "isolated_workspace",
    allowIssueOverride: true,
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "comp-1", name: "Acme", status: "active" }],
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Acme" },
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newIssueOpen: true,
    newIssueDefaults: { projectId: "proj-1", title: "Use existing workspace" },
    closeNewIssue: vi.fn(),
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: () => ({ orderedProjects: [project] }),
}));

vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({ permissions: { canAssignTasks: true } }),
}));

vi.mock("../hooks/useWorkspacePermissions", () => ({
  useWorkspacePermissions: () => ({ canOverrideTaskWorkspace: true }),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    create: vi.fn().mockResolvedValue({ id: "issue-1", identifier: "AOA-1", title: "Task" }),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([project]) },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]), adapterModels: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "u1" } }) },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("../api/environments", () => ({
  useEnvironments: () => ({ data: [] }),
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    listSummaries: vi.fn().mockResolvedValue([
      {
        id: "ws-1",
        name: "Feature workspace",
        branchName: "feature/work",
        lastUsedAt: "2026-05-20T00:00:00Z",
      },
    ]),
  },
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea data-testid="md-editor" />,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("../components/InlineEntitySelector", () => ({
  InlineEntitySelector: () => null,
}));

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewIssueDialog />
    </QueryClientProvider>,
  );
}

describe("NewIssueDialog workspace policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("shows the department default workspace choice for a policy-enabled department once Advanced is expanded", async () => {
    renderDialog();

    // Not visible until Advanced is expanded (Task workspace mode lives behind the disclosure).
    expect(screen.queryByText("Department default")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));

    expect(await screen.findByText("Department default")).toBeInTheDocument();
  });

  it("sends reuse_existing workspace fields when a reusable workspace is selected", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /advanced/i }));
    await user.click(await screen.findByText("Department default"));
    await user.click(await screen.findByText("Feature workspace"));
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() =>
      expect(issuesApi.create).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({
          executionWorkspacePreference: "reuse_existing",
          executionWorkspaceSettings: {
            mode: "reuse_existing",
            reuseWorkspaceId: "ws-1",
          },
        }),
      ),
    );
  });
});
