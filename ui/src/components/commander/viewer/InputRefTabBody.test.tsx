import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HubItemListRow } from "@/api/hub-items";
import { TabBodySwitch } from "./CommanderViewerPanel";
import type { ViewerTab } from "./commanderViewerModel";

vi.mock("@/pages/ThreadDetail", () => ({
  ThreadDetail: () => (
    <div data-testid="thread-detail-mock">
      <button role="tab" aria-selected="true">Thread</button>
      <button role="tab" aria-selected="false">Scope</button>
      <button role="tab" aria-selected="false">Branches</button>
      <div role="tab" aria-selected="true">Open</div>
    </div>
  ),
}));

vi.mock("@/components/approval/ApprovalDetailCore", () => ({
  ApprovalDetailCore: ({
    approvalId,
    embedded,
  }: {
    approvalId: string;
    embedded?: boolean;
  }) => (
    <div
      data-testid="approval-detail-mock"
      data-approval-id={approvalId}
      data-embedded={String(embedded)}
    />
  ),
}));

vi.mock("@/api/hub-items", () => ({
  hubItemsApi: {
    getOne: vi.fn(async (): Promise<HubItemListRow> => ({
      id: "hub-1",
      companyId: "comp-1",
      semanticType: "run_complete",
      lane: "notifications",
      status: "open",
      priority: "normal",
      title: "Run complete",
      summary: "The run finished successfully.",
      sourceType: "heartbeat_run",
      sourceId: "run-1",
      ownerUserId: null,
      ownerPool: null,
      claimedByUserId: null,
      claimedAt: null,
      version: 1,
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
      readAt: null,
      snoozedUntil: null,
      dismissedAt: null,
      groupKey: null,
      groupLabel: null,
      groupCount: null,
      scopeKey: null,
      slaAt: null,
    })),
  },
}));

vi.mock("@/api/discussions", () => ({
  discussionsApi: {
    get: vi.fn(async () => ({
      id: "disc-1",
      title: "Sprint planning",
      status: "active",
      scopeType: "department",
      scopeId: "dept-1",
      scopeName: "Product",
      tags: ["planning"],
      entryCount: 2,
      pendingItemCount: 1,
      createdBy: "user-1",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T01:00:00.000Z",
      crewPaused: false,
      autonomyLevel: 1,
      derivedStage: {
        stage: "discussing",
        label: "Discussing",
        versionNumber: null,
        scopeVersionId: null,
        hasNewEntries: true,
        newEntryCount: 2,
      },
      entries: [
        {
          id: "entry-1",
          inputType: "note",
          rawContent: "Review the launch checklist and assign owners.",
          title: null,
          sourceInfo: null,
          departmentId: null,
          projectId: null,
          goalId: null,
          parentEntryId: null,
          authorAgentId: null,
          authorAgentName: null,
          authorAgentAvatar: null,
          extractionStatus: "completed",
          createdBy: "Local Board",
          createdAt: "2026-07-08T00:30:00.000Z",
          extractedItems: [],
          annotations: [],
        },
      ],
    })),
  },
}));

function renderTab(activeTab: ViewerTab) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TabBodySwitch
        activeId={activeTab.id}
        activeTab={activeTab}
        companyId="comp-1"
        conversationRefs={[]}
        onOpen={vi.fn()}
        onCloseTab={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("Commander Viewer input-ref tab bodies", () => {
  it("renders discussion refs as compact previews without nested thread tabs", async () => {
    renderTab({
      id: "discussion:disc-1",
      kind: "discussion",
      title: "Sprint planning",
      refId: "disc-1",
    });

    expect(await screen.findByTestId("commander-discussion-ref-body")).toBeInTheDocument();
    expect(screen.getByText("Sprint planning")).toBeInTheDocument();
    expect(screen.getByText("Review the launch checklist and assign owners.")).toBeInTheDocument();
    expect(screen.queryByTestId("thread-detail-mock")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Thread" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Scope" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Branches" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Open" })).not.toBeInTheDocument();
  });

  it("renders approval refs with embedded ApprovalDetailCore", () => {
    renderTab({
      id: "approval:approval-1",
      kind: "approval",
      title: "Approve budget",
      refId: "approval-1",
    });

    expect(screen.getByTestId("approval-detail-mock")).toHaveAttribute("data-approval-id", "approval-1");
    expect(screen.getByTestId("approval-detail-mock")).toHaveAttribute("data-embedded", "true");
  });

  it("does not send non-approval family ids to ApprovalDetailCore", () => {
    renderTab({
      id: "approval:memory-1",
      kind: "approval",
      title: "Use TypeScript",
      refId: "memory-1",
      inputRef: {
        v: 1,
        kind: "approval",
        id: "memory-1",
        label: "Use TypeScript",
        detail: "Domain memory decision",
        source: "memory",
      },
    });

    expect(screen.getByTestId("commander-approval-ref-body")).toBeInTheDocument();
    expect(screen.getByText("Use TypeScript")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-detail-mock")).not.toBeInTheDocument();
  });

  it("renders note refs as compact previews", () => {
    renderTab({
      id: "note:note-1",
      kind: "note",
      title: "Launch note",
      refId: "note-1",
      inputRef: {
        v: 1,
        kind: "note",
        id: "note-1",
        label: "Launch note",
        detail: "Remember to check QA.",
      },
    });

    expect(screen.getByText("Launch note")).toBeInTheDocument();
    expect(screen.getByText("Remember to check QA.")).toBeInTheDocument();
  });

  it("renders inbox refs from the hub item API", async () => {
    renderTab({
      id: "inbox:hub-1",
      kind: "inbox",
      title: "Run complete",
      refId: "hub-1",
      inputRef: {
        v: 1,
        kind: "inbox",
        id: "hub-1",
        label: "Run complete",
        detail: "Fallback detail",
      },
    });

    expect(await screen.findByText("Run complete")).toBeInTheDocument();
    expect(screen.getByText("The run finished successfully.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Snooze" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
  });
});
