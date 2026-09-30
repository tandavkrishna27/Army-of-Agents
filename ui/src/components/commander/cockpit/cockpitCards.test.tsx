/**
 * Phase 3b: Component tests for the 5 presentational cockpit cards.
 * All cards receive data directly (no query mocking needed — they are pure
 * presentational components).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CockpitData, CommanderOutputRef } from "@armyofagents/shared";

// Mock queryKeys and cockpitApi for the panel test (panel tests come later)
vi.mock("../../../api/cockpit", () => ({
  cockpitApi: {
    get: vi.fn().mockResolvedValue({ running: [], review: [], myTasks: [], today: { reminders: [], dueTasks: [] }, stickyNotes: [], inbox: [], discussions: [], approvals: [], pinned: [], goalsAtRisk: [], budgetPulse: null, doneToday: [], proactiveFindings: [], teammatesActivity: [] } satisfies CockpitData),
    counts: vi.fn().mockResolvedValue({ activeWorkMine: 0, activeWorkManaged: 0, awaitingReview: 0, running: 0, inbox: 0, approvals: 0, discussions: 0, generatedAt: "2026-07-10T00:00:00.000Z" }),
  },
}));
vi.mock("../../../lib/queryKeys", () => ({
  queryKeys: {
    cockpit: (id: string) => ["cockpit", id],
    cockpitCounts: (id: string) => ["cockpit", id, "counts"],
  },
}));
// Phase 3d: useCockpitPin calls useToast — mock it so panel tests don't need ToastProvider.
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

import { CommanderCockpitPanel } from "./CommanderCockpitPanel";
import { CockpitRunningCard } from "./CockpitRunningCard";
import { CockpitReviewCard } from "./CockpitReviewCard";
import { CockpitMyTasksCard } from "./CockpitMyTasksCard";
import { CockpitTodayCard } from "./CockpitTodayCard";
import { CockpitStickyNotesCard } from "./CockpitStickyNotesCard";
import { CockpitInboxCard } from "./CockpitInboxCard";
import { CockpitDiscussionsCard } from "./CockpitDiscussionsCard";

// ── Data factories ─────────────────────────────────────────────────────────

type RunItem = CockpitData["running"][0];
type TaskItem = CockpitData["review"][0];
type WorkTaskItem = NonNullable<CockpitData["activeWork"]>["mine"]["items"][0];
type ReminderItem = CockpitData["today"]["reminders"][0];
type DiscussionItem = CockpitData["discussions"][0];
type NoteItem = CockpitData["stickyNotes"][0];
type InboxItem = CockpitData["inbox"][0];

function makeRun(overrides?: Partial<RunItem>): RunItem {
  return { id: "run-1", agentName: "Atlas", status: "running", startedAt: null, issueId: "issue-1", ...overrides };
}

function makeTask(overrides?: Partial<TaskItem>): TaskItem {
  return {
    id: "task-1",
    identifier: "ACME-1",
    title: "Fix the login flow",
    status: "in_review",
    assigneeUserId: "u1",
    assigneeAgentId: null,
    dueDate: null,
    ...overrides,
  };
}

function makeWorkTask(overrides?: Partial<WorkTaskItem>): WorkTaskItem {
  return {
    ...makeTask(),
    priority: "high",
    responsibleUserId: "u1",
    reviewerUserId: null,
    responsibility: {
      reason: "assigned_to_you",
      entityType: "user",
      entityId: "u1",
      label: "Assigned to you",
    },
    ...overrides,
  };
}

function makeReminder(overrides?: Partial<ReminderItem>): ReminderItem {
  return { id: "rem-1", content: "Review Q2 roadmap", triggerAt: new Date().toISOString(), ...overrides };
}

function makeDiscussion(overrides?: Partial<DiscussionItem>): DiscussionItem {
  return { id: "disc-1", title: "Sprint planning", pendingItemCount: 3, reason: "pending_items", ...overrides };
}

function makeNote(overrides?: Partial<NoteItem>): NoteItem {
  return {
    id: "note-1",
    title: "Hiring",
    body: "Ask Priya about design contractor availability",
    color: "yellow",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeInboxItem(overrides?: Partial<InboxItem>): InboxItem {
  return {
    id: "hub-1",
    lane: "waiting_on_you",
    priority: "urgent",
    title: "Approve launch budget",
    summary: "Budget change needs review",
    sourceType: "approval",
    sourceId: "approval-1",
    relatedEntityType: "approval",
    relatedEntityId: "approval-1",
    unread: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Panel: card rendering from shared data ─────────────────────────────────

describe("CommanderCockpitPanel with shared data", () => {
  it("renders the Running card when data.running is non-empty", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["cockpit", "comp-1"], {
      running: [makeRun()],
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
    } satisfies CockpitData);

    render(
      <QueryClientProvider client={qc}>
        <CommanderCockpitPanel companyId="comp-1" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("cockpit-card-running")).toBeInTheDocument();
  });

  it("renders the Review card when data.review is non-empty", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["cockpit", "comp-1"], {
      running: [],
      review: [makeTask({ status: "in_review" })],
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
    } satisfies CockpitData);

    render(
      <QueryClientProvider client={qc}>
        <CommanderCockpitPanel companyId="comp-1" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("cockpit-card-review")).toBeInTheDocument();
  });

  it("renders the Sticky notes card even when all work slices are empty", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["cockpit", "comp-1"], {
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
    } satisfies CockpitData);

    render(
      <QueryClientProvider client={qc}>
        <CommanderCockpitPanel companyId="comp-1" onCollapse={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("cockpit-card-stickyNotes")).toBeInTheDocument();
    expect(screen.queryByText(/all clear/i)).not.toBeInTheDocument();
  });
});

// ── CockpitRunningCard ─────────────────────────────────────────────────────

describe("CockpitRunningCard", () => {
  it("renders null when runs is empty", () => {
    const { container } = render(<CockpitRunningCard runs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows agent name", () => {
    render(<CockpitRunningCard runs={[makeRun({ agentName: "Atlas" })]} />);
    expect(screen.getByText("Atlas")).toBeInTheDocument();
  });

  it("row click calls onOpenTask with issueId", () => {
    const onOpenTask = vi.fn();
    render(<CockpitRunningCard runs={[makeRun({ issueId: "issue-42", agentName: "Atlas" })]} onOpenTask={onOpenTask} />);
    fireEvent.click(screen.getByText("Atlas"));
    expect(onOpenTask).toHaveBeenCalledWith("issue-42", expect.any(String));
  });

  it("Ask↩ button calls onAsk with a scoped string", () => {
    const onAsk = vi.fn();
    render(<CockpitRunningCard runs={[makeRun({ agentName: "Atlas" })]} onAsk={onAsk} />);
    // The Ask button is hidden until hover — use fireEvent directly
    const askBtn = screen.getByRole("button", { name: /ask commander about this/i });
    fireEvent.click(askBtn);
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining("Atlas"));
  });
});

// ── CockpitReviewCard ──────────────────────────────────────────────────────

describe("CockpitReviewCard", () => {
  it("renders null when items is empty", () => {
    const { container } = render(<CockpitReviewCard items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows task title", () => {
    render(<CockpitReviewCard items={[makeTask({ title: "Fix the login flow" })]} />);
    expect(screen.getByText("Fix the login flow")).toBeInTheDocument();
  });

  it("row click calls onOpenTask(id, title)", () => {
    const onOpenTask = vi.fn();
    render(<CockpitReviewCard items={[makeTask({ id: "t-1", title: "Fix the login flow" })]} onOpenTask={onOpenTask} />);
    fireEvent.click(screen.getByText("Fix the login flow"));
    expect(onOpenTask).toHaveBeenCalledWith("t-1", "Fix the login flow");
  });

  it("Ask↩ button calls onAsk with scoped string including identifier", () => {
    const onAsk = vi.fn();
    render(<CockpitReviewCard items={[makeTask({ identifier: "ACME-1", title: "Fix the login flow" })]} onAsk={onAsk} />);
    const askBtn = screen.getByRole("button", { name: /ask commander about this/i });
    fireEvent.click(askBtn);
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining("ACME-1"));
  });
});

// ── CockpitMyTasksCard ─────────────────────────────────────────────────────

describe("CockpitMyTasksCard", () => {
  it("renders null when items is empty", () => {
    const { container } = render(<CockpitMyTasksCard items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows items grouped by status", () => {
    render(
      <CockpitMyTasksCard
        items={[
          makeTask({ id: "t1", status: "todo", title: "Write docs" }),
          makeTask({ id: "t2", status: "in_progress", title: "Build API" }),
        ]}
      />,
    );
    expect(screen.getByText("Write docs")).toBeInTheDocument();
    expect(screen.getByText("Build API")).toBeInTheDocument();
  });

  it("row click calls onOpenTask", () => {
    const onOpenTask = vi.fn();
    render(
      <CockpitMyTasksCard items={[makeTask({ id: "t-42", title: "Write docs" })]} onOpenTask={onOpenTask} />,
    );
    fireEvent.click(screen.getByText("Write docs"));
    expect(onOpenTask).toHaveBeenCalledWith("t-42", "Write docs");
  });

  it("renders Mine and Managed as distinct accountable-work groups", () => {
    render(
      <CockpitMyTasksCard
        activeWork={{
          mine: { items: [makeWorkTask({ id: "mine-1", title: "My launch task" })], total: 1 },
          managed: {
            items: [makeWorkTask({
              id: "managed-1",
              title: "Agent migration",
              responsibility: {
                reason: "managed_agent",
                entityType: "agent",
                entityId: "agent-1",
                label: "Managed: Atlas",
              },
            })],
            total: 4,
          },
        }}
      />,
    );

    expect(screen.getByTestId("cockpit-active-work-mine")).toHaveTextContent("My launch task");
    expect(screen.getByTestId("cockpit-active-work-managed")).toHaveTextContent("Agent migration");
    expect(screen.getByText("Managed: Atlas")).toBeInTheDocument();
    expect(screen.getByTestId("cockpit-active-work-managed")).toHaveTextContent("4");
  });
});

// ── CockpitTodayCard ───────────────────────────────────────────────────────

describe("CockpitTodayCard", () => {
  it("renders null when no reminders and no dueTasks", () => {
    const { container } = render(<CockpitTodayCard reminders={[]} dueTasks={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows reminder content", () => {
    render(<CockpitTodayCard reminders={[makeReminder({ content: "Review Q2 roadmap" })]} dueTasks={[]} />);
    expect(screen.getByText("Review Q2 roadmap")).toBeInTheDocument();
  });

  it("due task row click calls onOpenTask", () => {
    const onOpenTask = vi.fn();
    render(
      <CockpitTodayCard
        reminders={[]}
        dueTasks={[makeTask({ id: "due-1", title: "Ship v1" })]}
        onOpenTask={onOpenTask}
      />,
    );
    fireEvent.click(screen.getByText("Ship v1"));
    expect(onOpenTask).toHaveBeenCalledWith("due-1", "Ship v1");
  });
});

// ── CockpitReviewCard — Pin button (Phase 3d) ──────────────────────────────

describe("CockpitReviewCard — Pin button", () => {
  it("Pin button calls onPin('task', id)", () => {
    const onPin = vi.fn();
    render(
      <CockpitReviewCard
        items={[makeTask({ id: "t-pin-1", title: "Pinnable task" })]}
        onPin={onPin}
      />,
    );
    const pinBtn = screen.getByRole("button", { name: /^pin$/i });
    fireEvent.click(pinBtn);
    expect(onPin).toHaveBeenCalledWith("task", "t-pin-1");
  });

  it("Pin button is absent when onPin is not provided", () => {
    render(<CockpitReviewCard items={[makeTask({ title: "No pin card" })]} />);
    expect(screen.queryByRole("button", { name: /^pin$/i })).not.toBeInTheDocument();
  });
});

// ── CockpitDiscussionsCard ─────────────────────────────────────────────────

describe("CockpitStickyNotesCard", () => {
  it("renders personal notes", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CockpitStickyNotesCard companyId="comp-1" items={[makeNote()]} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Hiring")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Ask Priya about design contractor availability")).toBeInTheDocument();
  });

  it("sends note context to Commander", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onAsk = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <CockpitStickyNotesCard companyId="comp-1" items={[makeNote()]} onAsk={onAsk} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByLabelText("Ask Commander about this note"));
    expect(onAsk).toHaveBeenCalledWith(
      "Use this note as context: Hiring - Ask Priya about design contractor availability",
    );
  });
});

describe("CockpitInboxCard", () => {
  it("renders inbox items and opens the full inbox route", () => {
    const onOpenFullPage = vi.fn();
    render(
      <CockpitInboxCard
        items={[makeInboxItem()]}
        onOpenFullPage={onOpenFullPage}
      />,
    );

    fireEvent.click(screen.getByText("Approve launch budget"));
    expect(onOpenFullPage).toHaveBeenCalledWith("/inbox/waiting/hub-1");
  });

  it("sends inbox item context to Commander", () => {
    const onAsk = vi.fn();
    render(<CockpitInboxCard items={[makeInboxItem()]} onAsk={onAsk} />);

    fireEvent.click(screen.getByLabelText("Ask Commander about this inbox item"));
    expect(onAsk).toHaveBeenCalledWith(
      "Use this inbox item as context: Approve launch budget - Budget change needs review",
    );
  });
});

describe("CockpitDiscussionsCard", () => {
  it("renders null when items is empty", () => {
    const { container } = render(<CockpitDiscussionsCard items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows discussion title", () => {
    render(<CockpitDiscussionsCard items={[makeDiscussion({ title: "Sprint planning" })]} />);
    expect(screen.getByText("Sprint planning")).toBeInTheDocument();
  });

  it("row click calls onOpenFullPage with /discussions/:id", () => {
    const onOpenFullPage = vi.fn();
    render(
      <CockpitDiscussionsCard
        items={[makeDiscussion({ id: "disc-99", title: "Sprint planning" })]}
        onOpenFullPage={onOpenFullPage}
      />,
    );
    fireEvent.click(screen.getByText("Sprint planning"));
    expect(onOpenFullPage).toHaveBeenCalledWith("/discussions/disc-99");
  });

  it("Ask↩ button calls onAsk with discussion title", () => {
    const onAsk = vi.fn();
    render(
      <CockpitDiscussionsCard
        items={[makeDiscussion({ title: "Sprint planning" })]}
        onAsk={onAsk}
      />,
    );
    const askBtn = screen.getByRole("button", { name: /ask commander about this/i });
    fireEvent.click(askBtn);
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining("Sprint planning"));
  });
});

// ── CommanderCockpitPanel + CockpitConversationZone integration ───────────────

function makeConversationRef(overrides?: Partial<CommanderOutputRef>): CommanderOutputRef {
  return {
    v: 1,
    kind: "artifact",
    id: "artifact-zone-1",
    versionId: "ver-zone-1",
    title: "Zone Artifact",
    action: "created",
    ...overrides,
  };
}

function renderPanelWithRefs(conversationRefs: CommanderOutputRef[], data: CockpitData) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["cockpit", "comp-zone"], data);
  render(
    <QueryClientProvider client={qc}>
      <CommanderCockpitPanel
        companyId="comp-zone"
        onCollapse={vi.fn()}
        conversationRefs={conversationRefs}
      />
    </QueryClientProvider>,
  );
  return qc;
}

const EMPTY_COCKPIT: CockpitData = {
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
};

describe("CommanderCockpitPanel — CockpitConversationZone integration", () => {
  it("zone renders when conversationRefs is non-empty, even if all cards are empty", () => {
    renderPanelWithRefs([makeConversationRef()], EMPTY_COCKPIT);
    expect(screen.getByTestId("cockpit-zone-conversation")).toBeInTheDocument();
  });

  it("'All clear' does NOT appear when conversationRefs is non-empty (even if all cards empty)", async () => {
    renderPanelWithRefs([makeConversationRef()], EMPTY_COCKPIT);
    // Zone is showing — All clear must be suppressed
    expect(screen.queryByText(/all clear/i)).not.toBeInTheDocument();
  });

  it("shows Sticky notes when conversationRefs is empty and all work slices are empty", async () => {
    renderPanelWithRefs([], EMPTY_COCKPIT);
    expect(await screen.findByTestId("cockpit-card-stickyNotes")).toBeInTheDocument();
    expect(screen.queryByText(/all clear/i)).not.toBeInTheDocument();
  });

  it("zone title is shown in the panel", () => {
    renderPanelWithRefs([makeConversationRef({ title: "Zone Artifact" })], EMPTY_COCKPIT);
    expect(screen.getByText("Zone Artifact")).toBeInTheDocument();
  });
});
