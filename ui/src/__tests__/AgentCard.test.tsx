import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, makeAgent, mockCompanyContext } from "./test-utils";
import { AgentCard } from "../components/AgentCard";
import { getTrustScoreTrend } from "../lib/trust-score";

// --- Mocks ---

const mockNavigate = vi.fn();

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    Link: actual.Link,
    NavLink: actual.NavLink,
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useMutation: () => ({ mutate: vi.fn(), isPending: false }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    agents: {
      detail: (id: string) => ["agents", id],
      list: (id: string) => ["agents", "list", id],
    },
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { pause: vi.fn(), resume: vi.fn() },
}));

vi.mock("../lib/utils", () => ({
  relativeTime: () => "2 minutes ago",
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
  agentUrl: (agent: any) => `/agents/${agent.id}`,
  agentRouteRef: (agent: any) => agent.id,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: ({ icon, className }: any) => <span data-testid="agent-icon" className={className}>{icon ?? "icon"}</span>,
}));

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: any) => <span data-testid="status-badge">{status}</span>,
}));

vi.mock("./agent-config-primitives", () => ({
  adapterLabels: { claude_local: "Claude (local)", codex_local: "Codex (local)" } as Record<string, string>,
  roleLabels: { engineer: "Engineer", designer: "Designer" } as Record<string, string>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children, asChild }: any) => <div>{children}</div>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
  TooltipProvider: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: any) => <div onClick={onClick}>{children}</div>,
  DropdownMenuTrigger: ({ children, asChild }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("../lib/status-colors", () => ({
  agentStatusDot: {
    active: "bg-green-400",
    paused: "bg-yellow-400",
    idle: "bg-yellow-400",
    error: "bg-red-400",
    archived: "bg-neutral-400",
  },
  agentStatusDotDefault: "bg-neutral-400",
  statusBadge: {
    active: "bg-green-100",
    paused: "bg-orange-100",
    idle: "bg-yellow-100",
    error: "bg-red-100",
  },
  statusBadgeDefault: "bg-muted",
}));

// --- Tests ---

describe("AgentCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
  });

  it("renders agent name, role, and status", () => {
    const agent = makeAgent({ name: "Claude Agent", role: "engineer", status: "active" });

    renderWithProviders(<AgentCard agent={agent as any} />);

    expect(screen.getByText("Claude Agent")).toBeInTheDocument();
    expect(screen.getByText(/Engineer/)).toBeInTheDocument();
    // StatusBadge renders the status text directly
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("shows correct status dot color for active agent", () => {
    const agent = makeAgent({ status: "active" });

    const { container } = renderWithProviders(<AgentCard agent={agent as any} />);

    // The status dot should have the green color class
    const dot = container.querySelector(".bg-green-400");
    expect(dot).toBeInTheDocument();
  });

  it("shows correct status dot color for paused agent", () => {
    const agent = makeAgent({ status: "paused" });

    const { container } = renderWithProviders(<AgentCard agent={agent as any} />);

    const dot = container.querySelector(".bg-yellow-400");
    expect(dot).toBeInTheDocument();
  });

  it("shows correct status dot color for error agent", () => {
    const agent = makeAgent({ status: "error" });

    const { container } = renderWithProviders(<AgentCard agent={agent as any} />);

    const dot = container.querySelector(".bg-red-400");
    expect(dot).toBeInTheDocument();
  });

  it("click card calls navigation", async () => {
    const user = userEvent.setup();
    const agent = makeAgent({ id: "agent-1" });

    renderWithProviders(<AgentCard agent={agent as any} />);

    // Click the card container (outermost div)
    await user.click(screen.getByText("Claude Agent"));
    expect(mockNavigate).toHaveBeenCalledWith("/agents/agent-1");
  });

  it("renders a green trust score badge for scores above 80%", () => {
    const agent = makeAgent();

    renderWithProviders(
      <AgentCard
        agent={agent as any}
        trustScore={{
          id: "ts-1",
          companyId: "comp-1",
          agentId: agent.id,
          totalCompleted: 12,
          approvedWithoutChanges: 11,
          recentCompleted: 12,
          recentApproved: 11,
          currentScore: 91,
          createdAt: new Date(),
          updatedAt: new Date(),
        }}
      />,
    );

    const badge = screen.getByTestId("trust-score-badge");
    expect(badge).toHaveTextContent("91%");
    expect(badge).toHaveAttribute("data-tone", "high");
  });

  it("renders a yellow trust score badge for scores between 50% and 80%", () => {
    const agent = makeAgent();

    renderWithProviders(
      <AgentCard
        agent={agent as any}
        trustScore={{
          id: "ts-1",
          companyId: "comp-1",
          agentId: agent.id,
          totalCompleted: 10,
          approvedWithoutChanges: 7,
          recentCompleted: 10,
          recentApproved: 7,
          currentScore: 70,
          createdAt: new Date(),
          updatedAt: new Date(),
        }}
      />,
    );

    expect(screen.getByTestId("trust-score-badge")).toHaveAttribute("data-tone", "moderate");
  });

  it("renders a red trust score badge for scores below 50%", () => {
    const agent = makeAgent();

    renderWithProviders(
      <AgentCard
        agent={agent as any}
        trustScore={{
          id: "ts-1",
          companyId: "comp-1",
          agentId: agent.id,
          totalCompleted: 10,
          approvedWithoutChanges: 4,
          recentCompleted: 10,
          recentApproved: 4,
          currentScore: 40,
          createdAt: new Date(),
          updatedAt: new Date(),
        }}
      />,
    );

    expect(screen.getByTestId("trust-score-badge")).toHaveAttribute("data-tone", "low");
  });

  it("shows the trust score tooltip breakdown", () => {
    const agent = makeAgent();

    renderWithProviders(
      <AgentCard
        agent={agent as any}
        trustScore={{
          id: "ts-1",
          companyId: "comp-1",
          agentId: agent.id,
          totalCompleted: 8,
          approvedWithoutChanges: 6,
          recentCompleted: 8,
          recentApproved: 6,
          currentScore: 75,
          createdAt: new Date(),
          updatedAt: new Date(),
        }}
      />,
    );

    expect(screen.getByText("Trust Score: 75% — based on 8 tasks (6 approved without changes)")).toBeInTheDocument();
  });

  it("does not render a trust score badge for agents with null score", () => {
    const agent = makeAgent();

    renderWithProviders(<AgentCard agent={agent as any} trustScore={null} />);

    expect(screen.queryByTestId("trust-score-badge")).not.toBeInTheDocument();
  });

  it("marks trend as up when recent performance exceeds the overall score", () => {
    expect(
      getTrustScoreTrend({
        currentScore: 65,
        recentCompleted: 20,
        recentApproved: 16,
      }),
    ).toBe("up");
  });
});
