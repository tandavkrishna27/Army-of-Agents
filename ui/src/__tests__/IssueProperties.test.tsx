import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, mockCompanyContext } from "./test-utils";
import { IssueProperties } from "../components/IssueProperties";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const issue = {
  id: "issue-1",
  companyId: "comp-1",
  title: "Task",
  workMode: "standard",
  status: "todo",
  priority: "medium",
  assigneeAgentId: null,
  assigneeUserId: null,
  responsibleUserId: null,
  projectId: null,
  parentId: null,
  ancestors: [],
  labels: [],
  labelIds: [],
  requestDepth: 0,
  createdByUserId: "user-1",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as any;

let canAssignTasks = false;
let agents: Array<{ id: string; name: string; status: string; icon?: string | null }> = [];
let members: Array<{
  userId: string;
  displayName: string | null;
  email: string | null;
  title: string | null;
  role: string;
}> = [];

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: () => ({ orderedProjects: [] }),
}));

vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({
    summary: { members },
    permissions: {
      canAssignTasks,
      canInviteUsers: false,
      canManageRoles: false,
      canEditIdentityMemory: false,
    },
  }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey[0] : queryKey;
      if (key === "auth") {
        return { data: { user: { id: "user-1" }, session: { userId: "user-1" } }, isLoading: false };
      }
      if (key === "agents") {
        return { data: agents, isLoading: false };
      }
      return { data: [], isLoading: false };
    }),
    useMutation: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  };
});

vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/auth", () => ({ authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "user-1" } }) } }));
vi.mock("../api/issues", () => ({
  issuesApi: {
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn(),
    deleteLabel: vi.fn(),
  },
}));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    auth: { session: ["auth"] },
    agents: { list: () => ["agents"] },
    projects: { list: () => ["projects"] },
    issues: { labels: () => ["labels"] },
  },
}));

describe("IssueProperties permissions", () => {
  beforeEach(() => {
    canAssignTasks = false;
    agents = [];
    members = [];
  });

  it("hides assignment controls for team members without task assignment permission", () => {
    canAssignTasks = false;
    renderWithProviders(<IssueProperties issue={issue} onUpdate={vi.fn()} />);

    expect(screen.getByText("Unassigned")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search assignees...")).not.toBeInTheDocument();
  });

  it("keeps assignment controls available when the user can assign tasks", () => {
    canAssignTasks = true;
    renderWithProviders(<IssueProperties issue={issue} onUpdate={vi.fn()} />);

    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("displays Assignee as agent and Responsible as human manager separately", () => {
    canAssignTasks = true;
    agents = [{ id: "agent-1", name: "Research Agent", status: "idle" }];
    members = [
      {
        userId: "manager-1",
        displayName: "Avery Manager",
        email: "avery@example.com",
        title: "Growth Lead",
        role: "team_lead",
      },
    ];

    renderWithProviders(
      <IssueProperties
        issue={{ ...issue, assigneeAgentId: "agent-1", responsibleUserId: "manager-1" }}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText("Assignee")).toBeInTheDocument();
    expect(screen.getByText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText("Responsible")).toBeInTheDocument();
    expect(screen.getByText("Avery Manager")).toBeInTheDocument();
  });

  it("displays a human assignee and the same human as Responsible in a separate row", () => {
    canAssignTasks = true;
    members = [
      {
        userId: "user-1",
        displayName: "Mina Founder",
        email: "mina@example.com",
        title: "Founder",
        role: "founder",
      },
    ];

    renderWithProviders(
      <IssueProperties
        issue={{ ...issue, assigneeUserId: "user-1", responsibleUserId: "user-1" }}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText("Assignee")).toBeInTheDocument();
    expect(screen.getByText("Responsible")).toBeInTheDocument();
    expect(screen.getAllByText("Mina Founder")).toHaveLength(2);
  });

  it("selecting a human assignee clears agent assignee and does not change responsible human", async () => {
    canAssignTasks = true;
    agents = [{ id: "agent-1", name: "Agent One", status: "idle" }];
    members = [
      {
        userId: "user-1",
        displayName: "Priya Owner",
        email: "priya@example.com",
        title: "Ops",
        role: "team_member",
      },
      {
        userId: "user-2",
        displayName: "Jordan Member",
        email: "jordan@example.com",
        title: "Engineering",
        role: "team_member",
      },
    ];
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IssueProperties
        issue={{ ...issue, assigneeAgentId: "agent-1", responsibleUserId: "manager-1" }}
        onUpdate={onUpdate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Agent One/ }));
    await user.click(screen.getByRole("button", { name: /Jordan Member/ }));

    expect(onUpdate).toHaveBeenCalledWith({
      assigneeAgentId: null,
      assigneeUserId: "user-2",
    });
    expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ responsibleUserId: expect.anything() }));
  });

  it("selecting a Responsible human calls onUpdate with responsibleUserId only", async () => {
    canAssignTasks = true;
    members = [
      {
        userId: "manager-1",
        displayName: "Avery Manager",
        email: "avery@example.com",
        title: "Growth Lead",
        role: "team_lead",
      },
      {
        userId: "member-2",
        displayName: "Jordan Member",
        email: "jordan@example.com",
        title: "Ops",
        role: "team_member",
      },
    ];
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IssueProperties
        issue={{ ...issue, responsibleUserId: "manager-1" }}
        onUpdate={onUpdate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Avery Manager/i }));
    await user.click(screen.getByRole("button", { name: /Jordan Member/i }));

    expect(onUpdate).toHaveBeenCalledWith({ responsibleUserId: "member-2" });
  });

  it("clearing Responsible calls onUpdate with responsibleUserId null", async () => {
    canAssignTasks = true;
    members = [
      {
        userId: "manager-1",
        displayName: "Avery Manager",
        email: "avery@example.com",
        title: "Growth Lead",
        role: "team_lead",
      },
    ];
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IssueProperties
        issue={{ ...issue, responsibleUserId: "manager-1" }}
        onUpdate={onUpdate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Avery Manager/i }));
    await user.click(screen.getByRole("button", { name: /No responsible human/i }));

    expect(onUpdate).toHaveBeenCalledWith({ responsibleUserId: null });
  });

  it("read-only users see Responsible but cannot open or change it", async () => {
    canAssignTasks = false;
    members = [
      {
        userId: "manager-1",
        displayName: "Avery Manager",
        email: "avery@example.com",
        title: "Growth Lead",
        role: "team_lead",
      },
    ];
    const onUpdate = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <IssueProperties
        issue={{ ...issue, responsibleUserId: "manager-1" }}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByText("Responsible")).toBeInTheDocument();
    expect(screen.getByText("Avery Manager")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search responsible humans...")).not.toBeInTheDocument();

    await user.click(screen.getByText("Avery Manager"));

    expect(screen.queryByPlaceholderText("Search responsible humans...")).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("does not display Responsible: Board for local-board when a member label or stable fallback is available", () => {
    canAssignTasks = true;
    members = [
      {
        userId: "local-board",
        displayName: "Taylor Founder",
        email: "taylor@example.com",
        title: "Founder",
        role: "founder",
      },
    ];

    renderWithProviders(
      <IssueProperties
        issue={{ ...issue, assigneeUserId: "local-board", responsibleUserId: "local-board" }}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Taylor Founder")).toHaveLength(2);
    expect(screen.queryByText("Board")).not.toBeInTheDocument();
  });
});

describe("IssueProperties compact layout", () => {
  it("renders approved single-row cards for mode, primary controls, and task context", () => {
    canAssignTasks = true;
    renderWithProviders(
      <IssueProperties
        issue={{
          ...issue,
          workMode: "planning",
          labels: [{ id: "label-1", name: "smoke", color: "#22c55e" }],
          labelIds: ["label-1"],
          startedAt: "2026-07-07T09:30:00.000Z",
        }}
        onUpdate={vi.fn()}
        layout="compact"
      />,
    );

    const grid = screen.getByTestId("task-compact-properties-grid");
    const cards = within(grid).getAllByTestId("task-compact-property-card");

    expect(cards).toHaveLength(9);
    expect(grid).toHaveTextContent("Mode");
    expect(grid).toHaveTextContent("Planning");
    expect(grid).toHaveTextContent("Status");
    expect(grid).toHaveTextContent("Todo");
    expect(grid).toHaveTextContent("Priority");
    expect(grid).toHaveTextContent("Medium");
    expect(grid).toHaveTextContent("Assignee");
    expect(grid).toHaveTextContent("Responsible");
    expect(grid).toHaveTextContent("No responsible human");
    expect(grid).toHaveTextContent("Project");
    expect(grid).toHaveTextContent("Labels");
    expect(grid).toHaveTextContent("smoke");
    expect(grid).toHaveTextContent("Started");
    expect(grid).toHaveTextContent("Created");
    expect(grid).not.toHaveTextContent("Updated");

    cards.forEach((card) => {
      expect(card.className).toContain("h-10");
      expect(card.className).toContain("rounded-lg");
    });
  });

  it("updates work mode from the compact Mode card", async () => {
    canAssignTasks = true;
    const user = userEvent.setup();
    const onUpdate = vi.fn();

    renderWithProviders(<IssueProperties issue={issue} onUpdate={onUpdate} layout="compact" />);

    await user.click(screen.getByRole("button", { name: /Mode Standard/i }));
    await user.click(screen.getByRole("button", { name: /Planning/i }));

    expect(onUpdate).toHaveBeenCalledWith({ workMode: "planning" });
  });

  it("uses a floating picker for compact assignee edits instead of inline expansion", async () => {
    canAssignTasks = true;
    const user = userEvent.setup();
    renderWithProviders(<IssueProperties issue={issue} onUpdate={vi.fn()} layout="compact" />);

    await user.click(screen.getByText("Unassigned"));

    expect(screen.getByTestId("task-property-picker-assignee")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search assignees...")).toBeInTheDocument();
  });

  it("keeps compact card values right-aligned and makes editable cards feel clickable", () => {
    canAssignTasks = true;
    renderWithProviders(<IssueProperties issue={issue} onUpdate={vi.fn()} layout="compact" />);

    const cards = screen.getAllByTestId("task-compact-property-card");
    cards.forEach((card) => {
      const value = within(card).getByTestId("task-compact-property-value");
      expect(value.className).toContain("justify-end");
      expect(value.className).toContain("text-right");
      expect(value.className).not.toContain("justify-start");
    });

    const editableLabels = ["Mode", "Status", "Priority", "Assignee", "Responsible", "Project", "Labels"];
    editableLabels.forEach((label) => {
      const card = screen.getByText(label).closest('[data-testid="task-compact-property-card"]');
      expect(card).not.toBeNull();
      expect(card.className).toContain("cursor-pointer");
      expect(card.className).toContain("hover:bg-accent/30");
      expect(card.className).toContain("[&_*]:cursor-pointer");
    });

    const modeButton = screen.getByRole("button", { name: /Mode Standard/i });
    expect(modeButton.className).toContain("cursor-pointer");
  });

  it("does not show compact external open actions for project or assignee", () => {
    canAssignTasks = true;
    renderWithProviders(
      <IssueProperties
        issue={{
          ...issue,
          assigneeAgentId: "agent-1",
          projectId: "project-1",
        }}
        onUpdate={vi.fn()}
        layout="compact"
      />,
    );

    expect(screen.queryByLabelText("Open assignee")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Open project")).not.toBeInTheDocument();
  });

  it("opens compact editors when clicking the card label area", async () => {
    canAssignTasks = true;
    const user = userEvent.setup();
    renderWithProviders(<IssueProperties issue={issue} onUpdate={vi.fn()} layout="compact" />);

    await user.click(screen.getByText("Mode"));

    expect(screen.getByTestId("task-property-picker-work-mode")).toBeInTheDocument();
  });

  it("applies a visible active state to editable compact cards on mouse hover", () => {
    canAssignTasks = true;
    renderWithProviders(<IssueProperties issue={issue} onUpdate={vi.fn()} layout="compact" />);

    const modeCard = screen.getByText("Mode").closest('[data-testid="task-compact-property-card"]');
    const responsibleCard = screen.getByText("Responsible").closest('[data-testid="task-compact-property-card"]');

    expect(modeCard).not.toBeNull();
    expect(responsibleCard).not.toBeNull();

    fireEvent.mouseMove(modeCard!);

    expect(modeCard!.className).toContain("bg-accent/50");
    expect(modeCard!.className).toContain("ring-1");
    expect(modeCard!.className).toContain("shadow-sm");

    fireEvent.mouseMove(responsibleCard!);

    expect(responsibleCard!.className).toContain("bg-accent/50");
    expect(responsibleCard!.className).toContain("ring-1");
    expect(responsibleCard!.className).toContain("shadow-sm");
  });
});
