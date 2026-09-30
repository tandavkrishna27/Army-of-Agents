import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { COMPOSER_MAX_ATTACHMENT_BYTES } from "@armyofagents/shared";
import { CommentThread, resolveTaskCommentAction } from "./CommentThread";

// ─── Mocks ───────────────────────────────────────────────────────────────────

// MarkdownEditor is contenteditable-heavy; the composer contract only needs
// value/onChange/onSubmit/placeholder, so mock it as a plain textarea.
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, placeholder, onSubmit }: {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    onSubmit?: () => void;
  }) => (
    <textarea
      data-testid="markdown-editor-mock"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") onSubmit?.();
      }}
    />
  ),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// The real InlineEntitySelector is a popover combobox; the control contract
// only needs value/options/onChange, so mock it as a plain select.
vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: ({ value, options, onChange }: {
    value: string;
    options: Array<{ id: string; label: string }>;
    onChange: (next: string) => void;
  }) => (
    <select
      data-testid="assignee-selector-mock"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Assignee</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>{option.label}</option>
      ))}
    </select>
  ),
}));

// Mutable connection state for the shared offline strip (B-states, mock §5).
const liveState = vi.hoisted(() => ({ connectionState: "open" }));

vi.mock("../context/LiveUpdatesProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../context/LiveUpdatesProvider")>();
  return {
    ...actual,
    useLiveUpdates: () => ({
      connectionState: liveState.connectionState,
      workingAgentsByThread: {},
      presenceByThread: {},
    }),
  };
});

// ─── resolveTaskCommentAction (pure) ─────────────────────────────────────────

const base = {
  isClosed: false,
  reopenRequested: false,
  hasActiveRun: false,
  interruptRequested: false,
  hasReassignment: false,
};

describe("resolveTaskCommentAction", () => {
  it("keeps an ordinary comment non-interrupting while an agent is running", () => {
    expect(resolveTaskCommentAction({ ...base, hasActiveRun: true })).toBe("comment");
  });

  it("requires an active run before an interrupt effect is emitted", () => {
    expect(resolveTaskCommentAction({ ...base, interruptRequested: true })).toBe("comment");
    expect(resolveTaskCommentAction({ ...base, hasActiveRun: true, interruptRequested: true })).toBe("interrupt");
  });

  it("maps a closed-task comment with reopen enabled to reopen", () => {
    expect(resolveTaskCommentAction({ ...base, isClosed: true, reopenRequested: true })).toBe("reopen");
  });

  it("prioritizes reassignment as its own governed mutation", () => {
    expect(resolveTaskCommentAction({
      ...base,
      hasActiveRun: true,
      interruptRequested: true,
      hasReassignment: true,
    })).toBe("reassign");
  });
});

// ─── Composer B-states (mock §5) ─────────────────────────────────────────────

function renderThread(overrides: Partial<React.ComponentProps<typeof CommentThread>> = {}) {
  const onAdd = vi.fn().mockResolvedValue(undefined);
  const onAddWithAttachments = vi.fn().mockResolvedValue(undefined);
  const onAttachImage = vi.fn().mockResolvedValue(undefined);
  const makeUi = (next: Partial<React.ComponentProps<typeof CommentThread>>) => (
    <MemoryRouter>
      <CommentThread
        comments={[]}
        onAdd={onAdd}
        onAddWithAttachments={onAddWithAttachments}
        onAttachImage={onAttachImage}
        {...next}
      />
    </MemoryRouter>
  );
  const result = render(makeUi(overrides));
  return {
    ...result,
    onAdd,
    onAddWithAttachments,
    onAttachImage,
    // Same mounted thread, new props — simulates switching tasks (draftKey).
    rerenderThread: (next: Partial<React.ComponentProps<typeof CommentThread>>) =>
      result.rerender(makeUi(next)),
  };
}

function editor() {
  return screen.getByPlaceholderText("Leave a comment...") as HTMLTextAreaElement;
}

function dropFile(target: HTMLElement, file: File) {
  fireEvent.dragEnter(target, { dataTransfer: { types: ["Files"], files: [] } });
  fireEvent.drop(target, { dataTransfer: { types: ["Files"], files: [file] } });
}

beforeEach(() => {
  liveState.connectionState = "open";
});

describe("CommentThread — B-states (mock §5)", () => {
  it("keeps the draft and files when sending fails and raises the banner; Retry re-sends IDENTICAL args including clientSubmissionId; success clears", async () => {
    const { onAddWithAttachments } = renderThread();
    onAddWithAttachments.mockRejectedValueOnce(new Error("network error"));

    const frame = screen.getByTestId("task-comments-composer-frame");
    const file = new File(["fake"], "evidence.txt", { type: "text/plain" });
    dropFile(frame, file);
    expect(await screen.findByText("evidence.txt")).toBeInTheDocument();

    fireEvent.change(editor(), { target: { value: "please keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    // THE silent-failure regression: the user sees the banner and loses nothing.
    const banner = await screen.findByTestId("composer-send-failed-banner");
    expect(editor()).toHaveValue("please keep me");
    expect(screen.getByText("evidence.txt")).toBeInTheDocument();

    const firstCall = onAddWithAttachments.mock.calls[0];
    const submissionId = firstCall[4];
    expect(typeof submissionId).toBe("string");
    expect((submissionId as string).length).toBeGreaterThan(0);

    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onAddWithAttachments).toHaveBeenCalledTimes(2));
    // Identical args — same clientSubmissionId means the server replays, never duplicates.
    expect(onAddWithAttachments.mock.calls[1]).toEqual(firstCall);

    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // Retry success clears the composer like a normal send.
    expect(editor()).toHaveValue("");
    expect(screen.queryByText("evidence.txt")).not.toBeInTheDocument();
  });

  it("dismisses the banner on body edit; the next send mints a NEW clientSubmissionId", async () => {
    const { onAdd } = renderThread();
    onAdd.mockRejectedValueOnce(new Error("network error"));

    fireEvent.change(editor(), { target: { value: "first try" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByTestId("composer-send-failed-banner");

    // Editing past the failed snapshot: Retry would post stale content and its
    // success-clear would wipe the newer edits — the banner must go.
    fireEvent.change(editor(), { target: { value: "first try plus newer edits" } });
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(editor()).toHaveValue("first try plus newer edits");

    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    const first = onAdd.mock.calls[0];
    const second = onAdd.mock.calls[1];
    expect(second[0]).toBe("first try plus newer edits");
    expect(second[4]).not.toBe(first[4]);
  });

  it("removing a selected file dismisses the banner — Retry must never post a removed file", async () => {
    const { onAddWithAttachments } = renderThread();
    onAddWithAttachments.mockRejectedValueOnce(new Error("boom"));

    const frame = screen.getByTestId("task-comments-composer-frame");
    const file = new File(["fake"], "sensitive.txt", { type: "text/plain" });
    dropFile(frame, file);
    expect(await screen.findByText("sensitive.txt")).toBeInTheDocument();

    fireEvent.change(editor(), { target: { value: "with file" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(screen.getByRole("button", { name: "Remove sensitive.txt" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    // No resend happened — the stale snapshot (with the removed file) is unreachable.
    expect(onAddWithAttachments).toHaveBeenCalledTimes(1);
  });

  it("Discard dismisses the banner and clears the input and selected files", async () => {
    const { onAddWithAttachments } = renderThread();
    onAddWithAttachments.mockRejectedValueOnce(new Error("boom"));

    const frame = screen.getByTestId("task-comments-composer-frame");
    const file = new File(["fake"], "evidence.txt", { type: "text/plain" });
    dropFile(frame, file);
    fireEvent.change(editor(), { target: { value: "discard me" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(within(banner).getByRole("button", { name: "Discard" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(editor()).toHaveValue("");
    expect(screen.queryByText("evidence.txt")).not.toBeInTheDocument();
    expect(onAddWithAttachments).toHaveBeenCalledTimes(1);
  });

  it("Edit dismisses the banner but keeps the draft", async () => {
    const { onAdd } = renderThread();
    onAdd.mockRejectedValueOnce(new Error("network error"));

    fireEvent.change(editor(), { target: { value: "edit me" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(within(banner).getByRole("button", { name: "Edit" }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(editor()).toHaveValue("edit me");
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("shows the offline strip and disables the Comment button while offline", async () => {
    liveState.connectionState = "offline";
    const { onAdd } = renderThread();

    const strip = screen.getByTestId("composer-offline-strip");
    expect(strip.textContent).toContain("You're offline");

    fireEvent.change(editor(), { target: { value: "queued while offline" } });
    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();

    // The editor's submit shortcut must not bypass the disabled send either.
    fireEvent.keyDown(editor(), { key: "Enter", ctrlKey: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("shows the drop overlay on frame dragEnter and attaches dropped files via the shared validation path", async () => {
    renderThread();

    const frame = screen.getByTestId("task-comments-composer-frame");
    fireEvent.dragEnter(frame, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByTestId("composer-drop-overlay")).toBeInTheDocument();

    const file = new File(["fake"], "dropped.png", { type: "image/png" });
    fireEvent.drop(frame, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(screen.queryByTestId("composer-drop-overlay")).not.toBeInTheDocument();
    expect(await screen.findByText("dropped.png")).toBeInTheDocument();
  });

  it("changing the assignee after a failure dismisses the banner — Retry must never post a stale reassignment", async () => {
    const { onAdd } = renderThread({
      enableReassign: true,
      reassignOptions: [
        { id: "agent:agent-a", label: "Agent A" },
        { id: "agent:agent-b", label: "Agent B" },
      ],
    });
    onAdd.mockRejectedValueOnce(new Error("network error"));

    fireEvent.change(screen.getByTestId("assignee-selector-mock"), { target: { value: "agent:agent-a" } });
    fireEvent.change(editor(), { target: { value: "reassign please" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByTestId("composer-send-failed-banner");
    expect(onAdd.mock.calls[0][2]).toEqual({ assigneeAgentId: "agent-a", assigneeUserId: null });

    // Switching the target after the failure: Retry would post the OLD
    // reassignment and the success-clear would silently discard the new one.
    fireEvent.change(screen.getByTestId("assignee-selector-mock"), { target: { value: "agent:agent-b" } });
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("toggling interrupt after a failure dismisses the banner", async () => {
    const { onAdd } = renderThread({ hasActiveRun: true });
    onAdd.mockRejectedValueOnce(new Error("network error"));

    fireEvent.change(editor(), { target: { value: "interrupt flip" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByTestId("composer-send-failed-banner");

    const interruptBox = within(screen.getByTestId("task-comments-interrupt")).getByRole("checkbox");
    fireEvent.click(interruptBox);
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("toggling reopen after a failure dismisses the banner", async () => {
    const { onAdd } = renderThread({ issueStatus: "done" });
    onAdd.mockRejectedValueOnce(new Error("network error"));

    fireEvent.change(editor(), { target: { value: "reopen flip" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByTestId("composer-send-failed-banner");

    fireEvent.click(screen.getByRole("checkbox", { name: /Re-open/i }));
    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("a retry that succeeds AFTER the assignee changed skips the clears (revision guard)", async () => {
    const { onAdd } = renderThread({
      enableReassign: true,
      reassignOptions: [
        { id: "agent:agent-a", label: "Agent A" },
        { id: "agent:agent-b", label: "Agent B" },
      ],
    });
    onAdd.mockRejectedValueOnce(new Error("network error"));

    fireEvent.change(screen.getByTestId("assignee-selector-mock"), { target: { value: "agent:agent-a" } });
    fireEvent.change(editor(), { target: { value: "hold my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    // Retry hangs; while it is in flight the user picks a different assignee.
    let resolveRetry!: () => void;
    onAdd.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveRetry = resolve; }));
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    fireEvent.change(screen.getByTestId("assignee-selector-mock"), { target: { value: "agent:agent-b" } });

    await act(async () => { resolveRetry(); });
    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    // Retry itself posted the ORIGINAL snapshot (assignee A)…
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd.mock.calls[1][2]).toEqual({ assigneeAgentId: "agent-a", assigneeUserId: null });
    // …but the success-clear must NOT wipe the newer control state or draft.
    expect((screen.getByTestId("assignee-selector-mock") as HTMLSelectElement).value).toBe("agent:agent-b");
    expect(editor()).toHaveValue("hold my draft");
  });

  it("a control change mid-retry keeps a FAILED retry from re-arming the stale banner", async () => {
    const { onAdd } = renderThread({
      enableReassign: true,
      reassignOptions: [
        { id: "agent:agent-a", label: "Agent A" },
        { id: "agent:agent-b", label: "Agent B" },
      ],
    });
    onAdd.mockRejectedValueOnce(new Error("network error"));

    fireEvent.change(screen.getByTestId("assignee-selector-mock"), { target: { value: "agent:agent-a" } });
    fireEvent.change(editor(), { target: { value: "stale snapshot" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const banner = await screen.findByTestId("composer-send-failed-banner");

    // Retry hangs; the user changes a control while it is in flight (the
    // control-change dismiss is locked during retry — banner stays up).
    let rejectRetry!: (err: Error) => void;
    onAdd.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectRetry = reject; }));
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    fireEvent.change(screen.getByTestId("assignee-selector-mock"), { target: { value: "agent:agent-b" } });
    expect(screen.getByTestId("composer-send-failed-banner")).toBeInTheDocument();

    // The failed retry must NOT re-arm the banner over the stale snapshot —
    // a second Retry would post the OLD reassignment the user moved away from.
    await act(async () => { rejectRetry(new Error("still failing")); });
    await waitFor(() =>
      expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument(),
    );
    expect(onAdd).toHaveBeenCalledTimes(2);
  });

  it("switching tasks (draftKey) clears the banner, snapshot, and tray — Retry must never post into a different task", async () => {
    const { onAddWithAttachments, rerenderThread } = renderThread({ draftKey: "comment-draft-task-a" });
    onAddWithAttachments.mockRejectedValueOnce(new Error("boom"));

    const frame = screen.getByTestId("task-comments-composer-frame");
    dropFile(frame, new File(["fake"], "task-a-file.txt", { type: "text/plain" }));
    expect(await screen.findByText("task-a-file.txt")).toBeInTheDocument();
    fireEvent.change(editor(), { target: { value: "meant for task A" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await screen.findByTestId("composer-send-failed-banner");

    // Entity switch: same mounted thread, different task.
    rerenderThread({ draftKey: "comment-draft-task-b" });

    expect(screen.queryByTestId("composer-send-failed-banner")).not.toBeInTheDocument();
    // The tray must not leak into the other task either.
    expect(screen.queryByText("task-a-file.txt")).not.toBeInTheDocument();
    // The snapshot is unreachable — nothing was re-sent anywhere.
    expect(onAddWithAttachments).toHaveBeenCalledTimes(1);
  });

  it("frame drag-drop still routes through attachment validation (oversized dropped file rejected)", async () => {
    renderThread();

    const frame = screen.getByTestId("task-comments-composer-frame");
    const oversized = new File(["fake"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(oversized, "size", {
      configurable: true,
      value: COMPOSER_MAX_ATTACHMENT_BYTES + 1,
    });
    dropFile(frame, oversized);

    expect(await screen.findByRole("alert")).toHaveTextContent("huge.pdf exceeds the 10 MB attachment limit");
    expect(screen.queryByText("huge.pdf")).not.toBeInTheDocument();
  });
});
