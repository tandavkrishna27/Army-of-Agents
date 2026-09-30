import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils";
import { RoutineRevisionHistory } from "../components/routines/RoutineRevisionHistory";

// ── API mocks ──────────────────────────────────────────────────────────────────
const listRevisionsMock = vi.fn();
const restoreRevisionMock = vi.fn();

vi.mock("@/api/routines", () => ({
  routinesApi: {
    listRevisions: (...args: unknown[]) => listRevisionsMock(...args),
    restoreRevision: (...args: unknown[]) => restoreRevisionMock(...args),
  },
}));

const pushToast = vi.fn();
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────
function makeRevision(overrides: Record<string, unknown> = {}) {
  return {
    id: "rev-1",
    companyId: "comp-1",
    routineId: "routine-1",
    snapshot: {
      title: "My Routine",
      description: "Initial description",
      assigneeAgentId: null,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [],
      projectId: null,
      goalId: null,
      parentIssueId: null,
    },
    author: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

const ROUTINE_ID = "routine-1";
const defaultProps = {
  routineId: ROUTINE_ID,
  getBaseRevisionId: () => "head-revision",
  onRestored: vi.fn(),
};

// ── Tests ──────────────────────────────────────────────────────────────────────
describe("RoutineRevisionHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    restoreRevisionMock.mockResolvedValue({ id: ROUTINE_ID, latestRevisionId: "restored-head" });
  });

  it("renders empty state when query returns empty list", async () => {
    listRevisionsMock.mockResolvedValue([]);

    renderWithProviders(<RoutineRevisionHistory {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/no revision history yet/i)).toBeInTheDocument();
    });
  });

  it("renders revision cards when query returns revisions", async () => {
    const rev = makeRevision({
      id: "rev-1",
      author: { type: "user", userId: "user-alice" },
    });
    listRevisionsMock.mockResolvedValue([rev]);

    renderWithProviders(<RoutineRevisionHistory {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("user-alice")).toBeInTheDocument();
    });
    // Restore button should be present
    expect(screen.getByRole("button", { name: /restore/i })).toBeInTheDocument();
  });

  it("renders agent author name when author type is agent", async () => {
    const rev = makeRevision({
      author: { type: "agent", name: "CodeBot", urlKey: "codebot" },
    });
    listRevisionsMock.mockResolvedValue([rev]);

    renderWithProviders(<RoutineRevisionHistory {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("CodeBot")).toBeInTheDocument();
    });
  });

  it("clicking Restore calls restoreRevision with correct args and fires onRestored", async () => {
    const user = userEvent.setup();
    const onRestored = vi.fn();
    const rev = makeRevision({ id: "rev-abc" });
    listRevisionsMock.mockResolvedValue([rev]);

    renderWithProviders(
      <RoutineRevisionHistory {...defaultProps} routineId={ROUTINE_ID} onRestored={onRestored} />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /restore/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /restore/i }));

    await waitFor(() => {
      expect(restoreRevisionMock).toHaveBeenCalledWith(ROUTINE_ID, "rev-abc", "head-revision");
      expect(onRestored).toHaveBeenCalledWith(
        expect.objectContaining({ latestRevisionId: "restored-head" }),
      );
    });
  });

  it("shows 'No description change' when description did not change between revisions", async () => {
    const user = userEvent.setup();
    const sharedDesc = "Same description";
    const rev1 = makeRevision({
      id: "rev-1",
      snapshot: { ...makeRevision().snapshot, description: sharedDesc },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const rev2 = makeRevision({
      id: "rev-2",
      snapshot: { ...makeRevision().snapshot, description: sharedDesc },
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
    // newest-first: rev1 is index 0, rev2 is index 1
    listRevisionsMock.mockResolvedValue([rev1, rev2]);

    renderWithProviders(<RoutineRevisionHistory {...defaultProps} />);

    await waitFor(() => {
      const showDiffButtons = screen.getAllByRole("button", { name: /show diff/i });
      expect(showDiffButtons.length).toBeGreaterThan(0);
    });

    // Open the first revision's diff
    const showDiffButtons = screen.getAllByRole("button", { name: /show diff/i });
    await user.click(showDiffButtons[0]);

    await waitFor(() => {
      expect(screen.getByText(/no description change/i)).toBeInTheDocument();
    });
  });
});
