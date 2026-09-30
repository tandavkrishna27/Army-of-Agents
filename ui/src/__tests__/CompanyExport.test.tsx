import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext, makeCompany } from "./test-utils";
import { CompanyExport } from "../pages/CompanyExport";

const previewExport = vi.fn();
const exportBundle = vi.fn();

vi.mock("@/api/company-portability", () => ({
  companyPortabilityApi: {
    previewExport: (...args: unknown[]) => previewExport(...args),
    exportBundle: (...args: unknown[]) => exportBundle(...args),
  },
}));

const mockCompany = makeCompany({ id: "comp-1", name: "Acme Inc", issuePrefix: "ACME" });

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    ...mockCompanyContext,
    selectedCompany: mockCompany,
    selectedCompanyId: mockCompany.id,
    companies: [mockCompany],
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

function makePreview(
  overrides: Partial<{
    counts: Record<string, number>;
    files: string[];
    estimatedBytes: number;
    warnings: string[];
  }> = {},
) {
  return {
    counts: {
      agents: 3,
      projects: 0,
      issues: 0,
      skills: 0,
      routines: 0,
      envInputs: 0,
    },
    files: ["README.md", "agents/alice.md"],
    estimatedBytes: 2048,
    warnings: [],
    ...overrides,
  };
}

describe("CompanyExport page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders heading and company name", () => {
    renderWithProviders(<CompanyExport />);
    expect(screen.getByRole("heading", { name: /export/i })).toBeInTheDocument();
    expect(screen.getByText(/Acme Inc/)).toBeInTheDocument();
  });

  it("checkbox defaults match DEFAULT_INCLUDE (agents ON, projects/issues/skills/routines/envInputs OFF, company locked ON)", () => {
    renderWithProviders(<CompanyExport />);
    const company = screen.getByRole("checkbox", { name: /^company$/i });
    const agents = screen.getByRole("checkbox", { name: /^agents$/i });
    const projects = screen.getByRole("checkbox", { name: /projects/i });
    const tasks = screen.getByRole("checkbox", { name: /tasks/i });
    const skills = screen.getByRole("checkbox", { name: /skills/i });
    const routines = screen.getByRole("checkbox", { name: /routines/i });
    const envInputs = screen.getByRole("checkbox", { name: /environment inputs/i });

    expect(company).toBeChecked();
    expect(company).toBeDisabled();
    expect(agents).toBeChecked();
    expect(projects).not.toBeChecked();
    expect(tasks).not.toBeChecked();
    expect(skills).not.toBeChecked();
    expect(routines).not.toBeChecked();
    expect(envInputs).not.toBeChecked();
  });

  it("E.2 checkbox defaults: internal agent ON, budget/cost/finance/quota OFF", () => {
    renderWithProviders(<CompanyExport />);
    const internalAgent = screen.getByRole("checkbox", { name: /internal agent config/i });
    const budgetPolicies = screen.getByRole("checkbox", { name: /budget policies/i });
    const costEvents = screen.getByRole("checkbox", { name: /cost events/i });
    const financeEvents = screen.getByRole("checkbox", { name: /finance events/i });
    const quotaWindows = screen.getByRole("checkbox", { name: /quota windows/i });

    expect(internalAgent).toBeChecked();
    expect(budgetPolicies).not.toBeChecked();
    expect(costEvents).not.toBeChecked();
    expect(financeEvents).not.toBeChecked();
    expect(quotaWindows).not.toBeChecked();
  });

  it("volume warning appears inline when Cost Events is checked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyExport />);
    expect(screen.queryByText(/high-volume operational data/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /cost events/i }));
    await screen.findByText(/high-volume operational data/i);
  });

  it("toggling E.2 checkboxes propagates flags to previewExport call", async () => {
    const user = userEvent.setup();
    previewExport.mockResolvedValue(makePreview());
    renderWithProviders(<CompanyExport />);
    await user.click(screen.getByRole("checkbox", { name: /budget policies/i }));
    await user.click(screen.getByRole("checkbox", { name: /finance events/i }));
    await user.click(screen.getByRole("button", { name: /preview/i }));

    await waitFor(() => {
      expect(previewExport).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({
          internalAgentConfig: true,
          budgetPolicies: true,
          costEvents: false,
          financeEvents: true,
          quotaWindows: false,
        }),
      );
    });
  });

  it("clicking Preview calls previewExport with selected include flags", async () => {
    const user = userEvent.setup();
    previewExport.mockResolvedValue(makePreview());
    renderWithProviders(<CompanyExport />);
    await user.click(screen.getByRole("checkbox", { name: /projects/i }));
    await user.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => {
      expect(previewExport).toHaveBeenCalledWith(
        "comp-1",
        expect.objectContaining({
          company: true,
          agents: true,
          projects: true,
          issues: false,
          skills: false,
          routines: false,
          envInputs: false,
        }),
      );
    });
  });

  it("shows summary card after preview with counts + file count + size + warnings", async () => {
    const user = userEvent.setup();
    previewExport.mockResolvedValue(
      makePreview({
        counts: { agents: 5, projects: 2, issues: 10, skills: 0, routines: 1, envInputs: 0 },
        files: ["README.md", "agents/a.md", "agents/b.md"],
        estimatedBytes: 4096,
        warnings: ["Skill foo missing source"],
      }),
    );
    renderWithProviders(<CompanyExport />);
    await user.click(screen.getByRole("button", { name: /preview/i }));

    await screen.findByText(/5/); // agent count shows
    expect(screen.getByText(/3 files/i)).toBeInTheDocument();
    expect(screen.getByText(/Skill foo missing source/)).toBeInTheDocument();
  });

  it("Download button is disabled until preview succeeds, then enabled", async () => {
    const user = userEvent.setup();
    previewExport.mockResolvedValue(makePreview());
    renderWithProviders(<CompanyExport />);

    const downloadBtn = screen.getByRole("button", { name: /download/i });
    expect(downloadBtn).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /preview/i }));
    await waitFor(() => expect(downloadBtn).not.toBeDisabled());
  });

  it("clicking Download triggers exportBundle call", async () => {
    const user = userEvent.setup();
    previewExport.mockResolvedValue(makePreview());
    exportBundle.mockResolvedValue({
      manifest: { schemaVersion: 2, generatedAt: "2026-04-21T00:00:00Z", includes: {}, company: null, agents: [], requiredSecrets: [] },
      files: { "README.md": "# Acme" },
      warnings: [],
    });

    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    const originalURL = globalThis.URL.createObjectURL;
    const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    const anchorClick = vi.fn();
    globalThis.URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;
    HTMLAnchorElement.prototype.click = anchorClick;

    try {
      renderWithProviders(<CompanyExport />);
      await user.click(screen.getByRole("button", { name: /preview/i }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /download/i })).not.toBeDisabled(),
      );
      await user.click(screen.getByRole("button", { name: /download/i }));
      await waitFor(() => expect(exportBundle).toHaveBeenCalledWith("comp-1", expect.any(Object)));
      expect(anchorClick).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    } finally {
      globalThis.URL.createObjectURL = originalURL;
      globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
      HTMLAnchorElement.prototype.click = originalAnchorClick;
    }
  });

  it("shows error state when preview API fails", async () => {
    const user = userEvent.setup();
    previewExport.mockRejectedValue(new Error("Server is down"));
    renderWithProviders(<CompanyExport />);
    await user.click(screen.getByRole("button", { name: /preview/i }));
    await screen.findByText(/Server is down/i);
  });
});

