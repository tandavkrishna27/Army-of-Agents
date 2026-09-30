import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewIssueDialog } from "../components/NewIssueDialog";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [],
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Acme" },
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newIssueOpen: true,
    newIssueDefaults: {},
    closeNewIssue: vi.fn(),
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: () => ({ orderedProjects: [] }),
}));

vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({ permissions: {} }),
}));

vi.mock("../api/issues", () => ({
  issuesApi: { create: vi.fn().mockResolvedValue({ id: "issue-1", title: "T" }) },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]), adapterModels: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { id: "u1" } }) },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: (_props: Record<string, unknown>) => <textarea data-testid="md-editor" />,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("../components/InlineEntitySelector", () => ({
  InlineEntitySelector: () => null,
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined, isLoading: false, error: null })),
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
    }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewIssueDialog />
    </QueryClientProvider>
  );
}

describe("NewIssueDialog — work-mode chip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("renders Standard chip by default", () => {
    renderDialog();
    expect(screen.getByText("Standard")).toBeInTheDocument();
  });

  it("switches to Planning when chip is clicked and Planning option selected", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByText("Standard"));
    const planningOption = screen.getAllByText("Planning")[0];
    await user.click(planningOption);

    expect(screen.getByText("Planning")).toBeInTheDocument();
  });
});
