import { beforeEach, describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UserRole } from "@armyofagents/shared";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { HomeBoard } from "../../components/home/HomeBoard";
import { HomeBoardControls } from "../../components/home/HomeBoardControls";
import { useBoardEdit } from "../../components/home/useBoardEdit";

// Same jsdom-width workaround as HomeBoard.test.tsx (see its comment for why).
const containerWidthMock = vi.hoisted(() => ({ width: 1024 }));
vi.mock("react-grid-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-grid-layout")>();
  return {
    ...actual,
    useContainerWidth: () => ({
      width: containerWidthMock.width,
      mounted: true,
      containerRef: { current: null },
      measureWidth: vi.fn(),
    }),
  };
});

// Hook-layer mocks (not api-layer) — this file is about the ARIA contract of
// the rendered markup, not query behavior (see HomeBoard.strictmode.test.tsx/
// HomeBoard.queries.test.tsx for that). Mirrors HomeBoard.test.tsx's harness.
const homeBoardLayoutMock = vi.hoisted(() => ({
  layout: null as null,
  saveAsync: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("../../hooks/useHomeBoardLayout", () => ({
  useHomeBoardLayout: () => ({
    layout: homeBoardLayoutMock.layout,
    schemaVersion: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
    save: vi.fn(),
    saveAsync: homeBoardLayoutMock.saveAsync,
    isSaving: false,
    saveError: null,
    reset: homeBoardLayoutMock.reset,
    resetAsync: vi.fn(),
    isResetting: false,
    resetError: null,
  }),
}));

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../hooks/useHomeSummary", () => ({
  useHomeSummary: () => ({
    data: {
      goalProgress: [{ id: "g1", title: "Launch", status: "active", totalTasks: 2, doneTasks: 1, inProgressTasks: 1, blockedTasks: 0, progressPercent: 50 }],
      recentActivity: [{ id: "a1", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Spec" }, createdAt: new Date().toISOString(), actorType: "agent", actorId: "z" }],
      tasksInReview: 1, blockedTasks: 0, discussionsPendingReview: 0, myTasksDueToday: [],
    },
    isLoading: false,
  }),
}));
vi.mock("../../lib/timeAgo", () => ({ timeAgo: () => "2m ago" }));
vi.mock("../../api/suggestions", () => ({ suggestionsApi: { pending: vi.fn().mockResolvedValue([]), detect: vi.fn(), accept: vi.fn(), dismiss: vi.fn() } }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => ({ openDiscussionCapture: vi.fn() }) }));
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("../../api/dashboard", () => ({
  dashboardApi: { summary: vi.fn().mockResolvedValue({
    costs: { monthSpendCents: 41200, monthBudgetCents: 200000, monthUtilizationPercent: 21 },
    pendingApprovals: 1,
  }) },
  homeApi: { summary: vi.fn() },
}));
vi.mock("../../api/approvals", () => ({
  approvalsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../api/work-questions", () => ({
  workQuestionsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../../api/issues", () => ({
  issuesApi: { list: vi.fn().mockResolvedValue([{ id: "t1", title: "Ship it", status: "in_progress", priority: "high" }]) },
}));
vi.mock("../../hooks/useLiveAgentCount", () => ({ useLiveAgentCount: () => 2 }));
vi.mock("../../api/discussions", () => ({
  discussionsApi: { list: vi.fn().mockResolvedValue({ discussions: [], total: 0, limit: 0, offset: 0 }) },
}));
vi.mock("../../api/memory", () => ({
  memoryApi: { listPending: vi.fn().mockResolvedValue({ items: [], versions: [], archives: [], totalCount: 0 }) },
}));

/** Mirrors HomeBoard.test.tsx's harness (Task D3). */
function HomeBoardHarness({ companyId, role }: { companyId: string; role: UserRole | null }) {
  const boardEdit = useBoardEdit(companyId, role);
  return (
    <>
      <HomeBoardControls boardEdit={boardEdit} role={role} />
      <HomeBoard companyId={companyId} role={role} boardEdit={boardEdit} />
    </>
  );
}

// Plan 7 Task 5: the founder default's curated 8-widget title set, in
// getDefaultLayout("founder") order (suggestions and memory-review dropped
// to tray-only).
const FOUNDER_TITLES = [
  "Waiting on you",
  "Action queue",
  "Objectives",
  "My tasks",
  "Discussions",
  "Today's activity",
  "Agents working now",
  "Budget",
];

describe("HomeBoard a11y contract sweep (Plan 4 Task 4)", () => {
  beforeEach(() => {
    homeBoardLayoutMock.saveAsync.mockReset().mockResolvedValue({ layout: [], schemaVersion: 1 });
    homeBoardLayoutMock.reset.mockReset();
    containerWidthMock.width = 1024;
  });

  describe("non-edit mode", () => {
    it("the board container is a labeled landmark", async () => {
      renderWithProviders(<HomeBoardHarness companyId="co-1" role="founder" />);
      expect(await screen.findByText("Ship it")).toBeInTheDocument();

      expect(screen.getByRole("region", { name: "Home widget board" })).toBeInTheDocument();
    });

    it("every widget's header is an accessible link labeled 'Open {title}', one per registered title", async () => {
      renderWithProviders(<HomeBoardHarness companyId="co-1" role="founder" />);
      expect(await screen.findByText("Ship it")).toBeInTheDocument();

      for (const title of FOUNDER_TITLES) {
        const link = screen.getByRole("link", { name: `Open ${title}` });
        expect(link).toBeInTheDocument();
      }
      expect(screen.getAllByRole("link", { name: /^Open / })).toHaveLength(FOUNDER_TITLES.length);
    });
  });

  describe("edit mode", () => {
    // Plan 7 Task 3 (P1-1): "Customize board" now opens a dropdown instead
    // of entering edit mode directly — an extra "Rearrange tiles" selection
    // is needed to actually enter edit mode.
    async function renderAndEnterEdit() {
      renderWithProviders(<HomeBoardHarness companyId="co-1" role="founder" />);
      expect(await screen.findByText("Ship it")).toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Customize board" }));
      await user.click(await screen.findByRole("menuitem", { name: "Rearrange tiles" }));
      return user;
    }

    it("every tile is focusable (tabIndex=0) with a descriptive aria-label (title + position/size)", async () => {
      await renderAndEnterEdit();

      for (const title of FOUNDER_TITLES) {
        const tile = screen.getByRole("group", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} tile, column \\d+, row \\d+, size \\d+ by \\d+$`) });
        expect(tile).toHaveAttribute("tabindex", "0");
      }
    });

    it("every tile has a remove control labeled 'Remove {title}', one per registered title", async () => {
      await renderAndEnterEdit();

      for (const title of FOUNDER_TITLES) {
        expect(screen.getByRole("button", { name: `Remove ${title}` })).toBeInTheDocument();
      }
      expect(screen.getAllByLabelText(/^Remove /)).toHaveLength(FOUNDER_TITLES.length);
    });

    it("the add-widget tray is a labeled menu whose items are labeled buttons", async () => {
      const user = await renderAndEnterEdit();

      // Founder default already has Budget on the board, so the tray would
      // exclude it — remove it FIRST, before opening the dropdown. (Radix
      // DropdownMenu is modal by default: once open, it marks the rest of
      // the page aria-hidden, so "Remove Budget" elsewhere on the page would
      // no longer be reachable by role if we opened the dropdown first.)
      await user.click(screen.getByRole("button", { name: "Remove Budget" }));

      await user.click(screen.getByRole("button", { name: "Add widget" }));
      const tray = await screen.findByRole("menu", { name: "Add widget" });
      expect(within(tray).getByRole("button", { name: "Budget" })).toBeInTheDocument();
    });

    it("the aria-live region exists before any interaction, updates on a keyboard move, and focus is retained", async () => {
      const user = await renderAndEnterEdit();

      // Exists (mounted unconditionally) even before the first keyboard op.
      const liveRegion = screen.getByRole("status");
      expect(liveRegion).toHaveAttribute("aria-live", "polite");
      expect(liveRegion).toHaveTextContent("");

      const tile = screen.getByRole("group", { name: /^Budget/ });
      tile.focus();
      expect(tile).toHaveFocus();

      await user.keyboard("{ArrowRight}");

      expect(liveRegion).toHaveTextContent(/Budget moved to column \d+, row \d+/);
      // Same tile (re-queried by its now-updated label) retains focus after
      // the move — an assistive-tech user doesn't lose their place.
      const movedTile = screen.getByRole("group", { name: /^Budget/ });
      expect(movedTile).toBe(tile);
      expect(movedTile).toHaveFocus();
    });
  });
});
