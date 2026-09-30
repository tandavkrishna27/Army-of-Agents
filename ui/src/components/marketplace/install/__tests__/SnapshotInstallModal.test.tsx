import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { SnapshotInstallModal } from "../SnapshotInstallModal";
import { ToastProvider } from "@/context/ToastContext";
import { InstallToastProvider } from "@/components/marketplace/toast/ToastProvider";
import { ToastViewport } from "@/components/ToastViewport";
import {
  CODE_REVIEW_SKILL,
  ENGINEER_AGENT,
  ENGINEERING_TEAM,
  GSTACK_BROWSE_SKILL,
} from "@/__tests__/__fixtures__/marketplace-catalog";
import { marketplaceApi } from "@/api/marketplace";
import { projectsApi } from "@/api/projects";

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

vi.mock("@/api/marketplace", async () => {
  const actual = await vi.importActual<typeof import("@/api/marketplace")>("@/api/marketplace");
  return {
    ...actual,
    marketplaceApi: {
      ...actual.marketplaceApi,
      install: vi.fn(),
      getOperation: vi.fn(),
      resolvePlan: vi.fn(),
    },
  };
});
vi.mock("@/api/projects", () => ({ projectsApi: { list: vi.fn() } }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "c1",
    companies: [{ id: "c1", name: "Acme", status: "active" }],
  }),
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>
          <InstallToastProvider>
            {node}
            <ToastViewport />
          </InstallToastProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SnapshotInstallModal — skill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.list).mockResolvedValue([
      { id: "d1", name: "Engineering", type: "department" },
    ] as any);
  });

  it("renders skill detail without a dept picker (skills don't require a department)", async () => {
    wrap(<SnapshotInstallModal item={CODE_REVIEW_SKILL} open onOpenChange={() => {}} />);
    expect(screen.getByText("Install Code Review")).toBeInTheDocument();
    // Wait for the component to fully settle (company auto-pick effect)
    await waitFor(() => expect(screen.getByRole("button", { name: /^Install$/ })).toBeInTheDocument());
    // Skills don't require a department — no dept picker shown
    expect(screen.queryByLabelText("Install to department")).not.toBeInTheDocument();
    // No company picker either (only 1 active company)
    expect(screen.queryByLabelText("Install to company")).not.toBeInTheDocument();
  });

  it("Install button is enabled immediately for skills (no department required)", async () => {
    wrap(<SnapshotInstallModal item={CODE_REVIEW_SKILL} open onOpenChange={() => {}} />);
    // With 1 active company auto-selected and no dept required, Install should be enabled at once
    await waitFor(() => {
      const installBtn = screen.getByRole("button", { name: /^Install$/ });
      expect(installBtn).not.toBeDisabled();
    });
  });
});

describe("SnapshotInstallModal — runtime requires banner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows amber banner with human-readable labels when runtimeRequires is non-empty", async () => {
    wrap(<SnapshotInstallModal item={GSTACK_BROWSE_SKILL} open onOpenChange={() => {}} />);
    await waitFor(() => {
      const banner = screen.getByTestId("runtime-requires-banner");
      expect(banner).toBeInTheDocument();
      expect(banner).toHaveTextContent("gstack CLI binaries");
      expect(banner).toHaveTextContent("gstack browse daemon ($B)");
    });
  });

  it("does not show banner when runtimeRequires is absent", async () => {
    wrap(<SnapshotInstallModal item={CODE_REVIEW_SKILL} open onOpenChange={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Install$/ })).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("runtime-requires-banner")).not.toBeInTheDocument();
  });
});

describe("SnapshotInstallModal — team", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.list).mockResolvedValue([
      { id: "d1", name: "Engineering", type: "department" },
    ] as any);
    vi.mocked(marketplaceApi.resolvePlan).mockResolvedValue({
      rootItem: { id: ENGINEERING_TEAM.id, name: "Engineering Team", type: "team", version: "1.0.0" },
      steps: [
        { catalogItemId: "skill:aoa-curated/code-review", itemType: "skill", name: "Code Review", version: "1.0.0", action: "install-new" },
        { catalogItemId: "agent:aoa-curated/engineer", itemType: "agent", name: "Engineer", version: "1.0.0", action: "install-new" },
        { catalogItemId: ENGINEERING_TEAM.id, itemType: "team", name: "Engineering Team", version: "1.0.0", action: "install-new" },
      ],
      conflicts: [],
    });
  });

  it("renders cascade tree for team installs", async () => {
    wrap(<SnapshotInstallModal item={ENGINEERING_TEAM} open onOpenChange={() => {}} />);
    expect(screen.getByText("Install Engineering Team")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Installing this team will also install/)).toBeInTheDocument());
    // Cascade tree shows the steps
    expect(screen.getByText("Code Review")).toBeInTheDocument();
    expect(screen.getByText("Engineer")).toBeInTheDocument();
  });
});

describe("SnapshotInstallModal - agent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.list).mockResolvedValue([
      { id: "d1", name: "Engineering", type: "department" },
    ] as any);
    vi.mocked(marketplaceApi.resolvePlan).mockResolvedValue({
      rootItem: { id: ENGINEER_AGENT.id, name: "Engineer", type: "agent", version: "1.0.0" },
      steps: [
        { catalogItemId: "skill:aoa-curated/code-review", itemType: "skill", name: "Code Review", version: "1.0.0", action: "install-new" },
        { catalogItemId: ENGINEER_AGENT.id, itemType: "agent", name: "Engineer", version: "1.0.0", action: "install-new" },
      ],
      conflicts: [],
      agentInstall: {
        suggestedRole: "lead",
        supportedRoles: ["cxo", "lead", "general"],
        suggestedAdapterType: "codex",
        supportedAdapterTypes: ["codex", "claude"],
        availableAdapterTypes: ["codex"],
        setupRequired: true,
        setupRequirements: [{
          kind: "secret",
          key: "GITHUB_TOKEN",
          label: "GitHub token",
          required: true,
          reason: "Needed to inspect private repositories.",
          usedBy: "github",
        }],
        warnings: [],
      },
    });
    vi.mocked(marketplaceApi.install).mockResolvedValue({
      operationId: "op-agent-1",
      status: "pending",
    });
    vi.mocked(marketplaceApi.getOperation).mockResolvedValue({
      id: "op-agent-1",
      companyId: "c1",
      catalogItemId: ENGINEER_AGENT.id,
      itemType: "agent",
      targetDepartmentId: "d1",
      status: "running",
      resultEntityId: null,
      errorMessage: null,
      cascadeResults: null,
      startedAt: "2026-05-14T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-05-14T00:00:00.000Z",
    });
  });

  it("shows agent defaults, setup warning, dependencies, and submits selected settings", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    wrap(<SnapshotInstallModal item={ENGINEER_AGENT} open onOpenChange={onOpenChange} />);

    await waitFor(() => expect(screen.getByText("Agent settings")).toBeInTheDocument());
    expect(screen.getByText("Setup required after install")).toBeInTheDocument();
    expect(screen.getByText("GitHub token")).toBeInTheDocument();
    expect(screen.getByText(/Installing this agent will also install/)).toBeInTheDocument();
    expect(screen.getByText("Code Review")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: /install to department/i }));
    await user.click(screen.getByText("Engineering"));
    await user.click(screen.getByRole("button", { name: /^Install$/ }));

    expect(marketplaceApi.install).toHaveBeenCalledWith("c1", {
      catalogItemId: ENGINEER_AGENT.id,
      targetDepartmentId: "d1",
      role: "lead",
      adapterType: "codex",
    });
  });

  it("blocks install when the resolved plan has a dependency version mismatch", async () => {
    vi.mocked(marketplaceApi.resolvePlan).mockResolvedValueOnce({
      rootItem: { id: ENGINEER_AGENT.id, name: "Engineer", type: "agent", version: "1.0.0" },
      steps: [
        { catalogItemId: "plugin:aoa-curated/github", itemType: "plugin", name: "GitHub Issues", version: "1.0.0", action: "fail-version-mismatch", reason: "Installed version 0.9.0 differs from catalog 1.0.0" },
        { catalogItemId: ENGINEER_AGENT.id, itemType: "agent", name: "Engineer", version: "1.0.0", action: "install-new" },
      ],
      conflicts: [],
      agentInstall: {
        suggestedRole: "lead",
        supportedRoles: ["cxo", "lead", "general"],
        suggestedAdapterType: "codex",
        supportedAdapterTypes: ["codex"],
        availableAdapterTypes: ["codex"],
        setupRequired: false,
        setupRequirements: [],
        warnings: [],
      },
    });

    wrap(<SnapshotInstallModal item={ENGINEER_AGENT} open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByText("Version mismatch")).toBeInTheDocument());
    expect(screen.getByText(/Resolve version mismatches before installing/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Install$/ })).toBeDisabled();
  });
});

describe("SnapshotInstallModal — locked company/department (WS7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(projectsApi.list).mockResolvedValue([
      { id: "d1", name: "Engineering", type: "department" },
      { id: "d9", name: "Sales", type: "department" },
    ] as any);
    vi.mocked(marketplaceApi.resolvePlan).mockResolvedValue({
      rootItem: { id: ENGINEER_AGENT.id, name: "Engineer", type: "agent", version: "1.0.0" },
      steps: [
        { catalogItemId: ENGINEER_AGENT.id, itemType: "agent", name: "Engineer", version: "1.0.0", action: "install-new" },
      ],
      conflicts: [],
      agentInstall: {
        suggestedRole: "lead",
        supportedRoles: ["cxo", "lead", "general"],
        suggestedAdapterType: "codex",
        supportedAdapterTypes: ["codex"],
        availableAdapterTypes: ["codex"],
        setupRequired: false,
        setupRequirements: [],
        warnings: [],
      },
    });
    vi.mocked(marketplaceApi.install).mockResolvedValue({
      operationId: "op-locked-1",
      status: "pending",
    });
    vi.mocked(marketplaceApi.getOperation).mockResolvedValue({
      id: "op-locked-1",
      companyId: "c2",
      catalogItemId: ENGINEER_AGENT.id,
      itemType: "agent",
      targetDepartmentId: "d9",
      status: "running",
      resultEntityId: null,
      errorMessage: null,
      cascadeResults: null,
      startedAt: "2026-05-14T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-05-14T00:00:00.000Z",
    });
  });

  it("hides both the company and department pickers when lockedCompanyId + lockedDeptId are both provided, and installs straight to them", async () => {
    const user = userEvent.setup();
    wrap(
      <SnapshotInstallModal
        item={ENGINEER_AGENT}
        open
        onOpenChange={() => {}}
        lockedCompanyId="c2"
        lockedDeptId="d9"
      />,
    );

    await waitFor(() => expect(screen.getByText("Agent settings")).toBeInTheDocument());
    expect(screen.queryByLabelText(/install to company/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/install to department/i)).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole("button", { name: /^Install$/ })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: /^Install$/ }));

    expect(marketplaceApi.install).toHaveBeenCalledWith("c2", {
      catalogItemId: ENGINEER_AGENT.id,
      targetDepartmentId: "d9",
      role: "lead",
      adapterType: "codex",
    });
  });

  it("keeps using the locked company+department even though CompanyContext's selectedCompanyId differs, and fires onInstalled on a confirmed install", async () => {
    // The top-of-file useCompany mock always reports selectedCompanyId "c1" —
    // the modal must use the LOCKED "c2"/"d9" throughout, never falling back
    // to (or being reset toward) the context's company.
    const user = userEvent.setup();
    const onInstalled = vi.fn();
    wrap(
      <SnapshotInstallModal
        item={ENGINEER_AGENT}
        open
        onOpenChange={() => {}}
        lockedCompanyId="c2"
        lockedDeptId="d9"
        onInstalled={onInstalled}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /^Install$/ })).not.toBeDisabled());
    await user.click(screen.getByRole("button", { name: /^Install$/ }));

    await waitFor(() => expect(onInstalled).toHaveBeenCalledTimes(1));
    expect(marketplaceApi.install).toHaveBeenCalledWith(
      "c2",
      expect.objectContaining({ targetDepartmentId: "d9" }),
    );
  });

  it("passing only one of lockedCompanyId/lockedDeptId is treated as unlocked (pickers still render)", async () => {
    wrap(
      <SnapshotInstallModal
        item={ENGINEER_AGENT}
        open
        onOpenChange={() => {}}
        lockedDeptId="d9"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText(/install to department/i)).toBeInTheDocument());
  });
});
