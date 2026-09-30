import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, mockCompanyContext, makeCompany } from "./test-utils";
import { Layout } from "../components/Layout";

// Membership-aware routing (piece 2): a :companyPrefix that matches none of the
// user's accessible companies must render the AccessRequired surface in place of
// the page content — NOT silently redirect to the user's own first company. A
// prefix that DOES resolve (including a wrong-case one) still auto-corrects.

const mockNavigate = vi.fn();

// Deployment mode is read per-test: the zero-company → /onboarding redirect only
// fires in non-`authenticated` modes, so the cloud (revoked-last-membership) case
// sets this to "cloud_auth". Default "authenticated" preserves the pre-existing
// tests (which all mount with companies present, so the mode is irrelevant to them).
const healthState = vi.hoisted(() => ({ deploymentMode: "authenticated" as string }));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

// Layout chrome + hooks that pull heavy contexts — stub to isolate the routing
// effect under test.
vi.mock("../components/Sidebar", () => ({ Sidebar: () => <aside data-testid="sidebar" /> }));
vi.mock("../components/SidebarNavItem", () => ({ SidebarNavItem: () => null }));
vi.mock("../components/BreadcrumbBar", () => ({ BreadcrumbBar: () => <div data-testid="breadcrumb" /> }));
vi.mock("../components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("../components/MobileBottomNav", () => ({ MobileBottomNav: () => null }));
vi.mock("../components/KeyboardShortcutsCheatsheet", () => ({
  KeyboardShortcutsCheatsheet: () => null,
}));
vi.mock("../context/AgentPanelContext", () => ({
  AgentPanelProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newAgentOpen: false,
    newGoalOpen: false,
    newIssueOpen: false,
    newProjectOpen: false,
    openNewIssue: vi.fn(),
  }),
}));
vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    sidebarOpen: false,
    setSidebarOpen: vi.fn(),
    toggleSidebar: vi.fn(),
    isMobile: false,
    setCollapsed: vi.fn(),
    toggleCollapse: vi.fn(),
  }),
}));
vi.mock("../hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock("../hooks/useCompanyPageMemory", () => ({ useCompanyPageMemory: vi.fn() }));
vi.mock("../api/health", () => ({
  healthApi: {
    get: vi.fn(() => Promise.resolve({ status: "ok", deploymentMode: healthState.deploymentMode })),
  },
}));

function renderLayout(initialPath: string) {
  return renderWithProviders(
    <Routes>
      {/* Root (no :companyPrefix) — exercises the first-time-founder redirect. */}
      <Route path="/" element={<Layout />}>
        <Route index element={<div data-testid="root-home">Root Home</div>} />
      </Route>
      <Route path=":companyPrefix" element={<Layout />}>
        <Route index element={<div data-testid="company-home">Company Home</div>} />
        <Route path="home" element={<div data-testid="company-home">Company Home</div>} />
      </Route>
    </Routes>,
    { initialEntries: [initialPath] },
  );
}

describe("Layout membership-aware routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    healthState.deploymentMode = "authenticated";
    mockCompanyContext.companies = [
      makeCompany({ id: "a", name: "Alpha", issuePrefix: "AAA" }),
      makeCompany({ id: "b", name: "Beta", issuePrefix: "BBB" }),
    ];
    mockCompanyContext.loading = false;
    mockCompanyContext.selectedCompanyId = null;
    mockCompanyContext.selectionSource = "bootstrap";
  });

  it("renders AccessRequired (no silent redirect) for a non-member prefix", async () => {
    renderLayout("/CCC/home");

    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument();
    // Names the requested prefix as context.
    expect(screen.getByText(/CCC/)).toBeInTheDocument();
    // The company page content did NOT render.
    expect(screen.queryByTestId("company-home")).toBeNull();
    // Crucially: NOT a silent redirect to the user's own first company.
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("still canonical-redirects a wrong-case prefix of an accessible company", async () => {
    renderLayout("/aaa/home");

    // Auto-corrects the casing → canonical /AAA/home (replace).
    await vi.waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith("/AAA/home", { replace: true }),
    );
    // The access-required surface must NOT appear for a resolvable company.
    expect(screen.queryByText("You don't have access to this")).toBeNull();
  });

  it("renders AccessRequired for an inaccessible prefix at ZERO companies (revoked last membership, cloud)", async () => {
    // A cloud user who lost their LAST membership then opens a /PREFIX/... URL
    // must get the honest AccessRequired surface — NOT be dropped into the
    // first-time founder onboarding flow. (Two effects previously conflicted:
    // the zero-company effect redirected to /onboarding, and the no-match effect
    // bailed on companies.length === 0, so noAccessPrefix was never set.)
    healthState.deploymentMode = "cloud_auth";
    mockCompanyContext.companies = [];
    renderLayout("/ACME/home");

    expect(await screen.findByText("You don't have access to this")).toBeInTheDocument();
    // Names the requested prefix as context.
    expect(screen.getByText(/ACME/)).toBeInTheDocument();
    // The company page content did NOT render.
    expect(screen.queryByTestId("company-home")).toBeNull();
    // Crucially: NOT a silent redirect into onboarding.
    expect(mockNavigate).not.toHaveBeenCalledWith("/onboarding");
  });

  it("still routes a zero-company user with NO requested prefix into onboarding (first-time founder, cloud)", async () => {
    // The first-time-founder path (root URL, no prefix) must be preserved: the
    // `!companyPrefix` guard on the zero-company redirect is what keeps this alive.
    healthState.deploymentMode = "cloud_auth";
    mockCompanyContext.companies = [];
    renderLayout("/");

    // Robust to the trailing options arg react-router threads through navigate().
    await vi.waitFor(() =>
      expect(mockNavigate.mock.calls.some((call) => call[0] === "/onboarding")).toBe(true),
    );
    expect(screen.queryByText("You don't have access to this")).toBeNull();
  });

  it("renders the company page for an exact-match accessible prefix and syncs selection", async () => {
    renderLayout("/AAA/home");

    expect(await screen.findByTestId("company-home")).toBeInTheDocument();
    expect(screen.queryByText("You don't have access to this")).toBeNull();
    expect(mockCompanyContext.setSelectedCompanyId).toHaveBeenCalledWith("a", {
      source: "route_sync",
    });
    // No redirect on an exact, canonical match.
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
