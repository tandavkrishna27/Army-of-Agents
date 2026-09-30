import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewIssueDialog } from "../components/NewIssueDialog";
import { issuesApi } from "../api/issues";

const agent = vi.hoisted(() => ({
  id: "agent-1",
  name: "Ada Agent",
  role: "engineer",
  title: "Engineer",
  status: "idle",
  adapterType: "process",
  icon: "bot",
}));

const teamAccess = vi.hoisted(() => ({
  summary: {
    currentUser: {
      userId: "founder-1",
      role: "founder",
      departmentId: null,
      isSystemAdmin: true,
      permissions: {
        canAssignTasks: true,
        canInviteUsers: true,
        canManageRoles: true,
        canEditIdentityMemory: true,
      },
    },
    members: [
      {
        userId: "human-1",
        email: "mia@example.com",
        displayName: "Mia Manager",
        avatarUrl: null,
        title: "General Manager",
        role: "team_lead",
        departmentId: null,
        departmentName: null,
        permissions: [],
        isCurrentUser: false,
        isSystemAdmin: false,
        parentType: null,
        parentId: null,
      },
    ],
    pendingInvites: [],
  },
  permissions: {
    canAssignTasks: true,
    canInviteUsers: true,
    canManageRoles: true,
    canEditIdentityMemory: true,
  },
}));

const companyState = vi.hoisted(() => ({
  companies: [
    { id: "comp-1", name: "Acme", status: "active" },
    { id: "comp-2", name: "Globex", status: "active" },
  ],
  selectedCompanyId: "comp-1",
  selectedCompany: { id: "comp-1", name: "Acme" },
}));

const dialogState = vi.hoisted(() => ({
  defaults: { title: "Launch the thing" },
  closeNewIssue: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newIssueOpen: true,
    newIssueDefaults: dialogState.defaults,
    closeNewIssue: dialogState.closeNewIssue,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: () => ({ orderedProjects: [] }),
}));

vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => teamAccess,
}));

vi.mock("../hooks/useWorkspacePermissions", () => ({
  useWorkspacePermissions: () => ({ canOverrideTaskWorkspace: true }),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    create: vi.fn().mockResolvedValue({ id: "issue-1", identifier: "AOA-1", title: "Launch the thing" }),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([agent]), adapterModels: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "founder-1" } }) },
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
  InlineEntitySelector: ({
    value,
    options,
    placeholder,
    onChange,
  }: {
    value: string;
    options: Array<{ id: string; label: string }>;
    placeholder: string;
    onChange: (id: string) => void;
  }) => {
    const selected = options.find((option) => option.id === value);
    const firstOption = options.find((option) => option.label !== "No responsible human")?.id ?? options[0]?.id ?? "";
    return (
      <div data-testid={`selector-${placeholder}`}>
        <span data-testid={`selector-${placeholder}-value`}>{selected?.label ?? placeholder}</span>
        <span data-testid={`selector-${placeholder}-options`}>{options.length}</span>
        {options.map((option) => (
          <button key={option.id} type="button" onClick={() => onChange(option.id)}>
            Choose {option.label}
          </button>
        ))}
        <button type="button" onClick={() => onChange(firstOption)}>
          Choose {placeholder}
        </button>
        <button type="button" onClick={() => onChange("")}>
          Clear {placeholder}
        </button>
      </div>
    );
  },
}));

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewIssueDialog />
    </QueryClientProvider>,
  );
}

describe("NewIssueDialog responsible human", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    dialogState.defaults = { title: "Launch the thing" };
    companyState.companies = [
      { id: "comp-1", name: "Acme", status: "active" },
      { id: "comp-2", name: "Globex", status: "active" },
    ];
    companyState.selectedCompanyId = "comp-1";
    companyState.selectedCompany = { id: "comp-1", name: "Acme" };
    teamAccess.permissions.canAssignTasks = true;
    teamAccess.summary.currentUser.permissions.canAssignTasks = true;
    teamAccess.summary.members = [
      {
        userId: "human-1",
        email: "mia@example.com",
        displayName: "Mia Manager",
        avatarUrl: null,
        title: "General Manager",
        role: "team_lead",
        departmentId: null,
        departmentName: null,
        permissions: [],
        isCurrentUser: false,
        isSystemAdmin: false,
        parentType: null,
        parentId: null,
      },
    ];
  });

  it("sends selected responsible human separately from agent assignee on create", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("selector-Assignee-options")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByTestId("selector-Responsible human-options")).toHaveTextContent("2"));

    fireEvent.click(screen.getByRole("button", { name: "Choose Assignee" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose Responsible human" }));
    await waitFor(() => expect(screen.getByTestId("selector-Assignee-value")).toHaveTextContent("Ada Agent"));
    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Mia Manager"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() =>
      expect(issuesApi.create).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({
          assigneeAgentId: "agent-1",
          responsibleUserId: "human-1",
        }),
      ),
    );
  });

  it("creates a human-assigned task and lets backend default responsible human", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("selector-Assignee-options")).toHaveTextContent("2"));
    fireEvent.click(within(screen.getByTestId("selector-Assignee")).getByRole("button", { name: "Choose Mia Manager" }));
    await waitFor(() => expect(screen.getByTestId("selector-Assignee-value")).toHaveTextContent("Mia Manager"));
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() =>
      expect(issuesApi.create).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({
          assigneeAgentId: null,
          assigneeUserId: "human-1",
        }),
      ),
    );
    expect(issuesApi.create).toHaveBeenCalledWith(
      "comp-1",
      expect.not.objectContaining({ responsibleUserId: expect.anything() }),
    );
  });

  it("omits responsibleUserId when the responsible human is blank or cleared", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("selector-Responsible human-options")).toHaveTextContent("2"));

    fireEvent.click(screen.getByRole("button", { name: "Choose Responsible human" }));
    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Mia Manager"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear Responsible human" }));
    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Responsible human"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => expect(issuesApi.create).toHaveBeenCalled());
    expect(issuesApi.create).toHaveBeenCalledWith(
      "comp-1",
      expect.not.objectContaining({ responsibleUserId: expect.anything() }),
    );
  });

  it("sends null when the explicit no responsible human option is selected", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("selector-Responsible human-options")).toHaveTextContent("2"));

    fireEvent.click(screen.getByRole("button", { name: "Choose No responsible human" }));
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => expect(issuesApi.create).toHaveBeenCalled());
    expect(issuesApi.create).toHaveBeenCalledWith(
      "comp-1",
      expect.objectContaining({ responsibleUserId: null }),
    );
  });

  it("clears the responsible human when the dialog company changes", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("selector-Responsible human-options")).toHaveTextContent("2"));

    fireEvent.click(screen.getByRole("button", { name: "Choose Responsible human" }));
    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Mia Manager"),
    );

    fireEvent.click(screen.getByRole("button", { name: "ACM" }));
    fireEvent.click(screen.getByRole("button", { name: /Globex/i }));

    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Responsible human"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => expect(issuesApi.create).toHaveBeenCalled());
    expect(issuesApi.create).toHaveBeenCalledWith(
      "comp-2",
      expect.not.objectContaining({ responsibleUserId: expect.anything() }),
    );
  });

  it("resets the responsible human after a successful create", async () => {
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("selector-Responsible human-options")).toHaveTextContent("2"));

    fireEvent.click(screen.getByRole("button", { name: "Choose Responsible human" }));
    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Mia Manager"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => expect(dialogState.closeNewIssue).toHaveBeenCalled());
    expect(issuesApi.create).toHaveBeenCalledWith(
      "comp-1",
      expect.objectContaining({ responsibleUserId: "human-1" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Responsible human"),
    );
    expect(localStorage.getItem("aoa:issue-draft")).toBeNull();
  });

  it("does not expose or submit responsible human selection without assignment permission", async () => {
    localStorage.setItem(
      "aoa:issue-draft",
      JSON.stringify({
        title: "Restore without assignment access",
        description: "",
        status: "todo",
        priority: "",
        assigneeId: "",
        responsibleUserId: "human-1",
        projectId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
        assigneeUseProjectWorkspace: true,
      }),
    );
    dialogState.defaults = {};
    teamAccess.permissions.canAssignTasks = false;
    teamAccess.summary.currentUser.permissions.canAssignTasks = false;

    renderDialog();

    expect(await screen.findByText("No assignment access")).toBeInTheDocument();
    expect(screen.queryByTestId("selector-Responsible human")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => expect(issuesApi.create).toHaveBeenCalled());
    expect(issuesApi.create).toHaveBeenCalledWith(
      "comp-1",
      expect.not.objectContaining({
        assigneeAgentId: expect.anything(),
        responsibleUserId: expect.anything(),
      }),
    );
  });

  it("saves and restores a valid responsible human in the dialog draft", async () => {
    const firstRender = renderDialog();

    await waitFor(() => expect(screen.getByTestId("selector-Responsible human-options")).toHaveTextContent("2"));

    fireEvent.click(screen.getByRole("button", { name: "Choose Responsible human" }));
    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Mia Manager"),
    );
    await waitFor(() => {
      const rawDraft = localStorage.getItem("aoa:issue-draft");
      expect(rawDraft).not.toBeNull();
      expect(JSON.parse(rawDraft!).responsibleUserId).toBe("human-1");
    });

    firstRender.unmount();
    dialogState.defaults = {};
    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Mia Manager"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() =>
      expect(issuesApi.create).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({
          responsibleUserId: "human-1",
        }),
      ),
    );
  });

  it("prunes a stale draft responsible human when that person is no longer on the team", async () => {
    localStorage.setItem(
      "aoa:issue-draft",
      JSON.stringify({
        title: "Restore from stale draft",
        description: "",
        status: "todo",
        priority: "",
        assigneeId: "",
        responsibleUserId: "human-stale",
        projectId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
        assigneeUseProjectWorkspace: true,
      }),
    );
    dialogState.defaults = {};
    teamAccess.summary.members = [];

    renderDialog();

    await waitFor(() =>
      expect(screen.getByTestId("selector-Responsible human-value")).toHaveTextContent("Responsible human"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));

    await waitFor(() => expect(issuesApi.create).toHaveBeenCalled());
    expect(issuesApi.create).toHaveBeenCalledWith(
      "comp-1",
      expect.not.objectContaining({ responsibleUserId: expect.anything() }),
    );
  });
});
