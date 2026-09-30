import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { HubItemListRow } from "@/api/hub-items";
import { HubTabBody } from "../HubTabBody";
import { HUB_TABPANEL_ID } from "../HubTabStrip";
import {
  HOME_TAB,
  agentTab,
  approvalTab,
  browserTab,
  budgetTab,
  joinRequestTab,
  notificationTab,
  runTab,
  runtimeDecisionTab,
  taskTab,
  threadTab,
  type HubTab,
} from "../hubViewerModel";

// ── Mock the heavy viewers as simple divs. Each records the props it received
//    on a module-level spy so tests can assert what was threaded through. ──

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
  }),
}));

const taskDetailSpy = vi.fn();
vi.mock("@/components/TaskDetail", () => ({
  TaskDetail: (props: Record<string, unknown>) => {
    taskDetailSpy(props);
    return (
      <div data-testid="mock-task-detail" data-issue-id={String(props.issueId)}>
        TaskDetail
      </div>
    );
  },
}));

const threadDetailSpy = vi.fn();
vi.mock("@/pages/ThreadDetail", () => ({
  ThreadDetail: (props: Record<string, unknown>) => {
    threadDetailSpy(props);
    return (
      <div
        data-testid="mock-thread-detail"
        data-discussion-id={String(props.discussionId)}
        data-embedded={String(props.embedded)}
      >
        ThreadDetail
      </div>
    );
  },
}));

const approvalCoreSpy = vi.fn();
vi.mock("@/components/approval/ApprovalDetailCore", () => ({
  ApprovalDetailCore: (props: Record<string, unknown>) => {
    approvalCoreSpy(props);
    return (
      <div
        data-testid="mock-approval-core"
        data-approval-id={String(props.approvalId)}
        data-embedded={String(props.embedded)}
      >
        ApprovalDetailCore
      </div>
    );
  },
}));

const browserSpy = vi.fn();
vi.mock("@/components/viewers/BrowserViewer", () => ({
  BrowserViewer: (props: Record<string, unknown>) => {
    browserSpy(props);
    return (
      <div data-testid="mock-browser" data-url={String(props.initialUrl)}>
        BrowserViewer
      </div>
    );
  },
}));

vi.mock("@/components/settings/sections/BudgetCapsSection", () => ({
  BudgetCapsSection: () => <div data-testid="mock-budget">BudgetCapsSection</div>,
}));

vi.mock("../TaskOutputViewer", () => ({
  TaskOutputViewer: (props: Record<string, unknown>) => (
    <div data-testid="mock-task-output" data-issue-id={String(props.issueId)}>
      TaskOutputViewer
    </div>
  ),
}));

// D4 containers are exercised in their own suites; here we stub them to simple
// divs and only assert HubTabBody's switch routes to them with the right props.
const agentContainerSpy = vi.fn();
vi.mock("../../agent-detail/AgentDetailContainer", () => ({
  AgentDetailContainer: (props: Record<string, unknown>) => {
    agentContainerSpy(props);
    return (
      <div
        data-testid="mock-agent-container"
        data-agent-id={String(props.agentId)}
        data-company-id={String(props.companyId)}
      />
    );
  },
}));

const runContainerSpy = vi.fn();
vi.mock("../../agent-detail/RunDetailContainer", () => ({
  RunDetailContainer: (props: Record<string, unknown>) => {
    runContainerSpy(props);
    return (
      <div
        data-testid="mock-run-container"
        data-run-id={String(props.runId)}
        data-agent-id={String(props.agentId)}
        data-company-id={String(props.companyId)}
      />
    );
  },
}));

// RuntimeDecisionPanel is exercised in its own suite; here we only assert the
// tab body renders it (given a resolver) vs. falling back to the placeholder.
const runtimeDecisionPanelSpy = vi.fn();
vi.mock("../RuntimeDecisionPanel", () => ({
  RuntimeDecisionPanel: (props: Record<string, unknown>) => {
    runtimeDecisionPanelSpy(props);
    const item = props.item as HubItemListRow;
    return <div data-testid="mock-runtime-decision" data-item-id={item.id} />;
  },
}));

function renderBody(
  tab: HubTab,
  onOpenTab = vi.fn(),
  resolveHubItem?: (hubItemId: string) => HubItemListRow | undefined,
  activeItem?: HubItemListRow | null,
) {
  const utils = render(
    <HubTabBody
      tab={tab}
      companyId="company-1"
      onOpenTab={onOpenTab}
      resolveHubItem={resolveHubItem}
      activeItem={activeItem}
    />,
  );
  return { ...utils, onOpenTab };
}

function runtimeDecisionItem(id: string): HubItemListRow {
  return {
    id,
    companyId: "company-1",
    semanticType: "agent_runtime_decision",
    lane: "waiting_on_you",
    status: "open",
    priority: "normal",
    title: "Runtime decision",
    summary: null,
    sourceType: "agent_runtime_decision",
    sourceId: "decision-1",
    ownerUserId: null,
    ownerPool: "board",
    claimedByUserId: null,
    claimedAt: null,
    version: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    readAt: null,
    snoozedUntil: null,
    dismissedAt: null,
    groupKey: null,
    groupLabel: null,
    groupCount: null,
    scopeKey: null,
    slaAt: null,
  };
}

describe("HubTabBody", () => {
  it("roots the body at the tabpanel id with role=tabpanel", () => {
    const { container } = renderBody(HOME_TAB);
    const root = container.querySelector(`#${HUB_TABPANEL_ID}`);
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute("role", "tabpanel");
  });

  it("fills the panel (fluid w-full h-full, not a fixed width)", () => {
    const { container } = renderBody(HOME_TAB);
    const root = container.querySelector(`#${HUB_TABPANEL_ID}`);
    expect(root?.className).toContain("w-full");
    expect(root?.className).toContain("h-full");
    expect(root?.className).not.toContain("w-[360px]");
  });

  it("renders the home placeholder for the home tab", () => {
    renderBody(HOME_TAB);
    expect(screen.getByText(/inbox home/i)).toBeInTheDocument();
  });

  it("renders TaskDetail with the right issueId for a task tab", () => {
    renderBody(taskTab("issue-42", "Ship it"));
    const el = screen.getByTestId("mock-task-detail");
    expect(el).toHaveAttribute("data-issue-id", "issue-42");
  });

  it("renders ThreadDetail with the payload discussionId + embedded for a thread tab", () => {
    renderBody(threadTab("disc-77", "Sprint planning"));
    const el = screen.getByTestId("mock-thread-detail");
    expect(el).toHaveAttribute("data-discussion-id", "disc-77");
    expect(el).toHaveAttribute("data-embedded", "true");
    // The hosting company id is threaded through so the thread query resolves.
    const props = threadDetailSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(props.companyId).toBe("company-1");
  });

  it("threads onOpenTab into TaskDetail's handoff callback", () => {
    const onOpenTab = vi.fn();
    renderBody(taskTab("issue-42", "Ship it"), onOpenTab);
    const props = taskDetailSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // TaskDetail must receive active + a handoff callback wired to onOpenTab.
    expect(props.active).toBe(true);
    const handoff = props.onOpenScopeHandoffItem as (item: unknown) => void;
    expect(typeof handoff).toBe("function");

    // A url handoff item should re-emit a browser tab through onOpenTab.
    handoff({
      id: "ctx-1",
      itemType: "url",
      label: "Docs",
      sourceId: null,
      metadata: { url: "https://example.com" },
    });
    expect(onOpenTab).toHaveBeenCalledTimes(1);
    const emitted = onOpenTab.mock.calls[0][0] as HubTab;
    expect(emitted.kind).toBe("browser");
  });

  it("renders BrowserViewer with the url for a browser tab", () => {
    renderBody(browserTab("https://example.com/path"));
    const el = screen.getByTestId("mock-browser");
    expect(el.getAttribute("data-url")).toContain("example.com");
  });

  it("renders BudgetCapsSection for a budget tab", () => {
    renderBody(budgetTab());
    expect(screen.getByTestId("mock-budget")).toBeInTheDocument();
  });

  it("renders ApprovalDetailCore embedded with the payload approvalId for an approval tab", () => {
    const onOpenTab = vi.fn();
    renderBody(approvalTab("approval-1", "Review hire"), onOpenTab);
    const el = screen.getByTestId("mock-approval-core");
    expect(el).toHaveAttribute("data-approval-id", "approval-1");
    expect(el).toHaveAttribute("data-embedded", "true");
    // onOpenTab is threaded through so linked task / hired agent links open
    // sibling hub tabs instead of navigating.
    const props = approvalCoreSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(props.onOpenTab).toBe(onOpenTab);
  });

  it("keeps hosting the embedded ApprovalDetailCore (no compact-body regression)", () => {
    renderBody(approvalTab("approval-9", "Review hire"));
    expect(screen.getByTestId("mock-approval-core")).toBeInTheDocument();
    expect(screen.queryByTestId("hub-viewer-scaffold")).toBeNull();
  });

  it("renders JoinRequestBody for a join_request tab when the active item resolves", () => {
    render(
      <MemoryRouter>
        <HubTabBody
          tab={joinRequestTab("jr-1", "Join request")}
          companyId="company-1"
          onOpenTab={vi.fn()}
          activeItem={{
            ...runtimeDecisionItem("hub-jr"),
            semanticType: "join_request",
            sourceType: "join_request",
            title: "Scout wants to join",
            summary: "Requested by scout@example.com",
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: /scout wants to join/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /approve/i })).toBeInTheDocument();
  });

  it("falls back to the placeholder for a join_request tab with no active item", () => {
    const { container } = renderBody(joinRequestTab("jr-1", "Join request"));
    const root = container.querySelector(`#${HUB_TABPANEL_ID}`);
    expect(root).not.toBeNull();
    expect(screen.getByText(/preparing viewer/i)).toBeInTheDocument();
  });

  it("renders a minimal generic body for a notification tab", () => {
    renderBody(notificationTab("hub-item-1", "Budget nearing cap"));
    expect(screen.getByText("Budget nearing cap")).toBeInTheDocument();
    expect(screen.getByText(/no dedicated viewer/i)).toBeInTheDocument();
  });

  it("renders RuntimeDecisionPanel for a runtime_decision tab when resolveHubItem returns an item", () => {
    const item = runtimeDecisionItem("hub-runtime-9");
    const resolveHubItem = vi.fn().mockReturnValue(item);
    renderBody(runtimeDecisionTab("hub-runtime-9", "Allow command?"), vi.fn(), resolveHubItem);

    expect(resolveHubItem).toHaveBeenCalledWith("hub-runtime-9");
    const el = screen.getByTestId("mock-runtime-decision");
    expect(el).toHaveAttribute("data-item-id", "hub-runtime-9");
    // The panel received the full resolved row, not just the id.
    const props = runtimeDecisionPanelSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(props.item).toBe(item);
  });

  it("falls back to the placeholder for a runtime_decision tab without a resolveHubItem", () => {
    renderBody(runtimeDecisionTab("hub-runtime-9", "Allow command?"));
    expect(screen.queryByTestId("mock-runtime-decision")).toBeNull();
    expect(screen.getByText(/preparing viewer/i)).toBeInTheDocument();
  });

  it("falls back to the placeholder when resolveHubItem returns undefined", () => {
    const resolveHubItem = vi.fn().mockReturnValue(undefined);
    renderBody(runtimeDecisionTab("hub-runtime-missing"), vi.fn(), resolveHubItem);
    expect(screen.queryByTestId("mock-runtime-decision")).toBeNull();
    expect(screen.getByText(/preparing viewer/i)).toBeInTheDocument();
  });

  // ── D4a/D4b: agent + run tabs are now live-wired (no longer placeholders) ──

  it("routes an agent tab to AgentDetailContainer with agentId + companyId (D4a)", () => {
    renderBody(agentTab("agent-42", "Worker"));
    const el = screen.getByTestId("mock-agent-container");
    expect(el).toHaveAttribute("data-agent-id", "agent-42");
    expect(el).toHaveAttribute("data-company-id", "company-1");
    expect(screen.queryByText(/preparing viewer/i)).toBeNull();
  });

  it("routes a run tab to RunDetailContainer with runId + agentId + companyId (D4b)", () => {
    const onOpenTab = vi.fn();
    renderBody(runTab("run-7", "agent-42", "Run 7"), onOpenTab);
    const el = screen.getByTestId("mock-run-container");
    expect(el).toHaveAttribute("data-run-id", "run-7");
    expect(el).toHaveAttribute("data-agent-id", "agent-42");
    expect(el).toHaveAttribute("data-company-id", "company-1");
    expect(screen.queryByText(/preparing viewer/i)).toBeNull();

    const props = runContainerSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const onOpenIssue = props.onOpenIssue as (issueId: string, title: string) => void;
    onOpenIssue("issue-9", "Review launch plan");
    expect(onOpenTab).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task",
        payload: expect.objectContaining({ issueId: "issue-9" }),
      }),
    );
  });

  it("falls back to the placeholder for an agent tab with no payload", () => {
    renderBody({ key: "agent:x", kind: "agent", title: "Agent", closeable: true });
    expect(screen.queryByTestId("mock-agent-container")).toBeNull();
    expect(screen.getByText(/preparing viewer/i)).toBeInTheDocument();
  });

  it("falls back to the placeholder for a run tab with no payload", () => {
    renderBody({ key: "run:x", kind: "run", title: "Run", closeable: true });
    expect(screen.queryByTestId("mock-run-container")).toBeNull();
    expect(screen.getByText(/preparing viewer/i)).toBeInTheDocument();
  });
});
