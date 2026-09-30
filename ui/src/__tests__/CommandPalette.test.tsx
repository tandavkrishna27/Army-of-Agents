import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { CommandPalette } from "../components/CommandPalette";
import { issuesApi } from "../api/issues";

const navigate = vi.fn();

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
    openNewAgent: vi.fn(),
    openNewGoal: vi.fn(),
    openDiscussionCapture: vi.fn(),
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
  }),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

const globalSearchMock = vi.fn().mockResolvedValue({
  query: "search",
  tookMs: 12,
  totalCount: 3,
  groups: [
    {
      type: "memory",
      label: "Memory",
      count: 1,
      items: [
        {
          id: "memory-1",
          type: "memory",
          title: "Shared playbook",
          subtitle: "Reusable process guidance",
          href: "/memory/explore?item=memory-1",
          score: 0.9,
          category: "reference",
          layer: "domain",
          departmentName: "Engineering",
        },
      ],
    },
    {
      type: "artifact",
      label: "Artifacts",
      count: 1,
      items: [
        {
          id: "artifact-1",
          type: "artifact",
          title: "API Spec",
          subtitle: "Current spec version",
          href: "/issues/TASK-1",
          score: 0.8,
          artifactType: "document",
          currentVersionNumber: 4,
        },
      ],
    },
    {
      type: "task",
      label: "Tasks",
      count: 1,
      items: [
        {
          id: "task-1",
          type: "task",
          title: "Search hardening",
          subtitle: "Improve cmd+k latency",
          href: "/issues/TASK-1",
          score: 0.7,
          identifier: "TASK-1",
          status: "todo",
        },
      ],
    },
  ],
});

vi.mock("../api/search", () => ({
  searchApi: {
    global: (...args: unknown[]) => globalSearchMock(...args),
  },
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({ open, onOpenChange, children }: any) =>
    open ? <div data-testid="command-dialog" data-open={open} onClick={() => onOpenChange(open)}>{children}</div> : null,
  CommandInput: ({ value, onValueChange, placeholder }: any) => (
    <input
      aria-label={placeholder}
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    />
  ),
  CommandList: ({ children }: any) => <div>{children}</div>,
  CommandEmpty: ({ children }: any) => <div>{children}</div>,
  CommandGroup: ({ heading, children }: any) => (
    <section>
      <h2>{heading}</h2>
      {children}
    </section>
  ),
  CommandItem: ({ onSelect, children }: any) => (
    <button type="button" onClick={() => onSelect?.("")}>
      {children}
    </button>
  ),
  CommandSeparator: () => <hr />,
}));

function renderPalette() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CommandPalette />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes its task queries to taskScope:'all' so crew tasks are findable", async () => {
    const user = userEvent.setup();
    renderPalette();

    // Instant list fires on open.
    await user.keyboard("{Control>}k{/Control}");
    expect(issuesApi.list).toHaveBeenCalledWith("company-1", { taskScope: "all" });

    // The {q} search list fires once a query is typed.
    await user.type(screen.getByLabelText(/search tasks, goals, agents/i), "auth");
    await vi.waitFor(() =>
      expect(issuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "auth",
        taskScope: "all",
      }),
    );

    // Crucially, cmd+K never issues an org-scoped (scope-less) task list.
    const calls = (issuesApi.list as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    for (const [, filters] of calls) {
      expect((filters as { taskScope?: string } | undefined)?.taskScope).toBe("all");
    }
  });

  it("renders grouped global search results with memory and artifact badges", async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByLabelText(/search tasks, goals, agents/i), "search");

    expect(await screen.findByText("Memory (1)")).toBeInTheDocument();
    expect(screen.getByText("Artifacts (1)")).toBeInTheDocument();
    expect(screen.getByText("Tasks (1)")).toBeInTheDocument();
    expect(screen.getByText("Shared playbook")).toBeInTheDocument();
    expect(screen.getByText("domain")).toBeInTheDocument();
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("reference")).toBeInTheDocument();
    expect(screen.getByText("document")).toBeInTheDocument();
    expect(screen.getByText("v4")).toBeInTheDocument();
  });

  it("navigates to the selected grouped result", async () => {
    const user = userEvent.setup();
    renderPalette();

    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByLabelText(/search tasks, goals, agents/i), "search");
    await user.click(await screen.findByText("API Spec"));

    expect(navigate).toHaveBeenCalledWith("/issues/TASK-1");
  });

  it("renders Discussions/Threads search results and navigates to /discussions/:id (Plan 5)", async () => {
    const user = userEvent.setup();

    // Override globalSearchMock to return a brief/thread result
    globalSearchMock.mockResolvedValue({
      query: "auth",
      tookMs: 5,
      totalCount: 1,
      groups: [
        {
          type: "brief",
          label: "Discussions",
          count: 1,
          items: [
            {
              id: "disc-1",
              type: "brief",
              title: "Auth refactor thread",
              subtitle: "Security improvement discussion",
              href: "/discussions/disc-1",
              score: 0.9,
              status: "active",
            },
          ],
        },
      ],
    });

    renderPalette();

    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByLabelText(/search tasks, goals, agents/i), "auth");

    // Thread title should appear in results
    expect(await screen.findByText("Auth refactor thread")).toBeInTheDocument();
    // Group header should say "Discussions (1)"
    expect(screen.getByText("Discussions (1)")).toBeInTheDocument();

    // Clicking the result should navigate to /discussions/:id
    await user.click(screen.getByText("Auth refactor thread"));
    expect(navigate).toHaveBeenCalledWith("/discussions/disc-1");
  });
});
