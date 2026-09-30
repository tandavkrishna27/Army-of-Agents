import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HubShell } from "../HubShell";
import { HOME_TAB } from "../hubViewerModel";
import type { HubItemListRow } from "@/api/hub-items";
import type { HubAutopilotActionsResponse, HubAutopilotPolicy } from "@armyofagents/shared";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Test Co", issuePrefix: "TC" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// react-resizable-panels can't measure size under the JSDOM ResizeObserver stub,
// so (like every other panel-using suite in this repo) mock it with plain divs.
vi.mock("react-resizable-panels", () => ({
  Group: ({ children, ...props }: any) => (
    <div data-testid={props["data-testid"]} role="group">
      {children}
    </div>
  ),
  Panel: ({ children, ...props }: any) => (
    <div data-testid={props["data-testid"]} data-panel-id={props.id}>
      {children}
    </div>
  ),
  Separator: ({ ...props }: any) => <div data-testid={props["data-testid"]} />,
  useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: vi.fn() }),
}));

vi.mock("@/api/agent-runtime-decisions", () => ({
  agentRuntimeDecisionsApi: {
    detail: vi.fn().mockResolvedValue({
      id: "decision-1",
      hubItemId: "hub-runtime",
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      adapterType: "claude_local",
      adapterSessionId: null,
      kind: "permission",
      status: "shown",
      sourceRevision: 2,
      nonce: "nonce-1",
      title: "Allow command?",
      summary: "Run tests",
      promptText: "pnpm test:run",
      toolName: "shell",
      command: "pnpm test:run",
      cwd: "C:/repo",
      path: null,
      networkTarget: null,
      riskClass: "medium",
      options: null,
      timeoutPolicy: "deny",
      expiresAt: null,
      answeredAt: null,
      relayedAt: null,
      relayError: null,
      createdAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z",
    }),
    answer: vi.fn().mockResolvedValue({}),
  },
}));

const items: HubItemListRow[] = [
  {
    id: "hub-1",
    companyId: "company-1",
    semanticType: "approval_request",
    lane: "waiting_on_you",
    status: "open",
    priority: "normal",
    title: "Review hire approval",
    summary: "Scout",
    sourceType: "approval",
    sourceId: "approval-1",
    ownerUserId: "user-1",
    ownerPool: "board",
    version: 0,
    createdAt: "2026-06-29T00:00:00Z",
    updatedAt: "2026-06-29T00:00:00Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: "source:approval",
    groupLabel: "approval",
    groupCount: null,
    scopeKey: null,
    slaAt: null,
  },
];

function renderShell(overrides: Partial<React.ComponentProps<typeof HubShell>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const merged = {
    activeLane: "waiting_on_you" as const,
    items,
    counts: { open: 1, unread: 1 },
    isLoading: false,
    error: null,
    selectedItemId: null as string | null,
    onLaneChange: vi.fn(),
    onSelectItem: vi.fn(),
    onMarkRead: vi.fn(),
    preferences: {
      defaultLanding: "waiting_on_you" as const,
      visibleLanes: ["waiting_on_you", "suggestions"] as ("waiting_on_you" | "notifications" | "suggestions")[],
      groupMode: "auto" as const,
      density: "comfortable" as const,
      showAutopilotEntry: true,
      updatedAt: null,
    },
    ...overrides,
  };
  // The parent (InboxHub) now resolves `selectedItem`; mirror that here so a test
  // that passes `selectedItemId` still gets the Home-tab reading pane.
  const derivedSelectedItem =
    (merged.items ?? items).find((item) => item.id === merged.selectedItemId) ?? null;
  const finalProps = {
    // New tabbed-viewer props default to a Home-only tab set; overridable per test.
    companyId: "company-1" as string | undefined,
    tabs: [HOME_TAB],
    activeTabKey: "home" as string | null,
    selectedItem: derivedSelectedItem,
    onOpenTab: vi.fn(),
    onOpenItem: vi.fn(),
    onCloseTab: vi.fn(),
    onActivateTab: vi.fn(),
    onAddBrowserTab: vi.fn(),
    resolveHubItem: (id: string) => (merged.items ?? items).find((item) => item.id === id),
    ...merged,
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HubShell {...finalProps} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Waiting-lane chip harness: the "N hidden" affordance only surfaces on the
 * waiting lane's OPEN history view, so pin those defaults here and let each test
 * vary hiddenCount / showHidden / handlers.
 */
function chipProps(overrides: Partial<React.ComponentProps<typeof HubShell>> = {}) {
  return {
    activeLane: "waiting_on_you" as const,
    historyStatus: "open" as const,
    items,
    counts: { open: 1, unread: 1 },
    isLoading: false,
    error: null,
    selectedItemId: null as string | null,
    selectedItem: null as HubItemListRow | null,
    companyId: "company-1" as string | undefined,
    tabs: [HOME_TAB],
    activeTabKey: "home" as string | null,
    onLaneChange: vi.fn(),
    onSelectItem: vi.fn(),
    onMarkRead: vi.fn(),
    onOpenTab: vi.fn(),
    onOpenItem: vi.fn(),
    onCloseTab: vi.fn(),
    onActivateTab: vi.fn(),
    onAddBrowserTab: vi.fn(),
    onHistoryStatusChange: vi.fn(),
    resolveHubItem: (id: string) => items.find((item) => item.id === id),
    preferences: {
      defaultLanding: "waiting_on_you" as const,
      visibleLanes: ["waiting_on_you", "notifications", "suggestions"] as (
        | "waiting_on_you"
        | "notifications"
        | "suggestions"
      )[],
      groupMode: "auto" as const,
      density: "comfortable" as const,
      showAutopilotEntry: true,
      updatedAt: null,
    },
    ...overrides,
  } as React.ComponentProps<typeof HubShell>;
}

function chipShell(overrides: Partial<React.ComponentProps<typeof HubShell>> = {}) {
  return <HubShell {...chipProps(overrides)} />;
}

function renderChip(overrides: Partial<React.ComponentProps<typeof HubShell>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{chipShell(overrides)}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function autopilotPolicy(overrides: Partial<HubAutopilotPolicy> = {}): HubAutopilotPolicy {
  return {
    mode: "off",
    handledToday: 0,
    lastHandledAt: null,
    rules: [
      { semanticType: "approval_request", action: "none", minTrustScore: 100, enabled: false },
      { semanticType: "run_complete", action: "none", minTrustScore: 100, enabled: false },
    ],
    updatedAt: null,
    ...overrides,
  };
}

function autopilotActions(
  overrides: Partial<HubAutopilotActionsResponse> = {},
): HubAutopilotActionsResponse {
  return {
    items: [],
    ...overrides,
  };
}

describe("HubShell", () => {
  it("renders rail, lane list, and the Home tab body (tab-first, no reading pane)", () => {
    renderShell();

    const rail = within(screen.getByRole("navigation", { name: /hub lanes/i }));
    // The rail lane button — scoped, since the Home dashboard tab body also
    // renders a "Waiting on you" lane shortcut.
    expect(rail.getByRole("button", { name: /waiting on you/i })).toBeInTheDocument();
    // The lane list row lives in the list panel.
    const list = within(screen.getByTestId("hub-list-panel"));
    expect(list.getByText("Review hire approval")).toBeInTheDocument();
    expect(list.getByText("normal")).toBeInTheDocument();
    // The default Home tab renders the dashboard in the tab body — no reading pane.
    const body = screen.getByTestId("hub-tab-body");
    expect(within(body).getByText(/needs you most/i)).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /hub viewer/i })).toBeNull();
  });

  it("opens AND activates a dedicated tab when a list row is clicked (tab-first)", async () => {
    const user = userEvent.setup();
    const onOpenItem = vi.fn();
    renderShell({ onOpenItem });

    await user.click(screen.getByRole("button", { name: /review hire approval/i }));

    // Row-click opens the item's dedicated tab (HubList prefers onOpenItem).
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: "hub-1" }));
  });

  it("does NOT add a duplicate tab when the same row is clicked twice (ensureTab dedups)", async () => {
    const user = userEvent.setup();
    const onOpenItem = vi.fn();
    renderShell({ onOpenItem });

    const row = screen.getByRole("button", { name: /review hire approval/i });
    await user.click(row);
    await user.click(row);

    // Both clicks call the open handler; dedup + re-activate lives in useHubTabs
    // (openTab → ensureTab), so HubShell just forwards each click. Assert HubShell
    // forwards every click (the dedup contract is proven in the useHubTabs suite,
    // Amendment 2 tab-cap test).
    expect(onOpenItem).toHaveBeenCalledTimes(2);
    expect(onOpenItem).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: "hub-1" }));
    expect(onOpenItem).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: "hub-1" }));
  });

  it("renders the HubHome dashboard as the Home tab body (no reading-pane preview)", () => {
    // The Home tab body is the "Needs you most" dashboard, regardless of any
    // center-list selection — there is no per-item preview surface anymore.
    renderShell({ selectedItemId: "hub-1", tabs: [HOME_TAB], activeTabKey: "home" });

    // The dashboard renders inside the tab body (viewer panel), not the list.
    const body = screen.getByTestId("hub-tab-body");
    expect(within(body).getByText(/needs you most/i)).toBeInTheDocument();
    // No reading-pane chrome: the old "Open full" button + hub-viewer aside are gone.
    expect(within(body).queryByRole("button", { name: /open full/i })).toBeNull();
    expect(screen.queryByRole("complementary", { name: /hub viewer/i })).toBeNull();
  });

  it("renders Home as a three-pane dashboard with a real attention list", () => {
    renderShell({
      activeLane: null,
      items: [],
      homeItems: [{ ...items[0], id: "home-hub-1", title: "Home queue approval" }],
      tabs: [HOME_TAB],
      activeTabKey: "home",
    });

    const listPanel = screen.getByTestId("hub-list-panel");
    expect(screen.getByTestId("hub-panel-group")).toBeInTheDocument();
    expect(listPanel).toBeInTheDocument();
    expect(screen.getByTestId("hub-panel-separator")).toBeInTheDocument();
    expect(screen.queryByTestId("hub-list-home-hint")).toBeNull();
    expect(screen.getByTestId("hub-viewer-panel")).toBeInTheDocument();
    expect(within(listPanel).getByRole("button", { name: /home queue approval/i })).toBeInTheDocument();
    expect(within(screen.getByTestId("hub-tab-body")).getByText(/needs you most/i)).toBeInTheDocument();
  });

  it("keeps the Home lane drawer reachable on mobile", async () => {
    const user = userEvent.setup();
    renderShell({
      activeLane: null,
      homeItems: [{ ...items[0], id: "home-mobile-1", title: "Home mobile queue" }],
      tabs: [HOME_TAB],
      activeTabKey: "home",
    });

    await user.click(screen.getByRole("button", { name: /open hub lanes/i }));
    expect(screen.getByRole("dialog", { name: /hub lanes/i })).toBeInTheDocument();
  });

  it("moves a list highlight with j/k and opens the highlighted item's tab on Enter", async () => {
    const user = userEvent.setup();
    const onSelectItem = vi.fn();
    const onOpenItem = vi.fn();
    renderShell({
      onSelectItem,
      onOpenItem,
      items: [
        { ...items[0], id: "hub-1", title: "First approval" },
        { ...items[0], id: "hub-2", title: "Second approval" },
      ],
    });

    // j/k move the highlight (drives the center-list highlight + URL, NOT a preview).
    await user.keyboard("j");
    expect(onSelectItem).toHaveBeenLastCalledWith("hub-1");
    await user.keyboard("j");
    expect(onSelectItem).toHaveBeenLastCalledWith("hub-2");

    // Enter opens the highlighted row's tab.
    await user.keyboard("{Enter}");
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: "hub-2" }));
  });

  it("Escape clears the list highlight and does NOT close a tab", async () => {
    const user = userEvent.setup();
    const onSelectItem = vi.fn();
    const onCloseTab = vi.fn();
    renderShell({ selectedItemId: "hub-1", onSelectItem, onCloseTab });

    await user.keyboard("{Escape}");

    // Escape clears the highlight (selection) — tabs are untouched.
    expect(onSelectItem).toHaveBeenCalledWith(null);
    expect(onCloseTab).not.toHaveBeenCalled();
  });

  it("mounts the slim action bar above the tab body for the active non-home tab", () => {
    const approvalTab = {
      key: "approval:approval-1",
      kind: "approval" as const,
      title: "Review hire approval",
      closeable: true,
      payload: { approvalId: "approval-1" },
    };
    renderShell({
      selectedItemId: "hub-1",
      tabs: [HOME_TAB, approvalTab],
      activeTabKey: "approval:approval-1",
    });

    const bar = within(screen.getByTestId("hub-action-bar"));
    expect(bar.getByRole("button", { name: /^dismiss$/i })).toBeInTheDocument();
    expect(bar.getByRole("button", { name: /^snooze$/i })).toBeInTheDocument();
    expect(bar.queryByRole("button", { name: /^resolve$/i })).toBeNull();
    expect(bar.getByRole("button", { name: /route or delegate \(coming soon\)/i })).toBeDisabled();
  });

  it("does NOT render the action bar on the Home tab (dashboard is chrome-free)", () => {
    renderShell({ selectedItemId: "hub-1", tabs: [HOME_TAB], activeTabKey: "home" });
    expect(screen.queryByTestId("hub-action-bar")).toBeNull();
  });

  it("hides generic lifecycle actions for runtime decision prompts", async () => {
    const runtimeItem = {
      ...items[0],
      id: "hub-runtime",
      semanticType: "agent_runtime_decision",
      sourceType: "runtime_decision",
      sourceId: "decision-1",
      title: "Allow command?",
      ownerPool: "board",
    } as HubItemListRow;
    const runtimeTab = {
      key: "runtime_decision:hub-runtime",
      kind: "runtime_decision" as const,
      title: "Allow command?",
      closeable: true,
      payload: { hubItemId: "hub-runtime" },
    };
    renderShell({
      items: [runtimeItem],
      selectedItemId: "hub-runtime",
      tabs: [HOME_TAB, runtimeTab],
      activeTabKey: "runtime_decision:hub-runtime",
    });

    const bar = within(screen.getByTestId("hub-action-bar"));
    expect(bar.queryByRole("button", { name: /^resolve$/i })).toBeNull();
    expect(bar.queryByRole("button", { name: /^archive$/i })).toBeNull();
    expect(bar.queryByRole("button", { name: /^claim$/i })).toBeNull();
    expect(
      await within(screen.getByTestId("hub-runtime-decision-body")).findByRole("button", {
        name: /allow once/i,
      }),
    ).toBeInTheDocument();
  });

  it("hides Resolve/Archive for an open approval_request but keeps dismiss and snooze", () => {
    const approvalTab = {
      key: "approval:approval-1",
      kind: "approval" as const,
      title: "Review hire approval",
      closeable: true,
      payload: { approvalId: "approval-1" },
    };
    renderShell({
      selectedItemId: "hub-1",
      tabs: [HOME_TAB, approvalTab],
      activeTabKey: "approval:approval-1",
    });

    const bar = within(screen.getByTestId("hub-action-bar"));
    expect(bar.queryByRole("button", { name: /^resolve$/i })).toBeNull();
    expect(bar.queryByRole("button", { name: /^archive$/i })).toBeNull();
    expect(bar.getByRole("button", { name: /^dismiss$/i })).toBeInTheDocument();
    expect(bar.getByRole("button", { name: /^snooze$/i })).toBeInTheDocument();
  });

  it("targets the active entity tab item instead of a stale selected row", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const approvalTab = {
      key: "approval:approval-1",
      kind: "approval" as const,
      title: "First approval",
      closeable: true,
      payload: { approvalId: "approval-1" },
    };
    renderShell({
      items: [
        { ...items[0], id: "hub-1", title: "First approval", sourceId: "approval-1" },
        { ...items[0], id: "hub-2", title: "Second approval", sourceId: "approval-2" },
      ],
      selectedItemId: "hub-2",
      tabs: [HOME_TAB, approvalTab],
      activeTabKey: "approval:approval-1",
      onDismiss,
    });

    await user.click(
      within(screen.getByTestId("hub-action-bar")).getByRole("button", {
        name: /^dismiss$/i,
      }),
    );

    expect(onDismiss).toHaveBeenCalledWith("hub-1");
  });

  it("hides Resolve/Archive for an open join_request but keeps dismiss and snooze", () => {
    const joinItem = {
      ...items[0],
      id: "hub-join",
      semanticType: "join_request",
      sourceType: "join_request",
      sourceId: "join-1",
      title: "Join request",
    } as HubItemListRow;
    const joinTab = {
      key: "join_request:join-1",
      kind: "join_request" as const,
      title: "Join request",
      closeable: true,
      payload: { joinRequestId: "join-1" },
    };
    renderShell({
      items: [joinItem],
      selectedItemId: "hub-join",
      tabs: [HOME_TAB, joinTab],
      activeTabKey: "join_request:join-1",
    });

    const bar = within(screen.getByTestId("hub-action-bar"));
    expect(bar.queryByRole("button", { name: /^resolve$/i })).toBeNull();
    expect(bar.queryByRole("button", { name: /^archive$/i })).toBeNull();
    expect(bar.getByRole("button", { name: /^dismiss$/i })).toBeInTheDocument();
    expect(bar.getByRole("button", { name: /^snooze$/i })).toBeInTheDocument();
  });

  it("still offers Resolve/Archive for a non-mirrored notifications item (run_failed)", () => {
    const runItem = {
      ...items[0],
      id: "hub-run",
      semanticType: "run_failed",
      lane: "notifications",
      sourceType: "heartbeat_run",
      sourceId: "run-1",
      title: "Run failed",
      ownerPool: null,
    } as HubItemListRow;
    const runTab = {
      key: "notification:hub-run",
      kind: "notification" as const,
      title: "Run failed",
      closeable: true,
      payload: { hubItemId: "hub-run" },
    };
    renderShell({
      items: [runItem],
      selectedItemId: "hub-run",
      tabs: [HOME_TAB, runTab],
      activeTabKey: "notification:hub-run",
    });

    const bar = within(screen.getByTestId("hub-action-bar"));
    expect(bar.getByRole("button", { name: /^resolve$/i })).toBeInTheDocument();
    expect(bar.getByRole("button", { name: /^archive$/i })).toBeInTheDocument();
  });

  it("hides lanes excluded by preferences", () => {
    renderShell();

    // Scope to the rail: default preferences hide the notifications lane, so the
    // rail must not offer it. (The Home dashboard tab body also renders lane
    // shortcuts gated by the same visibleLanes, so an unscoped query collides.)
    const rail = within(screen.getByRole("navigation", { name: /hub lanes/i }));
    expect(rail.getByRole("button", { name: /waiting on you/i })).toBeInTheDocument();
    expect(rail.queryByRole("button", { name: /notifications/i })).not.toBeInTheDocument();
  });

  it("renders grouped rows with explicit expansion state", () => {
    renderShell({
      items: Array.from({ length: 3 }, (_, index) => ({
        ...items[0],
        id: `hub-${index + 1}`,
        title: `Approval ${index + 1}`,
      })),
    });

    expect(screen.getByRole("button", { name: /3 approval/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("renders curated group summaries in grouped rows", () => {
    renderShell({
      items: Array.from({ length: 3 }, (_, index) => ({
        ...items[0],
        id: `hub-curated-${index + 1}`,
        title: `Approval ${index + 1}`,
        curationGroupSummary: "Three related approvals are waiting for founder review.",
      }) as HubItemListRow),
    });

    expect(screen.getByText("Three related approvals are waiting for founder review.")).toBeInTheDocument();
  });

  // NOTE (Task 1 deviation): "Why you are seeing this" was reading-pane chrome in
  // the deleted HubViewer; the curation-reason surface moves with the item viewers
  // (Task 5 / follow-up). The Home needs-you-most curation coverage below stays.

  it("uses curation reason on Hub Home needs-you-most", () => {
    renderShell({
      activeLane: null,
      items: [
        {
          ...items[0],
          curationReason: "SLA is due in 20 minutes.",
        } as HubItemListRow,
      ],
    });

    expect(screen.getByText("Review hire approval")).toBeInTheDocument();
    expect(screen.getByText("SLA is due in 20 minutes.")).toBeInTheDocument();
  });

  it("no longer renders a hub settings gear (settings live in Settings -> Inbox)", () => {
    renderShell();
    expect(screen.queryByRole("button", { name: /hub settings/i })).toBeNull();
  });

  it("renders live Autopilot status on Hub Home with recent undoable actions", async () => {
    const user = userEvent.setup();
    const onUndoAutopilotAction = vi.fn();
    renderShell({
      activeLane: null,
      autopilotPolicy: autopilotPolicy({ mode: "drive", handledToday: 1 }),
      autopilotActions: autopilotActions({
        items: [
          {
            auditId: "audit-1",
            hubItemId: "hub-1",
            title: "Finished run",
            semanticType: "run_complete",
            action: "resolve",
            autonomyLevel: "drive",
            reason: "Trusted completion",
            decisionContext: {},
            undoDeadline: "2099-01-01T00:00:00.000Z",
            itemStatus: "resolved",
            itemVersion: 3,
            createdAt: "2026-07-01T12:00:00.000Z",
          },
        ],
      }),
      onUndoAutopilotAction,
    });

    expect(screen.getByText("Drive")).toBeInTheDocument();
    expect(screen.getByText(/handled today/i)).toHaveTextContent("1 handled today");
    expect(screen.getByText("Finished run")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /undo autopilot action finished run/i }));
    expect(onUndoAutopilotAction).toHaveBeenCalledWith(expect.objectContaining({ auditId: "audit-1" }));
  });

  it("shows the 'N hidden' chip on the waiting lane only when there are hidden rows", () => {
    const { rerender, container } = renderChip({ hiddenCount: 2 });
    expect(screen.getByRole("button", { name: /2 hidden/i })).toBeInTheDocument();

    // Zero hidden + not revealed → no chip.
    rerender(chipShell({ hiddenCount: 0, showHidden: false }));
    expect(screen.queryByRole("button", { name: /hidden/i })).not.toBeInTheDocument();
    // Silence unused-var lint on container.
    expect(container).toBeTruthy();
  });

  it("does not show the hidden chip outside the waiting lane's open view", () => {
    renderChip({ hiddenCount: 3, activeLane: "notifications" });
    expect(screen.queryByRole("button", { name: /hidden/i })).not.toBeInTheDocument();
  });

  it("toggles the hidden reveal when the chip is clicked", async () => {
    const user = userEvent.setup();
    const onToggleHidden = vi.fn();
    renderChip({ hiddenCount: 1, onToggleHidden });

    await user.click(screen.getByRole("button", { name: /1 hidden/i }));
    expect(onToggleHidden).toHaveBeenCalledTimes(1);
  });

  it("keeps the chip visible (as 'Hide dismissed') while revealed even at zero count", () => {
    renderChip({ hiddenCount: 0, showHidden: true });
    expect(screen.getByRole("button", { name: /hide dismissed/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /hide dismissed/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders a dismissed badge + Undismiss action on a hidden row and calls onUndismiss", async () => {
    const user = userEvent.setup();
    const onUndismiss = vi.fn();
    renderChip({
      hiddenCount: 1,
      showHidden: true,
      onUndismiss,
      items: [{ ...items[0], id: "hub-hidden", dismissedAt: "2026-07-01T00:00:00Z" }],
    });

    expect(screen.getByText("dismissed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /undismiss/i }));
    expect(onUndismiss).toHaveBeenCalledWith("hub-hidden");
  });

  it("renders a snoozed badge + Unsnooze action on a future-snoozed hidden row", async () => {
    const user = userEvent.setup();
    const onUnsnooze = vi.fn();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    renderChip({
      hiddenCount: 1,
      showHidden: true,
      onUnsnooze,
      items: [{ ...items[0], id: "hub-snoozed", snoozedUntil: future }],
    });

    expect(screen.getByText("snoozed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /unsnooze/i }));
    expect(onUnsnooze).toHaveBeenCalledWith("hub-snoozed");
  });

  it("focuses search when slash is pressed outside an editable field", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.keyboard("/");

    expect(screen.getByRole("searchbox", { name: /search hub/i })).toHaveFocus();
  });

  it("does not steal slash key presses from editable fields", async () => {
    const user = userEvent.setup();
    const onSearchTextChange = vi.fn();
    renderShell({ onSearchTextChange });
    const search = screen.getByRole("searchbox", { name: /search hub/i });

    await user.click(search);
    await user.keyboard("/");

    expect(onSearchTextChange).toHaveBeenCalledWith("/");
  });

  it("renders and closes the mobile lane drawer", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: /open hub lanes/i }));

    expect(screen.getByRole("dialog", { name: /hub lanes/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /close hub lanes/i }));

    expect(screen.queryByRole("dialog", { name: /hub lanes/i })).not.toBeInTheDocument();
  });

});
