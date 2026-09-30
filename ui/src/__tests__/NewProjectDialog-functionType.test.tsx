import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewProjectDialog } from "../components/NewProjectDialog";

const projectApiMocks = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue({ id: "proj-1" }),
  createWorkspace: vi.fn().mockResolvedValue({}),
}));

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
  tablePlugin: () => ({}),
  imagePlugin: () => ({}),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { name: "Acme Corp", rootFolder: "C:\\Work\\Acme" },
  }),
}));

const mockCloseNewProject = vi.fn();

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newProjectOpen: true,
    newProjectDefaults: { type: "department" },
    closeNewProject: mockCloseNewProject,
  }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    create: projectApiMocks.create,
    createWorkspace: projectApiMocks.createWorkspace,
  },
}));

vi.mock("../api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("../components/PathInstructionsModal", () => ({
  ChoosePathButton: () => <button type="button">Choose</button>,
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: [], isLoading: false, error: null })),
    useMutation: (options?: { mutationFn?: (input: unknown) => Promise<unknown> }) => ({
      mutate: vi.fn((input, callbacks) => {
        Promise.resolve(options?.mutationFn?.(input))
          .then((result) => callbacks?.onSuccess?.(result))
          .catch((error) => callbacks?.onError?.(error));
      }),
      mutateAsync: vi.fn((input) => options?.mutationFn?.(input) ?? Promise.resolve({ id: "proj-1" })),
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
      <NewProjectDialog />
    </QueryClientProvider>
  );
}

describe("NewProjectDialog — function type picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectApiMocks.create.mockResolvedValue({ id: "proj-1" });
    projectApiMocks.createWorkspace.mockResolvedValue({});
  });

  it("renders all 11 function type options for departments (shared taxonomy)", () => {
    renderDialog();
    expect(screen.getByText("Product (Software)")).toBeInTheDocument();
    expect(screen.getByText("Marketing")).toBeInTheDocument();
    expect(screen.getByText("Sales")).toBeInTheDocument(); // C9: new
    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Customer Support")).toBeInTheDocument(); // C9: relabeled from "Support"
    expect(screen.getByText("HR")).toBeInTheDocument();
    expect(screen.getByText("Legal")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("selecting Product (Software) shows repo setup", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText("Product (Software)"));
    expect(screen.getByText("A local folder")).toBeInTheDocument();
    expect(screen.getByText("A github repo")).toBeInTheDocument();
    expect(screen.getByText("Both")).toBeInTheDocument();
  });

  it("selecting a non-software type shows working directory input, not repo setup", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText("Marketing"));
    expect(screen.queryByText("A local folder")).not.toBeInTheDocument();
    expect(screen.queryByText("A github repo")).not.toBeInTheDocument();
    expect(screen.getByText("Working directory")).toBeInTheDocument();
  });

  it("workspace mode toggle renders and Shared can be selected", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText("Marketing"));
    const sharedBtn = screen.getByRole("button", { name: /shared/i });
    await user.click(sharedBtn);
    expect(sharedBtn.className).toContain("border-foreground");
  });

  it("requires software departments to choose a workspace source before creation", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByPlaceholderText("Department name"), "Engineering");
    await user.click(screen.getByText("Product (Software)"));
    await user.click(screen.getByRole("button", { name: /create department/i }));

    expect(await screen.findByText(/Choose local folder, GitHub repo, or both/i)).toBeInTheDocument();
    expect(projectApiMocks.create).not.toHaveBeenCalled();
    expect(projectApiMocks.createWorkspace).not.toHaveBeenCalled();
  });

  it("creates a software department with a repo-only workspace source", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByPlaceholderText("Department name"), "Engineering");
    await user.click(screen.getByText("Product (Software)"));
    await user.click(screen.getByRole("button", { name: /a github repo/i }));
    await user.type(screen.getByPlaceholderText("https://github.com/org/repo"), "https://github.com/acme/app");
    await user.click(screen.getByRole("button", { name: /create department/i }));

    expect(projectApiMocks.create).toHaveBeenCalledWith("comp-1", expect.objectContaining({
      name: "Engineering",
      functionType: "software_development",
    }));
    expect(projectApiMocks.createWorkspace).toHaveBeenCalledWith("proj-1", expect.objectContaining({
      cwd: "/__paperclip_repo_only__",
      repoUrl: "https://github.com/acme/app",
    }));
  });
});
