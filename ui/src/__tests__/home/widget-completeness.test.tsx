import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import type { UserRole } from "@armyofagents/shared";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { listWidgets } from "../../components/home/widgets/registry";
import { WidgetErrorBoundary } from "../../components/home/WidgetErrorBoundary";

/**
 * Task 3 Step 2 (Plan 4): a completeness SAFETY NET across every registered
 * widget at once, generically mocked toward "empty" data — on top of (not a
 * replacement for) each widget's own bespoke loading/empty/error tests. Each
 * widget is rendered exactly as HomeBoard itself renders it — wrapped in the
 * same WidgetErrorBoundary — so a widget that throws during render surfaces
 * as the boundary's "This widget couldn't load" fallback instead of an
 * uncaught exception, giving a single, uniform assertion this loop can check
 * for every widget without needing widget-specific markup knowledge.
 *
 * Plan 5: widgets no longer self-hide (`return null`) on empty/loading/error
 * data — the contract tightens from "null OR a titled shell" to "ALWAYS a
 * titled shell" (data, empty state, error, or loading all render INSIDE
 * WidgetShell now), so this loop additionally asserts the widget's heading is
 * present, not just that it didn't throw.
 */
const genericApiSpies = vi.hoisted(() => ({
  dashboardSummary: vi.fn(),
  homeApiSummary: vi.fn(),
  approvalsList: vi.fn(),
  workQuestionsList: vi.fn(),
  issuesList: vi.fn(),
  suggestionsPending: vi.fn(),
  suggestionsDetect: vi.fn(),
  goalsList: vi.fn(),
  memoryCreate: vi.fn(),
  memoryListPending: vi.fn(),
  discussionsList: vi.fn(),
}));

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
// Plan 5: ObjectivesWidget's empty state CTA reads openNewGoal from useDialog
// — omitting it here wouldn't throw (the CTA button just silently fails to
// render, since WidgetEmpty only renders its button when BOTH ctaLabel and
// onCta are truthy), so it would slip past the "no throw" check below without
// ever exercising the real opener. Both openers are mocked so every widget's
// CTA (Objectives' "+ New goal", My tasks' "+ New task") gets a real handler.
vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: vi.fn(), openNewGoal: vi.fn(), openDiscussionCapture: vi.fn() }),
}));
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("../../lib/timeAgo", () => ({ timeAgo: () => "2m ago" }));

// Action queue / Objectives / Today's activity: no data yet — each widget's
// own `!data` guard collapses this to a safe empty render.
vi.mock("../../hooks/useHomeSummary", () => ({
  useHomeSummary: () => ({ data: undefined, isLoading: false, error: null }),
}));
// Agents working now: the hook itself always returns a safe number.
vi.mock("../../hooks/useLiveAgentCount", () => ({ useLiveAgentCount: () => 0 }));

vi.mock("../../api/dashboard", () => ({
  dashboardApi: { summary: genericApiSpies.dashboardSummary },
  homeApi: { summary: genericApiSpies.homeApiSummary },
}));
vi.mock("../../api/approvals", () => ({
  approvalsApi: { list: genericApiSpies.approvalsList },
}));
vi.mock("../../api/work-questions", () => ({
  workQuestionsApi: { list: genericApiSpies.workQuestionsList },
}));
vi.mock("../../api/issues", () => ({
  issuesApi: { list: genericApiSpies.issuesList },
}));
vi.mock("../../api/suggestions", () => ({
  suggestionsApi: {
    pending: genericApiSpies.suggestionsPending,
    detect: genericApiSpies.suggestionsDetect,
    accept: vi.fn(),
    dismiss: vi.fn(),
  },
}));
// Only reachable via SuggestionsWidget's nested (closed-by-default) suggested-
// memory dialog — its queries are `enabled: false` while closed, so these
// exist purely as defensive stubs (matches Dashboard.test.tsx's own pattern).
vi.mock("../../api/goals", () => ({ goalsApi: { list: genericApiSpies.goalsList } }));
vi.mock("../../api/memory", () => ({
  memoryApi: { create: genericApiSpies.memoryCreate, listPending: genericApiSpies.memoryListPending },
}));
vi.mock("../../api/discussions", () => ({
  discussionsApi: { list: genericApiSpies.discussionsList },
}));

const ROLE: UserRole = "founder";

describe("widget completeness: every registered widget survives empty data", () => {
  beforeEach(() => {
    mockCompanyContext.selectedCompanyId = "co-1";
    genericApiSpies.dashboardSummary.mockResolvedValue({
      costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
      pendingApprovals: 0,
    });
    genericApiSpies.homeApiSummary.mockResolvedValue(undefined);
    genericApiSpies.approvalsList.mockResolvedValue([]);
    genericApiSpies.workQuestionsList.mockResolvedValue([]);
    genericApiSpies.issuesList.mockResolvedValue([]);
    genericApiSpies.suggestionsPending.mockResolvedValue([]);
    genericApiSpies.suggestionsDetect.mockResolvedValue({ ok: true });
    genericApiSpies.goalsList.mockResolvedValue([]);
    genericApiSpies.memoryCreate.mockResolvedValue({});
    genericApiSpies.memoryListPending.mockResolvedValue({ items: [], versions: [], archives: [], totalCount: 0 });
    genericApiSpies.discussionsList.mockResolvedValue({ discussions: [], total: 0, limit: 0, offset: 0 });
  });

  for (const def of listWidgets()) {
    it(`${def.key} (${def.title}) always renders a titled shell (never null) on empty data`, async () => {
      const Widget = def.Component;
      renderWithProviders(
        <WidgetErrorBoundary>
          <Widget companyId="co-1" role={ROLE} size={def.defaultSize} />
        </WidgetErrorBoundary>,
      );

      // Flush the mocked (already-resolved) query promises through a real
      // macrotask tick so any post-settle re-render has happened before the
      // assertion below runs.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Never the boundary's fallback (which only renders after a caught
      // throw) — every widget must produce a safe shell.
      // Regex (not an exact string) so this can't silently stop matching on
      // a punctuation/whitespace tweak to WidgetErrorBoundary's copy.
      expect(screen.queryByText(/This widget couldn't load/)).not.toBeInTheDocument();

      // Plan 5: never a blank tile — the widget's titled WidgetShell is
      // always present, whatever data/loading/error state it settled into.
      expect(screen.getByRole("heading", { level: 2, name: def.title })).toBeInTheDocument();
    });
  }

  it("covers all 10 registered widgets (guards against a silently-shrunk registry)", () => {
    expect(listWidgets().map((def) => def.key).sort()).toEqual([
      "action-queue",
      "activity-feed",
      "agents-now",
      "approvals",
      "budget",
      "discussions",
      "memory-review",
      "my-tasks",
      "objectives",
      "suggestions",
    ]);
  });
});
