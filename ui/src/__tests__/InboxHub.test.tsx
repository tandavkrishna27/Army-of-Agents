import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  HubAutopilotActionsResponse,
  HubAutopilotPolicy,
  HubPreferences,
  NotificationPreferences,
} from "@armyofagents/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { hubItemsApi } from "@/api/hub-items";
import { agentRuntimeDecisionsApi } from "@/api/agent-runtime-decisions";
import { InboxHub, insertOpenedItem, OPENED_ITEM_CACHE_MAX } from "../pages/InboxHub";

const mockPushToast = vi.hoisted(() => vi.fn());
const liveHubItemCallbacks = vi.hoisted(() => new Set<(itemId: string) => void>());

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

/** Test-only SPA navigation buttons: navigate without remounting the router. */
function DeepLinkNav({ targets }: { targets: string[] }) {
  const navigate = useNavigate();
  return (
    <>
      {targets.map((target) => (
        <button key={target} type="button" onClick={() => navigate(target)}>
          nav:{target}
        </button>
      ))}
    </>
  );
}

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Test Co", issuePrefix: "P4" },
  }),
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

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/LiveUpdatesProvider", () => ({
  useLiveUpdates: () => ({
    onHubItemChanged: (cb: (itemId: string) => void) => {
      liveHubItemCallbacks.add(cb);
      return () => liveHubItemCallbacks.delete(cb);
    },
    subscribeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
    sendPresence: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("@/api/hub-items", () => ({
  hubItemsApi: {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null, totalKnown: null }),
    getOne: vi.fn().mockResolvedValue({}),
    counts: vi.fn().mockResolvedValue({ open: 0, unread: 0 }),
    hiddenCount: vi.fn().mockResolvedValue({ hiddenOpen: 0 }),
    markRead: vi.fn().mockResolvedValue({}),
    markUnread: vi.fn().mockResolvedValue({}),
    snooze: vi.fn().mockResolvedValue({}),
    unsnooze: vi.fn().mockResolvedValue({}),
    dismiss: vi.fn().mockResolvedValue({}),
    undismiss: vi.fn().mockResolvedValue({}),
    act: vi.fn().mockResolvedValue({
      item: { id: "hub-1", status: "resolved", version: 2 },
      auditId: "audit-1",
      undoDeadline: "2026-06-29T00:00:08.000Z",
    }),
    undo: vi.fn().mockResolvedValue({
      item: { id: "hub-1", status: "open", version: 1 },
      auditId: "undo-audit-1",
    }),
    bulkAction: vi.fn().mockResolvedValue({
      bulkId: "bulk-1",
      summary: { succeeded: 2, failed: 0, skipped: 0 },
      results: [],
    }),
    audit: vi.fn().mockResolvedValue([]),
    getPreferences: vi.fn().mockResolvedValue(defaultPreferences()),
    updatePreferences: vi.fn().mockResolvedValue(defaultPreferences()),
    autopilotPolicy: {
      get: vi.fn().mockResolvedValue(defaultAutopilotPolicy()),
      update: vi.fn().mockResolvedValue(defaultAutopilotPolicy()),
      reset: vi.fn().mockResolvedValue(defaultAutopilotPolicy()),
    },
    autopilotActions: {
      list: vi.fn().mockResolvedValue(defaultAutopilotActions()),
    },
    notificationPreferences: {
      get: vi.fn().mockResolvedValue(defaultNotificationPreferences()),
      update: vi.fn().mockResolvedValue(defaultNotificationPreferences()),
      reset: vi.fn().mockResolvedValue(defaultNotificationPreferences()),
    },
    notificationDigest: {
      list: vi.fn().mockResolvedValue({ items: [] }),
      ack: vi.fn().mockResolvedValue({ acked: 0 }),
    },
  },
}));

vi.mock("@/api/agent-runtime-decisions", () => ({
  agentRuntimeDecisionsApi: {
    detail: vi.fn(),
    answer: vi.fn(),
  },
}));

function renderPage(initialEntry: string, navTargets: string[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        {navTargets.length > 0 ? <DeepLinkNav targets={navTargets} /> : null}
        <Routes>
          <Route path="/:companyPrefix/inbox" element={<><InboxHub /><LocationProbe /></>} />
          <Route path="/:companyPrefix/inbox/new" element={<><InboxHub /><LocationProbe /></>} />
          <Route path="/:companyPrefix/inbox/all" element={<><InboxHub /><LocationProbe /></>} />
          <Route path="/:companyPrefix/inbox/:lane" element={<><InboxHub /><LocationProbe /></>} />
          <Route path="/:companyPrefix/inbox/:lane/:itemId" element={<><InboxHub /><LocationProbe /></>} />
          <Route path="/:companyPrefix/inbox-hub" element={<InboxHub />} />
          <Route path="/:companyPrefix/inbox-hub/:lane" element={<><InboxHub /><LocationProbe /></>} />
          <Route path="/:companyPrefix/inbox-hub/:lane/:itemId" element={<><InboxHub /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Tab-first: useHubTabs persists the open tab set to localStorage per company.
  // JSDOM localStorage survives between tests in a file, so a tab opened by one
  // test would rehydrate into the next and collide (e.g. a "Close <title>" button
  // shadowing a list row). Reset it for clean per-test isolation.
  localStorage.clear();
  liveHubItemCallbacks.clear();
  vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([]));
  // Default getOne is itemId-aware so a tab-first deep link that hydrates an
  // off-list item opens a tab for the RIGHT id (the old reading pane keyed off the
  // reactively-updated list, so a fixed row sufficed; a one-shot openTab does not).
  vi.mocked(hubItemsApi.getOne).mockImplementation(
    async (_companyId, itemId) => hubItem({ id: itemId }),
  );
  vi.mocked(hubItemsApi.counts).mockResolvedValue({ open: 0, unread: 0 });
  vi.mocked(hubItemsApi.hiddenCount).mockResolvedValue({ hiddenOpen: 0 });
  vi.mocked(hubItemsApi.markRead).mockResolvedValue({});
  vi.mocked(hubItemsApi.markUnread).mockResolvedValue({});
  vi.mocked(hubItemsApi.snooze).mockResolvedValue({});
  vi.mocked(hubItemsApi.unsnooze).mockResolvedValue({});
  vi.mocked(hubItemsApi.dismiss).mockResolvedValue({});
  vi.mocked(hubItemsApi.undismiss).mockResolvedValue({});
  vi.mocked(hubItemsApi.act).mockResolvedValue({
    item: { id: "hub-1", status: "resolved", version: 2 },
    auditId: "audit-1",
    undoDeadline: "2026-06-29T00:00:08.000Z",
  } as never);
  vi.mocked(hubItemsApi.undo).mockResolvedValue({
    item: { id: "hub-1", status: "open", version: 1 },
    auditId: "undo-audit-1",
  } as never);
  vi.mocked(hubItemsApi.bulkAction).mockResolvedValue({
    bulkId: "bulk-1",
    summary: { succeeded: 2, failed: 0, skipped: 0 },
    results: [],
  });
  vi.mocked(hubItemsApi.audit).mockResolvedValue([]);
  vi.mocked(hubItemsApi.getPreferences).mockResolvedValue(defaultPreferences());
  vi.mocked(hubItemsApi.updatePreferences).mockResolvedValue(defaultPreferences());
  vi.mocked(hubItemsApi.autopilotPolicy.get).mockResolvedValue(
    defaultAutopilotPolicy(),
  );
  vi.mocked(hubItemsApi.autopilotPolicy.update).mockResolvedValue(
    defaultAutopilotPolicy(),
  );
  vi.mocked(hubItemsApi.autopilotPolicy.reset).mockResolvedValue(
    defaultAutopilotPolicy(),
  );
  vi.mocked(hubItemsApi.autopilotActions.list).mockResolvedValue(
    defaultAutopilotActions(),
  );
  vi.mocked(hubItemsApi.notificationPreferences.get).mockResolvedValue(
    defaultNotificationPreferences(),
  );
  vi.mocked(hubItemsApi.notificationPreferences.update).mockResolvedValue(
    defaultNotificationPreferences(),
  );
  vi.mocked(hubItemsApi.notificationPreferences.reset).mockResolvedValue(
    defaultNotificationPreferences(),
  );
  vi.mocked(hubItemsApi.notificationDigest.list).mockResolvedValue({ items: [] });
  vi.mocked(hubItemsApi.notificationDigest.ack).mockResolvedValue({ acked: 0 });
  vi.mocked(agentRuntimeDecisionsApi.detail).mockResolvedValue(runtimeDecisionDetail());
  vi.mocked(agentRuntimeDecisionsApi.answer).mockResolvedValue(
    runtimeDecisionDetail({ status: "answered", sourceRevision: 4 }),
  );
});

type HubListItem = Awaited<ReturnType<typeof hubItemsApi.list>>["items"][number];

function hubList(items: HubListItem[], nextCursor: string | null = null) {
  return { items, nextCursor, totalKnown: null };
}

function defaultPreferences(overrides: Partial<HubPreferences> = {}): HubPreferences {
  return {
    defaultLanding: "home",
    visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
    groupMode: "auto",
    density: "comfortable",
    showAutopilotEntry: true,
    updatedAt: null,
    ...overrides,
  };
}

function defaultNotificationPreferences(
  overrides: Partial<NotificationPreferences> = {},
): NotificationPreferences {
  return {
    rules: [
      { semanticType: "approval_request", deliveryMode: "realtime", toastEnabled: true },
    ],
    quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
    digest: { enabled: true, cadence: "daily" },
    updatedAt: null,
    ...overrides,
  };
}

function defaultAutopilotPolicy(
  overrides: Partial<HubAutopilotPolicy> = {},
): HubAutopilotPolicy {
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

function defaultAutopilotActions(
  overrides: Partial<HubAutopilotActionsResponse> = {},
): HubAutopilotActionsResponse {
  return {
    items: [],
    ...overrides,
  };
}

function hubItem(overrides: Partial<HubListItem> = {}) {
  return {
    id: "hub-1",
    companyId: "company-1",
    semanticType: "approval_request",
    lane: "waiting_on_you",
    status: "open",
    priority: "normal",
    title: "Approve deployment",
    summary: "Needs your decision",
    sourceType: "approval",
    sourceId: "approval-1",
    ownerUserId: null,
    ownerPool: null,
    claimedByUserId: null,
    claimedAt: null,
    version: 1,
    createdAt: "2026-06-29T10:00:00.000Z",
    updatedAt: "2026-06-29T10:00:00.000Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: null,
    groupLabel: null,
    groupCount: null,
    scopeKey: null,
    slaAt: null,
    ...overrides,
  } as HubListItem;
}

function runtimeDecisionDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision-1",
    hubItemId: "hub-runtime",
    companyId: "company-1",
    agentId: "agent-1",
    runId: "run-1",
    adapterType: "codex_local",
    adapterSessionId: "session-1",
    kind: "permission",
    status: "shown",
    sourceRevision: 3,
    nonce: "nonce-1",
    title: "Allow command?",
    summary: "Run tests",
    promptText: "Run pnpm test:run?",
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
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as never;
}

describe("InboxHub page", () => {
  it("renders the hub at the canonical /inbox route", async () => {
    renderPage("/P4/inbox");

    expect(await screen.findByText(/Autopilot/i)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /hub lanes/i })).toBeInTheDocument();
  });

  it("maps legacy /inbox/new to the active waiting hub view", async () => {
    renderPage("/P4/inbox/new");

    await screen.findByRole("navigation", { name: /hub lanes/i });
    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenLastCalledWith("company-1", {
        lane: "waiting_on_you",
        status: "open",
        groupMode: "auto",
        limit: 50,
      });
    });
  });

  it("maps legacy /inbox/all to a route-backed all/history view", async () => {
    renderPage("/P4/inbox/all");

    await screen.findByRole("navigation", { name: /hub lanes/i });
    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenLastCalledWith("company-1", {
        lane: "waiting_on_you",
        status: "resolved",
        groupMode: "auto",
        limit: 50,
      });
    });
  });

  it("redirects old /inbox-hub deep links to canonical /inbox links and preserves search", async () => {
    renderPage("/P4/inbox-hub/waiting/hub-1?q=approval&status=archived");

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/P4/inbox/waiting/hub-1?q=approval&status=archived",
      );
    });
  });

  it("writes canonical /inbox paths when lanes and items are selected", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([hubItem()]));

    renderPage("/P4/inbox");

    const laneNav = await screen.findByRole("navigation", { name: /hub lanes/i });
    fireEvent.click(within(laneNav).getByRole("button", { name: /waiting on you/i }));
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/P4/inbox/waiting");
    });

    fireEvent.click(await screen.findByRole("button", { name: /approve deployment/i }));
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/P4/inbox/waiting/hub-1");
    });

    // Row-click now also opens a dedicated tab for the item (tab-first).
    expect(
      await screen.findByRole("tab", { name: /approve deployment/i }),
    ).toBeInTheDocument();
  });

  it("answers runtime permission prompts from the hub viewer", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(
      hubList([
        hubItem({
          id: "hub-runtime",
          semanticType: "agent_runtime_decision",
          title: "Allow command?",
          sourceType: "runtime_decision",
          sourceId: "decision-1",
        }),
      ]),
    );

    renderPage("/P4/inbox/waiting/hub-runtime");

    expect(await screen.findByText("Run pnpm test:run?")).toBeInTheDocument();
    // The decision now renders inside a dedicated tab (tab-first), not a preview.
    expect(await screen.findByTestId("hub-runtime-decision-body")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /hub viewer/i })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /allow once/i }));

    await waitFor(() => {
      expect(agentRuntimeDecisionsApi.answer).toHaveBeenCalledWith(
        "company-1",
        "decision-1",
        {
          kind: "permission",
          decision: "allow_once",
          expectedSourceRevision: 3,
          nonce: "nonce-1",
        },
      );
    });
  });

  it("submits runtime work-question answers from the hub viewer", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(
      hubList([
        hubItem({
          id: "hub-runtime",
          semanticType: "agent_runtime_decision",
          title: "Need product answer",
          sourceType: "runtime_decision",
          sourceId: "decision-1",
        }),
      ]),
    );
    vi.mocked(agentRuntimeDecisionsApi.detail).mockResolvedValue(
      runtimeDecisionDetail({
        kind: "work_question",
        title: "Need product answer",
        promptText: "Which segment should we prioritize?",
      }),
    );

    renderPage("/P4/inbox/waiting/hub-runtime");

    // The decision now renders inside a dedicated tab (tab-first), not a preview.
    expect(await screen.findByTestId("hub-runtime-decision-body")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /hub viewer/i })).toBeNull();
    await userEvent.type(
      await screen.findByRole("textbox", { name: /work question answer/i }),
      "Founder-led SaaS teams.",
    );
    await userEvent.click(screen.getByRole("button", { name: /send answer/i }));

    await waitFor(() => {
      expect(agentRuntimeDecisionsApi.answer).toHaveBeenCalledWith(
        "company-1",
        "decision-1",
        {
          kind: "work_question",
          answer: { text: "Founder-led SaaS teams." },
          expectedSourceRevision: 3,
          nonce: "nonce-1",
        },
      );
    });
  });

  it("disables runtime decision actions after the prompt expires", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(
      hubList([
        hubItem({
          id: "hub-runtime",
          semanticType: "agent_runtime_decision",
          title: "Allow command?",
          sourceType: "runtime_decision",
          sourceId: "decision-1",
        }),
      ]),
    );
    vi.mocked(agentRuntimeDecisionsApi.detail).mockResolvedValue(
      runtimeDecisionDetail({ status: "expired" }),
    );

    renderPage("/P4/inbox/waiting/hub-runtime");

    // The decision now renders inside a dedicated tab (tab-first), not a preview.
    expect(await screen.findByTestId("hub-runtime-decision-body")).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /hub viewer/i })).toBeNull();
    expect(await screen.findByRole("button", { name: /allow once/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /deny/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /allow always/i })).toBeNull();
    expect(screen.getByText("expired")).toBeInTheDocument();
  });

  it("renders Home by default", async () => {
    renderPage("/P4/inbox-hub");

    expect(await screen.findByText(/Autopilot/i)).toBeInTheDocument();
  });

  it("fetches a waiting-lane preview on Home and surfaces it as 'Needs you most'", async () => {
    // On Home (no active lane) the lane list query is disabled; the dedicated
    // home-preview fetch must fill the "Needs you most" card.
    vi.mocked(hubItemsApi.list).mockImplementation(async (_cid, opts) =>
      opts?.lane === "waiting_on_you" && opts?.limit === 5
        ? hubList([hubItem({ id: "hub-needs", title: "Decide the deployment" })])
        : hubList([]),
    );

    renderPage("/P4/inbox-hub");

    // The preview page is requested with the stable HOME_PREVIEW_OPTIONS.
    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenCalledWith("company-1", {
        lane: "waiting_on_you",
        status: "open",
        limit: 5,
      });
    });
    // Its top item appears in the "Needs you most" card (no longer the empty copy).
    const needsYouMostHeading = await screen.findByText("Needs you most");
    const needsYouMostCard = needsYouMostHeading.closest("section");
    expect(needsYouMostCard).not.toBeNull();
    expect(within(needsYouMostCard as HTMLElement).getByText("Decide the deployment")).toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing needs attention right now/i),
    ).not.toBeInTheDocument();
  });

  it("does not fetch the Home preview once a lane is active", async () => {
    renderPage("/P4/inbox-hub/waiting");

    await screen.findByRole("navigation", { name: /hub lanes/i });
    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenCalled();
    });
    // Every list call on the waiting lane uses limit 50 — the home preview
    // (limit 5) query must stay disabled outside Home.
    expect(hubItemsApi.list).not.toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("bridges realtime hub item changes to hydrated toasts", async () => {
    vi.mocked(hubItemsApi.getOne).mockResolvedValue(
      hubItem({ title: "Authorized row title", version: 7 }),
    );
    renderPage("/P4/inbox");

    await screen.findByText(/Autopilot/i);
    await waitFor(() => expect(liveHubItemCallbacks.size).toBe(1));
    await act(async () => {
      for (const cb of liveHubItemCallbacks) cb("hub-1");
    });

    await waitFor(() => {
      expect(hubItemsApi.getOne).toHaveBeenCalledWith("company-1", "hub-1");
      expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({
        dedupeKey: "hub:company-1:hub-1:7",
        title: "Authorized row title",
      }));
    });
  });

  it("does not bridge hub item changes to toasts before notification preferences load", async () => {
    let resolvePreferences: (preferences: NotificationPreferences) => void = () => {};
    vi.mocked(hubItemsApi.notificationPreferences.get).mockReturnValue(
      new Promise<NotificationPreferences>((resolve) => {
        resolvePreferences = resolve;
      }),
    );
    vi.mocked(hubItemsApi.getOne).mockResolvedValue(
      hubItem({ title: "Early event title", version: 3 }),
    );
    renderPage("/P4/inbox");

    await screen.findByText(/Autopilot/i);
    await waitFor(() => expect(liveHubItemCallbacks.size).toBe(1));
    await act(async () => {
      for (const cb of liveHubItemCallbacks) cb("hub-1");
    });

    expect(hubItemsApi.getOne).not.toHaveBeenCalledWith("company-1", "hub-1");
    expect(mockPushToast).not.toHaveBeenCalled();

    await act(async () => {
      resolvePreferences(defaultNotificationPreferences());
    });
  });

  it("does not toast digest-mode hub item changes", async () => {
    vi.mocked(hubItemsApi.notificationPreferences.get).mockResolvedValue(
      defaultNotificationPreferences({
        rules: [
          { semanticType: "approval_request", deliveryMode: "digest", toastEnabled: true },
        ],
      }),
    );
    renderPage("/P4/inbox");

    await screen.findByText(/Autopilot/i);
    await waitFor(() => expect(liveHubItemCallbacks.size).toBe(1));
    await act(async () => {
      for (const cb of liveHubItemCallbacks) cb("hub-1");
    });

    await waitFor(() => expect(hubItemsApi.getOne).toHaveBeenCalledWith("company-1", "hub-1"));
    expect(mockPushToast).not.toHaveBeenCalled();
  });

  it("undoes a recent Autopilot action from Home", async () => {
    const user = userEvent.setup();
    vi.mocked(hubItemsApi.autopilotPolicy.get).mockResolvedValue(
      defaultAutopilotPolicy({ mode: "drive", handledToday: 1 }),
    );
    vi.mocked(hubItemsApi.autopilotActions.list).mockResolvedValue(
      defaultAutopilotActions({
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
    );
    renderPage("/P4/inbox");

    await user.click(
      await screen.findByRole("button", { name: /undo autopilot action finished run/i }),
    );

    await waitFor(() => {
      expect(hubItemsApi.undo).toHaveBeenCalledWith("company-1", "hub-1", {
        auditId: "audit-1",
        expectedVersion: 3,
      });
    });
  });

  it("maps the waiting slug to the waiting_on_you API lane with the preview limit", async () => {
    renderPage("/P4/inbox-hub/waiting");

    await screen.findByRole("navigation", { name: /hub lanes/i });
    await waitFor(() => {
      expect(vi.mocked(hubItemsApi.list)).toHaveBeenCalledWith("company-1", {
        lane: "waiting_on_you",
        status: "open",
        groupMode: "auto",
        limit: 50,
      });
    });
  });

  it("marks an unread row read only once even if it is clicked repeatedly", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([hubItem()]));

    renderPage("/P4/inbox-hub/waiting");

    const row = await screen.findByRole("button", { name: /approve deployment/i });
    fireEvent.click(row);
    fireEvent.click(row);

    await waitFor(() => {
      expect(hubItemsApi.markRead).toHaveBeenCalledTimes(1);
    });
  });

  it("optimistically clears the unread indicator on click (infinite-query paged cache)", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([hubItem()]));
    // Hold markRead unresolved so we observe the OPTIMISTIC list update before any
    // server settle/refetch — this exercises the `{ pages: [...] }` cache branch.
    let resolveMarkRead: (() => void) | undefined;
    vi.mocked(hubItemsApi.markRead).mockImplementation(
      () =>
        new Promise((res) => {
          resolveMarkRead = () => res({} as never);
        }),
    );

    renderPage("/P4/inbox-hub/waiting");

    const row = await screen.findByRole("button", { name: /approve deployment/i });
    expect(screen.getByLabelText("Unread")).toBeInTheDocument();

    fireEvent.click(row);

    // The optimistic setQueriesData must reach the paged list cache and re-derive
    // `items`, removing the unread dot — if the `{pages}` branch no-ops this fails.
    await waitFor(() => {
      expect(screen.queryByLabelText("Unread")).not.toBeInTheDocument();
    });

    resolveMarkRead?.();
  });

  // Tab-first: these actions now live in the standalone HubActionBar mounted
  // above each item tab body, not in the deleted reading-pane HubViewer footer.
  it("viewer can mark a selected read item unread", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([
      hubItem({ readAt: "2026-06-29T10:01:00.000Z" }),
    ]));

    renderPage("/P4/inbox-hub/waiting/hub-1");

    fireEvent.click(await screen.findByRole("button", { name: /mark unread/i }));

    await waitFor(() => {
      expect(hubItemsApi.markUnread).toHaveBeenCalledWith("company-1", "hub-1");
    });
  });

  it("viewer can dismiss and snooze the selected item", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([hubItem()]));

    renderPage("/P4/inbox-hub/waiting/hub-1");

    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));
    fireEvent.click(await screen.findByRole("button", { name: /snooze/i }));

    await waitFor(() => {
      expect(hubItemsApi.dismiss).toHaveBeenCalledWith("company-1", "hub-1");
      expect(hubItemsApi.snooze).toHaveBeenCalledWith(
        "company-1",
        "hub-1",
        expect.stringMatching(/T/),
      );
    });
  });

  it("targets the selected hub row when multiple rows map to the same entity tab", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(
      hubList([
        hubItem({
          id: "hub-mention-1",
          semanticType: "mention",
          lane: "notifications",
          sourceType: "discussion",
          sourceId: "thread-1:entry-1:user-1",
          title: "First mention",
        }),
        hubItem({
          id: "hub-mention-2",
          semanticType: "mention",
          lane: "notifications",
          sourceType: "discussion",
          sourceId: "thread-1:entry-2:user-2",
          title: "Second mention",
        }),
      ]),
    );

    renderPage("/P4/inbox-hub/notifications");

    fireEvent.click(await screen.findByRole("button", { name: /second mention/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^dismiss$/i }));

    await waitFor(() => {
      expect(hubItemsApi.dismiss).toHaveBeenCalledWith("company-1", "hub-mention-2");
    });
  });

  it("viewer can undo personal dismiss and snooze actions", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([hubItem()]));

    renderPage("/P4/inbox-hub/waiting/hub-1");

    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));
    fireEvent.click(await screen.findByRole("button", { name: /undo dismiss/i }));
    fireEvent.click(await screen.findByRole("button", { name: /snooze/i }));
    fireEvent.click(await screen.findByRole("button", { name: /undo snooze/i }));

    await waitFor(() => {
      expect(hubItemsApi.undismiss).toHaveBeenCalledWith("company-1", "hub-1");
      expect(hubItemsApi.unsnooze).toHaveBeenCalledWith("company-1", "hub-1");
    });
  });

  it("viewer resolves an item and can undo the server-backed action", async () => {
    // Use a NON-mirrored notifications-lane type: the mirror model (Task 1)
    // hides Resolve/Archive on source-backed decision items (approval_request),
    // so the generic resolve→undo flow is exercised on run_failed instead.
    vi.mocked(hubItemsApi.list).mockResolvedValue(
      hubList([hubItem({ semanticType: "run_failed", lane: "notifications", ownerPool: null })]),
    );

    renderPage("/P4/inbox-hub/notifications/hub-1");

    fireEvent.click(await screen.findByRole("button", { name: /^resolve$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /undo resolve/i }));

    await waitFor(() => {
      expect(hubItemsApi.act).toHaveBeenCalledWith("company-1", "hub-1", {
        action: "resolve",
        expectedVersion: 1,
      });
      expect(hubItemsApi.undo).toHaveBeenCalledWith("company-1", "hub-1", {
        auditId: "audit-1",
        expectedVersion: 2,
      });
    });
  });

  it("keeps server undo reachable after the resolved item leaves the active list", async () => {
    // Non-mirrored type (see above): Resolve stays available on run_failed.
    vi.mocked(hubItemsApi.list)
      .mockResolvedValueOnce(
        hubList([hubItem({ semanticType: "run_failed", lane: "notifications", ownerPool: null })]),
      )
      .mockResolvedValue(hubList([]));

    renderPage("/P4/inbox-hub/notifications/hub-1");

    fireEvent.click(await screen.findByRole("button", { name: /^resolve$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /undo resolve/i }));

    await waitFor(() => {
      expect(hubItemsApi.undo).toHaveBeenCalledWith("company-1", "hub-1", {
        auditId: "audit-1",
        expectedVersion: 2,
      });
    });
  });

  it("viewer shows claim and release actions for board-pool items", async () => {
    // Claim/Release live in HubActionBar for board-pool items.
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([
      hubItem({ semanticType: "stale_work", lane: "suggestions", ownerPool: "board" }),
    ]));

    renderPage("/P4/inbox-hub/suggestions/hub-1");

    fireEvent.click(await screen.findByRole("button", { name: /^claim$/i }));

    await waitFor(() => {
      expect(hubItemsApi.act).toHaveBeenCalledWith("company-1", "hub-1", {
        action: "claim",
        expectedVersion: 1,
      });
    });
  });

  it("history controls request resolved and archived items inside the active lane", async () => {
    renderPage("/P4/inbox-hub/waiting");

    fireEvent.click(await screen.findByRole("button", { name: /^resolved$/i }));

    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenLastCalledWith("company-1", {
        lane: "waiting_on_you",
        status: "resolved",
        groupMode: "auto",
        limit: 50,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /^archived$/i }));

    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenLastCalledWith("company-1", {
        lane: "waiting_on_you",
        status: "archived",
        groupMode: "auto",
        limit: 50,
      });
    });
  });

  // TASK 5 (deferred): the history reading pane (item heading + audit timeline for
  // resolved/archived items) was HubViewer chrome, deleted in tab-first. Its
  // replacement is a per-entity tab body / dedicated history viewer (Task 5). The
  // two tests below are skipped until that viewer lands.
  it.skip("opens resolved and archived history items in the viewer", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([
      hubItem({
        id: "history-1",
        status: "resolved",
        title: "Resolved approval",
        readAt: "2026-06-29T10:01:00.000Z",
      }),
    ]));

    renderPage("/P4/inbox-hub/waiting/history-1");
    fireEvent.click(await screen.findByRole("button", { name: /^resolved$/i }));

    expect(await screen.findByRole("heading", { name: /resolved approval/i })).toBeInTheDocument();
  });

  it.skip("loads an audit timeline for the selected history item", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([
      hubItem({
        id: "history-1",
        status: "archived",
        title: "Archived notification",
        readAt: "2026-06-29T10:01:00.000Z",
      }),
    ]));
    vi.mocked(hubItemsApi.audit).mockResolvedValue([
      {
        id: "audit-1",
        companyId: "company-1",
        hubItemId: "history-1",
        actorType: "user",
        actorId: "user-1",
        action: "archive",
        authorityBasis: "founder",
        reason: "No longer needed",
        undoDeadline: null,
        createdAt: "2026-06-29T10:03:00.000Z",
      },
    ]);

    renderPage("/P4/inbox-hub/waiting/history-1");
    fireEvent.click(await screen.findByRole("button", { name: /^archived$/i }));

    await waitFor(() => {
      expect(hubItemsApi.audit).toHaveBeenCalledWith("company-1", "history-1");
    });
    const auditTimeline = await screen.findByRole("region", { name: /audit timeline/i });
    expect(within(auditTimeline).getByText(/^archive$/i)).toBeInTheDocument();
    expect(within(auditTimeline).getByText(/No longer needed/i)).toBeInTheDocument();
    expect(within(auditTimeline).getByText(/user-1/i)).toBeInTheDocument();
  });

  it("bulk archives selected open items with optimistic versions", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([
      hubItem({ id: "hub-1", title: "First approval", version: 1 }),
      hubItem({ id: "hub-2", title: "Second approval", version: 3 }),
    ]));

    renderPage("/P4/inbox-hub/waiting");

    fireEvent.click(await screen.findByRole("checkbox", { name: /select first approval/i }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /select second approval/i }));
    fireEvent.click(await screen.findByRole("button", { name: /archive selected/i }));

    await waitFor(() => {
      expect(hubItemsApi.bulkAction).toHaveBeenCalledWith("company-1", {
        items: [
          { id: "hub-1", action: "archive", expectedVersion: 1 },
          { id: "hub-2", action: "archive", expectedVersion: 3 },
        ],
      });
    });
  });

  it("bulk dismisses selected open items as personal state", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([
      hubItem({ id: "hub-1", title: "Dismiss one" }),
      hubItem({ id: "hub-2", title: "Dismiss two" }),
    ]));

    renderPage("/P4/inbox-hub/waiting");

    fireEvent.click(await screen.findByRole("checkbox", { name: /select dismiss one/i }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /select dismiss two/i }));
    fireEvent.click(await screen.findByRole("button", { name: /dismiss selected/i }));

    await waitFor(() => {
      expect(hubItemsApi.bulkAction).toHaveBeenCalledWith("company-1", {
        items: [
          { id: "hub-1", action: "dismiss" },
          { id: "hub-2", action: "dismiss" },
        ],
      });
    });
  });

  it("shows a compact bulk result summary when one selected item fails", async () => {
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([
      hubItem({ id: "hub-1", title: "Fresh item", version: 1 }),
      hubItem({ id: "hub-2", title: "Changed item", version: 1 }),
    ]));
    vi.mocked(hubItemsApi.bulkAction).mockResolvedValue({
      bulkId: "bulk-partial",
      summary: { succeeded: 1, failed: 1, skipped: 0 },
      results: [
        { id: "hub-1", status: "success" },
        { id: "hub-2", status: "failed", error: { status: 409, message: "Changed elsewhere" } },
      ],
    });

    renderPage("/P4/inbox-hub/waiting");

    fireEvent.click(await screen.findByRole("checkbox", { name: /select fresh item/i }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /select changed item/i }));
    fireEvent.click(await screen.findByRole("button", { name: /archive selected/i }));

    expect(await screen.findByText(/1 succeeded, 1 failed/i)).toBeInTheDocument();
  });

  it("passes search text to the list query", async () => {
    renderPage("/P4/inbox-hub/waiting");

    fireEvent.change(await screen.findByRole("searchbox", { name: /search hub/i }), {
      target: { value: "deploy" },
    });

    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenLastCalledWith("company-1", {
        lane: "waiting_on_you",
        status: "open",
        q: "deploy",
        groupMode: "auto",
        limit: 50,
      });
    });
  });

  it("shows the 'N hidden' chip on the waiting lane and toggles the reveal query", async () => {
    vi.mocked(hubItemsApi.hiddenCount).mockResolvedValue({ hiddenOpen: 2 });
    vi.mocked(hubItemsApi.list).mockResolvedValue(hubList([hubItem()]));

    renderPage("/P4/inbox-hub/waiting");

    // The chip renders from the lane-scoped hidden-count query.
    const chip = await screen.findByRole("button", { name: /2 hidden/i });
    expect(hubItemsApi.hiddenCount).toHaveBeenCalledWith("company-1", "waiting_on_you");

    // Toggling it on re-issues the list query WITH includeDismissed+includeSnoozed.
    fireEvent.click(chip);
    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenLastCalledWith("company-1", {
        lane: "waiting_on_you",
        status: "open",
        groupMode: "auto",
        includeDismissed: true,
        includeSnoozed: true,
        limit: 50,
      });
    });
  });

  it("restores a hidden dismissed row via Undismiss from the revealed list", async () => {
    vi.mocked(hubItemsApi.hiddenCount).mockResolvedValue({ hiddenOpen: 1 });
    // First page (open only) is empty; once revealed, the dismissed row appears.
    vi.mocked(hubItemsApi.list).mockImplementation(async (_cid, opts) =>
      opts?.includeDismissed
        ? hubList([hubItem({ id: "hub-hidden", title: "Hidden approval", dismissedAt: "2026-07-01T00:00:00.000Z" })])
        : hubList([]),
    );

    renderPage("/P4/inbox-hub/waiting");

    fireEvent.click(await screen.findByRole("button", { name: /1 hidden/i }));

    // The revealed row shows a dismissed badge + an Undismiss action.
    expect(await screen.findByText("dismissed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /undismiss/i }));

    await waitFor(() => {
      expect(hubItemsApi.undismiss).toHaveBeenCalledWith("company-1", "hub-hidden");
    });
  });

  it("does not fetch the hidden count outside the waiting lane", async () => {
    renderPage("/P4/inbox-hub/notifications");

    await screen.findByRole("navigation", { name: /hub lanes/i });
    // Give effects a tick; the waiting-only query must stay disabled.
    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenCalled();
    });
    expect(hubItemsApi.hiddenCount).not.toHaveBeenCalled();
  });

  it("loads the next cursor page", async () => {
    vi.mocked(hubItemsApi.list)
      .mockResolvedValueOnce(hubList([hubItem({ id: "hub-1", title: "First approval" })], "cursor-2"))
      .mockResolvedValueOnce(hubList([hubItem({ id: "hub-2", title: "Second approval" })]));

    renderPage("/P4/inbox-hub/waiting");

    fireEvent.click(await screen.findByRole("button", { name: /load more/i }));

    await waitFor(() => {
      expect(hubItemsApi.list).toHaveBeenLastCalledWith("company-1", {
        lane: "waiting_on_you",
        status: "open",
        groupMode: "auto",
        cursor: "cursor-2",
        limit: 50,
      });
    });
    expect(await screen.findByText(/second approval/i)).toBeInTheDocument();
  });

  it("hydrates a second deep-link to a different item in the same SPA session", async () => {
    vi.mocked(hubItemsApi.getOne).mockImplementation(async (_companyId, itemId) =>
      hubItem({
        id: itemId,
        // Distinct sourceId per item → distinct approval-tab keys (a shared
        // sourceId would dedup both deep links onto one tab).
        sourceId: `approval-${itemId}`,
        title: itemId === "hub-a" ? "Deep item A" : "Deep item B",
      }),
    );

    renderPage("/P4/inbox/waiting/hub-a", ["/P4/inbox/waiting/hub-b"]);

    // Tab-first: the deep link hydrates the off-list item and OPENS its tab.
    expect(await screen.findByRole("tab", { name: /deep item a/i })).toBeInTheDocument();
    expect(hubItemsApi.getOne).toHaveBeenCalledWith("company-1", "hub-a");

    // SPA navigation (no remount) to a SECOND deep-linked item: a boolean
    // handled-guard makes this second hydration impossible — the guard must be
    // per-itemId.
    fireEvent.click(screen.getByRole("button", { name: "nav:/P4/inbox/waiting/hub-b" }));

    expect(await screen.findByRole("tab", { name: /deep item b/i })).toBeInTheDocument();
    expect(hubItemsApi.getOne).toHaveBeenCalledWith("company-1", "hub-b");
  });

  it("caches a list item's tab so it survives a refetch that drops the row", async () => {
    vi.mocked(hubItemsApi.list)
      .mockResolvedValueOnce(hubList([hubItem({ id: "hub-1", title: "Listed deep item" })]))
      .mockResolvedValue(hubList([]));

    renderPage("/P4/inbox/waiting");

    // Row-click AFTER the list loads → the found-in-list branch caches the row +
    // opens its tab (no getOne fetch).
    fireEvent.click(await screen.findByRole("button", { name: /listed deep item/i }));
    expect(await screen.findByRole("tab", { name: /listed deep item/i })).toBeInTheDocument();
    expect(hubItemsApi.getOne).not.toHaveBeenCalled();

    // Scope change → fresh list query that DROPS the row. The open tab (tab-first)
    // persists independently of the list, so the item stays reachable — and the
    // cached row keeps its tab body resolvable without a getOne refetch.
    fireEvent.click(screen.getByRole("button", { name: /^resolved$/i }));
    await screen.findByText(/no open items in this lane/i);

    expect(screen.getByRole("tab", { name: /listed deep item/i })).toBeInTheDocument();
    expect(hubItemsApi.getOne).not.toHaveBeenCalled();
  });
});

describe("insertOpenedItem (bounded opened-item cache)", () => {
  it("keeps only the most recent OPENED_ITEM_CACHE_MAX entries", () => {
    let cache: Record<string, HubListItem> = {};
    for (let i = 0; i < 30; i += 1) {
      cache = insertOpenedItem(cache, hubItem({ id: `hub-${i}` }));
    }
    expect(Object.keys(cache)).toHaveLength(OPENED_ITEM_CACHE_MAX);
    // 30 inserts, cap 24: hub-0..hub-5 (oldest) evicted, hub-6..hub-29 kept.
    expect(cache["hub-5"]).toBeUndefined();
    expect(cache["hub-6"]).toBeDefined();
    expect(cache["hub-29"]).toBeDefined();
  });

  it("re-inserting the same cached reference is a no-op (no state churn)", () => {
    const row = hubItem({ id: "hub-1" });
    const cache = insertOpenedItem({}, row);
    expect(insertOpenedItem(cache, row)).toBe(cache);
  });

  it("re-inserting an updated row for a cached id refreshes data and recency", () => {
    let cache: Record<string, HubListItem> = {};
    for (let i = 0; i < OPENED_ITEM_CACHE_MAX; i += 1) {
      cache = insertOpenedItem(cache, hubItem({ id: `hub-${i}` }));
    }
    // Refresh the oldest entry, then insert one more: the refreshed entry
    // survives and the now-oldest (hub-1) is evicted instead.
    cache = insertOpenedItem(cache, hubItem({ id: "hub-0", title: "Refreshed" }));
    cache = insertOpenedItem(cache, hubItem({ id: "hub-new" }));
    expect(Object.keys(cache)).toHaveLength(OPENED_ITEM_CACHE_MAX);
    expect(cache["hub-0"]?.title).toBe("Refreshed");
    expect(cache["hub-1"]).toBeUndefined();
    expect(cache["hub-new"]).toBeDefined();
  });
});
