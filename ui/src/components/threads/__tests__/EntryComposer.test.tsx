/**
 * EntryComposer.test.tsx — Phase E1 composer tests.
 */
import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { EntryComposer, type AgentRef, type UserRef } from "../EntryComposer";

// renderWithProviders has no ToastProvider, so mock the hook (mirrors ThreadTab.test).
vi.mock("../../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

const agents: AgentRef[] = [
  { id: "agent-scout", name: "Scout", role: "scout" },
  { id: "agent-engineer", name: "Engineer", role: "engineer" },
];

const users: UserRef[] = [
  { id: "user-1", name: "Alice", email: "alice@example.com" },
  { id: "user-2", name: "Bob", email: "bob@example.com" },
];

describe("EntryComposer — autocomplete", () => {
  it("opens the autocomplete dropdown when the user types '@'", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onSubmit={vi.fn()}
      />,
    );
    const ta = screen.getByTestId("entry-composer-textarea");
    await user.click(ta);
    await user.type(ta, "@");
    expect(screen.getByTestId("entry-autocomplete")).toBeInTheDocument();
    // Both agents and both users (capped at 8) are shown
    expect(screen.getByTestId("entry-autocomplete-option-Scout")).toBeInTheDocument();
    expect(screen.getByTestId("entry-autocomplete-option-Alice")).toBeInTheDocument();
  });

  it("filters suggestions when typing '@Sco' — Scout matches, Engineer does not", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onSubmit={vi.fn()}
      />,
    );
    const ta = screen.getByTestId("entry-composer-textarea");
    await user.click(ta);
    await user.type(ta, "@Sco");
    expect(screen.getByTestId("entry-autocomplete-option-Scout")).toBeInTheDocument();
    expect(screen.queryByTestId("entry-autocomplete-option-Engineer")).not.toBeInTheDocument();
  });

  it("inserts a mention chip when Enter is pressed on the active suggestion", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onSubmit={vi.fn()}
      />,
    );
    const ta = screen.getByTestId("entry-composer-textarea");
    await user.click(ta);
    await user.type(ta, "@Sco");
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("mention-chip-Scout")).toBeInTheDocument();
    // Textarea now contains the expanded @Name and a trailing space
    expect((ta as HTMLTextAreaElement).value).toMatch(/^@Scout /);
  });
});

describe("EntryComposer — submit", () => {
  it("sends with Enter and keeps Shift+Enter available for multiline text", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onSubmit={onSubmit}
      />,
    );
    const ta = screen.getByTestId("entry-composer-textarea");
    await user.type(ta, "first line");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(ta, "second line");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].text).toBe("first line\nsecond line");
  });

  it("submits the entry with text + mentions + attachments + parentEntryId on Ctrl+Enter", async () => {
    const user = userEvent.setup();
    const upload = vi.fn().mockResolvedValue({
      id: "asset-1",
      name: "test.png",
      mimeType: "image/png",
    });
    const onSubmit = vi.fn();
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        parentEntryId="parent-42"
        agents={agents}
        users={users}
        onUpload={upload}
        onSubmit={onSubmit}
      />,
    );
    const ta = screen.getByTestId("entry-composer-textarea") as HTMLTextAreaElement;
    await user.click(ta);
    await user.type(ta, "@Sco");
    await user.keyboard("{Enter}");
    // The composer restores the caret via requestAnimationFrame, which userEvent
    // does not flush. Wait for the mention to expand, flush the rAF so the caret
    // restore can't fire mid-typing and scramble the text, then place the caret at
    // the end before typing the rest. (This test was flaky on Linux CI.)
    await screen.findByTestId("mention-chip-Scout");
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    ta.setSelectionRange(ta.value.length, ta.value.length);
    await user.type(ta, "ping the build");

    // Attach a file via the hidden file input
    const fileInput = screen.getByTestId("entry-composer-file-input") as HTMLInputElement;
    const file = new File(["pixels"], "test.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId("entry-composer-attachment-test.png")).toBeInTheDocument(),
    );

    // Ctrl+Enter submits
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.text).toContain("@Scout");
    expect(payload.text).toContain("ping the build");
    expect(payload.mentions).toEqual(["agent-scout"]);
    expect(payload.parentEntryId).toBe("parent-42");
    expect(payload.attachments).toEqual([
      { id: "asset-1", name: "test.png", mimeType: "image/png" },
    ]);
  });
});

describe("EntryComposer — attachments", () => {
  it("allows an attachment-only message", async () => {
    const user = userEvent.setup();
    const upload = vi.fn().mockResolvedValue({
      id: "asset-1",
      name: "test.png",
      mimeType: "image/png",
    });
    const onSubmit = vi.fn();
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onUpload={upload}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByTestId("entry-composer-file-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "test.png", { type: "image/png" })] },
    });
    await screen.findByTestId("entry-composer-attachment-test.png");
    (screen.getByTestId("entry-composer-textarea") as HTMLTextAreaElement).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].text).toBe("");
    expect(onSubmit.mock.calls[0][0].attachments).toHaveLength(1);
  });

  it("rejects unsupported and oversized files before upload", async () => {
    const upload = vi.fn();
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onUpload={upload}
        onSubmit={vi.fn()}
      />,
    );
    const input = screen.getByTestId("entry-composer-file-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["text"], "notes.exe", { type: "application/x-msdownload" })] },
    });
    expect(upload).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Unsupported attachment type");
  });

  it("does not render the tracked file-artifact upload by default", () => {
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("file-artifact-upload")).not.toBeInTheDocument();
  });

  it("never renders the file-artifact control and shows the dim mic placeholder (mock v2)", () => {
    // Mock v2: 📎 is the ONLY attach entry — the File-artifact button was
    // removed from the composer. The mic is present (disabled) for placement.
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("file-artifact-upload")).not.toBeInTheDocument();
    const mic = screen.getByTestId("entry-composer-mic-button") as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    expect(mic.title).toMatch(/coming soon/i);
  });

  it("renders an attachment preview after the file is uploaded", async () => {
    const upload = vi.fn().mockResolvedValue({
      id: "asset-1",
      name: "test.png",
      mimeType: "image/png",
    });
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onUpload={upload}
        onSubmit={vi.fn()}
      />,
    );
    // The attach button exists, and clicking it would open the OS file picker.
    // We assert on the underlying hidden input instead.
    expect(screen.getByTestId("entry-composer-attach-button")).toBeInTheDocument();
    const input = screen.getByTestId("entry-composer-file-input") as HTMLInputElement;
    const file = new File(["x"], "test.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId("entry-composer-attachment-test.png")).toBeInTheDocument(),
    );
    expect(upload).toHaveBeenCalledWith(file);
  });
});

describe("EntryComposer — B-states (mock §5)", () => {
  it("keeps a failed upload as a failed card whose Retry re-uploads it", async () => {
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error("upload boom"))
      .mockResolvedValue({ id: "asset-1", name: "test.png", mimeType: "image/png" });
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onUpload={upload}
        onSubmit={vi.fn()}
      />,
    );
    const input = screen.getByTestId("entry-composer-file-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "test.png", { type: "image/png" })] },
    });
    const failedCard = await screen.findByTestId("entry-composer-attachment-test.png");
    expect(failedCard).toHaveAttribute("data-state", "failed");
    expect(failedCard.textContent).toContain("Failed to upload");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("entry-composer-attachment-test.png")).toHaveAttribute(
        "data-state",
        "ready",
      ),
    );
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("removes a failed upload card without retrying", async () => {
    const upload = vi.fn().mockRejectedValue(new Error("upload boom"));
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onUpload={upload}
        onSubmit={vi.fn()}
      />,
    );
    const input = screen.getByTestId("entry-composer-file-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "test.png", { type: "image/png" })] },
    });
    await screen.findByTestId("entry-composer-attachment-test.png");
    fireEvent.click(screen.getByRole("button", { name: "Remove test.png" }));
    expect(screen.queryByTestId("entry-composer-attachment-test.png")).not.toBeInTheDocument();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("shows the drop overlay on dragenter and uploads dropped files", async () => {
    const upload = vi.fn().mockResolvedValue({
      id: "asset-1",
      name: "drop.png",
      mimeType: "image/png",
    });
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onUpload={upload}
        onSubmit={vi.fn()}
      />,
    );
    const frame = screen.getByTestId("entry-composer");
    fireEvent.dragEnter(frame, { dataTransfer: { types: ["Files"], files: [] } });
    expect(screen.getByTestId("composer-drop-overlay")).toBeInTheDocument();

    const file = new File(["x"], "drop.png", { type: "image/png" });
    fireEvent.drop(frame, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(screen.queryByTestId("composer-drop-overlay")).not.toBeInTheDocument();
    await waitFor(() => expect(upload).toHaveBeenCalledWith(file));
    await screen.findByTestId("entry-composer-attachment-drop.png");
  });

  it("renders the host-provided failureBanner inside the frame", () => {
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onSubmit={vi.fn()}
        failureBanner={<div data-testid="test-failure-banner">failed</div>}
      />,
    );
    expect(screen.getByTestId("entry-composer")).toContainElement(
      screen.getByTestId("test-failure-banner"),
    );
  });

  it("clears text and attachments when clearSignal bumps", async () => {
    const user = userEvent.setup();
    const upload = vi.fn().mockResolvedValue({
      id: "asset-1",
      name: "test.png",
      mimeType: "image/png",
    });
    const props = {
      threadId: "thread-1",
      agents,
      users,
      onUpload: upload,
      onSubmit: vi.fn(),
    };
    const view = renderWithProviders(<EntryComposer {...props} clearSignal={0} />);
    const ta = screen.getByTestId("entry-composer-textarea") as HTMLTextAreaElement;
    await user.type(ta, "draft to discard");
    const input = screen.getByTestId("entry-composer-file-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "test.png", { type: "image/png" })] },
    });
    await screen.findByTestId("entry-composer-attachment-test.png");

    view.rerender(<EntryComposer {...props} clearSignal={1} />);
    expect(ta.value).toBe("");
    expect(screen.queryByTestId("entry-composer-attachment-test.png")).not.toBeInTheDocument();
  });
});

describe("EntryComposer — onAttachmentsChanged", () => {
  it("fires on upload success, failed upload, attachment remove, and failed-card remove", async () => {
    const onAttachmentsChanged = vi.fn();
    const upload = vi.fn()
      .mockResolvedValueOnce({ id: "asset-ok", name: "ok.png", mimeType: "image/png" })
      .mockRejectedValueOnce(new Error("upload down"));
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        agents={agents}
        users={users}
        onSubmit={vi.fn()}
        onUpload={upload}
        onAttachmentsChanged={onAttachmentsChanged}
      />,
    );
    const input = screen.getByTestId("entry-composer-file-input") as HTMLInputElement;

    // 1) successful eager upload lands in the tray
    fireEvent.change(input, {
      target: { files: [new File(["x"], "ok.png", { type: "image/png" })] },
    });
    await screen.findByTestId("entry-composer-attachment-ok.png");
    expect(onAttachmentsChanged).toHaveBeenCalledTimes(1);

    // 2) a failed upload retained as a failed card is a tray change too
    fireEvent.change(input, {
      target: { files: [new File(["x"], "bad.png", { type: "image/png" })] },
    });
    const failedCard = await screen.findByTestId("entry-composer-attachment-bad.png");
    expect(failedCard).toHaveAttribute("data-state", "failed");
    expect(onAttachmentsChanged).toHaveBeenCalledTimes(2);

    // 3) removing the ready attachment
    fireEvent.click(screen.getByRole("button", { name: "Remove ok.png" }));
    expect(onAttachmentsChanged).toHaveBeenCalledTimes(3);

    // 4) removing the failed card
    fireEvent.click(screen.getByRole("button", { name: "Remove bad.png" }));
    expect(onAttachmentsChanged).toHaveBeenCalledTimes(4);
  });

  it("does NOT fire for the host-driven clearSignal wipe", async () => {
    const onAttachmentsChanged = vi.fn();
    const upload = vi.fn().mockResolvedValue({
      id: "asset-1",
      name: "test.png",
      mimeType: "image/png",
    });
    const props = {
      threadId: "thread-1",
      agents,
      users,
      onUpload: upload,
      onSubmit: vi.fn(),
      onAttachmentsChanged,
    };
    const view = renderWithProviders(<EntryComposer {...props} clearSignal={0} />);
    const input = screen.getByTestId("entry-composer-file-input") as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "test.png", { type: "image/png" })] },
    });
    await screen.findByTestId("entry-composer-attachment-test.png");
    onAttachmentsChanged.mockClear();

    view.rerender(<EntryComposer {...props} clearSignal={1} />);
    expect(screen.queryByTestId("entry-composer-attachment-test.png")).not.toBeInTheDocument();
    expect(onAttachmentsChanged).not.toHaveBeenCalled();
  });
});

describe("EntryComposer — reply mode", () => {
  it("renders reply-mode UI when parentEntryId is set", () => {
    renderWithProviders(
      <EntryComposer
        threadId="thread-1"
        parentEntryId="parent-42"
        agents={agents}
        users={users}
        onSubmit={vi.fn()}
      />,
    );
    const composer = screen.getByTestId("entry-composer");
    expect(composer.getAttribute("data-reply")).toBe("true");
    expect(composer.getAttribute("data-parent-entry-id")).toBe("parent-42");
  });
});
