import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext } from "./test-utils";
import { UserMenu } from "../components/UserMenu";

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

const profileGet = vi.fn();
const signOut = vi.fn();

vi.mock("@/api/profile", () => ({
  profileApi: { get: (...args: unknown[]) => profileGet(...args) },
}));

vi.mock("@/api/auth", () => ({
  authApi: { signOut: (...args: unknown[]) => signOut(...args) },
}));

const resetSidebar = vi.fn();
vi.mock("@/hooks/useSidebarOrder", () => ({
  useSidebarOrder: () => ({
    departmentOrder: [],
    projectOrder: [],
    orderFor: () => [],
    setOrder: vi.fn(),
    flushPending: vi.fn(),
    resetToDefault: resetSidebar,
    isSyncing: false,
    isLoading: false,
  }),
}));

describe("UserMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileGet.mockResolvedValue({
      id: "user-1",
      email: "alice@example.com",
      displayName: "Alice",
      avatarUrl: null,
    });
    signOut.mockResolvedValue(undefined);
  });

  it("renders avatar trigger with user initials", async () => {
    renderWithProviders(<UserMenu />);
    const trigger = await screen.findByRole("button", { name: /account menu/i });
    expect(trigger).toBeInTheDocument();
    // Initials derive from displayName "Alice" → "AL"
    await waitFor(() => expect(trigger).toHaveTextContent(/AL/i));
  });

  it("shows display name when expanded", async () => {
    renderWithProviders(<UserMenu collapsed={false} />);
    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });
  });

  it("opens dropdown with Profile and Sign out items on click", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserMenu />);
    const trigger = await screen.findByRole("button", { name: /account menu/i });
    await user.click(trigger);
    expect(await screen.findByRole("menuitem", { name: /profile/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /sign out/i })).toBeInTheDocument();
  });

  it("navigates to /me when Profile is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserMenu />);
    await user.click(await screen.findByRole("button", { name: /account menu/i }));
    await user.click(await screen.findByRole("menuitem", { name: /profile/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/me", undefined);
  });

  it("calls signOut and navigates to /auth when Sign out is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UserMenu />);
    await user.click(await screen.findByRole("button", { name: /account menu/i }));
    await user.click(await screen.findByRole("menuitem", { name: /sign out/i }));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/auth", undefined));
  });

  it("calls sidebar resetToDefault when 'Reset sidebar to default' is selected", async () => {
    const previous = mockCompanyContext.selectedCompanyId;
    mockCompanyContext.selectedCompanyId = "11111111-1111-1111-1111-111111111111";
    try {
      const user = userEvent.setup();
      renderWithProviders(<UserMenu />);
      await user.click(await screen.findByRole("button", { name: /account menu/i }));
      await user.click(
        await screen.findByRole("menuitem", { name: /reset sidebar to default/i }),
      );
      expect(resetSidebar).toHaveBeenCalledTimes(1);
    } finally {
      mockCompanyContext.selectedCompanyId = previous;
    }
  });
});
