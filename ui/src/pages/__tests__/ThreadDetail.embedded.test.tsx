/**
 * ThreadDetail — prop-id + embedded chrome-gating (D2, Inbox Hub).
 *
 * Verifies the D2 refactor that lets ThreadDetail be hosted inside a hub tab:
 *   1. `<ThreadDetail discussionId="d1" embedded/>` resolves the thread by PROP,
 *      not `useParams` (useParams returns nothing here).
 *   2. When `embedded`, the page chrome setters (setBreadcrumbs) are NOT called
 *      — the host owns the breadcrumbs (mirrors the left-rail `!embedded` gate).
 *   3. Route mode (no prop, `useParams` supplies the id) STILL sets breadcrumbs.
 *
 * Mirrors the useParams mock pattern from DiscussionDetail.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../__tests__/test-utils";
import { ThreadDetail } from "../ThreadDetail";

// --- Minimal thread the detail query resolves. Only the fields the render
//     path touches need to be present; the rest are permissive. ---
function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    title: "Prop-hosted Thread",
    status: "active",
    phase: "discuss",
    subtype: "normal",
    scopeType: null,
    scopeName: null,
    crewPaused: false,
    autonomyLevel: null,
    ownerUserId: "user-1",
    pendingItemCount: 0,
    summaryText: null,
    summaryNext: null,
    lastError: null,
    consecutiveCommitFailures: 0,
    derivedStage: null,
    visibility: "private",
    shareToken: null,
    participants: [],
    allowMemoryExtraction: true,
    entries: [],
    ...overrides,
  };
}

// --- Mocks ---

const detailMock = vi.fn();
vi.mock("../../api/threads", () => ({
  threadsApi: new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "detail") return detailMock;
        // Every other threadsApi method is a resolved no-op for this suite.
        return vi.fn().mockResolvedValue({ versions: [] });
      },
    },
  ),
}));

// `useParams` returns NOTHING — proves the embedded render reads the prop id,
// never the route. The route-mode test overrides this per-test.
const useParamsMock = vi.fn(() => ({}) as Record<string, string | undefined>);
vi.mock("@/lib/router", async () => {
  const actual = (await vi.importActual("react-router-dom")) as any;
  return {
    ...actual,
    useParams: () => useParamsMock(),
    Link: actual.Link,
  };
});

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "comp-1" }),
}));

const setBreadcrumbsSpy = vi.fn();
const setSubtitleSpy = vi.fn();
const setEntityColorSpy = vi.fn();
vi.mock("../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: setBreadcrumbsSpy,
    setSubtitle: setSubtitleSpy,
    setEntityColor: setEntityColorSpy,
  }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../../context/LiveUpdatesProvider", () => ({
  useLiveUpdates: () => ({
    connectionState: "open" as const,
    subscribeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
    sendPresence: vi.fn(),
    onReconnect: () => () => {},
  }),
}));

// Heavy child panels are stubbed — this suite only exercises ThreadDetail's own
// id resolution + chrome gating, not the sub-viewers.
vi.mock("../../components/threads/ThreadTab", () => ({
  ThreadTab: () => <div data-testid="stub-thread-tab" />,
}));
vi.mock("../../components/threads/ThreadViewer", () => ({
  ThreadViewer: () => <div data-testid="stub-thread-viewer" />,
  ThreadCollapsedTabStrip: () => <div data-testid="stub-collapsed-strip" />,
}));
vi.mock("../../components/threads/ScopeTab", () => ({
  ScopeTab: () => <div data-testid="stub-scope-tab" />,
}));
vi.mock("../../components/threads/BranchesTab", () => ({
  BranchesTab: () => <div data-testid="stub-branches-tab" />,
}));
vi.mock("../../components/threads/ThreadErrorBanner", () => ({
  ThreadErrorBanner: () => <div data-testid="stub-error-banner" />,
}));
vi.mock("../../components/threads/ThreadVisibilityControls", () => ({
  ThreadVisibilityControls: () => <div data-testid="stub-visibility-controls" />,
}));

beforeEach(() => {
  vi.clearAllMocks();
  useParamsMock.mockReturnValue({});
  detailMock.mockResolvedValue(makeThread());
});

describe("ThreadDetail — embedded, prop-supplied id", () => {
  it("renders the thread for the PROP id without reading useParams", async () => {
    renderWithProviders(<ThreadDetail discussionId="d1" embedded />);

    await waitFor(() => {
      // Title renders in both the sr-only <h1> and the visible <h2> header.
      expect(screen.getAllByText("Prop-hosted Thread").length).toBeGreaterThan(0);
    });

    // detail() was called with the PROP id, not a param id.
    expect(detailMock).toHaveBeenCalledWith("comp-1", "d1");
    // useParams returned {} — the render did not depend on it.
    expect(useParamsMock).toHaveBeenCalled();
  });

  it("does NOT set page breadcrumbs/subtitle/entity color when embedded", async () => {
    renderWithProviders(<ThreadDetail discussionId="d1" embedded />);

    await waitFor(() => {
      // Title renders in both the sr-only <h1> and the visible <h2> header.
      expect(screen.getAllByText("Prop-hosted Thread").length).toBeGreaterThan(0);
    });

    expect(setBreadcrumbsSpy).not.toHaveBeenCalled();
    expect(setEntityColorSpy).not.toHaveBeenCalled();
    expect(setSubtitleSpy).not.toHaveBeenCalled();
  });

  it("prefers the companyId prop over CompanyContext", async () => {
    renderWithProviders(<ThreadDetail discussionId="d1" companyId="comp-override" embedded />);

    await waitFor(() => {
      expect(detailMock).toHaveBeenCalledWith("comp-override", "d1");
    });
  });

  it("does not mount the Discussions-owned viewer for a host-dispatched pane", async () => {
    renderWithProviders(
      <ThreadDetail discussionId="d1" companyId="comp-1" embedded onOpenRequest={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("Prop-hosted Thread").length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId("thread-right-viewer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("stub-thread-viewer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mobile-tab-viewer")).not.toBeInTheDocument();
  });

  it("puts the host close action in the native discussion header", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ThreadDetail discussionId="d1" companyId="comp-1" embedded onClose={onClose} />,
    );

    const closeButton = await screen.findByRole("button", { name: "Close discussion focus" });
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ThreadDetail — route mode (no prop)", () => {
  it("resolves the id from useParams and sets breadcrumbs", async () => {
    // Route mode: id comes from the route, chrome IS owned by the page.
    useParamsMock.mockReturnValue({ discussionId: "d1" });

    renderWithProviders(<ThreadDetail />);

    await waitFor(() => {
      // Title renders in both the sr-only <h1> and the visible <h2> header.
      expect(screen.getAllByText("Prop-hosted Thread").length).toBeGreaterThan(0);
    });

    expect(detailMock).toHaveBeenCalledWith("comp-1", "d1");
    expect(setBreadcrumbsSpy).toHaveBeenCalled();
    expect(setEntityColorSpy).toHaveBeenCalled();
  });
});
