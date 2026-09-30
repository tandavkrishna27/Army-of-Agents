import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectProperties } from "../components/ProjectProperties";
import type { Project } from "@armyofagents/shared";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, Link: actual.Link };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "comp-1" }),
}));

vi.mock("../api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: [], isLoading: false, error: null })),
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({}),
      isPending: false,
      isError: false,
      isSuccess: false,
    }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock("../components/PathInstructionsModal", () => ({
  ChoosePathButton: () => <button type="button">Choose</button>,
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    goals: { list: (id: string) => ["goals", "list", id] },
    projects: { list: (id: string) => ["projects", "list", id] },
    executionWorkspaces: {
      detail: (id: string) => ["executionWorkspaces", "detail", id],
      list: (id: string) => ["executionWorkspaces", id],
    },
  },
}));

vi.mock("../lib/status-colors", () => ({
  statusBadge: {},
  statusBadgeDefault: "bg-gray-100 text-gray-800",
}));

const baseProject: Project = {
  id: "proj-1",
  companyId: "comp-1",
  urlKey: "ENG",
  goalId: null,
  goalIds: [],
  goals: [],
  type: "department",
  name: "Engineering",
  description: null,
  status: "active",
  leadAgentId: null,
  targetDate: null,
  color: null,
  functionType: "software_development",
  executionWorkspacePolicy: null,
  workspaces: [],
  primaryWorkspace: null,
  archivedAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function renderProperties(project: Project) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter>
          <ProjectProperties project={project} onUpdate={vi.fn()} />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

describe("ProjectProperties — Workspace Policy section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render editable Workspace Policy controls in Overview", () => {
    const project = {
      ...baseProject,
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace" as const,
        allowIssueOverride: true,
      },
    };
    renderProperties(project);
    expect(screen.queryByText("Workspace Policy")).not.toBeInTheDocument();
    expect(screen.queryByText("Allow tasks to override workspace mode")).not.toBeInTheDocument();
  });

  it("hides Workspace Policy section when executionWorkspacePolicy is null", () => {
    renderProperties(baseProject); // executionWorkspacePolicy: null
    expect(screen.queryByText("Workspace Policy")).not.toBeInTheDocument();
  });
});
