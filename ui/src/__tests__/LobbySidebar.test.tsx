import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext } from "./test-utils";
import { LobbySidebar } from "../components/LobbySidebar";

// --- Mocks ---

const mockNavigate = vi.fn();

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

// UserMenu pulls in profile/auth queries; stub it for sidebar isolation.
vi.mock("@/components/UserMenu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));

// The sidebar gates the instance-Settings row on the canonical operator-plane
// capability returned by profileApi.get().
const mockProfileGet = vi.fn();
vi.mock("@/api/profile", () => ({
  profileApi: {
    get: (...args: unknown[]) => mockProfileGet(...args),
  },
}));

// Tooltip from Radix needs a TooltipProvider context, which the test renderer
// doesn't supply. Stub Tooltip+children so collapsed-mode buttons render.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: any) => (asChild ? children : <>{children}</>),
  TooltipContent: () => null,
  TooltipProvider: ({ children }: any) => <>{children}</>,
}));

// Radix DropdownMenu doesn't run cleanly in jsdom (portal + pointer events).
// Render children inline and map onSelect→onClick so items are directly testable.
// Same convention as AgentCard.test.tsx.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: any) => <>{children}</>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: any) => (
    <div role="menuitem" onClick={onSelect}>
      {children}
    </div>
  ),
}));

// --- Tests ---

describe("LobbySidebar", () => {
  const onCreateCompany = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    onCreateCompany.mockClear();
    mockCompanyContext.companies = [];
    mockCompanyContext.loading = false;
    mockProfileGet.mockResolvedValue({
      id: "user-1",
      email: "user@example.com",
      displayName: "User One",
      avatarUrl: null,
      canManageInstanceSettings: true,
      isInstanceAdmin: true,
    });
    // Reset persisted collapse preference between tests so default is expanded.
    try {
      localStorage.removeItem("aoa.lobby.sidebar-collapsed");
    } catch {
      // noop
    }
  });

  it("renders the AoA brand wordmark", () => {
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    // Expanded brand renders "AoA" + a brand-red period span as siblings.
    expect(screen.getByText("AoA")).toBeInTheDocument();
  });

  it("renders the + New company button at the top", () => {
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(screen.getByRole("button", { name: /new company/i })).toBeInTheDocument();
  });

  it("clicking + New company calls the onCreateCompany handler", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    await user.click(screen.getByRole("button", { name: /new company/i }));
    expect(onCreateCompany).toHaveBeenCalledTimes(1);
  });

  it("renders Companies (active), Marketplace, Learn, Documentation, Settings", async () => {
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(screen.getByRole("button", { name: /companies/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /marketplace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /learn/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /documentation/i })).toBeInTheDocument();
    // Settings appears once the profile query resolves (instance admin).
    expect(await screen.findByRole("button", { name: /settings/i })).toBeInTheDocument();
  });

  it("Companies row is the active item (data-active=true)", () => {
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    const companies = screen.getByRole("button", { name: /companies/i });
    expect(companies.getAttribute("data-active")).toBe("true");
  });

  it("labels the company list 'Companies' / 'New company', never 'Organizations'", () => {
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(screen.getByRole("button", { name: /^companies$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^new company$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /organizations/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /new organization/i })).toBeNull();
  });

  it("renders the UserMenu at the bottom", () => {
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(screen.getByTestId("user-menu")).toBeInTheDocument();
  });

  it("renders the external collapse toggle button", () => {
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(screen.getByRole("button", { name: /collapse sidebar/i })).toBeInTheDocument();
  });

  it("clicking Marketplace navigates to /marketplace", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    await user.click(screen.getByRole("button", { name: /marketplace/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/marketplace", undefined);
  });

  it("clicking Settings navigates to /instance/settings", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    await user.click(await screen.findByRole("button", { name: /settings/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/instance/settings", undefined);
  });

  // --- Instance-Settings row gating (N2) ---
  //
  // The non-admin test resolves a deferred profile INSIDE act() and asserts
  // absence strictly post-settle; its control twin runs the exact same flush
  // with canManageInstanceSettings: true and requires the row synchronously. Together
  // they guarantee the absence assertion is not vacuous (pre-settle the row
  // is also hidden, so a truthiness regression could otherwise slip past).

  function deferredProfile() {
    let resolveProfile!: (value: unknown) => void;
    mockProfileGet.mockReturnValue(
      new Promise((resolve) => {
        resolveProfile = resolve;
      }),
    );
    return async (overrides: Record<string, unknown>) => {
      // react-query delivers observer notifications on its default scheduler
      // (setTimeout(cb, 0)). A fixed setTimeout(0) hop was NOT a reliable settle
      // barrier — that macrotask races React 19 act()'s MessageChannel flush, so
      // the "control" test flaked on CI. Keep the PRODUCTION scheduler but drive
      // it under fake timers and flush every pending timer + microtask INSIDE
      // act via runAllTimersAsync — deterministic, and the notification lands
      // inside act (no "not wrapped in act" warnings, unlike a synchronous
      // scheduler override). Scoped to this deferred flow only; the other tests
      // (which use userEvent / findBy) keep real timers.
      vi.useFakeTimers();
      try {
        await act(async () => {
          resolveProfile({
            id: "user-2",
            email: "teammate@example.com",
            displayName: "Teammate",
            avatarUrl: null,
            ...overrides,
          });
          await vi.runAllTimersAsync();
        });
      } finally {
        vi.useRealTimers();
      }
    };
  }

  it("hides the Settings row (and System section header) for non-instance-admins", async () => {
    const resolveWith = deferredProfile();
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    await resolveWith({
      canManageInstanceSettings: false,
      isInstanceAdmin: false,
    });
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
    expect(screen.queryByText("System")).toBeNull();
  });

  it("control: the identical post-settle flush shows the row for operators", async () => {
    const resolveWith = deferredProfile();
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    await resolveWith({
      canManageInstanceSettings: true,
      isInstanceAdmin: true,
    });
    // Must be present synchronously after the same flush the non-admin test
    // uses — proves that flush is sufficient for the absence assertions above.
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("does not flash the Settings row while the profile is still loading (default hidden)", () => {
    mockProfileGet.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
  });

  it("shows the Settings row for instance admins", async () => {
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(await screen.findByRole("button", { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
  });

  it("has an aside element", () => {
    const { container } = renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
  });

  it("applies the lobby-sidebar-enter mount-animation class", () => {
    const { container } = renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    const aside = container.querySelector("aside");
    expect(aside).toBeTruthy();
    expect(aside!.className).toContain("lobby-sidebar-enter");
  });

  it("toggling the collapse button flips data-collapsed on the aside", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    const aside = container.querySelector("aside");
    expect(aside?.getAttribute("data-collapsed")).toBe("false");
    await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));
    expect(aside?.getAttribute("data-collapsed")).toBe("true");
  });

  it("force-collapses when a secondary sidebar is present, even if localStorage says expanded", () => {
    localStorage.setItem("aoa.lobby.sidebar-collapsed", "false");
    const { container } = renderWithProviders(
      <LobbySidebar onCreateCompany={onCreateCompany} hasSecondarySidebar activeItem="settings" />,
    );
    expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("true");
  });

  it("reflects the stored preference when no secondary sidebar is present", () => {
    localStorage.setItem("aoa.lobby.sidebar-collapsed", "true");
    const { container } = renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("true");
  });

  it("collapses/expands reactively when hasSecondarySidebar toggles without remount (persistent-layout transition)", () => {
    // Persistent LobbyLayout keeps this component mounted across navigation, so
    // rerender (not remount) mirrors navigating into/out of Settings.
    localStorage.setItem("aoa.lobby.sidebar-collapsed", "false");
    const { container, rerender } = renderWithProviders(
      <LobbySidebar onCreateCompany={onCreateCompany} />,
    );
    expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("false");
    // Navigate INTO a secondary-sidebar page → force-collapse.
    rerender(
      <LobbySidebar onCreateCompany={onCreateCompany} hasSecondarySidebar activeItem="settings" />,
    );
    expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("true");
    // Navigate back OUT → restore the expanded preference.
    rerender(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("false");
  });

  it("peek-expanding on a secondary-sidebar page does not persist the preference", async () => {
    const user = userEvent.setup();
    localStorage.setItem("aoa.lobby.sidebar-collapsed", "false");
    const { container } = renderWithProviders(
      <LobbySidebar onCreateCompany={onCreateCompany} hasSecondarySidebar activeItem="settings" />,
    );
    await user.click(screen.getByRole("button", { name: /expand sidebar/i }));
    expect(container.querySelector("aside")?.getAttribute("data-collapsed")).toBe("false");
    expect(localStorage.getItem("aoa.lobby.sidebar-collapsed")).toBe("false");
  });

  // --- Rounded floating rail (Task 1) ---

  it("renders the primary rail as a rounded floating island (no right border)", () => {
    const { container } = renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    const aside = container.querySelector("aside")!;
    expect(aside.className).toContain("rounded-2xl");
    expect(aside.className).toContain("border-border");
    // Floating island uses an all-sides border, not the old flush right border.
    expect(aside.className).not.toContain("border-r");
  });

  it("drawer mode is full-width and NOT rounded", () => {
    const { container } = renderWithProviders(
      <LobbySidebar onCreateCompany={onCreateCompany} drawer />,
    );
    const aside = container.querySelector("aside")!;
    expect(aside.className).toContain("w-full");
    expect(aside.className).not.toContain("rounded-2xl");
  });

  // --- New-organization split button + floating Import menu (Task 2) ---

  it("expanded: renders the create button and the More-options trigger", () => {
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(screen.getByRole("button", { name: /^new company$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /more company options/i })).toBeInTheDocument();
  });

  it("Import company menuitem navigates to /import", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    await user.click(screen.getByRole("menuitem", { name: /import company/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/import", undefined);
  });

  it("primary + New company still creates in one click (no regression)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    await user.click(screen.getByRole("button", { name: /^new company$/i }));
    expect(onCreateCompany).toHaveBeenCalledTimes(1);
  });

  it("collapsed: no More-options trigger and no import menuitem (create-only)", () => {
    localStorage.setItem("aoa.lobby.sidebar-collapsed", "true");
    renderWithProviders(<LobbySidebar onCreateCompany={onCreateCompany} />);
    expect(screen.queryByRole("button", { name: /more company options/i })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /import company/i })).toBeNull();
  });
});
