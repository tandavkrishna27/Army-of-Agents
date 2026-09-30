import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { JoinRequest, TeamSummary } from "@armyofagents/shared";
import { accessApi } from "../../../api/access";
import { teamApi } from "../../../api/team";
import { HumansTab } from "../HumansTab";

const pushToast = vi.fn();

// Baseline clipboard stub for jsdom; tests spy on whatever is current.
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

vi.mock("../../../api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../../api/access", () => ({
  accessApi: {
    listJoinRequests: vi.fn(),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
  },
}));

vi.mock("../../../api/team", () => ({
  teamApi: {
    searchHumans: vi.fn(),
    resendInvite: vi.fn(),
    revokeInvite: vi.fn(),
  },
}));

const teamSummary: TeamSummary = {
  currentUser: {
    userId: "founder-1",
    role: "founder",
    departmentId: null,
    isSystemAdmin: false,
    permissions: {
      canAssignTasks: true,
      canInviteUsers: true,
      canManageRoles: true,
      canEditIdentityMemory: true,
    },
  },
  members: [
    {
      userId: "founder-1",
      email: "founder@example.com",
      displayName: "Founder",
      avatarUrl: null,
      avatarAssetId: null,
      title: null,
      bio: null,
      location: null,
      timezone: null,
      socialLinks: [],
      role: "founder",
      departmentId: null,
      departmentName: null,
      permissions: [],
      isCurrentUser: true,
      isSystemAdmin: false,
      parentType: null,
      parentId: null,
    },
  ],
  pendingInvites: [],
};

const joinRequest: JoinRequest = {
  id: "jr-1",
  inviteId: "invite-1",
  companyId: "company-1",
  requestType: "agent",
  status: "pending_approval",
  requestIp: "127.0.0.1",
  requestingUserId: null,
  requestEmailSnapshot: "ops@example.com",
  agentName: "Ops Scout",
  adapterType: "openclaw",
  capabilities: "Handles operational follow-up.",
  agentDefaultsPayload: null,
  claimSecretExpiresAt: null,
  claimSecretConsumedAt: null,
  createdAgentId: null,
  approvedByUserId: null,
  approvalSource: null,
  approvedAt: null,
  rejectedByUserId: null,
  rejectedAt: null,
  createdAt: new Date("2026-07-07T10:00:00.000Z"),
  updatedAt: new Date("2026-07-07T10:00:00.000Z"),
};

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

const pendingInviteSummary: TeamSummary = {
  ...teamSummary,
  pendingInvites: [
    {
      id: "invite-1",
      email: "ada@example.com",
      role: "team_member",
      departmentId: null,
      departmentName: null,
      reportsToId: null,
      reportsToName: null,
      expiresAt: new Date(Date.now() + SIX_DAYS_MS),
      inviteUrl: "",
    },
  ],
};

function renderHumansTab({
  highlightId,
  summary = teamSummary,
}: { highlightId?: string | null; summary?: TeamSummary } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }

  return render(
    <HumansTab
      teamSummary={summary}
      highlightId={highlightId}
      permissions={teamSummary.currentUser!.permissions}
      isSystemAdmin={false}
    />,
    { wrapper: Wrapper },
  );
}

describe("HumansTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(accessApi.listJoinRequests).mockResolvedValue([joinRequest]);
    vi.mocked(accessApi.approveJoinRequest).mockResolvedValue({ ...joinRequest, status: "approved" });
    vi.mocked(accessApi.rejectJoinRequest).mockResolvedValue({ ...joinRequest, status: "rejected" });
    vi.mocked(teamApi.searchHumans).mockResolvedValue({
      companyId: "company-1",
      query: "enterprise routing alpha",
      results: [
        {
          userId: "founder-1",
          email: "founder@example.com",
          displayName: "Founder",
          avatarUrl: null,
          title: "Founder",
          role: "founder",
          departmentId: null,
          departmentName: null,
          reportsToUserId: null,
          reportsToName: null,
          matchedFields: ["capability_document"],
          snippets: [
            {
              field: "capability_document",
              label: "Skills",
              value: "Strong in enterprise routing alpha and product strategy.",
              documentId: "doc-1",
              filename: "skills.md",
            },
          ],
          responsibilitySummary: {
            directHumanReportCount: 0,
            directAgentTreeCount: 1,
            assignedTaskCount: 2,
            createdTaskCount: 3,
          },
        },
      ],
    });
  });

  it("renders pending join requests and approves them inline", async () => {
    const user = userEvent.setup();
    renderHumansTab();

    expect(await screen.findByText("Ops Scout")).toBeInTheDocument();
    expect(screen.getByText("Agent join request")).toBeInTheDocument();
    expect(screen.getByText("Handles operational follow-up.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(accessApi.approveJoinRequest).toHaveBeenCalledWith("company-1", "jr-1");
    });
    expect(pushToast).toHaveBeenCalledWith({ title: "Join request approved", tone: "success" });
  });

  it("does not pulse or ring a single human card when highlightId is present", async () => {
    const { container } = renderHumansTab({ highlightId: "founder-1" });

    expect(await screen.findAllByText("Founder")).not.toHaveLength(0);
    expect(container.querySelector(".animate-pulse")).not.toBeInTheDocument();
    expect(container.querySelector(".ring-primary")).not.toBeInTheDocument();
  });

  it("declines pending join requests inline", async () => {
    const user = userEvent.setup();
    renderHumansTab();

    expect(await screen.findByText("Ops Scout")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Decline" }));

    await waitFor(() => {
      expect(accessApi.rejectJoinRequest).toHaveBeenCalledWith("company-1", "jr-1");
    });
    expect(pushToast).toHaveBeenCalledWith({ title: "Join request declined", tone: "success" });
  });

  it("searches human capabilities through the discovery API and renders snippets", async () => {
    const user = userEvent.setup();
    renderHumansTab();

    const search = screen.getByPlaceholderText("Search humans by skills, responsibilities, role, or docs...");
    await user.type(search, "enterprise routing alpha");

    await waitFor(() => {
      expect(teamApi.searchHumans).toHaveBeenCalledWith("company-1", {
        q: "enterprise routing alpha",
        role: "all",
        limit: 20,
      });
    });
    expect(await screen.findByText("Skills")).toBeInTheDocument();
    expect(screen.getByText(/Strong in enterprise routing alpha/)).toBeInTheDocument();
    expect(screen.getByText("1 agent tree")).toBeInTheDocument();
    expect(screen.getByText("2 assigned")).toBeInTheDocument();
  });

  it("keeps pending search local and does not call human discovery", async () => {
    const user = userEvent.setup();
    renderHumansTab();

    await user.click(screen.getByRole("button", { name: /Pending/ }));
    await user.type(screen.getByPlaceholderText("Search humans by skills, responsibilities, role, or docs..."), "Ops Scout");

    expect(await screen.findByText("Ops Scout")).toBeInTheDocument();
    expect(teamApi.searchHumans).not.toHaveBeenCalled();
  });

  it("shows relative expiry on pending invite cards", async () => {
    renderHumansTab({ summary: pendingInviteSummary });

    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText("Expires in 6 days")).toBeInTheDocument();
  });

  it("surfaces the rotated link with a copy affordance after resend", async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(teamApi.resendInvite).mockResolvedValue({
      inviteId: "invite-2",
      token: "tok-2",
      inviteUrl: "https://aoa.example.com/invite/tok-2",
      expiresAt,
    });
    const user = userEvent.setup();
    renderHumansTab({ summary: pendingInviteSummary });
    const clipboardSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    await user.click(await screen.findByRole("button", { name: "Resend invite" }));

    await waitFor(() => {
      expect(teamApi.resendInvite).toHaveBeenCalledWith("company-1", "invite-1");
    });
    expect(await screen.findByText("New invite link for ada@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("New invite link URL")).toHaveValue(
      "https://aoa.example.com/invite/tok-2",
    );
    expect(screen.getByText(/This link expires in 7 days\./)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(clipboardSpy).toHaveBeenCalledWith("https://aoa.example.com/invite/tok-2");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("clears the resend banner when the invite it belongs to is revoked", async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    vi.mocked(teamApi.resendInvite).mockResolvedValue({
      inviteId: "invite-2",
      token: "tok-2",
      inviteUrl: "https://aoa.example.com/invite/tok-2",
      expiresAt,
    });
    vi.mocked(teamApi.revokeInvite).mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { rerender } = renderHumansTab({ summary: pendingInviteSummary });

    await user.click(await screen.findByRole("button", { name: "Resend invite" }));
    expect(await screen.findByText("New invite link for ada@example.com")).toBeInTheDocument();

    // The refetched summary now shows the rotated invite (invite-2).
    const rotatedSummary: TeamSummary = {
      ...teamSummary,
      pendingInvites: [{ ...pendingInviteSummary.pendingInvites[0]!, id: "invite-2" }],
    };
    rerender(
      <HumansTab
        teamSummary={rotatedSummary}
        highlightId={null}
        permissions={teamSummary.currentUser!.permissions}
        isSystemAdmin={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Revoke invite" }));
    await waitFor(() => {
      expect(teamApi.revokeInvite).toHaveBeenCalledWith("company-1", "invite-2");
    });
    // The banner offered a now-dead link — it must be gone.
    expect(screen.queryByText("New invite link for ada@example.com")).not.toBeInTheDocument();
  });
});
