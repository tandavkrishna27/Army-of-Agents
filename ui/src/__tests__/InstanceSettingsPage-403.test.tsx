import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routes, Route } from "react-router-dom";
import { renderWithProviders, mockCompanyContext, makeCompany } from "./test-utils";
import { InstanceSettingsPage } from "../pages/InstanceSettingsPage";
import { ApiError } from "../api/client";
import { LobbyLayout } from "@/components/LobbyLayout";

// N2: a non-instance-admin who deep-links to /instance/settings gets a
// purposeful "requires instance-admin access" state instead of the dead
// "Failed to load general settings." (the server 403s every instance-settings
// query for them). Harness mirrors InstanceSettingsPage-signout.test.tsx.

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

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

vi.mock("../api/auth", () => ({
  authApi: {
    getSession: vi.fn(),
    signInSocial: vi.fn(),
    signOut: vi.fn(),
  },
}));

const mockGetHealth = vi.fn();

vi.mock("../api/health", () => ({
  healthApi: {
    get: (...args: unknown[]) => mockGetHealth(...args),
  },
}));

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
  SecondarySidebar: () => <aside data-testid="secondary-sidebar" />,
}));

// ── Tests ──────────────────────────────────────────────────────────────────────

const forbidden = () =>
  new ApiError("Instance admin access required", 403, {
    error: "Instance admin access required",
  });

describe("InstanceSettingsPage 403 access state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockCompanyContext.selectedCompany = makeCompany();
    mockCompanyContext.companies = [makeCompany()];
    mockGetGeneral.mockRejectedValue(forbidden());
    mockGetExperimental.mockRejectedValue(forbidden());
    mockGetHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
    });
  });

  it("renders the instance-admin-required state instead of the raw failure copy", async () => {
    renderSettings();

    expect(
      await screen.findByRole("heading", {
        name: /instance settings require instance-admin access/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/open your company and go to\s*settings there/i)).toBeInTheDocument();
    expect(screen.queryByText("Failed to load general settings.")).not.toBeInTheDocument();
  });

  it("offers a button into the selected company's settings", async () => {
    const user = userEvent.setup();
    renderSettings();

    const button = await screen.findByRole("button", {
      name: /open company settings/i,
    });
    await user.click(button);
    // makeCompany() has issuePrefix "TC" → company settings route.
    expect(mockNavigate).toHaveBeenCalledWith("/TC/settings");
  });

  it("falls back to the Lobby when no company is selected", async () => {
    mockCompanyContext.selectedCompany = null;
    mockCompanyContext.selectedCompanyId = null;
    mockCompanyContext.companies = [];
    const user = userEvent.setup();
    renderSettings();

    const button = await screen.findByRole("button", {
      name: /back to lobby/i,
    });
    await user.click(button);
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("keeps the existing failure copy for non-403 errors", async () => {
    // 400: a non-403 client error — fails fast under the page's 4xx-aware
    // retry (5xx would exercise the real 3-retry backoff and slow the test).
    mockGetGeneral.mockRejectedValue(new ApiError("boom", 400, { error: "boom" }));
    mockGetExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      enableWorkspaceTtlSweeper: false,
    });
    renderSettings();

    expect(await screen.findByText("Failed to load general settings.")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: /instance settings require instance-admin access/i,
      }),
    ).not.toBeInTheDocument();
  });

  it("shows the access state when only the experimental query 403s", async () => {
    mockGetGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
    });
    renderSettings({ initialEntries: ["/instance/settings?tab=experimental"] });

    expect(
      await screen.findByRole("heading", {
        name: /instance settings require instance-admin access/i,
      }),
    ).toBeInTheDocument();
  });

  it("fails closed on a cloud heartbeats deep link before mounting the heartbeat view", async () => {
    mockGetGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
    });
    mockGetExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      enableWorkspaceTtlSweeper: false,
    });
    mockGetHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "cloud_auth",
    });
    const user = userEvent.setup();
    renderSettings({ initialEntries: ["/instance/settings?tab=heartbeats"] });

    const heading = await screen.findByRole("heading", {
      name: /heartbeats is unavailable on aoa cloud/i,
    });
    expect(document.activeElement).toBe(heading);
    expect(screen.queryByTestId("heartbeats-tab-stub")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^heartbeats$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^access$/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /back to general/i }));
    expect(mockNavigate.mock.calls[0]?.[0]).toBe("/instance/settings?tab=general");
  });

  it("does not mount heartbeats while deployment health is still loading", async () => {
    mockGetHealth.mockReturnValue(new Promise(() => {}));
    renderSettings({ initialEntries: ["/instance/settings?tab=heartbeats"] });

    expect(
      await screen.findByRole("heading", {
        name: /checking heartbeats availability/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("heartbeats-tab-stub")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^heartbeats$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^access$/i })).not.toBeInTheDocument();
  });

  it("shows the cloud-unavailable state even when operator settings requests are denied", async () => {
    mockGetHealth.mockResolvedValue({ status: "ok", deploymentMode: "cloud_auth" });
    renderSettings({ initialEntries: ["/instance/settings?tab=heartbeats"] });

    expect(
      await screen.findByRole("heading", {
        name: /heartbeats is unavailable on aoa cloud/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: /instance settings require instance-admin access/i,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("heartbeats-tab-stub")).not.toBeInTheDocument();
  });

  it("keeps heartbeats closed when health fails and retries explicitly", async () => {
    mockGetGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      keyboardShortcuts: false,
    });
    mockGetExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      autoRestartDevServerWhenIdle: false,
      enableWorkspaceTtlSweeper: false,
    });
    mockGetHealth.mockRejectedValueOnce(new Error("offline"));
    mockGetHealth.mockResolvedValueOnce({
      status: "ok",
      deploymentMode: "cloud_auth",
    });
    const user = userEvent.setup();
    renderSettings({ initialEntries: ["/instance/settings?tab=heartbeats"] });

    expect(
      await screen.findByRole("heading", {
        name: /couldn't verify heartbeats availability/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("heartbeats-tab-stub")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retry deployment check/i }));
    expect(
      await screen.findByRole("heading", {
        name: /heartbeats is unavailable on aoa cloud/i,
      }),
    ).toBeInTheDocument();
    expect(mockGetHealth).toHaveBeenCalledTimes(2);
  });
});
