import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const updateMock = vi.fn().mockResolvedValue({});
const invalidateQueriesMock = vi.fn();

vi.mock("../api/issues", () => ({
  issuesApi: {
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    listSummaries: vi.fn(),
  },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getExperimental: vi.fn(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    get: vi.fn(),
  },
}));

vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    issues: {
      detail: (id: string) => ["issues", "detail", id],
    },
    projects: {
      detail: (id: string) => ["projects", "detail", id],
    },
    instanceSettings: {
      experimental: ["instance-settings", "experimental"],
    },
    executionWorkspaces: {
      list: (id: string) => ["executionWorkspaces", id],
    },
  },
}));

vi.mock("../hooks/useWorkspacePermissions", () => ({
  useWorkspacePermissions: () => ({
    canOverrideTaskWorkspace: true,
  }),
}));

// We mock react-query's useQuery to return specific shapes per queryKey signature
type QueryShape = { data: unknown; isLoading?: boolean; error?: unknown };
const queryShapes: Record<string, QueryShape> = {};
function keyOf(key: unknown): string {
  return Array.isArray(key) ? key.map(String).join(".") : String(key);
}

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return {
    ...actual,
    useQuery: vi.fn(({ queryKey }: { queryKey: unknown }) => {
      const k = keyOf(queryKey);
      for (const prefix of Object.keys(queryShapes)) {
        if (k.startsWith(prefix)) return { ...queryShapes[prefix], isLoading: false, error: null };
      }
      return { data: undefined, isLoading: false, error: null };
    }),
    useMutation: (opts: { mutationFn: (payload: unknown) => Promise<unknown>; onSuccess?: () => void }) => ({
      mutate: (payload: unknown) => {
        void opts.mutationFn(payload).then(() => opts.onSuccess?.());
      },
      mutateAsync: opts.mutationFn,
      isPending: false,
      isError: false,
      isSuccess: false,
    }),
    useQueryClient: () => ({
      invalidateQueries: invalidateQueriesMock,
    }),
  };
});

// Mock shadcn Select so the test can drive onValueChange directly, bypassing
// Radix's dropdown (Radix portals the options into a popover which is flaky in
// jsdom and adds no value to the unit test).
const capturedHandlers: Array<(v: string) => void> = [];
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange }: any) => {
    capturedHandlers.push(onValueChange);
    return (
      <div
        data-testid="select"
        data-value={value}
        data-handler-index={capturedHandlers.length - 1}
      >
        {children}
      </div>
    );
  },
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: any) => (
    <div data-testid={props["data-testid"] ?? "select-trigger"}>{children}</div>
  ),
  SelectValue: ({ placeholder }: any) => <span>{placeholder}</span>,
  SelectItem: ({ value, children }: any) => (
    <div data-testid={`select-item-${value}`} data-value={value}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: any) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, ...props }: any) => (
    <button data-testid={props["data-testid"] ?? "collapsible-trigger"}>{children}</button>
  ),
  CollapsibleContent: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

import { IssueWorkspaceCard } from "../components/IssueWorkspaceCard";

function renderCard(props: Partial<React.ComponentProps<typeof IssueWorkspaceCard>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <IssueWorkspaceCard
          issueId="i-1"
          companyId="c-1"
          projectId="p-1"
          issueExecutionWorkspacePreference={null}
          issueExecutionWorkspaceSettings={null}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function seed({
  instance,
  project,
  candidates,
}: {
  instance?: { enableIsolatedWorkspaces: boolean };
  project?: { functionType: string | null; executionWorkspacePolicy: { enabled: boolean; allowIssueOverride?: boolean } | null };
  candidates?: Array<{ id: string; name: string; branchName: string | null; lastUsedAt: Date }>;
}) {
  for (const k of Object.keys(queryShapes)) delete queryShapes[k];
  if (instance) queryShapes["instance-settings.experimental"] = { data: instance };
  if (project) queryShapes["projects.detail"] = { data: project };
  if (candidates) queryShapes["executionWorkspaces.c-1.reuseCandidates"] = { data: candidates };
}

describe("IssueWorkspaceCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateQueriesMock.mockClear();
    capturedHandlers.length = 0;
    for (const k of Object.keys(queryShapes)) delete queryShapes[k];
  });

  it("renders nothing when instance flag is off", () => {
    seed({
      instance: { enableIsolatedWorkspaces: false },
      project: {
        functionType: "software_development",
        executionWorkspacePolicy: { enabled: true },
      },
    });
    renderCard();
    expect(screen.queryByTestId("issue-workspace-card")).not.toBeInTheDocument();
  });

  it("renders nothing when project functionType is not software_development", () => {
    seed({
      instance: { enableIsolatedWorkspaces: true },
      project: { functionType: "marketing", executionWorkspacePolicy: { enabled: true } },
    });
    renderCard();
    expect(screen.queryByTestId("issue-workspace-card")).not.toBeInTheDocument();
  });

  it("renders nothing when project workspace policy is disabled", () => {
    seed({
      instance: { enableIsolatedWorkspaces: true },
      project: { functionType: "software_development", executionWorkspacePolicy: null },
    });
    renderCard();
    expect(screen.queryByTestId("issue-workspace-card")).not.toBeInTheDocument();
  });

  it("renders the three-option select when flag + engineering + no reuse candidates", () => {
    seed({
      instance: { enableIsolatedWorkspaces: true },
      project: {
        functionType: "software_development",
        executionWorkspacePolicy: { enabled: true },
      },
      candidates: [],
    });
    renderCard();
    expect(screen.getByTestId("issue-workspace-card")).toBeInTheDocument();
    expect(screen.getByTestId("select-item-inherit")).toBeInTheDocument();
    expect(screen.getByTestId("select-item-shared_workspace")).toBeInTheDocument();
    expect(screen.getByTestId("select-item-isolated_workspace")).toBeInTheDocument();
    expect(screen.queryByTestId("select-item-reuse_existing")).not.toBeInTheDocument();
  });

  it("renders read-only inherited workspace state when project disallows task overrides", () => {
    seed({
      instance: { enableIsolatedWorkspaces: true },
      project: {
        functionType: "software_development",
        executionWorkspacePolicy: { enabled: true, allowIssueOverride: false },
      },
      candidates: [],
    });
    renderCard();
    expect(screen.getByText(/department default/i)).toBeInTheDocument();
    expect(screen.getByText(/Task-level workspace overrides are disabled/i)).toBeInTheDocument();
    expect(screen.queryByTestId("issue-workspace-mode-trigger")).not.toBeInTheDocument();
  });

  it("shows reuse_existing option when candidates exist", () => {
    seed({
      instance: { enableIsolatedWorkspaces: true },
      project: {
        functionType: "software_development",
        executionWorkspacePolicy: { enabled: true },
      },
      candidates: [
        { id: "ws-1", name: "feature-a", branchName: "feature/a", lastUsedAt: new Date() },
      ],
    });
    renderCard();
    expect(screen.getByTestId("select-item-reuse_existing")).toBeInTheDocument();
  });

  it("shows reuse picker when mode=reuse_existing AND candidates exist", () => {
    seed({
      instance: { enableIsolatedWorkspaces: true },
      project: {
        functionType: "software_development",
        executionWorkspacePolicy: { enabled: true },
      },
      candidates: [
        { id: "ws-1", name: "feature-a", branchName: "feature/a", lastUsedAt: new Date() },
        { id: "ws-2", name: "feature-b", branchName: "feature/b", lastUsedAt: new Date() },
      ],
    });
    renderCard({
      issueExecutionWorkspacePreference: "reuse_existing",
      issueExecutionWorkspaceSettings: { reuseWorkspaceId: "ws-1" },
    });
    expect(screen.getByTestId("issue-workspace-reuse-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("select-item-ws-1")).toBeInTheDocument();
    expect(screen.getByTestId("select-item-ws-2")).toBeInTheDocument();
  });

  it("fires update mutation when mode changes to isolated_workspace", () => {
    seed({
      instance: { enableIsolatedWorkspaces: true },
      project: {
        functionType: "software_development",
        executionWorkspacePolicy: { enabled: true },
      },
      candidates: [],
    });
    renderCard();
    // Drive the Select handler directly — bypasses Radix's portal-based dropdown
    expect(capturedHandlers.length).toBeGreaterThan(0);
    capturedHandlers[0]!("isolated_workspace");
    expect(updateMock).toHaveBeenCalledWith("i-1", {
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: null,
    });
  });

  it("invalidates issue detail and workspace list after mode update", async () => {
    seed({
      instance: { enableIsolatedWorkspaces: true },
      project: {
        functionType: "software_development",
        executionWorkspacePolicy: { enabled: true },
      },
      candidates: [],
    });
    renderCard();

    capturedHandlers[0]!("isolated_workspace");

    await vi.waitFor(() => {
      expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["issues", "detail", "i-1"] });
      expect(invalidateQueriesMock).toHaveBeenCalledWith({ queryKey: ["executionWorkspaces", "c-1"] });
    });
  });

  it("sends null preference when mode=inherit is selected", () => {
    seed({
      instance: { enableIsolatedWorkspaces: true },
      project: {
        functionType: "software_development",
        executionWorkspacePolicy: { enabled: true },
      },
      candidates: [],
    });
    renderCard({ issueExecutionWorkspacePreference: "shared_workspace" });
    capturedHandlers[0]!("inherit");
    expect(updateMock).toHaveBeenCalledWith("i-1", {
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
    });
  });
});
