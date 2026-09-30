import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, makeAgent, mockCompanyContext } from "./test-utils";
import { CommanderTeamTab } from "../components/team/CommanderTeamTab";
import { agentsApi } from "../api/agents";

// --- Sub-component stubs (test shell wiring, not sub-component rendering) ---

vi.mock("../components/team/CommanderRosterTab", () => ({
  CommanderRosterTab: ({ agents, isFounder, onNewAgent }: any) => (
    <div data-testid="roster-content">
      {agents.map((a: any) => (
        <div key={a.id} data-testid={`commander-agent-card-${a.id}`}>
          {a.name}
          {a.runtimeConfig?.aoa?.role === "lead" && <span>Lead</span>}
        </div>
      ))}
      {isFounder && <button onClick={onNewAgent}>New AoA Agent</button>}
    </div>
  ),
}));

vi.mock("../components/team/CommanderKanbanTab", () => ({
  CommanderKanbanTab: () => <div data-testid="kanban-content">kanban view</div>,
}));

vi.mock("../components/team/CommanderGovernanceTab", () => ({
  CommanderGovernanceTab: () => <div data-testid="governance-content">governance view</div>,
}));

// --- Other mocks ---

const mockNavigate = vi.fn();

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("@/lib/router")>("@/lib/router");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../api/agents", () => ({
  agentsApi: {
    listAoa: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
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

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <div>{children}</div>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
  TooltipProvider: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: any) => <span {...props}>{children}</span>,
}));

vi.mock("@/components/ui/empty-state", () => ({
  EmptyState: ({ title, description, action }: any) => (
    <div>
      <p>{title}</p>
      {description && <p>{description}</p>}
      {action}
    </div>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: any) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  DialogDescription: ({ children }: any) => <p>{children}</p>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ onValueChange, defaultValue, children }: any) => (
    <select defaultValue={defaultValue} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: any) => <>{children}</>,
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, children }: any) => <option value={value}>{children}</option>,
}));

const mockInvalidateQueries = vi.fn();
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mockInvalidateQueries }),
    useMutation: (opts: any) => ({
      mutate: (data: any) => {
        const result = opts.mutationFn(data);
        if (result && typeof result.then === "function") {
          result.then((res: any) => opts.onSuccess?.(res)).catch((err: any) => opts.onError?.(err));
        }
      },
      isPending: false,
    }),
  };
});

// --- Tests ---

describe("CommanderTeamTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
  });

  const defaultPermissions = { isFounder: true };

  function makeAoaAgents() {
    return [
      makeAgent({
        id: "a1",
        name: "Commander",
        kind: "aoa",
        runtimeConfig: { aoa: { role: "lead" } },
        status: "idle",
        adapterType: "process",
      }),
      makeAgent({
        id: "a2",
        name: "Discussion Extraction",
        kind: "aoa",
        runtimeConfig: { aoa: { role: "member" } },
        status: "idle",
        adapterType: "process",
      }),
    ];
  }

  // ── Roster (default sub-tab) ──────────────────────────────────────────────

  it("renders both agent names in Roster tab (default)", () => {
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab agents={agents as any} trustScores={[]} liveRuns={[]} permissions={defaultPermissions} />,
    );
    expect(screen.getByText("Commander")).toBeInTheDocument();
    expect(screen.getByText("Discussion Extraction")).toBeInTheDocument();
  });

  it("shows Lead badge for commander agent with lead role", () => {
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab agents={agents as any} trustScores={[]} liveRuns={[]} permissions={defaultPermissions} />,
    );
    expect(screen.getByText("Lead")).toBeInTheDocument();
  });

  it("does not show Lead badge for member agent", () => {
    const agents = [
      makeAgent({
        id: "a2",
        name: "Discussion Extraction",
        kind: "aoa",
        runtimeConfig: { aoa: { role: "member" } },
        status: "idle",
        adapterType: "process",
      }),
    ];
    renderWithProviders(
      <CommanderTeamTab agents={agents as any} trustScores={[]} liveRuns={[]} permissions={defaultPermissions} />,
    );
    expect(screen.queryByText("Lead")).not.toBeInTheDocument();
  });

  it("shows empty state when no agents", () => {
    renderWithProviders(
      <CommanderTeamTab agents={[]} trustScores={[]} liveRuns={[]} permissions={defaultPermissions} />,
    );
    expect(screen.getByText("No AoA agents yet")).toBeInTheDocument();
  });

  it("shows New AoA agent button for founder", () => {
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab agents={agents as any} trustScores={[]} liveRuns={[]} permissions={defaultPermissions} />,
    );
    expect(screen.getByText("New AoA Agent")).toBeInTheDocument();
  });

  it("hides New AoA agent button for non-founders", () => {
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab agents={agents as any} trustScores={[]} liveRuns={[]} permissions={{ isFounder: false }} />,
    );
    expect(screen.queryByText("New AoA Agent")).not.toBeInTheDocument();
  });

  it("New AoA Agent button opens dialog and submits kind=aoa", async () => {
    const user = userEvent.setup();
    const fakeAgent = makeAgent({ id: "new-aoa-1", name: "Test Agent", kind: "aoa" });
    vi.mocked(agentsApi.create).mockResolvedValue(fakeAgent as any);

    renderWithProviders(
      <CommanderTeamTab agents={[]} trustScores={[]} liveRuns={[]} permissions={{ isFounder: true }} />,
    );

    // Click "New AoA Agent" button in empty state
    const button = screen.getByText("New AoA Agent");
    await user.click(button);

    // Dialog should appear
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Fill name input
    const nameInput = screen.getByPlaceholderText("Agent name");
    await user.clear(nameInput);
    await user.type(nameInput, "Test Agent");

    // Submit form
    const createBtn = screen.getByRole("button", { name: /create/i });
    await user.click(createBtn);

    // Verify agentsApi.create was called with kind=aoa and runtimeConfig.aoa.role=member
    await waitFor(() => {
      expect(agentsApi.create).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({
          kind: "aoa",
          runtimeConfig: expect.objectContaining({
            aoa: expect.objectContaining({ role: "member" }),
          }),
        }),
      );
    });
  });

  // ── Sub-tab navigation ────────────────────────────────────────────────────

  it("defaults to Roster sub-tab (roster-content visible)", () => {
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab agents={agents as any} trustScores={[]} liveRuns={[]} permissions={defaultPermissions} />,
    );
    expect(screen.getByTestId("roster-content")).toBeInTheDocument();
    expect(screen.queryByTestId("kanban-content")).toBeNull();
    expect(screen.queryByTestId("governance-content")).toBeNull();
  });

  it("switching to Kanban tab shows kanban-content and hides others", async () => {
    const user = userEvent.setup();
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab agents={agents as any} trustScores={[]} liveRuns={[]} permissions={defaultPermissions} />,
    );
    await user.click(screen.getByTestId("commander-subtab-kanban"));
    expect(screen.getByTestId("kanban-content")).toBeInTheDocument();
    expect(screen.queryByTestId("roster-content")).toBeNull();
    expect(screen.queryByTestId("governance-content")).toBeNull();
  });

  it("switching to Tasks tab shows task content and hides roster/kanban/governance", async () => {
    const user = userEvent.setup();
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab
        agents={agents as any}
        trustScores={[]}
        liveRuns={[]}
        permissions={defaultPermissions}
        tasksContent={<div data-testid="aoa-tasks-content">tasks</div>}
      />,
    );

    await user.click(screen.getByTestId("commander-subtab-tasks"));

    expect(screen.getByTestId("aoa-tasks-content")).toBeInTheDocument();
    expect(screen.queryByTestId("roster-content")).toBeNull();
    expect(screen.queryByTestId("kanban-content")).toBeNull();
    expect(screen.queryByTestId("governance-content")).toBeNull();
  });

  it("can be opened directly on the Tasks subtab", () => {
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab
        agents={agents as any}
        trustScores={[]}
        liveRuns={[]}
        permissions={defaultPermissions}
        activeSubTab="tasks"
        onSubTabChange={vi.fn()}
        tasksContent={<div data-testid="aoa-tasks-content">tasks</div>}
      />,
    );

    expect(screen.getByTestId("aoa-tasks-content")).toBeInTheDocument();
    expect(screen.getByTestId("commander-subtab-tasks")).toHaveAttribute("data-active", "true");
  });

  it("can hide its internal subtab bar when the page owns header subtabs", () => {
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab
        agents={agents as any}
        trustScores={[]}
        liveRuns={[]}
        permissions={defaultPermissions}
        activeSubTab="tasks"
        onSubTabChange={vi.fn()}
        showSubTabs={false}
        tasksContent={<div data-testid="aoa-tasks-content">tasks</div>}
      />,
    );

    expect(screen.getByTestId("aoa-tasks-content")).toBeInTheDocument();
    expect(screen.queryByTestId("commander-subtab-tasks")).not.toBeInTheDocument();
  });

  it("switching to Governance tab shows governance-content and hides others", async () => {
    const user = userEvent.setup();
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab agents={agents as any} trustScores={[]} liveRuns={[]} permissions={defaultPermissions} />,
    );
    await user.click(screen.getByTestId("commander-subtab-governance"));
    expect(screen.getByTestId("governance-content")).toBeInTheDocument();
    expect(screen.queryByTestId("roster-content")).toBeNull();
    expect(screen.queryByTestId("kanban-content")).toBeNull();
  });

  it("switching back to Roster tab from Governance restores roster-content", async () => {
    const user = userEvent.setup();
    const agents = makeAoaAgents();
    renderWithProviders(
      <CommanderTeamTab agents={agents as any} trustScores={[]} liveRuns={[]} permissions={defaultPermissions} />,
    );
    await user.click(screen.getByTestId("commander-subtab-governance"));
    expect(screen.getByTestId("governance-content")).toBeInTheDocument();

    await user.click(screen.getByTestId("commander-subtab-roster"));
    expect(screen.getByTestId("roster-content")).toBeInTheDocument();
    expect(screen.queryByTestId("governance-content")).toBeNull();
  });
});
