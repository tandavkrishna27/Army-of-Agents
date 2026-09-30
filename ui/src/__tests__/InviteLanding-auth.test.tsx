import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getSession: vi.fn(),
  getInvite: vi.fn(),
  acceptInvite: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../api/health", () => ({
  healthApi: { get: mocks.getHealth },
}));
vi.mock("../api/auth", () => ({
  authApi: { getSession: mocks.getSession },
}));
vi.mock("../api/access", () => ({
  accessApi: {
    getInvite: mocks.getInvite,
    acceptInvite: mocks.acceptInvite,
  },
}));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ token: "invite-token" }),
  useNavigate: () => mocks.navigate,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import { InviteLandingPage } from "../pages/InviteLanding";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <InviteLandingPage />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

describe("InviteLandingPage authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue(null);
    mocks.acceptInvite.mockResolvedValue({ id: "join-1" });
    mocks.getInvite.mockResolvedValue({
      id: "invite-1",
      inviteType: "company_join",
      allowedJoinTypes: "both",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("names the company in the heading when the summary carries companyName", async () => {
    mocks.getHealth.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });
    mocks.getInvite.mockResolvedValue({
      id: "invite-1",
      companyId: "company-42",
      companyName: "Acme Rockets",
      inviteType: "company_join",
      allowedJoinTypes: "both",
      expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    });

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Join Acme Rockets on AoA" }),
    ).toBeInTheDocument();
    // Relative, honest expiry copy (formatInviteExpiry) — not a raw timestamp.
    expect(screen.getByText(/invite expires in 6 days\./i)).toBeInTheDocument();
    // Title-case pills.
    expect(screen.getByRole("button", { name: "Join as a human" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect an agent" })).toBeInTheDocument();
  });

  it("falls back to the generic heading when the summary has no companyName", async () => {
    mocks.getHealth.mockResolvedValue({ status: "ok", deploymentMode: "local_trusted" });

    renderPage();

    expect(
      await screen.findByRole("heading", { name: /join this aoa company/i }),
    ).toBeInTheDocument();
  });

  it("requires sign-in for human acceptance when local_trusted has Google auth ready", async () => {
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "local_trusted",
      authReady: true,
    });

    renderPage();

    expect(await screen.findByText(/sign in or create an account/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /sign in \/ create account/i })).toHaveAttribute(
      "href",
      "/auth?next=%2Finvite%2Finvite-token",
    );
    expect(screen.getByRole("button", { name: /submit join request/i })).toBeDisabled();
  });

  it("keeps unauthenticated agent acceptance available when board auth is ready", async () => {
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "local_trusted",
      authReady: true,
    });

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /connect an agent/i }));
    fireEvent.change(screen.getByLabelText(/agent name/i), { target: { value: "Scout" } });

    expect(screen.queryByText(/sign in or create an account/i)).not.toBeInTheDocument();
    const submitButton = screen.getByRole("button", { name: /submit join request/i });
    expect(submitButton).toBeEnabled();
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mocks.acceptInvite).toHaveBeenCalledWith("invite-token", {
        requestType: "agent",
        agentName: "Scout",
        adapterType: "codex_local",
        capabilities: null,
      });
    });

    // Agent accepts keep their inline result screen (claim-secret display) —
    // only human accepts redirect into the guided invited flow.
    expect(await screen.findByText(/join request submitted/i)).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("keeps legacy local_trusted human acceptance compatible without authReady", async () => {
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "local_trusted",
    });

    renderPage();

    expect(await screen.findByRole("button", { name: /submit join request/i })).toBeEnabled();
    expect(screen.queryByText(/sign in or create an account/i)).not.toBeInTheDocument();
  });

  it("allows an authenticated human to submit when board auth is ready", async () => {
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "local_trusted",
      authReady: true,
    });
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });

    renderPage();

    const submitButton = await screen.findByRole("button", { name: /submit join request/i });
    expect(submitButton).toBeEnabled();
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mocks.acceptInvite).toHaveBeenCalledWith("invite-token", { requestType: "human" });
    });
  });

  it("routes a successful human accept into the guided invited flow instead of the inline result screen", async () => {
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "local_trusted",
      authReady: true,
    });
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.acceptInvite.mockResolvedValue({ id: "join-1", companyId: "company-42" });

    const { queryClient } = renderPage();
    const removeQueriesSpy = vi.spyOn(queryClient, "removeQueries");

    const submitButton = await screen.findByRole("button", { name: /submit join request/i });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mocks.navigate).toHaveBeenCalledWith(
        "/onboarding/join?company=company-42",
        { replace: true },
      );
    });

    expect(removeQueriesSpy).toHaveBeenCalledWith({ queryKey: ["onboarding", "journey"], exact: true });
    expect(screen.queryByText(/join request submitted/i)).not.toBeInTheDocument();
  });

  it("does not redirect a bootstrap-CEO accept (keeps the inline bootstrap-complete screen)", async () => {
    mocks.getHealth.mockResolvedValue({
      status: "ok",
      deploymentMode: "local_trusted",
      authReady: true,
    });
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getInvite.mockResolvedValue({
      id: "invite-1",
      inviteType: "bootstrap_ceo",
      allowedJoinTypes: "both",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    mocks.acceptInvite.mockResolvedValue({ id: "join-1", bootstrapAccepted: true, companyId: "company-42" });

    renderPage();

    const submitButton = await screen.findByRole("button", { name: /accept bootstrap invite/i });
    fireEvent.click(submitButton);

    expect(await screen.findByText(/bootstrap complete/i)).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
