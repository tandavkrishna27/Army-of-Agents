import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import type { Issue } from "@armyofagents/shared";
import { KanbanBoard, type KanbanCardVariant } from "../components/KanbanBoard";

/**
 * Tests for the shared KanbanCard footer across its two chrome variants
 * (unified-crew-board design 2026-06-02, T-D):
 *
 *   - `cardVariant="crew"` (Crew Board only) renders the ENRICHED meta row:
 *     owner avatar (🤖 agent / 👤 human), clickable source-lineage badge, and
 *     artifact chip.
 *   - `cardVariant="standard"` (the DEFAULT — main Tasks board + department/
 *     project boards) renders the pre-74d603770 footer: PriorityIcon + the bare
 *     assignee name, with NONE of the enrichment.
 *
 * The enrichment assertions therefore all pass `cardVariant="crew"`; a separate
 * block guards that the standard (default) card stays un-enriched.
 */

// The card's outer Link and the source-badge navigate both resolve the active
// company prefix via useCompany. Mock it with no selected company so paths stay
// un-prefixed and navigation assertions read cleanly.
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: null,
    companies: [],
  }),
}));

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "comp-1",
    projectId: null,
    goalId: null,
    parentId: null,
    title: "Build first-action prompt flow",
    description: null,
    status: "in_progress",
    priority: "high",
    workMode: "standard",
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
    issueNumber: 13,
    identifier: "QAC-13",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    source: null,
    sourceDiscussionId: null,
    sourceThreadTitle: null,
    reviewerUserId: null,
    dueDate: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    artifactId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Issue;
}

/** Renders the board with a location probe so we can assert navigation. */
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}</div>;
}

function renderBoard(
  issue: Issue,
  opts: {
    agents?: { id: string; name: string }[];
    onSelectIssue?: (id: string) => void;
    /** Omit to exercise the genuine default ("standard"). */
    cardVariant?: KanbanCardVariant;
  } = {},
) {
  return render(
    <MemoryRouter initialEntries={["/board"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <KanbanBoard
                issues={[issue]}
                agents={opts.agents}
                {...(opts.cardVariant ? { cardVariant: opts.cardVariant } : {})}
                onUpdateIssue={vi.fn()}
                onSelectIssue={opts.onSelectIssue}
              />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("KanbanCard (crew variant) — owner", () => {
  it("renders the agent avatar + name for an agent-assigned task", () => {
    const issue = makeIssue({ assigneeAgentId: "agent-9" });
    renderBoard(issue, {
      agents: [{ id: "agent-9", name: "Engineer" }],
      cardVariant: "crew",
    });

    // Agent owner: shared AgentAvatar (robot) + the agent name.
    expect(screen.getAllByTestId("agent-avatar").length).toBeGreaterThan(0);
    expect(screen.getByText("Engineer")).toBeTruthy();
  });

  it("renders human initials (not the robot) for a human-assigned task", () => {
    const issue = makeIssue({ assigneeUserId: "Ada Lovelace" });
    renderBoard(issue, { cardVariant: "crew" });

    // Human owner uses Identity initials — no agent robot avatar present.
    expect(screen.queryByTestId("agent-avatar")).toBeNull();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
  });
});

describe("KanbanCard (crew variant) — source badge (lineage)", () => {
  it("shows the discussion thread title and links to the origin", async () => {
    const user = userEvent.setup();
    const onSelectIssue = vi.fn();
    const issue = makeIssue({
      sourceThreadTitle: "QA6-drive",
      sourceDiscussionId: "disc-77",
    });
    renderBoard(issue, { onSelectIssue, cardVariant: "crew" });

    const badge = screen.getByTitle("From discussion: QA6-drive");
    expect(badge).toBeTruthy();
    // Truncated/exact thread title appears in the badge label.
    expect(within(badge).getByText("QA6-drive")).toBeTruthy();
    expect(badge.getAttribute("role")).toBe("link");

    // Clicking the badge navigates to the discussion and does NOT open the
    // card slide-over (stopPropagation/preventDefault on the outer Link).
    await user.click(badge);
    expect(screen.getByTestId("location").textContent).toContain("/discussions/disc-77");
    expect(onSelectIssue).not.toHaveBeenCalled();
  });

  it("links a goal-scoped task to its goal", () => {
    const issue = makeIssue({ goalId: "goal-3" });
    renderBoard(issue, { cardVariant: "crew" });

    const badge = screen.getByTitle("Serves a goal");
    expect(badge.getAttribute("role")).toBe("link");
    expect(within(badge).getByText("goal")).toBeTruthy();
  });

  it("renders a faint non-clickable 'direct' label for context-free tasks", () => {
    const issue = makeIssue();
    renderBoard(issue, { cardVariant: "crew" });

    const badge = screen.getByTitle("Created directly");
    // Not a link — direct tasks have no navigable origin.
    expect(badge.getAttribute("role")).not.toBe("link");
    expect(within(badge).getByText("direct")).toBeTruthy();
  });
});

describe("KanbanCard (crew variant) — artifact chip", () => {
  it("renders the artifact chip only when artifactId is present", () => {
    const withArtifact = makeIssue({ artifactId: "artifact-1" });
    const { unmount } = renderBoard(withArtifact, { cardVariant: "crew" });
    expect(screen.getByTestId("kanban-artifact-chip")).toBeTruthy();
    unmount();

    const withoutArtifact = makeIssue();
    renderBoard(withoutArtifact, { cardVariant: "crew" });
    expect(screen.queryByTestId("kanban-artifact-chip")).toBeNull();
  });
});

describe("KanbanCard (standard variant — the default) — no enrichment", () => {
  it("renders the bare assignee name with NO owner avatar, source badge, or artifact chip", () => {
    // Loaded with everything that WOULD light up the enriched meta row: an agent
    // owner, a discussion lineage, AND an artifact. On the standard card none of
    // it renders — only the pre-74d603770 footer (PriorityIcon + bare name).
    const issue = makeIssue({
      assigneeAgentId: "agent-9",
      sourceThreadTitle: "QA6-drive",
      sourceDiscussionId: "disc-77",
      artifactId: "artifact-1",
    });
    // No cardVariant → exercises the genuine default ("standard").
    renderBoard(issue, { agents: [{ id: "agent-9", name: "Engineer" }] });

    // Bare assignee name still shows (Identity, size "xs").
    expect(screen.getByText("Engineer")).toBeTruthy();

    // None of the enrichment is present.
    expect(screen.queryByTestId("agent-avatar")).toBeNull();
    expect(screen.queryByTestId("kanban-artifact-chip")).toBeNull();
    expect(screen.queryByTitle("From discussion: QA6-drive")).toBeNull();
  });

  it("falls back to the id prefix when the agent name can't be resolved", () => {
    const issue = makeIssue({ assigneeAgentId: "agent-abcdef12" });
    // No agents passed → name unresolved → mono id-prefix fallback.
    renderBoard(issue);

    expect(screen.getByText("agent-ab")).toBeTruthy();
    expect(screen.queryByTestId("agent-avatar")).toBeNull();
  });

  it("keeps the blocked chip on the standard card (predates the enrichment)", () => {
    const issue = makeIssue({ status: "blocked" });
    renderBoard(issue);

    // The blocked dependency chip lives in the header (outside the gated
    // footer), so it renders for BOTH variants. Assert its visual marker — the
    // amber Link2 icon — directly, without relying on the Radix tooltip portal
    // (which only mounts the label text on hover and is flaky in jsdom).
    expect(document.querySelector("svg.lucide-link-2")).not.toBeNull();

    // Still no enrichment on the standard card.
    expect(screen.queryByTestId("agent-avatar")).toBeNull();
    expect(screen.queryByTestId("kanban-artifact-chip")).toBeNull();
  });
});
