import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { IssuesList } from "../components/IssuesList";
import type { Issue } from "@armyofagents/shared";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "comp-1", selectedCompany: { id: "comp-1", issuePrefix: "TST" } }),
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ openNewIssue: vi.fn() }),
}));
vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, Link: actual.Link };
});
vi.mock("@/lib/inbox", () => ({
  getCollapsedSet: () => new Set<string>(),
  toggleCollapsed: vi.fn(),
}));
vi.mock("../api/issues", () => ({
  issuesApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    issues: {
      list: () => ["issues"],
      search: () => ["issues", "search"],
      labels: () => ["issues", "labels"],
    },
  },
}));
vi.mock("../components/KanbanBoard", () => ({
  KanbanBoard: () => null,
}));

const baseIssue: Issue = {
  id: "i1",
  identifier: "TST-1",
  title: "Design architecture plan",
  status: "todo",
  priority: "medium",
  workMode: "planning",
  assigneeAgentId: null,
  assigneeUserId: null,
  companyId: "comp-1",
  projectId: null,
  goalId: null,
  parentId: null,
  description: null,
  checkoutRunId: null,
  executionRunId: null,
  executionAgentNameKey: null,
  executionLockedAt: null,
  executionWorkspaceId: null,
  executionWorkspacePreference: null,
  executionWorkspaceSettings: null,
  createdByAgentId: null,
  createdByUserId: null,
  issueNumber: 1,
  requestDepth: 0,
  billingCode: null,
  assigneeAdapterOverrides: null,
  source: null,
  reviewerUserId: null,
  dueDate: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  hiddenAt: null,
  artifactId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const VIEW_KEY = "test-view:comp-1";

function renderList(issues: Issue[]) {
  // Force list mode so we render rows (not the KanbanBoard)
  localStorage.setItem(VIEW_KEY, JSON.stringify({ viewMode: "list", groupBy: "none" }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <IssuesList
          issues={issues}
          viewStateKey="test-view"
          onUpdateIssue={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("IssuesList — Planning pill", () => {
  it("renders Planning pill for a planning-mode issue", () => {
    renderList([baseIssue]);
    expect(screen.getByText("Planning")).toBeInTheDocument();
  });

  it("does not render Planning pill for a standard-mode issue", () => {
    renderList([{ ...baseIssue, workMode: "standard" }]);
    expect(screen.queryByText("Planning")).not.toBeInTheDocument();
  });
});
