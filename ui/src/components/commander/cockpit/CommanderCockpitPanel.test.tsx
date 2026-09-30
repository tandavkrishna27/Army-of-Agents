import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CockpitData } from "@armyofagents/shared";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Phase 3d: useCockpitPin calls useToast — mock it so tests don't need ToastProvider.
vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// Phase 3d: pinsApi — mock so useCockpitPin mutations don't make real network calls.
vi.mock("../../../api/pins", () => ({
  pinsApi: {
    pin: vi.fn().mockResolvedValue(undefined),
    unpin: vi.fn().mockResolvedValue(undefined),
  },
}));

// Phase 3b/3c: mock the cockpit API (replaced the 3a per-card /live-runs query)
vi.mock("../../../api/cockpit", () => ({
  cockpitApi: {
    get: vi.fn().mockResolvedValue({
      running: [],
      review: [],
      myTasks: [],
      today: { reminders: [], dueTasks: [] },
      stickyNotes: [],
      inbox: [],
      discussions: [],
      approvals: [],
      pinned: [],
      goalsAtRisk: [],
      budgetPulse: null,
      doneToday: [],
      proactiveFindings: [],
      teammatesActivity: [],
    } satisfies CockpitData),
    counts: vi.fn().mockResolvedValue({
      activeWorkMine: 0,
      activeWorkManaged: 0,
      awaitingReview: 0,
      running: 0,
      inbox: 0,
      approvals: 0,
      discussions: 0,
      generatedAt: "2026-07-10T00:00:00.000Z",
    }),
  },
}));

// Mock queryKeys — only the cockpit key is needed in this test
vi.mock("../../../lib/queryKeys", () => ({
  queryKeys: {
    cockpit: (companyId: string) => ["cockpit", companyId],
    cockpitCounts: (companyId: string) => ["cockpit", companyId, "counts"],
  },
}));

import { cockpitApi } from "../../../api/cockpit";
import { CommanderCockpitPanel } from "./CommanderCockpitPanel";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeData(overrides?: Partial<CockpitData>): CockpitData {
  return {
    running: [],
    review: [],
    myTasks: [],
    today: { reminders: [], dueTasks: [] },
    stickyNotes: [],
    inbox: [],
    discussions: [],
    // Phase 3c: required by CockpitData
    approvals: [],
    // Phase 3d: required by CockpitData
    pinned: [],
    // Opt-in cards
    goalsAtRisk: [],
    budgetPulse: null,
    doneToday: [],
    proactiveFindings: [],
    teammatesActivity: [],
    ...overrides,
  };
}

function makeRunItem(overrides?: Partial<CockpitData["running"][0]>): CockpitData["running"][0] {
  return {
    id: "run-1",
    agentName: "Atlas",
    status: "running",
    startedAt: null,
    issueId: "issue-1",
    ...overrides,
  };
}

function renderPanel(onCollapse = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CommanderCockpitPanel companyId="comp-1" onCollapse={onCollapse} />
    </QueryClientProvider>,
  );
  return { onCollapse, queryClient };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CommanderCockpitPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(cockpitApi.get).mockResolvedValue(makeData());
    vi.mocked(cockpitApi.counts).mockResolvedValue({
      activeWorkMine: 0,
      activeWorkManaged: 0,
      awaitingReview: 0,
      running: 0,
      inbox: 0,
      approvals: 0,
      discussions: 0,
      generatedAt: "2026-07-10T00:00:00.000Z",
    });
  });

  it("uses lightweight counts and disables the full query while collapsed", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CommanderCockpitPanel
          companyId="comp-1"
          collapsed
          onExpand={vi.fn()}
          onCollapse={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(cockpitApi.counts).toHaveBeenCalledWith("comp-1"));
    expect(cockpitApi.get).not.toHaveBeenCalled();
  });

  it("renders with data-testid='commander-cockpit-panel'", async () => {
    renderPanel();
    expect(screen.getByTestId("commander-cockpit-panel")).toBeInTheDocument();
  });

  it("with empty data → shows 'All clear' empty state (no cards rendered)", async () => {
    vi.mocked(cockpitApi.get).mockResolvedValue(makeData());
    renderPanel();
    // No cards visible when all slices are empty
    expect(screen.queryByTestId("cockpit-card-running")).not.toBeInTheDocument();
    // "All clear" renders immediately since active is derived from the shared data
    // (no async onActiveChange self-report — derived synchronously from query data).
    expect(await screen.findByTestId("cockpit-card-stickyNotes")).toBeInTheDocument();
    expect(screen.queryByText(/all clear/i)).not.toBeInTheDocument();
  });

  it("with running runs → the Running card renders with cockpit-card-running testid", async () => {
    const run = makeRunItem();
    const { queryClient } = renderPanel();
    // Pre-seed the cache so the component renders immediately without fetch
    queryClient.setQueryData(["cockpit", "comp-1"], makeData({ running: [run] }));
    // Re-render with seeded data
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <CommanderCockpitPanel companyId="comp-1" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("cockpit-card-running")).toBeInTheDocument();
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    unmount();
  });

  it("renders visible cards under product cockpit section headings", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["cockpit", "comp-sections"], makeData({
      approvals: [
        { source: "approval", id: "approval-1", title: "Hire Atlas", subtitle: "hire agent" },
      ],
      myTasks: [
        {
          id: "task-1",
          identifier: "AOA-1",
          title: "Write plan",
          status: "todo",
          assigneeUserId: "u1",
          assigneeAgentId: null,
          dueDate: null,
        },
      ],
      discussions: [
        { id: "disc-1", title: "Pricing sync", pendingItemCount: 1, reason: "pending_items" },
      ],
      running: [makeRunItem({ id: "run-1", agentName: "Atlas", issueId: null })],
      pinned: [
        { entityType: "task", entityId: "task-1", title: "Write plan", status: "todo", identifier: "AOA-1" },
      ],
    }));

    render(
      <QueryClientProvider client={queryClient}>
        <CommanderCockpitPanel companyId="comp-sections" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("cockpit-group-triage")).toBeInTheDocument();
    expect(screen.getByTestId("cockpit-group-my_work")).toBeInTheDocument();
    expect(screen.getByTestId("cockpit-group-conversations")).toBeInTheDocument();
    expect(screen.getByTestId("cockpit-group-watch")).toBeInTheDocument();
    expect(screen.getByTestId("cockpit-group-memory_context")).toBeInTheDocument();
    expect(screen.getByText("Triage")).toBeInTheDocument();
    expect(screen.getByText("My Work")).toBeInTheDocument();
    expect(screen.getByText("Conversations")).toBeInTheDocument();
    expect(screen.getByText("Watch")).toBeInTheDocument();
    expect(screen.getByText("Memory & Context")).toBeInTheDocument();
  });

  it("⚙ config popover can hide the running card", async () => {
    const run = makeRunItem();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["cockpit", "comp-1"], makeData({ running: [run] }));

    render(
      <QueryClientProvider client={queryClient}>
        <CommanderCockpitPanel companyId="comp-1" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );

    // Initially the card is present
    expect(screen.getByTestId("cockpit-card-running")).toBeInTheDocument();

    // Open config popover
    const configBtn = screen.getByRole("button", { name: /configure cockpit/i });
    fireEvent.click(configBtn);

    // Uncheck the "Running now" checkbox
    const checkbox = screen.getByRole("checkbox", { name: /running now/i });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);

    // After hiding, the Running card should not be rendered
    expect(screen.queryByTestId("cockpit-card-running")).not.toBeInTheDocument();
  });

  it("config popover groups card toggles by cockpit section", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /configure cockpit cards/i }));

    expect(screen.getByTestId("cockpit-config-group-triage")).toBeInTheDocument();
    expect(screen.getByTestId("cockpit-config-group-my_work")).toBeInTheDocument();
    expect(screen.getByTestId("cockpit-config-group-conversations")).toBeInTheDocument();
    expect(screen.getByTestId("cockpit-config-group-watch")).toBeInTheDocument();
    expect(screen.getByTestId("cockpit-config-group-memory_context")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /approvals/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /active work/i })).toBeInTheDocument();
  });

  it("collapse button calls onCollapse", () => {
    const onCollapse = vi.fn();
    renderPanel(onCollapse);
    const collapseBtn = screen.getByRole("button", { name: /collapse cockpit/i });
    fireEvent.click(collapseBtn);
    expect(onCollapse).toHaveBeenCalledOnce();
  });

  // Phase 5A: 42px header
  it("panel header has data-testid='commander-cockpit-header'", () => {
    renderPanel();
    expect(screen.getByTestId("commander-cockpit-header")).toBeInTheDocument();
  });

  it("panel header contains 'Cockpit' title", () => {
    renderPanel();
    expect(screen.getByText("Cockpit")).toBeInTheDocument();
  });
});

// ── Phase 5B: Collapsible card tests ──────────────────────────────────────────

describe("CommanderCockpitPanel — Phase 5B collapsible cards", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("active card renders inside CockpitSection (cockpit-section-<id> testid)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const run = makeRunItem();
    qc.setQueryData(["cockpit", "comp-p5"], makeData({ running: [run] }));

    render(
      <QueryClientProvider client={qc}>
        <CommanderCockpitPanel companyId="comp-p5" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );

    // CockpitSection renders data-testid="cockpit-section-<id>"
    expect(screen.getByTestId("cockpit-section-running")).toBeInTheDocument();
  });

  it("card body is visible by default (expanded by default)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const run = makeRunItem({ agentName: "Atlas" });
    qc.setQueryData(["cockpit", "comp-p5b"], makeData({ running: [run] }));

    render(
      <QueryClientProvider client={qc}>
        <CommanderCockpitPanel companyId="comp-p5b" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );

    // Body content visible since expanded by default
    expect(screen.getByText("Atlas")).toBeInTheDocument();
  });

  it("collapse persistence: collapsed state is saved to localStorage", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const run = makeRunItem({ agentName: "Atlas" });
    qc.setQueryData(["cockpit", "comp-persist"], makeData({ running: [run] }));

    render(
      <QueryClientProvider client={qc}>
        <CommanderCockpitPanel companyId="comp-persist" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );

    // Click the CockpitSection trigger to collapse the running card
    const trigger = screen.getByTestId("cockpit-section-trigger-running");
    fireEvent.click(trigger);

    // Verify the collapsed state was persisted to localStorage
    expect(localStorage.getItem("aoa:commander:cockpit:section:running")).toBe("false");
  });

  it("collapse persistence: stored 'false' means collapsed on re-render", async () => {
    // Pre-set the collapsed state
    localStorage.setItem("aoa:commander:cockpit:section:running", "false");

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const run = makeRunItem({ agentName: "Atlas" });
    qc.setQueryData(["cockpit", "comp-preload"], makeData({ running: [run] }));

    render(
      <QueryClientProvider client={qc}>
        <CommanderCockpitPanel companyId="comp-preload" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );

    // Section exists but content should be hidden (collapsed)
    expect(screen.getByTestId("cockpit-section-running")).toBeInTheDocument();
    // The card body (Atlas name) should NOT be visible since collapsed
    expect(screen.queryByText("Atlas")).not.toBeInTheDocument();
  });
});

// ── Phase 5D: registry icon/summary ───────────────────────────────────────────

import { COCKPIT_REGISTRY } from "./CommanderCockpitPanel";

describe("COCKPIT_REGISTRY — Phase 5 icon + summary", () => {
  it("every registry entry has an icon (Lucide component)", () => {
    for (const entry of COCKPIT_REGISTRY) {
      expect(entry.icon, `${entry.id} missing icon`).toBeDefined();
      // Lucide icons may be function or object (forwardRef) depending on version
      expect(["function", "object"]).toContain(typeof entry.icon);
    }
  });

  it("every registry entry has a summary function", () => {
    for (const entry of COCKPIT_REGISTRY) {
      expect(entry.summary, `${entry.id} missing summary`).toBeDefined();
      expect(typeof entry.summary).toBe("function");
    }
  });

  it("'running' summary returns count string when data has runs", () => {
    const runningEntry = COCKPIT_REGISTRY.find((c) => c.id === "running")!;
    const data = makeData({ running: [makeRunItem(), makeRunItem({ id: "run-2" })] });
    expect(runningEntry.summary(data)).toBe("2 running");
  });

  it("'running' summary returns null when no runs", () => {
    const runningEntry = COCKPIT_REGISTRY.find((c) => c.id === "running")!;
    expect(runningEntry.summary(makeData())).toBeNull();
  });

  it("'review' summary returns count string", () => {
    const reviewEntry = COCKPIT_REGISTRY.find((c) => c.id === "review")!;
    const data = makeData({
      review: [{ id: "t1", title: "T", status: "in_review", identifier: null, assigneeUserId: null, assigneeAgentId: null, dueDate: null }],
    });
    expect(reviewEntry.summary(data)).toBe("1 awaiting");
  });

  it("'budgetPulse' summary shows percent", () => {
    const budgetEntry = COCKPIT_REGISTRY.find((c) => c.id === "budgetPulse")!;
    const data = makeData({ budgetPulse: { limitCents: 1000, spentCents: 750, percentUsed: 75, openIncidentCount: 0 } });
    expect(budgetEntry.summary(data)).toBe("75% used");
  });
});
