import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext, mockBreadcrumbContext } from "./test-utils";
import { TeamPage } from "../pages/TeamPage";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setCollapsed: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewAgent: vi.fn() }),
}));

vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({
    summary: null,
    permissions: {
      canAssignTasks: false,
      canInviteUsers: false,
      canManageRoles: false,
      canEditIdentityMemory: false,
    },
    role: "founder",
    isLoading: false,
  }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([]),
    listAoa: vi.fn().mockResolvedValue([]),
    org: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/trust-scores", () => ({
  trustScoresApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    liveRunsForCompany: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/team", () => ({
  teamApi: {
    get: vi.fn().mockResolvedValue({ members: [], pendingInvites: [] }),
    updateRole: vi.fn().mockResolvedValue({}),
  },
}));

describe("TeamPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
  });

  it("renders the team sidebar sections", () => {
    renderWithProviders(<TeamPage />);

    expect(screen.getByRole("button", { name: /organization/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^agents/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /humans/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^teams/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /aoa team/i })).toBeInTheDocument();
  });

  it("defaults to Organization in the sidebar", () => {
    renderWithProviders(<TeamPage />);

    expect(screen.getByRole("button", { name: /organization/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("switches sidebar sections when clicking", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TeamPage />);

    await user.click(screen.getByRole("button", { name: /^agents/i }));

    expect(screen.getByRole("button", { name: /^agents/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("collapses the Team sidebar to icon-only section buttons", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TeamPage />);

    const sidebar = screen.getByTestId("team-section-sidebar");
    expect(sidebar).toHaveClass("w-[220px]");

    await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));

    expect(sidebar).toHaveClass("w-[48px]");
    expect(within(sidebar).queryByText("Team")).not.toBeInTheDocument();
    expect(within(sidebar).queryByText("Agents")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^agents/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand sidebar/i })).toBeInTheDocument();
  });

  it("wraps the Team panes in the same muted padded page band as other pane pages", () => {
    renderWithProviders(<TeamPage />);

    const sidebar = screen.getByTestId("team-section-sidebar");
    const wrapper = sidebar.parentElement;

    expect(wrapper).toHaveClass("bg-muted/30");
    expect(wrapper).toHaveClass("p-2");
  });

  it("renders AoA Team subtabs in the right pane header", () => {
    renderWithProviders(<TeamPage />, {
      initialEntries: ["/team?tab=aoa&aoaTab=tasks"],
    });

    const headerTabs = screen.getByTestId("aoa-team-header-tabs");
    expect(within(headerTabs).getByRole("button", { name: /roster/i })).toBeInTheDocument();
    expect(within(headerTabs).getByRole("button", { name: /tasks/i })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(within(headerTabs).getByRole("button", { name: /kanban/i })).toBeInTheDocument();
    expect(within(headerTabs).getByRole("button", { name: /governance/i })).toBeInTheDocument();
  });

  it("switches AoA Team header subtabs and keeps AoA Team active", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TeamPage />, {
      initialEntries: ["/team?tab=aoa&aoaTab=tasks"],
    });

    await user.click(screen.getByTestId("aoa-header-subtab-kanban"));

    expect(screen.getByRole("button", { name: /aoa team/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByTestId("aoa-header-subtab-kanban")).toHaveAttribute("data-active", "true");
  });

  it("opens correct sidebar section from direct URL", () => {
    renderWithProviders(<TeamPage />, {
      initialEntries: ["/team?tab=humans"],
    });

    expect(screen.getByRole("button", { name: /humans/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("opens AoA Team roster from the legacy commander tab URL", async () => {
    renderWithProviders(<TeamPage />, {
      initialEntries: ["/team?tab=commander"],
    });

    expect(screen.getByRole("button", { name: /aoa team/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByTestId("aoa-header-subtab-roster")).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("opens AoA Team tasks from the legacy tasks tab URL", () => {
    renderWithProviders(<TeamPage />, {
      initialEntries: ["/team?tab=tasks"],
    });

    expect(screen.getByRole("button", { name: /aoa team/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByTestId("aoa-header-subtab-tasks")).toHaveAttribute("data-active", "true");
  });

  it("falls back to Organization for invalid tab param", () => {
    renderWithProviders(<TeamPage />, {
      initialEntries: ["/team?tab=invalid"],
    });

    expect(screen.getByRole("button", { name: /organization/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("sets breadcrumbs to Team", () => {
    renderWithProviders(<TeamPage />);

    expect(mockBreadcrumbContext.setBreadcrumbs).toHaveBeenCalledWith([
      { label: "Team" },
    ]);
  });

  it("shows empty state when no company selected", () => {
    mockCompanyContext.selectedCompanyId = null;
    renderWithProviders(<TeamPage />);

    expect(
      screen.getByText("Select a company to view team."),
    ).toBeInTheDocument();
  });
});
