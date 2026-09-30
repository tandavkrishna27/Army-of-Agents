import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, mockCompanyContext, makeCompany } from "./test-utils";
import { InstanceSettingsPage } from "../pages/InstanceSettingsPage";
import { LobbyLayout } from "@/components/LobbyLayout";

// The page now renders inside the persistent LobbyLayout (which owns the shell
// and the secondary-sidebar slot the page fills via outlet context). Render it
// under a real LobbyLayout route so useOutletContext + the SecondarySidebar
// handoff work exactly as in production.
function renderSettings(opts?: { initialEntries?: string[] }) {
  return renderWithProviders(
    <Routes>
      <Route element={<LobbyLayout />}>
        <Route path="/instance/settings" element={<InstanceSettingsPage />} />
      </Route>
    </Routes>,
    { initialEntries: opts?.initialEntries ?? ["/instance/settings"] },
  );
}

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

// ── API mocks ─────────────────────────────────────────────────────────────────

const mockGetGeneral = vi.fn();
const mockUpdateGeneral = vi.fn();
const mockGetExperimental = vi.fn();
const mockUpdateExperimental = vi.fn();

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: (...args: unknown[]) => mockGetGeneral(...args),
    updateGeneral: (...args: unknown[]) => mockUpdateGeneral(...args),
    getExperimental: (...args: unknown[]) => mockGetExperimental(...args),
    updateExperimental: (...args: unknown[]) => mockUpdateExperimental(...args),
  },
}));

const mockSignOut = vi.fn();

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: vi.fn(),
    signInSocial: vi.fn(),
    signOut: (...args: unknown[]) => mockSignOut(...args),
  },
}));

const mockGetHealth = vi.fn();

vi.mock("../api/health", () => ({
  healthApi: {
    get: (...args: unknown[]) => mockGetHealth(...args),
  },
}));

// feedbackApi is only called when the Privacy tab is active — not needed here.
vi.mock("../api/feedback", () => ({
  feedbackApi: {
    listExports: vi.fn().mockResolvedValue([]),
  },
}));

// Stub out heavy sub-components that live on other tabs
vi.mock("../components/settings/HeartbeatsTab", () => ({
  HeartbeatsTab: () => <div data-testid="heartbeats-tab-stub" />,
}));

vi.mock("../components/settings/PrivacyTab", () => ({
  PrivacyTab: () => <div data-testid="privacy-tab-stub" />,
}));

vi.mock("../pages/PluginManager", () => ({
  PluginManager: () => <div data-testid="plugin-manager-stub" />,
}));

vi.mock("@/components/LobbySidebar", () => ({
  LobbySidebar: () => <aside data-testid="lobby-sidebar" />,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/UserMenu", () => ({ UserMenu: () => <div /> }));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("@/components/SecondarySidebar", () => ({
  SecondarySidebar: ({ sections }: { sections: Array<{ items: Array<{ id: string; label: string; onClick?: () => void }> }> }) => (
    <aside data-testid="secondary-sidebar">
      {sections.flatMap((s) => s.items).map((item) => (
        <button key={item.id} data-testid={`sidebar-item-${item.id}`} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </aside>
  ),
}));

// ── Default fixture data ───────────────────────────────────────────────────────

const defaultGeneralSettings = {
  censorUsernameInLogs: false,
  keyboardShortcuts: false,
};

const defaultExperimentalSettings = {
  enableIsolatedWorkspaces: false,
  autoRestartDevServerWhenIdle: false,
  enableWorkspaceTtlSweeper: false,
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("InstanceSettingsPage Sign out section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockCompanyContext.selectedCompany = makeCompany();
    mockCompanyContext.companies = [makeCompany()];
    mockGetGeneral.mockResolvedValue(defaultGeneralSettings);
    mockGetExperimental.mockResolvedValue(defaultExperimentalSettings);
    mockSignOut.mockResolvedValue(undefined);
    mockGetHealth.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
  });

  it("renders the Sign out button in the General tab", async () => {
    renderSettings();
    expect(
      await screen.findByRole("button", { name: /sign out/i }),
    ).toBeInTheDocument();
  });

  it("renders the Sign out section heading and description", async () => {
    renderSettings();
    const heading = await screen.findByRole("heading", { name: "Sign out", level: 2 });
    expect(heading).toBeInTheDocument();
    expect(
      await screen.findByText(/sign out of this AoA instance/i),
    ).toBeInTheDocument();
  });

  it("calls authApi.signOut on button click", async () => {
    const user = userEvent.setup();
    renderSettings();

    const button = await screen.findByRole("button", { name: /sign out/i });
    await user.click(button);

    await waitFor(() => expect(mockSignOut).toHaveBeenCalledTimes(1));
  });

  it("disables the button while sign-out is pending", async () => {
    // Return a promise that never resolves so isPending stays true
    mockSignOut.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    renderSettings();

    const button = await screen.findByRole("button", { name: /sign out/i });
    await user.click(button);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /signing out/i }),
      ).toBeDisabled(),
    );
  });

  describe("Sign out section visibility by deployment mode", () => {
    it("hides the Sign out section when deploymentMode is local_trusted", async () => {
      mockGetHealth.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });
      renderSettings();

      // Wait for general settings to load so the General tab body is rendered.
      await screen.findByRole("heading", { name: /keyboard shortcuts/i });

      expect(
        screen.queryByRole("heading", { name: "Sign out", level: 2 }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /sign out/i }),
      ).not.toBeInTheDocument();
    });

    it("renders the Sign out section when deploymentMode is authenticated", async () => {
      mockGetHealth.mockResolvedValue({ status: "ok", deploymentMode: "authenticated" });
      renderSettings();

      expect(
        await screen.findByRole("heading", { name: "Sign out", level: 2 }),
      ).toBeInTheDocument();
    });

    it("renders the Sign out section when deploymentMode is undefined (legacy)", async () => {
      mockGetHealth.mockResolvedValue({ status: "ok" });
      renderSettings();

      expect(
        await screen.findByRole("heading", { name: "Sign out", level: 2 }),
      ).toBeInTheDocument();
    });
  });

  it("renders SecondarySidebar with all 8 settings sections after deployment mode resolves", async () => {
    renderSettings();
    expect(screen.getByTestId("secondary-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-general")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-health")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-privacy")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-backups")).toBeInTheDocument();
    expect(await screen.findByTestId("sidebar-item-heartbeats")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-experimental")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-plugins")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-access")).toBeInTheDocument();
  });

  it("clicking a non-Access sidebar item switches the active tab to that section", async () => {
    const user = userEvent.setup();
    renderSettings({ initialEntries: ["/instance/settings"] });
    // General is active on load, so the Privacy body is not mounted yet
    // (Radix Tabs only renders the active TabsContent).
    expect(screen.queryByTestId("privacy-tab-stub")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("sidebar-item-privacy"));
    // handleTabChange("privacy") → setSearchParams({tab:privacy}) → activeTab
    // becomes "privacy" → the Privacy tab body mounts. Fails if the click wiring
    // is broken (the previous assertion could not fail).
    expect(await screen.findByTestId("privacy-tab-stub")).toBeInTheDocument();
  });
});
