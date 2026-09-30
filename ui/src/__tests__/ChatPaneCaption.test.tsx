import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPaneCaption } from "@/components/commander/ChatPaneCaption";

describe("ChatPaneCaption", () => {
  it("renders the title", () => {
    render(
      <ChatPaneCaption
        title="Sprint planning chat"
        messageCount={5}
      />,
    );
    expect(screen.getByText("Sprint planning chat")).toBeInTheDocument();
  });

  it("renders N msgs", () => {
    render(
      <ChatPaneCaption
        title="My chat"
        messageCount={12}
      />,
    );
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("msgs")).toBeInTheDocument();
  });

  it("renders 0 msgs when messageCount is 0", () => {
    render(
      <ChatPaneCaption
        title="Empty chat"
        messageCount={0}
      />,
    );
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("renders relative time when updatedAt is provided", () => {
    const updatedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
    render(
      <ChatPaneCaption
        title="My chat"
        messageCount={3}
        updatedAt={updatedAt}
      />,
    );
    // timeAgo returns "2m ago" for ~2 minutes
    expect(screen.getByText(/ago/i)).toBeInTheDocument();
  });

  it("omits relative time when updatedAt is not provided", () => {
    render(
      <ChatPaneCaption
        title="New chat"
        messageCount={0}
      />,
    );
    expect(screen.queryByText(/ago/i)).not.toBeInTheDocument();
  });

  it("calls onOpenSessions when Sessions button is clicked", async () => {
    const user = userEvent.setup();
    const onOpenSessions = vi.fn();
    render(
      <ChatPaneCaption
        title="My chat"
        messageCount={2}
        onOpenSessions={onOpenSessions}
      />,
    );
    const btn = screen.getByRole("button", { name: /open sessions/i });
    await user.click(btn);
    expect(onOpenSessions).toHaveBeenCalledOnce();
  });

  // Phase 3 — 42px header + Open preview toggle
  it("has exactly h-[42px] height class on the root element", () => {
    const { container } = render(
      <ChatPaneCaption title="My chat" messageCount={1} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("h-[42px]");
  });

  it("shows 'Open preview' toggle when onToggleViewer is provided and viewer is closed", () => {
    render(
      <ChatPaneCaption
        title="My chat"
        messageCount={1}
        viewerOpen={false}
        onToggleViewer={vi.fn()}
      />,
    );
    const btn = screen.getByTestId("commander-open-preview");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-label", "Open preview");
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("shows 'Hide preview' label and aria-pressed=true when viewer is open", () => {
    render(
      <ChatPaneCaption
        title="My chat"
        messageCount={1}
        viewerOpen={true}
        onToggleViewer={vi.fn()}
      />,
    );
    const btn = screen.getByTestId("commander-open-preview");
    expect(btn).toHaveAttribute("aria-label", "Hide preview");
    expect(btn).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onToggleViewer when the toggle is clicked", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <ChatPaneCaption
        title="My chat"
        messageCount={1}
        viewerOpen={false}
        onToggleViewer={onToggle}
      />,
    );
    await user.click(screen.getByTestId("commander-open-preview"));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("does not render the Open preview toggle when onToggleViewer is not provided", () => {
    render(
      <ChatPaneCaption
        title="My chat"
        messageCount={1}
      />,
    );
    expect(screen.queryByTestId("commander-open-preview")).not.toBeInTheDocument();
  });
});
