import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KeyboardShortcutsCheatsheet } from "../components/KeyboardShortcutsCheatsheet";

describe("KeyboardShortcutsCheatsheet", () => {
  it("renders all section headings when open", () => {
    render(<KeyboardShortcutsCheatsheet open onOpenChange={() => {}} />);
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Task detail" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Global" })).toBeInTheDocument();
  });

  it("renders representative shortcuts from the config", () => {
    render(<KeyboardShortcutsCheatsheet open onOpenChange={() => {}} />);
    expect(screen.getByText("New task")).toBeInTheDocument();
    expect(screen.getByText("Show keyboard shortcuts")).toBeInTheDocument();
  });

  it("does not render content when open=false", () => {
    render(<KeyboardShortcutsCheatsheet open={false} onOpenChange={() => {}} />);
    expect(screen.queryByText("New task")).not.toBeInTheDocument();
  });

  it("calls onOpenChange with false when close button clicked", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<KeyboardShortcutsCheatsheet open onOpenChange={onOpenChange} />);
    const closeButton = screen.getByRole("button", { name: /close/i });
    await user.click(closeButton);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
