import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { mockCompanyContext } from "./test-utils";

// ── Mock functions ────────────────────────────────────────────────────────────
const mockStatus = vi.fn();
const mockAppStatus = vi.fn();
const mockGetAppInstallUrl = vi.fn();
const mockDisconnectApp = vi.fn();
const mockSetPat = vi.fn();
const mockRemovePat = vi.fn();
const mockPushToast = vi.fn();

vi.mock("../api/github-integration", () => ({
  githubIntegrationApi: {
    status: (...args: unknown[]) => mockStatus(...args),
    appStatus: (...args: unknown[]) => mockAppStatus(...args),
    getAppInstallUrl: (...args: unknown[]) => mockGetAppInstallUrl(...args),
    disconnectApp: (...args: unknown[]) => mockDisconnectApp(...args),
    setPat: (...args: unknown[]) => mockSetPat(...args),
    removePat: (...args: unknown[]) => mockRemovePat(...args),
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    toasts: [],
    pushToast: (...args: unknown[]) => mockPushToast(...args),
    dismissToast: vi.fn(),
    clearToasts: vi.fn(),
  }),
}));

let mockSelectedCompanyId: string | null = "co-1";
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    ...mockCompanyContext,
    selectedCompanyId: mockSelectedCompanyId,
  }),
}));

import { GitHubIntegrationCard } from "../components/GitHubIntegrationCard";

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(<GitHubIntegrationCard />, { wrapper: Wrapper });
}

// ── Shared defaults ───────────────────────────────────────────────────────────
function setupDefaults() {
  mockStatus.mockResolvedValue({ configured: false });
  mockAppStatus.mockResolvedValue({ installed: false });
  mockGetAppInstallUrl.mockResolvedValue({
    url: "https://github.com/apps/test-app/installations/new",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe("GitHubIntegrationCard — App section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectedCompanyId = "co-1";
    setupDefaults();
  });

  it("shows Connect with GitHub button when App not installed", async () => {
    renderCard();
    expect(
      await screen.findByRole("button", { name: /connect with github/i }),
    ).toBeInTheDocument();
  });

  it("shows App connected badge when installed", async () => {
    mockAppStatus.mockResolvedValue({
      installed: true,
      accountLogin: "myorg",
      accountType: "Organization",
    });
    renderCard();
    // "@myorg" now appears in both the status strip (summary) and the App card
    // (detail) — assert it renders at least once rather than requiring one node.
    expect((await screen.findAllByText(/myorg/i)).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /disconnect app/i }),
    ).toBeInTheDocument();
  });

  it("calls disconnectApp on disconnect click", async () => {
    const user = userEvent.setup();
    mockAppStatus.mockResolvedValue({
      installed: true,
      accountLogin: "myorg",
      accountType: "Organization",
    });
    mockDisconnectApp.mockResolvedValue({ removed: true });
    renderCard();
    await user.click(await screen.findByRole("button", { name: /disconnect app/i }));
    await waitFor(() => expect(mockDisconnectApp).toHaveBeenCalledWith("co-1"));
  });

  it("still shows PAT section when App is installed (both coexist)", async () => {
    mockAppStatus.mockResolvedValue({
      installed: true,
      accountLogin: "myorg",
      accountType: "Organization",
    });
    renderCard();
    await screen.findAllByText(/myorg/i);
    // PAT input section should still be visible as fallback
    expect(screen.getByPlaceholderText(/github_pat/i)).toBeInTheDocument();
  });

  it("shows PAT connected state when PAT configured but App not installed", async () => {
    mockStatus.mockResolvedValue({
      configured: true,
      githubUser: "octocat",
      createdAt: new Date().toISOString(),
    });
    renderCard();
    expect((await screen.findAllByText(/@octocat/)).length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GitHubIntegrationCard — PAT section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectedCompanyId = "co-1";
    setupDefaults();
  });

  it("renders nothing when selectedCompanyId is null", () => {
    mockSelectedCompanyId = null;
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it("renders disconnected state with Connect button + PAT input when not configured", async () => {
    renderCard();

    await waitFor(() => expect(mockStatus).toHaveBeenCalledWith("co-1"));

    const input = await screen.findByLabelText(/github personal access token/i);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: /^connect$/i })).toBeInTheDocument();
    // Link to PAT docs.
    const link = screen.getByRole("link", { name: /create a github pat/i });
    expect(link).toHaveAttribute("href", expect.stringContaining("github.com/settings/tokens"));
  });

  it("renders connected-PAT state with username + Disconnect when configured (App not installed)", async () => {
    mockStatus.mockResolvedValue({
      configured: true,
      githubUser: "octocat",
      createdAt: "2026-04-22T10:00:00Z",
    });

    renderCard();

    await waitFor(() =>
      expect(screen.getByText(/connected as/i)).toBeInTheDocument(),
    );
    // "@octocat" appears in both the status strip and the PAT card detail.
    expect(screen.getAllByText(/@octocat/i).length).toBeGreaterThan(0);
    // Disconnect button is present for the PAT
    expect(screen.getByRole("button", { name: /^disconnect$/i })).toBeInTheDocument();
    // In the connected-PAT state, the PAT input is NOT shown (replaced by connected banner)
    expect(
      screen.queryByLabelText(/github personal access token/i),
    ).not.toBeInTheDocument();
  });

  it("typing + clicking Connect calls setPat and clears the input on success", async () => {
    mockStatus.mockResolvedValueOnce({ configured: false });
    mockStatus.mockResolvedValueOnce({
      configured: true,
      githubUser: "octocat",
      createdAt: "2026-04-22T10:00:00Z",
    });
    mockSetPat.mockResolvedValue({ configured: true, githubUser: "octocat" });

    const user = userEvent.setup();
    renderCard();

    const input = (await screen.findByLabelText(
      /github personal access token/i,
    )) as HTMLInputElement;

    await user.type(input, "ghp_validtoken");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => {
      expect(mockSetPat).toHaveBeenCalledWith("co-1", "ghp_validtoken");
    });
    // Success toast fires.
    await waitFor(() => {
      expect(mockPushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("octocat"),
          tone: "success",
        }),
      );
    });
    // Status query invalidated → refetch.
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(2));
    // Connected state should now be visible.
    expect(await screen.findByText(/connected as/i)).toBeInTheDocument();
  });

  it("clicking Disconnect calls removePat and refetches status", async () => {
    mockStatus.mockResolvedValueOnce({
      configured: true,
      githubUser: "octocat",
      createdAt: "2026-04-22T10:00:00Z",
    });
    mockStatus.mockResolvedValueOnce({ configured: false });
    mockRemovePat.mockResolvedValue({ configured: false, removed: true });

    const user = userEvent.setup();
    renderCard();

    const disconnectBtn = await screen.findByRole("button", { name: /^disconnect$/i });
    await user.click(disconnectBtn);

    await waitFor(() => expect(mockRemovePat).toHaveBeenCalledWith("co-1"));
    await waitFor(() => expect(mockStatus).toHaveBeenCalledTimes(2));
    // Should flip to disconnected state.
    expect(
      await screen.findByLabelText(/github personal access token/i),
    ).toBeInTheDocument();
  });

  it("shows inline error when setPat throws + keeps input value", async () => {
    mockStatus.mockResolvedValue({ configured: false });
    mockSetPat.mockRejectedValue(new Error("Invalid GitHub PAT"));

    const user = userEvent.setup();
    renderCard();

    const input = (await screen.findByLabelText(
      /github personal access token/i,
    )) as HTMLInputElement;

    await user.type(input, "ghp_bogus");
    await user.click(screen.getByRole("button", { name: /^connect$/i }));

    // Inline error shown
    expect(await screen.findByText(/invalid github pat/i)).toBeInTheDocument();
    // Input value retained so user can fix/retry.
    expect(input).toHaveValue("ghp_bogus");
  });

  it("Connect button is disabled when input is empty", async () => {
    mockStatus.mockResolvedValue({ configured: false });
    renderCard();

    const btn = await screen.findByRole("button", { name: /^connect$/i });
    expect(btn).toBeDisabled();
  });
});

describe("GitHubIntegrationCard — card structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectedCompanyId = "co-1";
    setupDefaults();
  });

  it("shows a Not-connected status strip when neither App nor PAT is configured", async () => {
    renderCard();
    const strip = await screen.findByTestId("github-status-strip");
    expect(strip).toHaveTextContent(/not connected/i);
  });

  it("shows a Connected-via-App status strip when the App is installed", async () => {
    mockAppStatus.mockResolvedValue({
      installed: true,
      accountLogin: "myorg",
      accountType: "Organization",
    });
    renderCard();
    const strip = await screen.findByTestId("github-status-strip");
    expect(strip).toHaveTextContent(/connected via github app/i);
    expect(strip).toHaveTextContent(/myorg/i);
  });

  it("renders the GitHub App and Personal access token card headers", async () => {
    renderCard();
    expect(
      await screen.findByRole("heading", { name: /^GitHub App$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /^Personal access token$/ }),
    ).toBeInTheDocument();
  });
});
