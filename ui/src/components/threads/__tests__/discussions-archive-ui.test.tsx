/**
 * discussions-archive-ui.test.tsx
 *
 * Task 4.1 — Crew Work-as-Tasks:
 *   1. Sidebar hover-kebab "Archive" on thread rail rows (ThreadLeftRail in ThreadDetail.tsx).
 *   2. Archived column on the discussions board (ThreadBoard.tsx).
 *
 * Covers:
 *   - Hovering a thread row reveals the kebab button.
 *   - Clicking the kebab and then "Archive" calls threadsApi.setStatus(…, 'archived').
 *   - Archived threads render in the "Archived" column on ThreadBoard.
 *   - Active threads do NOT appear in the Archived column.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { ThreadBoard } from "../ThreadBoard";
import type { ThreadListItem } from "../../../api/threads";
import React from "react";

// ── Mock threadsApi ────────────────────────────────────────────────────────────

vi.mock("../../../api/threads", () => ({
  threadsApi: {
    list: vi.fn(),
    detail: vi.fn(),
    setStatus: vi.fn(),
    listLinks: vi.fn().mockResolvedValue({ links: [] }),
  },
}));

vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Test Corp", issuePrefix: "TC" },
  }),
}));

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../../../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
    setSubtitle: vi.fn(),
    setEntityColor: vi.fn(),
  }),
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/router")>(
    "../../../lib/router",
  );
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
      <a href={to}>{children}</a>
    ),
    useNavigate: () => vi.fn(),
    useParams: () => ({ threadId: "thread-1", companyPrefix: "TC" }),
  };
});

// ── Shared factory ─────────────────────────────────────────────────────────────

const makeThread = (overrides: Partial<ThreadListItem> = {}): ThreadListItem => ({
  id: "t-default",
  title: "Default thread",
  status: "active",
  scopeType: null,
  scopeId: null,
  scopeName: null,
  tags: [],
  entryCount: 0,
  pendingItemCount: 0,
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00Z",
  lastEntryAt: null,
  lastEntryInputType: null,
  phase: "discuss",
  visibility: "company",
  ownerUserId: null,
  originSource: null,
  intent: null,
  goalId: null,
  autonomyLevel: null,
  summaryText: null,
  summaryNext: null,
  subtype: "normal",
  shareToken: null,
  participants: [],
  allowMemoryExtraction: true,
  ...overrides,
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 1: ThreadBoard — Archived column
// ══════════════════════════════════════════════════════════════════════════════

describe("ThreadBoard — Archived column", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Archived column header", () => {
    renderWithProviders(
      <ThreadBoard threads={[]} onNewThread={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    expect(screen.getByTestId("archived-column")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });

  it("renders archived threads in the Archived column", () => {
    const archived = [
      makeThread({ id: "a1", title: "Old campaign brief", status: "archived" }),
      makeThread({ id: "a2", title: "Finished roadmap", status: "archived" }),
    ];

    renderWithProviders(
      <ThreadBoard threads={[]} archivedThreads={archived} onNewThread={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    const col = screen.getByTestId("archived-column");
    expect(within(col).getByText("Old campaign brief")).toBeInTheDocument();
    expect(within(col).getByText("Finished roadmap")).toBeInTheDocument();
  });

  it("shows empty message when no archived threads", () => {
    renderWithProviders(
      <ThreadBoard threads={[]} archivedThreads={[]} onNewThread={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    const col = screen.getByTestId("archived-column");
    expect(within(col).getByText(/no archived threads/i)).toBeInTheDocument();
  });

  it("shows archived count in column header", () => {
    const archived = [
      makeThread({ id: "a1", title: "T1", status: "archived" }),
      makeThread({ id: "a2", title: "T2", status: "archived" }),
    ];

    renderWithProviders(
      <ThreadBoard threads={[]} archivedThreads={archived} onNewThread={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    const col = screen.getByTestId("archived-column");
    // Header shows count "2"
    expect(within(col).getByText("2")).toBeInTheDocument();
  });

  it("does NOT show active threads in the Archived column", () => {
    const active = [makeThread({ id: "act1", title: "Active thread" })];
    const archived = [makeThread({ id: "arc1", title: "Archived thread", status: "archived" })];

    renderWithProviders(
      <ThreadBoard threads={active} archivedThreads={archived} onNewThread={vi.fn()} />,
      { initialEntries: ["/TC/discussions"] },
    );

    const col = screen.getByTestId("archived-column");
    expect(within(col).queryByText("Active thread")).not.toBeInTheDocument();
    expect(within(col).getByText("Archived thread")).toBeInTheDocument();
  });

  it("exposes an Unarchive action for archived threads", async () => {
    const user = userEvent.setup();
    const onUnarchiveThread = vi.fn();
    const archived = [
      makeThread({ id: "arc1", title: "Archived thread", status: "archived" }),
    ];

    renderWithProviders(
      <ThreadBoard
        threads={[]}
        archivedThreads={archived}
        onNewThread={vi.fn()}
        onUnarchiveThread={onUnarchiveThread}
      />,
      { initialEntries: ["/TC/discussions"] },
    );

    const col = screen.getByTestId("archived-column");
    await user.click(within(col).getByRole("button", { name: /unarchive archived thread/i }));

    expect(onUnarchiveThread).toHaveBeenCalledWith("arc1");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 2: ThreadDetail ThreadLeftRail — hover-kebab Archive action
// ══════════════════════════════════════════════════════════════════════════════

// We test the left-rail kebab by rendering ThreadDetail (which owns ThreadLeftRail).

import { ThreadDetail } from "../../../pages/ThreadDetail";
import { threadsApi } from "../../../api/threads";
import type { ThreadDetail as ThreadDetailType } from "../../../api/threads";

vi.mock("../../../context/LiveUpdatesProvider", () => ({
  useLiveUpdates: () => ({
    connectionState: "open",
    subscribeThread: vi.fn(),
    unsubscribeThread: vi.fn(),
    sendPresence: vi.fn(),
    onReconnect: () => () => {},
    presenceByThread: {},
    workingAgentsByThread: {},
  }),
}));

vi.mock("../../../api/client", () => ({
  api: {
    get: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../../api/agents", () => ({
  agentsApi: {
    listAoa: vi.fn().mockResolvedValue([]),
  },
}));

const mockDetailThread: ThreadDetailType = {
  id: "thread-1",
  title: "Auth refactor",
  status: "active",
  scopeType: null,
  scopeId: null,
  scopeName: null,
  tags: [],
  entryCount: 0,
  pendingItemCount: 0,
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  entries: [],
  phase: "discuss",
  visibility: "company",
  ownerUserId: null,
  originSource: null,
  intent: null,
  goalId: null,
  autonomyLevel: null,
  summaryText: null,
  summaryNext: null,
  crewPaused: false,
  subtype: "normal",
  shareToken: null,
  participants: [],
  allowMemoryExtraction: true,
};

const mockRailThread: ThreadListItem = makeThread({
  id: "rail-thread-1",
  title: "Rail thread A",
  status: "active",
  phase: "discuss",
});

describe("ThreadLeftRail — hover-kebab Archive action", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // detail returns the current thread
    vi.mocked(threadsApi.detail).mockResolvedValue(mockDetailThread);

    // list returns a rail thread (separate from the detail thread)
    vi.mocked(threadsApi.list).mockResolvedValue({
      discussions: [mockRailThread],
      total: 1,
      limit: 50,
      offset: 0,
    } as never);

    // setStatus succeeds
    vi.mocked(threadsApi.setStatus).mockResolvedValue({} as never);
  });

  it("reveals the kebab button on the rail row", async () => {
    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    // Wait for left rail to populate
    await waitFor(() => {
      expect(screen.getByText("Rail thread A")).toBeInTheDocument();
    });

    // The kebab should exist in DOM (opacity-0 via CSS, but present)
    const kebab = screen.getByTestId("thread-rail-kebab-rail-thread-1");
    expect(kebab).toBeInTheDocument();
  });

  it("clicking Archive in the kebab asks for confirmation before archiving", async () => {
    const user = userEvent.setup();

    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    await waitFor(() => {
      expect(screen.getByText("Rail thread A")).toBeInTheDocument();
    });

    // Open the kebab
    const kebab = screen.getByTestId("thread-rail-kebab-rail-thread-1");
    await user.click(kebab);

    // "Archive" menu item should be visible
    const archiveItem = await screen.findByText("Archive");
    expect(archiveItem).toBeInTheDocument();

    await user.click(archiveItem);

    expect(threadsApi.setStatus).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: /archive thread/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^archive$/i }));

    await waitFor(() => {
      expect(threadsApi.setStatus).toHaveBeenCalledWith(
        "comp-1",
        "rail-thread-1",
        "archived",
      );
    });
  });

  it("archived threads are filtered out of the rail", async () => {
    // Return an archived thread in the list
    vi.mocked(threadsApi.list).mockResolvedValue({
      discussions: [
        makeThread({ id: "arc-1", title: "Old thread (archived)", status: "archived" }),
      ],
      total: 1,
      limit: 50,
      offset: 0,
    } as never);

    renderWithProviders(<ThreadDetail />, {
      initialEntries: ["/TC/discussions/thread-1"],
    });

    // The detail still loads
    await waitFor(() => {
      expect(screen.getByTestId("thread-detail")).toBeInTheDocument();
    });

    // The archived thread should NOT appear in the left rail
    expect(screen.queryByText("Old thread (archived)")).not.toBeInTheDocument();
  });
});
