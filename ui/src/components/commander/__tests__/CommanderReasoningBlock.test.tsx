/**
 * T3 — CommanderReasoningBlock collapse + a11y tests.
 *
 * Verifies:
 *   - Component starts expanded while streaming (streaming=true).
 *   - Component auto-collapses when streaming flips to false (settled).
 *   - Clicking the toggle expands and collapses the content.
 *   - aria-expanded reflects the open/closed state.
 *   - aria-controls points to the content element's id (present on render).
 *   - Returns null when text is empty / whitespace.
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { CommanderReasoningBlock } from "../CommanderReasoningBlock.js";

// lucide-react uses ESM; mock icon wrappers so jsdom doesn't need to
// resolve SVG internals.
vi.mock("lucide-react", () => ({
  ChevronRight: ({ className }: { className?: string }) => (
    <span data-testid="icon-right" className={className} />
  ),
  ChevronDown: ({ className }: { className?: string }) => (
    <span data-testid="icon-down" className={className} />
  ),
}));

describe("CommanderReasoningBlock", () => {
  it("renders null when text is empty", () => {
    const { container } = render(
      <CommanderReasoningBlock text="" streaming={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders null when text is only whitespace", () => {
    const { container } = render(
      <CommanderReasoningBlock text="   " streaming={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows content while streaming=true (expanded by default)", () => {
    render(
      <CommanderReasoningBlock text="Thinking about it..." streaming={true} />,
    );
    // Content is visible while streaming
    expect(screen.getByText("Thinking about it...")).toBeInTheDocument();
  });

  it("auto-collapses when streaming flips to false (settled)", () => {
    const { rerender } = render(
      <CommanderReasoningBlock text="Reasoning text" streaming={true} />,
    );
    // Content visible while streaming
    expect(screen.getByText("Reasoning text")).toBeInTheDocument();

    // Flip to settled
    act(() => {
      rerender(<CommanderReasoningBlock text="Reasoning text" streaming={false} />);
    });

    // Content should now be hidden (collapsed on settle)
    expect(screen.queryByText("Reasoning text")).not.toBeInTheDocument();
  });

  it("toggle button has aria-expanded=false when collapsed", () => {
    render(
      <CommanderReasoningBlock
        text="Some reasoning"
        streaming={false}
        defaultCollapsed={true}
      />,
    );
    const button = screen.getByRole("button", { name: /show reasoning/i });
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("toggle button has aria-expanded=true when expanded", () => {
    render(
      <CommanderReasoningBlock text="Some reasoning" streaming={true} />,
    );
    const button = screen.getByRole("button", { name: /show reasoning/i });
    expect(button).toHaveAttribute("aria-expanded", "true");
  });

  it("clicking toggle expands the content and sets aria-expanded=true", () => {
    render(
      <CommanderReasoningBlock
        text="Toggle me"
        streaming={false}
        defaultCollapsed={true}
      />,
    );
    const button = screen.getByRole("button", { name: /show reasoning/i });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Toggle me")).not.toBeInTheDocument();

    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Toggle me")).toBeInTheDocument();
  });

  it("clicking toggle again collapses and sets aria-expanded=false", () => {
    render(
      <CommanderReasoningBlock
        text="Toggle twice"
        streaming={false}
        defaultCollapsed={true}
      />,
    );
    const button = screen.getByRole("button", { name: /show reasoning/i });

    // Expand
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");

    // Collapse
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Toggle twice")).not.toBeInTheDocument();
  });

  it("aria-controls points to a valid element id in the DOM when expanded", () => {
    render(
      <CommanderReasoningBlock text="Linked content" streaming={true} />,
    );
    const button = screen.getByRole("button", { name: /show reasoning/i });
    const controlsId = button.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();

    // The content element with that id must be in the DOM
    const contentEl = document.getElementById(controlsId!);
    expect(contentEl).not.toBeNull();
    expect(contentEl).toHaveTextContent("Linked content");
  });
});
