import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessApi } from "../../../api/access";
import { teamApi } from "../../../api/team";
import { AddMemberDialog } from "../AddMemberDialog";

const pushToast = vi.fn();

// Baseline clipboard stub for jsdom; individual tests spy on whatever is
// current (userEvent.setup() may swap in its own stub).
Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

vi.mock("../../../api/access", () => ({
  accessApi: {
    createCompanyInvite: vi.fn(),
  },
}));

vi.mock("../../../api/team", () => ({
  teamApi: {
    addMember: vi.fn(),
  },
}));

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function inviteResponse(overrides: Partial<{ inviteUrl: string; expiresAt: string }> = {}) {
  return {
    id: "invite-1",
    token: "tok-1",
    inviteUrl: "https://aoa.example.com/invite/tok-1",
    expiresAt: new Date(Date.now() + SEVEN_DAYS_MS).toISOString(),
    allowedJoinTypes: "human" as const,
    ...overrides,
  };
}

function renderDialog(onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  render(
    <AddMemberDialog
      companyId="company-1"
      departments={[]}
      members={[]}
      isSystemAdmin={false}
      open
      onOpenChange={onOpenChange}
    />,
    { wrapper: Wrapper },
  );
  return { onOpenChange };
}

describe("AddMemberDialog — invite link mechanics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(accessApi.createCompanyInvite).mockResolvedValue(inviteResponse());
    vi.mocked(teamApi.addMember).mockResolvedValue({ userId: "user-2" });
  });

  it("shows the created link with honest TTL, auto-copies it, and offers only Done", async () => {
    const user = userEvent.setup();
    renderDialog();
    const clipboardSpy = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    const linkInput = await screen.findByLabelText("Invite Link");
    expect(linkInput).toHaveValue("https://aoa.example.com/invite/tok-1");
    expect(clipboardSpy).toHaveBeenCalledWith("https://aoa.example.com/invite/tok-1");
    expect(screen.getByText(/This link expires in 7 days\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();

    // Terminal state: single Done button, no way to re-submit.
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("prefixes the origin when the server returns a relative invite URL", async () => {
    vi.mocked(accessApi.createCompanyInvite).mockResolvedValue(
      inviteResponse({ inviteUrl: "/invite/tok-1" }),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    const linkInput = await screen.findByLabelText("Invite Link");
    expect(linkInput).toHaveValue(`${window.location.origin}/invite/tok-1`);
  });

  it("surfaces invite creation failures as an error toast", async () => {
    vi.mocked(accessApi.createCompanyInvite).mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith({
        title: "Failed to create invite",
        body: "boom",
        tone: "error",
      });
    });
    // No terminal state on failure — the form stays editable.
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
  });

  it("explains the email binding under the email field in invite mode", () => {
    renderDialog();
    expect(screen.getByText(/The link is tied to this email/)).toBeInTheDocument();
  });

  it("closes and resets via Done after creating a link", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    await user.click(await screen.findByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("AddMemberDialog — invite is the primary path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(accessApi.createCompanyInvite).mockResolvedValue(inviteResponse());
    vi.mocked(teamApi.addMember).mockResolvedValue({ userId: "user-2" });
  });

  it("defaults to invite mode with descriptive toggles", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: /Invite by email/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /Add manually/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByText("They accept a link and join with their Google account."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Instant access, no invite or email verification."),
    ).toBeInTheDocument();
    // Invite mode: no Name field, submit is Create link.
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
  });

  it("gates direct add behind an explicit confirmation", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Add manually/ }));
    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Add Member" }));

    // Nothing happens until the founder confirms.
    expect(teamApi.addMember).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "This grants immediate access with no email verification. Continue?",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add member now" }));
    await waitFor(() => {
      expect(teamApi.addMember).toHaveBeenCalledWith("company-1", {
        name: "Ada Lovelace",
        email: "ada@example.com",
        role: "team_member",
        projectId: null,
        parentType: null,
        parentId: null,
      });
    });
  });

  it("cancelling the confirmation does not add the member", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /Add manually/ }));
    await user.type(screen.getByLabelText("Name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.click(screen.getByRole("button", { name: "Add Member" }));

    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(teamApi.addMember).not.toHaveBeenCalled();
  });
});

describe("AddMemberDialog — cloud invite-only gating (Fix 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(accessApi.createCompanyInvite).mockResolvedValue(inviteResponse());
    vi.mocked(teamApi.addMember).mockResolvedValue({ userId: "user-2" });
  });

  function renderWith(inviteOnly: boolean) {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    }
    render(
      <AddMemberDialog
        companyId="company-1"
        departments={[]}
        members={[]}
        isSystemAdmin={false}
        inviteOnly={inviteOnly}
        open
        onOpenChange={vi.fn()}
      />,
      { wrapper: Wrapper },
    );
  }

  it("hides the manual-add path entirely in cloud mode", () => {
    renderWith(true);
    // Invite form is still present...
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create link" })).toBeInTheDocument();
    // ...but there is no way to switch to (or reach) direct add.
    expect(screen.queryByRole("button", { name: /Add manually/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Invite by email/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("keeps both modes in self-hosted (inviteOnly=false)", () => {
    renderWith(false);
    expect(screen.getByRole("button", { name: /Invite by email/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add manually/ })).toBeInTheDocument();
  });
});
