import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerFrame } from "./ComposerFrame";

describe("ComposerFrame", () => {
  it("keeps the shared frame anatomy and density contract", () => {
    render(<ComposerFrame density="compact" data-testid="composer-frame"><span>editor</span></ComposerFrame>);
    const frame = screen.getByTestId("composer-frame");
    expect(frame).toHaveAttribute("data-composer-frame");
    expect(frame).toHaveAttribute("data-density", "compact");
    expect(frame).toHaveTextContent("editor");
  });

  it("base class list includes relative (drop overlay anchor) and never overflow", () => {
    render(<ComposerFrame data-testid="f"><div /></ComposerFrame>);
    const el = screen.getByTestId("f");
    expect(el.className).toContain("relative");
    expect(el.className).not.toContain("overflow-hidden");
    expect(el.className).not.toContain("overflow-clip");
    expect(el.className).not.toMatch(/\boverflow-/);
  });

  it("spreads dragHandlers onto the wrapper div", () => {
    const onDragEnter = vi.fn();
    render(
      <ComposerFrame data-testid="f" dragHandlers={{ onDragEnter }}>
        <div />
      </ComposerFrame>,
    );
    fireEvent.dragEnter(screen.getByTestId("f"));
    expect(onDragEnter).toHaveBeenCalledTimes(1);
  });

  it("card chrome renders the bordered focus-glow card (Quiet Operator)", () => {
    render(<ComposerFrame chrome="card" data-testid="f"><div /></ComposerFrame>);
    const el = screen.getByTestId("f");
    expect(el.className).toContain("rounded-lg");
    expect(el.className).toContain("border-border");
    expect(el.className).toContain("focus-within:ring-2");
    expect(el.className).toContain("shadow-sm");
    // P1 review finding: the frame must NEVER clip — the mention popovers render
    // absolute bottom-full INSIDE it and Playwright toBeVisible can't see clipping.
    expect(el.className).not.toContain("overflow-hidden");
    expect(el.className).not.toContain("overflow-clip");
  });

  it("bare chrome (default) adds no card classes", () => {
    render(<ComposerFrame data-testid="f"><div /></ComposerFrame>);
    const el = screen.getByTestId("f");
    expect(el.className).not.toContain("rounded-lg");
    expect(el.className).not.toContain("shadow-sm");
  });
});
