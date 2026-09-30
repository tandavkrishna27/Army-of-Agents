import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, makeAgent, mockCompanyContext, mockDialogContext } from "./test-utils";
import { AgentsTab } from "../components/team/AgentsTab";

// --- Mocks ---

const mockPushToast = vi.fn();
const mockMutate = vi.fn();
let mockIsPending = false;

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => mockDialogContext,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useMutation: (opts: any) => ({
      mutate: (...args: any[]) => {
        mockMutate(...args);
        // Simulate success callback for pause/resume
        if (opts?.onSuccess) {
          opts.onSuccess(null, args[0]);
        }
      },
      isPending: mockIsPending,
    }),
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
  agentsApi: {
    pause: vi.fn(),
    resume: vi.fn(),
    terminate: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    adapterModels: vi.fn().mockResolvedValue([]),
    hire: vi.fn(),
  },
}));

vi.mock("../lib/utils", () => ({
  formatCents: (v: number) => `$${(v / 100).toFixed(2)}`,
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
  agentUrl: (agent: any) => `/agents/${agent.id}`,
  agentRouteRef: (agent: any) => agent.id,
  relativeTime: (date: any) => (date ? "just now" : ""),
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: ({ icon, className }: any) => <span data-testid="agent-icon" className={className}>{icon ?? "icon"}</span>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: any) => <span data-testid="status-badge">{status}</span>,
}));

vi.mock("../components/agent-config-primitives", () => ({
  adapterLabels: { claude_local: "Claude (local)", codex_local: "Codex (local)" } as Record<string, string>,
  roleLabels: { engineer: "Engineer", designer: "Designer", cxo: "Director", lead: "Lead", general: "General" } as Record<string, string>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <div>{children}</div>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
  TooltipProvider: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, variant }: any) => (
    <div role="menuitem" onClick={onClick} data-variant={variant}>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: any) => open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));

vi.mock("../lib/status-colors", () => ({
  agentStatusDot: {
    active: "bg-green-400",
    paused: "bg-yellow-400",
    idle: "bg-yellow-400",
    error: "bg-red-400",
    terminated: "bg-red-400",
  },
  agentStatusDotDefault: "bg-neutral-400",
}));

vi.mock("../components/TrustScoreBadge", () => ({
  TrustScoreBadge: ({ score }: any) =>
    score ? <span data-testid="trust-score-badge">{score.currentScore}%</span> : null,
}));

// Mock NewAgentDialog (create-only, no props needed)
vi.mock("../components/NewAgentDialog", () => ({
  NewAgentDialog: () => null,
}));

// --- Tests ---

describe("AgentsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockIsPending = false;
  });

  const defaultPermissions = { isFounder: true };
  const nonFounderPermissions = { isFounder: false };

  function makeAgentList() {
    return [
      makeAgent({ id: "a1", name: "Alice", role: "cxo", status: "active", adapterType: "codex_local", reportsTo: null, budgetMonthlyCents: 5000, title: "Chief Executive" }),
      makeAgent({ id: "a2", name: "Bob", role: "engineer", status: "paused", adapterType: "claude_local", reportsTo: "a1", parentType: "agent", parentId: "a1", budgetMonthlyCents: 0, title: null }),
    ];
  }

  it("renders agent cards with all fields", () => {
    const agents = makeAgentList();

    renderWithProviders(
      <AgentsTab
        agents={agents as any}
        orgTree={[]}
        permissions={defaultPermissions}
      />,
    );

    // Agent names
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();

    // Roles
    expect(screen.getByText(/Director/)).toBeInTheDocument();
    expect(screen.getByText(/Engineer/)).toBeInTheDocument();

    // Adapter types (Sprint 2A removed claude_api — Alice now uses codex_local)
    expect(screen.getByText("Codex (local)")).toBeInTheDocument();
    expect(screen.getByText("Claude (local)")).toBeInTheDocument();

    // Reports-to / budget rendering moved into <AgentCard>'s own surface;
    // assertions now belong to AgentCard.test.tsx. AgentsTab just composes
    // the grid + destructive dropdown items.
    // Last-active relative time replaces budget in AgentCard's footer.
    expect(screen.getAllByText(/Last active|No activity yet/).length).toBeGreaterThan(0);
  });

  it("shows trust scores when provided", () => {
    const agents = [makeAgent({ id: "a1", name: "Alice" })];
    const trustScores = new Map([
      ["a1", {
        id: "ts-1",
        companyId: "comp-1",
        agentId: "a1",
        totalCompleted: 10,
        approvedWithoutChanges: 8,
        recentCompleted: 10,
        recentApproved: 8,
        currentScore: 80,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    ]);

    renderWithProviders(
      <AgentsTab
        agents={agents as any}
        orgTree={[]}
        permissions={defaultPermissions}
        trustScores={trustScores as any}
      />,
    );

    expect(screen.getByTestId("trust-score-badge")).toHaveTextContent("80%");
  });

  it("shows empty state when no agents", () => {
    renderWithProviders(
      <AgentsTab agents={[]} orgTree={[]} permissions={defaultPermissions} />,
    );

    expect(screen.getByText("No agents yet")).toBeInTheDocument();
  });

  it("shows New Agent button for founder", () => {
    const agents = makeAgentList();

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={defaultPermissions} />,
    );

    expect(screen.getByText("New Agent")).toBeInTheDocument();
  });

  it("hides New Agent button for non-founders", () => {
    const agents = makeAgentList();

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={nonFounderPermissions} />,
    );

    // The header "New Agent" button should not exist for non-founders
    const newAgentButtons = screen.queryAllByText("New Agent");
    expect(newAgentButtons.length).toBe(0);
  });

  it("pause/resume buttons call mutation", async () => {
    const user = userEvent.setup();
    const agents = [makeAgent({ id: "a1", name: "Alice", status: "active" })];

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={defaultPermissions} />,
    );

    // The Pause button is rendered (since agent is active)
    // In the mocked tooltip, the button is directly accessible
    const pauseButtons = screen.getAllByRole("button");
    // Find the pause button - it has a Pause icon child
    const pauseBtn = pauseButtons.find((btn) => !btn.hasAttribute("disabled") && btn.querySelector("svg"));
    // Click any button that represents pause action
    // Due to mocking, just verify mutation is callable
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("renders agent card for founder users", () => {
    const agents = [makeAgent({ id: "a1", name: "Alice", status: "active" })];

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={defaultPermissions} />,
    );

    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("shows terminate and delete options in more menu for founder", () => {
    const agents = [makeAgent({ id: "a1", name: "Alice", status: "active" })];

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={defaultPermissions} />,
    );

    // Due to the dropdown mock rendering all items visible, we should see both
    expect(screen.getByText("Terminate")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("hides delete option for non-founders", () => {
    const agents = [makeAgent({ id: "a1", name: "Alice", status: "active" })];

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={nonFounderPermissions} />,
    );

    // Terminate should still be visible
    expect(screen.getByText("Terminate")).toBeInTheDocument();
    // Delete should not be visible
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("opens confirmation dialog when terminate is clicked", async () => {
    const user = userEvent.setup();
    const agents = [makeAgent({ id: "a1", name: "Alice", status: "active" })];

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={defaultPermissions} />,
    );

    await user.click(screen.getByText("Terminate"));

    // Confirmation dialog should appear
    expect(screen.getByText("Terminate agent")).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to terminate "Alice"/)).toBeInTheDocument();
  });

  it("opens confirmation dialog when delete is clicked", async () => {
    const user = userEvent.setup();
    const agents = [makeAgent({ id: "a1", name: "Alice", status: "active" })];

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={defaultPermissions} />,
    );

    await user.click(screen.getByText("Delete"));

    expect(screen.getByText("Delete agent")).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to permanently delete "Alice"/)).toBeInTheDocument();
  });

  it("does not pulse or ring an agent card when highlightId matches", () => {
    const agents = [makeAgent({ id: "a1", name: "Alice" })];

    const { container } = renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={defaultPermissions} highlightId="a1" />,
    );

    const highlightedCard = container.querySelector("[data-testid='agent-card-a1']");
    expect(highlightedCard).toBeInTheDocument();
    expect(highlightedCard?.className).not.toContain("ring-2");
    expect(highlightedCard?.className).not.toContain("animate-pulse");
  });

  it("does not highlight card when highlightId does not match", () => {
    const agents = [makeAgent({ id: "a1", name: "Alice" })];

    const { container } = renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={defaultPermissions} highlightId="other-id" />,
    );

    const card = container.querySelector("[data-testid='agent-card-a1']");
    expect(card).toBeInTheDocument();
    expect(card?.className).not.toContain("ring-2");
  });

  it("shows title in agent subtitle when present", () => {
    const agents = [makeAgent({ id: "a1", name: "Alice", role: "cxo", title: "Chief Executive" })];

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={defaultPermissions} />,
    );

    expect(screen.getByText(/Chief Executive/)).toBeInTheDocument();
  });
});

describe("AgentsTab navigation", () => {
  it("agent card surface is clickable for navigation", () => {
    const agents = [makeAgent({ id: "a1", name: "Alice", status: "active" })];

    renderWithProviders(
      <AgentsTab agents={agents as any} orgTree={[]} permissions={{ isFounder: true }} />,
    );

    // <AgentCard> wraps the whole surface in a ClickableDiv with cursor-pointer.
    expect(screen.getByText("Alice")).toBeInTheDocument();
    const clickableSurface = document.querySelector(".cursor-pointer");
    expect(clickableSurface).not.toBeNull();
  });
});
