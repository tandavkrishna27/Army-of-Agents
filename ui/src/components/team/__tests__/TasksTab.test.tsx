import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";

// Mock @/lib/router so any company-prefix-aware Link/navigate doesn't pull in
// CompanyProvider (we render outside a real CompanyContext here).
vi.mock("@/lib/router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => vi.fn(),
  };
});

import { TasksTab } from "../TasksTab";

const mockIssuesList = vi.fn();
const mockIssuesUpdate = vi.fn();

vi.mock("../../../api/issues", () => ({
  issuesApi: {
    list: (...args: any[]) => mockIssuesList(...args),
    update: (...args: any[]) => mockIssuesUpdate(...args),
  },
}));

// KanbanBoard pulls in dnd-kit which is heavy in jsdom; stub it down to the
// surface this test cares about: the flat list of cards, and the click→select
// wiring. Each card is a button that fires onSelectIssue with the identifier
// (falling back to id) — mirroring the real board's behavior.
vi.mock("../../KanbanBoard", () => ({
  KanbanBoard: ({
    issues,
    cardVariant,
    onSelectIssue,
  }: {
    issues: any[];
    cardVariant?: string;
    onSelectIssue?: (id: string) => void;
  }) => (
    <div data-testid="kanban-stub" data-card-variant={cardVariant ?? "(default)"}>
      {issues.map((i) => (
        <button
          key={i.id}
          type="button"
          data-testid={`kb-card-${i.id}`}
          onClick={() => onSelectIssue?.(i.identifier ?? i.id)}
        >
          {i.title}
        </button>
      ))}
    </div>
  ),
}));

// TaskSlideOver is the rich detail panel (many queries) — stub it to a marker
// that reflects whether it's open and which issue it's showing.
vi.mock("../../TaskSlideOver", () => ({
  TaskSlideOver: ({ issueId, open }: { issueId: string | null; open: boolean }) =>
    open ? (
      <div data-testid="task-slide-over" data-issue-id={issueId ?? ""}>
        slide-over
      </div>
    ) : null,
}));

function makeIssue(overrides: Record<string, any> = {}) {
  return {
    id: "i-1",
    companyId: "comp-1",
    projectId: null,
    goalId: null,
    parentId: null,
    title: "Task title",
    description: null,
    status: "todo" as const,
    priority: "medium" as const,
    workMode: "standard" as const,
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    executionWorkspaceId: null,
    executionEnvironmentId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "TC-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    source: null,
    originKind: "crew_thread",
    sourceDiscussionId: "thread-A",
    sourceThreadTitle: "Plan landing page redesign",
    reviewerUserId: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    artifactId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("CrewBoard (TasksTab)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading then renders one flat board with all crew tasks (no source grouping)", async () => {
    mockIssuesList.mockResolvedValue([
      makeIssue({ id: "i-1", title: "Hero copy" }),
      makeIssue({ id: "i-2", title: "Pricing card" }),
      makeIssue({
        id: "i-3",
        title: "Backend API stub",
        originKind: "goal",
        sourceDiscussionId: null,
        sourceThreadTitle: null,
      }),
    ]);

    renderWithProviders(<TasksTab companyId="comp-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("crew-board")).toBeInTheDocument(),
    );

    // The query is issued with taskScope:'crew' (crew-assignee predicate + the
    // source-thread JOIN), and no agent filter is appended.
    expect(mockIssuesList).toHaveBeenCalledWith("comp-1", {
      taskScope: "crew",
    });

    // Exactly one KanbanBoard (no per-thread boards/headers).
    expect(screen.getAllByTestId("kanban-stub")).toHaveLength(1);

    // The Crew Board opts into the enriched "crew" card variant (owner avatar +
    // source badge + artifact chip). Only this surface passes it.
    expect(screen.getByTestId("kanban-stub")).toHaveAttribute(
      "data-card-variant",
      "crew",
    );

    // Every returned task renders flat — including the goal-origin task that has
    // no sourceDiscussionId (the old grouped board would have dropped it).
    expect(screen.getByTestId("kb-card-i-1")).toBeInTheDocument();
    expect(screen.getByTestId("kb-card-i-2")).toBeInTheDocument();
    expect(screen.getByTestId("kb-card-i-3")).toBeInTheDocument();

    // No "From: <thread>" group headers remain.
    expect(
      screen.queryByText("Plan landing page redesign"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("crew-board-group-thread-A")).not.toBeInTheDocument();
  });

  it("clicking a card opens the full TaskSlideOver for that task", async () => {
    const user = userEvent.setup();
    mockIssuesList.mockResolvedValue([
      makeIssue({ id: "i-1", identifier: "QAC-13", title: "Hero copy" }),
    ]);

    renderWithProviders(<TasksTab companyId="comp-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("kb-card-i-1")).toBeInTheDocument(),
    );

    // Closed by default.
    expect(screen.queryByTestId("task-slide-over")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("kb-card-i-1"));

    const slideOver = await screen.findByTestId("task-slide-over");
    expect(slideOver).toBeInTheDocument();
    // Opens with the identifier (resolved server-side); not the audit card.
    expect(slideOver).toHaveAttribute("data-issue-id", "QAC-13");
  });

  it("renders the empty state when no crew tasks come back from the server", async () => {
    mockIssuesList.mockResolvedValue([]);

    renderWithProviders(<TasksTab companyId="comp-1" />);

    await waitFor(() =>
      expect(screen.getByTestId("crew-board-empty")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/No crew tasks yet\. Crew-agent tasks will appear here\./),
    ).toBeInTheDocument();
  });

  it("does not render an agent-filter dropdown (board is one flat list)", async () => {
    mockIssuesList.mockResolvedValue([
      makeIssue({ id: "i-1", title: "Task by A", assigneeAgentId: "agent-1" }),
    ]);

    renderWithProviders(
      <TasksTab
        companyId="comp-1"
        crewAgents={[
          { id: "agent-1", name: "Adjutant" },
          { id: "agent-2", name: "Planner" },
        ]}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("crew-board")).toBeInTheDocument(),
    );

    // The old crew-board-agent-filter dropdown is gone — owner lives on the card.
    expect(screen.queryByTestId("crew-board-agent-filter")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-filter-select")).not.toBeInTheDocument();

    // And the query is never re-issued with assigneeAgentId from the board.
    expect(mockIssuesList).toHaveBeenCalledTimes(1);
    expect(mockIssuesList).toHaveBeenCalledWith("comp-1", { taskScope: "crew" });
  });
});
