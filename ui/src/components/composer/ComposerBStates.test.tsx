import { fireEvent, render, renderHook, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerSendFailedBanner } from "./ComposerSendFailedBanner";
import { ComposerOfflineStrip, toComposerConnectionState } from "./ComposerOfflineStrip";
import { useComposerDragDrop } from "./useComposerDragDrop";
import { ComposerDropOverlay } from "./ComposerDropOverlay";

describe("ComposerSendFailedBanner", () => {
  it("renders exact copy and fires callbacks", () => {
    const onRetry = vi.fn();
    const onEdit = vi.fn();
    const onDiscard = vi.fn();
    render(<ComposerSendFailedBanner onRetry={onRetry} onEdit={onEdit} onDiscard={onDiscard} />);
    expect(screen.getByText("Failed to send. Your message is saved.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Edit"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("disables ALL actions while retrying — Discard can't cancel an in-flight send and Edit invites edits the success-clear would wipe", () => {
    const onEdit = vi.fn();
    const onDiscard = vi.fn();
    render(
      <ComposerSendFailedBanner onRetry={vi.fn()} onEdit={onEdit} onDiscard={onDiscard} retrying />,
    );
    expect(screen.getByText("Retrying…")).toBeDisabled();
    expect(screen.getByText("Edit")).toBeDisabled();
    expect(screen.getByText("Discard")).toBeDisabled();
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Discard"));
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });
});

describe("ComposerOfflineStrip", () => {
  it("renders offline copy", () => {
    render(<ComposerOfflineStrip state="offline" />);
    expect(
      screen.getByText("You're offline — draft saved. We'll send when you're back."),
    ).toBeInTheDocument();
  });

  it("renders reconnecting copy", () => {
    render(<ComposerOfflineStrip state="reconnecting" />);
    expect(screen.getByTestId("composer-offline-strip").textContent).toContain("Reconnecting");
  });

  it("renders nothing when connected", () => {
    render(<ComposerOfflineStrip state="connected" />);
    expect(screen.queryByTestId("composer-offline-strip")).not.toBeInTheDocument();
  });

  it("toComposerConnectionState maps live states to the tri-state", () => {
    expect(toComposerConnectionState("open")).toBe("connected");
    expect(toComposerConnectionState("connecting")).toBe("connected");
    expect(toComposerConnectionState("offline")).toBe("offline");
    expect(toComposerConnectionState("reconnecting")).toBe("reconnecting");
  });
});

describe("useComposerDragDrop", () => {
  function makeDragEvent(types: string[] = ["Files"], files: File[] = []) {
    return {
      preventDefault: vi.fn(),
      dataTransfer: { types, files },
    } as unknown as React.DragEvent;
  }

  it("enter/enter/leave keeps active until depth returns to zero", () => {
    const { result } = renderHook(() => useComposerDragDrop({ onDropFiles: vi.fn() }));
    act(() => result.current.dragHandlers.onDragEnter(makeDragEvent()));
    expect(result.current.isDragActive).toBe(true);
    act(() => result.current.dragHandlers.onDragEnter(makeDragEvent()));
    expect(result.current.isDragActive).toBe(true);
    act(() => result.current.dragHandlers.onDragLeave(makeDragEvent()));
    expect(result.current.isDragActive).toBe(true);
    act(() => result.current.dragHandlers.onDragLeave(makeDragEvent()));
    expect(result.current.isDragActive).toBe(false);
  });

  it("drop with files calls onDropFiles and deactivates", () => {
    const onDropFiles = vi.fn();
    const { result } = renderHook(() => useComposerDragDrop({ onDropFiles }));
    const file = new File(["hi"], "hi.txt");
    act(() => result.current.dragHandlers.onDragEnter(makeDragEvent(["Files"])));
    expect(result.current.isDragActive).toBe(true);
    act(() => result.current.dragHandlers.onDrop(makeDragEvent(["Files"], [file])));
    expect(onDropFiles).toHaveBeenCalledTimes(1);
    expect(onDropFiles).toHaveBeenCalledWith([file]);
    expect(result.current.isDragActive).toBe(false);
  });

  it("non-file drag (text/plain) is ignored", () => {
    const onDropFiles = vi.fn();
    const { result } = renderHook(() => useComposerDragDrop({ onDropFiles }));
    act(() => result.current.dragHandlers.onDragEnter(makeDragEvent(["text/plain"])));
    expect(result.current.isDragActive).toBe(false);
    act(() => result.current.dragHandlers.onDrop(makeDragEvent(["text/plain"])));
    expect(onDropFiles).not.toHaveBeenCalled();
  });

  it("disabled ignores all handlers", () => {
    const onDropFiles = vi.fn();
    const { result } = renderHook(() =>
      useComposerDragDrop({ onDropFiles, disabled: true }),
    );
    const file = new File(["hi"], "hi.txt");
    act(() => result.current.dragHandlers.onDragEnter(makeDragEvent(["Files"])));
    expect(result.current.isDragActive).toBe(false);
    act(() => result.current.dragHandlers.onDrop(makeDragEvent(["Files"], [file])));
    expect(onDropFiles).not.toHaveBeenCalled();
  });
});

describe("ComposerDropOverlay", () => {
  it("renders copy derived from the max-attachment constant when active", () => {
    render(<ComposerDropOverlay active />);
    expect(screen.getByTestId("composer-drop-overlay").textContent).toContain("up to 10 MB each");
  });

  it("renders nothing when inactive", () => {
    render(<ComposerDropOverlay active={false} />);
    expect(screen.queryByTestId("composer-drop-overlay")).not.toBeInTheDocument();
  });
});
