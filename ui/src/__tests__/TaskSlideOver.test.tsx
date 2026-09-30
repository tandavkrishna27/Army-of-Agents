import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

// Mock @mdxeditor/editor before any imports to avoid CSS-in-ESM cycle
vi.mock("@mdxeditor/editor", () => ({
  CodeMirrorEditor: {},
  MDXEditor: () => null,
  headingsPlugin: () => ({}),
  listsPlugin: () => ({}),
  quotePlugin: () => ({}),
  thematicBreakPlugin: () => ({}),
  markdownShortcutPlugin: () => ({}),
  toolbarPlugin: () => ({}),
  BoldItalicUnderlineToggles: () => null,
  ListsToggle: () => null,
  BlockTypeSelect: () => null,
  CreateLink: () => null,
  linkPlugin: () => ({}),
  linkDialogPlugin: () => ({}),
  codeBlockPlugin: () => ({}),
  codeMirrorPlugin: () => ({}),
}));

// --- We test the component's API surface by mocking heavy dependencies ---

const mockOnClose = vi.fn();
// Stable toast spy so tests can assert on onError/onSuccess toasts. Hoisted so it
// exists before the ToastContext mock factory runs.
const mockPushToast = vi.hoisted(() => vi.fn());
const mockIssue = {
  id: "issue-1",
  title: "Fix login bug",
  description: "The login page has a bug",
  status: "in_progress",
  priority: "high",
  identifier: "TC-1",
  assigneeAgentId: null,
  assigneeUserId: null,
  projectId: null,
  parentId: null,
  goalId: null,
  labels: ["bug"],
  workMode: "standard" as const,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// Default useQuery implementation shared by the mock factory and beforeEach.
// Tests that need bespoke query data override this per-test; beforeEach restores
// it so tests stay order-independent (a leaked override must not bleed forward).
function defaultUseQueryImpl({ queryKey }: any) {
  const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
  // Return mock issue for the detail query
  if (key.includes("detail")) {
    return { data: mockIssue, isLoading: false, error: null };
  }
  // Return empty arrays for list-type queries
  if (key.includes("comments") || key.includes("activity") ||
      key.includes("runs") || key.includes("approvals") ||
      key.includes("attachments") || key.includes("liveRuns") ||
      key.includes("dependencies") || key.includes("list") ||
      key.includes("agents") || key.includes("projects") ||
      key.includes("contextBundles")) {
    return { data: [], isLoading: false, error: null };
  }
  // activeRun returns null
  if (key.includes("activeRun")) {
    return { data: null, isLoading: false, error: null };
  }
  // Artifacts — return null (no linked artifact)
  if (key.includes("artifacts")) {
    return { data: null, isLoading: false, error: null };
  }
  // Detected outputs — return empty array
  if (key.includes("detected-outputs")) {
    return { data: [], isLoading: false, error: null };
  }
  // Execution workspaces — return null by default (no workspace)
  if (key.includes("executionWorkspaces")) {
    return { data: null, isLoading: false, error: null };
  }
  return { data: undefined, isLoading: false, error: null };
}

// Mock all heavy dependencies
const mockNavigate = vi.fn();
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    Link: actual.Link,
    NavLink: actual.NavLink,
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "comp-1", selectedCompany: { id: "comp-1", issuePrefix: "TC" } }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({
    permissions: {
      canAssignTasks: true,
      canInviteUsers: true,
      canManageRoles: true,
      canEditIdentityMemory: true,
    },
  }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(defaultUseQueryImpl),
    useQueries: ({ queries }: any) =>
      (queries ?? []).map(() => ({ data: null, isLoading: false, error: null })),
    useMutation: (options: any = {}) => ({
      // Route the mutationFn result through onSuccess/onError so tests can drive
      // the error path (a rejecting mutationFn must invoke onError, like the real
      // useMutation does). We still call mutationFn synchronously first so existing
      // "API was called with …" assertions keep working.
      mutate: vi.fn((variables: unknown) => {
        try {
          const result = options.mutationFn?.(variables);
          Promise.resolve(result).then(
            (data) => options.onSuccess?.(data, variables, undefined),
            (error) => options.onError?.(error, variables, undefined),
          );
        } catch (error) {
          options.onError?.(error, variables, undefined);
        }
      }),
      mutateAsync: vi.fn((variables: unknown) => options.mutationFn?.(variables) ?? Promise.resolve({})),
      isPending: false,
      isSuccess: false,
      isError: false,
    }),
    useQueryClient: () => ({
      invalidateQueries: vi.fn(),
      setQueryData: vi.fn(),
    }),
  };
});

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    issues: {
      detail: (id: string) => ["issues", "detail", id],
      list: (id: string) => ["issues", "list", id],
      listTouchedByMe: (id: string) => ["issues", "listTouchedByMe", id],
      listUnreadTouchedByMe: (id: string) => ["issues", "listUnreadTouchedByMe", id],
      comments: (id: string) => ["issues", "comments", id],
      activity: (id: string) => ["issues", "activity", id],
      runs: (id: string) => ["issues", "runs", id],
      approvals: (id: string) => ["issues", "approvals", id],
      attachments: (id: string) => ["issues", "attachments", id],
      liveRuns: (id: string) => ["issues", "liveRuns", id],
      activeRun: (id: string) => ["issues", "activeRun", id],
      dependencies: (id: string) => ["issues", "dependencies", id],
      documents: (id: string) => ["issues", "documents", id],
    },
    sidebarBadges: (id: string) => ["sidebarBadges", id],
    agents: { list: (id: string) => ["agents", "list", id] },
    projects: { list: (id: string) => ["projects", "list", id], detail: (id: string) => ["projects", "detail", id] },
    goals: { list: (id: string) => ["goals", "list", id] },
    artifacts: {
      byIssue: (id: string) => ["artifacts", "issue", id],
      detail: (id: string) => ["artifacts", "detail", id],
    },
    detectedOutputs: {
      byIssue: (id: string) => ["detected-outputs", "issue", id],
      byRun: (id: string) => ["detected-outputs", "run", id],
    },
    activity: (id: string) => ["activity", id],
    auth: { session: "auth.session" },
    executionWorkspaces: {
      detail: (id: string) => ["executionWorkspaces", "detail", id],
      list: (id: string) => ["executionWorkspaces", id],
      listForProject: (cId: string, pId: string) => ["executionWorkspaces", cId, pId],
    },
    workQuestions: {
      all: (companyId: string) => ["work-questions", companyId],
    },
  },
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: () => ({ orderedProjects: [], reorder: vi.fn() }),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
    update: vi.fn(),
    addComment: vi.fn(),
    markRead: vi.fn(),
    delete: vi.fn(),
    listContextBundles: vi.fn().mockResolvedValue([]),
    updateContextBundleItemIncluded: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../api/dependencies", () => ({
  dependenciesApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
}));

vi.mock("../api/activity", () => ({
  activityApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: { triggerByIssueId: vi.fn() },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "u1" } }) },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn().mockResolvedValue({ functionType: "general" }) },
}));

vi.mock("../api/artifacts", () => ({
  artifactsApi: { getByIssueId: vi.fn().mockResolvedValue(null), get: vi.fn(), addVersion: vi.fn() },
}));

vi.mock("../api/output-detection", () => ({
  outputDetectionApi: { listForIssue: vi.fn().mockResolvedValue([]), confirm: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("../api/context-packaging", () => ({
  contextPackagingApi: {
    getContextPackage: vi.fn().mockResolvedValue({ markdown: "# Test context", tokenEstimate: 100 }),
  },
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    get: vi.fn().mockResolvedValue(null),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../lib/utils", () => ({
  relativeTime: () => "2m ago",
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
  formatTokens: (v: number) => String(v),
}));

// Mock all child components that are complex
vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, multilineAutoSave }: any) => (
    <div data-testid="inline-editor" data-multiline-autosave={multilineAutoSave ? "true" : "false"}>
      {value}
    </div>
  ),
}));

vi.mock("../components/CommentThread", () => ({
  CommentThread: () => <div data-testid="comment-thread">Comments</div>,
}));

vi.mock("../components/IssueProperties", () => ({
  IssueProperties: ({ layout }: any) => (
    <div data-testid="issue-properties" data-layout={layout ?? "default"}>
      Properties
    </div>
  ),
}));

vi.mock("../components/LiveRunWidget", () => ({
  LiveRunWidget: () => null,
}));

vi.mock("../components/StatusIcon", () => ({
  StatusIcon: ({ status }: any) => <span data-testid="status-icon">{status}</span>,
}));

vi.mock("../components/PriorityIcon", () => ({
  PriorityIcon: ({ priority }: any) => <span data-testid="priority-icon">{priority}</span>,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: any) => <span data-testid="status-badge">{status}</span>,
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: any) => <span>{name}</span>,
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: any) => <div data-testid="markdown-body">{children}</div>,
}));

vi.mock("../components/IssueDocumentsSection", () => ({
  IssueDocumentsSection: () => <div data-testid="issue-documents" />,
}));

vi.mock("../components/IssueWorkspaceCard", () => ({
  IssueWorkspaceCard: () => null,
}));

// Mock the Sheet component to just render children when open
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children, onOpenChange }: any) =>
    open ? <div data-testid="sheet" data-open={open}>{children}</div> : null,
  SheetContent: ({
    children,
    side,
    className,
    style,
    showCloseButton: _showCloseButton,
    onPointerDownOutside: _onPointerDownOutside,
    ...props
  }: any) => (
    <div
      data-testid="sheet-content"
      data-side={side ?? "right"}
      className={className}
      style={style}
      {...props}
    >
      {children}
    </div>
  ),
  SheetHeader: ({ children }: any) => <div>{children}</div>,
  SheetTitle: ({ children }: any) => <div>{children}</div>,
  SheetDescription: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className, ...props }: any) => (
    <div className={className} {...props}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children, ...props }: any) => <div data-testid="tabs" {...props}>{children}</div>,
  TabsList: ({ children, className }: any) => <div data-testid="tabs-list" className={className}>{children}</div>,
  TabsTrigger: ({ children, value }: any) => <button data-testid={`tab-${value}`}>{children}</button>,
  TabsContent: ({ children, value, className, ...props }: any) => (
    <div data-testid={`tab-content-${value}`} className={className} {...props}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: any) => <div>{children}</div>,
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: any) => <div>{children}</div>,
  PopoverTrigger: ({ children }: any) => <div>{children}</div>,
  PopoverContent: ({ children }: any) => <div>{children}</div>,
}));

import { issuesApi } from "../api/issues";
import { TaskSlideOver } from "../components/TaskSlideOver";
import { TaskDetail } from "@/components/TaskDetail";

function renderSlideOver(props: { issueId: string | null; open: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskSlideOver issueId={props.issueId} open={props.open} onClose={mockOnClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderTaskDetail(props: {
  issueId: string | null;
  active?: boolean;
  onOpenScopeHandoffItem?: ComponentProps<typeof TaskDetail>["onOpenScopeHandoffItem"];
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskDetail
          issueId={props.issueId}
          active={props.active ?? true}
          onOpenScopeHandoffItem={props.onOpenScopeHandoffItem}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// --- Tests ---

describe("TaskSlideOver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Several tests in this block call vi.mocked(useQuery).mockImplementation(...)
    // for bespoke query data. vi.clearAllMocks() only clears call history, NOT the
    // implementation, so that override would leak into later tests and make them
    // order-dependent. Explicitly restore the default impl here so every test in
    // this block starts from the same query state regardless of run order.
    // (resetAllMocks() can't be used: it would wipe the factory-provided default
    // implementation too, leaving useQuery returning undefined.)
    vi.mocked(useQuery).mockImplementation(defaultUseQueryImpl);
    vi.mocked(issuesApi.update).mockResolvedValue(mockIssue as any);
  });

  it("renders nothing when open=false", () => {
    const { container } = renderSlideOver({ issueId: "issue-1", open: false });
    expect(container.querySelector("[data-testid='sheet']")).not.toBeInTheDocument();
  });

  it("opens as right-side Sheet when issueId is set and open=true", () => {
    renderSlideOver({ issueId: "issue-1", open: true });
    expect(screen.getByTestId("sheet")).toBeInTheDocument();
    expect(screen.getByTestId("sheet-content")).toHaveAttribute("data-side", "right");
  });

  it("keeps focused task state, comments, and activity synchronized with agent work", () => {
    renderSlideOver({ issueId: "issue-1", open: true });

    const queryOptions = vi.mocked(useQuery).mock.calls.map(([options]) => options as any);
    for (const key of [
      ["issues", "detail", "issue-1"],
      ["issues", "comments", "issue-1"],
      ["issues", "activity", "issue-1"],
    ]) {
      expect(queryOptions).toContainEqual(
        expect.objectContaining({ queryKey: key, refetchInterval: 5000 }),
      );
    }
  });

  it("requires review feedback before returning a task to progress", async () => {
    const user = userEvent.setup();
    const reviewIssue = { ...mockIssue, status: "in_review" };
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
      if (key.includes("detail")) return { data: reviewIssue, isLoading: false, error: null } as any;
      return defaultUseQueryImpl({ queryKey });
    });
    vi.mocked(issuesApi.update).mockResolvedValue({ ...reviewIssue, status: "in_progress" } as any);

    renderSlideOver({ issueId: "issue-1", open: true });

    await user.click(screen.getByRole("button", { name: "Request Changes" }));
    const submit = screen.getByRole("button", { name: "Send feedback & resume" });
    expect(screen.getByRole("dialog", { name: "Request changes" })).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText("Review feedback"), "Add measurable acceptance criteria.");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(issuesApi.update).toHaveBeenCalledWith("issue-1", {
      status: "in_progress",
      comment: "Add measurable acceptance criteria.",
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Request changes" })).not.toBeInTheDocument();
    });
  });

  it("uses a wider task panel by default and hides accidental horizontal overflow", () => {
    renderSlideOver({ issueId: "issue-1", open: true });

    const sheet = screen.getByTestId("sheet-content");
    expect(sheet).toHaveAttribute("data-size-mode", "default");
    expect(sheet.className).toContain("task-slide-over-default");
    expect(sheet.className).toContain("overflow-x-hidden");
    expect(sheet.className).toContain("sm:max-w-[min(760px,calc(100vw-32px))]");
  });

  it("lets the user toggle the task panel into a wider mode from the header", async () => {
    const user = userEvent.setup();
    renderSlideOver({ issueId: "issue-1", open: true });

    await user.click(screen.getByLabelText("Expand task panel"));

    const sheet = screen.getByTestId("sheet-content");
    expect(sheet).toHaveAttribute("data-size-mode", "wide");
    expect(sheet.className).toContain("task-slide-over-wide");
    expect(screen.getByLabelText("Collapse task panel")).toBeInTheDocument();
  });

  it("renders an edge resize handle for widening the task panel", () => {
    renderSlideOver({ issueId: "issue-1", open: true });

    const handle = screen.getByTestId("task-slide-over-resize-handle");
    expect(handle).toHaveAttribute("aria-label", "Resize task panel");
    expect(handle.className).toContain("cursor-ew-resize");
  });

  it("renders task title when issue data is loaded", () => {
    renderSlideOver({ issueId: "issue-1", open: true });
    // Two InlineEditors: one for title, one for description
    const editors = screen.getAllByTestId("inline-editor");
    expect(editors[0]).toHaveTextContent("Fix login bug");
    expect(editors[1]).toHaveTextContent("The login page has a bug");
  });

  it("autosaves the task description editor without changing title editing behavior", () => {
    renderSlideOver({ issueId: "issue-1", open: true });

    const editors = screen.getAllByTestId("inline-editor");
    expect(editors[0]).toHaveAttribute("data-multiline-autosave", "false");
    expect(editors[1]).toHaveAttribute("data-multiline-autosave", "true");
  });

  it("renders the task detail body without opening a Sheet when rendered directly", () => {
    renderTaskDetail({ issueId: "issue-1" });
    expect(screen.queryByTestId("sheet")).not.toBeInTheDocument();
    expect(screen.getByTestId("issue-properties")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-artifacts")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-activity")).toBeInTheDocument();
  });

  it("opens task details on Overview with the compact redesign tab inventory", () => {
    renderTaskDetail({ issueId: "issue-1" });

    expect(screen.getByTestId("tabs")).toHaveAttribute("value", "overview");
    expect(screen.getByTestId("tab-overview")).toHaveTextContent("Overview");
    expect(screen.getByTestId("tab-work")).toHaveTextContent("Work");
    expect(screen.getByTestId("tab-comments")).toHaveTextContent("Comments");
    expect(screen.getByTestId("tab-subtasks")).toHaveTextContent("Sub-tasks");
    expect(screen.getByTestId("tab-activity")).toHaveTextContent("Activity");
    expect(screen.queryByTestId("tab-artifacts")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tab-subissues")).not.toBeInTheDocument();
  });

  it("previews the newest comment on Overview when comments are newest-first", () => {
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
      if (key.includes("detail")) return { data: mockIssue, isLoading: false, error: null } as any;
      if (key.includes("comments")) {
        return {
          data: [
            {
              id: "comment-newest",
              issueId: "issue-1",
              body: "Newest comment should be previewed",
              createdAt: "2026-07-08T06:00:00.000Z",
            },
            {
              id: "comment-oldest",
              issueId: "issue-1",
              body: "Oldest comment should stay hidden",
              createdAt: "2026-07-07T06:00:00.000Z",
            },
          ],
          isLoading: false,
          error: null,
        } as any;
      }
      return defaultUseQueryImpl({ queryKey });
    });

    renderTaskDetail({ issueId: "issue-1" });

    expect(screen.getByText("Latest comment")).toBeInTheDocument();
    expect(screen.getByText("Newest comment should be previewed")).toBeInTheDocument();
    expect(screen.queryByText("Oldest comment should stay hidden")).not.toBeInTheDocument();
  });

  it("previews substantive work instead of a newer automatic run summary", () => {
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
      if (key.includes("detail")) return { data: mockIssue, isLoading: false, error: null } as any;
      if (key.includes("comments")) {
        return {
          data: [
            {
              id: "comment-summary",
              issueId: "issue-1",
              authorType: "system",
              presentation: { kind: "system_notice", title: "Run summary" },
              body: "**Run Summary** - succeeded",
              createdAt: "2026-07-08T06:01:00.000Z",
            },
            {
              id: "comment-delivery",
              issueId: "issue-1",
              authorType: "agent",
              presentation: null,
              body: "Acceptance checklist and recommendation",
              createdAt: "2026-07-08T06:00:00.000Z",
            },
          ],
          isLoading: false,
          error: null,
        } as any;
      }
      return defaultUseQueryImpl({ queryKey });
    });

    renderTaskDetail({ issueId: "issue-1" });

    expect(screen.getByText("Acceptance checklist and recommendation")).toBeInTheDocument();
    expect(screen.queryByText("**Run Summary** - succeeded")).not.toBeInTheDocument();
  });

  it("gives the comments tab a bounded chat-pane layout so the composer can stay docked", () => {
    renderTaskDetail({ issueId: "issue-1" });

    const commentsContent = screen.getByTestId("task-comments-tab-content");

    expect(commentsContent).toHaveClass("flex");
    expect(commentsContent).toHaveClass("flex-col");
    expect(commentsContent).toHaveClass("min-h-0");
    expect(commentsContent).toHaveClass("overflow-hidden");
  });

  it("shows scope handoff context for discussion-created tasks", () => {
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
      if (key.includes("detail")) return { data: mockIssue, isLoading: false, error: null } as any;
      if (key.includes("contextBundles")) {
        return {
          data: [
            {
              id: "bundle-1",
              companyId: "comp-1",
              sourceIssueId: null,
              sourceDiscussionId: "thread-1",
              sourceKind: "discussion_scope",
              targetIssueId: "issue-1",
              brief: "Use selected scope evidence.",
              items: [
                {
                  id: "item-1",
                  itemType: "discussion_entry",
                  sourceId: "entry-1",
                  label: "Founder request",
                  metadata: { excerpt: "Need guided onboarding cleanup." },
                },
                {
                  id: "item-2",
                  itemType: "url",
                  sourceId: null,
                  label: "Reference",
                  metadata: { url: "https://example.com/ref" },
                },
              ],
            },
          ],
          isLoading: false,
          error: null,
        } as any;
      }
      if (key.includes("comments") || key.includes("activity") || key.includes("runs") ||
          key.includes("approvals") || key.includes("attachments") || key.includes("liveRuns") ||
          key.includes("dependencies") || key.includes("list") || key.includes("agents") ||
          key.includes("projects")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("activeRun")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("artifacts")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("detected-outputs")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("executionWorkspaces")) return { data: null, isLoading: false, error: null } as any;
      return { data: undefined, isLoading: false, error: null } as any;
    });

    renderTaskDetail({ issueId: "issue-1" });

    expect(screen.getByText("Scope handoff")).toBeInTheDocument();
    expect(screen.getByText("Use selected scope evidence.")).toBeInTheDocument();
    expect(screen.getByText("Founder request")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/ref")).toBeInTheDocument();
  });

  it("renders a self-contained Open button through the real TaskSlideOver shell (no parent callback) and opens the URL on click", async () => {
    // Regression guard: TaskSlideOver renders TaskDetail WITHOUT
    // onOpenScopeHandoffItem (the production standalone path — Tasks page,
    // Project/Crew board, Commander viewer). Before the integration merge the
    // slide-over opened scope-handoff items itself; the ported ScopeHandoffSection
    // accidentally gated the Open button on the parent callback existing. This
    // test asserts the button renders AND triggers the self-contained window.open.
    const user = userEvent.setup();
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
      if (key.includes("detail")) return { data: mockIssue, isLoading: false, error: null } as any;
      if (key.includes("contextBundles")) {
        return {
          data: [
            {
              id: "bundle-1",
              companyId: "comp-1",
              sourceIssueId: null,
              sourceDiscussionId: "thread-1",
              sourceKind: "discussion_scope",
              targetIssueId: "issue-1",
              brief: "Use selected sources for this task.",
              items: [
                {
                  id: "item-url",
                  itemType: "url",
                  sourceId: null,
                  label: "Reference URL",
                  metadata: { url: "https://example.com/ref" },
                },
              ],
            },
          ],
          isLoading: false,
          error: null,
        } as any;
      }
      if (key.includes("comments") || key.includes("activity") || key.includes("runs") ||
          key.includes("approvals") || key.includes("attachments") || key.includes("liveRuns") ||
          key.includes("dependencies") || key.includes("list") || key.includes("agents") ||
          key.includes("projects")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("activeRun")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("artifacts")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("detected-outputs")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("executionWorkspaces")) return { data: null, isLoading: false, error: null } as any;
      return { data: undefined, isLoading: false, error: null } as any;
    });

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      // Real shell: TaskSlideOver → TaskDetail WITHOUT onOpenScopeHandoffItem.
      renderSlideOver({ issueId: "issue-1", open: true });

      const openButton = screen.getByRole("button", { name: /Open handoff item: Reference URL/i });
      expect(openButton).toBeInTheDocument();

      await user.click(openButton);

      expect(openSpy).toHaveBeenCalledWith("https://example.com/ref", "_blank", "noopener,noreferrer");
    } finally {
      openSpy.mockRestore();
    }
  });

  it("shows editable scope handoff between dependencies and attachments", async () => {
    const user = userEvent.setup();
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
      if (key.includes("detail")) return { data: mockIssue, isLoading: false, error: null } as any;
      if (key.includes("contextBundles")) {
        return {
          data: [
            {
              id: "bundle-1",
              companyId: "comp-1",
              sourceIssueId: null,
              sourceDiscussionId: "thread-1",
              sourceScopeVersionId: "scope-v1",
              sourceKind: "discussion_scope",
              targetIssueId: "issue-1",
              brief: "Use selected sources for this task.",
              items: [
                {
                  id: "item-1",
                  itemType: "asset",
                  sourceId: "asset-1",
                  label: "interview-notes.pdf",
                  metadata: { contentType: "application/pdf" },
                },
                {
                  id: "item-artifact",
                  itemType: "artifact",
                  sourceId: "artifact-1",
                  label: "Design spec",
                  metadata: { artifactVersionId: "version-1" },
                },
                {
                  id: "item-2",
                  itemType: "url",
                  sourceId: null,
                  label: "Reference URL",
                  metadata: { url: "https://example.com/ref", includeInAgentContext: false },
                },
              ],
            },
          ],
          isLoading: false,
          error: null,
        } as any;
      }
      if (key.includes("comments") || key.includes("activity") || key.includes("runs") ||
          key.includes("approvals") || key.includes("attachments") || key.includes("liveRuns") ||
          key.includes("dependencies") || key.includes("list") || key.includes("agents") ||
          key.includes("projects")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("activeRun")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("artifacts")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("detected-outputs")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("executionWorkspaces")) return { data: null, isLoading: false, error: null } as any;
      return { data: undefined, isLoading: false, error: null } as any;
    });

    renderTaskDetail({ issueId: "issue-1", onOpenScopeHandoffItem: vi.fn() });

    const dependencies = screen.getByText("Dependencies");
    const handoff = screen.getByTestId("task-scope-handoff");
    const attachments = screen.getByText("Attachments");
    expect(dependencies.compareDocumentPosition(handoff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(handoff.compareDocumentPosition(attachments) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("interview-notes.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open handoff item: interview-notes\.pdf/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open handoff item: Design spec/i })).toBeInTheDocument();
    expect(screen.getAllByText("In context")).toHaveLength(2);
    expect(screen.getByText("Excluded")).toBeInTheDocument();
    expect(screen.queryByText("Included in agent context")).not.toBeInTheDocument();
    expect(screen.queryByText("Excluded from agent context")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Exclude interview-notes\.pdf from agent context/i }));
    expect(issuesApi.updateContextBundleItemIncluded).toHaveBeenCalledWith("issue-1", "item-1", false);
  });

  it("surfaces an error toast when the include/exclude toggle is rejected by the server", async () => {
    const user = userEvent.setup();
    // Server rejects the include/exclude change — the optimistic toggle must not
    // silently stick (context-leak risk); onError shows a warn toast.
    vi.mocked(issuesApi.updateContextBundleItemIncluded).mockRejectedValueOnce(
      new Error("forbidden"),
    );
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
      if (key.includes("detail")) return { data: mockIssue, isLoading: false, error: null } as any;
      if (key.includes("contextBundles")) {
        return {
          data: [
            {
              id: "bundle-1",
              companyId: "comp-1",
              sourceIssueId: null,
              sourceDiscussionId: "thread-1",
              sourceKind: "discussion_scope",
              targetIssueId: "issue-1",
              brief: "Use selected sources for this task.",
              items: [
                {
                  id: "item-1",
                  itemType: "asset",
                  sourceId: "asset-1",
                  label: "interview-notes.pdf",
                  metadata: { contentType: "application/pdf" },
                },
              ],
            },
          ],
          isLoading: false,
          error: null,
        } as any;
      }
      if (key.includes("comments") || key.includes("activity") || key.includes("runs") ||
          key.includes("approvals") || key.includes("attachments") || key.includes("liveRuns") ||
          key.includes("dependencies") || key.includes("list") || key.includes("agents") ||
          key.includes("projects")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("activeRun")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("artifacts")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("detected-outputs")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("executionWorkspaces")) return { data: null, isLoading: false, error: null } as any;
      return { data: undefined, isLoading: false, error: null } as any;
    });

    renderTaskDetail({ issueId: "issue-1", onOpenScopeHandoffItem: vi.fn() });

    await user.click(
      screen.getByRole("button", { name: /Exclude interview-notes\.pdf from agent context/i }),
    );

    expect(issuesApi.updateContextBundleItemIncluded).toHaveBeenCalledWith("issue-1", "item-1", false);
    await waitFor(() => {
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({ tone: "warn" }),
      );
    });
  });

  it("opens scope handoff items through the embedded task viewer callback", async () => {
    const user = userEvent.setup();
    const onOpenScopeHandoffItem = vi.fn();
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
      if (key.includes("detail")) return { data: mockIssue, isLoading: false, error: null } as any;
      if (key.includes("contextBundles")) {
        return {
          data: [
            {
              id: "bundle-1",
              companyId: "comp-1",
              sourceIssueId: null,
              sourceDiscussionId: "thread-1",
              sourceKind: "discussion_scope",
              targetIssueId: "issue-1",
              brief: "Use selected sources for this task.",
              items: [
                {
                  id: "item-url",
                  itemType: "url",
                  sourceId: null,
                  label: "Reference URL",
                  metadata: { url: "https://example.com/ref" },
                },
              ],
            },
          ],
          isLoading: false,
          error: null,
        } as any;
      }
      if (key.includes("comments") || key.includes("activity") || key.includes("runs") ||
          key.includes("approvals") || key.includes("attachments") || key.includes("liveRuns") ||
          key.includes("dependencies") || key.includes("list") || key.includes("agents") ||
          key.includes("projects")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("activeRun")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("artifacts")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("detected-outputs")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("executionWorkspaces")) return { data: null, isLoading: false, error: null } as any;
      return { data: undefined, isLoading: false, error: null } as any;
    });

    renderTaskDetail({
      issueId: "issue-1",
      onOpenScopeHandoffItem,
    });

    await user.click(screen.getByRole("button", { name: /Open handoff item: Reference URL/i }));

    expect(onOpenScopeHandoffItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "item-url", itemType: "url" }),
    );
  });

  it("opens URL scope handoff rows through the scope handoff callback", async () => {
    const user = userEvent.setup();
    const onOpenScopeHandoffItem = vi.fn();
    vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
      const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
      if (key.includes("detail")) return { data: mockIssue, isLoading: false, error: null } as any;
      if (key.includes("contextBundles")) {
        return {
          data: [
            {
              id: "bundle-1",
              companyId: "comp-1",
              sourceIssueId: null,
              sourceDiscussionId: "thread-1",
              sourceKind: "discussion_scope",
              targetIssueId: "issue-1",
              brief: "Use selected sources for this task.",
              items: [
                {
                  id: "item-url",
                  itemType: "url",
                  sourceId: null,
                  label: "Reference URL",
                  metadata: { url: "https://example.com/ref" },
                },
              ],
            },
          ],
          isLoading: false,
          error: null,
        } as any;
      }
      if (key.includes("comments") || key.includes("activity") || key.includes("runs") ||
          key.includes("approvals") || key.includes("attachments") || key.includes("liveRuns") ||
          key.includes("dependencies") || key.includes("list") || key.includes("agents") ||
          key.includes("projects")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("activeRun")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("artifacts")) return { data: null, isLoading: false, error: null } as any;
      if (key.includes("detected-outputs")) return { data: [], isLoading: false, error: null } as any;
      if (key.includes("executionWorkspaces")) return { data: null, isLoading: false, error: null } as any;
      return { data: undefined, isLoading: false, error: null } as any;
    });

    renderTaskDetail({ issueId: "issue-1", onOpenScopeHandoffItem });
    await user.click(screen.getByRole("button", { name: /Open handoff item: Reference URL/i }));

    expect(onOpenScopeHandoffItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "item-url",
        itemType: "url",
        metadata: expect.objectContaining({ url: "https://example.com/ref" }),
      }),
    );
  });

  it("renders properties section", () => {
    renderSlideOver({ issueId: "issue-1", open: true });
    expect(screen.getByTestId("issue-properties")).toBeInTheDocument();
  });

  it("folds artifacts into Work instead of rendering an Artifacts tab trigger", () => {
    renderSlideOver({ issueId: "issue-1", open: true });
    expect(screen.queryByTestId("tab-artifacts")).not.toBeInTheDocument();
    expect(screen.getByTestId("tab-work")).toHaveTextContent("Work");
  });

  it("renders Open in LLM button options", () => {
    renderSlideOver({ issueId: "issue-1", open: true });
    // The LLM menu popover content renders inline in our mock
    expect(screen.getByText("Copy context to clipboard")).toBeInTheDocument();
    expect(screen.getByText("Open in Claude")).toBeInTheDocument();
    expect(screen.getByText("Open in ChatGPT")).toBeInTheDocument();
  });

  it("calls onClose when X button is clicked", async () => {
    const user = userEvent.setup();
    renderSlideOver({ issueId: "issue-1", open: true });

    await user.click(screen.getByTestId("close-button"));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it("renders the five agreed redesign tab triggers inside Sheet", () => {
    renderSlideOver({ issueId: "issue-1", open: true });
    expect(screen.getByTestId("tab-overview")).toBeInTheDocument();
    expect(screen.getByTestId("tab-work")).toBeInTheDocument();
    expect(screen.getByTestId("tab-comments")).toBeInTheDocument();
    expect(screen.getByTestId("tab-subtasks")).toBeInTheDocument();
    expect(screen.getByTestId("tab-activity")).toBeInTheDocument();
    expect(screen.queryByTestId("tab-artifacts")).not.toBeInTheDocument();
  });

  it("keeps tab overflow as a hidden-scrollbar fallback instead of showing a tab scrollbar", () => {
    renderSlideOver({ issueId: "issue-1", open: true });

    const tabsList = screen.getByTestId("tabs-list");
    expect(tabsList.className).toContain("overflow-x-auto");
    expect(tabsList.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(tabsList.className).toContain("[scrollbar-width:none]");
  });

  it("renders StatusIcon and PriorityIcon in Sheet header", () => {
    renderSlideOver({ issueId: "issue-1", open: true });
    expect(screen.getByTestId("status-icon")).toBeInTheDocument();
    expect(screen.getByTestId("priority-icon")).toBeInTheDocument();
  });

  it("renders popovers (LLM and more-menu) within Sheet without crashing", () => {
    // Popovers are mocked to render inline — verifies they don't break in Sheet context
    renderSlideOver({ issueId: "issue-1", open: true });
    expect(screen.getByText("Copy context to clipboard")).toBeInTheDocument();
    expect(screen.getByText("Hide this Task")).toBeInTheDocument();
  });

  describe("workspace section", () => {
    it("renders contextual empty state when issue has no executionWorkspaceId", () => {
      // mockIssue has no executionWorkspaceId and no projectId
      renderSlideOver({ issueId: "issue-1", open: true });
      expect(screen.getByTestId("workspace-section")).toBeInTheDocument();
      expect(screen.getByTestId("workspace-empty-state")).toBeInTheDocument();
      expect(screen.getByText(/No project assigned/)).toBeInTheDocument();
    });

    it("does not show provisioning for a stale execution lock when no run is active", () => {
      vi.mocked(useQuery).mockImplementation(makeQueryImpl({
        ...mockIssue,
        executionLockedAt: new Date().toISOString(),
        executionWorkspaceId: null,
      } as typeof mockIssue));

      renderSlideOver({ issueId: "issue-1", open: true });

      expect(screen.getByTestId("workspace-empty-state")).toHaveTextContent(/No project assigned/);
      expect(screen.queryByText(/Provisioning workspace/)).not.toBeInTheDocument();
    });

    it("shows a truthful fallback workspace state when an agent is running without a project", () => {
      vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
        const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
        if (key.includes("detail")) {
          return {
            data: {
              ...mockIssue,
              executionLockedAt: new Date().toISOString(),
              executionWorkspaceId: null,
            },
            isLoading: false,
            error: null,
          } as any;
        }
        if (key.includes("activeRun")) return { data: { id: "run-1", status: "running" }, isLoading: false, error: null } as any;
        return makeQueryImpl(mockIssue)({ queryKey });
      });

      renderSlideOver({ issueId: "issue-1", open: true });

      expect(screen.getByTestId("workspace-empty-state")).toHaveTextContent(/without a project workspace/);
      expect(screen.queryByText(/Provisioning workspace/)).not.toBeInTheDocument();
    });

    it("shows provisioning only when an active run expects a project workspace", () => {
      vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
        const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
        if (key.includes("detail")) {
          return {
            data: {
              ...mockIssue,
              projectId: "project-1",
              project: { id: "project-1", executionWorkspacePolicy: { mode: "create_new" } },
              executionLockedAt: new Date().toISOString(),
              executionWorkspaceId: null,
            },
            isLoading: false,
            error: null,
          } as any;
        }
        if (key.includes("activeRun")) return { data: { id: "run-1", status: "running" }, isLoading: false, error: null } as any;
        return makeQueryImpl(mockIssue)({ queryKey });
      });

      renderSlideOver({ issueId: "issue-1", open: true });

      expect(screen.getByTestId("workspace-empty-state")).toHaveTextContent(/Provisioning workspace/);
    });
  });
});

// ── Workspace mode tests (require custom useQuery setup) ──────────────────────

const mockIssueWithWorkspace = {
  id: "issue-1",
  title: "Fix login bug",
  description: "The login page has a bug",
  status: "in_progress",
  priority: "high",
  identifier: "TC-1",
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  projectId: null,
  parentId: null,
  goalId: null,
  labels: ["bug"],
  executionWorkspaceId: "ws-123",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockWorkspaceData = {
  id: "ws-123",
  status: "active",
  branchName: "ENG-42-fix-auth",
  name: "eng-42-fix-auth",
  lastUsedAt: new Date("2026-04-04T10:00:00Z"),
};

function renderSlideOverWithWorkspace() {
  vi.mocked(useQuery).mockImplementation(({ queryKey }: any) => {
    const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
    if (key.includes("executionWorkspaces")) return { data: mockWorkspaceData, isLoading: false, error: null } as any;
    if (key.includes("detail")) return { data: mockIssueWithWorkspace, isLoading: false, error: null } as any;
    if (key.includes("comments") || key.includes("activity") || key.includes("runs") ||
        key.includes("approvals") || key.includes("attachments") || key.includes("liveRuns") ||
        key.includes("dependencies") || key.includes("list") || key.includes("agents") ||
        key.includes("projects")) return { data: [], isLoading: false, error: null } as any;
    if (key.includes("activeRun")) return { data: null, isLoading: false, error: null } as any;
    if (key.includes("artifacts")) return { data: null, isLoading: false, error: null } as any;
    if (key.includes("detected-outputs")) return { data: [], isLoading: false, error: null } as any;
    return { data: undefined, isLoading: false, error: null } as any;
  });

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TaskSlideOver issueId="issue-1" open={true} onClose={mockOnClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Planning mode pill tests ──────────────────────────────────────────────────

function makeQueryImpl(overrideIssue: typeof mockIssue) {
  return ({ queryKey }: any) => {
    const key = Array.isArray(queryKey) ? queryKey.join(".") : String(queryKey);
    if (key.includes("detail")) return { data: overrideIssue, isLoading: false, error: null } as any;
    if (key.includes("comments") || key.includes("activity") || key.includes("runs") ||
        key.includes("approvals") || key.includes("attachments") || key.includes("liveRuns") ||
        key.includes("dependencies") || key.includes("list") || key.includes("agents") ||
        key.includes("projects")) return { data: [], isLoading: false, error: null } as any;
    if (key.includes("activeRun")) return { data: null, isLoading: false, error: null } as any;
    if (key.includes("artifacts")) return { data: null, isLoading: false, error: null } as any;
    if (key.includes("detected-outputs")) return { data: [], isLoading: false, error: null } as any;
    if (key.includes("executionWorkspaces")) return { data: null, isLoading: false, error: null } as any;
    return { data: undefined, isLoading: false, error: null } as any;
  };
}

describe("planning mode pill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default useQuery implementation before each test in this block
    vi.mocked(useQuery).mockImplementation(makeQueryImpl(mockIssue));
    vi.mocked(issuesApi.update).mockResolvedValue(mockIssue as any);
  });

  it("shows Planning pill when workMode is planning", () => {
    vi.mocked(useQuery).mockImplementation(makeQueryImpl({ ...mockIssue, workMode: "planning" as const }));
    renderSlideOver({ issueId: "issue-1", open: true });
    expect(screen.getByText("Planning")).toBeInTheDocument();
  });

  it("does not show Planning pill when workMode is standard", () => {
    renderSlideOver({ issueId: "issue-1", open: true });
    expect(screen.queryByText("Planning")).not.toBeInTheDocument();
  });

  it("shows the last updated timestamp in the task header", () => {
    renderSlideOver({ issueId: "issue-1", open: true });

    expect(screen.getByTestId("task-header-updated-at")).toHaveTextContent("Updated");
  });

  it("offers a standard task action to switch into Planning mode", async () => {
    const user = userEvent.setup();
    renderSlideOver({ issueId: "issue-1", open: true });

    await user.click(screen.getByLabelText("More task actions"));
    await user.click(screen.getByRole("button", { name: /Switch to Planning mode/i }));

    expect(issuesApi.update).toHaveBeenCalledWith("issue-1", expect.objectContaining({ workMode: "planning" }));
  });
});

describe("TaskSlideOver — workspace with executionWorkspaceId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces compact workspace access on the Overview tab", () => {
    renderSlideOverWithWorkspace();
    expect(screen.getByTestId("overview-workspace-row")).toBeInTheDocument();
  });

  it("places highlighted workspace access before compact overview properties", () => {
    renderSlideOverWithWorkspace();

    const overview = screen.getByTestId("task-overview-tab");
    const workspaceRow = screen.getByTestId("overview-workspace-row");
    const properties = screen.getByTestId("task-overview-properties");

    expect(workspaceRow.compareDocumentPosition(properties) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(workspaceRow.className).toContain("bg-cyan-500/10");
    expect(workspaceRow.className).toContain("border-cyan-500/30");
    expect(overview.firstElementChild).toBe(workspaceRow);
    expect(screen.getByTestId("issue-properties")).toHaveAttribute("data-layout", "compact");
  });

  it("renders workspace row when executionWorkspaceId is set", () => {
    renderSlideOverWithWorkspace();
    expect(screen.getByTestId("workspace-row")).toBeInTheDocument();
  });

  it("switches to Mode 2 (workspace chat) when workspace row is clicked", async () => {
    const user = userEvent.setup();
    renderSlideOverWithWorkspace();

    await user.click(screen.getByTestId("workspace-row"));

    expect(screen.getByTestId("workspace-breadcrumb-back")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-timeline")).toBeInTheDocument();
  });

  it("breadcrumb back button returns to Mode 1 (task properties)", async () => {
    const user = userEvent.setup();
    renderSlideOverWithWorkspace();

    // Enter Mode 2
    await user.click(screen.getByTestId("workspace-row"));
    expect(screen.getByTestId("workspace-breadcrumb-back")).toBeInTheDocument();

    // Go back to Mode 1
    await user.click(screen.getByTestId("workspace-breadcrumb-back"));

    expect(screen.getByTestId("workspace-section")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace-chatbar")).not.toBeInTheDocument();
  });

  it("'Open Workspace' button navigates to workspace view and closes sheet", async () => {
    const user = userEvent.setup();
    renderSlideOverWithWorkspace();

    // Enter Mode 2
    await user.click(screen.getByTestId("workspace-row"));

    // Click "Open Workspace"
    const openBtn = screen.getByTestId("open-workspace-button");
    expect(openBtn).toBeInTheDocument();
    await user.click(openBtn);

    expect(mockOnClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/TC/workspaces/ws-123");
  });
});
