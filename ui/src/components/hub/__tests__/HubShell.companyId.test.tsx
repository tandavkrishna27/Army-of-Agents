import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HubItemListRow } from "@/api/hub-items";
import { HOME_TAB, threadTab } from "../hubViewerModel";

// D2-review seam guard: an embedded ThreadDetail with an UNDEFINED companyId
// falls back to context (undefined on the Inbox route) → its query stays disabled
// → the tab shows a skeleton forever. So the shell MUST forward a concrete
// companyId into the tab body. Capture ThreadDetail's props to prove it.
vi.mock("@/pages/ThreadDetail", () => ({
  ThreadDetail: (props: { companyId?: string; discussionId?: string; embedded?: boolean }) => (
    <div
      data-testid="thread-detail-stub"
      data-company-id={String(props.companyId)}
      data-discussion-id={String(props.discussionId)}
      data-embedded={String(props.embedded)}
    />
  ),
}));

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

vi.mock("@/lib/useBreakpoint", () => ({
  useBreakpoint: () => ({
    isMobile: false,
    isTablet: false,
    isDesktopUp: true,
    isWide: false,
  }),
}));

import { HubShell } from "../HubShell";

const items: HubItemListRow[] = [
  {
    id: "hub-1",
    companyId: "company-1",
    semanticType: "discussion_pending",
    lane: "waiting_on_you",
    status: "open",
    priority: "normal",
    title: "Discussion needs review",
    summary: null,
    sourceType: "discussion",
    sourceId: "disc-1",
    ownerUserId: "user-1",
    ownerPool: "board",
    version: 0,
    createdAt: "2026-06-29T00:00:00Z",
    updatedAt: "2026-06-29T00:00:00Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: null,
    groupLabel: null,
    groupCount: null,
    scopeKey: null,
    slaAt: null,
  },
];

function renderShell(companyId: string | undefined) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const thread = threadTab("disc-1", "Discussion");
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <HubShell
          activeLane="waiting_on_you"
          items={items}
          counts={{ open: 1, unread: 1 }}
          isLoading={false}
          error={null}
          selectedItemId={null}
          selectedItem={null}
          companyId={companyId}
          tabs={[HOME_TAB, thread]}
          activeTabKey={thread.key}
          onOpenTab={vi.fn()}
          onOpenItem={vi.fn()}
          onCloseTab={vi.fn()}
          onActivateTab={vi.fn()}
          onAddBrowserTab={vi.fn()}
          resolveHubItem={() => undefined}
          onLaneChange={vi.fn()}
          onSelectItem={vi.fn()}
          onMarkRead={vi.fn()}
          preferences={{
            defaultLanding: "waiting_on_you",
            visibleLanes: ["waiting_on_you", "suggestions"],
            groupMode: "auto",
            density: "comfortable",
            showAutopilotEntry: true,
            updatedAt: null,
          }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HubShell tab body companyId seam", () => {
  it("forwards the concrete companyId into an embedded thread tab", () => {
    renderShell("company-1");
    const stub = screen.getByTestId("thread-detail-stub");
    expect(stub).toHaveAttribute("data-company-id", "company-1");
    expect(stub).toHaveAttribute("data-discussion-id", "disc-1");
    expect(stub).toHaveAttribute("data-embedded", "true");
  });

  it("passes companyId through verbatim (does not swallow it to undefined)", () => {
    renderShell("company-xyz");
    expect(screen.getByTestId("thread-detail-stub")).toHaveAttribute(
      "data-company-id",
      "company-xyz",
    );
  });
});
