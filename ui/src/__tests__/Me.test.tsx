import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext } from "./test-utils";
import { Me } from "../pages/Me";

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

const pushToast = vi.fn();
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

const profileGet = vi.fn();
const profileUpdate = vi.fn();
vi.mock("@/api/profile", () => ({
  profileApi: {
    get: (...args: unknown[]) => profileGet(...args),
    update: (...args: unknown[]) => profileUpdate(...args),
  },
}));

function editableProfile() {
  return {
    id: "user-1",
    email: "alice@example.com",
    displayName: "Alice",
    avatarUrl: null,
    canManageInstanceSettings: false,
    isInstanceAdmin: false,
  };
}

describe("Me page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileGet.mockResolvedValue(editableProfile());
  });

  it("renders display name and email from profile", async () => {
    renderWithProviders(<Me />);
    expect(await screen.findByDisplayValue("Alice")).toBeInTheDocument();
    expect(screen.getByDisplayValue("alice@example.com")).toBeInTheDocument();
  });

  it("save button is disabled until the form is edited", async () => {
    renderWithProviders(<Me />);
    await screen.findByDisplayValue("Alice");
    const saveBtn = screen.getByRole("button", { name: /save changes/i });
    expect(saveBtn).toBeDisabled();
  });

  it("submits updated displayName via profileApi.update", async () => {
    const user = userEvent.setup();
    profileUpdate.mockResolvedValue({
      ...editableProfile(),
      displayName: "Alicia",
    });
    renderWithProviders(<Me />);
    const input = await screen.findByLabelText(/display name/i);
    await user.clear(input);
    await user.type(input, "Alicia");
    const saveBtn = screen.getByRole("button", { name: /save changes/i });
    await user.click(saveBtn);
    await waitFor(() =>
      expect(profileUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ displayName: "Alicia" }),
      ),
    );
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" })),
    );
  });

  it("shows read-only banner when profile has no email (local_implicit)", async () => {
    profileGet.mockResolvedValue({
      id: "local-board",
      email: null,
      displayName: "Local Board",
      avatarUrl: null,
      canManageInstanceSettings: true,
      isInstanceAdmin: true,
    });
    renderWithProviders(<Me />);
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    const input = await screen.findByLabelText(/display name/i);
    expect(input).toBeDisabled();
  });

  // ── Instance-settings gear gating (N2) ─────────────────────────────────────

  describe("instance settings gear", () => {
    it("hides the gear for non-instance-admins", async () => {
      profileGet.mockResolvedValue({
        ...editableProfile(),
        canManageInstanceSettings: false,
        isInstanceAdmin: false,
      });
      renderWithProviders(<Me />);
      // Post-settle marker: the form only renders once the profile resolved.
      await screen.findByDisplayValue("Alice");
      expect(screen.queryByRole("button", { name: /instance settings/i })).toBeNull();
    });

    it("hides the gear while the profile is loading (default hidden)", () => {
      profileGet.mockReturnValue(new Promise(() => {})); // never resolves
      renderWithProviders(<Me />);
      expect(screen.queryByRole("button", { name: /instance settings/i })).toBeNull();
    });

    it("shows the gear for instance admins and navigates to /instance/settings", async () => {
      const user = userEvent.setup();
      profileGet.mockResolvedValue({
        ...editableProfile(),
        canManageInstanceSettings: true,
        isInstanceAdmin: true,
      });
      renderWithProviders(<Me />);
      const gear = await screen.findByRole("button", {
        name: /instance settings/i,
      });
      await user.click(gear);
      expect(mockNavigate).toHaveBeenCalledWith("/instance/settings", undefined);
    });
  });
});
