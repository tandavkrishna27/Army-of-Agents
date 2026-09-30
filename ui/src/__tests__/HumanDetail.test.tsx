import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { HumanDetail } from "../pages/HumanDetail";
import { teamApi } from "../api/team";
import { issuesApi } from "../api/issues";
import { activityApi } from "../api/activity";
import { assetsApi } from "../api/assets";
import { SidebarProvider } from "../context/SidebarContext";

const pushToast = vi.fn();

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

vi.mock("../api/team", () => ({
  teamApi: {
    get: vi.fn(),
    getMember: vi.fn(),
    updateRole: vi.fn(),
    updateProfile: vi.fn(),
    listCapabilities: vi.fn(),
    createCapabilityDocument: vi.fn(),
    updateCapabilityDocument: vi.fn(),
    deleteCapabilityDocument: vi.fn(),
    getWorkload: vi.fn(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: vi.fn(),
  },
}));

vi.mock("../api/activity", () => ({
  activityApi: {
    list: vi.fn(),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(),
  },
}));

vi.mock("../components/TaskSlideOver", () => ({
  TaskSlideOver: ({ issueId, open, onClose }: { issueId: string | null; open: boolean; onClose: () => void }) =>
    open ? (
      <div role="dialog" aria-label="Task details">
        <span>Local task slide-over: {issueId}</span>
        <button type="button" onClick={onClose}>Close task</button>
      </div>
    ) : null,
}));

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="current-location">{`${location.pathname}${location.search}`}</div>;
}

function renderHumanDetail(path = "/team/user-1") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <MemoryRouter initialEntries={[path]}>
            <LocationProbe />
            <Routes>
              <Route path="/team/:userId" element={children} />
              <Route path="/team/:userId/:tab" element={children} />
            </Routes>
          </MemoryRouter>
        </SidebarProvider>
      </QueryClientProvider>
    );
  }

  return {
    ...render(<HumanDetail />, { wrapper: Wrapper }),
    queryClient,
  };
}

const member = {
  userId: "user-1",
  email: "ada@example.com",
  displayName: "Ada Lovelace",
  avatarUrl: null,
  title: "Product Lead",
  bio: "Turns founder intent into shipped operating systems.",
  location: "London",
  timezone: "Europe/London",
  socialLinks: [{ type: "github", label: "GitHub", url: "https://github.com/ada" }],
  avatarAssetId: null,
  role: "team_lead",
  departmentId: "dept-1",
  departmentName: "Product",
  permissions: ["tasks.assign"],
  isCurrentUser: true,
  isSystemAdmin: false,
  parentType: "user",
  parentId: "founder-1",
} as const;

const teamSummary = {
  currentUser: {
    userId: "user-1",
    role: "team_lead",
    departmentId: "dept-1",
    isSystemAdmin: false,
    permissions: {
      canAssignTasks: true,
      canInviteUsers: false,
      canManageRoles: false,
      canEditIdentityMemory: false,
    },
  },
  members: [
    member,
    {
      ...member,
      userId: "founder-1",
      email: "founder@example.com",
      displayName: "Grace Founder",
      role: "founder",
      isCurrentUser: false,
      parentId: null,
    },
  ],
  pendingInvites: [],
};

const roleManagerTeamSummary = {
  ...teamSummary,
  currentUser: {
    ...teamSummary.currentUser,
    userId: "founder-1",
    role: "founder",
    departmentId: null,
    permissions: {
      ...teamSummary.currentUser.permissions,
      canManageRoles: true,
    },
  },
};

async function chooseSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  scope: typeof screen | ReturnType<typeof within>,
  name: string,
  optionName: string | RegExp,
) {
  await user.click(scope.getByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function issue(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    goalId: null,
    parentId: null,
    title: "Draft onboarding profile",
    description: null,
    status: "todo",
    priority: "medium",
    workMode: "standard",
    assigneeAgentId: null,
    assigneeUserId: "user-1",
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    executionWorkspaceId: null,
    executionEnvironmentId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 42,
    identifier: "AOA-42",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    source: null,
    reviewerUserId: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    artifactId: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  };
}

function makeWorkload() {
  const updatedAt = new Date("2026-07-09T00:00:00.000Z");
  return {
    companyId: "company-1",
    userId: "user-1",
    generatedAt: updatedAt,
    summary: {
      responsibleOpenTaskCount: 1,
      assignedOpenTaskCount: 1,
      managedAgentCount: 1,
      managedAgentOpenTaskCount: 1,
      attentionCount: 1,
    },
    responsibleTasks: [
      {
        id: "issue-1",
        identifier: "MANA-1",
        title: "Own launch checklist",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        responsibleUserId: "user-1",
        dueDate: null,
        updatedAt,
      },
    ],
    assignedTasks: [
      {
        id: "issue-2",
        identifier: "MANA-2",
        title: "Direct human task",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        responsibleUserId: "user-1",
        dueDate: null,
        updatedAt,
      },
    ],
    managedAgents: [
      {
        id: "agent-1",
        name: "Engineer",
        role: "engineer",
        status: "idle",
        rootAgentId: "agent-1",
        rootAgentName: "Engineer",
        openTaskCount: 1,
      },
    ],
    managedAgentTasks: [
      {
        id: "issue-3",
        identifier: "MANA-3",
        title: "Managed agent blocked task",
        status: "blocked",
        priority: "high",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        responsibleUserId: "user-1",
        dueDate: null,
        updatedAt,
        managedAgentId: "agent-1",
        managedAgentName: "Engineer",
        rootAgentId: "agent-1",
        rootAgentName: "Engineer",
      },
    ],
    attentionItems: [
      {
        kind: "blocked_task",
        taskId: "issue-3",
        identifier: "MANA-3",
        title: "Managed agent blocked task",
        status: "blocked",
        source: "managed_agent",
        agentId: "agent-1",
        agentName: "Engineer",
      },
    ],
  } as never;
}

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(teamApi.getMember).mockResolvedValue({
    member,
    dependencies: {
      teamMembers: [],
      agentTrees: [{ rootAgentId: "agent-1", rootAgentName: "Ops Agent", subAgentCount: 1, agentIds: ["agent-1", "agent-2"] }],
      assignedTaskCount: 1,
      createdTaskCount: 1,
    },
  });
  vi.mocked(teamApi.get).mockResolvedValue(teamSummary);
  vi.mocked(teamApi.getWorkload).mockResolvedValue(makeWorkload());
  vi.mocked(teamApi.updateProfile).mockResolvedValue({
    profile: {
      id: "profile-1",
      companyId: "company-1",
      userId: "user-1",
      displayName: "Ada Lovelace",
      title: "Product Lead",
      bio: "Turns founder intent into shipped operating systems.",
      location: "London",
      timezone: "Europe/London",
      socialLinks: [{ type: "github", label: "GitHub", url: "https://github.com/ada" }],
      avatarAssetId: null,
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
      updatedAt: new Date("2026-07-01T10:00:00.000Z"),
      updatedByUserId: "user-1",
    },
  });
  vi.mocked(teamApi.listCapabilities).mockResolvedValue({
    companyId: "company-1",
    userId: "user-1",
    documents: [
      {
        id: "cap-skills",
        companyId: "company-1",
        userId: "user-1",
        slug: "skills",
        filename: "skills.md",
        title: "Skills",
        kind: "skills",
        content: "# Skills\n\n## Core Skills\n\n- Product strategy",
        sortOrder: 20,
        isStandard: true,
        createdAt: new Date("2026-07-08T00:00:00.000Z"),
        updatedAt: new Date("2026-07-08T00:00:00.000Z"),
        createdByUserId: null,
        updatedByUserId: null,
      },
      {
        id: "cap-background",
        companyId: "company-1",
        userId: "user-1",
        slug: "background",
        filename: "background.md",
        title: "Background",
        kind: "background",
        content: "# Background\n\n## Professional Background\n\n- Founder operator",
        sortOrder: 60,
        isStandard: true,
        createdAt: new Date("2026-07-08T00:00:00.000Z"),
        updatedAt: new Date("2026-07-08T00:00:00.000Z"),
        createdByUserId: null,
        updatedByUserId: null,
      },
    ],
  } as never);
  vi.mocked(teamApi.updateCapabilityDocument).mockResolvedValue({
    document: {
      id: "cap-skills",
      companyId: "company-1",
      userId: "user-1",
      slug: "skills",
      filename: "skills.md",
      title: "Skills",
      kind: "skills",
      content: "# Skills\n\n## Core Skills\n\n- Product strategy\n- Hiring",
      sortOrder: 20,
      isStandard: true,
      createdAt: new Date("2026-07-08T00:00:00.000Z"),
      updatedAt: new Date("2026-07-08T00:00:00.000Z"),
      createdByUserId: null,
      updatedByUserId: "user-1",
    },
  } as never);
  vi.mocked(teamApi.createCapabilityDocument).mockResolvedValue({
    document: {
      id: "cap-portfolio",
      companyId: "company-1",
      userId: "user-1",
      slug: "portfolio",
      filename: "portfolio.md",
      title: "Portfolio",
      kind: "custom",
      content: "# Portfolio",
      sortOrder: 1000,
      isStandard: false,
      createdAt: new Date("2026-07-08T00:00:00.000Z"),
      updatedAt: new Date("2026-07-08T00:00:00.000Z"),
      createdByUserId: "user-1",
      updatedByUserId: "user-1",
    },
  } as never);
  vi.mocked(teamApi.deleteCapabilityDocument).mockResolvedValue({ ok: true });
  vi.mocked(assetsApi.uploadImage).mockResolvedValue({
    assetId: "asset-1",
    companyId: "company-1",
    contentPath: "/api/assets/asset-1/content",
  } as never);
  vi.mocked(activityApi.list).mockResolvedValue([
    {
      id: "activity-1",
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action: "issue.created",
      entityType: "issue",
      entityId: "issue-created",
      agentId: null,
      runId: null,
      details: { title: "Created launch checklist" },
      createdAt: "2026-07-03T10:00:00.000Z",
    },
  ] as never);
  vi.mocked(issuesApi.list).mockImplementation(async (_companyId, filters) => {
    if (filters?.responsibleUserId === "user-1") {
      return [issue({ id: "responsible-1", identifier: "AOA-0", title: "Owned by Ada", responsibleUserId: "user-1" })] as never;
    }
    if (filters?.assigneeUserId === "user-1") {
      return [issue({ id: "assigned-1", identifier: "AOA-1", title: "Assigned directly" })] as never;
    }
    if (filters?.createdByUserId === "user-1") {
      return [issue({ id: "created-1", identifier: "AOA-2", title: "Created by Ada" })] as never;
    }
    if (filters?.assigneeAgentId === "agent-1") {
      return [issue({ id: "agent-task-1", identifier: "AOA-3", title: "Agent follow-up", assigneeAgentId: "agent-1", assigneeUserId: null })] as never;
    }
    return [] as never;
  });
});

describe("HumanDetail", () => {
  it("renders profile fields and compact overview sections with query filters", async () => {
    renderHumanDetail();

    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getByTestId("human-profile-avatar")).toHaveAttribute("data-shape", "squircle");
    expect(screen.getByRole("button", { name: "Edit profile" })).toBeInTheDocument();
    expect(screen.queryByText("Edit Profile")).not.toBeInTheDocument();
    expect(screen.getByText("Product Lead")).toBeInTheDocument();
    expect(screen.getByText("Turns founder intent into shipped operating systems.")).toBeInTheDocument();
    expect(screen.getByText("London")).toBeInTheDocument();
    expect(screen.getByText("Europe/London")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/ada");

    expect(await screen.findByText("Responsible Tasks")).toBeInTheDocument();
    expect(screen.getByText("Owned by Ada")).toBeInTheDocument();
    expect(await screen.findByText("Assigned directly")).toBeInTheDocument();
    expect(screen.getByText("Created by Ada")).toBeInTheDocument();
    expect(screen.getByText("Agent follow-up")).toBeInTheDocument();
    expect(screen.getByText("issue.created")).toBeInTheDocument();
    expect(screen.queryByText("Authority")).not.toBeInTheDocument();

    expect(issuesApi.list).toHaveBeenCalledWith("company-1", { responsibleUserId: "user-1", taskScope: "all" });
    expect(issuesApi.list).toHaveBeenCalledWith("company-1", { assigneeUserId: "user-1", taskScope: "all" });
    expect(issuesApi.list).toHaveBeenCalledWith("company-1", { createdByUserId: "user-1", taskScope: "all" });
    expect(issuesApi.list).toHaveBeenCalledWith("company-1", { assigneeAgentId: "agent-1", taskScope: "all" });
    expect(issuesApi.list).toHaveBeenCalledWith("company-1", { assigneeAgentId: "agent-2", taskScope: "all" });
    expect(activityApi.list).toHaveBeenCalledWith("company-1", { actorType: "user", actorId: "user-1" });
  });

  it("loads workload data on the Workload tab", async () => {
    renderHumanDetail("/team/user-1/workload");

    await waitFor(() => {
      expect(teamApi.getWorkload).toHaveBeenCalledWith("company-1", "user-1");
    });
  });

  it("renders workload summary, attention, task links, and managed agents without inline mutations", async () => {
    renderHumanDetail("/team/user-1/workload");

    expect(await screen.findByRole("heading", { name: "Needs Attention" })).toBeInTheDocument();
    expect(screen.getByText("Own launch checklist")).toBeInTheDocument();
    expect(screen.getByText("Direct human task")).toBeInTheDocument();
    expect(screen.getAllByText("Managed agent blocked task")).toHaveLength(2);
    expect(screen.getByText("Engineer")).toBeInTheDocument();

    expect(screen.getByText("Responsible")).toBeInTheDocument();
    expect(screen.getByText("Assigned")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Managed Agents" })).toBeInTheDocument();

    expect(screen.getByRole("button", { name: /Open Own launch checklist/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Engineer/ })).toHaveAttribute("href", "/agents/agent-1");
    expect(screen.queryByRole("button", { name: /change status/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /assign/i })).not.toBeInTheDocument();
  });

  it("opens workload tasks in a local slide-over without leaving the human page", async () => {
    const user = userEvent.setup();
    renderHumanDetail("/team/user-1/workload");

    await user.click(await screen.findByRole("button", { name: /Open Own launch checklist/ }));

    expect(screen.getByRole("dialog", { name: "Task details" })).toHaveTextContent("Local task slide-over: issue-1");
    expect(screen.getByTestId("current-location")).toHaveTextContent("/team/user-1/workload?task=issue-1");

    await user.click(screen.getByRole("button", { name: "Close task" }));

    expect(screen.queryByRole("dialog", { name: "Task details" })).not.toBeInTheDocument();
    expect(screen.getByTestId("current-location")).toHaveTextContent("/team/user-1/workload");
  });

  it("opens a modal from the header and saves profile display fields", async () => {
    const user = userEvent.setup();
    renderHumanDetail();

    await user.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Profile" });
    expect(dialog).toHaveClass("flex-col");
    expect(within(dialog).queryByText("Company profile identity")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Choose File")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Upload Avatar")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Remove Avatar")).not.toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Display name"));
    await user.type(within(dialog).getByLabelText("Display name"), "Ada Byron");
    await user.selectOptions(within(dialog).getByLabelText("Title"), "Founder Partner");
    await user.clear(within(dialog).getByLabelText("Bio"));
    await user.type(within(dialog).getByLabelText("Bio"), "Builds the operating cadence.");
    await user.clear(within(dialog).getByLabelText("Location"));
    await user.type(within(dialog).getByLabelText("Location"), "San Francisco");
    await user.selectOptions(within(dialog).getByLabelText("Timezone"), "America/Los_Angeles");
    await user.clear(within(dialog).getByLabelText("Label"));
    await user.type(within(dialog).getByLabelText("Label"), "Portfolio");
    await user.clear(within(dialog).getByLabelText("URL"));
    await user.type(within(dialog).getByLabelText("URL"), "https://ada.example.com");
    await user.click(within(dialog).getByRole("button", { name: "Save Profile" }));

    await waitFor(() => {
      expect(teamApi.updateProfile).toHaveBeenCalledWith("company-1", "user-1", {
        displayName: "Ada Byron",
        title: "Founder Partner",
        bio: "Builds the operating cadence.",
        location: "San Francisco",
        timezone: "America/Los_Angeles",
        socialLinks: [{ type: "github", label: "Portfolio", url: "https://ada.example.com" }],
      });
    });
  });

  it("renders authority and editable role controls in the roles tab", async () => {
    const user = userEvent.setup();
    vi.mocked(teamApi.get).mockResolvedValueOnce(roleManagerTeamSummary);
    vi.mocked(teamApi.updateRole).mockResolvedValue({
      role: "team_member",
      projectId: null,
      parentType: "user",
      parentId: "founder-1",
    });

    renderHumanDetail("/team/user-1/roles");

    expect(await screen.findByText("Authority")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Role" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit roles" })).toBeInTheDocument();
    expect(screen.getAllByText("Team Lead").length).toBeGreaterThan(0);
    expect(screen.getByText("Product")).toBeInTheDocument();
    expect(screen.getAllByText("Grace Founder").length).toBeGreaterThan(0);
    expect(screen.getByText("tasks.assign")).toBeInTheDocument();
    expect(screen.getByText("Reports")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit roles" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Roles" });
    const modal = within(dialog);

    await chooseSelectOption(user, modal, "Role", "Team Member");
    await chooseSelectOption(user, modal, "Department", "No department");
    await chooseSelectOption(user, modal, "Reports to", /Grace Founder/);
    await user.click(modal.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(teamApi.updateRole).toHaveBeenCalledWith("company-1", "user-1", {
        role: "team_member",
        projectId: null,
        parentType: "user",
        parentId: "founder-1",
      });
    });
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Role saved", tone: "success" }));
  });

  it("keeps settings focused on operational controls", async () => {
    renderHumanDetail("/team/user-1/settings");

    expect(await screen.findByRole("button", { name: "Edit profile" })).toBeInTheDocument();
    expect(screen.queryByText("Role & Department")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Profile" })).not.toBeInTheDocument();
  });

  it("renders capabilities documents and saves markdown edits", async () => {
    const user = userEvent.setup();
    renderHumanDetail("/team/user-1/capabilities");

    expect((await screen.findAllByText("skills.md")).length).toBeGreaterThan(0);
    expect(screen.getByText("background.md")).toBeInTheDocument();
    expect(screen.getByText(/Product strategy/)).toBeInTheDocument();
    expect(screen.queryByText("Professional Background")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit document" }));
    const editor = screen.getByLabelText("Capability markdown");
    await user.clear(editor);
    await user.type(editor, "# Skills\n\n## Core Skills\n\n- Product strategy\n- Hiring");
    await user.click(screen.getByRole("button", { name: "Save document" }));

    await waitFor(() => {
      expect(teamApi.updateCapabilityDocument).toHaveBeenCalledWith("company-1", "user-1", "cap-skills", {
        content: "# Skills\n\n## Core Skills\n\n- Product strategy\n- Hiring",
      });
    });
  });

  it("clears department and manager drafts when founder is selected", async () => {
    const user = userEvent.setup();
    vi.mocked(teamApi.get).mockResolvedValueOnce(roleManagerTeamSummary);
    vi.mocked(teamApi.updateRole).mockResolvedValue({
      role: "founder",
      projectId: null,
      parentType: null,
      parentId: null,
    });

    renderHumanDetail("/team/user-1/roles");

    await screen.findByText("Authority");
    await user.click(screen.getByRole("button", { name: "Edit roles" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Roles" });
    const modal = within(dialog);
    await chooseSelectOption(user, modal, "Role", "Founder");
    await user.click(modal.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(teamApi.updateRole).toHaveBeenCalledWith("company-1", "user-1", {
        role: "founder",
        projectId: null,
        parentType: null,
        parentId: null,
      });
    });
  });

  it("shows roles authority but disables editing for non-role-managers", async () => {
    vi.mocked(teamApi.get).mockResolvedValueOnce({
      ...teamSummary,
      currentUser: {
        ...teamSummary.currentUser,
        role: "team_member",
        permissions: {
          canAssignTasks: false,
          canInviteUsers: false,
          canManageRoles: false,
          canEditIdentityMemory: false,
        },
      },
    });

    renderHumanDetail("/team/user-1/roles");

    expect(await screen.findByText("Authority")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit roles" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Roles" });
    const modal = within(dialog);
    expect(modal.getByRole("combobox", { name: "Role" })).toBeDisabled();
    expect(modal.getByRole("combobox", { name: "Department" })).toBeDisabled();
    expect(modal.getByRole("combobox", { name: "Reports to" })).toBeDisabled();
  });

  it("locks all role hierarchy controls when viewing the only founder's own profile", async () => {
    const founderMember = {
      ...member,
      role: "founder",
      departmentId: null,
      departmentName: null,
      parentType: null,
      parentId: null,
      permissions: [],
      isSystemAdmin: true,
    } as const;
    vi.mocked(teamApi.getMember).mockResolvedValueOnce({
      member: founderMember,
      dependencies: {
        teamMembers: [],
        agentTrees: [],
        assignedTaskCount: 0,
        createdTaskCount: 0,
      },
    });
    vi.mocked(teamApi.get).mockResolvedValueOnce({
      currentUser: {
        userId: "user-1",
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
      members: [founderMember],
      pendingInvites: [],
    });

    renderHumanDetail("/team/user-1/roles");

    expect(await screen.findByText("Authority")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit roles" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Roles" });
    const modal = within(dialog);
    expect(modal.getByRole("combobox", { name: "Role" })).toBeDisabled();
    expect(modal.getByRole("combobox", { name: "Department" })).toBeDisabled();
    expect(modal.getByRole("combobox", { name: "Reports to" })).toBeDisabled();
    expect(modal.getByRole("button", { name: "Save Changes" })).toBeDisabled();
    expect(modal.getByText(/Your founder role is locked/)).toBeInTheDocument();
  });

  it("keeps unsaved profile edits during a background member refetch", async () => {
    const user = userEvent.setup();
    const { queryClient } = renderHumanDetail();

    await user.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Profile" });
    const displayNameInput = within(dialog).getByLabelText("Display name");
    await user.clear(displayNameInput);
    await user.type(displayNameInput, "Ada Byron");

    vi.mocked(teamApi.getMember).mockResolvedValueOnce({
      member: {
        ...member,
        displayName: "Server Refetch Name",
      },
      dependencies: {
        teamMembers: [],
        agentTrees: [],
        assignedTaskCount: 0,
        createdTaskCount: 0,
      },
    });

    await queryClient.invalidateQueries({ queryKey: ["team", "company-1", "member", "user-1"] });

    await waitFor(() => {
      expect(teamApi.getMember).toHaveBeenCalledTimes(2);
    });
    expect(displayNameInput).toHaveValue("Ada Byron");
  });

  it("uploads an avatar before saving the returned asset id and can remove it", async () => {
    const user = userEvent.setup();
    renderHumanDetail();

    await user.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Profile" });
    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    await user.upload(within(dialog).getByLabelText("Change avatar"), file);

    await waitFor(() => {
      expect(assetsApi.uploadImage).toHaveBeenCalledWith("company-1", file, "humans/avatars");
      expect(teamApi.updateProfile).toHaveBeenCalledWith("company-1", "user-1", { avatarAssetId: "asset-1" });
    });

    vi.mocked(teamApi.updateProfile).mockClear();
    await user.click(within(dialog).getByRole("button", { name: "Remove avatar" }));

    await waitFor(() => {
      expect(teamApi.updateProfile).toHaveBeenCalledWith("company-1", "user-1", { avatarAssetId: null });
    });
  });

  it("keeps profile modal actions visible after adding links", async () => {
    const user = userEvent.setup();
    renderHumanDetail();

    await user.click(await screen.findByRole("button", { name: "Edit profile" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Profile" });

    await user.click(within(dialog).getByRole("button", { name: "Add Social Link" }));
    await user.click(within(dialog).getByRole("button", { name: "Add Social Link" }));

    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Save Profile" })).toBeVisible();
  });
});
