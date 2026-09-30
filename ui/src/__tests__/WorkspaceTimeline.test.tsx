import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { COMPOSER_MAX_ATTACHMENT_BYTES } from "@armyofagents/shared";
import { WorkspaceTimeline } from "../components/workspace/WorkspaceTimeline";
import { queryKeys } from "../lib/queryKeys";

// ─── Mock data ───────────────────────────────────────────────────────────────

const mockIssue = {
  id: "issue-1",
  companyId: "comp-1",
  projectId: "proj-1",
  title: "Fix auth",
  description: "Fix the login flow and verify session handling.",
  status: "in_progress",
  priority: "high",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
};

const mockRuns = [
  {
    runId: "run-001",
    status: "succeeded",
    agentId: "agent-1",
    startedAt: "2026-04-01T10:00:00Z",
    finishedAt: "2026-04-01T10:05:00Z",
    createdAt: "2026-04-01T10:00:00Z",
    invocationSource: "on_demand",
    usageJson: { inputTokens: 1000, outputTokens: 500 },
    resultJson: null,
    detectedOutputs: null,
  },
  {
    runId: "run-002",
    status: "succeeded",
    agentId: "agent-1",
    startedAt: "2026-04-01T10:20:00Z",
    finishedAt: "2026-04-01T10:25:00Z",
    createdAt: "2026-04-01T10:20:00Z",
    invocationSource: "on_demand",
    usageJson: { inputTokens: 2000, outputTokens: 800 },
    resultJson: null,
    detectedOutputs: null,
  },
];

const mockComments = [
  {
    id: "comment-1",
    companyId: "comp-1",
    issueId: "issue-1",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Please fix the login flow",
    createdAt: "2026-04-01T10:10:00Z",
    updatedAt: "2026-04-01T10:10:00Z",
  },
  {
    id: "comment-2",
    companyId: "comp-1",
    issueId: "issue-1",
    authorAgentId: "agent-1",
    authorUserId: null,
    body: "Working on it now",
    createdAt: "2026-04-01T10:15:00Z",
    updatedAt: "2026-04-01T10:15:00Z",
  },
];

const mockAgents = [
  { id: "agent-1", name: "Alpha Agent", status: "active", companyId: "comp-1", adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-6" } },
  { id: "agent-2", name: "Beta Agent", status: "active", companyId: "comp-1", adapterType: "process", adapterConfig: {} },
];

// ─── API Mocks ───────────────────────────────────────────────────────────────

const issuesApiMock = {
  get: vi.fn().mockResolvedValue(mockIssue),
  listComments: vi.fn().mockResolvedValue(mockComments),
  addComment: vi.fn().mockResolvedValue({ id: "new-comment" }),
  addCommentWithAttachments: vi.fn().mockResolvedValue({
    comment: { id: "new-comment", body: "see attached" },
    attachments: [{ id: "att-1", originalFilename: "proof.png" }],
  }),
  listAttachments: vi.fn().mockResolvedValue([]),
  listContextBundles: vi.fn().mockResolvedValue([]),
};

const activityApiMock = {
  runsForIssue: vi.fn().mockResolvedValue(mockRuns),
};

const heartbeatsApiMock = {
  liveRunsForIssue: vi.fn().mockResolvedValue([]),
  activeRunForIssue: vi.fn().mockResolvedValue(null),
  log: vi.fn().mockResolvedValue({ runId: "run-001", store: "file", logRef: "", content: "done" }),
};

const agentsApiMock = {
  list: vi.fn().mockResolvedValue(mockAgents),
  wakeup: vi.fn().mockResolvedValue(undefined),
};

const workQuestionsApiMock = {
  listInline: vi.fn().mockResolvedValue([]),
};

vi.mock("../api/issues", () => ({
  issuesApi: new Proxy(
    {},
    { get: (_t, prop) => (issuesApiMock as any)[prop] },
  ),
}));

vi.mock("../api/activity", () => ({
  activityApi: new Proxy(
    {},
    { get: (_t, prop) => (activityApiMock as any)[prop] },
  ),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: new Proxy(
    {},
    { get: (_t, prop) => (heartbeatsApiMock as any)[prop] },
  ),
}));

vi.mock("../api/agents", () => ({
  agentsApi: new Proxy(
    {},
    { get: (_t, prop) => (agentsApiMock as any)[prop] },
  ),
}));

vi.mock("../api/work-questions", () => ({
  workQuestionsApi: new Proxy(
    {},
    { get: (_t, prop) => (workQuestionsApiMock as any)[prop] },
  ),
}));

// Mutable connection state for the shared offline strip (B-states, mock §5).
const liveState = vi.hoisted(() => ({ connectionState: "open" }));

vi.mock("../context/LiveUpdatesProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context/LiveUpdatesProvider")>();
  return {
    ...actual,
    useLiveUpdates: () => ({
      connectionState: liveState.connectionState,
      workingAgentsByThread: {},
      presenceByThread: {},
    }),
  };
});

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn(), toasts: [], dismissToast: vi.fn(), clearToasts: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", issuePrefix: "TC" },
    companies: [{ id: "comp-1" }],
  }),
}));

// Mock LiveRunWidget to avoid complex WebSocket dependencies
vi.mock("../components/LiveRunWidget", () => ({
  LiveRunWidget: ({ issueId }: { issueId: string }) => (
    <div data-testid="live-run-widget">Live runs for {issueId}</div>
  ),
}));

vi.mock("../components/work-questions/WorkQuestionPanel", () => ({
  WorkQuestionPanel: ({ questionId }: { questionId: string }) => (
    <div data-testid={`inline-work-question-${questionId}`}>Question {questionId}</div>
  ),
}));

// Mock adapter registry to avoid importing real adapter modules
vi.mock("../adapters/registry", () => ({
  getUIAdapter: () => ({
    parseStdoutLine: () => [],
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderTimeline(props: Partial<React.ComponentProps<typeof WorkspaceTimeline>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  const makeUi = (extra: Partial<React.ComponentProps<typeof WorkspaceTimeline>> = {}) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <WorkspaceTimeline
          issueId="issue-1"
          {...props}
          {...extra}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const result = render(makeUi());

  // Fresh element tree each time so mocked hook values (e.g. liveState) that
  // changed since the first render are re-read. Pass `extra` props to simulate
  // an entity switch (e.g. a different issueId) on the SAME mounted component.
  return {
    ...result,
    queryClient,
    rerenderTimeline: (extra: Partial<React.ComponentProps<typeof WorkspaceTimeline>> = {}) =>
      result.rerender(makeUi(extra)),
  };
}

function setScrollMetrics(element: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: metrics.clientHeight });
  element.scrollTop = metrics.scrollTop;
}

function makeLiveRun(id = "run-live-scroll") {
  return {
    id,
    agentId: "agent-1",
    agentName: "Alpha Agent",
    adapterType: "claude_local",
    status: "running",
    invocationSource: "on_demand",
    triggerDetail: null,
    startedAt: "2026-04-01T11:00:00Z",
    createdAt: "2026-04-01T11:00:00Z",
    finishedAt: null,
    issueId: "issue-1",
    logStore: null,
    logRef: null,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  liveState.connectionState = "open";
  issuesApiMock.get.mockResolvedValue(mockIssue);
  issuesApiMock.listComments.mockResolvedValue(mockComments);
  issuesApiMock.listAttachments.mockResolvedValue([]);
  issuesApiMock.listContextBundles.mockResolvedValue([]);
  activityApiMock.runsForIssue.mockResolvedValue(mockRuns);
  heartbeatsApiMock.liveRunsForIssue.mockResolvedValue([]);
  heartbeatsApiMock.activeRunForIssue.mockResolvedValue(null);
  agentsApiMock.list.mockResolvedValue(mockAgents);
  workQuestionsApiMock.listInline.mockResolvedValue([]);
});

describe("WorkspaceTimeline — rendering", () => {
  it("renders completed runs as Codex-like worked-for boundaries", async () => {
    renderTimeline();

    expect(await screen.findAllByText(/Worked for/i)).toHaveLength(2);
  });

  it("separates active execution from human and permission wait time", async () => {
    activityApiMock.runsForIssue.mockResolvedValue([
      {
        ...mockRuns[0],
        activeExecutionMs: 90_000,
        humanQuestionWaitMs: 30_000,
        runtimePermissionWaitMs: 120_000,
        totalWallClockMs: 240_000,
      },
    ]);

    renderTimeline();

    expect(await screen.findByText("Active: 1m 30s")).toBeInTheDocument();
    expect(screen.getByText("Human wait: 30s")).toBeInTheDocument();
    expect(screen.getByText("Permission wait: 2m 0s")).toBeInTheDocument();
  });

  it("renders image attachments under the exact comment that uploaded them", async () => {
    issuesApiMock.listAttachments.mockResolvedValue([
      {
        id: "att-1",
        assetId: "asset-att-1",
        issueId: "issue-1",
        issueCommentId: "comment-1",
        contentType: "image/png",
        originalFilename: "proof.png",
        contentPath: "/api/attachments/att-1/content",
      },
    ]);

    renderTimeline();

    const attachmentGroup = await screen.findByTestId("timeline-comment-attachments-comment-1");
    expect(attachmentGroup).toHaveTextContent("proof.png");
    expect(attachmentGroup.querySelector("img")).toHaveAttribute("src", "/api/assets/asset-att-1/content");
    expect(screen.queryByTestId("timeline-comment-attachments-comment-2")).not.toBeInTheDocument();
  });

  it("renders non-image attachments as compact file pills under the comment", async () => {
    issuesApiMock.listAttachments.mockResolvedValue([
      {
        id: "att-2",
        issueId: "issue-1",
        issueCommentId: "comment-1",
        contentType: "text/markdown",
        originalFilename: "notes.md",
        contentPath: "/api/attachments/att-2/content",
      },
    ]);

    renderTimeline();

    const attachmentGroup = await screen.findByTestId("timeline-comment-attachments-comment-1");
    expect(attachmentGroup).toHaveTextContent("notes.md");
    expect(attachmentGroup).toHaveTextContent("file");
  });

  it("renders the task brief as the first thread context item", async () => {
    renderTimeline();

    const brief = await screen.findByTestId("timeline-task-brief");
    expect(brief).toHaveTextContent("Task");
    expect(brief).toHaveTextContent("Fix auth");
    expect(brief).toHaveTextContent("Fix the login flow and verify session handling.");
    expect(brief).toHaveTextContent("in progress");
    expect(brief).toHaveTextContent("Assigned to Alpha Agent");
  });

  it("renders DIS-5-style inline image markdown and recovery diagnostics without blanking", async () => {
    issuesApiMock.get.mockResolvedValue({
      ...mockIssue,
      id: "issue-1",
      identifier: "DIS-5",
      title: "aoa deisgn",
      description:
        "![ChatGPT Image May 14, 2026, 02_59_35 PM.png](/api/assets/448d649d-2b98-4330-9021-b8c6f32af310/content)\n\n" +
        "do you think we can animate this ? give me a plan",
      status: "in_progress",
      assigneeAgentId: "agent-1",
    });
    activityApiMock.runsForIssue.mockResolvedValue([
      {
        runId: "run-dis-5",
        status: "succeeded",
        agentId: "agent-1",
        startedAt: "2026-05-18T17:29:24.406Z",
        finishedAt: "2026-05-18T17:29:38.666Z",
        createdAt: "2026-05-18T17:29:24.397Z",
        invocationSource: "on_demand",
        usageJson: { inputTokens: 22044, outputTokens: 392 },
        resultJson: {
          stderr: Array.from({ length: 35 }, (_, index) => `diagnostic ${index + 1}`).join("\n"),
          stdout: JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "Yes. We can animate this." },
          }),
          stopReason: "completed",
        },
        detectedOutputs: null,
      },
    ]);
    issuesApiMock.listComments.mockResolvedValue([
      {
        id: "recovery-comment",
        companyId: "comp-1",
        issueId: "issue-1",
        authorAgentId: null,
        authorUserId: null,
        authorType: "system",
        presentation: { kind: "system_notice", tone: "warning", title: "Task needs final status" },
        metadata: null,
        body: "The agent run finished, but the task is still in progress.",
        createdAt: "2026-05-18T17:29:38.755Z",
        updatedAt: "2026-05-18T17:29:38.755Z",
      },
    ]);
    issuesApiMock.listAttachments.mockResolvedValue([]);

    renderTimeline();

    const brief = await screen.findByTestId("timeline-task-brief");
    expect(brief).toHaveTextContent("DIS-5");
    expect(brief).toHaveTextContent("aoa deisgn");
    expect(brief.querySelector("img")).toHaveAttribute(
      "src",
      "/api/assets/448d649d-2b98-4330-9021-b8c6f32af310/content",
    );
    expect(await screen.findByTestId("timeline-comment-recovery-comment")).toHaveTextContent(
      "The agent run finished, but the task is still in progress.",
    );
    expect(screen.getByTestId("workspace-timeline")).toBeInTheDocument();
  });

  it("renders task-level attachments in the task brief and keeps comment attachments on the comment", async () => {
    issuesApiMock.listAttachments.mockResolvedValue([
      {
        id: "task-att-1",
        issueId: "issue-1",
        issueCommentId: null,
        contentType: "image/png",
        originalFilename: "task-screenshot.png",
        contentPath: "/api/attachments/task-att-1/content",
        byteSize: 1000,
      },
      {
        id: "comment-att-1",
        issueId: "issue-1",
        issueCommentId: "comment-1",
        contentType: "text/markdown",
        originalFilename: "comment-note.md",
        contentPath: "/api/attachments/comment-att-1/content",
        byteSize: 1000,
      },
    ]);

    renderTimeline();

    const taskAttachments = await screen.findByTestId("timeline-task-attachments");
    expect(taskAttachments).toHaveTextContent("task-screenshot.png");
    expect(taskAttachments).not.toHaveTextContent("comment-note.md");

    const commentAttachments = await screen.findByTestId("timeline-comment-attachments-comment-1");
    expect(commentAttachments).toHaveTextContent("comment-note.md");
    expect(commentAttachments).not.toHaveTextContent("task-screenshot.png");
  });

  it("shows inherited context when bundle data exists", async () => {
    issuesApiMock.listContextBundles.mockResolvedValue([
      {
        id: "bundle-1",
        companyId: "comp-1",
        sourceIssueId: "parent-task-1234",
        targetIssueId: "issue-1",
        brief: "Use selected context only.",
        items: [
          { id: "item-1", itemType: "attachment", sourceId: "att-1", label: "proof.png" },
          { id: "item-2", itemType: "comment", sourceId: "comment-parent", label: "Parent note" },
        ],
      },
    ]);

    renderTimeline();

    const brief = await screen.findByTestId("timeline-task-brief");
    expect(brief).toHaveTextContent("Inherited context");
    expect(brief).toHaveTextContent("2 selected items");
    expect(brief).toHaveTextContent("proof.png");
    expect(brief).toHaveTextContent("Parent note");
  });

  it("renders active runs as Codex-like working-for boundaries", async () => {
    heartbeatsApiMock.liveRunsForIssue.mockResolvedValue([
      {
        id: "run-live-1",
        agentId: "agent-1",
        agentName: "Alpha Agent",
        adapterType: "claude_local",
        status: "running",
        invocationSource: "on_demand",
        triggerDetail: null,
        startedAt: new Date(Date.now() - 140_000).toISOString(),
        createdAt: new Date(Date.now() - 150_000).toISOString(),
        finishedAt: null,
        issueId: "issue-1",
      },
    ]);

    renderTimeline();

    expect(await screen.findByText(/Working for/i)).toBeInTheDocument();
  });

  it("updates active run duration while the run remains open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-04-01T10:00:01Z"));
    heartbeatsApiMock.liveRunsForIssue.mockResolvedValue([
      {
        id: "run-live-timer",
        agentId: "agent-1",
        agentName: "Alpha Agent",
        adapterType: "claude_local",
        status: "running",
        invocationSource: "on_demand",
        triggerDetail: null,
        startedAt: "2026-04-01T10:00:00Z",
        createdAt: "2026-04-01T10:00:00Z",
        finishedAt: null,
        issueId: "issue-1",
        logStore: null,
        logRef: null,
      },
    ]);

    renderTimeline();

    expect(await screen.findByText(/Working for 1s/i)).toBeInTheDocument();

    act(() => {
      vi.setSystemTime(new Date("2026-04-01T10:00:03Z"));
      vi.advanceTimersByTime(2000);
    });

    expect(await screen.findByText(/Working for [2-9]s/i)).toBeInTheDocument();
    expect(screen.queryByText(/Working for 1s/i)).not.toBeInTheDocument();
  });

  it("keeps timeline content in a centered width-safe thread lane", async () => {
    renderTimeline();

    expect(await screen.findByTestId("timeline-thread-lane")).toHaveClass("max-w-3xl");
    expect(screen.getByTestId("timeline-thread-lane")).toHaveClass("min-w-0");
    expect(screen.getByTestId("timeline-scroll")).toHaveClass("overflow-y-auto");
  });

  it("keeps the chatbar outside the transcript scroll area", async () => {
    renderTimeline();

    const timeline = await screen.findByTestId("workspace-timeline");
    const scroll = screen.getByTestId("timeline-scroll");
    const chatbar = await screen.findByTestId("workspace-chatbar");

    expect(timeline).toHaveClass("flex-1");
    expect(timeline).toHaveClass("overflow-hidden");
    expect(scroll).toHaveClass("flex-1");
    expect(scroll).toHaveClass("overflow-y-auto");
    expect(chatbar).toHaveClass("shrink-0");
  });

  it("auto-follows new live activity while the user is pinned near the bottom", async () => {
    const { queryClient } = renderTimeline();

    const scroll = await screen.findByTestId("timeline-scroll");
    setScrollMetrics(scroll, { scrollHeight: 1000, clientHeight: 400, scrollTop: 590 });
    fireEvent.scroll(scroll);

    heartbeatsApiMock.liveRunsForIssue.mockResolvedValue([makeLiveRun()]);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns("issue-1") });
    });

    await screen.findByTestId("timeline-agent-msg-run-live-scroll");
    expect(scroll.scrollTop).toBe(1000);
    expect(screen.queryByText("New activity")).not.toBeInTheDocument();
  });

  it("pauses auto-follow when the user has scrolled up and resumes from New activity", async () => {
    const { queryClient } = renderTimeline();

    const scroll = await screen.findByTestId("timeline-scroll");
    setScrollMetrics(scroll, { scrollHeight: 1000, clientHeight: 400, scrollTop: 120 });
    fireEvent.scroll(scroll);

    heartbeatsApiMock.liveRunsForIssue.mockResolvedValue([makeLiveRun()]);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns("issue-1") });
    });

    await screen.findByTestId("timeline-agent-msg-run-live-scroll");
    expect(scroll.scrollTop).toBe(120);

    fireEvent.click(screen.getByText("New activity"));

    expect(scroll.scrollTop).toBe(1000);
    expect(screen.queryByText("New activity")).not.toBeInTheDocument();
  });

  it("renders runs and comments in chronological order", async () => {
    renderTimeline();

    await waitFor(() => {
      // Both runs should render as TimelineAgentMessages
      expect(screen.getByTestId("timeline-agent-msg-run-001")).toBeInTheDocument();
      expect(screen.getByTestId("timeline-agent-msg-run-002")).toBeInTheDocument();
    });

    // Both comments should render
    expect(screen.getByText("Please fix the login flow")).toBeInTheDocument();
    expect(screen.getByText("Working on it now")).toBeInTheDocument();
  });

  it("composes a question chronologically and focuses an exact Commander anchor", async () => {
    const questionId = "55555555-5555-4555-8555-555555555555";
    workQuestionsApiMock.listInline.mockResolvedValueOnce([{
      question: {
        id: questionId,
        createdAt: "2026-04-01T10:12:00Z",
      },
      capabilities: { read: true },
    }]);
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    renderTimeline({ anchorId: questionId });

    const firstComment = await screen.findByTestId("timeline-comment-comment-1");
    const question = await screen.findByTestId(`inline-work-question-${questionId}`);
    const secondComment = screen.getByTestId("timeline-comment-comment-2");
    expect(firstComment.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(question.compareDocumentPosition(secondComment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(question.parentElement).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("shows empty state when no runs or comments", async () => {
    activityApiMock.runsForIssue.mockResolvedValue([]);
    issuesApiMock.listComments.mockResolvedValue([]);

    renderTimeline();

    await waitFor(() => {
      expect(screen.getByText(/No runs or comments yet/)).toBeInTheDocument();
    });
  });

  it("latest run is expanded, older runs collapsed", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByTestId("timeline-agent-msg-run-001")).toBeInTheDocument();
      expect(screen.getByTestId("timeline-agent-msg-run-002")).toBeInTheDocument();
    });

    // run-002 is the latest run — run-001 log should be collapsed (not expanded)
    expect(screen.queryByTestId("agent-msg-log-run-001")).not.toBeInTheDocument();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkspaceTimeline — input area", () => {
  it("renders the chatbar with textarea and send button", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-chatbar")).toBeInTheDocument();
    });

    expect(screen.getByPlaceholderText("Message Alpha Agent...")).toBeInTheDocument();
    expect(screen.getByText("Send & wake")).toBeInTheDocument();
  });

  it("Send creates a comment and lets the server wake the agent", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-chatbar")).toBeInTheDocument();
    });

    const textarea = screen.getByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "Please review the changes" } });

    const sendButton = screen.getByText("Send & wake");
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(issuesApiMock.addComment).toHaveBeenCalledWith(
        "issue-1",
        "Please review the changes",
        undefined,
        undefined,
        undefined,
        expect.any(String),
      );
    });

    expect(agentsApiMock.wakeup).not.toHaveBeenCalled();
  });

  it("sends on Enter and keeps Shift+Enter available for a newline", async () => {
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "First line" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(issuesApiMock.addComment).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("First line");

    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(issuesApiMock.addComment).toHaveBeenCalledWith(
        "issue-1",
        "First line",
        undefined,
        undefined,
        undefined,
        expect.any(String),
      );
    });
  });

  it("renders the classic separated chatbar rows", async () => {
    renderTimeline();

    const chatbar = await screen.findByTestId("workspace-chatbar");
    const separatedRows = chatbar.querySelectorAll(".border-t");

    expect(separatedRows.length).toBeGreaterThanOrEqual(2);
  });

  it("renders full composer controls when no agent is assigned", async () => {
    issuesApiMock.get.mockResolvedValue({ ...mockIssue, assigneeAgentId: null });

    renderTimeline();

    const chatbar = await screen.findByTestId("workspace-chatbar-fallback");
    expect(chatbar).toHaveTextContent("No agent assigned");
    expect(screen.getByLabelText("Attach file")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Task progress" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Context usage" })).toBeInTheDocument();
    expect(screen.getByText("Send")).toBeInTheDocument();
    expect(screen.queryByText("Comment")).not.toBeInTheDocument();
    expect(screen.queryByText("comment")).not.toBeInTheDocument();
  });

  it("sends attachment comments from the no-agent composer", async () => {
    issuesApiMock.get.mockResolvedValue({ ...mockIssue, assigneeAgentId: null });

    renderTimeline();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-chatbar-fallback")).toBeInTheDocument();
    });

    const file = new File(["fake"], "fallback-proof.txt", { type: "text/plain" });
    const fileInput = screen.getByTestId("workspace-chatbar-file-input") as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText("fallback-proof.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      expect(issuesApiMock.addCommentWithAttachments).toHaveBeenCalledWith(
        "issue-1",
        "",
        [file],
        undefined,
        undefined,
        expect.any(String),
      );
    });
  });

  it("selects attachments and sends them with the comment through the combined endpoint", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-chatbar")).toBeInTheDocument();
    });

    const file = new File(["fake"], "proof.png", { type: "image/png" });
    const fileInput = screen.getByTestId("workspace-chatbar-file-input") as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText("proof.png")).toBeInTheDocument();

    const textarea = screen.getByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "see attached" } });
    fireEvent.click(screen.getByText("Send & wake"));

    await waitFor(() => {
      expect(issuesApiMock.addCommentWithAttachments).toHaveBeenCalledWith(
        "issue-1",
        "see attached",
        [file],
        undefined,
        undefined,
        expect.any(String),
      );
    });
    expect(agentsApiMock.wakeup).not.toHaveBeenCalled();
  });

  it("allows file-only attachment comments", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-chatbar")).toBeInTheDocument();
    });

    const file = new File(["fake"], "evidence.md", { type: "text/markdown" });
    const fileInput = screen.getByTestId("workspace-chatbar-file-input") as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    fireEvent.click(screen.getByText("Send & wake"));

    await waitFor(() => {
      expect(issuesApiMock.addCommentWithAttachments).toHaveBeenCalledWith(
        "issue-1",
        "",
        [file],
        undefined,
        undefined,
        expect.any(String),
      );
    });
  });

  it("rejects unsupported and oversized attachments with inline feedback", async () => {
    renderTimeline();

    await screen.findByTestId("workspace-chatbar");
    const fileInput = screen.getByTestId("workspace-chatbar-file-input") as HTMLInputElement;
    const unsupported = new File(["fake"], "script.exe", { type: "application/x-msdownload" });
    fireEvent.change(fileInput, { target: { files: [unsupported] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported attachment type");
    expect(screen.queryByText("script.exe")).not.toBeInTheDocument();

    const oversized = new File(["fake"], "large.pdf", { type: "application/pdf" });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: COMPOSER_MAX_ATTACHMENT_BYTES + 1,
    });
    fireEvent.change(fileInput, { target: { files: [oversized] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("large.pdf exceeds the 10 MB attachment limit");
    expect(screen.queryByText("large.pdf")).not.toBeInTheDocument();
    expect(issuesApiMock.addCommentWithAttachments).not.toHaveBeenCalled();
  });

  it("keeps the draft and selected files when sending fails and raises the banner", async () => {
    issuesApiMock.addCommentWithAttachments.mockRejectedValueOnce(new Error("Upload failed"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    const file = new File(["fake"], "evidence.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("workspace-chatbar-file-input"), { target: { files: [file] } });
    fireEvent.change(textarea, { target: { value: "Please inspect this" } });
    fireEvent.click(screen.getByText("Send & wake"));

    // The send-failure message lives in the shared banner now — the old inline
    // "Could not send message" composerError copy is gone (mock §5).
    expect(await screen.findByTestId("composer-send-failed-banner")).toBeInTheDocument();
    expect(screen.queryByText(/Could not send message/)).not.toBeInTheDocument();
    expect(textarea).toHaveValue("Please inspect this");
    expect(screen.getByText("evidence.txt")).toBeInTheDocument();
  });

  it("Send button is disabled when input is empty", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByText("Send & wake")).toBeInTheDocument();
    });

    const sendButton = screen.getByText("Send & wake");
    expect(sendButton).toBeDisabled();
  });

  it("does not show latest run output file chips in the composer status row", async () => {
    activityApiMock.runsForIssue.mockResolvedValue([
      {
        ...mockRuns[0],
        detectedOutputs: [{ path: "report.md", byteSize: 42, kind: "file" }],
      },
    ]);

    renderTimeline();

    expect(await screen.findByTestId("workspace-chatbar")).toBeInTheDocument();
    expect(screen.queryByText(/1 file/i)).not.toBeInTheDocument();
  });
});

describe("WorkspaceTimeline — chatbar context donut and todos", () => {
  it("renders chatbar with context donut and todo data", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-chatbar")).toBeInTheDocument();
    });

    // Agent name should appear (may appear in multiple places — timeline + chatbar status row)
    expect(screen.getAllByText("Alpha Agent").length).toBeGreaterThanOrEqual(1);
  });
});

describe("WorkspaceTimeline — comment display", () => {
  it("renders user comments as quiet right-aligned bubbles and agent comments as plain thread text", async () => {
    renderTimeline();

    const userComment = await screen.findByTestId("timeline-comment-comment-1");
    const agentComment = await screen.findByTestId("timeline-comment-comment-2");

    expect(userComment).toHaveClass("ml-auto");
    expect(userComment.firstElementChild).toHaveClass("bg-card");
    expect(agentComment).toHaveClass("mr-auto");
    expect(agentComment.firstElementChild).toHaveClass("bg-transparent");
  });

  it("shows author name for agent comments", async () => {
    renderTimeline();

    await waitFor(() => {
      // Agent name appears in Identity + in the text span, so multiple matches expected
      expect(screen.getAllByText("Alpha Agent").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows You for user comments", async () => {
    renderTimeline();

    await waitFor(() => {
      // "You" appears in Identity + in the font-medium span
      expect(screen.getAllByText("You").length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("WorkspaceTimeline — chatbar live state", () => {
  it("shows live run state in the chatbar status row", async () => {
    heartbeatsApiMock.liveRunsForIssue.mockResolvedValue([makeLiveRun("run-live-status")]);

    renderTimeline();

    const chatbar = await screen.findByTestId("workspace-chatbar");
    expect(chatbar).toHaveTextContent("Alpha Agent");
    expect(chatbar).toHaveTextContent("Working");
  });

  it("states 'Queued after current run' inside the frame while a run is live (Board 1 §3)", async () => {
    heartbeatsApiMock.liveRunsForIssue.mockResolvedValue([makeLiveRun("run-live-queued")]);

    renderTimeline();

    const notice = await screen.findByTestId("workspace-chatbar-queued-notice");
    expect(notice).toHaveTextContent("Queued after current run");
    // The notice lives INSIDE the composer frame, per the containment contract.
    expect(screen.getByTestId("workspace-chatbar").contains(notice)).toBe(true);
  });

  it("chatbar carries the Quiet Operator card chrome without overflow clipping", async () => {
    renderTimeline();

    const chatbar = await screen.findByTestId("workspace-chatbar");
    expect(chatbar).toHaveAttribute("data-chrome", "card");
    expect(chatbar.className).toContain("rounded-lg");
    expect(chatbar.className).not.toContain("overflow-hidden");
  });
});

describe("WorkspaceTimeline — B-states (mock §5)", () => {
  it("Retry re-sends the IDENTICAL args including the same clientSubmissionId, then clears", async () => {
    issuesApiMock.addComment.mockRejectedValueOnce(new Error("network error"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "retry me" } });
    fireEvent.click(screen.getByText("Send & wake"));

    const banner = await screen.findByTestId("composer-send-failed-banner");
    expect(textarea).toHaveValue("retry me");

    const firstCall = issuesApiMock.addComment.mock.calls[0];
    const submissionId = firstCall[5];
    expect(typeof submissionId).toBe("string");
    expect((submissionId as string).length).toBeGreaterThan(0);

    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(issuesApiMock.addComment).toHaveBeenCalledTimes(2));
    // Identical args — same clientSubmissionId means the server replays, never duplicates.
    expect(issuesApiMock.addComment.mock.calls[1]).toEqual(firstCall);

    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // Retry success clears the composer like a normal send.
    expect(textarea).toHaveValue("");
  });

  it("dismisses the banner when the draft diverges; the next send mints a NEW clientSubmissionId", async () => {
    issuesApiMock.addComment.mockRejectedValueOnce(new Error("network error"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "first try" } });
    fireEvent.click(screen.getByText("Send & wake"));
    await screen.findByTestId("composer-send-failed-banner");

    // Keep editing past the failed snapshot — Retry would post stale content
    // and its success-clear would wipe these edits, so the banner must go.
    fireEvent.change(textarea, { target: { value: "first try plus newer edits" } });
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("first try plus newer edits");

    fireEvent.click(screen.getByText("Send & wake"));
    await waitFor(() => expect(issuesApiMock.addComment).toHaveBeenCalledTimes(2));
    const first = issuesApiMock.addComment.mock.calls[0];
    const second = issuesApiMock.addComment.mock.calls[1];
    expect(second[1]).toBe("first try plus newer edits");
    expect(second[5]).not.toBe(first[5]);
  });

  it("Edit dismisses the banner but keeps the draft", async () => {
    issuesApiMock.addComment.mockRejectedValueOnce(new Error("network error"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "edit me" } });
    fireEvent.click(screen.getByText("Send & wake"));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(within(banner).getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("edit me");
    expect(issuesApiMock.addComment).toHaveBeenCalledTimes(1);
  });

  it("Discard dismisses the banner and clears the input and selected files", async () => {
    issuesApiMock.addCommentWithAttachments.mockRejectedValueOnce(new Error("boom"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    const file = new File(["fake"], "evidence.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("workspace-chatbar-file-input"), { target: { files: [file] } });
    fireEvent.change(textarea, { target: { value: "discard me" } });
    fireEvent.click(screen.getByText("Send & wake"));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(within(banner).getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("");
    expect(screen.queryByText("evidence.txt")).not.toBeInTheDocument();
    // No resend happened.
    expect(issuesApiMock.addCommentWithAttachments).toHaveBeenCalledTimes(1);
  });

  it("shows the offline strip and disables send while offline", async () => {
    liveState.connectionState = "offline";
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    const strip = screen.getByTestId("composer-offline-strip");
    expect(strip.textContent).toContain("You're offline");

    fireEvent.change(textarea, { target: { value: "queued while offline" } });
    expect(screen.getByText("Send & wake")).toBeDisabled();

    // The Enter shortcut must not bypass the disabled send either.
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(issuesApiMock.addComment).not.toHaveBeenCalled();
  });

  it("shows the drop overlay on frame dragEnter and attaches dropped files via the shared validation path", async () => {
    renderTimeline();

    const chatbar = await screen.findByTestId("workspace-chatbar");
    fireEvent.dragEnter(chatbar, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByTestId("composer-drop-overlay")).toBeInTheDocument();

    const file = new File(["fake"], "dropped.png", { type: "image/png" });
    fireEvent.drop(chatbar, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(screen.queryByTestId("composer-drop-overlay")).not.toBeInTheDocument();
    expect(await screen.findByText("dropped.png")).toBeInTheDocument();
  });

  it("removing a selected file dismisses the banner — Retry must never post a removed file", async () => {
    issuesApiMock.addCommentWithAttachments.mockRejectedValueOnce(new Error("boom"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    const file = new File(["fake"], "sensitive.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("workspace-chatbar-file-input"), { target: { files: [file] } });
    fireEvent.change(textarea, { target: { value: "with file" } });
    fireEvent.click(screen.getByText("Send & wake"));
    await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(screen.getByRole("button", { name: "Remove sensitive.txt" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    // No resend happened — the stale snapshot (with the removed file) is unreachable.
    expect(issuesApiMock.addCommentWithAttachments).toHaveBeenCalledTimes(1);
  });

  it("adding a file dismisses the banner; a fully rejected add leaves it up", async () => {
    issuesApiMock.addComment.mockRejectedValueOnce(new Error("network error"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "text only" } });
    fireEvent.click(screen.getByText("Send & wake"));
    await screen.findByTestId("composer-send-failed-banner");

    // A rejected file leaves the tray unchanged — no divergence, banner stays.
    const unsupported = new File(["fake"], "script.exe", { type: "application/x-msdownload" });
    fireEvent.change(screen.getByTestId("workspace-chatbar-file-input"), { target: { files: [unsupported] } });
    expect(screen.getByTestId("composer-send-failed-banner")).toBeInTheDocument();

    const file = new File(["fake"], "added.png", { type: "image/png" });
    fireEvent.change(screen.getByTestId("workspace-chatbar-file-input"), { target: { files: [file] } });
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
  });

  it("the @ mention button insert dismisses the banner (divergence via mention.onChange)", async () => {
    issuesApiMock.addComment.mockRejectedValueOnce(new Error("network error"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "mention me" } });
    fireEvent.click(screen.getByText("Send & wake"));
    await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(screen.getByRole("button", { name: "Mention someone" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
  });

  it("Retry is a no-op while offline", async () => {
    issuesApiMock.addComment.mockRejectedValueOnce(new Error("network error"));
    const { rerenderTimeline } = renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "retry offline" } });
    fireEvent.click(screen.getByText("Send & wake"));
    await screen.findByTestId("composer-send-failed-banner");

    liveState.connectionState = "offline";
    rerenderTimeline();

    const banner = screen.getByTestId("composer-send-failed-banner");
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    // Flush the (would-be) async mutation before asserting nothing was sent.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(issuesApiMock.addComment).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("composer-send-failed-banner")).toBeInTheDocument();
  });

  it("mid-retry divergence never re-arms the stale banner (removed file stays unreachable)", async () => {
    issuesApiMock.addCommentWithAttachments.mockRejectedValueOnce(new Error("boom"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    const file = new File(["fake"], "sensitive.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("workspace-chatbar-file-input"), { target: { files: [file] } });
    fireEvent.change(textarea, { target: { value: "with file" } });
    fireEvent.click(screen.getByText("Send & wake"));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    // Hang the retry so we can mutate the tray while it is in flight.
    let rejectRetry!: (err: Error) => void;
    issuesApiMock.addCommentWithAttachments.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectRetry = reject; }),
    );
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(issuesApiMock.addCommentWithAttachments).toHaveBeenCalledTimes(2));

    // Divergence while retrying: the dismiss is suppressed (banner shows Retrying…)…
    fireEvent.click(screen.getByRole("button", { name: "Remove sensitive.txt" }));
    expect(screen.getByTestId("composer-send-failed-banner")).toBeInTheDocument();

    // …but when the retry fails, the failure path must NOT re-arm the stale
    // snapshot — a second Retry would post the removed (possibly sensitive) file.
    await act(async () => {
      rejectRetry(new Error("still failing"));
    });
    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // The stale snapshot stayed unreachable — nothing was re-sent.
    expect(issuesApiMock.addCommentWithAttachments).toHaveBeenCalledTimes(2);
  });

  it("frame drag-drop still routes through attachment validation (oversized dropped file rejected)", async () => {
    renderTimeline();

    const chatbar = await screen.findByTestId("workspace-chatbar");
    const oversized = new File(["fake"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: COMPOSER_MAX_ATTACHMENT_BYTES + 1,
    });
    fireEvent.dragEnter(chatbar, { dataTransfer: { types: ["Files"], files: [] } });
    fireEvent.drop(chatbar, { dataTransfer: { types: ["Files"], files: [oversized] } });

    expect(await screen.findByRole("alert")).toHaveTextContent("huge.pdf exceeds the 10 MB attachment limit");
    expect(screen.queryByText("huge.pdf")).not.toBeInTheDocument();
  });

  it("unchecking interrupt after a failure dismisses the banner — Retry must never post a stale interrupt", async () => {
    heartbeatsApiMock.liveRunsForIssue.mockResolvedValue([makeLiveRun("run-live-int")]);
    issuesApiMock.addComment.mockRejectedValueOnce(new Error("network error"));
    renderTimeline();

    const interrupt = within(await screen.findByTestId("workspace-chatbar-interrupt")).getByRole("checkbox");
    fireEvent.click(interrupt);
    const textarea = screen.getByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "stop and do this instead" } });
    fireEvent.click(screen.getByText("Send"));
    await screen.findByTestId("composer-send-failed-banner");
    // The failed attempt snapshotted interrupt: true.
    expect(issuesApiMock.addComment.mock.calls[0][3]).toBe(true);

    // Unchecking interrupt is divergence — Retry would still interrupt the run.
    fireEvent.click(interrupt);
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(issuesApiMock.addComment).toHaveBeenCalledTimes(1);
  });

  it("toggling Re-open after a failure dismisses the banner", async () => {
    issuesApiMock.get.mockResolvedValue({ ...mockIssue, status: "done" });
    issuesApiMock.addComment.mockRejectedValueOnce(new Error("network error"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "reopen flip" } });
    fireEvent.click(screen.getByText("Send & wake"));
    await screen.findByTestId("composer-send-failed-banner");
    // The failed attempt snapshotted reopen: true (the default on a closed task).
    expect(issuesApiMock.addComment.mock.calls[0][2]).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: /Re-open task/i }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(issuesApiMock.addComment).toHaveBeenCalledTimes(1);
  });

  it("a retry that succeeds AFTER an interrupt toggle mid-flight keeps the newer toggle and draft (revision guard)", async () => {
    heartbeatsApiMock.liveRunsForIssue.mockResolvedValue([makeLiveRun("run-live-rev")]);
    issuesApiMock.addComment.mockRejectedValueOnce(new Error("network error"));
    renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    fireEvent.change(textarea, { target: { value: "hold my draft" } });
    fireEvent.click(screen.getByText("Send"));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    // Retry hangs; while it is in flight the user opts INTO interrupting.
    let resolveRetry!: () => void;
    issuesApiMock.addComment.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveRetry = resolve; }),
    );
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(issuesApiMock.addComment).toHaveBeenCalledTimes(2));

    const interrupt = within(screen.getByTestId("workspace-chatbar-interrupt")).getByRole("checkbox");
    fireEvent.click(interrupt);

    await act(async () => { resolveRetry(); });
    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // Retry itself posted the ORIGINAL snapshot (no interrupt)…
    expect(issuesApiMock.addComment.mock.calls[1]).toEqual(issuesApiMock.addComment.mock.calls[0]);
    // …but the success-clear must NOT wipe the newer control state or draft.
    expect(interrupt).toBeChecked();
    expect(textarea).toHaveValue("hold my draft");
  });

  it("switching tasks clears the banner, snapshot, and tray — Retry must never post into a different task", async () => {
    issuesApiMock.addCommentWithAttachments.mockRejectedValueOnce(new Error("boom"));
    const { rerenderTimeline } = renderTimeline();

    const textarea = await screen.findByPlaceholderText("Message Alpha Agent...");
    const file = new File(["fake"], "task-a-file.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("workspace-chatbar-file-input"), { target: { files: [file] } });
    fireEvent.change(textarea, { target: { value: "meant for task A" } });
    fireEvent.click(screen.getByText("Send & wake"));
    await screen.findByTestId("composer-send-failed-banner");

    // Entity switch: same mounted component, different task.
    rerenderTimeline({ issueId: "issue-2" });

    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    // The tray must not leak into the other task either.
    await waitFor(() => expect(screen.queryByText("task-a-file.txt")).not.toBeInTheDocument());
    // The snapshot is unreachable — nothing was re-sent anywhere.
    expect(issuesApiMock.addCommentWithAttachments).toHaveBeenCalledTimes(1);
  });
});

