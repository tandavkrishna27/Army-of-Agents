import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewIssueDialog } from "../components/NewIssueDialog";

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
    newIssueDefaults: { projectId: "proj-1" },
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
  executionWorkspacesApi: { listSummaries: vi.fn().mockResolvedValue([]) },
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

describe("NewIssueDialog — Advanced disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("hides advanced controls behind an Advanced disclosure and drops dead placeholders", async () => {
    renderDialog();

    // Essentials visible:
    expect(screen.getByPlaceholderText("Task title")).toBeInTheDocument();
    expect(screen.getByText("Standard")).toBeInTheDocument();

    // Dead placeholders GONE entirely:
    expect(screen.queryByText(/^labels$/i)).toBeNull();
    expect(screen.queryByText(/start date/i)).toBeNull();
    expect(screen.queryByText(/due date/i)).toBeNull();

    // Environment / Task workspace are NOT visible until Advanced is expanded:
    expect(screen.queryByText(/environment/i)).toBeNull();
    expect(screen.queryByText(/department default/i)).toBeNull();

    // Expand Advanced:
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));

    expect(await screen.findByText(/environment/i)).toBeInTheDocument();
    expect(await screen.findByText(/department default/i)).toBeInTheDocument();
  });
});
