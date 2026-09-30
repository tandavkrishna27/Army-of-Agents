import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DependencyChain } from "../components/workspace/DependencyChain";

// ─── Mock data ───────────────────────────────────────────────────────────────

const mockDepsResponse = {
  upstream: [
    {
      id: "dep-1",
      dependencyIssueId: "issue-up-1",
      title: "Write spec",
      status: "done",
      identifier: "ENG-10",
      createdAt: "2026-04-01T10:00:00Z",
    },
    {
      id: "dep-2",
      dependencyIssueId: "issue-up-2",
      title: "Design UI",
      status: "in_progress",
      identifier: "ENG-11",
      createdAt: "2026-04-01T11:00:00Z",
    },
  ],
  downstream: [
    {
      id: "dep-3",
      dependentIssueId: "issue-down-1",
      title: "Write tests",
      status: "todo",
      identifier: "ENG-13",
      createdAt: "2026-04-01T12:00:00Z",
    },
  ],
};

const emptyDepsResponse = { upstream: [], downstream: [] };

// ─── API Mocks ───────────────────────────────────────────────────────────────

const dependenciesApiMock = {
  list: vi.fn().mockResolvedValue(mockDepsResponse),
};

vi.mock("../api/dependencies", () => ({
  dependenciesApi: new Proxy(
    {},
    { get: (_t, prop) => (dependenciesApiMock as any)[prop] },
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", issuePrefix: "TC" },
    companies: [{ id: "comp-1" }],
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderChain(props: Partial<React.ComponentProps<typeof DependencyChain>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const onSelectIssue = props.onSelectIssue ?? vi.fn();

  return {
    onSelectIssue,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <DependencyChain
            issueId="issue-current"
            companyId="comp-1"
            selectedIssueId="issue-current"
            onSelectIssue={onSelectIssue}
            {...props}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  dependenciesApiMock.list.mockResolvedValue(mockDepsResponse);
});

describe("DependencyChain", () => {
  it("renders nodes for upstream and downstream dependencies", async () => {
    renderChain();

    await waitFor(() => {
      expect(screen.getByTestId("dependency-chain")).toBeInTheDocument();
    });

    // Upstream deps
    expect(screen.getByText("ENG-10")).toBeInTheDocument();
    expect(screen.getByText("ENG-11")).toBeInTheDocument();
    // Downstream dep
    expect(screen.getByText("ENG-13")).toBeInTheDocument();
  });

  it("highlights the current task node", async () => {
    renderChain();

    await waitFor(() => {
      expect(screen.getByTestId("dep-node-issue-current")).toBeInTheDocument();
    });

    const currentNode = screen.getByTestId("dep-node-issue-current");
    expect(currentNode.className).toMatch(/border-primary/);
  });

  it("clicking a dependency node calls onSelectIssue", async () => {
    const onSelectIssue = vi.fn();
    renderChain({ onSelectIssue });

    await waitFor(() => {
      expect(screen.getByTestId("dep-node-issue-up-1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("dep-node-issue-up-1"));
    expect(onSelectIssue).toHaveBeenCalledWith("issue-up-1");
  });

  it("renders nothing when there are no dependencies", async () => {
    dependenciesApiMock.list.mockResolvedValue(emptyDepsResponse);
    const { container } = renderChain();

    // Wait for query to resolve and component to render nothing
    await waitFor(() => {
      expect(dependenciesApiMock.list).toHaveBeenCalled();
      expect(container.innerHTML).toBe("");
    });
  });
});
