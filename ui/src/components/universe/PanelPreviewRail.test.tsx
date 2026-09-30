import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelPreviewRail, isPanelOutOfView } from "./PanelPreviewRail";

const item = { key: "p1", title: "Launch plan", kind: "Task", minimized: true };

describe("PanelPreviewRail", () => {
  it("detects panels fully outside the current canvas viewport", () => {
    const viewport = { x: -100, y: -50, zoom: 1 };
    const bounds = { width: 800, height: 600 };
    expect(isPanelOutOfView({ x: 150, y: 100, width: 300, height: 200 }, viewport, bounds)).toBe(false);
    expect(isPanelOutOfView({ x: 950, y: 100, width: 300, height: 200 }, viewport, bounds)).toBe(true);
    expect(isPanelOutOfView({ x: -300, y: 100, width: 100, height: 100 }, viewport, bounds)).toBe(true);
  });
  it("uses hover intent and keeps the preview available while crossing onto it", () => {
    vi.useFakeTimers();
    render(<PanelPreviewRail panels={[item]} onOpen={vi.fn()} />);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "Preview Launch plan" }));
    act(() => vi.advanceTimersByTime(179));
    expect(screen.queryByRole("dialog", { name: "Launch plan preview" })).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    const preview = screen.getByRole("dialog", { name: "Launch plan preview" });
    fireEvent.pointerLeave(screen.getByRole("button", { name: "Preview Launch plan" }));
    fireEvent.pointerEnter(preview);
    act(() => vi.advanceTimersByTime(120));
    expect(preview).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("restores a panel from the preview and supports keyboard focus", () => {
    const onOpen = vi.fn();
    render(<PanelPreviewRail panels={[item]} onOpen={onOpen} />);
    const trigger = screen.getByRole("button", { name: "Preview Launch plan" });
    fireEvent.focus(trigger);
    expect(screen.getByRole("dialog", { name: "Launch plan preview" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Launch plan" }));
    expect(onOpen).toHaveBeenCalledWith("p1");
  });
});
