import { describe, it, expect, vi, beforeAll } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { ThreadTab } from "../ThreadTab";
import type { DiscussionEntry } from "../../../api/discussions";
import { archiveArtifact, unarchiveArtifact } from "../../../api/artifacts";
import { teamApi } from "../../../api/team";
import { queryKeys } from "../../../lib/queryKeys";

// jsdom does not implement scrollIntoView
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

vi.mock("../../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Test Corp", issuePrefix: "TC" },
  }),
}));

vi.mock("../../../context/DialogContext", () => ({
  useDialog: () => ({
    openDiscussionCapture: vi.fn(),
  }),
}));

// Mutable connection state so the B-state tests can flip the composer offline.
const liveState = vi.hoisted(() => ({ connectionState: "open" }));
vi.mock("../../../context/LiveUpdatesProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../context/LiveUpdatesProvider")>();
  return {
    ...actual,
    useLiveUpdates: () => ({
      connectionState: liveState.connectionState,
      workingAgentsByThread: {},
      presenceByThread: {},
    }),
  };
});

vi.mock("../../../api/discussions", () => ({
  discussionsApi: {
    addEntry: vi.fn().mockResolvedValue({ id: "entry-new" }),
    reprocessEntry: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../../api/agents", () => ({
  agentsApi: {
    listAoa: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../../../api/team", () => ({
  teamApi: {
    // Real TeamSummary always carries currentUser (non-optional) — useTeamAccess
    // (now consumed by ThreadTab for the founder-gated artifact actions) reads
    // currentUser.role/permissions, so the mock must include it.
    get: vi.fn().mockResolvedValue({
      currentUser: {
        userId: "user-1",
        role: "team_member",
        permissions: {
          canAssignTasks: false,
          canInviteUsers: false,
          canManageRoles: false,
          canEditIdentityMemory: false,
        },
      },
      members: [],
      pendingInvites: [],
    }),
  },
}));

vi.mock("../../../api/assets", () => ({
  assetsApi: {
    uploadFile: vi.fn().mockResolvedValue({
      assetId: "asset-1",
      originalFilename: "f.txt",
      contentType: "text/plain",
    }),
  },
}));

vi.mock("../../../api/artifacts", () => ({
  archiveArtifact: vi.fn().mockResolvedValue({ id: "artifact-1", status: "archived" }),
  unarchiveArtifact: vi.fn().mockResolvedValue({ id: "artifact-1", status: "active" }),
}));

vi.mock("../../../api/auth", () => ({
  authApi: {
    getSession: vi.fn().mockResolvedValue({ userId: "user-1" }),
  },
}));

vi.mock("../../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

function makeEntry(overrides: Partial<DiscussionEntry> = {}): DiscussionEntry {
  return {
    id: "entry-1",
    inputType: "write",
    rawContent: "We need to redesign the onboarding flow.",
    title: null,
    sourceInfo: null,
    departmentId: null,
    projectId: null,
    goalId: null,
    parentEntryId: null,
    authorAgentId: null,
    authorAgentName: null,
    authorAgentAvatar: null,
    extractionStatus: "completed",
    createdBy: "user-1",
    createdAt: "2026-01-01T09:00:00Z",
    extractedItems: [],
    annotations: [],
    ...overrides,
  };
}

describe("ThreadTab", () => {
  it("renders entries with their raw content", () => {
    const entries = [
      makeEntry({ id: "e1", rawContent: "First post content" }),
      makeEntry({ id: "e2", rawContent: "Second post content" }),
    ];
    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={entries}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("First post content")).toBeInTheDocument();
    expect(screen.getByText("Second post content")).toBeInTheDocument();
  });

  it("shows empty state message when there are no entries", () => {
    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it("shows loading skeleton when isLoading is true", () => {
    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={true}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByTestId("thread-tab-skeleton")).toBeInTheDocument();
  });

  it("shows error state when isError is true", () => {
    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={true}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByTestId("thread-tab-error")).toBeInTheDocument();
  });

  it("renders entry content regardless of inputType", () => {
    const entries = [
      makeEntry({ id: "e1", inputType: "paste", rawContent: "Pasted content" }),
    ];
    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={entries}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Pasted content")).toBeInTheDocument();
  });

  it("nests a reply under its parent with pl-10 indentation", () => {
    const entries = [
      makeEntry({ id: "parent", rawContent: "Parent post" }),
      makeEntry({ id: "child", rawContent: "Child reply", parentEntryId: "parent" }),
    ];
    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={entries}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    const childRow = screen.getByTestId("entry-row-child");
    // Child is wrapped in a pl-10 indent div
    expect(childRow.closest(".pl-10")).not.toBeNull();
    // Child is inside the parent's group wrapper
    const group = screen.getByTestId("entry-group-parent");
    expect(group).toContainElement(childRow);
  });

  it("does not render a reply as its own top-level row", () => {
    const entries = [
      makeEntry({ id: "parent", rawContent: "Parent post" }),
      makeEntry({ id: "child", rawContent: "Child reply", parentEntryId: "parent" }),
    ];
    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={entries}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    // Exactly one top-level group (the parent); the child is nested inside it
    expect(screen.getAllByTestId(/^entry-group-/)).toHaveLength(1);
  });

  it("sends a top-level message via the composer", async () => {
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    // Phase E1: composer test-ids moved to entry-composer-*
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "hello world" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    await waitFor(() =>
      expect(discussionsApi.addEntry).toHaveBeenCalledWith(
        "comp-1",
        "thread-1",
        expect.objectContaining({ rawContent: "hello world", parentEntryId: null }),
      ),
    );
    expect(await screen.findByTestId("thread-send-receipt")).toHaveTextContent("Sent");
  });

  it("shows the send-failed banner with the draft intact when sending fails", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    vi.mocked(discussionsApi.addEntry).mockRejectedValueOnce(new Error("network error"));

    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "message that fails" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));

    expect(await screen.findByTestId("composer-send-failed-banner")).toBeInTheDocument();
    // The old inline receipt copy is gone — the banner replaces it.
    expect(screen.queryByText("Not sent. Try again.")).not.toBeInTheDocument();
    expect(screen.getByTestId("entry-composer-textarea")).toHaveValue("message that fails");
  });

  it("Retry re-sends the identical payload with the SAME clientSubmissionId, then clears", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    vi.mocked(discussionsApi.addEntry).mockClear();
    vi.mocked(discussionsApi.addEntry).mockRejectedValueOnce(new Error("network error"));

    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "retry me" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    const firstBody = vi.mocked(discussionsApi.addEntry).mock
      .calls[0][2] as Record<string, unknown>;
    expect(typeof firstBody.clientSubmissionId).toBe("string");
    expect((firstBody.clientSubmissionId as string).length).toBeGreaterThan(0);

    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(vi.mocked(discussionsApi.addEntry)).toHaveBeenCalledTimes(2),
    );
    const secondBody = vi.mocked(discussionsApi.addEntry).mock
      .calls[1][2] as Record<string, unknown>;
    // Identical body — same clientSubmissionId means the server replays, never duplicates.
    expect(secondBody).toEqual(firstBody);

    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // Retry success clears the composer like a normal send.
    expect(screen.getByTestId("entry-composer-textarea")).toHaveValue("");
  });

  it("a fresh submission after Edit mints a NEW clientSubmissionId", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    vi.mocked(discussionsApi.addEntry).mockClear();
    vi.mocked(discussionsApi.addEntry).mockRejectedValueOnce(new Error("network error"));

    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "first try" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    await screen.findByTestId("composer-send-failed-banner");

    // Edit dismisses the banner but keeps the draft.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("entry-composer-textarea")).toHaveValue("first try");

    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "second try" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    await waitFor(() =>
      expect(vi.mocked(discussionsApi.addEntry)).toHaveBeenCalledTimes(2),
    );
    const first = vi.mocked(discussionsApi.addEntry).mock.calls[0][2] as Record<string, unknown>;
    const second = vi.mocked(discussionsApi.addEntry).mock.calls[1][2] as Record<string, unknown>;
    expect(second.clientSubmissionId).not.toBe(first.clientSubmissionId);
  });

  it("dismisses the banner when the draft diverges from the failed snapshot; the next send is a fresh submission with a NEW clientSubmissionId", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    vi.mocked(discussionsApi.addEntry).mockClear();
    vi.mocked(discussionsApi.addEntry).mockRejectedValueOnce(new Error("network error"));

    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "first try" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    await screen.findByTestId("composer-send-failed-banner");

    // Keep editing past the failed snapshot — Retry would post stale content
    // and its success-clear would wipe these edits, so the banner must go.
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "first try plus newer edits" },
    });
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("entry-composer-textarea")).toHaveValue(
      "first try plus newer edits",
    );

    // The next send goes through the normal submit path with a fresh id.
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    await waitFor(() =>
      expect(vi.mocked(discussionsApi.addEntry)).toHaveBeenCalledTimes(2),
    );
    const first = vi.mocked(discussionsApi.addEntry).mock.calls[0][2] as Record<string, unknown>;
    const second = vi.mocked(discussionsApi.addEntry).mock.calls[1][2] as Record<string, unknown>;
    expect(second.rawContent).toBe("first try plus newer edits");
    expect(second.clientSubmissionId).not.toBe(first.clientSubmissionId);
  });

  it("Discard clears the banner and the composer draft", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    vi.mocked(discussionsApi.addEntry).mockClear();
    vi.mocked(discussionsApi.addEntry).mockRejectedValueOnce(new Error("network error"));

    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "discard me" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("entry-composer-textarea")).toHaveValue("");
    // No resend happened.
    expect(vi.mocked(discussionsApi.addEntry)).toHaveBeenCalledTimes(1);
  });

  it("attachment tray changes dismiss the send-failed banner", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    vi.mocked(discussionsApi.addEntry).mockClear();
    vi.mocked(discussionsApi.addEntry).mockRejectedValueOnce(new Error("network error"));

    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "tray change incoming" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    await screen.findByTestId("composer-send-failed-banner");

    // Adding (or removing) an attachment diverges from the failed snapshot —
    // Retry would post WITHOUT the new file (or WITH a removed one), so any
    // tray mutation dismisses the banner.
    fireEvent.change(screen.getByTestId("entry-composer-file-input"), {
      target: { files: [new File(["x"], "new.txt", { type: "text/plain" })] },
    });
    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // The draft itself is untouched.
    expect(screen.getByTestId("entry-composer-textarea")).toHaveValue("tray change incoming");
    expect(vi.mocked(discussionsApi.addEntry)).toHaveBeenCalledTimes(1);
  });

  it("edits made while a retry is in flight are not wiped by the retry-success clear", async () => {
    const { fireEvent, act } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    vi.mocked(discussionsApi.addEntry).mockClear();
    vi.mocked(discussionsApi.addEntry).mockRejectedValueOnce(new Error("network error"));

    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "first try" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    // Make the retry hang so the draft can change mid-flight.
    let resolveRetry!: (value: unknown) => void;
    vi.mocked(discussionsApi.addEntry).mockImplementationOnce(
      () => new Promise((res) => { resolveRetry = res; }) as never,
    );
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    // The mutation dispatch is async — wait until the retry is truly in flight.
    await waitFor(() =>
      expect(vi.mocked(discussionsApi.addEntry)).toHaveBeenCalledTimes(2),
    );

    // The (host-owned) draft diverges while the retry is in flight.
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "first try edited mid-flight" },
    });

    await act(async () => {
      resolveRetry({ id: "entry-new" });
    });

    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // The retry-success clear must NOT wipe the newer edits.
    expect(screen.getByTestId("entry-composer-textarea")).toHaveValue(
      "first try edited mid-flight",
    );
  });

  it("switching threads clears the banner and snapshot — Retry must never post into a different thread", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    vi.mocked(discussionsApi.addEntry).mockClear();
    vi.mocked(discussionsApi.addEntry).mockRejectedValueOnce(new Error("network error"));

    const makeUi = (threadId: string) => (
      <ThreadTab
        threadId={threadId}
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />
    );
    const { rerender } = renderWithProviders(makeUi("thread-1"));
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "meant for thread 1" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    await screen.findByTestId("composer-send-failed-banner");

    // Entity switch: same mounted tab, different thread.
    rerender(makeUi("thread-2"));

    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    // The snapshot is unreachable — nothing was re-sent anywhere.
    expect(vi.mocked(discussionsApi.addEntry)).toHaveBeenCalledTimes(1);
  });

  it("banner Retry is a no-op while disconnected", async () => {
    const { fireEvent, act } = await import("@testing-library/react");
    const { discussionsApi } = await import("../../../api/discussions");
    vi.mocked(discussionsApi.addEntry).mockClear();
    vi.mocked(discussionsApi.addEntry).mockRejectedValueOnce(new Error("network error"));

    // Fresh element each render — an identical element reference lets React
    // bail out of re-rendering, so the flipped liveState would never be read.
    const makeUi = () => (
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />
    );
    const { rerender } = renderWithProviders(makeUi());
    fireEvent.change(screen.getByTestId("entry-composer-textarea"), {
      target: { value: "retry offline" },
    });
    fireEvent.click(screen.getByTestId("entry-composer-submit"));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    liveState.connectionState = "offline";
    try {
      rerender(makeUi());
      fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
      // Flush the (would-be) async retry before asserting nothing was sent.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(vi.mocked(discussionsApi.addEntry)).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("composer-send-failed-banner")).toBeInTheDocument();
    } finally {
      liveState.connectionState = "open";
    }
  });

  it("renders the shared offline strip through the composer hint when offline", () => {
    liveState.connectionState = "offline";
    try {
      renderWithProviders(
        <ThreadTab
          threadId="thread-1"
          companyId="comp-1"
          entries={[]}
          isLoading={false}
          isError={false}
          onRetry={vi.fn()}
        />,
      );
      const hint = screen.getByTestId("thread-composer-offline-hint");
      const strip = screen.getByTestId("composer-offline-strip");
      expect(hint).toContainElement(strip);
      expect(strip.textContent).toContain(
        "You're offline — draft saved. We'll send when you're back.",
      );
    } finally {
      liveState.connectionState = "open";
    }
  });

  it("invalidates the discussion detail after archiving an inline artifact", async () => {
    vi.mocked(teamApi.get).mockResolvedValueOnce({
      currentUser: {
        userId: "user-1",
        role: "founder",
        permissions: {
          canAssignTasks: true,
          canInviteUsers: true,
          canManageRoles: true,
          canEditIdentityMemory: true,
        },
      },
      members: [],
      pendingInvites: [],
    });
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    vi.mocked(archiveArtifact).mockClear();
    vi.mocked(unarchiveArtifact).mockClear();
    const user = userEvent.setup();

    renderWithProviders(
      <ThreadTab
        threadId="thread-1"
        companyId="comp-1"
        entries={[
          makeEntry({
            attachments: [{
              id: "attachment-1",
              assetId: null,
              artifactId: "artifact-1",
              artifactType: "document",
              artifactTitle: "Launch brief",
              artifactStatus: "active",
            }],
          }),
        ]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
      />,
    );

    await user.click(await screen.findByTestId("artifact-archive"));

    await waitFor(() => expect(archiveArtifact).toHaveBeenCalledWith("artifact-1"));
    expect(unarchiveArtifact).not.toHaveBeenCalled();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["threads", "comp-1", "thread-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: queryKeys.discussions.detail("comp-1", "thread-1"),
    });
    invalidateSpy.mockRestore();
  });
});
