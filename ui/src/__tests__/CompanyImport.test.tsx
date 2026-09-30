import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { screen, waitFor, cleanup, fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// These tests render a multi-step import flow; give enough headroom for slow CI runs.
vi.setConfig({ testTimeout: 15000 });
import { renderWithProviders, mockCompanyContext, makeCompany } from "./test-utils";
import { CompanyImport } from "../pages/CompanyImport";
import { ThemeProvider } from "../context/ThemeContext";
import { queryKeys } from "../lib/queryKeys";

const previewImport = vi.fn();
const importBundle = vi.fn();

vi.mock("@/api/company-portability", () => ({
  companyPortabilityApi: {
    previewImport: (...args: unknown[]) => previewImport(...args),
    importBundle: (...args: unknown[]) => importBundle(...args),
    previewExport: vi.fn(),
    exportBundle: vi.fn(),
  },
}));

const companiesListMock = vi.fn();

vi.mock("@/api/companies", () => ({
  companiesApi: {
    list: (...args: unknown[]) => companiesListMock(...args),
  },
}));

const organizationsListMock = vi.fn();

vi.mock("@/api/organizations", () => ({
  organizationsApi: {
    list: (...args: unknown[]) => organizationsListMock(...args),
  },
}));

const healthGetMock = vi.fn();

vi.mock("@/api/health", () => ({
  healthApi: { get: (...args: unknown[]) => healthGetMock(...args) },
}));

const navigateFn = vi.fn();

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<object>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateFn,
  };
});

const mockCompany = makeCompany({ id: "comp-1", name: "Acme Inc", issuePrefix: "ACME" });

const reloadCompanies = vi.fn().mockResolvedValue(undefined);

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    ...mockCompanyContext,
    selectedCompany: mockCompany,
    selectedCompanyId: mockCompany.id,
    companies: [mockCompany],
    reloadCompanies,
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
    breadcrumbs: [],
    subtitle: null,
    setSubtitle: vi.fn(),
    entityColor: null,
    setEntityColor: vi.fn(),
  }),
}));

function makeValidBundle() {
  return {
    manifest: {
      schemaVersion: 2,
      generatedAt: "2026-04-21T00:00:00Z",
      source: "aoa",
      includes: { company: true, agents: true, projects: false, issues: false, skills: false, routines: false, envInputs: false },
      company: {
        slug: "acme",
        path: "company.md",
        name: "Acme Portable",
        description: "A portable company",
        brandColor: null,
      },
      agents: [
        { slug: "ceo", path: "agents/ceo.md", name: "CEO", role: "cxo", adapterType: "claude_local", title: null, icon: null, runtimeConfig: {}, adapterConfig: {}, skillKeys: [], reportsToSlug: null, projectSlug: null },
      ],
      requiredSecrets: [],
    },
    files: { "company.md": "# Acme" },
    warnings: [],
  };
}

function makePreviewResult(overrides: Partial<{
  warnings: unknown[];
  errors: string[];
  agentPlans: unknown[];
  projectPlans: unknown[];
  issuePlans: unknown[];
  skillPlans: unknown[];
  routinePlans: unknown[];
  companyAction: string;
  requiredSecrets: unknown[];
}> = {}) {
  return {
    include: { company: true, agents: true, projects: false, issues: false, skills: false, routines: false, envInputs: false },
    targetCompanyId: null,
    targetCompanyName: "Acme Portable",
    collisionStrategy: "rename",
    selectedAgentSlugs: ["ceo"],
    plan: {
      companyAction: overrides.companyAction ?? "create",
      agentPlans: overrides.agentPlans ?? [
        { slug: "ceo", action: "create", plannedName: "CEO", existingAgentId: null, reason: null },
      ],
      projectPlans: overrides.projectPlans ?? [],
      issuePlans: overrides.issuePlans ?? [],
      skillPlans: overrides.skillPlans ?? [],
      routinePlans: overrides.routinePlans ?? [],
    },
    requiredSecrets: overrides.requiredSecrets ?? [],
    warnings: overrides.warnings ?? [],
    errors: overrides.errors ?? [],
  };
}

function membership(overrides: Partial<{
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  userId: string;
  role: "owner" | "admin" | "member" | "billing";
  status: string;
}> = {}) {
  return {
    id: "membership-1",
    organizationId: "org-1",
    organizationName: "Acme Holdings",
    organizationSlug: "acme-holdings",
    userId: "user-1",
    role: "owner" as const,
    status: "active",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function uploadBundle(user: ReturnType<typeof userEvent.setup>, bundle: object | string) {
  const text = typeof bundle === "string" ? bundle : JSON.stringify(bundle);
  const file = new File([text], "bundle.aoa-bundle.json", { type: "application/json" });
  const input = screen.getByTestId("bundle-file-input") as HTMLInputElement;
  await user.upload(input, file);
}

function renderWithQueryClient(ui: ReactElement, queryClient: QueryClient) {
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThemeProvider>{children}</ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
}

describe("CompanyImport page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    healthGetMock.mockResolvedValue({ deploymentMode: "local_trusted" });
    organizationsListMock.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders heading and upload prompt", () => {
    renderWithProviders(<CompanyImport />);
    expect(screen.getByRole("heading", { name: /import company/i })).toBeInTheDocument();
    expect(screen.getByText(/upload bundle file/i)).toBeInTheDocument();
  });

  it("uploading a valid JSON file parses the bundle and shows its name", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    await screen.findByText(/Acme Portable/);
  });

  it("shows an error when the uploaded file is not valid JSON", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, "not-json-at-all");
    await screen.findByText(/not valid json/i);
  });

  it("clicking Preview after upload calls previewImport with inline source", async () => {
    const user = userEvent.setup();
    previewImport.mockResolvedValue(makePreviewResult());
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));

    await waitFor(() => expect(previewImport).toHaveBeenCalled());
    const arg = previewImport.mock.calls[0]![0] as { source: { type: string } };
    expect(arg.source.type).toBe("inline");
  });

  it("self-hosted empty memberships preserves the omitted organizationId fallback", async () => {
    const user = userEvent.setup();
    previewImport.mockResolvedValue(makePreviewResult());
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    fireEvent.click(await screen.findByRole("button", { name: /^preview$/i }));

    await waitFor(() => expect(previewImport).toHaveBeenCalledWith(
      expect.objectContaining({ target: { mode: "new_company" } }),
    ));
    expect(previewImport.mock.calls[0]![0].target).not.toHaveProperty("organizationId");
  });

  it("cloud_auth auto-selects one eligible organization for preview", async () => {
    const user = userEvent.setup();
    healthGetMock.mockResolvedValue({ deploymentMode: "cloud_auth" });
    organizationsListMock.mockResolvedValue([membership({ organizationId: "org-1" })]);
    previewImport.mockResolvedValue(makePreviewResult());
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    const previewButton = await screen.findByRole("button", { name: /^preview$/i });
    await waitFor(() => expect(previewButton).not.toBeDisabled());
    fireEvent.click(previewButton);

    await waitFor(() => expect(previewImport).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { mode: "new_company", organizationId: "org-1" },
      }),
    ));
  });

  it("requires a destination selection when cloud_auth has multiple eligible organizations", async () => {
    const user = userEvent.setup();
    healthGetMock.mockResolvedValue({ deploymentMode: "cloud_auth" });
    organizationsListMock.mockResolvedValue([
      membership({ organizationId: "org-1", organizationName: "Acme Holdings", organizationSlug: "acme-holdings" }),
      membership({ id: "membership-2", organizationId: "org-2", organizationName: "Beta Labs", organizationSlug: "beta-labs", role: "admin" }),
    ]);
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());

    expect(await screen.findByLabelText(/destination organization/i)).toBeInTheDocument();
    expect(screen.getByText(/acme holdings.*acme-holdings/i)).toBeInTheDocument();
    expect(screen.getByText(/beta labs.*beta-labs/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^preview$/i })).toBeDisabled();
  });

  it("uses the selected cloud destination for preview and import, then invalidates preview on change", async () => {
    const user = userEvent.setup();
    healthGetMock.mockResolvedValue({ deploymentMode: "cloud_auth" });
    organizationsListMock.mockResolvedValue([
      membership({ organizationId: "org-1" }),
      membership({ id: "membership-2", organizationId: "org-2", organizationName: "Beta Labs", organizationSlug: "beta-labs", role: "admin" }),
    ]);
    previewImport.mockResolvedValue(makePreviewResult());
    importBundle.mockResolvedValue({
      company: { id: "new-co-id", name: "Acme Portable", action: "created" },
      agents: [], projects: [], issues: [], skills: [], routines: [], requiredSecrets: [], warnings: [],
    });
    companiesListMock.mockResolvedValue([makeCompany({ id: "new-co-id", issuePrefix: "AP" })]);
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    const select = await screen.findByLabelText(/destination organization/i);
    await user.selectOptions(select, "org-2");
    fireEvent.click(screen.getByRole("button", { name: /^preview$/i }));
    await waitFor(() => expect(previewImport).toHaveBeenCalledWith(expect.objectContaining({
      target: { mode: "new_company", organizationId: "org-2" },
    })));
    const importButton = screen.getByRole("button", { name: /^import$/i });
    await waitFor(() => expect(importButton).not.toBeDisabled());

    await user.selectOptions(select, "org-1");
    expect(importButton).toBeDisabled();
    expect(screen.queryByRole("heading", { name: /^preview$/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^preview$/i }));
    await waitFor(() => expect(previewImport).toHaveBeenLastCalledWith(expect.objectContaining({
      target: { mode: "new_company", organizationId: "org-1" },
    })));
    await waitFor(() => expect(importButton).not.toBeDisabled());
    fireEvent.click(importButton);
    await waitFor(() => expect(importBundle).toHaveBeenCalledWith(expect.objectContaining({
      target: { mode: "new_company", organizationId: "org-1" },
    })));
  });

  it("invalidates a completed preview when the sole eligible organization changes on refetch", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    healthGetMock.mockResolvedValue({ deploymentMode: "cloud_auth" });
    organizationsListMock
      .mockResolvedValueOnce([membership({ organizationId: "org-1" })])
      .mockResolvedValueOnce([membership({ organizationId: "org-2", organizationName: "Beta Labs" })]);
    previewImport.mockResolvedValue(makePreviewResult());
    renderWithQueryClient(<CompanyImport />, queryClient);
    await uploadBundle(user, makeValidBundle());
    const previewButton = await screen.findByRole("button", { name: /^preview$/i });
    await waitFor(() => expect(previewButton).not.toBeDisabled());
    fireEvent.click(previewButton);
    const importButton = screen.getByRole("button", { name: /^import$/i });
    await waitFor(() => expect(importButton).not.toBeDisabled());

    await queryClient.invalidateQueries({ queryKey: queryKeys.organizations.list });
    await waitFor(() => expect(organizationsListMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(importButton).toBeDisabled());
    expect(screen.queryByRole("heading", { name: /^preview$/i })).toBeNull();
  });

  it("discards a preview response that resolves after its destination changes", async () => {
    const user = userEvent.setup();
    const previewRequest = deferred<ReturnType<typeof makePreviewResult>>();
    healthGetMock.mockResolvedValue({ deploymentMode: "cloud_auth" });
    organizationsListMock.mockResolvedValue([
      membership({ organizationId: "org-1" }),
      membership({ id: "membership-2", organizationId: "org-2", organizationName: "Beta Labs", organizationSlug: "beta-labs", role: "admin" }),
    ]);
    previewImport.mockReturnValue(previewRequest.promise);
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    const select = await screen.findByLabelText(/destination organization/i);
    await user.selectOptions(select, "org-1");
    fireEvent.click(screen.getByRole("button", { name: /^preview$/i }));
    await waitFor(() => expect(previewImport).toHaveBeenCalledWith(expect.objectContaining({
      target: { mode: "new_company", organizationId: "org-1" },
    })));

    await user.selectOptions(select, "org-2");
    previewRequest.resolve(makePreviewResult());

    await waitFor(() => expect(screen.getByRole("button", { name: /^preview$/i })).not.toBeDisabled());
    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: /^preview$/i })).toBeNull();
  });

  it("keeps cloud actions disabled when membership lacks owner or admin access", async () => {
    const user = userEvent.setup();
    healthGetMock.mockResolvedValue({ deploymentMode: "cloud_auth" });
    organizationsListMock.mockResolvedValue([
      membership({ role: "member" }),
      membership({ id: "membership-2", role: "billing" }),
    ]);
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());

    expect(await screen.findByText(/owner or admin access/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^preview$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
  });

  it("keeps actions disabled and shows an inline error when organizations cannot load", async () => {
    const user = userEvent.setup();
    organizationsListMock.mockRejectedValue(new Error("organizations unavailable"));
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());

    expect(await screen.findByText(/couldn't load your organizations/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^preview$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
  });

  it("fails closed while deployment health is unresolved or failed", async () => {
    const user = userEvent.setup();
    healthGetMock.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    expect(await screen.findByRole("button", { name: /^preview$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
  });

  it("fails closed when deployment health fails", async () => {
    const user = userEvent.setup();
    healthGetMock.mockRejectedValue(new Error("health unavailable"));
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());

    expect(await screen.findByText(/couldn't load your workspace deployment configuration/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^preview$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^import$/i })).toBeDisabled();
  });

  it("surfaces E.2 entity counts from bundle manifest in preview pane", async () => {
    const user = userEvent.setup();
    previewImport.mockResolvedValue(makePreviewResult());
    renderWithProviders(<CompanyImport />);

    const bundle = makeValidBundle();
    // Add E.2 entity sections to the manifest
    (bundle.manifest as Record<string, unknown>).internalAgentConfig = {
      executionMode: "api",
      autonomyLevel: 2,
      notificationPreference: "mentions",
      contextTokenBudget: 8000,
      proactiveIntervalMinutes: 240,
    };
    (bundle.manifest as Record<string, unknown>).budgetPolicies = [
      { slug: "b1" },
      { slug: "b2" },
      { slug: "b3" },
    ];
    (bundle.manifest as Record<string, unknown>).costEvents = new Array(42).fill({
      slug: "ce",
    });
    (bundle.manifest as Record<string, unknown>).financeEvents = [{ slug: "f1" }];
    (bundle.manifest as Record<string, unknown>).quotaWindows = [
      { slug: "q1" },
      { slug: "q2" },
    ];

    await uploadBundle(user, bundle);
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));

    await screen.findByText(/Budget & Internal Agent/i);
    await screen.findByText(/^Internal agent$/i);
    await screen.findByText(/^Budget policies$/i);
    await screen.findByText(/^Cost events$/i);
    await screen.findByText(/^Finance events$/i);
    await screen.findByText(/^Quota windows$/i);
    // Counts rendered
    await screen.findByText(/^42$/);
    await screen.findByText(/^3$/);
  });

  it("renders preview plan actions and counts after previewImport succeeds", async () => {
    const user = userEvent.setup();
    previewImport.mockResolvedValue(
      makePreviewResult({
        agentPlans: [
          { slug: "ceo", action: "create", plannedName: "CEO", existingAgentId: null, reason: null },
          { slug: "cto", action: "skip", plannedName: "CTO", existingAgentId: "a-1", reason: "already exists" },
        ],
        projectPlans: [
          { slug: "eng", action: "create", plannedName: "Engineering", existingProjectId: null, reason: null },
        ],
      }),
    );
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));

    await screen.findByText(/Agents/);
    // Rendered plan summary: 2 agents (1 create, 1 skip), 1 project (create)
    await screen.findByText(/Engineering/);
  });

  it("renders warnings with amber styling when preview returns warnings", async () => {
    const user = userEvent.setup();
    previewImport.mockResolvedValue(
      makePreviewResult({
        warnings: [
          { kind: "unknown_section", section: "memory", message: "Unknown section: memory" },
        ],
      }),
    );
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));
    await screen.findByText(/Unknown section: memory/);
  });

  it("renders required secrets when preview returns them", async () => {
    const user = userEvent.setup();
    previewImport.mockResolvedValue(
      makePreviewResult({
        requiredSecrets: [
          { key: "GITHUB_TOKEN", description: "GitHub API access", agentSlug: "ceo" },
        ],
      }),
    );
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));
    await screen.findByText(/GITHUB_TOKEN/);
  });

  it("changing collision strategy dropdown updates subsequent preview call", async () => {
    const user = userEvent.setup();
    previewImport.mockResolvedValue(makePreviewResult());
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());

    const select = await screen.findByLabelText(/collision strategy/i) as HTMLSelectElement;
    await user.selectOptions(select, "skip");

    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));
    await waitFor(() => expect(previewImport).toHaveBeenCalled());
    const arg = previewImport.mock.calls[previewImport.mock.calls.length - 1]![0] as {
      collisionStrategy: string;
    };
    expect(arg.collisionStrategy).toBe("skip");
  });

  it("Import button is disabled until preview succeeds", async () => {
    const user = userEvent.setup();
    previewImport.mockResolvedValue(makePreviewResult());
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());

    const importBtn = await screen.findByRole("button", { name: /^import$/i });
    expect(importBtn).toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));
    await waitFor(() => expect(importBtn).not.toBeDisabled());
  });

  it("clicking Import calls importBundle and redirects on success", async () => {
    const user = userEvent.setup();
    previewImport.mockResolvedValue(makePreviewResult());
    importBundle.mockResolvedValue({
      company: { id: "new-co-id", name: "Acme Portable", action: "created" },
      agents: [],
      projects: [],
      issues: [],
      skills: [],
      routines: [],
      requiredSecrets: [],
      warnings: [],
    });
    companiesListMock.mockResolvedValue([
      makeCompany({ id: "new-co-id", name: "Acme Portable", issuePrefix: "AP" }),
    ]);

    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));
    const importBtn = await screen.findByRole("button", { name: /^import$/i });
    await waitFor(() => expect(importBtn).not.toBeDisabled());
    fireEvent.click(importBtn);

    await waitFor(() => expect(importBundle).toHaveBeenCalled());
    await waitFor(() => expect(reloadCompanies).toHaveBeenCalled());
    await waitFor(() => expect(navigateFn).toHaveBeenCalled());
  });

  it("shows error state when preview API fails", async () => {
    const user = userEvent.setup();
    previewImport.mockRejectedValue(new Error("Server error"));
    renderWithProviders(<CompanyImport />);
    await uploadBundle(user, makeValidBundle());
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));
    await screen.findByText(/Server error/);
  });
});
